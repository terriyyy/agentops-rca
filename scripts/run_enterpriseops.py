"""Opt-in EnterpriseOps-Gym adapter; leaves upstream files unchanged.

Run directly (not inside `agentops run`). One execute_single_run is one Run.
Only supports serial ReAct attempts and database_state independent checks.
"""
import argparse
import asyncio
import contextvars
import functools
import importlib.util
import json
import logging
import os
import sys
import time
from pathlib import Path
from uuid import uuid4

from agentops_cli import emit, verification
from agentops_cli.session import CaptureSession
from agentops_cli.spool import SECRET_KEYS, clean


def check_status(records):
    """A missing/errored check is unknown, never an invented task failure."""
    statuses = []
    for record in records:
        result = record['result']
        if record['type'] != 'database_state' or result.get('error'):
            statuses.append('unknown')
        elif isinstance(result.get('passed'), bool):
            statuses.append('passed' if result['passed'] else 'failed')
        else:
            statuses.append('unknown')
    if 'failed' in statuses:
        return 'failed'
    return 'passed' if statuses and all(s == 'passed' for s in statuses) else 'unknown'


def tool_outcome(raw):
    """Respect explicit transport, JSON-RPC and MCP error signals."""
    if not isinstance(raw, dict):
        return None, None
    result = raw.get('result')
    mcp_error = isinstance(result, dict) and result.get('isError') is True
    if raw.get('success') is False or raw.get('error') is not None or raw.get('isError') is True or mcp_error:
        error = raw.get('error') or (result.get('content') if mcp_error else None) or 'MCP tool reported failure'
        return False, str(error)[:1000]
    return (True if raw.get('success') is True else None), None


class RedactingStream:
    def __init__(self, stream, secrets):
        self.stream = stream
        self.secrets = [secrets] if isinstance(secrets, str) else secrets

    def write(self, text):
        for secret in self.secrets:
            if secret:
                text = text.replace(secret, '[REDACTED]')
        return self.stream.write(clean(text))

    def flush(self):
        self.stream.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


class CaptureLog(logging.Handler):
    def __init__(self, secrets):
        super().__init__()
        self.secrets = [secrets] if isinstance(secrets, str) else secrets

    def emit(self, record):
        try:
            text = record.getMessage()
            for secret in self.secrets:
                if secret:
                    text = text.replace(secret, '[REDACTED]')
            emit('log', record.name, output=text)
        except Exception:
            # Capture must not change the benchmark's business result.
            pass


def install_adapter(evaluate, args, secrets):
    from benchmark.executor import BenchmarkExecutor
    from benchmark.llm_client import LLMClient
    from benchmark.verifier import VerifierEngine
    from orchestrators.base import AgentOrchestrator

    current = contextvars.ContextVar('enterpriseops_capture', default=None)
    checks = contextvars.ContextVar('enterpriseops_checks', default=None)
    attempted = 0
    calls = 0
    receipt = {'adapter': 'enterpriseops-explicit-0.1', 'runs': [], 'model_calls': 0,
               'max_model_calls': args.max_model_calls, 'legacy_probe_disabled': True}
    tether = None
    if getattr(args, 'agenttether_source', None):
        from agentops_cli.agenttether import AgentTetherCapture
        tether = AgentTetherCapture(args.agenttether_source, secrets=secrets)
        receipt['capture'] = tether.provenance
        receipt['capture_capabilities'] = {'tools': 'explicit-dispatch', 'llm': 'langchain-invoke',
                                           'stream': 'unsupported', 'automatic_rca': False}

    def save():
        path = Path(args.receipt)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')

    original_run = BenchmarkExecutor.execute_single_run

    @functools.wraps(original_run)
    async def run(executor, run_number, task_id=None, output_dir=None):
        nonlocal attempted
        # The platform task is stable across actual feedback attempts.
        attempted += 1
        goal = 'EnterpriseOps-Gym / ' + Path(executor.config_path).stem
        platform_task = receipt.get('task_id')
        with CaptureSession(server=args.server, goal=goal, task_id=platform_task,
                            spool_dir=args.spool_dir) as session:
            receipt['task_id'] = session.task_id
            entry = dict(run_id=session.run_id, attempt=attempted, url=session.url,
                         upstream_run_number=run_number, case=Path(executor.config_path).name,
                         outcome='unknown', execution='running')
            receipt['runs'].append(entry)
            save()
            print('[agentops] execution page: ' + session.url, flush=True)
            token = current.set(session)
            check_token = checks.set([])
            emit('event', 'TASK_CONTEXT', input={'benchmark': 'EnterpriseOps-Gym',
                 'case': entry['case'], 'attempt': attempted, 'goal': executor.config.user_prompt})
            if tether:
                emit('event', 'CAPTURE_CAPABILITIES', input=receipt['capture_capabilities'], capture=tether.provenance)
            try:
                result = await original_run(executor, run_number, task_id, output_dir)
                entry['execution'] = 'completed'
                entry['benchmark_success'] = result.get('overall_success')
                entry['check_status'] = check_status(checks.get())
                entry['outcome'] = entry['check_status']
                entry['check_count'] = len(checks.get())
                return result
            except BaseException as error:
                entry['execution'] = 'cancelled' if isinstance(error, KeyboardInterrupt) else 'failed'
                entry['error_type'] = type(error).__name__
                emit('event', 'AGENT_ERROR', error_signature=(type(error).__name__ + ': ' + str(error))[:1000])
                raise
            finally:
                checks.reset(check_token)
                current.reset(token)
                save()

    original_tool = AgentOrchestrator._execute_tool_call
    original_discover = BenchmarkExecutor._discover_and_merge_tools

    @functools.wraps(original_discover)
    async def discover(executor):
        await original_discover(executor)
        expected = set(executor.config.selected_tools or [])
        available = {t['name'] for t in executor.available_tools}
        if not available or not expected.issubset(available):
            raise RuntimeError('MCP tool discovery incomplete; no model request sent')

    @functools.wraps(original_tool)
    async def tool(orchestrator, tool_name, tool_args):
        if not current.get():
            return await original_tool(orchestrator, tool_name, tool_args)
        cid, span, start = uuid4().hex, uuid4().hex, time.perf_counter()
        emit('tool_call', tool_name, correlation_id=cid, source_span_id=span, input=tool_args)
        try:
            result = await original_tool(orchestrator, tool_name, tool_args)
        except BaseException as error:
            emit('tool_return', tool_name, correlation_id=cid, source_span_id=uuid4().hex,
                 ok=False, duration_ms=(time.perf_counter()-start)*1000,
                 error_signature=(type(error).__name__+': '+str(error))[:1000])
            raise
        raw = result.get('result', {})
        ok, error = tool_outcome(raw)
        emit('tool_return', tool_name, correlation_id=cid, source_span_id=uuid4().hex,
             output=result, ok=ok, duration_ms=(time.perf_counter()-start)*1000,
             error_signature=error)
        return result

    original_llm = LLMClient.invoke_with_tools
    original_client_init = LLMClient.__init__

    @functools.wraps(original_client_init)
    def client_init(client, *positional, **kwargs):
        original_client_init(client, *positional, **kwargs)
        # Only this opt-in run is affected. No hidden SDK or LangChain retries.
        if client.provider not in ('vllm', 'openrouter'):
            raise ValueError('Adapter requires an explicit OpenAI-compatible base URL')
        for attr in ('root_client', 'root_async_client'):
            sdk_client = getattr(client.llm, attr, None)
            if sdk_client is None:
                raise RuntimeError('Cannot verify SDK retry policy; no request sent')
            sdk_client.max_retries = 0
            sdk_client.timeout = 90
        if tether:
            # Keep/use the proxy; Pydantic Runnable instances stay unmodified.
            client.llm = tether.langchain(client.llm)

    @functools.wraps(original_llm)
    async def llm(client, messages, tools):
        nonlocal calls
        if not current.get():
            return await original_llm(client, messages, tools)
        if calls >= args.max_model_calls:
            raise RuntimeError('Explicit model-call limit reached; no more requests sent')
        calls += 1
        receipt['model_calls'] = calls
        save()
        if tether:
            bound = client.llm.bind_tools(client._convert_mcp_tools_to_langchain(tools))
            return await asyncio.wait_for(bound.ainvoke(messages), timeout=90)
        cid, start = uuid4().hex, time.perf_counter()
        inputs = [{'type': getattr(m, 'type', type(m).__name__), 'content': m.content}
                  for m in messages]
        emit('llm', 'LLM_REQUEST', source_span_id=uuid4().hex, correlation_id=cid,
             input={'model': client.model, 'messages': inputs, 'tools': [t['name'] for t in tools]})
        try:
            bound = client.llm.bind_tools(client._convert_mcp_tools_to_langchain(tools))
            response = await asyncio.wait_for(bound.ainvoke(messages), timeout=90)
        except BaseException as error:
            emit('llm', 'LLM_ERROR', source_span_id=uuid4().hex, correlation_id=cid,
                 input={'model': client.model}, duration_ms=(time.perf_counter()-start)*1000,
                 error_signature=(type(error).__name__+': '+str(error))[:1000])
            raise
        emit('llm', 'LLM_RESPONSE', source_span_id=uuid4().hex, correlation_id=cid,
             input={'model': client.model}, output={'content': response.content,
                  'tool_calls': getattr(response, 'tool_calls', None),
                  'usage_metadata': getattr(response, 'usage_metadata', None)},
             duration_ms=(time.perf_counter()-start)*1000, ok=True)
        return response

    original_check = VerifierEngine.execute_verifier

    @functools.wraps(original_check)
    async def check(engine, verifier, *positional, **kwargs):
        result = await original_check(engine, verifier, *positional, **kwargs)
        if checks.get() is not None:
            checks.get().append({'name': verifier.name, 'type': verifier.verifier_type,
                                 'basis': verifier.validation_config, 'result': result})
        return result

    original_checks = BenchmarkExecutor._run_verifiers

    @functools.wraps(original_checks)
    async def verify(executor, result):
        results = await original_checks(executor, result)
        if current.get():
            records = checks.get()
            status = check_status(records)
            verification(status, source='EnterpriseOps-Gym/database_state',
                         basis={'checks': records, 'platform_reran_checks': False},
                         summary=f'{len(records)} actual checks; aggregate={status}')
        return results

    BenchmarkExecutor.execute_single_run = run
    BenchmarkExecutor._discover_and_merge_tools = discover
    AgentOrchestrator._execute_tool_call = tether.wrap(
        original_tool, name=lambda a, k: a[1] if len(a)>1 else k['tool_name'],
        inputs=lambda a, k: a[2] if len(a)>2 else k['tool_args'],
        outcome=lambda result: tool_outcome(result.get('result', {}))) if tether else tool
    LLMClient.invoke_with_tools = llm
    LLMClient.__init__ = client_init
    VerifierEngine.execute_verifier = check
    BenchmarkExecutor._run_verifiers = verify
    # Override only the default outer sample retry count, not feedback decisions.
    evaluate.execute_sample = functools.partial(evaluate.execute_sample, max_num_attempts=1)
    logging.getLogger().addHandler(CaptureLog(secrets))
    return receipt, save


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--server', default='http://127.0.0.1:8000')
    parser.add_argument('--configs-folder', required=True)
    parser.add_argument('--llm-config', required=True)
    parser.add_argument('--output-folder', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--spool-dir', required=True)
    parser.add_argument('--max-model-calls', type=int, default=20)
    parser.add_argument('--agenttether-source', help='Private source root containing agent_tether/ops/instrumentation.py')
    args = parser.parse_args()
    if args.agenttether_source:
        args.agenttether_source = str(Path(args.agenttether_source).resolve())
    # Windows may supply a system proxy even without *_PROXY environment vars.
    # Loopback collector/MCP traffic must stay local; external TLS stays verified.
    bypass = [s for s in os.environ.get('NO_PROXY', os.environ.get('no_proxy', '')).split(',') if s]
    os.environ['NO_PROXY'] = ','.join(dict.fromkeys(bypass + ['127.0.0.1', 'localhost']))
    if not 1 <= args.max_model_calls <= 100:
        parser.error('model call limit must be 1..100')
    configs = list(Path(args.configs_folder).glob('*.json'))
    if len(configs) != 1:
        parser.error('This smoke-test adapter requires exactly one case')
    llm_config = json.loads(Path(args.llm_config).read_text(encoding='utf-8'))
    secrets = [llm_config['llm_api_key']]
    # Upstream logs repr(context), which can contain nonstandard MCP credentials.
    # Mask exact known credentials as well as the collector's generic patterns.
    def collect_secrets(value):
        if isinstance(value, dict):
            for name, item in value.items():
                if SECRET_KEYS.search(str(name)) and isinstance(item, str) and item:
                    secrets.append(item)
                else:
                    collect_secrets(item)
        elif isinstance(value, list):
            for item in value:
                collect_secrets(item)
    collect_secrets(json.loads(configs[0].read_text(encoding='utf-8')))
    secrets = sorted(set(secrets), key=len, reverse=True)
    sys.stdout = RedactingStream(sys.stdout, secrets)
    sys.stderr = RedactingStream(sys.stderr, secrets)
    os.environ['AGENT_SRE_PATH'] = '/nonexistent'
    os.environ['SWEAGENT_OPS_DEFER_REPORT'] = '1'
    for name in ('LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING'):
        os.environ[name] = 'false'
    source = Path(args.source).resolve()
    sys.path.insert(0, str(source))
    os.chdir(source)
    spec = importlib.util.spec_from_file_location('enterpriseops_evaluate', source/'evaluate.py')
    evaluate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evaluate)
    receipt, save = install_adapter(evaluate, args, secrets)
    sys.argv = ['evaluate.py', '--configs_folder', args.configs_folder,
                '--llm_config', args.llm_config, '--output_folder', args.output_folder,
                '--enable_feedback_iteration', '--max_feedback_iterations', '2',
                '--num_runs', '1', '--concurrency', '1']
    try:
        asyncio.run(evaluate.main())
    finally:
        save()
    if not receipt['runs'] or any(r['execution'] != 'completed' for r in receipt['runs']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
