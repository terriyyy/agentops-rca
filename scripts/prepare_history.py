"""Build a private import package from one existing SWE-bench case directory."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path


def prepare(source:Path,destination:Path):
    source=source.resolve()
    destination=destination.resolve()
    if source==destination or source in destination.parents:
        raise ValueError('输出目录必须位于原始案例目录之外')
    state=source/'.agentops_state'
    histories=list(state.glob('*.outcome_history.json'))
    if len(histories)!=1:raise ValueError('案例目录必须包含唯一的 outcome_history.json')
    history=json.loads(histories[0].read_text(encoding='utf-8'))
    instance=history['instance_id']
    manifest={'schema_version':'0.1','source_namespace':'swe-bench/local-history','task_id':instance,'goal':f'完成 SWE-bench 代码任务 {instance}，以保存的独立测试验收结果对照各轮执行。','sample_kind':'historical','runs':[]}
    copies={}
    for directory in sorted((state/'iter_telemetry').glob('iter_*')):
        attempt=int(directory.name.split('_')[-1])
        traces=list(directory.glob('*.jsonl'))
        if len(traces)!=1:raise ValueError(f'{directory.name} 需要唯一原始 JSONL')
        name=f'iter-{attempt}.jsonl'
        copies[name]=traces[0]
        spec={'run_key':directory.name,'attempt_index':attempt,'telemetry':name,'outcome':'outcome.json','source_algorithm':'PROBE'}
        report=traces[0].with_suffix('.agentops_report.json')
        if report.exists():spec['report']=f'iter-{attempt}.report.json';copies[spec['report']]=report
        feedback=state/f'{instance}.iter_{attempt}.feedback.md'
        if feedback.exists() and feedback.stat().st_size:spec['feedback']=f'iter-{attempt}.feedback.md';copies[spec['feedback']]=feedback
        manifest['runs'].append(spec)
    if not manifest['runs']:raise ValueError('未找到轨迹')
    copies['outcome.json']=histories[0]
    destination.mkdir(parents=True,exist_ok=True)
    for name in [*copies,'manifest.json','provenance.local.json']:
        if (destination/name).exists():raise ValueError('输出文件已存在；请选择新的输出目录')
    provenance=[]
    for name,path in copies.items():
        shutil.copyfile(path,destination/name)
        provenance.append({'file':name,'sha256':hashlib.sha256((destination/name).read_bytes()).hexdigest(),'source':str(path)})
    (destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (destination/'provenance.local.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    args=parser.parse_args()
    result=prepare(args.source,args.out)
    print(f"Prepared {len(result['runs'])} runs. Upload manifest.json and referenced files only; keep provenance.local.json private.")
