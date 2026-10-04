import {useMemo,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {ArrowUpRight,Activity,AlertCircle,Check,Minus} from 'lucide-react';
import {attentionNames,diagnosisNames,executionNames,outcomeNames,type HomeSample,type Run} from './api';
import {durationLabel} from './trace-model';
import {usageNumber} from './run-usage';
import './home-run-list.css';

function State({label,value,tone='unknown'}:{label:string;value:string;tone?:string}) {
  return <span className={'home-run-status '+tone}><span className="home-sr-only">{label}：</span>{tone==='failed'?<AlertCircle size={13}/>:tone==='running'?<Activity size={13}/>:tone==='passed'?<Check size={13}/>:tone==='unknown'?<Minus size={13}/>:<i/>}<span>{value}</span></span>;
}
function Row({run,sample,renderSource}:{run:Run;sample?:HomeSample;renderSource:(run:Run)=>ReactNode}) {
  const goal=run.task_goal||run.task_external_id||run.external_run_id;
  const diagnosis=run.insight?.diagnosis,state=diagnosis?.state||'none';
  const names:Record<string,string>={none:'尚未分析',running:'分析进行中',hypothesis:'待验证假设',localization:'已有定位线索',historical:'附带历史报告',failed:'分析作业失败'};
  const failedJob=diagnosis?.latest_job&&['failed','timed_out','interrupted'].includes(diagnosis.latest_job.state);
  const reasons=(run.insight?.attention_reasons||[]).map(reason=>attentionNames[reason]||reason);
  const date=new Date(run.created_at),dateText=Number.isNaN(date.getTime())?'入库时间未知':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const time=sample?.time;
  return <Link className="workbench-run home-run-row" to={'/runs/'+run.run_id}>
    <div className="home-run-identity"><strong title={goal}>{goal}</strong><div className="home-run-meta"><span>第 {run.attempt_index} 次</span>{renderSource(run)}</div><small title={run.created_at}>入库 {dateText}{run.execution_status==='running'&&run.origin==='live'&&<span className={run.capture_status==='disconnected'?'capture-lost':''}> · {run.capture_status==='connected'?'采集在线':run.capture_status==='disconnected'?'采集失联 · 执行待确认':'等待采集连接'}</span>}</small></div>
    <div className="home-run-cell"><State label="执行" value={executionNames[run.execution_status]||'执行状态未知'} tone={run.execution_status==='running'?'running':run.execution_status==='failed'?'failed':run.execution_status==='completed'?'completed':'unknown'}/></div>
    <div className="home-run-cell"><State label="验收" value={outcomeNames[run.outcome_status]||'验收未知'} tone={run.outcome_status==='passed'?'passed':run.outcome_status==='failed'?'failed':'unknown'}/></div>
    <div className="home-run-cell home-run-diagnosis" title={diagnosisNames[state]||'诊断状态未知'}><State label="诊断" value={names[state]||'诊断状态未知'} tone={state==='running'?'running':state==='failed'?'failed':['hypothesis','localization'].includes(state)?'analysis':'unknown'}/>{failedJob&&!!diagnosis?.report_count&&<small className="home-job-failed">最近作业失败</small>}{reasons.includes('采集不完整')&&<small className="home-capture-warning">采集不完整</small>}</div>
    <div className="home-run-number" title={time?`源事件时间范围；${time.timed_events}/${run.event_count} 条事件有可靠时间，不代表完整进程耗时`:'所选来源最近 20 次入库样本内的源事件时间范围'}><span className="home-sr-only">已记录时长：</span><strong>{time?.recorded_ms!=null?durationLabel(time.recorded_ms):'—'}</strong><small>{!sample?'不在样本内':time?.recorded_ms==null?'未记录':run.execution_status==='running'?'已观察时长':'源事件范围'}</small></div>
    <div className="home-run-number" title="仅汇总已记录的 Agent 响应总用量；不含 RCA 调用"><span className="home-sr-only">Agent Token：</span><strong>{usageNumber(sample?.tokens)}</strong><small>{!sample?'不在样本内':sample.tokens==null?'未记录':`${sample.with_total}/${sample.responses} 响应`}</small></div>
    <ArrowUpRight className="home-run-open" size={16}/>
  </Link>;
}
export function HomeRunSection({title,description,runs,empty,id,count,samples,renderSource}:{title:string;description:string;runs:Run[];empty:string;id?:string;count?:number;samples?:HomeSample[];renderSource:(run:Run)=>ReactNode}) {
  const byId=useMemo(()=>new Map((samples||[]).map(sample=>[sample.run_id,sample])),[samples]);
  return <section className={'panel workbench-section home-run-section'+(!runs.length?' is-empty':'')}>
    <div className="section-heading"><div><h2 id={id} tabIndex={-1}>{title}<span className="counter">{count??runs.length}</span></h2><p>{description}{count!==undefined&&count>runs.length&&` 当前显示最近 ${runs.length} 条。`}</p></div></div>
    {runs.length?<><div className="home-run-columns" aria-hidden="true"><span>运行 / 来源</span><span>执行</span><span>任务检查</span><span>原因分析</span><span>已记录时长</span><span>Agent Token</span><span/></div><div className="home-run-items">{runs.map(run=><Row key={run.run_id} run={run} sample={byId.get(run.run_id)} renderSource={renderSource}/>)}</div></>:<div className="home-run-empty"><span className="home-empty-mark"><Check size={14}/></span><span>{empty}</span></div>}
  </section>;
}
