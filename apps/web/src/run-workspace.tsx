import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {AlertCircle,ArrowLeft,ArrowUpRight,Blocks,Check,ChevronDown,ChevronLeft,ChevronRight,ChevronUp,Clock3,FileJson,FileText,Layers3,Link2,Loader2,Search,Sparkles,Terminal,X} from 'lucide-react';
import {api,pretty,executionNames,outcomeNames,diagnosisNames,warningNames,type Run,type TraceEvent,type Evidence,type Diagnosis} from './api';
import {callInterval,durationLabel,isFailure,kindLabel,objectValue,pageTimeWindow,rowDuration,rowFailure,rowPrimary,timelineTicks,traceModel,type TraceRow} from './trace-model';
import './run-workspace.css';
import {TimelineGrid,TimelineMark,TimelineNavigation,TimelineRuler,TraceBranch,TraceType,useTimelineView} from './trace-timeline';
import {useRunAnalysis,type RunAnalysis} from './run-analysis';
import {reportKind} from './run-panels';
import {ModelUsageDetail,RunUsageSummary,useRunMetrics} from './run-usage';

// Event records are append-only. Read in bounded API batches; refresh only the suffix.
function useTrace(run:Run) {
  const cache=useRef<{id:string;events:TraceEvent[]}>({id:run.run_id,events:[]});
  const [state,setState]=useState({id:run.run_id,events:[] as TraceEvent[],loading:true,error:''});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    if(cache.current.id!==run.run_id)cache.current={id:run.run_id,events:[]};
    const current=cache.current;
    setState({id:run.run_id,events:[...current.events],loading:true,error:''});
    async function read(){
      try {
        let target=run.event_count;
        do {
          const result=await api<{items:TraceEvent[];total:number}>(`/runs/${run.run_id}/events?offset=${current.events.length}&limit=200`,{signal:controller.signal});
          if(controller.signal.aborted)return;
          const known=new Set(current.events.map(e=>e.event_id));
          current.events.push(...result.items.filter(e=>!known.has(e.event_id)));target=result.total;
          setState({id:run.run_id,events:[...current.events],loading:current.events.length<target,error:''});
          if(!result.items.length)break;
        }while(current.events.length<target);
        if(!controller.signal.aborted)setState({id:run.run_id,events:[...current.events],loading:false,error:''});
      }catch(error){if(!controller.signal.aborted)setState({id:run.run_id,events:[...current.events],loading:false,error:(error as Error).message});}
    }
    // No read is necessary when the SSE count has not changed.
    if(current.events.length===run.event_count&&retry===0){setState({id:run.run_id,events:[...current.events],loading:false,error:''});}
    else void read();
    return()=>controller.abort();
  },[run.run_id,run.event_count,retry]);
  return {...(state.id===run.run_id?state:{id:run.run_id,events:[],loading:true,error:''}),retry:()=>setRetry(n=>n+1)};
}

function EventIcon({event}:{event:TraceEvent}) {
  return event.kind.startsWith('tool')?<Terminal size={14}/>:event.kind==='llm'?<Blocks size={14}/>:event.kind==='log'?<FileText size={14}/>:event.kind==='verification'?<Check size={14}/>:<Layers3 size={14}/>;
}
function EventStatus({event}:{event:TraceEvent}) {
  if(isFailure(event))return <span className="event-result failed"><X size={12}/>失败</span>;
  if(event.tool_status==='succeeded')return <span className="event-result succeeded"><Check size={12}/>成功</span>;
  return <span className="event-result neutral">{event.kind==='tool_call'?'调用':event.tool_status==='conflict'?'冲突':event.kind==='log'?'日志':'已记录'}</span>;
}
function RowStatus({row}:{row:TraceRow}) {
  if(row.kind==='event')return <EventStatus event={row.event}/>;
  if(rowFailure(row))return <span className="event-result failed"><X size={12}/>失败</span>;
  if(row.returned.tool_status==='succeeded')return <span className="event-result succeeded"><Check size={12}/>成功</span>;
  return <span className="event-result neutral">已返回</span>;
}
function ValueSection({label,value,open=true}:{label:string;value:unknown;open?:boolean}) {
  if(value===null||value===undefined)return null;
  return <details className="event-value" open={open}><summary>{label}</summary><pre>{pretty(value)}</pre></details>;
}
function RawEvidence({id}:{id:string}) {
  const [state,setState]=useState<{id:string;data:Evidence|null;error:string}>({id,data:null,error:''});
  const [formatted,setFormatted]=useState(true);
  useEffect(()=>{const controller=new AbortController();setState({id,data:null,error:''});setFormatted(true);
    api<Evidence>('/evidence/'+id,{signal:controller.signal}).then(data=>setState({id,data,error:''})).catch(error=>{if(!controller.signal.aborted)setState({id,data:null,error:error.message});});
    return()=>controller.abort();},[id]);
  const data=state.id===id?state.data:null;
  if(state.error)return <p className="workspace-error" role="alert">{state.error}</p>;
  if(!data)return <p className="pane-empty"><Loader2 size={15} className="spin"/>读取原始证据…</p>;
  let value=data.content;if(formatted&&typeof value==='string'){try{value=JSON.parse(value.replace(/^\uFEFF/,''));}catch{/* Preserve plain logs. */}}
  return <div className="raw-inspector"><div className="raw-location"><FileJson size={14}/><strong>{data.filename}</strong><span>{data.line?'L'+data.line:data.json_pointer||'完整文件'}</span></div>
    {data.resolution_status!=='resolved'&&<p className="workspace-notice">{data.resolution_status==='ambiguous'?'引用存在多个候选':'引用未解析'}，未建立事件关联。</p>}
    <div className="raw-tools"><span>原件只读</span><button className="text-button" onClick={()=>setFormatted(v=>!v)}>{formatted?'原始文本':'格式化展示'}</button></div><pre className="source-code">{pretty(value)}</pre><details className="event-value"><summary>文件校验 SHA-256</summary><code>{data.sha256}</code></details></div>;
}

type DockMode='diagnosis'|'validation';
type ResourceMode='technical'|'history'|'report';
function RunResources({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[]);
  return <dialog ref={ref} className="run-resources" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}} aria-label={title}><div className="resources-heading"><strong>{title}</strong><button className="icon-button" aria-label="关闭资料" onClick={close}><X size={18}/></button></div><div className="resources-content">{children}</div></dialog>;
}
interface Props {
  run:Run;connection:string;error:string;sourceLabels:ReactNode;diagnosisLabel:ReactNode;
  renderDiagnosis:(openEvidence:(id:string)=>void,analysis:RunAnalysis,events:TraceEvent[],onFullReport:()=>void)=>ReactNode;
  renderValidation:(openEvidence:(id:string)=>void,onAnalyze:()=>void)=>ReactNode;
  renderTechnical:(openEvidence:(id:string)=>void,analysis:RunAnalysis)=>ReactNode;
  renderReport:(report:Diagnosis,openEvidence:(id:string)=>void)=>ReactNode;
}
export function RunWorkspace({run,connection,error,sourceLabels,diagnosisLabel,renderDiagnosis,renderValidation,renderTechnical,renderReport}:Props) {
  const trace=useTrace(run);const events=trace.events;
  const metrics=useRunMetrics(run);
  const analysis=useRunAnalysis(run),references=analysis.reports;
  const model=useMemo(()=>traceModel(events),[events]);
  const [selected,setSelected]=useState<string|null>(null),[query,setQuery]=useState(''),[kind,setKind]=useState(''),[onlyErrors,setOnlyErrors]=useState(false);
  const [page,setPage]=useState(0),[follow,setFollow]=useState(run.origin==='live'&&run.execution_status==='running');
  const [timeScope,setTimeScope]=useState<'page'|'run'>('page');
  const [tree,setTree]=useState(true),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[expanded,setExpanded]=useState<Set<string>>(new Set());
  const hasRecordedFailure=(run.insight?.failure_signals||[]).some(s=>s.kind==='event');
  const [dock,setDock]=useState<DockMode>(run.outcome_status==='failed'&&!hasRecordedFailure?'validation':'diagnosis');
  const [dockOpen,setDockOpen]=useState(run.execution_status!=='running'),[dockHeight,setDockHeight]=useState(run.outcome_status==='failed'&&!hasRecordedFailure?180:Math.min(260,Math.max(180,window.innerHeight-560)));
  const [resources,setResources]=useState<ResourceMode|null>(null);
  const manualHeight=useRef(false),dockTouched=useRef(false);
  useEffect(()=>{function fitDock(){setDockHeight(height=>Math.max(140,Math.min(height,window.innerHeight*.48,manualHeight.current?Infinity:Math.max(180,window.innerHeight-560))));}window.addEventListener('resize',fitDock);return()=>window.removeEventListener('resize',fitDock);},[]);
  const [rawId,setRawId]=useState<string|null>(null),[detailTab,setDetailTab]=useState<'details'|'raw'>('details'),[evidenceMessage,setEvidenceMessage]=useState('');
  const [locating,setLocating]=useState(false);
  const [pendingEvidence,setPendingEvidence]=useState<{id:string;eventId:string}|null>(null);
  const initialized=useRef(false),requestVersion=useRef(0),traceScroll=useRef<HTMLDivElement>(null),dockRef=useRef<HTMLDivElement>(null);
  const selectedRow=model.rows.find(row=>row.id===selected)||null;
  const selectedEvent=selectedRow?rowPrimary(selectedRow):null;
  const filterActive=!!(query||kind||onlyErrors);
  const filtered=useMemo(()=>model.rows.filter(row=>(!kind||(kind==='tool'?row.kind==='tool_span'||rowPrimary(row).kind.startsWith('tool'):row.events.some(event=>event.kind===kind)))&&(!onlyErrors||rowFailure(row))&&(!query||row.events.some(event=>JSON.stringify(event).toLowerCase().includes(query.toLowerCase())))),[model,kind,onlyErrors,query]);
  const ordered=useMemo(()=>{
    if(!tree||!model.hasTree||filterActive)return filtered.map(row=>({row,depth:0,hasChildren:false,guides:[] as boolean[],last:true}));
    const children=new Map<string,TraceRow[]>();for(const row of model.rows){const parent=model.rowParent.get(row.id)||'';children.set(parent,[...(children.get(parent)||[]),row]);}
    const rows:{row:TraceRow;depth:number;hasChildren:boolean;guides:boolean[];last:boolean}[]=[];
    function visit(parent:string,depth:number,guides:boolean[]=[]){const siblings=children.get(parent)||[];siblings.forEach((row,index)=>{const hasChildren=!!children.get(row.id)?.length,last=index===siblings.length-1;rows.push({row,depth,hasChildren,guides,last});if(!collapsed.has(row.id))visit(row.id,depth+1,depth>0?[...guides,!last]:guides);});}
    visit('',0);return rows;
  },[filtered,tree,model,filterActive,collapsed]);
  const pageSize=50,pageCount=Math.max(1,Math.ceil(ordered.length/pageSize)),safePage=Math.min(page,pageCount-1),rows=ordered.slice(safePage*pageSize,(safePage+1)*pageSize);
  const pageWindow=pageTimeWindow(rows.map(item=>item.row),model.start,model.end);
  const timeWindow=timeScope==='page'?pageWindow:{start:model.start,end:model.end,scope:'run' as const};
  const timeView=useTimelineView(timeWindow.start,timeWindow.end,`${timeScope}:${safePage}:${kind}:${query}:${onlyErrors}:${tree}`);
  const ticks=timelineTicks(timeView.start,timeView.end,model.start);
  const failures=model.rows.filter(rowFailure);
  const selectedOutside=!!selectedRow&&!ordered.some(item=>item.row.id===selected);
  const referencedRows=useMemo(()=>new Set(references.flatMap(report=>report.findings.flatMap(finding=>finding.evidence.filter(ref=>ref.resolution_status==='resolved'&&ref.event_id).map(ref=>model.rowForEvent.get(ref.event_id!)||'')).filter(Boolean))),[references,model]);
  useEffect(()=>{
    if(trace.loading||initialized.current)return;
    initialized.current=true;
    if(run.outcome_status==='failed'&&!failures.length){if(!dockTouched.current){setDock('validation');setDockOpen(true);}return;}
    const signal=run.insight?.failure_signals?.find(s=>s.kind==='event'&&s.event_id);
    const initial=follow?model.rows.at(-1):model.rows.find(row=>row.events.some(e=>e.event_id===signal?.event_id))||failures[0]||model.rows.at(-1);
    if(initial){setSelected(initial.id);setPage(Math.floor(Math.max(0,ordered.findIndex(item=>item.row.id===initial.id))/pageSize));}
  },[trace.loading,events,run,failures]);
  useEffect(()=>{if(follow&&ordered.length){setPage(Math.floor((ordered.length-1)/pageSize));setSelected(ordered.at(-1)!.row.id);setDetailTab('details');setRawId(null);}},[follow,ordered.length]);
  useEffect(()=>{if(selected)traceScroll.current?.querySelector<HTMLElement>(`[data-event-id="${selected}"]`)?.scrollIntoView({block:'nearest'});},[selected,safePage,ordered.length]);
  useEffect(()=>{function escape(event:KeyboardEvent){if(event.key==='Escape'&&detailTab==='raw'){setDetailTab('details');setRawId(null);}}window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[detailTab]);
  useEffect(()=>{
    if(!pendingEvidence)return;
    const target=events.find(event=>event.event_id===pendingEvidence.eventId);
    if(target){locateEvent(target);setRawId(pendingEvidence.id);setDetailTab('raw');setEvidenceMessage('已定位报告引用的执行事件');setPendingEvidence(null);}
    else if(!trace.loading){setPendingEvidence(null);setEvidenceMessage('该引用没有本轮可定位的执行事件，保留原始证据。');}
  },[events,trace.loading,pendingEvidence]);
  function selectRow(row:TraceRow){initialized.current=true;requestVersion.current++;setPendingEvidence(null);setSelected(row.id);setFollow(false);setDetailTab('details');setRawId(null);setEvidenceMessage('');}
  function locateEvent(event:TraceEvent){const target=model.rows.find(row=>row.id===model.rowForEvent.get(event.event_id));if(!target)return;
    setQuery('');setKind('');setOnlyErrors(false);setCollapsed(new Set());selectRow(target);
    const fullRows=tree&&model.hasTree?(()=>{const list:TraceRow[]=[];function visit(id:string){for(const row of model.rows.filter(item=>(model.rowParent.get(item.id)||'')===id)){list.push(row);visit(row.id);}}visit('');return list;})():model.rows;
    setPage(Math.max(0,Math.floor(fullRows.findIndex(row=>row.id===target.id)/pageSize)));}
  async function openEvidence(id:string){
    initialized.current=true;const version=++requestVersion.current;setPendingEvidence(null);setFollow(false);setLocating(true);setEvidenceMessage('');
    try {const evidence=await api<Evidence>('/evidence/'+id);if(version!==requestVersion.current)return;
      const target=evidence.resolution_status==='resolved'?events.find(e=>e.event_id===evidence.event_id):null;
      if(target){locateEvent(target);setEvidenceMessage('已定位报告引用的执行事件');}
      else{setSelected(null);if(evidence.resolution_status==='resolved'&&evidence.event_id&&trace.loading)setPendingEvidence({id,eventId:evidence.event_id});setEvidenceMessage(evidence.event_id&&trace.loading?'轨迹仍在加载；当前先查看原始证据':'Run 级证据或未解析引用，没有可定位的执行事件');}
      setRawId(id);setDetailTab('raw');
    }catch(error){if(version===requestVersion.current)setEvidenceMessage((error as Error).message);}finally{setLocating(false);}
  }
  function openDock(mode:DockMode){dockTouched.current=true;setDock(mode);setDockOpen(true);if(!manualHeight.current)setDockHeight(Math.min(window.innerHeight*.48,mode==='validation'?180:260));}
  function openResource(mode:ResourceMode){setResources(mode);}
  function resourceEvidence(id:string){setResources(null);void openEvidence(id);}
  function jumpFailure(){const current=failures.findIndex(row=>row.id===selected);const next=failures[(current+1)%failures.length];if(next)locateEvent(rowPrimary(next));else openDock('validation');}
  function resizeDock(event:React.PointerEvent<HTMLDivElement>){
    manualHeight.current=true;
    const startY=event.clientY,startHeight=dockHeight;event.currentTarget.setPointerCapture(event.pointerId);
    const move=(move:PointerEvent)=>setDockHeight(Math.max(140,Math.min(window.innerHeight*.48,startHeight+startY-move.clientY)));
    const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});
  }
  const selectedDuration=selectedRow?rowDuration(selectedRow):null;
  const selectedInput=selectedRow?.kind==='tool_span'?selectedRow.call.input:selectedEvent?.input;
  const selectedOutput=selectedRow?.kind==='tool_span'?selectedRow.returned.output:selectedEvent?.output;
  const input=objectValue(selectedInput),output=objectValue(selectedOutput);
  const selectedModelCall=selectedEvent?.kind==='llm'?metrics.data?.llm.calls.find(call=>call.start_event_id===selectedEvent.event_id||call.end_event_id===selectedEvent.event_id):undefined;
  const refs=selectedRow?references.filter(report=>report.findings.some(finding=>finding.evidence.some(ref=>ref.resolution_status==='resolved'&&selectedRow.events.some(event=>ref.event_id===event.event_id)))):[];
  const contextPosition=selectedRow?.kind==='tool_span'?(selectedRow.events.find(isFailure)?.position??selectedRow.returned.position):selectedEvent?.position;
  const previous=contextPosition===undefined?[]:events.filter(e=>e.position<contextPosition&&e.event_id!==selectedRow?.id).slice(-3);
  const capture=run.origin==='live'?({complete:'完整',partial:'不完整',pending:'接收中 / 待补齐',unknown:'未知'} as Record<string,string>)[run.capture_integrity||'unknown']:'按来源文件核对';
  const executionTone=({running:'running',completed:'complete',failed:'failed',cancelled:'unknown',unknown:'unknown'} as Record<string,string>)[run.execution_status]||'unknown';
  const projectedState=run.insight?.diagnosis.state||'none';
  const diagnosisState=projectedState!=='none'?projectedState:analysis.reports.length?(analysis.reports.some(report=>report.mode==='analyst_rca')?'hypothesis':analysis.reports.some(report=>report.origin==='recomputed')?'localization':'historical'):'none';
  const diagnosisTone=({running:'running',failed:'failed',hypothesis:'hypothesis',localization:'localization',historical:'unknown',none:'unknown'} as Record<string,string>)[diagnosisState]||'unknown';
  const captureTone=run.origin!=='live'?'unknown':({complete:'complete',partial:'partial',pending:'running',unknown:'unknown'} as Record<string,string>)[run.capture_integrity||'unknown']||'unknown';
  return <div className="run-console">
    <header className="console-header"><div className="console-identity"><Link to="/" className="console-back" aria-label="返回运行工作台"><ArrowLeft size={17}/></Link><div><div className="console-kicker"><span>RUN</span><span>第 {run.attempt_index} 次运行</span>{sourceLabels}</div><h1 title={run.task_goal||'Agent 运行'}>{run.task_goal||'Agent 运行'}</h1></div></div><div className="console-links"><Link to={'/tasks/'+run.task_id}>任务历程<ArrowUpRight size={13}/></Link><button onClick={()=>openResource('technical')}>运行资料<FileJson size={13}/></button></div></header>
    <div className="console-states run-status"><div><span>Execution</span><strong className={'status-value tone-'+executionTone}>{executionNames[run.execution_status]||'执行未知'}</strong><small>退出码 {run.exit_code??'—'}</small></div><button onClick={()=>openDock('validation')}><span>Task Outcome</span><strong className={'status-value tone-'+run.outcome_status}>{outcomeNames[run.outcome_status]||'验收未知'}</strong></button><button onClick={()=>openDock('diagnosis')}><span>Diagnosis</span><strong className={'status-value tone-'+diagnosisTone}>{diagnosisState!==projectedState?diagnosisNames[diagnosisState]:diagnosisLabel}</strong></button><div><span>Capture</span><strong className={'status-value tone-'+captureTone}>{capture}</strong></div></div>
    {run.origin==='live'&&<div className="console-live live-monitor" role="status"><span className={'connection-dot '+(connection==='connected'?'':'offline')}/><span>{connection==='connected'?'网页实时连接':connection==='reconnecting'?'网页断线 · 正在重连':'正在建立实时连接'}</span><span>采集器：{({connected:'在线',disconnected:'失联 · 状态未确认',finished:'已结束'} as Record<string,string>)[run.capture_status||'']||'连接中'}</span><span>丢失告警 {run.dropped_events||0}</span></div>}
    {(error||run.warnings.length>0)&&<details className="console-warnings"><summary><AlertCircle size={13}/>{error?'详情刷新失败，保留已收到记录':`数据提示 ${run.warnings.length}`}</summary>{error&&<p>{error}</p>}<ul>{run.warnings.map(item=><li key={item}>{warningNames[item]||item}</li>)}</ul></details>}
    <RunUsageSummary metrics={metrics.data} error={metrics.error} loading={metrics.loading} retry={metrics.retry}
      onTime={()=>{setTimeScope('run');timeView.fit();}}
      onModels={()=>{setKind('llm');setQuery('');setOnlyErrors(false);setPage(0);setFollow(false);const row=model.rows.find(row=>rowPrimary(row).kind==='llm');if(row)selectRow(row);}}
      onTools={()=>{setKind('tool');setQuery('');setOnlyErrors(false);setPage(0);setFollow(false);const row=model.rows.find(row=>row.kind==='tool_span'||rowPrimary(row).kind==='tool_call');if(row)selectRow(row);}}
      onSelect={call=>{const target=events.find(event=>event.event_id===call.event_id);if(target)locateEvent(target);else if(call.evidence_id)void openEvidence(call.evidence_id);}}/>
    <div className="console-trace-toolbar"><span className="toolbar-title">Execution Trace</span><label className="console-search"><Search size={14}/><input aria-label="搜索事件" placeholder="搜索事件、命令或错误…" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);setFollow(false);}}/></label><select aria-label="事件类型" value={kind} onChange={e=>{setKind(e.target.value);setPage(0);setFollow(false);}}><option value="">全部类型</option><option value="tool">Tool Execution</option>{['llm','log','event'].map(type=><option value={type} key={type}>{kindLabel(type)}</option>)}</select><button className={onlyErrors?'active':''} aria-pressed={onlyErrors} onClick={()=>{setOnlyErrors(v=>!v);setPage(0);setFollow(false);}}>仅异常 {failures.length||''}</button>{(failures.length>0||run.outcome_status==='failed')&&<button onClick={jumpFailure}>{failures.length?'定位失败':'查看验收失败'}</button>}<button className="run-analysis-trigger" title="分析本次运行；先定位、预览，人工确认后才调用模型" onClick={()=>openDock('diagnosis')}><Sparkles size={14}/>{analysis.actionLabel}</button><span className="toolbar-count">{model.rows.length.toLocaleString()} 步 · {events.length.toLocaleString()} 原始事件</span>{run.origin==='live'&&<button className={follow?'active':''} onClick={()=>{setFollow(v=>!v);if(!follow){setQuery('');setKind('');setOnlyErrors(false);setCollapsed(new Set());}}}>{follow?'暂停跟随':'跟随最新'}</button>}</div>
    <div className="console-split">
      <section className="execution-pane" aria-label="执行轨迹"><div className="execution-caption"><span>{tree&&model.hasTree&&!filterActive?'来源关系树':'时序事件列表'}{model.hasTree&&<button onClick={()=>{setTree(v=>!v);setPage(0);}}>{tree?'平铺':'关系树'}</button>}</span><span className="execution-caption-tools">{model.hasTimeline&&<span className="time-scope" role="group" aria-label="时间轴范围"><span>时间范围</span><button aria-pressed={timeWindow.scope==='page'} disabled={pageWindow.scope!=='page'} title={pageWindow.scope==='page'?'以当前页来源时间绘制线性时间轴':'当前页缺少可用的时间范围'} onClick={()=>setTimeScope('page')}>本页</button><button aria-pressed={timeWindow.scope==='run'} title="以整轮来源时间绘制线性时间轴" onClick={()=>setTimeScope('run')}>整轮</button></span>}{model.hasTimeline&&<TimelineNavigation view={timeView} selected={selectedRow}/>}<span className="execution-follow-label">{follow?'跟随最新事件':run.origin==='live'?'已暂停跟随 · 可查看旧记录':'保留原始事件顺序'}</span></span></div>
        {selectedOutside&&<div className="workspace-notice">选中事件不在当前筛选／折叠结果内。<button className="text-button" onClick={()=>selectedEvent&&locateEvent(selectedEvent)}>定位并显示</button></div>}
        <div className="execution-scroll" ref={traceScroll}>
          <div className={'execution-columns'+(!model.hasTimeline?' without-time':'')}><span>步骤 / 事件</span>{model.hasTimeline&&<TimelineRuler ticks={ticks} view={timeView}/>}<span>Duration</span></div>
          <div className="execution-rows">{model.hasTimeline&&<TimelineGrid ticks={ticks}/>}
          {trace.error&&<div className="workspace-error" role="alert">{trace.error} <button className="text-button" onClick={trace.retry}>重试读取</button></div>}
          {!events.length&&<div className="pane-empty">{trace.loading?<><Loader2 size={18} className="spin"/>读取执行轨迹…</>:run.execution_status==='running'?<>等待 Agent 上报事件<br/><small>采集到的步骤会实时出现在这里</small></>:<>本次运行没有执行事件<br/><small>仍可查看已有诊断与独立验收记录</small></>}</div>}
          {events.length>0&&!rows.length&&<div className="pane-empty">没有匹配事件<button className="text-button" onClick={()=>{setQuery('');setKind('');setOnlyErrors(false);}}>清除筛选</button></div>}
          {rows.map(({row,depth,hasChildren,guides,last})=>{
            const event=rowPrimary(row),interval=row.kind==='tool_span'?callInterval(row.call,row.returned):null;
            const failure=row.events.find(isFailure),summary=objectValue(failure?.output);const inlineError=failure?.error_signature||pretty(summary.stderr??failure?.output);
            const referenced=referencedRows.has(row.id),duration=rowDuration(row);
            return <div className={'execution-item'+(failure?' failed':'')+(referenced?' referenced':'')} key={row.id}>
              <div role="button" tabIndex={0} aria-label={`${row.kind==='tool_span'?'选择工具执行':'选择事件'} ${event.position+1} ${row.name}`} aria-pressed={selected===row.id} data-event-id={row.id} className={'trace-row console-event'+(selected===row.id?' selected':'')+(!model.hasTimeline?' without-time':'')} onClick={()=>selectRow(row)} onDoubleClick={()=>timeView.focus(row)} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();selectRow(row);}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const index=ordered.findIndex(item=>item.row.id===row.id)+(e.key==='ArrowDown'?1:-1);const next=ordered[index]?.row;if(next){selectRow(next);setPage(Math.floor(index/pageSize));}}}}>
                <div className="console-event-name"><span className="trace-position">{String(event.position+1).padStart(3,'0')}</span><TraceBranch depth={depth} guides={guides} last={last}/>{hasChildren&&<button className="row-expand" aria-label={collapsed.has(row.id)?'展开子事件':'收起子事件'} onClick={e=>{e.stopPropagation();setCollapsed(values=>{const next=new Set(values);next.has(row.id)?next.delete(row.id):next.add(row.id);return next;});}}>{collapsed.has(row.id)?<ChevronRight size={12}/>:<ChevronDown size={12}/>}</button>}<TraceType row={row}/><div className="trace-name"><strong title={row.name}>{row.name}</strong><small className="trace-kind-description">{row.kind==='tool_span'?'Tool Execution':kindLabel(event.kind)}</small></div>{referenced&&<Link2 className="trace-reference" size={12} aria-label="被诊断报告引用"/>}<span className="trace-row-status"><RowStatus row={row}/></span></div>
                {model.hasTimeline&&<TimelineMark row={row} view={timeView} origin={model.start} failed={!!failure}/>}
                <span className={'event-duration'+(duration!==null?' measured':'')+(interval?' ranged':'')} title={interval?'调用与返回的来源时间区间':duration!==null?'来源提供耗时；未据此推断起止时间':'来源未提供耗时'}>{durationLabel(duration)}</span>
              </div>
              {failure&&<div className="inline-failure"><button aria-expanded={expanded.has(row.id)} onClick={()=>setExpanded(values=>{const next=new Set(values);next.has(row.id)?next.delete(row.id):next.add(row.id);return next;})}>{expanded.has(row.id)?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<span>{failure.error_signature||'查看失败输出'}</span></button>{expanded.has(row.id)&&<pre>{inlineError}</pre>}</div>}
            </div>;
          })}
          </div>
        </div>
        <div className="execution-footer"><span title="按来源带时区的时间戳绘制；区间只来自唯一关联的调用与返回，不保证跨生产者时钟同步。">{model.hasTimeline?`来源时间 · ${model.timeCount}/${events.length} 条有时间 · ${timeWindow.scope==='page'?'本页':'整轮'} ${durationLabel(timeView.end-timeView.start)} · 刻度相对本轮起点`:'顺序视图 · 无可靠时间尺度'}{trace.loading&&' · 继续读取中…'}</span><div><button aria-label="上一页" disabled={safePage===0} onClick={()=>{setFollow(false);setPage(safePage-1);traceScroll.current?.scrollTo(0,0);}}><ChevronLeft size={14}/></button><span>{safePage+1}/{pageCount}</span><button aria-label="下一页" disabled={safePage+1>=pageCount} onClick={()=>{setFollow(false);setPage(safePage+1);traceScroll.current?.scrollTo(0,0);}}><ChevronRight size={14}/></button></div></div>
      </section>
      <aside className="event-inspector" aria-label="选中事件详情"><div className="inspector-head">{selectedEvent?<><EventIcon event={selectedEvent}/><strong title={selectedEvent.name}>{selectedEvent.name}</strong><span>#{selectedEvent.position+1}{selectedRow?.kind==='tool_span'?`–${selectedRow.returned.position+1}`:''}</span></>:<><FileText size={15}/><strong>{rawId?'Run 级原始证据':'Selected Event'}</strong></>}</div><div className="inspector-tabs" role="tablist" aria-label="事件详情视图"><button role="tab" aria-selected={detailTab==='details'} onClick={()=>setDetailTab('details')}>详情</button><button role="tab" aria-selected={detailTab==='raw'} disabled={!rawId&&!selectedEvent} onClick={()=>{if(!rawId&&selectedEvent)setRawId(selectedEvent.evidence_id);setDetailTab('raw');}}>原始证据</button>{detailTab==='raw'&&<button className="inspector-close" aria-label="关闭证据" onClick={()=>{setRawId(null);setDetailTab('details');}}><X size={13}/></button>}</div>
        <div className="inspector-scroll">{(evidenceMessage||locating)&&<p className="workspace-notice" role="status">{locating?'定位证据…':evidenceMessage}</p>}
          {detailTab==='raw'&&rawId?<RawEvidence id={rawId}/>:selectedEvent?<>
            <div className="selected-overview">{selectedRow&&<RowStatus row={selectedRow}/>}<span>{selectedRow?.kind==='tool_span'?'Tool Execution':kindLabel(selectedEvent.kind)}</span><span><Clock3 size={12}/>{durationLabel(selectedDuration)}</span></div>
            {selectedRow&&rowFailure(selectedRow)&&<div className="selected-error"><h3><AlertCircle size={14}/>Error · 已记录异常</h3><pre>{selectedRow.events.find(isFailure)?.error_signature||pretty(output.stderr??selectedOutput)}</pre><button className="text-button contextual-analysis" onClick={()=>openDock('diagnosis')}>分析本次运行的失败原因<ArrowUpRight size={12}/></button></div>}
            {selectedModelCall&&<ModelUsageDetail call={selectedModelCall}/>}
            {(input.command!==undefined||output.returncode!==undefined||(!selectedModelCall&&(input.model!==undefined||output.model!==undefined)))&&<dl className="event-facts">{input.command!==undefined&&<><dt>Command</dt><dd>{pretty(input.command)}</dd></>}{output.returncode!==undefined&&<><dt>Return code</dt><dd>{pretty(output.returncode)}</dd></>}{!selectedModelCall&&(input.model??output.model)!==undefined&&<><dt>Model</dt><dd>{pretty(input.model??output.model)}</dd></>}</dl>}
            <ValueSection label={selectedRow?.kind==='tool_span'?'Call / Arguments':'Input'} value={selectedInput}/><ValueSection label={selectedRow?.kind==='tool_span'?'Return / Exit code':'Output'} value={selectedOutput} open={output.stdout===undefined&&output.stderr===undefined}/>
            {selectedInput==null&&selectedOutput==null&&<p className="detail-absent">来源未提供输入或输出。</p>}
            {output.stdout!==undefined&&<ValueSection label="stdout" value={output.stdout} open={!!selectedRow&&rowFailure(selectedRow)}/>}{output.stderr!==undefined&&<ValueSection label="stderr" value={output.stderr} open={!!selectedRow&&rowFailure(selectedRow)}/>}
            <div className="event-origin-links"><button className="evidence-location" onClick={()=>{setRawId(selectedEvent.evidence_id);setDetailTab('raw');}}><FileText size={14}/>{selectedRow?.kind==='tool_span'?'调用原件':'原始证据'} · {selectedEvent.line?'L'+selectedEvent.line:'事件记录'}<ArrowUpRight size={12}/></button>{selectedRow?.kind==='tool_span'&&<button className="evidence-location" onClick={()=>{setRawId(selectedRow.returned.evidence_id);setDetailTab('raw');}}><FileText size={14}/>返回原件 · {selectedRow.returned.line?'L'+selectedRow.returned.line:'事件记录'}<ArrowUpRight size={12}/></button>}</div>
            {!!refs.length&&<div className="event-references"><h3>被原因分析引用</h3>{refs.map(report=><button key={report.diagnosis_id} onClick={()=>{analysis.selectReport(report.diagnosis_id);openDock('diagnosis');}}>{report.mode==='analyst_rca'?'待验证根因假设':report.origin==='imported'?'历史报告':'定位线索'}<ArrowUpRight size={12}/></button>)}</div>}
            {selectedRow&&rowFailure(selectedRow)&&!!previous.length&&<details className="event-context" open><summary>异常前的事件</summary>{previous.map(event=><button key={event.event_id} onClick={()=>locateEvent(event)}><span>{String(event.position+1).padStart(3,'0')}</span><strong>{event.name}</strong><small>{kindLabel(event.kind)}</small></button>)}</details>}
            <details className="event-value"><summary>Attributes / Raw</summary><dl className="event-facts"><dt>事件时间</dt><dd>{selectedEvent.occurred_at||'未提供'}</dd><dt>Correlation ID</dt><dd>{selectedEvent.correlation_id||'未提供'}</dd><dt>源 ID</dt><dd>{selectedEvent.source_span_id||'未提供'}</dd><dt>父 ID</dt><dd>{selectedEvent.parent_source_id||'未提供'}</dd></dl>{selectedRow?.kind==='tool_span'?<><strong>Call event</strong><pre>{pretty(selectedRow.call)}</pre><strong>Return event</strong><pre>{pretty(selectedRow.returned)}</pre></>:<pre>{pretty(selectedEvent)}</pre>}</details>
          </>:<div className="pane-empty"><Layers3 size={24}/><strong>选择一个执行事件</strong><span>{run.outcome_status==='failed'&&!failures.length?'任务验收未通过，但未记录失败执行事件。':'在左侧选择步骤，查看输入、输出与原始证据。'}</span>{run.outcome_status==='failed'&&!failures.length&&<button className="text-button" onClick={()=>openDock('validation')}>查看任务检查</button>}</div>}
        </div>
      </aside>
    </div>
    <div className={'run-dock'+(dockOpen?' open':'')} ref={dockRef} style={dockOpen?{height:dockHeight}:undefined}>
      {dockOpen&&<div className="dock-resize" role="separator" aria-label="调整调查面板高度" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={Math.round(window.innerHeight*.48)} aria-valuenow={Math.round(dockHeight)} tabIndex={0} onPointerDown={resizeDock} onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();manualHeight.current=true;setDockHeight(height=>Math.max(140,Math.min(window.innerHeight*.48,height+(e.key==='ArrowUp'?20:-20))));}}}/>}
      <div className="dock-bar"><div role="tablist" aria-label="Run 级调查"><button id="analysis-tab" role="tab" aria-controls="analysis-panel" aria-selected={dock==='diagnosis'} onClick={()=>openDock('diagnosis')} onKeyDown={e=>{if(e.key==='ArrowRight'){openDock('validation');document.getElementById('check-tab')?.focus();}}}>原因分析</button><button id="check-tab" role="tab" aria-controls="check-panel" aria-selected={dock==='validation'} onClick={()=>openDock('validation')} onKeyDown={e=>{if(e.key==='ArrowLeft'){openDock('diagnosis');document.getElementById('analysis-tab')?.focus();}}}>任务检查 <span className={run.outcome_status}>{({passed:'通过',failed:'未通过',unknown:'未知'} as Record<string,string>)[run.outcome_status]||'未知'}</span></button></div><button className="dock-resource-link" onClick={()=>openResource('history')}>分析记录 <span>{analysis.loading?(run.insight?.diagnosis.report_count||0):analysis.reports.length}</span></button><button className="dock-resource-link" onClick={()=>openResource('technical')}>更多资料<FileJson size={12}/></button><span className="dock-scope">本次运行 · 分析不改变检查结果</span><button className="dock-toggle" aria-label={dockOpen?'收起调查面板':'展开调查面板'} onClick={()=>setDockOpen(v=>!v)}>{dockOpen?<ChevronDown size={15}/>:<ChevronUp size={15}/>}</button></div>
      <div className="dock-content" hidden={!dockOpen}><div id="analysis-panel" role="tabpanel" aria-labelledby="analysis-tab" hidden={dock!=='diagnosis'}>{renderDiagnosis(openEvidence,analysis,events,()=>openResource('report'))}</div><div id="check-panel" role="tabpanel" aria-labelledby="check-tab" hidden={dock!=='validation'}>{renderValidation(openEvidence,()=>openDock('diagnosis'))}</div></div>
    </div>
    {resources&&<RunResources key={resources} title={resources==='technical'?'更多资料':resources==='history'?'分析记录':'完整分析报告'} close={()=>setResources(null)}>
      {resources==='technical'?renderTechnical(resourceEvidence,analysis):resources==='report'?(analysis.selected?renderReport(analysis.selected,resourceEvidence):<p>尚无可查看的报告。</p>):<div className="analysis-history"><p>共 {analysis.reports.length} 份报告，包含定位、模型分析和历史报告；不是根因数量。</p>{analysis.reportError&&<p role="alert">{analysis.reportError}</p>}{!analysis.reports.length&&<p>尚无分析记录。</p>}{analysis.reports.map(report=><button className={'analysis-history-row'+(analysis.selected?.diagnosis_id===report.diagnosis_id?' selected':'')} key={report.diagnosis_id} onClick={()=>{analysis.selectReport(report.diagnosis_id);setResources(null);openDock('diagnosis');}}><strong>{reportKind(report)}</strong><time>{report.created_at?new Date(report.created_at).toLocaleString('zh-CN'):'来源未提供报告时间'}</time><span>{report.summary}</span><small>{report.origin==='imported'?'历史导入':'本机生成'} · {report.source_algorithm}</small></button>)}</div>}
    </RunResources>}
  </div>;
}
