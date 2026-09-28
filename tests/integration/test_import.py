import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app

FIXTURE=Path(__file__).resolve().parents[1]/'fixtures/demo'


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path/'app.sqlite3')) as c:
        yield c


def package():
    manifest=json.loads((FIXTURE/'manifest.json').read_text(encoding='utf-8'))
    names={r[k] for r in manifest['runs'] for k in ('telemetry','report','outcome','feedback') if r.get(k)}
    return manifest,{name:(FIXTURE/name).read_text(encoding='utf-8') for name in names}


def upload(client,manifest=None,contents=None):
    if manifest is None:manifest,contents=package()
    files=[('manifest',('manifest.json',json.dumps(manifest),'application/json'))]
    files += [('files',(name,text,'application/octet-stream')) for name,text in contents.items()]
    return client.post('/api/imports',files=files)


def test_two_attempts_states_evidence_and_idempotency(client):
    response=upload(client);assert response.status_code==200,response.text
    result=response.json()
    task=client.get('/api/tasks/'+result['task_id']).json()
    a,b=task['runs']
    assert [a['attempt_index'],b['attempt_index']]==[1,2]
    assert a['raw_attempts']==b['raw_attempts']==[0]
    assert [a['outcome_status'],b['outcome_status']]==['failed','passed']
    assert a['execution_status']==b['execution_status']=='completed'
    assert b['report_ok'] is False
    assert 'report_ok_differs_from_outcome' in b['warnings']
    assert b['model_status']=='unavailable'
    report=client.get('/api/runs/'+a['run_id']+'/diagnoses').json()[0]
    reference=report['findings'][0]['evidence'][0]
    evidence=client.get('/api/evidence/'+reference['evidence_id']).json()
    assert evidence['run_id']==a['run_id']
    assert json.loads(evidence['content'])['correlation_id']=='shared-test'
    assert evidence['line']>1 and len(evidence['sha256'])==64
    unresolved=report['findings'][0]['evidence'][1]
    assert unresolved['resolution_status']=='unresolved'
    assert client.get('/api/evidence/'+unresolved['evidence_id']).json()['content']=={'span_id':'not-recorded'}
    again=upload(client).json();assert again['duplicate'] and again['import_id']==result['import_id']
    assert len(client.get('/api/tasks').json())==1


def test_cross_run_ids_and_pagination(client):
    task=client.get('/api/tasks/'+upload(client).json()['task_id']).json()
    evidence_sets=[]
    for run in task['runs']:
        url='/api/runs/'+run['run_id']
        first=client.get(url+'/events?limit=3').json()
        second=client.get(url+'/events?limit=3&offset=3').json()
        assert {e['event_id'] for e in first['items']}.isdisjoint(e['event_id'] for e in second['items'])
        links=client.get(url+'/links').json()
        assert all(link['run_id']==run['run_id'] for link in links)
        events=client.get(url+'/events').json()['items']
        ids={e['event_id'] for e in events}
        assert all(set(link['event_ids'])<=ids for link in links)
        evidence_sets.append({e['evidence_id'] for e in events})
        filtered=client.get(url+'/events?kind=tool_return&q=bash').json()
        assert all(e['kind']=='tool_return' and e['name']=='bash' for e in filtered['items'])
    assert evidence_sets[0].isdisjoint(evidence_sets[1])


def test_changed_run_is_conflict_not_overwrite(client):
    result=upload(client).json();manifest,contents=package()
    contents['run-1.jsonl']+='\n'
    response=upload(client,manifest,contents)
    assert response.status_code==409
    assert len(client.get('/api/tasks/'+result['task_id']).json()['runs'])==2


def test_invalid_second_run_rolls_back_entire_package(client):
    manifest,contents=package();contents['run-2.jsonl']='not json'
    assert upload(client,manifest,contents).status_code==422
    assert client.get('/api/tasks').json()==[]
    assert client.get('/api/imports').json()==[]
    with client.app.state.store.connect() as db:
        assert db.execute('SELECT count(*) FROM artifacts').fetchone()[0]==0


@pytest.mark.parametrize('name',['../outside.jsonl','C:\\outside.jsonl','.hidden','folder/run.jsonl'])
def test_path_traversal_rejected(client,name):
    manifest,contents=package();manifest['runs'][0]['telemetry']=name
    assert upload(client,manifest,contents).status_code==422


def test_missing_return_and_duplicate_correlation_preserved(client):
    manifest,contents=package()
    rows=[json.loads(line) for line in contents['run-1.jsonl'].splitlines()]
    rows=[r for r in rows if not (r['kind']=='tool_return' and r.get('correlation_id')=='shared-test')]
    extra=copy.deepcopy(next(r for r in rows if r['kind']=='tool_call' and r['correlation_id']=='shared-read'))
    extra['span_id']='extra-call';rows.append(extra)
    contents['run-1.jsonl']='\n'.join(json.dumps(r) for r in rows)
    response=upload(client,manifest,contents);assert response.status_code==200
    run=client.get('/api/runs/'+response.json()['run_ids'][0]).json()
    assert run['event_count']==len(rows)
    assert {'call_return_unresolved','call_return_ambiguous'}<=set(run['warnings'])
    report=client.get('/api/runs/'+run['run_id']+'/diagnoses').json()[0]
    assert report['findings'][0]['evidence'][0]['resolution_status']=='unresolved'


def test_missing_outcome_and_diagnosis_are_not_success(client):
    manifest,contents=package()
    for spec in manifest['runs']:
        for key in ['outcome','report']:contents.pop(spec.pop(key))
    result=upload(client,manifest,contents).json()
    for rid in result['run_ids']:
        run=client.get('/api/runs/'+rid).json()
        assert run['outcome_status']=='unknown'
        assert 'outcome_missing' in run['warnings']
        assert client.get('/api/runs/'+rid+'/diagnoses').json()==[]


def test_conflicting_evaluator_records_remain_unknown(client):
    manifest,contents=package()
    contents['run-2.outcome.json']=json.dumps({'outcome_evidence':[{'resolved':True},{'resolved':False}]})
    result=upload(client,manifest,contents).json()
    run=client.get('/api/runs/'+result['run_ids'][1]).json()
    assert run['outcome_status']=='unknown' and 'outcome_conflict' in run['warnings']


def test_restart_preserves_imports(tmp_path):
    path=tmp_path/'persist.sqlite3'
    with TestClient(create_app(path)) as client: result=upload(client).json()
    with TestClient(create_app(path)) as client:
        assert client.get('/api/tasks/'+result['task_id']).status_code==200
        assert upload(client).json()['duplicate'] is True


def test_origin_file_limit_and_non_utf8(client,monkeypatch):
    assert client.post('/api/examples/import',headers={'origin':'https://untrusted.example'}).status_code==403
    manifest,contents=package()
    monkeypatch.setattr('apps.api.main.MAX_FILE',16)
    assert upload(client,manifest,contents).status_code==413
    monkeypatch.setattr('apps.api.main.MAX_FILE',1024*1024)
    contents['run-1.jsonl']=b'\xff\xfe'
    assert upload(client,manifest,contents).status_code==422
    assert client.get('/api/tasks').json()==[]


def test_request_size_limit(client,monkeypatch):
    monkeypatch.setattr('apps.api.main.MAX_BODY',32)
    assert client.post('/api/imports',content=b'x'*33).status_code==413


def test_concurrent_identical_imports_share_one_result(client):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:upload(client),range(2)))
    assert all(r.status_code==200 for r in results)
    assert len({r.json()['import_id'] for r in results})==1


def test_ids_not_paths_and_invalid_pagination(client):
    assert client.get('/api/evidence/not-present').status_code==404
    assert client.get('/api/unknown').status_code==404
    result=upload(client).json()
    assert client.get('/api/runs/'+result['run_ids'][0]+'/events?limit=999').status_code==422


def test_unknown_task_namespace_does_not_merge(client):
    upload(client)
    manifest,contents=package();manifest['source_namespace']='separate-experiment'
    assert upload(client,manifest,contents).status_code==200
    assert len(client.get('/api/tasks').json())==2
