"""Distributed real-run derivatives must remain importable and evidence-linked."""
import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.main import create_app

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/team-enterpriseops'


def package():
    manifest = json.loads((FIXTURE / 'manifest.json').read_text(encoding='utf-8'))
    names = {r[k] for r in manifest['runs'] for k in ('telemetry', 'report', 'outcome')}
    contents = {name: (FIXTURE / name).read_text(encoding='utf-8') for name in names}
    files = [('manifest', ('manifest.json', json.dumps(manifest), 'application/json'))]
    files += [('files', (name, text, 'application/octet-stream')) for name, text in contents.items()]
    return manifest, contents, files


def test_team_history_import_preserves_pairs_usage_checks_and_evidence(tmp_path):
    manifest, contents, files = package()
    with TestClient(create_app(tmp_path / 'samples.sqlite3')) as client:
        response = client.post('/api/imports', files=files)
        assert response.status_code == 200, response.text
        imported = response.json()
        task = client.get('/api/tasks/' + imported['task_id']).json()
        assert len(task['runs']) == 2
        for index, run in enumerate(task['runs'], 1):
            prefix = '/api/runs/' + run['run_id']
            assert run['origin'] == 'imported' and run['sample_kind'] == 'derived'
            assert run['execution_status'] == 'completed'
            assert run['outcome_status'] == ('failed' if index == 1 else 'passed')
            assert run['confirmed_pairs'] == (7 if index == 1 else 10)
            assert run['feedback'] is None  # No claimed RCA prompt injection.
            assert run['warnings'] == []
            events = client.get(prefix + '/events?limit=200').json()['items']
            raw = [json.loads(line) for line in contents[f'run-{index}.jsonl'].splitlines()]
            assert len(events) == len(raw) == (138 if index == 1 else 170)
            assert [e['occurred_at'] for e in events] == [r['ts'] for r in raw]
            assert [e['duration_ms'] for e in events] == [r['duration_ms'] for r in raw]
            assert all(e['parent_source_id'] is None for e in events)
            metrics = client.get(prefix + '/metrics').json()
            assert metrics['tools']['paired'] == (7 if index == 1 else 10)
            assert metrics['llm']['observed'] == (5 if index == 1 else 7)
            assert metrics['tokens']['with_usage'] == metrics['llm']['completed']
            outcomes = client.get(prefix + '/outcomes').json()
            assert len(outcomes) == 1 and outcomes[0]['authoritative']
            checks = outcomes[0]['basis']['checks']
            assert len(checks) == 14
            assert sum(c['result']['passed'] for c in checks) == (10 if index == 1 else 14)
            assert client.get('/api/evidence/' + outcomes[0]['evidence_id']).status_code == 200
            reports = client.get(prefix + '/diagnoses').json()
            assert len(reports) == 1 and reports[0]['origin'] == 'imported'
            refs = [ref for f in reports[0]['findings'] for ref in f['evidence']]
            assert len(refs) == 2
            for ref in refs:
                assert ref['resolution_status'] == 'resolved'
                evidence = client.get('/api/evidence/' + ref['evidence_id']).json()
                assert evidence['run_id'] == run['run_id']
                assert evidence['event_id'] == ref['event_id']
                assert json.loads(evidence['content']) == raw[evidence['line'] - 1]
            assert client.get(prefix).json()['outcome_status'] == run['outcome_status']
        again = client.post('/api/imports', files=files).json()
        assert again['duplicate'] and again['run_ids'] == imported['run_ids']


def test_team_history_has_explicit_redactions_and_no_private_endpoints():
    manifest, contents, _ = package()
    assert manifest['sample_kind'] == 'derived'
    text = '\n'.join(contents.values())
    assert '[REDACTED:' in text
    for pattern in (r'https?://', r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}',
                    r'[A-Za-z]:\\', r'/home/', r'\bsk-[A-Za-z0-9_-]{12,}',
                    r'\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b'):
        assert not re.search(pattern, text), pattern
    notes = json.loads((FIXTURE / 'sample-notes.json').read_text(encoding='utf-8'))
    assert 'not platform RCA injection' in notes['iteration_driver']
