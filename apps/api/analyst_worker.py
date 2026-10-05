"""Single-request AgentTether analyst worker. Credentials arrive only through stdin."""
import argparse
import hashlib
import json
import os
import sys
import types
from pathlib import Path

from diagnosis_worker import source_hash


def canonical(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def execute(config,material,credentials):
    source=Path(config['source'])
    if source_hash(source)!=config['source_sha256']:raise ValueError('source_hash_mismatch')
    encoded=canonical(material.get('request',material['prompt']))
    if hashlib.sha256(encoded.encode('utf-8')).hexdigest()!=material['prompt_sha256']:
        raise ValueError('prompt_mismatch')
    for name in ('agent_tether','agent_tether.recovery','agent_tether.enrichers'):
        module=types.ModuleType(name);module.__path__=[str(source.joinpath(*name.split('.')))];sys.modules[name]=module
    sys.path.insert(0,str(source))
    from agent_tether.recovery.llm_analyst import LLMRecoveryAnalyst
    from agent_tether.recovery.types import CriticalSubtrajectory,CriticalTransition,TransitionUnit
    import requests

    class BoundedAnalyst(LLMRecoveryAnalyst):
        def __init__(self):
            # Do not invoke upstream env_llm_cfg: explicit connection only, no .env fallback.
            self.api_key=credentials.get('api_key')
            self.model=material['model'];self.base_url=material['base_url']
            self.timeout_s=45;self.max_transitions=12;self.temperature=0
        def _payload(self,**kwargs):return material['prompt']
        def _chat(self,messages):
            from urllib.parse import urlsplit
            url=urlsplit(self.base_url)
            if url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('localhost','127.0.0.1','::1')):
                raise RuntimeError('provider_error')
            if url.username or url.password or url.query or url.fragment:raise RuntimeError('provider_error')
            parameter=material.get('token_parameter','max_tokens')
            if parameter not in ('max_tokens','max_completion_tokens'):raise RuntimeError('provider_error')
            body=material.get('request') or {'model':self.model,'messages':messages,parameter:2500}
            if body.get('model')!=self.model or body.get(parameter)!=2500:raise RuntimeError('provider_error')
            try:
                response=requests.post(self.base_url.rstrip('/')+'/chat/completions',
                                       headers={'Authorization':'Bearer '+self.api_key,'Content-Type':'application/json'},
                                       json=body,timeout=45,allow_redirects=False)
            except requests.Timeout as exc:raise RuntimeError('provider_timeout') from exc
            except requests.RequestException as exc:raise RuntimeError('provider_error') from exc
            if response.status_code!=200:
                code=response.status_code
                raise RuntimeError('provider_http_'+str(code) if code in (401,403,429) else 'provider_error')
            try:
                value=response.json();self.usage=value.get('usage') or None;self.returned_model=value.get('model') or self.model
                content=value['choices'][0]['message']['content']
                if not isinstance(content,str) or len(content)>24000:raise ValueError()
                return content
            except (ValueError,KeyError,IndexError,TypeError) as exc:raise RuntimeError('invalid_model_output') from exc

    analyst=BoundedAnalyst()
    if not analyst.available:raise ValueError('analyst_unconfigured')
    candidates=material['prompt']['selected_subtrajectory']
    units=[TransitionUnit(transition_id=c['transition_id'],index=i+1,span_ids=c['event_ids'],tool=c['tool'],status=c['status'],
                          action=c['action'],feedback=c['feedback'],error_signature=c['error_signature']) for i,c in enumerate(candidates)]
    ranked=[CriticalTransition(transition=u,score=0.0) for u in units]
    plan,meta=analyst.analyze_to_plan(subtrajectory=CriticalSubtrajectory(transitions=units,critical=ranked[0]),
                                      critical_transitions=ranked,diagnostic_signals=[],rca_result={})
    if plan is None:
        cause=str(meta.get('error',''))
        for code in ('provider_http_401','provider_http_403','provider_http_429','provider_timeout','provider_error'):
            if code in cause:raise ValueError(code)
        raise ValueError('invalid_model_output' if 'JSON' in cause else 'incomplete_plan')
    parsed=meta.get('result') or {}
    tid=parsed.get('turning_point_transition_id')
    if tid not in material['candidate_ids']:raise ValueError('invalid_turning_point')
    summary=str(parsed.get('rca_summary') or '').strip()
    if not summary:raise ValueError('incomplete_plan')
    chain=parsed.get('evidence_chain') or []
    if not isinstance(chain,list):raise ValueError('invalid_model_output')
    chain=[str(x)[:500] for x in chain[:8]]
    references=set(material['evidence_map'])|set(material['candidate_ids'])
    chain_status=[{'claim':item,'resolution_status':'resolved' if item in references else 'unresolved'} for item in chain]
    return {'format':'agenttether-analyst','analysis_status':'complete','model_status':'ready',
            'summary':summary[:4000],'failed_assumption':str(parsed.get('failed_assumption') or '')[:1000],
            'turning_point_transition_id':tid,'guidance':plan.operation,'verification_suggestion':plan.verification,
            'boundary':plan.boundary,'confidence':plan.confidence,'evidence_chain':chain_status,
            'prompt_sha256':material['prompt_sha256'],'usage':analyst.usage,
            'provenance':{'source_sha256':config['source_sha256'],'weight_sha256':config['weight_sha256'],
                          'manifest_sha256':config['manifest_sha256'],'hgt_sha256':material['hgt_sha256'],
                          'model_requested':material['model'],'model_returned':analyst.returned_model,
                          'provider':material['provider'],'base_url':material['base_url'],
                          'config_revision':material['config_revision'],'protocol':'openai_chat_completions',
                          'adapter_version':'agenttether-analyst-0.4.0'}}


def main():
    parser=argparse.ArgumentParser()
    for key in ('config','input','output'):parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    try:
        config=json.loads(Path(args.config).read_text(encoding='utf-8'))
        material=json.loads(Path(args.input).read_text(encoding='utf-8'))
        credentials=json.loads(sys.stdin.buffer.read(16384).decode('utf-8'))
        result=execute(config,material,credentials)
    except Exception as exc:
        # No traceback or HTTP body: both may contain credentials or private telemetry.
        allowed={'source_hash_mismatch','prompt_mismatch','analyst_unconfigured','invalid_model_output',
                 'invalid_turning_point','incomplete_plan','provider_http_401','provider_http_403','provider_http_429',
                 'provider_timeout','provider_error'}
        result={'error':str(exc) if str(exc) in allowed else 'provider_error'}
    Path(args.output).write_text(canonical(result),encoding='utf-8')
    return 1 if 'error' in result else 0


if __name__=='__main__':sys.exit(main())
