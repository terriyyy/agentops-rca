"""Workbench projections must preserve independent Run facts across pages."""

from uuid import uuid4

from fastapi.testclient import TestClient

from apps.api.main import create_app
from apps.api.storage import dumps


def test_overview_keeps_execution_outcome_and_report_origin_separate(tmp_path):
    with TestClient(create_app(tmp_path / 'overview.sqlite3')) as client:
        assert client.get('/api/overview').json() == {
            'running': [], 'attention': [], 'recent': []
        }
        imported = client.post('/api/examples/import').json()
        task = client.get('/api/tasks/' + imported['task_id']).json()
        failed, passed = task['runs']
        assert failed['execution_status'] == 'completed'
        assert failed['outcome_status'] == 'failed'
        assert failed['insight']['diagnosis']['state'] == 'historical'
        assert failed['insight']['failure_signals'][-1]['kind'] == 'outcome'
        assert failed['insight']['failure_signals'][-1]['evidence_id']
        overview = client.get('/api/overview').json()
        attention = next(run for run in overview['attention'] if run['run_id'] == failed['run_id'])
        assert attention['insight'] == failed['insight']
        assert 'task_failed' in attention['insight']['attention_reasons']
        assert passed['outcome_status'] == 'passed'
        assert passed['run_id'] in {run['run_id'] for run in overview['recent']}


def test_existing_diagnosis_survives_failed_new_job_in_every_projection(tmp_path):
    with TestClient(create_app(tmp_path / 'diagnosis.sqlite3')) as client:
        imported = client.post('/api/examples/import').json()
        run_id = client.get('/api/tasks/' + imported['task_id']).json()['runs'][0]['run_id']
        job_id = uuid4().hex
        report_id = uuid4().hex
        with client.app.state.store.connect() as db:
            db.execute('INSERT INTO diagnoses VALUES (?,?,?)', (
                report_id, run_id, dumps({
                    'diagnosis_id': report_id, 'origin': 'recomputed',
                    'mode': 'analyst_rca', 'format': 'agenttether-analyst',
                    'summary': '待验证的根因假设',
                }),
            ))
            db.execute('INSERT INTO diagnosis_jobs VALUES (?,?,?,?,?,?)', (
                job_id, run_id, job_id, 'failed', '2026-09-27T10:00:00+00:00',
                dumps({'job_id': job_id, 'run_id': run_id, 'mode': 'analyst_rca',
                       'state': 'failed', 'error': 'provider_timeout'}),
            ))
        paths = ['/api/runs/' + run_id, '/api/tasks/' + imported['task_id'], '/api/overview']
        detail, task, overview = (client.get(path).json() for path in paths)
        projected = [detail, task['runs'][0], next(
            item for item in overview['attention'] if item['run_id'] == run_id
        )]
        assert all(item['insight']['diagnosis']['state'] == 'hypothesis' for item in projected)
        assert all(item['insight']['diagnosis']['latest_job']['state'] == 'failed' for item in projected)
        assert all(item['insight']['diagnosis']['featured_report']['diagnosis_id'] == report_id for item in projected)
        assert all('diagnosis_job_failed' in item['insight']['attention_reasons'] for item in projected)


def test_live_synthetic_and_partial_capture_remain_distinct(tmp_path):
    with TestClient(create_app(tmp_path / 'live.sqlite3')) as client:
        spec = {'request_id': uuid4().hex, 'write_token': 'a' * 40,
                'goal': '本地检查', 'sample_kind': 'synthetic'}
        created = client.post('/api/live/runs', json=spec).json()
        run_id = created['run_id']
        initial = client.get('/api/overview?limit=1').json()
        run = initial['running'][0]
        assert run['run_id'] == run_id
        assert run['origin'] == 'live' and run['sample_kind'] == 'synthetic'
        assert run['outcome_status'] == 'unknown'
        assert run['insight']['diagnosis']['state'] == 'none'
        finished = client.post('/api/live/runs/' + run_id + '/finish',
            headers={'Authorization': 'Bearer ' + spec['write_token']},
            json={'exit_code': 0, 'producers': {}, 'dropped': 1}).json()
        assert finished['execution_status'] == 'completed'
        assert finished['capture_integrity'] == 'partial'
        detail = client.get('/api/runs/' + run_id).json()
        assert detail['outcome_status'] == 'unknown'
        assert detail['insight']['attention_reasons'] == ['capture_incomplete']
        assert client.get('/api/overview').json()['attention'][0]['run_id'] == run_id


def test_old_running_run_is_not_displaced_by_newer_imports(tmp_path):
    with TestClient(create_app(tmp_path / 'bounds.sqlite3')) as client:
        spec = {'request_id': uuid4().hex, 'write_token': 'b' * 40,
                'goal': '等待中的运行'}
        run_id = client.post('/api/live/runs', json=spec).json()['run_id']
        client.post('/api/examples/import')
        overview = client.get('/api/overview?limit=1').json()
        assert [item['run_id'] for item in overview['running']] == [run_id]
        assert len(overview['attention']) <= 1 and len(overview['recent']) <= 1
