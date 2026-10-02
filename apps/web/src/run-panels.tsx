import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,FileText,Loader2,X} from 'lucide-react';
import {api,pretty,type Diagnosis,type Outcome,type Ref,type Run,type TraceEvent} from './api';
import {isFailure,objectValue} from './trace-model';
import {DiagnosisControls} from './diagnosis';
import type {RunAnalysis} from './run-analysis';

const checkNames:Record<string,string>={passed:'通过',failed:'未通过',unknown:'未知'};
export const reportKind=(report:Diagnosis)=>report.mode==='analyst_rca'?'可能原因 · 待验证':report.origin==='recomputed'?'定位线索 · 尚非完整原因分析':'历史分析 · 来源提供';

function evidenceLabel(ref:Ref,events:TraceEvent[]) {
  const event=ref.resolution_status==='resolved'?events.find(event=>event.event_id===ref.event_id||event.evidence_id===ref.evidence_id):undefined;
  if(!event)return `${ref.label||'来源引用'}${ref.resolution_status==='resolved'?'':' · '+(ref.resolution_status==='ambiguous'?'存在多个候选':'引用待解析')}`;
  const phase=event.kind==='tool_call'?'调用参数':event.kind==='tool_return'?'返回'+(isFailure(event)?' · 失败':''):event.kind==='verification'?'检查记录':'事件';
  return `#${String(event.position+1).padStart(2,'0')} ${event.name} · ${phase}`;
}

export function AnalysisPanel({run,analysis,events,onEvidence,onFullReport}:{run:Run;analysis:RunAnalysis;events:TraceEvent[];onEvidence:(id:string)=>void;onFullReport:()=>void}) {
  const report=analysis.selected;
  const [expanded,setExpanded]=useState(false),[allEvidence,setAllEvidence]=useState(false);
  const [canExpand,setCanExpand]=useState(false),statement=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{setExpanded(false);setAllEvidence(false);},[report?.diagnosis_id]);
  useEffect(()=>{if(expanded||!statement.current)return;const element=statement.current;const measure=()=>setCanExpand(element.scrollHeight>element.clientHeight+1);const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[report?.diagnosis_id,report?.summary,expanded]);
  const refs=report?.findings.flatMap(finding=>finding.evidence).filter((ref,index,all)=>all.findIndex(item=>item.evidence_id===ref.evidence_id)===index)||[];
  const event=events.find(event=>event.event_id===run.insight?.failure_signals.find(signal=>signal.kind==='event')?.event_id)||events.find(isFailure);
  const stderr=objectValue(event?.output).stderr;
  const errorText=typeof stderr==='string'?stderr.trim().split('\n').slice(-2).join(' '):event?.error_signature;
  const fact=event?`${event.name} · ${errorText||'来源记录了执行异常'}`:run.outcome_status==='failed'?'任务检查未通过；当前没有记录到执行错误。':run.execution_status==='running'?'运行进行中，任务是否达标尚需检查结果。':'当前记录未提供明确失败事件，请结合任务检查判断。';
  return <div className="run-analysis-layout">
    <div className="analysis-reading">
      <div className="analysis-fact"><span>发生了什么</span><strong title={fact}>{fact}</strong></div>
      {analysis.reportError&&<p role="alert">报告刷新失败：{analysis.reportError}；保留已收到的记录。</p>}
      {analysis.loading&&!report?<p className="analysis-empty"><Loader2 size={16} className="spin"/>正在读取分析记录…</p>:report?<>
        <div className="analysis-result-heading"><strong>{reportKind(report)}</strong><button className="text-button full-report" onClick={onFullReport}>查看完整报告<ArrowUpRight size={13}/></button></div>
        <p ref={statement} className={'hypothesis-statement'+(!expanded?' compact':'')}>{report.summary||'报告未提供原因摘要。'}</p>
        {canExpand&&<button className="text-button summary-expand" onClick={()=>setExpanded(value=>!value)}>{expanded?'收起摘要原文':'展开摘要原文'}</button>}
        <div className="hypothesis-evidence"><div><strong>相关证据</strong><span>{refs.length} 条引用</span></div>{(allEvidence?refs:refs.slice(0,3)).map(ref=><button className={'evidence-chip '+ref.resolution_status} key={ref.evidence_id} title={evidenceLabel(ref,events)} onClick={()=>onEvidence(ref.evidence_id)}><FileText size={13}/><span>{evidenceLabel(ref,events)}</span><ArrowUpRight size={12}/></button>)}{refs.length>3&&<button className="text-button" onClick={()=>setAllEvidence(value=>!value)}>{allEvidence?'收起其他证据':`查看其余 ${refs.length-3} 条证据`}</button>}{!refs.length&&<p>报告没有可定位的事件引用。<button className="text-button" onClick={()=>onEvidence(report.raw_evidence_id)}>查看源报告</button></p>}</div>
        {report.boundary&&<p className="analysis-boundary"><strong>尚不能确定 / 分析限制</strong>{report.boundary}</p>}
        <div className="analysis-followup"><strong>下一步检查 <small>尚未执行</small></strong><p>{report.verification_suggestion||report.guidance||'报告没有提供具体检查步骤；请先核对失败记录和任务检查依据。'}</p></div>

      </>:<div className="analysis-empty"><strong>还没有原因分析</strong><p>从右侧开始定位，核对候选证据后再决定是否使用模型分析。</p></div>}
    </div>
    <DiagnosisControls run={run} analysis={analysis}/>
  </div>;
}

export function ReportView({report,onEvidence}:{report:Diagnosis;onEvidence:(id:string)=>void}) {
  return <article className="analysis-full-report"><div className="analysis-result-heading"><strong>{reportKind(report)}</strong><button className="text-button" onClick={()=>onEvidence(report.raw_evidence_id)}>查看源报告<ArrowUpRight size={13}/></button></div><h3>摘要原文</h3><p>{report.summary}</p>{report.findings.map((finding,index)=><section className="full-finding" key={index}><h3>{index+1}. {finding.title}</h3><p>{finding.description}</p>{finding.evidence.map((ref,index)=><button className={'evidence-chip '+ref.resolution_status} key={index} onClick={()=>onEvidence(ref.evidence_id)}>{ref.label} · {ref.resolution_status}<ArrowUpRight size={12}/></button>)}</section>)}{report.guidance&&<><h3>建议原文</h3><p>{report.guidance}</p></>}{report.verification_suggestion&&<><h3>建议检查 · 尚未执行</h3><p>{report.verification_suggestion}</p></>}{report.boundary&&<><h3>分析限制</h3><p>{report.boundary}</p></>}<details><summary>全部报告字段 / 原始JSON</summary><pre>{pretty(report)}</pre></details></article>;
}

function checkSource(outcome:Outcome,run:Run) {
  if(outcome.source_kind==='report')return '历史报告提供';
  if(outcome.source_kind==='telemetry')return '历史遥测提供';
  if(run.origin==='live')return '接入方上报 · 平台未复跑';
  return outcome.source_kind==='outcome'||outcome.authoritative?'历史检查文件 · 平台未复跑':'历史结果 · 平台未复跑';
}
export function CheckPanel({run,onEvidence,onAnalyze}:{run:Run;onEvidence:(id:string)=>void;onAnalyze:()=>void}) {
  const [data,setData]=useState<Outcome[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();api<Outcome[]>(`/runs/${run.run_id}/outcomes`,{signal:controller.signal}).then(items=>{setData(items);setError('');}).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message);});return()=>controller.abort();},[run.run_id,run.event_count,run.outcome_status]);
  return <section className="outcomes task-checks"><div className="check-heading"><strong>任务是否达标 <span className={'check-status '+run.outcome_status}>{checkNames[run.outcome_status]||'未知'}</span></strong><p>根据上报的测试或规则判断，与原因分析分开保留。</p>{run.outcome_status==='failed'&&<button className="text-button" onClick={onAnalyze}>分析本次运行的失败原因<ArrowUpRight size={12}/></button>}</div>{run.warnings.includes('outcome_conflict')&&<p role="status" className="check-conflict">检查记录存在冲突，任务结果未知；请核对各来源。</p>}{run.warnings.includes('outcome_sources_disagree')&&<p role="status">不同来源的检查结果存在差异；当前结果沿用已记录的验收依据。</p>}{error&&<p role="alert">{error}</p>}{!data&&!error?<p>正在读取检查记录…</p>:!data?.length?<p>尚无检查记录。平台没有通过分析报告补充任务结论。</p>:data.map(outcome=><details className="check-row" key={outcome.outcome_id} open={outcome.status==='failed'}><summary><span className={'check-status '+outcome.status}>{outcome.status==='passed'?<Check size={14}/>:outcome.status==='failed'?<X size={14}/>:null}{checkNames[outcome.status]||'未知'}</span><strong>{outcome.source}</strong><code title={pretty(outcome.basis)}>{pretty(outcome.basis)}</code><small>{checkSource(outcome,run)}</small></summary><div className="check-record"><div><p>{outcome.summary||'来源未提供检查摘要。'}</p><span>检查依据 <code>{pretty(outcome.basis)}</code>{outcome.reward!==null&&<> · reward {outcome.reward}</>}</span></div><button className="text-button" onClick={()=>onEvidence(outcome.evidence_id)}>查看检查记录<ArrowUpRight size={13}/></button></div></details>)}</section>;
}
