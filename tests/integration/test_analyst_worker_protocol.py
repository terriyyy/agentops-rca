"""Optional local test of the untouched upstream analyst with a fake HTTP transport."""
import json
from pathlib import Path
import subprocess

import pytest


ROOT=Path(__file__).resolve().parents[2]
PYTHON=ROOT/'.local/diagnosis-venv/Scripts/python.exe'
CONFIG=ROOT/'.local/diagnosis-config.json'


@pytest.mark.skipif(not PYTHON.is_file() or not CONFIG.is_file(),reason='Local AgentTether environment is not configured')
def test_upstream_analyst_success_errors_and_no_retry(tmp_path):
    if not Path(json.loads(CONFIG.read_text(encoding='utf-8'))['source']).is_dir():
        pytest.skip('Local upstream source directory is unavailable; standalone mock transport tests cover the adapter')
    dummy=tmp_path/'dummy.env'
    dummy.write_text('OPS_OPENAI_API_BASE_URL=https://api.chatanywhere.tech/v1\nOPS_OPENAI_API_KEY=dummy-key\nOPS_OPENAI_MODEL=gpt-5.6-luna\n',encoding='utf-8')
    script=r'''
import hashlib,json,os,sys
from pathlib import Path
root=Path(sys.argv[1]);os.environ['AGENT_SRE_ENV_FILE']=sys.argv[2]
sys.path.insert(0,str(root/'apps/api'))
import requests
from analyst_worker import execute,canonical
config=json.loads((root/'.local/diagnosis-config.json').read_text(encoding='utf-8'))
prompt={'task':'diagnose_recovery_turning_point_from_graph_evidence','selected_subtrajectory':[{'transition_id':'t1','event_ids':['e1'],'tool':'shell','status':'failure','action':'pytest','feedback':'AssertionError','error_signature':'assertion'}]}
material={'prompt':prompt,'prompt_sha256':hashlib.sha256(canonical(prompt).encode()).hexdigest(),'candidate_ids':['t1'],'evidence_map':{'e1':'ref'},'hgt_sha256':'f'*64,'model':'gpt-5.6-luna','base_url':'https://fixture.example/v1','provider':'fixture','config_revision':'fixture-revision'}
def content(tid):return json.dumps({'turning_point_transition_id':tid,'rca_summary':'A test failed','failed_assumption':'It would pass','evidence_chain':['e1'],'recovery_plan':{'target':'t1','operation':'Inspect code','verification':'Run pytest','boundary':'Fixture'},'confidence':0.5})
results=[]
for mode in ('valid','bad_json','403','429','wrong_id'):
    calls=[]
    class Response:
        status_code=int(mode) if mode in ('403','429') else 200
        def json(self):return {'model':'fixture','usage':{'prompt_tokens':5,'completion_tokens':5},'choices':[{'message':{'content':'not-json' if mode=='bad_json' else content('other' if mode=='wrong_id' else 't1')}}]}
    def fake_post(*args,**kwargs):calls.append(kwargs);return Response()
    requests.post=fake_post
    try:status=execute(config,material,{'api_key':'dummy-key'})['analysis_status']
    except Exception as exc:status=str(exc)
    assert len(calls)==1 and calls[0]['allow_redirects'] is False
    results.append(status)
print(json.dumps(results))
'''
    completed=subprocess.run([str(PYTHON),'-c',script,str(ROOT),str(dummy)],capture_output=True,text=True,timeout=30)
    assert completed.returncode==0,completed.stderr[-500:]
    assert json.loads(completed.stdout.strip().splitlines()[-1])==[
        'complete','invalid_model_output','provider_http_403','provider_http_429','invalid_turning_point']
