import hashlib
import json

from .test_import import package, upload, client


def test_bom_and_crlf_preserve_original_file_hash(client):
    manifest,files=package()
    files['run-1.jsonl']='\ufeff'+files['run-1.jsonl'].replace('\n','\r\n')
    files['run-1.report.json']='\ufeff'+files['run-1.report.json']
    result=upload(client,manifest,files)
    assert result.status_code==200,result.text
    run=client.get('/api/runs/'+result.json()['run_ids'][0]).json()
    artifact=next(a for a in run['artifacts'] if a['kind']=='telemetry')
    assert artifact['sha256']==hashlib.sha256(files['run-1.jsonl'].encode('utf-8')).hexdigest()
    diagnosis=client.get('/api/runs/'+run['run_id']+'/diagnoses').json()[0]
    assert client.get('/api/evidence/'+diagnosis['raw_evidence_id']).status_code==200


def test_nonzero_exit_code_wins_over_tool_ok(client):
    manifest,files=package()
    rows=[json.loads(line) for line in files['run-1.jsonl'].splitlines()]
    bad=next(r for r in rows if r.get('correlation_id')=='shared-test' and r['kind']=='tool_return')
    bad['ok']=True
    files['run-1.jsonl']='\n'.join(json.dumps(r) for r in rows)
    result=upload(client,manifest,files).json()
    run=client.get('/api/runs/'+result['run_ids'][0]).json()
    assert 'tool_status_conflict' in run['warnings']
    assert run['failed_tool_count']==1


def test_unexpected_files_and_nonfinite_numbers_rejected(client):
    manifest,files=package()
    files['not-listed.json']='{}'
    assert upload(client,manifest,files).status_code==422
    del files['not-listed.json']
    files['run-1.jsonl']='{"kind":"event","duration_ms":NaN}'
    assert upload(client,manifest,files).status_code==422
    assert client.get('/api/tasks').json()==[]


def test_malformed_display_fields_rejected_atomically(client):
    manifest,files=package()
    rows=[json.loads(line) for line in files['run-1.jsonl'].splitlines()]
    rows[0]['duration_ms']={'invalid':'object'}
    files['run-1.jsonl']='\n'.join(json.dumps(r) for r in rows)
    assert upload(client,manifest,files).status_code==422
    manifest,files=package()
    report=json.loads(files['run-2.report.json'])
    report['hierarchical_trajectory_graph']['macro_nodes']=[None]
    files['run-2.report.json']=json.dumps(report)
    assert upload(client,manifest,files).status_code==422
    assert client.get('/api/tasks').json()==[]
