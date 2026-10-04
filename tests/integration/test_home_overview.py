"""Home counts, bounded usage, and feedback must describe the selected facts."""
from uuid import uuid4

from fastapi.testclient import TestClient

from apps.api.main import create_app


def create(client, kind='live'):
    token=uuid4().hex+uuid4().hex
    response=client.post('/api/live/runs',json={'request_id':uuid4().hex,'write_token':token,'goal':'Home fixture','sample_kind':kind})
    assert response.status_code == 200
    return response.json()['run_id'], {'Authorization':'Bearer '+token}


def observe(client,run_id,headers):
    def event(seq,kind,name,**fields):
        return {'event_id':uuid4().hex,'producer_id':'home','producer_seq':seq,
                'occurred_at':f'2026-10-04T00:00:0{seq}Z','kind':kind,'name':name,**fields}
    events=[event(1,'llm','LLM_REQUEST',correlation_id='model',input={'model':'fixture'}),
            event(2,'llm','LLM_RESPONSE',correlation_id='model',output={'usage_metadata':{'input_tokens':8,'output_tokens':2,'total_tokens':10}}),
            event(3,'tool_call','test',correlation_id='tool'),
            event(4,'tool_return','test',correlation_id='tool',ok=False,output={'returncode':1}),
            event(5,'verification','OUTCOME_EVIDENCE',input={'status':'failed','source':'fixture-rule','basis':'expected result'})]
    assert client.post(f'/api/live/runs/{run_id}/events',headers=headers,json={'events':events}).status_code == 200
    assert client.post(f'/api/live/runs/{run_id}/finish',headers=headers,json={'exit_code':0,'producers':{'home':5}}).status_code == 200


def test_scope_counts_are_not_bucket_lengths_and_demo_is_excluded(tmp_path):
    with TestClient(create_app(tmp_path/'home.sqlite3')) as client:
        for _ in range(3):
            create(client)
        create(client,'synthetic')
        client.post('/api/examples/import')
        value=client.get('/api/overview?limit=1&source=live&include_summary=true').json()
        assert len(value['running']) == 1
        assert value['summary']['running'] == value['summary']['total_runs'] == 3
        assert value['summary']['all_runs'] == 6
        assert value['summary']['sample']['count'] == 1
        assert value['summary']['tokens']['value'] is None
        assert all(run['sample_kind']=='live' for run in value['running'])
        synthetic=client.get('/api/overview?source=synthetic&include_summary=true').json()
        assert synthetic['summary']['total_runs'] == 3
        assert synthetic['summary']['running'] == 1
        imported=client.get('/api/overview?source=imported&include_summary=true').json()
        assert imported['summary']['total_runs'] == 0
        assert imported['summary']['feedback'] is None
        assert client.get('/api/overview?source=invalid').status_code == 422


def test_feedback_usage_and_checks_remain_independent_and_read_only(tmp_path):
    with TestClient(create_app(tmp_path/'feedback.sqlite3')) as client:
        create(client)
        run_id,headers=create(client)
        observe(client,run_id,headers)
        original=client.get(f'/api/runs/{run_id}').json()
        value=client.get('/api/overview?limit=1&source=live&include_summary=true').json()
        summary=value['summary'];feedback=summary['feedback']
        assert summary['running'] == 1 and summary['attention'] == 1
        assert summary['tokens'] == {'value':10,'responses':1,'with_total':1,'uncertain_events':0}
        assert summary['sample']['count'] == 1
        assert feedback['events'] == 5
        assert feedback['tools'] == {'observed':1,'paired':1,'failed':1,'unpaired_calls':0}
        assert feedback['model_responses'] == feedback['with_total'] == feedback['outcomes'] == 1
        assert feedback['run']['execution_status'] == 'completed'
        assert feedback['run']['outcome_status'] == 'failed'
        assert feedback['run']['insight']['diagnosis']['state'] == 'none'
        assert client.get(f'/api/runs/{run_id}').json() == original
        assert client.get('/api/overview?limit=1').json().keys() == {'running','attention','recent'}


def test_empty_feedback_does_not_claim_an_agent_is_connected(tmp_path):
    with TestClient(create_app(tmp_path/'empty.sqlite3')) as client:
        summary=client.get('/api/overview?source=live&include_summary=true').json()['summary']
        assert summary['all_runs'] == 0 and summary['feedback'] is None
        assert summary['tokens']['value'] is None
        run_id,_=create(client)
        feedback=client.get('/api/overview?source=live&include_summary=true').json()['summary']['feedback']
        assert feedback['run']['run_id'] == run_id
        assert feedback['events'] == feedback['tools']['observed'] == feedback['model_responses'] == feedback['outcomes'] == 0
