import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Blocks,ChevronRight,Clock3,Info,Terminal,X} from 'lucide-react';
import {api,type ModelCall,type Run,type RunMetrics} from './api';
import {durationLabel} from './trace-model';
import './run-usage.css';

export const usageNumber=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('en-US');

export function useRunMetrics(run:Run) {
  const [data,setData]=useState<RunMetrics|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);
    api<RunMetrics>(`/runs/${run.run_id}/metrics`,{signal:controller.signal}).then(value=>{setData(value);setError('');setLoading(false);}).catch(reason=>{if(!controller.signal.aborted){setError(reason.message);setLoading(false);}});
    return()=>controller.abort();
  },[run.run_id,run.event_count,run.execution_status,retry]);
  return {data,error,loading,retry:()=>setRetry(value=>value+1)};
}

function UsageDialog({metrics,onSelect,onClose}:{metrics:RunMetrics;onSelect:(call:ModelCall)=>void;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();trigger?.isConnected&&trigger.focus({preventScroll:true});};},[]);
  const tokens=metrics.tokens;
  return <dialog ref={ref} className="usage-dialog" aria-label="模型调用与用量" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <header><div><strong>模型调用与用量</strong><span>本次 Agent · {metrics.in_progress?'截至目前':'已记录'}</span></div><button className="icon-button" aria-label="关闭用量明细" onClick={onClose}><X size={18}/></button></header>
    <div className="usage-dialog-totals">{([['input','输入 Token'],['output','输出 Token'],['total','已记录总 Token']] as const).map(([key,label])=><div key={key}><span>{label}</span><strong>{usageNumber(tokens[key].value)}</strong><small>{tokens[key].responses}/{tokens.responses} 条响应有用量</small></div>)}</div>
    <p className="usage-dialog-note"><Info size={14}/>只统计已观察到的 Agent 调用；缺少用量显示 —，平台 RCA 用量单独保留。</p>
    {!!(metrics.llm.ambiguous_events+metrics.llm.unclassified_events)&&<p className="usage-data-warning">另有 {metrics.llm.ambiguous_events+metrics.llm.unclassified_events} 条模型事件无法确定调用归属，未计入本表和用量合计。</p>}
    {!!tokens.conflicting_responses&&<p className="usage-data-warning">{tokens.conflicting_responses} 条响应的总量与分项之和不一致，保留来源总量。</p>}
    <div className="usage-call-scroll"><table className="usage-call-table"><thead><tr><th>模型 / 步骤</th><th>状态</th><th>输入</th><th>输出</th><th>总 Token</th><th>耗时</th></tr></thead><tbody>{metrics.llm.calls.map(call=><tr key={call.event_id}><td><button disabled={!call.evidence_id} onClick={()=>onSelect(call)} title="定位对应模型事件，查看输入输出和原始证据"><small>#{call.position+1}</small><span>{call.model||'来源未提供模型'}</span><ArrowUpRight size={13}/></button></td><td><span className={'usage-call-state '+call.state}>{call.state==='failed'?'失败':call.state==='pending'?metrics.in_progress?'待返回':'缺少返回':'已返回'}</span></td><td>{usageNumber(call.usage?.input_tokens)}</td><td>{usageNumber(call.usage?.output_tokens)}</td><td>{usageNumber(call.usage?.total_tokens)}</td><td>{durationLabel(call.duration_ms)}</td></tr>)}</tbody></table>{!metrics.llm.calls.length&&<p className="usage-no-calls">尚未记录到可识别的模型调用。</p>}</div>
    <footer><span>点击模型定位到执行轨迹</span><span>费用：尚无计价配置</span></footer>
  </dialog>;
}

export function RunUsageSummary({metrics,error,loading,retry,onModels,onTools,onTime,onSelect}:{metrics:RunMetrics|null;error:string;loading:boolean;retry:()=>void;onModels:()=>void;onTools:()=>void;onTime:()=>void;onSelect:(call:ModelCall)=>void}) {
  const [open,setOpen]=useState(false);
  const tokens=metrics?.tokens,tools=metrics?.tools,llm=metrics?.llm;
  const countSuffix=!llm?'等待数据':llm.pending?`${llm.pending} 次${metrics?.in_progress?'待返回':'缺少返回'}`:llm.response_only?`${llm.response_only} 条仅记录响应`:'按唯一关联计数';
  return <>
    <section className="run-usage-strip" aria-label="本次运行用量" aria-busy={loading}>
      <button className="usage-metric" onClick={onTime} disabled={!metrics||metrics.time.recorded_ms===null} title="来源事件最早至最晚时间的跨度；不是步骤耗时之和，也不保证跨采集器时钟同步"><span className="usage-metric-label"><Clock3 size={14}/>观测时长</span><span className="usage-metric-value">{metrics?durationLabel(metrics.time.recorded_ms):'—'}</span><small>{!metrics?'等待数据':metrics.in_progress?'截至最新事件':`${metrics.time.timed_events} 条带时间事件`}</small></button>
      <button className="usage-metric" onClick={onModels} disabled={!llm?.observed} title="筛选模型事件；一次请求与对应响应只计一次，不代表底层 HTTP 重试数"><span className="usage-metric-label"><Blocks size={14}/>模型调用</span><span className="usage-metric-value">{llm?usageNumber(llm.observed):'—'}<span>次</span></span><small>{countSuffix}</small></button>
      <button className="usage-metric" onClick={onTools} disabled={!tools?.observed} title="筛选工具执行；明确关联的调用和返回才配对"><span className="usage-metric-label"><Terminal size={14}/>工具调用</span><span className="usage-metric-value">{tools?usageNumber(tools.observed):'—'}<span>次</span>{!!tools?.failed&&<em>{tools.failed} 失败</em>}</span><small>{tools?`${tools.paired} 组返回${tools.unpaired_calls?` · ${tools.unpaired_calls} 未配对`:''}`:'等待数据'}</small></button>
      <button className="usage-metric usage-tokens" onClick={()=>setOpen(true)} disabled={!metrics} title="查看输入／输出 Token 与每次模型响应，来源未提供用量不按 0 计算"><span className="usage-metric-label">已记录 Token<ChevronRight size={13}/></span><span className="usage-metric-value">{usageNumber(tokens?.total.value)}</span><small>{tokens?.total.value==null?'来源未提供总用量':`输入 ${usageNumber(tokens.input.value)} · 输出 ${usageNumber(tokens.output.value)}`}</small></button>
      <div className="usage-scope"><span className={'usage-scope-label'+(metrics?.in_progress?' live':'')}>{metrics?.in_progress?'实时累计':'本次 Agent'}</span><small>{error?<button onClick={retry} title={error}>刷新失败 · 重试</button>:!metrics?'读取用量…':`${tokens!.total.responses}/${tokens!.responses} 响应有总用量`}</small>{!!(llm?.ambiguous_events||llm?.unclassified_events)&&<small className="usage-data-warning">部分模型事件未计入</small>}</div>
    </section>
    {open&&metrics&&<UsageDialog metrics={metrics} onClose={()=>setOpen(false)} onSelect={call=>{setOpen(false);onSelect(call);}}/>}
  </>;
}

export function ModelUsageDetail({call}:{call:ModelCall}) {
  return <section className="model-usage-detail" aria-label="选中模型调用用量"><div className="model-usage-heading"><Blocks size={15}/><strong>{call.model||'来源未提供模型'}</strong><span>{call.response_only?'仅记录响应':call.state==='pending'?'尚无返回':'模型调用'}</span></div><div className="model-token-values">{([['input_tokens','输入 Token'],['output_tokens','输出 Token'],['total_tokens','总 Token']] as const).map(([key,label])=><div key={key}><span>{label}</span><strong>{usageNumber(call.usage?.[key])}</strong></div>)}</div>{call.usage?<small>用量来源：返回步骤 #{call.position+1} · {call.usage.source}{call.usage.total_derived?' · 总量由输入与输出相加':''}{call.usage.warnings.length?' · 来源总量与分项不一致':''}</small>:<small>{call.state==='pending'?'尚未记录响应，用量待提供。':'此响应未提供用量，未计入 Token 合计。'}</small>}</section>;
}
