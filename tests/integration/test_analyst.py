"""Analyst acceptance contract: all test reports below are explicit fixtures."""
import sys
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.api.main import create_app
from apps.api.diagnosis import DiagnosisManager,make_snapshot
from apps.api.analyst_context import build_prompt,clipped
from apps.api.storage import dumps,payload
from apps.api.importer import uid,digest
from apps.api.model_settings import ConnectionRequest
from tests.integration.test_live import create,event,send,finish


@pytest.fixture
def scenario(tmp_path,monkeypatch):
    with TestClient(create_app(tmp_path/'analyst.sqlite3',diagnosis_config=tmp_path/'absent.json')) as client:
        manager=client.app.state.diagnosis
        source=tmp_path/'fixture-source/agent_tether/recovery'
        source.mkdir(parents=True)
        (source/'llm_analyst.py').write_text('_SYSTEM_PROMPT = "Fixture system instruction"',encoding='utf-8')
        config={'python':sys.executable,'source':str(tmp_path/'fixture-source'),'source_sha256':'s','weight_sha256':'w','manifest_sha256':'m'}
        monkeypatch.setattr(manager,'config',lambda:config)
        monkeypatch.setattr(manager,'capabilities',lambda:{'hgt':'ready','analyst':'configured'})
        manager.models.save(ConnectionRequest(name='api.chatanywhere.tech',base_url='https://api.chatanywhere.tech/v1',
                                              model='gpt-5.6-luna',api_key='dummy-key',expected_revision=None))
        monkeypatch.setattr(manager,'run',lambda *args:None)
        run,headers,_=create(client)
        records=[event(input={'command':'pytest','password':'should-not-leak'}),event(2,kind='tool_return',ok=False,output={'returncode':1,'stderr':'AssertionError'})]
        assert send(client,run,headers,records).status_code==200
        assert finish(client,run,headers).status_code==200
        rid=run['run_id']
        with manager.store.connect() as db:
            row=payload(db.execute('SELECT * FROM runs WHERE id=?',(rid,)).fetchone())
            snapshot=make_snapshot(db,row)
            sid=digest(dumps(snapshot));call,ret=snapshot['events'][:2]
            raw={'format':'agenttether-hgt','model_status':'ready','provenance':config,
                 'selected_units':[{'transition_id':'t1','span_ids':[call['span_id'],ret['span_id']],
                                    'tool':'shell','status':'failure','action':'pytest password=should-not-leak',
                                    'feedback':'AssertionError','error_signature':'assertion'}]}
            aid=uid();ref=uid();did=uid();encoded=dumps(raw)
            db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(aid,rid,'hgt-fixture.json','diagnosis_report',digest(encoded),encoded))
            db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(ref,rid,aid,dumps({'evidence_id':ref,'artifact_id':aid,'run_id':rid})))
            report={'diagnosis_id':did,'format':'agenttether-hgt','origin':'recomputed','raw_evidence_id':ref,
                    'input_snapshot_hash':sid,'input_evidence_id':snapshot['evidence_map'][call['span_id']]}
            db.execute('INSERT INTO diagnoses VALUES (?,?,?)',(did,rid,dumps(report)))
        yield client,manager,rid,config,records


def test_preview_redacts_and_requires_explicit_matching_submission(scenario):
    client,manager,rid,_,records=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview');assert preview.status_code==200,preview.text
    value=preview.json();assert value['model']=='gpt-5.6-luna' and value['prompt_bytes']<24000
    assert 'should-not-leak' not in preview.text and '[REDACTED]' in preview.text
    assert len(value['prompt']['selected_subtrajectory'])==1
    bad=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':'0'*64,'hgt_diagnosis_id':value['hgt_diagnosis_id']})
    assert bad.status_code==409
    spec={'request_id':uuid4().hex,'preview_sha256':value['preview_sha256'],'hgt_diagnosis_id':value['hgt_diagnosis_id']}
    response=client.post('/api/runs/'+rid+'/analyst-jobs',json=spec);assert response.status_code==200,response.text
    job=response.json();assert job['mode']=='analyst_rca' and job['state']=='queued'
    assert client.get('/api/evidence/'+job['prompt_evidence_id']).json()['sha256']==job['prompt_sha256']
    assert client.post('/api/runs/'+rid+'/analyst-jobs',json=spec).json()['job_id']==job['job_id']
    assert client.post('/api/runs/'+rid+'/analyst-jobs',json={**spec,'request_id':uuid4().hex}).status_code==409
    assert records[0]['event_id'] not in value['prompt']['selected_subtrajectory'][0]['action']


def test_report_references_and_outcome_unchanged(scenario):
    client,manager,rid,_,_=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview').json()
    original=client.get('/api/runs/'+rid).json()
    job=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':preview['preview_sha256'],'hgt_diagnosis_id':preview['hgt_diagnosis_id']}).json()
    with manager.store.connect() as db:
        item=payload(db.execute('SELECT * FROM diagnosis_jobs WHERE id=?',(job['job_id'],)).fetchone());item['state']='running';manager.save(db,item)
    result={'format':'agenttether-analyst','analysis_status':'complete','prompt_sha256':preview['prompt_sha256'],
            'turning_point_transition_id':'t1','summary':'Hypothesis: wrong implementation','failed_assumption':'Tests expected another behavior',
            'guidance':'Inspect calculation','verification_suggestion':'Rerun pytest','boundary':'Only synthetic case',
            'confidence':0.7,'evidence_chain':[{'claim':'t1','resolution_status':'resolved'},{'claim':'invented','resolution_status':'unresolved'}],
            'usage':{'prompt_tokens':10,'completion_tokens':10},'provenance':{'model_requested':'gpt-5.6-luna'}}
    manager.persist_analyst(job['job_id'],preview,result)
    reports=client.get('/api/runs/'+rid+'/diagnoses').json();assert len(reports)==2
    report=next(r for r in reports if r['format']=='agenttether-analyst')
    assert sum(x['resolution_status']=='resolved' for x in report['findings'][0]['evidence'])==2
    assert any(x['resolution_status']=='unresolved' for x in report['findings'][0]['evidence'])
    assert client.get('/api/evidence/'+report['findings'][0]['evidence'][0]['evidence_id']).status_code==200
    assert client.get('/api/runs/'+rid).json()['outcome_status']==original['outcome_status']
    assert client.get('/api/runs/'+rid+'/diagnosis-jobs').json()[0]['state']=='succeeded'


def test_cancelled_job_cannot_publish(scenario):
    client,manager,rid,_,_=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview').json()
    job=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':preview['preview_sha256'],'hgt_diagnosis_id':preview['hgt_diagnosis_id']}).json()
    assert client.post('/api/diagnosis-jobs/'+job['job_id']+'/cancel').json()['state']=='cancelled'
    manager.persist_analyst(job['job_id'],preview,{'format':'agenttether-analyst','analysis_status':'complete','prompt_sha256':preview['prompt_sha256'],'turning_point_transition_id':'t1'})
    assert len(client.get('/api/runs/'+rid+'/diagnoses').json())==1


def test_prompt_rejects_missing_evidence_and_limits_size():
    snapshot={'run_id':'r','evidence_map':{'e':'ref'}}
    hgt={'selected_units':[{'transition_id':'t','span_ids':['missing']} ]}
    with pytest.raises(ValueError,match='hgt_evidence_unresolved'):build_prompt(snapshot,hgt)
    hgt['selected_units'][0]['span_ids']=['e'];hgt['selected_units'][0]['action']='x'*100000
    prompt=build_prompt(snapshot,hgt)
    assert prompt['prompt_bytes']<24000 and 'truncated' in dumps(prompt['prompt'])
    redacted=clipped("{'password': 'top secret', 'api_key': 'samplekey', 'authorization': 'Bearer tokenvalue'}",900)
    assert 'top secret' not in redacted and 'samplekey' not in redacted and 'tokenvalue' not in redacted


def test_provider_failure_is_bounded_and_does_not_publish(scenario,monkeypatch):
    client,manager,rid,_,_=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview').json()
    class FailureProcess:
        returncode=1
        def __init__(self,args,env,**kwargs):
            assert args[1].endswith('analyst_worker.py')
            assert 'OPS_OPENAI_API_KEY' not in env
            assert 'dummy-key' not in dumps(args) and 'dummy-key' not in dumps(env)
            from pathlib import Path
            for name in ('config','input'):
                assert 'dummy-key' not in Path(args[args.index('--'+name)+1]).read_text(encoding='utf-8')
            Path(args[args.index('--output')+1]).write_text('{"error":"provider_http_401"}',encoding='utf-8')
        def poll(self):return 1
        def wait(self,timeout=None):return 1
        def communicate(self,input,timeout=None):
            assert b'dummy-key' in input
            return None,None
    monkeypatch.setattr('apps.api.diagnosis.subprocess.Popen',FailureProcess)
    monkeypatch.setattr(manager,'run',DiagnosisManager.run.__get__(manager))
    response=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,
        'preview_sha256':preview['preview_sha256'],'hgt_diagnosis_id':preview['hgt_diagnosis_id']})
    assert response.status_code==200,response.text
    for _ in range(100):
        job=client.get('/api/runs/'+rid+'/diagnosis-jobs').json()[0]
        if job['state'] not in ('queued','running'):break
        time.sleep(.01)
    assert job['state']=='failed' and job['error']=='provider_http_401'
    assert len(client.get('/api/runs/'+rid+'/diagnoses').json())==1
