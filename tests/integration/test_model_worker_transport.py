"""Exercise the real adapter transport with a minimal upstream protocol fixture."""
import importlib.util
import json
from pathlib import Path
import sys
import types

import pytest


@pytest.fixture
def worker(monkeypatch,tmp_path):
    directory=Path(__file__).resolve().parents[2]/'apps/api'
    monkeypatch.syspath_prepend(str(directory))
    spec=importlib.util.spec_from_file_location('model_worker_fixture',directory/'analyst_worker.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    monkeypatch.setattr(module,'source_hash',lambda source:'fixture-source')
    upstream=types.ModuleType('agent_tether.recovery.llm_analyst')
    class Analyst:
        def __init__(self,**kwargs):raise AssertionError('Environment fallback forbidden')
        @property
        def available(self):return bool(self.api_key and self.model and self.base_url)
        def analyze_to_plan(self,**kwargs):
            try:value=json.loads(self._chat([{'role':'system','content':'fixture instructions'},{'role':'user','content':json.dumps(self._payload())}]))
            except RuntimeError as exc:return None,{'error':str(exc)}
            except ValueError:return None,{'error':'JSON parse error'}
            return types.SimpleNamespace(operation='Inspect fixture',verification='Check fixture',boundary='Fixture only',confidence=.5),{'result':value}
    upstream.LLMRecoveryAnalyst=Analyst
    monkeypatch.setitem(sys.modules,upstream.__name__,upstream)
    protocol=types.ModuleType('agent_tether.recovery.types')
    for key in ('CriticalSubtrajectory','CriticalTransition','TransitionUnit'):setattr(protocol,key,lambda **kwargs:types.SimpleNamespace(**kwargs))
    monkeypatch.setitem(sys.modules,protocol.__name__,protocol)
    requests=types.ModuleType('requests')
    requests.Timeout=type('Timeout',(Exception,),{})
    requests.RequestException=type('RequestException',(Exception,),{})
    monkeypatch.setitem(sys.modules,'requests',requests)
    prompt={'selected_subtrajectory':[{'transition_id':'t1','event_ids':['e1'],'tool':'shell','status':'failure','action':'test','feedback':'failed','error_signature':'assertion'}]}
    material={'model':'user-model','base_url':'https://custom.example/v1','provider':'user-connection','config_revision':'revision',
              'prompt':prompt,'prompt_sha256':module.hashlib.sha256(module.canonical(prompt).encode()).hexdigest(),
              'hgt_sha256':'fixture-hgt','candidate_ids':['t1'],'evidence_map':{'e1':'ref'},'token_parameter':'max_completion_tokens'}
    config={'source':str(tmp_path),'source_sha256':'fixture-source','weight_sha256':'fixture-weight','manifest_sha256':'fixture-manifest'}
    yield module,requests,material,config


@pytest.mark.parametrize('status,content,expected',[(200,{'turning_point_transition_id':'t1','rca_summary':'A fixture hypothesis','evidence_chain':['e1']},'complete'),
    (401,{},'provider_http_401'),(403,{},'provider_http_403'),(429,{},'provider_http_429'),(307,{},'provider_error'),
    (200,'invalid JSON','invalid_model_output'),(200,{'turning_point_transition_id':'invented','rca_summary':'fixture'},'invalid_turning_point')])
def test_custom_endpoint_exact_model_parameter_no_redirect_or_retry(worker,status,content,expected):
    module,requests,material,config=worker;calls=[]
    class Response:
        status_code=status
        def json(self):return {'model':'provider-model','usage':{'total_tokens':8},'choices':[{'message':{'content':content if isinstance(content,str) else json.dumps(content)}}]}
    def post(url,**kwargs):calls.append((url,kwargs));return Response()
    requests.post=post
    try:value=module.execute(config,material,{'api_key':'fixture-secret-key'});result=value['analysis_status']
    except ValueError as exc:result=str(exc)
    assert result==expected
    assert len(calls)==1
    url,options=calls[0]
    assert url=='https://custom.example/v1/chat/completions'
    assert options['allow_redirects'] is False and options['timeout']==45
    assert options['headers']['Authorization']=='Bearer fixture-secret-key'
    assert options['json']['model']=='user-model' and options['json']['max_completion_tokens']==2500
    assert 'max_tokens' not in options['json']
    if expected=='complete':
        assert value['provenance']['provider']=='user-connection' and value['provenance']['config_revision']=='revision'
        assert 'fixture-secret-key' not in json.dumps(value)


def test_timeout_does_not_retry(worker):
    module,requests,material,config=worker;calls=[]
    def post(*args,**kwargs):calls.append(1);raise requests.Timeout()
    requests.post=post
    with pytest.raises(ValueError,match='provider_timeout'):module.execute(config,material,{'api_key':'fixture-secret-key'})
    assert calls==[1]


def test_transport_sends_exact_reviewed_request_and_rejects_tampering(worker):
    module,requests,material,config=worker;calls=[]
    reviewed={'model':'user-model','messages':[{'role':'system','content':'Reviewed instruction'},
              {'role':'user','content':'Reviewed evidence'}],'max_completion_tokens':2500}
    material['request']=reviewed
    material['prompt_sha256']=module.hashlib.sha256(module.canonical(reviewed).encode()).hexdigest()
    class Response:
        status_code=200
        def json(self):return {'choices':[{'message':{'content':json.dumps({'turning_point_transition_id':'t1','rca_summary':'Fixture hypothesis'})}}]}
    def post(url,**kwargs):calls.append(kwargs['json']);return Response()
    requests.post=post
    assert module.execute(config,material,{'api_key':'fixture-secret-key'})['analysis_status']=='complete'
    assert calls==[reviewed]
    material['request']={**reviewed,'messages':[{'role':'user','content':'Not reviewed'}]}
    with pytest.raises(ValueError,match='prompt_mismatch'):module.execute(config,material,{'api_key':'fixture-secret-key'})
    assert len(calls)==1
