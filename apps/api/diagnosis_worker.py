"""Trusted local AgentTether adapter. Offline HGT only; never calls an LLM."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import socket
import sys
import types
from pathlib import Path

ADAPTER='agenttether-hgt-0.3.1'


def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def source_hash(source):
    h=hashlib.sha256()
    for file in sorted((source/'agent_tether').rglob('*.py')):
        h.update(file.relative_to(source).as_posix().encode());h.update(file.read_bytes())
    return h.hexdigest()


def block_network():
    def denied(*args,**kwargs):raise RuntimeError('offline_worker_network_disabled')
    socket.socket.connect=denied
    socket.socket.connect_ex=denied
    socket.create_connection=denied


def load_model(config):
    source=Path(config['source']);bundle=Path(config['bundle'])
    if source_hash(source)!=config['source_sha256']:raise ValueError('source_hash_mismatch')
    if sha(bundle/'hgt_normal_model.pt')!=config['weight_sha256']:raise ValueError('weight_hash_mismatch')
    if sha(bundle/'manifest.json')!=config['manifest_sha256']:raise ValueError('manifest_hash_mismatch')
    # Load untouched leaf modules without package __init__ side effects. The upstream
    # recovery/ops initializers import observer/reporting and form a circular chain.
    for name in ('agent_tether','agent_tether.recovery','agent_tether.model'):
        module=types.ModuleType(name)
        module.__path__=[str(source.joinpath(*name.split('.')))]
        sys.modules[name]=module
    sys.path.insert(0,str(source))
    import torch
    torch.set_num_threads(2)
    from agent_tether.model.bundle import AgentTetherModelBundle
    model=AgentTetherModelBundle.load(bundle)
    return model,torch


def execute(config,snapshot):
    block_network()
    model,torch=load_model(config)
    versions={name:importlib.metadata.version(name) for name in ('torch','torch-geometric','numpy')}
    provenance={k:config[k] for k in ('source_sha256','weight_sha256','manifest_sha256')}
    provenance.update(adapter_version=ADAPTER,dependencies=versions,mode='offline_hgt',analyst='disabled',network='disabled')
    if snapshot is None:return {'status':'degraded','hgt':'ready','analyst':'disabled','provenance':provenance}
    from agent_tether.recovery.unitizer import build_transition_units
    from agent_tether.recovery.hierarchical_graph import build_hierarchical_trajectory_graph
    units=build_transition_units(snapshot['events'],case_id=snapshot['run_id'],setting='agentops',iteration=str(snapshot['attempt_index']))
    if not units:raise ValueError('no_transition_units')
    with torch.inference_mode(): diagnostics=model.score_graph(units)
    graph=build_hierarchical_trajectory_graph(units,run_meta={'task_id':snapshot['task_id']},task_context={})
    by_id={u.transition_id:u for u in units}
    findings=[]
    selected_ids=[]
    for item in diagnostics.get('selected_localizations',[]):
        ids=item.get('subtrajectory_transition_ids') or [item.get('transition_id')]
        selected=[by_id[tid] for tid in ids if tid in by_id]
        selected_ids.extend(u.transition_id for u in selected)
        findings.append({'title':'HGT 异常定位：'+', '.join(dict.fromkeys(u.tool for u in selected)),
                         'severity':'warn','description':json.dumps(item,ensure_ascii=False),
                         'event_ids':list(dict.fromkeys(span for u in selected for span in u.span_ids))})
    return {'format':'agenttether-hgt','model_status':'ready','model_reason':'真实权重已加载；仅离线 HGT 定位，analyst 未运行。',
            'summary':f'已对 {len(units)} 个工具转换执行 HGT 推理，生成 {len(findings)} 组异常定位。分数衡量模型偏离，不是根因概率；完整 RCA analyst 尚未运行。',
            'findings':findings,'graph':graph,'runtime_memory':None,'guidance':None,'provenance':provenance,
            'diagnostics':diagnostics,'transition_count':len(units),
            'selected_units':[
                {key:getattr(by_id[tid],key) for key in ('transition_id','span_ids','tool','status','action','feedback','error_signature')}
                for tid in dict.fromkeys(selected_ids) if tid in by_id
            ][:24]}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--input');parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        config=json.loads(Path(args.config).read_text(encoding='utf-8'))
        snapshot=json.loads(Path(args.input).read_text(encoding='utf-8')) if args.input else None
        result=execute(config,snapshot)
    except Exception as exc:
        # Detailed local stderr may include paths; API only exposes the stable type.
        import traceback
        traceback.print_exc()
        result={'error':type(exc).__name__,'reason':str(exc) if str(exc) in ('source_hash_mismatch','weight_hash_mismatch','manifest_hash_mismatch','no_transition_units') else 'worker_failed'}
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return 1 if 'error' in result else 0


if __name__=='__main__':sys.exit(main())
