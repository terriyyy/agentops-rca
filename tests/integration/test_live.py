import copy
import json
import sqlite3
from datetime import datetime, timezone, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from apps.api.storage import MIGRATION, Store


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path/'live.sqlite3')) as c:yield c


def create(client,**changes):
    spec={'request_id':uuid4().hex,'write_token':'t'*40,'goal':'test','sample_kind':'synthetic',**changes}
    r=client.post('/api/live/runs',json=spec);assert r.status_code==200,r.text
    return r.json(),{'Authorization':'Bearer '+spec['write_token']},spec


def event(seq=1,**fields):
    return {'event_id':uuid4().hex,'producer_id':'test','producer_seq':seq,'occurred_at':datetime.now(timezone.utc).isoformat(),'kind':'tool_call','name':'shell','source_span_id':uuid4().hex,'correlation_id':'pair',**fields}


def send(client,run,headers,items):
    return client.post('/api/live/runs/'+run['run_id']+'/events',headers=headers,json={'events':items})


def finish(client,run,headers,**extra):
    return client.post('/api/live/runs/'+run['run_id']+'/finish',headers=headers,json={'exit_code':0,'producers':{'test':2},**extra})


def test_idempotency_and_atomic_conflicts(client):
    run,h,spec=create(client)
    assert client.post('/api/live/runs',json=spec).json()==run
    assert client.post('/api/live/runs',json={**spec,'goal':'changed'}).status_code==409
    e=event()
    assert send(client,run,h,[e]).json()['accepted']==1
    assert send(client,run,h,[e]).json()['accepted']==0
    assert send(client,run,h,[event(2),{**e,'name':'changed'}]).status_code==409
    assert client.get('/api/runs/'+run['run_id']).json()['event_count']==1
    assert send(client,run,{},[event(2)]).status_code==401
    assert 'write_token' not in client.get('/api/runs/'+run['run_id']).text


def test_out_of_order_evidence_finish_and_replay(client):
    run,h,_=create(client)
    returned=event(2,kind='tool_return',ok=True,output={'returncode':1})
    assert send(client,run,h,[returned]).status_code==200
    assert finish(client,run,h).json()['capture_integrity']=='pending'
    assert send(client,run,h,[event()]).status_code==200
    data=client.get('/api/runs/'+run['run_id']).json()
    assert data['capture_integrity']=='complete' and len(data['snapshot_hash'])==64
    assert data['execution_status']=='completed' and data['outcome_status']=='unknown'
    assert data['confirmed_pairs']==1 and data['failed_tool_count']==1
    assert send(client,run,h,[event(3)]).status_code==409
    row=client.get('/api/runs/'+run['run_id']+'/events').json()['items'][0]
    assert client.get('/api/evidence/'+row['evidence_id']).json()['content']['event_id']==returned['event_id']
    with client.app.state.store.connect() as db:
        changes=db.execute('SELECT cursor FROM live_changes WHERE run_id=? ORDER BY cursor',(run['run_id'],)).fetchall()
        assert len(changes)==4
        assert len({r[0] for r in changes})==4


def test_independent_outcome_and_task_grouping(client):
    run,h,_=create(client)
    e=event(kind='verification',input={'status':'failed','source':'pytest','basis':'actual assertion'})
    assert send(client,run,h,[e]).status_code==200
    data=finish(client,run,h,producers={'test':1}).json()
    assert data['execution_status']=='completed' and data['outcome_status']=='failed'
    second,_,_=create(client,task_id=run['task_id'])
    assert client.get('/api/runs/'+second['run_id']).json()['attempt_index']==2
    assert client.get('/api/runs/'+second['run_id']).json()['outcome_status']=='unknown'


def test_missing_outcome_fields_roll_back(client):
    run,h,_=create(client)
    assert send(client,run,h,[event(kind='verification',input={'status':'passed'})]).status_code==422
    assert client.get('/api/runs/'+run['run_id']).json()['event_count']==0


@pytest.mark.parametrize('reason,code,status',[('exit',4,'failed'),('interrupted',130,'cancelled'),('launch_failed',127,'failed')])
def test_terminal_states(client,reason,code,status):
    run,h,_=create(client)
    data=finish(client,run,h,reason=reason,exit_code=code,producers={},dropped=1).json()
    assert data['execution_status']==status and data['outcome_status']=='unknown'
    assert data['capture_integrity']=='partial'


def test_disconnection_expiry_and_cross_run_isolation(client):
    a,ha,_=create(client);b,hb,_=create(client,write_token='b'*40)
    assert send(client,b,ha,[event()]).status_code==401
    e=event()
    assert send(client,a,ha,[e]).status_code==200
    assert send(client,b,hb,[e]).status_code==200
    with client.app.state.store.connect() as db:
        db.execute('UPDATE capture_sessions SET last_seen_at=? WHERE run_id=?',((datetime.now(timezone.utc)-timedelta(seconds=30)).isoformat(),a['run_id']))
    data=client.get('/api/runs/'+a['run_id']).json()
    assert data['capture_status']=='disconnected' and data['execution_status']=='running'
    assert data['outcome_status']=='unknown'
    with client.app.state.store.connect() as db:
        db.execute('UPDATE capture_sessions SET expires_at=? WHERE run_id=?',((datetime.now(timezone.utc)-timedelta(seconds=30)).isoformat(),a['run_id']))
    assert send(client,a,ha,[e]).status_code==401


def test_schema_limits_and_origin_guard(client):
    run,h,_=create(client)
    assert send(client,run,h,[event(producer_seq=-1)]).status_code==422
    assert send(client,run,h,[event(output='x'*70000)]).status_code==413
    assert finish(client,run,h,producers={'bad':-1}).status_code==422
    assert client.post('/api/live/runs',headers={'Origin':'https://other.example'},json={}).status_code==403
    body=json.dumps({'events':[event(input={'nested':float('nan')})]})
    assert client.post('/api/live/runs/'+run['run_id']+'/events',headers={**h,'Content-Type':'application/json'},content=body).status_code==422


def test_migration_keeps_v1_and_backup(tmp_path):
    path=tmp_path/'old.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript(MIGRATION)
        db.execute('INSERT INTO tasks VALUES (?,?,?,?,?)',('old','history','old','preserved','historical'))
    store=Store(path)
    with store.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0]==3
        assert db.execute('SELECT goal FROM tasks').fetchone()[0]=='preserved'
    assert path.with_name(path.name+'.v1-backup.sqlite3').exists()
    assert Store(path)
