"""Real SDKs, mocked HTTP. Run with the Agent environment, no API key needed."""
import asyncio
import json
import os
import sys
import unittest

try:
    import httpx
    import openai
    from langchain_openai import ChatOpenAI
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

from agentops_cli.agenttether import AgentTetherCapture

SOURCE = os.environ.get('AGENTOPS_AGENTTETHER_SOURCE')
COMPLETION = {'id': 'mock', 'object': 'chat.completion', 'created': 0, 'model': 'mock',
              'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'mock response'}, 'finish_reason': 'stop'}],
              'usage': {'prompt_tokens': 3, 'completion_tokens': 2, 'total_tokens': 5}}


@unittest.skipUnless(SOURCE and SDK_AVAILABLE, 'explicit private source and real SDK dependencies required')
class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.events, self.requests = [], []
        self.capture = AgentTetherCapture(SOURCE, secrets=['mock-credential'], sink=self.record)
        self.addCleanup(self.capture.close)

    def record(self, kind, name, **fields):
        self.events.append(dict(kind=kind, name=name, **fields))

    def respond(self, request):
        self.requests.append(request)
        return httpx.Response(200, json=COMPLETION)

    def test_sync_async_openai_real_sdk(self):
        with openai.OpenAI(api_key='mock-credential', base_url='https://mock.invalid/v1', max_retries=0,
                           http_client=httpx.Client(transport=httpx.MockTransport(self.respond))) as client:
            original = client.chat.completions.create
            self.capture.openai(client)
            result = client.chat.completions.create(model='mock', messages=[{'role': 'user', 'content': 'mock-credential'}])
            self.assertEqual(result.choices[0].message.content, 'mock response')
            self.capture.close()
            self.assertEqual(client.chat.completions.create, original)
        async def run():
            async with openai.AsyncOpenAI(api_key='mock-credential', base_url='https://mock.invalid/v1', max_retries=0,
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(self.respond))) as client:
                self.capture.openai(client)
                return await client.chat.completions.create(model='mock', messages=[])
        self.assertEqual(asyncio.run(run()).usage.total_tokens, 5)
        self.assertEqual(len(self.events), 4)
        self.assertTrue(all(e['kind'] == 'llm' for e in self.events))
        for start, end in zip(self.events[::2], self.events[1::2]):
            self.assertEqual(start['correlation_id'], end['correlation_id'])
            self.assertGreater(end['duration_ms'], 0)
            self.assertEqual(end['output']['usage']['total_tokens'], 5)
        self.assertNotIn('mock-credential', json.dumps(self.events))
        self.assertNotIn('agent_tether', sys.modules)

    def test_openai_error_and_cancellation_preserve_business_exception(self):
        def failed(request):
            return httpx.Response(400, json={'error': {'message': 'mock-credential invalid request', 'type': 'bad_request'}})
        with openai.OpenAI(api_key='mock-credential', max_retries=0,
                          http_client=httpx.Client(transport=httpx.MockTransport(failed))) as client:
            self.capture.openai(client)
            with self.assertRaises(openai.BadRequestError):
                client.chat.completions.create(model='mock', messages=[])
        self.assertFalse(self.events[-1]['ok'])
        self.assertEqual(self.events[-1]['name'], 'LLM_ERROR')
        async def delayed(request):
            await asyncio.sleep(60)
        async def run():
            async with openai.AsyncOpenAI(api_key='mock-credential', max_retries=0,
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(delayed))) as client:
                self.capture.openai(client)
                task = asyncio.create_task(client.chat.completions.create(model='mock', messages=[]))
                await asyncio.sleep(.02)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        asyncio.run(run())
        self.assertFalse(self.events[-1]['ok'])
        self.assertIn('CancelledError', self.events[-1]['error_signature'])
        self.assertNotIn('mock-credential', json.dumps(self.events))

    def test_langchain_immutable_model_and_factories(self):
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(self.respond)) as http:
                model = ChatOpenAI(model='mock', api_key='mock-credential', base_url='https://mock.invalid/v1',
                                   use_responses_api=False, max_retries=0, http_async_client=http)
                original = model.ainvoke
                proxy = self.capture.langchain(model)
                tool = {'type': 'function', 'function': {'name': 'example', 'description': 'example', 'parameters': {'type': 'object', 'properties': {}}}}
                bound = proxy.bind_tools([tool]).bind(temperature=0).with_retry(stop_after_attempt=1)
                result = await bound.ainvoke('input')
                self.assertEqual(result.content, 'mock response')
                self.assertEqual(model.ainvoke, original)
                self.assertEqual(result.usage_metadata['total_tokens'], 5)
        asyncio.run(run())
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len(self.events), 2)
        self.assertEqual(self.events[-1]['output']['usage_metadata']['total_tokens'], 5)

    def test_mcp_unknown_error_and_async_httpx(self):
        class Session:
            async def call_tool(self, name, arguments=None):
                return {'result': {}} if name == 'unknown' else {'isError': True, 'content': ['bad input']}
        async def run():
            session = self.capture.mcp(Session())
            self.assertEqual(await session.call_tool('unknown', {'x': 1}), {'result': {}})
            await session.call_tool('failed')
            async with httpx.AsyncClient(transport=httpx.MockTransport(self.respond)) as client:
                self.capture.httpx(client, collector_url='http://127.0.0.1:8000')
                await client.request('GET', 'https://mock.invalid/api')
                await client.request('POST', 'http://127.0.0.1:8000/api/live/runs')
        asyncio.run(run())
        self.assertIsNone(self.events[1]['ok'])
        self.assertFalse(self.events[3]['ok'])
        self.assertEqual(self.events[4]['input'], {'method': 'GET', 'url': 'https://mock.invalid/api'})
        self.assertEqual(len(self.events), 6)

    def test_sync_httpx_correct_bound_signature_and_process_result(self):
        import subprocess
        with httpx.Client(transport=httpx.MockTransport(self.respond)) as client:
            original = client.request
            self.capture.httpx(client, collector_url='http://127.0.0.1:8000')
            client.request('GET', 'https://mock.invalid/api')
            self.assertEqual(self.events[0]['input'], {'method': 'GET', 'url': 'https://mock.invalid/api'})
            self.capture.close()
            self.assertEqual(client.request, original)
        run = self.capture.wrap(subprocess.run, name='process', signal='proc')
        result = run([sys.executable, '-c', "print('stdout'); import sys; print('stderr', file=sys.stderr); sys.exit(3)"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.events[-1]['output']['returncode'], 3)
        self.assertEqual(self.events[-1]['output']['stdout'].strip(), 'stdout')
        self.assertFalse(self.events[-1]['ok'])

    def test_stream_is_forwarded_without_fake_finished_span(self):
        def streamed(request):
            self.requests.append(request)
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content='data: [DONE]\n\n')
        with openai.OpenAI(api_key='mock-credential', max_retries=0,
                          http_client=httpx.Client(transport=httpx.MockTransport(streamed))) as client:
            self.capture.openai(client)
            stream = client.chat.completions.create(model='mock', messages=[], stream=True)
            self.assertEqual(list(stream), [])
            stream.close()
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0]['name'], 'CAPTURE_UNSUPPORTED')

    @unittest.skipUnless(os.environ.get('AGENTOPS_ENTERPRISEOPS_SOURCE'), 'private EnterpriseOps source required')
    def test_enterpriseops_adapter_uses_bridge_with_actual_clients(self):
        """Actual benchmark LLM/tool boundaries, mocked benchmark lifecycle/MCP.

        This is adapter compatibility, not a benchmark case acceptance result.
        """
        import logging
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        sys.path.insert(0, os.environ['AGENTOPS_ENTERPRISEOPS_SOURCE'])
        os.environ['AGENT_SRE_PATH'] = '/nonexistent'
        from benchmark.executor import BenchmarkExecutor
        from benchmark.llm_client import LLMClient
        from benchmark.verifier import VerifierEngine
        from orchestrators.base import AgentOrchestrator
        from langchain_core.messages import HumanMessage
        from agentops_cli import verification
        from scripts.run_enterpriseops import install_adapter
        from agentops_cli.spool import Spool

        posts = []
        class Transport:
            def __init__(self, server, token):
                self.url = server
            def post(self, path, body):
                posts.append((path, body))
                return {'run_id': 'synthetic-test-run', 'task_id': 'synthetic-test-task', 'url': '/runs/synthetic-test-run'}
        class MCP:
            async def call_tool(self, name, args):
                return {'success': True, 'result': {'isError': name == 'failed', 'content': []}, 'error': None}
        class Orchestrator(AgentOrchestrator):
            async def execute(self):
                return {}
        async def lifecycle(executor, run_number, task_id=None, output_dir=None):
            # The adapter must hook the real model + factory + dispatcher.
            client = LLMClient(provider='vllm', model='mock', api_key='mock-credential', api_endpoint='https://mock.invalid/v1')
            underlying = client.llm._runnable
            underlying.use_responses_api = False
            sdk = underlying.root_async_client
            old_http = sdk._client
            sdk._client = httpx.AsyncClient(transport=httpx.MockTransport(self.respond))
            try:
                tool = {'name': 'example', 'description': 'example', 'inputSchema': {'type': 'object', 'properties': {}}}
                reply = await client.invoke_with_tools([HumanMessage(content='input')], [tool])
                self.assertEqual(reply.content, 'mock response')
                agent = Orchestrator(client, {'mock': MCP()}, {'example': 'mock', 'failed': 'mock'}, [], None)
                result = await agent._execute_tool_call('example', {'value': 1})
                self.assertFalse(result['result']['result']['isError'])
                await agent._execute_tool_call('failed', {'value': 2})
                verification('failed', source='mock-independent-check', basis={'synthetic': True})
                return {'overall_success': False}
            finally:
                await sdk.close()
                await old_http.aclose()
                underlying.root_client.close()
        evaluate = SimpleNamespace(execute_sample=lambda: None)
        originals = [(obj, attr, getattr(obj, attr)) for obj, attr in [
            (BenchmarkExecutor, 'execute_single_run'), (BenchmarkExecutor, '_discover_and_merge_tools'),
            (AgentOrchestrator, '_execute_tool_call'), (LLMClient, 'invoke_with_tools'),
            (LLMClient, '__init__'), (VerifierEngine, 'execute_verifier'), (BenchmarkExecutor, '_run_verifiers')]]
        logger = logging.getLogger()
        handlers = list(logger.handlers)
        try:
            with tempfile.TemporaryDirectory() as directory, patch('agentops_cli.session.Transport', Transport):
                BenchmarkExecutor.execute_single_run = lifecycle
                args = SimpleNamespace(max_model_calls=1, receipt=str(Path(directory)/'receipt.json'), server='http://127.0.0.1:8001',
                                       spool_dir=str(Path(directory)/'spool'), agenttether_source=SOURCE)
                receipt, save = install_adapter(evaluate, args, ['mock-credential'])
                executor = SimpleNamespace(config_path='synthetic-case.json', config=SimpleNamespace(user_prompt='synthetic case'))
                asyncio.run(BenchmarkExecutor.execute_single_run(executor, 1))
                records = [e for p, b in posts if p.endswith('/events') for e in b['events']]
                self.assertEqual(sum(e['kind'] == 'llm' for e in records), 2)
                self.assertEqual(sum(e['kind'] == 'tool_call' for e in records), 2)
                self.assertEqual(sum(e['kind'] == 'tool_return' for e in records), 2)
                self.assertFalse([e for e in records if e['kind'] == 'tool_return'][-1]['ok'])
                self.assertEqual(receipt['model_calls'], 1)
                self.assertNotIn('mock-credential', json.dumps(records))
                self.assertEqual([b for p, b in posts if p.endswith('/finish')][0]['dropped'], 0)
        finally:
            for obj, attr, original in originals:
                setattr(obj, attr, original)
            for handler in list(logger.handlers):
                if handler not in handlers:
                    logger.removeHandler(handler)


if __name__ == '__main__':
    unittest.main(verbosity=2)
