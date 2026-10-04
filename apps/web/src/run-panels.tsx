import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,Check,ChevronDown,FileText,Loader2,Search,X} from 'lucide-react';
import {api,pretty,type Diagnosis,type Outcome,type Ref,type Run,type TraceEvent} from './api';
import {isFailure,objectValue,rowFailure,traceModel,type TraceRow} from './trace-model';
import {Link} from 'react-router-dom';
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
  const [expanded,setExpanded]=useState(false),[allEvidence,setAllEvidence]=useState(false),[activeEvidence,setActiveEvidence]=useState<string|null>(null);
  const [canExpand,setCanExpand]=useState(false),statement=useRef<HTMLParagraphElement>(null);
  // A verbatim opening-sentence excerpt is navigation, not a rewritten conclusion.
  const excerpt=report?.summary.match(/^([\s\S]{1,160}?[。！？]|[\s\S]{1,160}?[.!?](?:\s|$))/)?.[0]?.trim()||report?.summary||'';
  const hasExcerpt=!!report&&excerpt!==report.summary;
  useEffect(()=>{setExpanded(false);setAllEvidence(false);setActiveEvidence(null);},[report?.diagnosis_id]);
  useEffect(()=>{if(expanded||!statement.current)return;const element=statement.current;const measure=()=>setCanExpand(hasExcerpt||element.scrollHeight>element.clientHeight+1);const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[report?.diagnosis_id,report?.summary,expanded,hasExcerpt]);
  const refs=useMemo(()=>report?.findings.flatMap(finding=>finding.evidence).filter((ref,index,all)=>all.findIndex(item=>item.evidence_id===ref.evidence_id)===index)||[],[report]);
  const groups=useMemo(()=>{
    const model=traceModel(events),result:{key:string;row:TraceRow|null;refs:Ref[]}[]=[];
    for(const ref of refs){const event=ref.resolution_status==='resolved'?events.find(event=>event.event_id===ref.event_id||event.evidence_id===ref.evidence_id):undefined;
      const row=event?model.rows.find(row=>row.id===model.rowForEvent.get(event.event_id))||null:null;
      const key=row?.kind==='tool_span'?row.id:ref.evidence_id;
      const existing=result.find(group=>group.key===key);if(existing)existing.refs.push(ref);else result.push({key,row,refs:[ref]});
    }return result;
  },[refs,events]);
  const event=events.find(event=>event.event_id===run.insight?.failure_signals.find(signal=>signal.kind==='event')?.event_id)||events.find(isFailure);
  const stderr=objectValue(event?.output).stderr;
  const errorText=typeof stderr==='string'?stderr.trim().split('\n').slice(-2).join(' '):event?.error_signature;
  const fact=event?`${event.name} · ${errorText||'来源记录了执行异常'}`:run.outcome_status==='failed'?'任务检查未通过，尚未记录执行错误。':run.execution_status==='running'?'正在运行，等待任务检查结果。':'没有明确的执行失败记录，请结合任务检查判断。';
  function inspect(ref:Ref){setActiveEvidence(ref.evidence_id);onEvidence(ref.evidence_id);}
  return <div className={'run-analysis-layout'+(analysis.preview?' previewing':'')}>
    <div className="analysis-reading">
      <div className="analysis-fact"><span>记录事实</span><strong title={fact}>{fact}</strong></div>
      {analysis.reportError&&<p role="alert">报告刷新失败：{analysis.reportError}；保留已收到的记录。</p>}
      {analysis.loading&&!report?<p className="analysis-empty"><Loader2 size={16} className="spin"/>正在读取分析记录…</p>:report?<>
        <section className="analysis-conclusion" aria-label="分析结果"><div className="analysis-result-heading"><strong>{reportKind(report)}</strong><span className="analysis-source">{report.origin==='imported'?'历史导入':'本机生成'}</span></div>
          <p ref={statement} className={'hypothesis-statement'+(!expanded?' compact':'')}>{(expanded?report.summary:excerpt)||'报告未提供原因摘要。'}</p>
          <div className="conclusion-tools">{hasExcerpt&&!expanded&&<span className="excerpt-label">摘要原文节选</span>}{canExpand&&<button className="text-button summary-expand" onClick={()=>setExpanded(value=>!value)}>{expanded?'收起摘要原文':'展开摘要原文'}<ChevronDown size={12}/></button>}<button className="text-button full-report" onClick={onFullReport}>查看完整报告<ArrowUpRight size={13}/></button></div>
        </section>
        <section className="hypothesis-evidence" aria-label="报告引用的证据"><div className="evidence-heading"><strong>相关证据</strong><span>{refs.length} 条原始引用</span></div>
          <div className="analysis-evidence-rows">{(allEvidence?groups:groups.slice(0,3)).map(group=>{
            const primary=group.row?.events[0],failed=group.row?rowFailure(group.row):false,succeeded=group.row?.events.some(event=>event.tool_status==='succeeded');
            return <div className={'analysis-evidence-row'+(group.refs.some(ref=>ref.evidence_id===activeEvidence)?' active':'')} key={group.key}>
              <div className="evidence-row-heading"><FileText size={14}/><strong>{group.row?`#${String((primary?.position??0)+1).padStart(2,'0')} ${group.row.name}`:group.refs[0].label||'来源引用'}</strong><span className={failed?'failed':succeeded?'passed':'unknown'}>{failed?'失败':succeeded?'成功':group.row?'已记录':group.refs[0].resolution_status==='resolved'?'源文件':'引用待解析'}</span></div>
              <div className="evidence-row-links">{group.refs.map(ref=>{const event=ref.resolution_status==='resolved'?events.find(event=>event.event_id===ref.event_id||event.evidence_id===ref.evidence_id):undefined;
                const label=event?.kind==='tool_call'?'调用参数':event?.kind==='tool_return'?'返回原件':event?.kind==='verification'?'检查原件':'查看原件';
                return <button className={'evidence-chip '+ref.resolution_status} key={ref.evidence_id} aria-label={evidenceLabel(ref,events)} title={evidenceLabel(ref,events)} onClick={()=>inspect(ref)}>{label}<ArrowUpRight size={12}/></button>;
              })}</div>
            </div>;
          })}</div>
          {groups.length>3&&<button className="text-button evidence-more" onClick={()=>setAllEvidence(value=>!value)}>{allEvidence?'收起其他证据':`显示全部 ${refs.length} 条引用`}</button>}
          {!refs.length&&<p className="evidence-missing">报告未提供可定位的引用。<button className="text-button" onClick={()=>onEvidence(report.raw_evidence_id)}>查看源报告</button></p>}
        </section>
        <section className="analysis-followup"><div><strong>下一步检查</strong><span>尚未执行</span></div><p>{report.verification_suggestion||report.guidance||'报告未提供具体检查步骤；请先核对失败记录和任务检查依据。'}</p><Link className="followup-history" to={'/tasks/'+run.task_id}>查看任务历程<ArrowUpRight size={13}/></Link><small>修改与复跑在本地终端进行。</small></section>
        {report.boundary&&<details className="analysis-limits"><summary>分析范围与不确定性</summary><p>{report.boundary}</p></details>}
      </>:<div className="analysis-empty"><span className="analysis-empty-icon"><Search size={22}/></span><strong>{run.execution_status==='running'?'先观察本次运行':'还没有原因分析'}</strong><p>{run.execution_status==='running'?'执行结束后，可结合工具记录和任务检查分析原因。':'先定位异常步骤，再核对证据并决定是否调用模型。'}</p></div>}
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
  return <section className="outcomes task-checks"><div className="check-heading"><strong>任务是否达标 <span className={'check-status '+run.outcome_status}>{checkNames[run.outcome_status]||'未知'}</span></strong><p>根据上报的测试或规则判断，与原因分析分开保留。</p>{run.outcome_status==='failed'&&<button className="text-button" onClick={onAnalyze}>分析本次运行的失败原因<ArrowUpRight size={12}/></button>}</div>{run.warnings.includes('outcome_conflict')&&<p role="status" className="check-conflict">检查记录存在冲突，任务结果未知；请核对各来源。</p>}{run.warnings.includes('outcome_sources_disagree')&&<p role="status">不同来源的检查结果存在差异；当前结果沿用已记录的验收依据。</p>}{error&&<p role="alert">{error}</p>}{!data&&!error?<p>正在读取检查记录…</p>:!data?.length?<p>尚无检查记录。平台没有通过分析报告补充任务结论。</p>:data.map(outcome=>{
    const basis=pretty(outcome.basis),detailedBasis=(typeof outcome.basis==='object'&&outcome.basis!==null)||basis.length>180||basis.includes('\n');
    return <details className="check-row" key={outcome.outcome_id} open={outcome.status==='failed'}><summary><span className={'check-status '+outcome.status}>{outcome.status==='passed'?<Check size={14}/>:outcome.status==='failed'?<X size={14}/>:null}{checkNames[outcome.status]||'未知'}</span><strong>{outcome.source}</strong>{!detailedBasis&&<code title={basis}>{basis}</code>}<small>{checkSource(outcome,run)}</small></summary><div className="check-record"><div><p>{outcome.summary||'来源未提供检查摘要。'}</p>{detailedBasis?<details className="check-basis"><summary>查看检查依据 · 原始字段</summary><pre>{basis}</pre></details>:<span>检查依据 <code>{basis}</code></span>}{outcome.reward!==null&&<small>来源 reward {outcome.reward}</small>}</div><button className="text-button" onClick={()=>onEvidence(outcome.evidence_id)}>查看检查记录<ArrowUpRight size={13}/></button></div></details>;
  })}</section>;
}
