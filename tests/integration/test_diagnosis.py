"""Job contract tests use an explicitly synthetic worker; no model API calls."""
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.api.main import create_app
from apps.api.diagnosis import DiagnosisManager,make_snapshot
from apps.api.storage import payload,dumps
from apps.api.storage import Store
from apps.api.diagnosis_worker import load_model,source_hash
from tests.integration.test_live import create,event,send,finish


@pytest.fixture
def client(tmp_path,monkeypatch):
    with TestClient(create_app(tmp_path/'test.sqlite3',diagnosis_config=tmp_path/'absent.json')) as c:
        manager=c.app.state.diagnosis
        monkeypatch.setattr(manager,'capabilities',lambda:{'status':'degraded','hgt':'ready','analyst':'disabled'})
        monkeypatch.setattr(manager,'config',lambda:{'python':sys.executable})
        yield c


def completed(client,items=None):
    run,h,_=create(client)
    items=items or [event(),event(2,kind='tool_return',ok=False,output={'returncode':1})]
    assert send(client,run,h,items).status_code==200
    assert finish(client,run,h,producers={'test':len(items)}).status_code==200
    return run['run_id']


def state(client,rid):return client.get('/api/runs/'+rid+'/diagnosis-jobs').json()[0]


def wait_done(client,rid):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        job=state(client,rid)
        if job['state'] not in ('queued','running'):return job
        time.sleep(.02)
    raise AssertionError('Job did not finish')


def fake_worker(monkeypatch,mode='success'):
    started=threading.Event();released=threading.Event()
    class Process:
        returncode=None
        def __init__(self,args,**kwargs):
            self.output=Path(args[args.index('--output')+1]);self.input=Path(args[args.index('--input')+1]);started.set()
        def poll(self):return self.returncode
        def terminate(self):self.returncode=-1;released.set()
        kill=terminate
        def wait(self,timeout=None):
            if self.returncode is not None:return self.returncode
            if mode=='timeout':raise subprocess.TimeoutExpired('fixture',timeout)
            if mode=='blocked':released.wait(5)
            if self.returncode is not None:return self.returncode
            snapshot=json.loads(self.input.read_text(encoding='utf-8'))
            result={'format':'agenttether-hgt','model_status':'ready','model_reason':'Synthetic test fixture',
                    'summary':'Synthetic fixture, not real inference','findings':[{'title':'fixture','severity':'warn','description':'fixture','event_ids':[snapshot['events'][0]['span_id'],'unresolvable']}],
                    'graph':None,'runtime_memory':None,'guidance':None,'provenance':{'fixture':True}}
            self.output.write_text(dumps(result),encoding='utf-8');self.returncode=0;return 0
    monkeypatch.setattr('apps.api.diagnosis.subprocess.Popen',Process)
    return started,released


def test_snapshot_report_idempotency_and_evidence(client,monkeypatch):
    fake_worker(monkeypatch)
    rid=completed(client,[event(),event(2,kind='tool_return',ok=True,output={'returncode':1}),event(3,kind='verification',name='OUTCOME_EVIDENCE',input={'status':'failed','source':'test','basis':'expected evaluator result'})])
    before=client.get('/api/runs/'+rid).json()
    with client.app.state.store.connect() as db:
        db.execute('INSERT INTO diagnoses VALUES (?,?,?)',('historical',rid,dumps({'diagnosis_id':'historical','origin':'imported','summary':'unchanged history'})))
    spec={'request_id':uuid4().hex}
    first=client.post('/api/runs/'+rid+'/diagnosis-jobs',json=spec);assert first.status_code==200,first.text
    assert wait_done(client,rid)['state']=='succeeded'
    assert client.post('/api/runs/'+rid+'/diagnosis-jobs',json=spec).json()['job_id']==first.json()['job_id']
    reports=client.get('/api/runs/'+rid+'/diagnoses').json();assert len(reports)==2
    assert next(r for r in reports if r['diagnosis_id']=='historical')['summary']=='unchanged history'
    report=next(r for r in reports if r['origin']=='recomputed')
    snapshot=client.get('/api/evidence/'+report['input_evidence_id']).json()['content']
    assert len(snapshot['events'])==2 and snapshot['events'][1]['ok'] is False
    assert snapshot['adjustments'] and snapshot['events'][0]['span_id'] in snapshot['evidence_map']
    refs=report['findings'][0]['evidence'];assert refs[0]['resolution_status']=='resolved' and refs[1]['resolution_status']=='unresolved'
    assert client.get('/api/evidence/'+refs[0]['evidence_id']).status_code==200
    after=client.get('/api/runs/'+rid).json()
    assert before['snapshot_hash']==after['snapshot_hash'] and before['outcome_status']==after['outcome_status']


@pytest.mark.parametrize('mode,expected',[('timeout','timed_out'),('blocked','cancelled')])
def test_cancel_timeout_never_publish(client,monkeypatch,mode,expected):
    started,released=fake_worker(monkeypatch,mode)
    rid=completed(client)
    job=client.post('/api/runs/'+rid+'/diagnosis-jobs',json={'request_id':uuid4().hex}).json()
    assert started.wait(2)
    if mode=='blocked':
        assert client.post('/api/runs/'+rid+'/diagnosis-jobs',json={'request_id':uuid4().hex}).status_code==409
        client.post('/api/diagnosis-jobs/'+job['job_id']+'/cancel')
    assert wait_done(client,rid)['state']==expected
    assert client.get('/api/runs/'+rid+'/diagnoses').json()==[]


@pytest.mark.parametrize('items',[
    [event(),event(2,correlation_id='overlap'),event(3,kind='tool_return',correlation_id='overlap'),event(4,kind='tool_return')],
    [event(),event(2,kind='tool_return',correlation_id='missing')],
    [event()],
    [event(),event(2,kind='tool_return',ok=False,output={'returncode':0})],
])
def test_reject_unsupported_inputs(client,items):
    rid=completed(client,items)
    assert client.post('/api/runs/'+rid+'/diagnosis-jobs',json={'request_id':uuid4().hex}).status_code==409
    assert client.get('/api/runs/'+rid+'/diagnosis-jobs').json()==[]


def test_unfinished_and_unavailable(client,monkeypatch):
    run,_,_=create(client)
    assert client.post('/api/runs/'+run['run_id']+'/diagnosis-jobs',json={'request_id':uuid4().hex}).status_code==409
    manager=client.app.state.diagnosis
    monkeypatch.setattr(manager,'config',lambda:None)
    assert DiagnosisManager.capabilities(manager)['status']=='unavailable'


def test_restart_recovery_and_late_result(client,monkeypatch):
    manager=client.app.state.diagnosis
    monkeypatch.setattr(manager,'run',lambda *args:None)
    rid=completed(client)
    job=client.post('/api/runs/'+rid+'/diagnosis-jobs',json={'request_id':uuid4().hex}).json()
    manager.recover();assert state(client,rid)['state']=='interrupted'
    manager.persist(job['job_id'],{}, {'format':'agenttether-hgt','model_status':'ready'})
    assert client.get('/api/runs/'+rid+'/diagnoses').json()==[]


def test_weight_integrity_checked_before_loading(tmp_path):
    (tmp_path/'agent_tether').mkdir()
    (tmp_path/'hgt_normal_model.pt').write_bytes(b'corrupted weight, never deserialize')
    with pytest.raises(ValueError,match='weight_hash_mismatch'):
        load_model({'source':str(tmp_path),'bundle':str(tmp_path),'source_sha256':source_hash(tmp_path),'weight_sha256':'0'*64})


def test_v2_migration_backup_preserves_records(tmp_path):
    store=Store(tmp_path/'migration.sqlite3')
    with store.connect() as db:
        db.execute("INSERT INTO tasks VALUES ('t','test','test','keep','synthetic')")
        db.execute('DROP TABLE diagnosis_jobs');db.execute('PRAGMA user_version=2')
    store=Store(store.path)
    with store.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0]==3
        assert db.execute('SELECT goal FROM tasks').fetchone()[0]=='keep'
    assert store.path.with_name(store.path.name+'.v2-backup.sqlite3').exists()
