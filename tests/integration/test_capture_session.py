"""Synthetic protocol tests; these never call an LLM or third-party gym."""
import json
import os
from uuid import uuid4

import pytest

from agentops_cli import emit, verification
from agentops_cli.session import CaptureSession


def test_embedded_attempts_keep_task_but_separate_execution_outcome(tmp_path, monkeypatch):
    import agentops_cli.session as module
    posts = []

    class Transport:
        def __init__(self, server, token):
            self.url = server

        def post(self, path, payload):
            posts.append((path, payload))
            if path == '/api/live/runs':
                run_id = uuid4().hex
                return dict(run_id=run_id, task_id=payload['task_id'] or uuid4().hex,
                            url='/runs/' + run_id)
            return {}

    monkeypatch.setattr(module, 'Transport', Transport)
    monkeypatch.delenv('AGENTOPS_SPOOL', raising=False)
    with CaptureSession(server='http://127.0.0.1:8001', goal='same task', spool_dir=tmp_path) as first:
        emit('tool_call', 'modify', correlation_id='real-id', input={'api_key': 'secret'})
        emit('tool_return', 'modify', correlation_id='real-id', output={'success': False}, ok=False)
        verification('failed', source='independent-sql', basis={'actual': 0, 'expected': 1})
        with pytest.raises(RuntimeError, match='non-nested'):
            with CaptureSession(server=first.server, goal='nested', spool_dir=tmp_path):
                pass
    assert first.finished
    assert 'AGENTOPS_SPOOL' not in os.environ
    with CaptureSession(server=first.server, goal='same task', task_id=first.task_id,
                        spool_dir=tmp_path) as second:
        verification('passed', source='independent-sql', basis={'actual': 1, 'expected': 1})
    creates = [body for path, body in posts if path == '/api/live/runs']
    assert creates[1]['task_id'] == first.task_id
    assert first.run_id != second.run_id
    finishes = [body for path, body in posts if path.endswith('/finish')]
    assert len(finishes) == 2 and all(f['exit_code'] == 0 for f in finishes)
    events = [e for path, body in posts if path.endswith('/events') for e in body['events']]
    assert {e['input']['status'] for e in events if e['kind'] == 'verification'} == {'passed', 'failed'}
    assert 'secret' not in json.dumps(events)
    assert sum(e['name'] == 'RUN_END' for e in events) == 2


def test_exception_closes_capture_and_propagates(tmp_path, monkeypatch):
    import agentops_cli.session as module
    posted = []

    class Transport:
        def __init__(self, server, token):
            self.url = server

        def post(self, path, body):
            posted.append((path, body))
            return dict(run_id='r', task_id='t', url='/runs/r')

    monkeypatch.setattr(module, 'Transport', Transport)
    monkeypatch.delenv('AGENTOPS_SPOOL', raising=False)
    with pytest.raises(ValueError, match='actual agent error'):
        with CaptureSession(server='http://127.0.0.1:8001', goal='task', spool_dir=tmp_path):
            raise ValueError('actual agent error')
    assert 'AGENTOPS_SPOOL' not in os.environ
    assert [body for path, body in posted if path.endswith('/finish')][0]['exit_code'] == 1


def test_independent_check_aggregation_retains_uncertainty():
    from scripts.run_enterpriseops import check_status

    def record(passed, error=None, kind='database_state'):
        return {'type': kind, 'result': {'passed': passed, 'error': error}}

    assert check_status([]) == 'unknown'
    assert check_status([record(True), record(False)]) == 'failed'
    assert check_status([record(True), record(False, 'database unavailable')]) == 'unknown'
    assert check_status([record(True), record(True)]) == 'passed'
    assert check_status([record(True, kind='response_checker')]) == 'unknown'


def test_adapter_redacts_known_credentials_in_upstream_repr_logs(monkeypatch):
    import io
    import logging
    from scripts import run_enterpriseops as adapter

    secrets = ['nonstandard-model-credential', 'nonstandard-mcp-credential']
    original = "context={'x-email-user-token': 'nonstandard-mcp-credential'} api='nonstandard-model-credential'"
    output = io.StringIO()
    adapter.RedactingStream(output, secrets).write(original)
    assert all(secret not in output.getvalue() for secret in secrets)
    captured = []
    monkeypatch.setattr(adapter, 'emit', lambda *args, **kwargs: captured.append(kwargs))
    adapter.CaptureLog(secrets).emit(logging.makeLogRecord({'msg': original, 'name': 'upstream'}))
    assert captured and all(secret not in captured[0]['output'] for secret in secrets)


def test_mcp_errors_are_not_mistaken_for_http_transport_success():
    from scripts.run_enterpriseops import tool_outcome

    assert tool_outcome({'success': True, 'result': {'content': []}, 'error': None}) == (True, None)
    assert tool_outcome({'success': False, 'error': 'connection failed'}) == (False, 'connection failed')
    assert tool_outcome({'success': True, 'error': {'code': -32602}})[0] is False
    assert tool_outcome({'success': True, 'result': {'isError': True, 'content': ['bad input']}})[0] is False
    assert tool_outcome({'result': {}}) == (None, None)
