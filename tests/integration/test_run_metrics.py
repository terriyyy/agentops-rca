from fastapi.testclient import TestClient

from apps.api.main import create_app
from apps.api.run_metrics import normalize_usage, run_metrics


def event(position, kind='llm', name='LLM_RESPONSE', cid=None, **fields):
    return {'event_id': f'e{position}', 'position': position, 'kind': kind, 'name': name,
            'correlation_id': cid, 'producer_id': 'p1', 'evidence_id': f'ref{position}', **fields}


def metrics(events, status='completed'):
    return run_metrics({'run_id': 'r', 'execution_status': status}, events)


def test_usage_envelopes_and_unknown_are_distinct_from_zero():
    assert normalize_usage({'usage_metadata': {'input_tokens': 0, 'output_tokens': 0}})['total_tokens'] == 0
    value = normalize_usage({'usage': {'prompt_tokens': 3, 'completion_tokens': 2, 'total_tokens': 6,
                                       'cached_tokens': 1, 'reasoning_tokens': 1}})
    assert value['total_tokens'] == 6
    assert value['warnings'] == ['total_differs_from_parts']
    assert normalize_usage({'usage': {'total_tokens': '[REDACTED]'},
                            'usage_metadata': {'input_tokens': 7}})['total_tokens'] is None
    assert normalize_usage({'usage': {'total_tokens': True, 'prompt_tokens': -1, 'completion_tokens': '3'}}) is None
    assert normalize_usage({'content': {'usage': {'total_tokens': 10000}}}) is None
    assert normalize_usage({'response_metadata': {'token_usage': {'prompt_tokens': 2, 'completion_tokens': 1}}})['total_tokens'] == 3


def test_seven_invocations_are_not_fourteen_and_provider_total_is_exact():
    events=[]
    inputs=[2474,3353,3709,4542,6555,8718,11062]
    outputs=[92,118,150,113,98,299,165]
    for index,(incoming,outgoing) in enumerate(zip(inputs,outputs)):
        events.extend([event(index*2,name='LLM_REQUEST',cid=f'c{index}',input={'model':'test'}),
                       event(index*2+1,cid=f'c{index}',output={'usage_metadata':{'input_tokens':incoming,'output_tokens':outgoing,'total_tokens':incoming+outgoing}})])
    result=metrics(events)
    assert result['llm']['observed'] == result['llm']['completed'] == 7
    assert result['tokens']['total'] == {'value':41448,'responses':7}
    assert result['tokens']['input']['value'] == 40413
    assert result['tokens']['output']['value'] == 1035
    assert result['llm']['calls'][0]['evidence_id'] == 'ref1'


def test_partial_pending_ambiguous_and_producers_are_not_guessed():
    events=[event(0,name='LLM_REQUEST',cid='pending'),event(1,cid='a',output={'usage':{'total_tokens':5}}),
            event(2,cid='b',output={}),event(3,name='LLM_REQUEST',cid='duplicate'),
            event(4,name='LLM_REQUEST',cid='duplicate'),event(5,cid='duplicate',output={'usage':{'total_tokens':999}}),
            event(6,name='LLM_REQUEST',cid='foreign'),event(7,cid='foreign',producer_id='p2',output={})]
    result=metrics(events,'running')
    assert result['in_progress']
    assert result['llm']['ambiguous_events'] == 3
    assert result['llm']['pending'] == 2
    assert result['tokens']['total'] == {'value':5,'responses':1}
    assert result['tokens']['responses'] == 3
    assert result['tokens']['with_usage'] == 1
    assert metrics([event(0,output={})])['tokens']['total']['value'] is None


def test_tools_time_and_missing_fields_preserve_source_facts():
    result=metrics([event(0,kind='tool_call',name='bash',cid='tool',occurred_at='2026-10-04T00:00:00Z'),
                    event(1,kind='tool_return',name='bash',cid='tool',tool_status='failed',occurred_at='2026-10-04T00:00:02Z'),
                    event(2,kind='log',name='stderr',occurred_at='2026-10-04T00:00:30')])
    assert result['time'] == {'recorded_ms':2000,'timed_events':2}
    assert result['tools'] == {'observed':1,'paired':1,'failed':1,'unpaired_calls':0}
    assert metrics([event(0,kind='tool_return',cid='no-call')])['tools']['observed'] == 0


def test_unlinked_and_reversed_requests_are_not_double_counted():
    result=metrics([event(0,name='LLM_REQUEST'),event(1,output={'usage':{'total_tokens':10}}),
                    event(2,cid='reversed',output={'usage':{'total_tokens':999}}),
                    event(3,name='LLM_REQUEST',cid='reversed')])
    assert result['llm']['observed'] == 1
    assert result['llm']['response_only'] == 1
    assert result['llm']['unclassified_events'] == 1
    assert result['llm']['ambiguous_events'] == 2
    assert result['tokens']['total']['value'] == 10


def test_metrics_endpoint_does_not_read_diagnosis_usage_or_change_records(tmp_path):
    with TestClient(create_app(tmp_path/'metrics.sqlite3')) as client:
        imported=client.post('/api/examples/import').json()
        run_id=imported['run_ids'][0]
        original=client.get(f'/api/runs/{run_id}').json()
        response=client.get(f'/api/runs/{run_id}/metrics')
        assert response.status_code == 200
        assert response.json()['tokens']['total']['value'] is None
        assert client.get(f'/api/runs/{run_id}').json() == original
        assert client.get('/api/runs/missing/metrics').status_code == 404
