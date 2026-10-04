"""Opt-in bridge to privately supplied AgentTether instrumentation.

No AgentTether session, emitter, diagnosis, recovery, or model is initialized.
The upstream generic wrappers remain the call boundary; compatibility code
corrects cancellation, monotonic timing and immutable SDK instance handling.
"""
import functools
import hashlib
import importlib.util
import inspect
import os
import sys
import threading
import time
import tomllib
import types
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from . import sdk
from .spool import Spool, clean

_invocation = ContextVar('agentops_tether_invocation', default=None)


def is_async(function):
    # Current OpenAI decorates async create with a synchronous validation
    # wrapper. Inspect the original coroutine as well as the public method.
    return inspect.iscoroutinefunction(function) or inspect.iscoroutinefunction(inspect.unwrap(function))


def json_value(value, depth=0):
    """Convert SDK records without serializing client objects or credentials."""
    if depth > 8:
        return '[DEPTH LIMIT]'
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(k): json_value(v, depth+1) for k, v in list(value.items())[:50]}
    if isinstance(value, (list, tuple)):
        return [json_value(v, depth+1) for v in value[:50]]
    if hasattr(value, 'returncode'):
        return json_value({k: getattr(value, k, None) for k in ('args', 'returncode', 'stdout', 'stderr')}, depth+1)
    if hasattr(value, 'model_dump'):
        return json_value(value.model_dump(mode='json'), depth+1)
    return '<' + type(value).__name__ + '>'


def tool_result(value):
    """Explicit MCP/JSON-RPC/process signals; absent status stays unknown."""
    raw = json_value(value)
    if hasattr(value, 'returncode'):
        return value.returncode == 0, None if value.returncode == 0 else 'exit code ' + str(value.returncode)
    if not isinstance(raw, dict):
        return None, None
    nested = raw.get('result')
    if raw.get('success') is False or raw.get('error') is not None or raw.get('isError') is True or isinstance(nested, dict) and nested.get('isError') is True:
        return False, str(raw.get('error') or 'MCP tool reported failure')[:1000]
    if isinstance(raw.get('returncode'), int):
        return raw['returncode'] == 0, None if raw['returncode'] == 0 else 'exit code ' + str(raw['returncode'])
    if raw.get('success') is True or raw.get('isError') is False:
        return True, None
    return None, None


def _load(source):
    root = Path(source).expanduser().resolve()
    package = root / 'agent_tether'
    if not (package / 'ops/instrumentation.py').is_file():
        raise ValueError('AgentTether source must contain agent_tether/ops/instrumentation.py')
    files = ['ops/context.py', 'ops/error_signature.py', 'ops/instrumentation.py']
    fingerprint = hashlib.sha256()
    for name in files:
        fingerprint.update(name.encode())
        fingerprint.update((package / name).read_bytes())
    # Synthetic namespaces prevent __init__ importing reporting/torch/recovery.
    prefix = '_agentops_tether_' + uuid4().hex
    for name, path in [(prefix, package), (prefix + '.ops', package / 'ops')]:
        module = types.ModuleType(name)
        module.__path__ = [str(path)]
        sys.modules[name] = module
    otel = types.ModuleType(prefix + '.otel')
    otel.span = otel.counter_add = None
    sys.modules[otel.__name__] = otel
    try:
        name = prefix + '.ops.instrumentation'
        spec = importlib.util.spec_from_file_location(name, package / 'ops/instrumentation.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        for function in ('instrument_callable_attr', 'instrument_async_callable_attr'):
            if not callable(getattr(module, function, None)):
                raise ValueError('Unsupported AgentTether instrumentation interface')
        config = tomllib.loads((root / 'pyproject.toml').read_text(encoding='utf-8'))
        provenance = {'adapter': 'agenttether-observer-0.1', 'source_version': config.get('project', {}).get('version', 'unknown'),
                      'source_sha256': fingerprint.hexdigest()}
        return module, provenance
    finally:
        # Loaded functions retain globals; no private import namespace leaks.
        for name in list(sys.modules):
            if name == prefix or name.startswith(prefix + '.'):
                del sys.modules[name]


class AgentTetherObserver:
    """Duck-compatible observer routed exclusively through the platform SDK."""
    def __init__(self, provenance, *, secrets=(), sink=None):
        self.provenance = provenance
        self.secrets = sorted({s for s in secrets if isinstance(s, str) and s}, key=len, reverse=True)
        self.sink = sink or sdk.emit
        self.external_sink = sink is not None
        self.pending = {}
        self.lock = threading.Lock()

    def fault(self):
        path = os.environ.get('AGENTOPS_SPOOL')
        if path:
            try:
                Spool(path).set('collection_error', True)
            except Exception:
                pass

    def _redact(self, value):
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, '[REDACTED]')
        elif isinstance(value, dict):
            value = {k: self._redact(v) for k, v in value.items()}
        elif isinstance(value, list):
            value = [self._redact(v) for v in value]
        return value

    def send(self, kind, name, **fields):
        try:
            self.sink(kind, name, **clean(self._redact(json_value(fields))))
        except Exception:
            self.fault()

    def unsupported(self, name):
        self.send('event', 'CAPTURE_UNSUPPORTED', input={'operation': name, 'reason': 'stream lifecycle not captured'},
                  capture={**self.provenance, 'signal_kind': 'capability', 'phase': 'unsupported'})

    def on_tool_call(self, name, input_dict, correlation_id=None, meta=None):
        try:
            state = _invocation.get()
            metadata = meta or {}
            signal = state['signal'] if state else metadata.get('span.kind', 'tool')
            label = state['name'] if state else name
            start = dict(span=uuid4().hex, clock=time.perf_counter(), signal=signal, name=label,
                         state=state, metadata=json_value(metadata))
            if not correlation_id:
                # Pair only an explicitly supplied correlation, never invent one
                # for two unrelated external observer calls.
                raise ValueError('call requires a correlation ID')
            with self.lock:
                if correlation_id in self.pending:
                    raise ValueError('duplicate active correlation ID')
                self.pending[correlation_id] = start
            if state is not None:
                state['span'] = start['span']
            self.send('llm' if signal == 'llm' else 'tool_call', 'LLM_REQUEST' if signal == 'llm' else label,
                      occurred_at=datetime.now(timezone.utc).isoformat(),
                      source_span_id=start['span'], parent_source_id=state.get('parent') if state else None,
                      correlation_id=correlation_id, input=input_dict,
                      capture={**self.provenance, 'signal_kind': signal, 'phase': 'start', 'metadata': metadata})
        except Exception:
            self.fault()

    def on_tool_return(self, name, output_text, ok=None, error_signature=None, duration_ms=None, correlation_id=None, meta=None):
        try:
            with self.lock:
                start = self.pending.pop(correlation_id, None)
            state = start['state'] if start else None
            if start is None:
                self.fault()
            if state and state.get('exception') is not None:
                error = state['exception']
                ok, error_signature = False, type(error).__name__ + ': ' + str(error)
                output_text = None
            elif state and 'result' in state:
                output_text = state['result']
                ok, error_signature = state['outcome'](output_text)
            # No absent ok -> False coercion and no inferred start timestamp.
            signal = start['signal'] if start else (meta or {}).get('span.kind', 'tool')
            label = start['name'] if start else name
            duration = max(0, (time.perf_counter()-start['clock'])*1000) if start else duration_ms
            self.send('llm' if signal == 'llm' else 'tool_return', ('LLM_ERROR' if error_signature else 'LLM_RESPONSE') if signal == 'llm' else label,
                      occurred_at=datetime.now(timezone.utc).isoformat(),
                      source_span_id=uuid4().hex, correlation_id=correlation_id,
                      output=json_value(output_text), ok=ok, duration_ms=duration,
                      error_signature=str(error_signature)[:1000] if error_signature else None,
                      capture={**self.provenance, 'signal_kind': signal, 'phase': 'end', 'metadata': meta or {}})
        except Exception:
            self.fault()

    def on_llm_end(self, content, usage=None, latency_ms=None, meta=None):
        # End-only upstream observations remain end-only, with no fake span.
        self.send('llm', 'LLM_RESPONSE', output={'content': content, 'usage': usage}, duration_ms=latency_ms,
                  capture={**self.provenance, 'signal_kind': 'llm', 'phase': 'end_only', 'metadata': meta or {}})


class AgentTetherCapture:
    def __init__(self, source, *, secrets=(), sink=None):
        self.module, self.provenance = _load(source)
        self.observer = AgentTetherObserver(self.provenance, secrets=secrets, sink=sink)
        self.undos = []

    def wrap(self, function, *, name, signal='tool', inputs=None, outcome=tool_result):
        """Use the upstream wrapper on a mutable shim, not a Pydantic client."""
        async_call = is_async(function)
        observer = self.observer
        def before(args, kwargs):
            parent = _invocation.get()
            try:
                label = name(args, kwargs) if callable(name) else name
                parameters = inputs(args, kwargs) if inputs else {'args': args, 'kwargs': kwargs}
            except Exception:
                observer.fault()
                label = 'capture-boundary'
                parameters = {'capture_input_unavailable': True}
            return dict(name=label, signal=signal, parent=parent.get('span') if parent else None,
                        input=json_value(parameters), outcome=outcome)

        @functools.wraps(function)
        def guarded(*args, **kwargs):
            state = _invocation.get()
            try:
                result = function(*args, **kwargs)
                state['result'] = result
                return result
            except BaseException as error:
                state['exception'] = error
                raise

        @functools.wraps(function)
        async def async_guarded(*args, **kwargs):
            state = _invocation.get()
            try:
                result = await function(*args, **kwargs)
                state['result'] = result
                return result
            except BaseException as error:
                state['exception'] = error
                raise

        shim = types.SimpleNamespace(invoke=async_guarded if async_call else guarded)
        patch = self.module.instrument_async_callable_attr if async_call else self.module.instrument_callable_attr
        patch(target=shim, attr='invoke', observer=observer, span_name=str(name) if not callable(name) else 'dynamic', kind=signal,
              input_builder=lambda a, k: _invocation.get()['input'], output_builder=lambda value: '',
              meta_builder=lambda a, k: {'span.kind': signal, 'capture.layer': 'explicit-boundary'})
        if shim.invoke is (async_guarded if async_call else guarded):
            raise RuntimeError('AgentTether wrapper was not installed')

        def active():
            return observer.external_sink or bool(os.environ.get('AGENTOPS_SPOOL'))

        @functools.wraps(function)
        def invoke(*args, **kwargs):
            if not active():
                return function(*args, **kwargs)
            token = _invocation.set(before(args, kwargs))
            try:
                return shim.invoke(*args, **kwargs)
            finally:
                _invocation.reset(token)

        @functools.wraps(function)
        async def ainvoke(*args, **kwargs):
            if not active():
                return await function(*args, **kwargs)
            token = _invocation.set(before(args, kwargs))
            try:
                return await shim.invoke(*args, **kwargs)
            finally:
                _invocation.reset(token)
        return ainvoke if async_call else invoke

    def patch(self, target, attr, **options):
        original = getattr(target, attr)
        wrapped = self.wrap(original, **options)
        # Fail visibly at setup instead of silently claiming successful capture.
        existed = attr in vars(target)
        setattr(target, attr, wrapped)
        def undo():
            if getattr(target, attr) is wrapped:
                if existed:
                    setattr(target, attr, original)
                else:
                    delattr(target, attr)
        self.undos.append(undo)
        return wrapped

    def openai(self, client):
        """Explicit client instance, sync or async Chat Completions only."""
        target = client.chat.completions
        original = target.create
        recorded = self.wrap(original, name='openai.chat.completions', signal='llm',
                             inputs=lambda a, k: k, outcome=lambda r: (True, None))
        if is_async(original):
            async def create(*a, **k):
                if k.get('stream'):
                    self.observer.unsupported('openai.chat.completions.stream')
                    return await original(*a, **k)
                return await recorded(*a, **k)
        else:
            def create(*a, **k):
                if k.get('stream'):
                    self.observer.unsupported('openai.chat.completions.stream')
                    return original(*a, **k)
                return recorded(*a, **k)
        existed = 'create' in vars(target)
        setattr(target, 'create', create)
        def undo():
            if target.create is create:
                if existed:
                    setattr(target, 'create', original)
                else:
                    delattr(target, 'create')
        self.undos.append(undo)
        return client

    def langchain(self, runnable):
        return _RunnableProxy(runnable, self)

    def mcp(self, session):
        self.patch(session, 'call_tool', name=lambda a, k: a[0] if a else k.get('name', 'mcp.call_tool'),
                   inputs=lambda a, k: {'arguments': a[1] if len(a)>1 else k.get('arguments')})
        return session

    def httpx(self, client, *, collector_url=None):
        """Bound instance signature: method, url (no misinterpreted self)."""
        from urllib.parse import urlsplit
        def address(url):
            parsed = urlsplit(str(url))
            return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80)
        original = client.request
        wrapped = self.wrap(original, name='httpx.request', signal='http',
                            inputs=lambda a, k: {'method': a[0] if a else k.get('method'), 'url': str(a[1] if len(a)>1 else k.get('url'))},
                            outcome=lambda r: (r.status_code < 400, None if r.status_code < 400 else 'HTTP ' + str(r.status_code)))
        def is_collector(a, k):
            return collector_url and address(a[1] if len(a)>1 else k.get('url')) == address(collector_url)
        if is_async(original):
            async def request(*a, **k):
                return await (original(*a, **k) if is_collector(a, k) else wrapped(*a, **k))
        else:
            def request(*a, **k):
                return original(*a, **k) if is_collector(a, k) else wrapped(*a, **k)
        existed = 'request' in vars(client)
        setattr(client, 'request', request)
        def undo():
            if client.request is request:
                if existed:
                    setattr(client, 'request', original)
                else:
                    delattr(client, 'request')
        self.undos.append(undo)
        return client

    def close(self):
        for undo in reversed(self.undos):
            undo()
        self.undos.clear()
        if self.observer.pending:
            self.observer.fault()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class _RunnableProxy:
    """Delegates without mutating Pydantic fields or changing model results.

    Explicit boundary proxy, not a substitute for every Runnable operator.
    Caller must keep/use the returned proxy. Factories wrap their returned
    Runnable; the underlying factory execution is never duplicated.
    """
    def __init__(self, runnable, capture):
        self._runnable, self._capture = runnable, capture
        for attr in ('invoke', 'ainvoke'):
            if callable(getattr(runnable, attr, None)):
                wrapped = capture.wrap(getattr(runnable, attr), name='langchain.' + attr, signal='llm',
                                       inputs=lambda a, k: {'model': getattr(runnable, 'model_name', None),
                                                           'input': a[0] if a else k.get('input'), 'options': k,
                                                           'bound_options': getattr(runnable, 'kwargs', {})},
                                       outcome=lambda r: (True, None))
                setattr(self, attr, wrapped)

    def __getattr__(self, name):
        return getattr(self._runnable, name)

    def bind_tools(self, *args, **kwargs):
        return self._capture.langchain(self._runnable.bind_tools(*args, **kwargs))

    def bind(self, *args, **kwargs):
        return self._capture.langchain(self._runnable.bind(*args, **kwargs))

    def with_retry(self, *args, **kwargs):
        return self._capture.langchain(self._runnable.with_retry(*args, **kwargs))
