"""Generate authored synthetic fixtures. These are NOT AgentTether experiment results."""
import json
from pathlib import Path

DEST=Path(__file__).resolve().parents[1]/'tests/fixtures/demo'


def write(name,value,jsonl=False):
    DEST.mkdir(parents=True,exist_ok=True)
    text='\n'.join(json.dumps(r,ensure_ascii=False) for r in value) if jsonl else json.dumps(value,ensure_ascii=False,indent=2)
    (DEST/name).write_text(text+'\n',encoding='utf-8')


def main():
    manifest={'schema_version':'0.1','source_namespace':'demo/synthetic','task_id':'matrix-write-regression','goal':'修复矩阵写入逻辑，并通过独立回归测试。此任务为人工编写的合成演示，不代表真实算法结果。','sample_kind':'synthetic','runs':[]}
    for attempt in (1,2):
        events=[]
        def event(kind,name,**kw):
            i=len(events)
            row={'span_id':f'r{attempt}-s{i}','ts':f'2026-09-18T08:{attempt:02d}:{i:02d}+00:00','attempt':0,'kind':kind,'name':name,'seq':i,'step_idx':i,'input':{},'output_text':None,'ok':True,**kw}
            events.append(row)
        event('event','RUN_START',input={'task_id':'matrix-write-regression'})
        event('event','TASK_CONTEXT',input={'goal':manifest['goal']})
        event('llm','LLM_RESPONSE',output_text='先定位写入分支，再检查对应回归测试。')
        event('tool_call','read_file',correlation_id='shared-read',input={'path':'src/matrix.py'})
        event('tool_return','read_file',correlation_id='shared-read',output_text='def set_value(row, col, value): ...',duration_ms=12)
        event('tool_call','bash',correlation_id='shared-edit',input={'command':'python apply_fix.py'})
        event('tool_return','bash',correlation_id='shared-edit',output_text=json.dumps({'returncode':0,'stdout':'Updated matrix.py'}),duration_ms=36)
        if attempt==2:event('event','PROBE_INTERVENTION',input={'guidance':'演示：提交前运行完整的矩阵回归测试。'})
        event('tool_call','bash',correlation_id='shared-test',input={'command':'python -m pytest tests/test_matrix.py'})
        event('tool_return','bash',correlation_id='shared-test',ok=attempt==2,error_signature='assertion_failed' if attempt==1 else None,output_text=json.dumps({'returncode':1 if attempt==1 else 0,'stdout':'1 failed: test_sparse_write' if attempt==1 else '12 passed'}),duration_ms=428)
        event('event','RUN_END',input={'status':'Submitted'})
        write(f'run-{attempt}.jsonl',events,True)
        finding={'type':'verification_gap','severity':'warn' if attempt==1 else 'info','title':'提交前的回归测试未通过' if attempt==1 else '历史验收记录已通过','description':'合成演示：结果以独立验收文件为准。','evidence':[{'correlation_id':'shared-test','name':'bash'}]}
        if attempt==1:finding['evidence'].append({'span_id':'not-recorded'})
        report={'run_meta':{'final_status':'Submitted','ok':False},'findings':[finding], 'rca':{'result':{'primary_cause':'演示诊断：修复未覆盖稀疏矩阵写入分支。' if attempt==1 else '演示诊断：新增分支检查，回归测试通过。'}}}
        if attempt==2:
            report.update(hierarchical_trajectory_graph={'macro_nodes':[{'id':'context','label':'理解任务'},{'id':'edit','label':'修复代码'},{'id':'verify','label':'回归验收'}],'micro_nodes':[],'edges':[{'source':'context','target':'edit','relation':'temporal_next'},{'source':'edit','target':'verify','relation':'temporal_next'}]},runtime_memory={'required_actions':['提交前执行回归测试']},pipeline={'offline_model_bundle':{'ok':False,'reason':'合成演示不加载模型'}},next_iteration_feedback={'text':'保留测试结果作为验收证据。'})
        write(f'run-{attempt}.report.json',report)
        write(f'run-{attempt}.outcome.json',{'source':'synthetic_test_harness','resolved':attempt==2,'summary':'1 failed' if attempt==1 else '12 passed','basis':'test_suite'})
        spec={'run_key':f'iter-{attempt}','attempt_index':attempt,'telemetry':f'run-{attempt}.jsonl','report':f'run-{attempt}.report.json','outcome':f'run-{attempt}.outcome.json','source_algorithm':'synthetic_fixture'}
        if attempt==2:
            (DEST/'feedback.md').write_text('合成演示反馈：检查稀疏分支，运行回归测试后再提交。\n',encoding='utf-8')
            spec['feedback']='feedback.md'
        manifest['runs'].append(spec)
    write('manifest.json',manifest)


if __name__=='__main__':main()
