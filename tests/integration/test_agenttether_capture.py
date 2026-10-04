"""Bridge protocol tests; private-wrapper tests require an explicit source."""
import asyncio
import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agentops_cli.agenttether import AgentTetherCapture, AgentTetherObserver, tool_result
from agentops_cli.spool import Spool, clean
from apps.api.diagnosis import make_snapshot
from apps.api.main import create_app
from apps.api.storage import payload
from tests.integration.test_live import create, send, finish, event


@pytest.fixture
def source():
    path = os.environ.get('AGENTOPS_AGENTTETHER_SOURCE')
    if not path:
        pytest.skip('Private AgentTether source not supplied')
    return path


def test_token_counts_do_not_disable_secret_redaction():
    value = clean({'usage': {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5},
                   'token': 'credential', 'api_key': 'credential',
                   'prompt_tokens': 'credential', 'completion_tokens': True, 'cached_tokens': -1})
    assert value['usage'] == {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5}
    assert all(value[k] == '[REDACTED]' for k in ('token', 'api_key', 'prompt_tokens', 'completion_tokens', 'cached_tokens'))


def test_unknown_and_end_only_are_not_invented_failures():
    events = []
    observer = AgentTetherObserver({'adapter': 'test'}, sink=lambda k, n, **v: events.append(dict(kind=k, name=n, **v)))
    observer.on_tool_call('tool', {}, correlation_id='actual')
    observer.on_tool_return('tool', {}, correlation_id='actual', ok=None)
    assert events[-1]['ok'] is None and events[-1]['error_signature'] is None
    observer.on_llm_end('only end', {'total_tokens': 5}, latency_ms=42)
    assert events[-1]['capture']['phase'] == 'end_only'
    assert 'correlation_id' not in events[-1]
    assert tool_result({'result': {}}) == (None, None)
    assert tool_result({'success': True, 'result': {'isError': True}})[0] is False


def test_missing_source_fails_before_agent_execution(tmp_path):
    with pytest.raises(ValueError, match='source must contain'):
        AgentTetherCapture(tmp_path)


def test_legacy_receipt_hash_is_unchanged_by_optional_capture(tmp_path):
    from apps.api.live_contracts import LiveEvent
    from apps.api.storage import dumps
    from apps.api.importer import digest
    with TestClient(create_app(tmp_path / 'legacy.sqlite3')) as client:
        run, headers, _ = create(client)
        item = event()
        legacy = LiveEvent.model_validate(item).model_dump(mode='json')
        legacy.pop('capture')
        assert send(client, run, headers, [item]).status_code == 200
        with client.app.state.store.connect() as db:
            received = db.execute('SELECT hash FROM live_receipts WHERE run_id=?', (run['run_id'],)).fetchone()[0]
            assert received == digest(dumps(legacy))
        assert send(client, run, headers, [item]).json()['accepted'] == 0


def test_private_wrappers_results_nested_parent_exception_and_cancel(source):
    events = []
    with AgentTetherCapture(source, secrets=['private-credential'], sink=lambda k, n, **v: events.append(dict(kind=k, name=n, **v))) as capture:
        inner = capture.wrap(lambda: {'returncode': 1}, name='inner')
        outer = capture.wrap(lambda: inner(), name='outer')
        assert outer() == {'returncode': 1}
        assert events[1]['parent_source_id'] == events[0]['source_span_id']
        assert events[2]['ok'] is False and events[3]['ok'] is False
        async def cancel():
            raise asyncio.CancelledError('private-credential')
        wrapped = capture.wrap(cancel, name='cancel')
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(wrapped())
        assert events[-1]['ok'] is False
        assert events[-1]['error_signature'].startswith('CancelledError')
        assert 'private-credential' not in json.dumps(events)
        assert not capture.observer.pending


def test_patch_restores_bound_method_and_input_failure_is_fail_open(source, tmp_path, monkeypatch):
    spool = Spool(tmp_path / 'spool.sqlite3'); spool.initialize({})
    monkeypatch.setenv('AGENTOPS_SPOOL', str(spool.path))
    class Tool:
        def execute(self, x):
            return {'success': True, 'value': x}
    target = Tool()
    def broken(a, k):
        raise ValueError('input builder unavailable')
    with AgentTetherCapture(source) as capture:
        capture.patch(target, 'execute', name='tool', inputs=broken)
        assert target.execute(2)['value'] == 2
    assert 'execute' not in vars(target)
    assert target.execute(3)['value'] == 3
    assert spool.get('collection_error') is True


def test_bridge_delivery_replay_evidence_and_hgt_snapshot(source, tmp_path, monkeypatch):
    spool = Spool(tmp_path / 'spool.sqlite3'); spool.initialize({})
    monkeypatch.setenv('AGENTOPS_SPOOL', str(spool.path))
    with AgentTetherCapture(source, secrets=['model-credential']) as capture:
        wrapped = capture.wrap(lambda: {'success': True, 'result': {'isError': True, 'content': 'tool rejected input'}},
                               name='real-tool', inputs=lambda a, k: {'command': 'example', 'credential': 'model-credential'})
        wrapped()
        spool.append('check', 'verification', 'OUTCOME_EVIDENCE', input={'status': 'failed', 'source': 'independent-check', 'basis': 'evaluator-only-answer'})
    items = [json.loads(r['body']) for r in spool.pending()]
    with TestClient(create_app(tmp_path / 'platform.sqlite3', diagnosis_config=tmp_path / 'missing.json')) as client:
        run, headers, _ = create(client)
        # Finished before retransmission: pending -> complete, no duplicates.
        assert finish(client, run, headers, producers=spool.counts()).json()['capture_integrity'] == 'pending'
        assert send(client, run, headers, items).json()['accepted'] == 3
        assert send(client, run, headers, items).json()['accepted'] == 0
        data = client.get('/api/runs/' + run['run_id']).json()
        assert data['capture_integrity'] == 'complete'
        assert data['execution_status'] == 'completed' and data['outcome_status'] == 'failed'
        assert data['tool_call_count'] == 1 and data['confirmed_pairs'] == 1
        rows = client.get('/api/runs/' + run['run_id'] + '/events').json()['items']
        assert rows[0]['capture']['source_sha256'] == capture.provenance['source_sha256']
        for row in rows:
            evidence = client.get('/api/evidence/' + row['evidence_id']).json()
            assert evidence['resolution_status'] == 'resolved'
            assert 'model-credential' not in json.dumps(evidence)
        with client.app.state.store.connect() as db:
            stored = payload(db.execute('SELECT * FROM runs WHERE id=?', (run['run_id'],)).fetchone())
            snapshot = make_snapshot(db, stored)
            assert len(snapshot['events']) == 2
            assert snapshot['events'][1]['ok'] is False
            assert snapshot['events'][0]['capture']['source_sha256'] == capture.provenance['source_sha256']
            assert 'evaluator-only-answer' not in json.dumps(snapshot)
            assert db.execute('SELECT count(*) FROM diagnosis_jobs').fetchone()[0] == 0
