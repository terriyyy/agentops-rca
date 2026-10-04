import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Blocks, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock3, Code2, Database, FileJson, FileSearch, FileText, FlaskConical, GitCompareArrows, GitBranch, Layers3, ListFilter, Loader2, Plus, Search, Settings2, ShieldCheck, Terminal, Upload, X } from 'lucide-react';
import { api, pretty, outcomeNames, executionNames, diagnosisNames, attentionNames, modelNames, warningNames, type Diagnosis, type Evidence, type ImportResult, type Outcome, type Run, type Task, type TraceEvent, type WorkbenchOverview, type HomeSource } from './api';
import './styles.css';
import { useLiveRun } from './live';
import { DiagnosisJobHistory,type Capabilities } from './diagnosis';
import type {RunAnalysis} from './run-analysis';
import {AnalysisPanel,CheckPanel,ReportView} from './run-panels';
import { RunWorkspace } from './run-workspace';
import {CaptureFeedback,HomeOverview,MonitorStart,homeSources} from './home-overview';
import {RunViewContext,useRunViewState} from './run-view';
import {HomeRunSection as HomeSection} from './home-run-list';
import {TaskHistoryView,TaskIndex} from './task-history';

function useData<T>(url: string, refresh = 0) {
  const [state, setState] = useState<{url:string;data: T | null; error: string; loading: boolean}>({url,data:null,error:'',loading:true});
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => previous.url===url?({...previous,error:'',loading:previous.data===null}):({url,data:null,error:'',loading:true}));
    api<T>(url, {signal:controller.signal}).then(data => setState({url,data,error:'',loading:false})).catch(error => {
      if (error.name !== 'AbortError') setState(previous=>({url,data:previous.url===url?previous.data:null,error:error.message,loading:false}));
    });
    return () => controller.abort();
  }, [url,refresh]);
  return state.url===url?state:{url,data:null,error:'',loading:true};
}
const EvidenceContext = createContext<(id: string) => void>(()=>{});
const formatNumber = (value:number)=>new Intl.NumberFormat('zh-CN').format(value);
function Badge({status, children}: {status?: string; children?: React.ReactNode}) { return <span className={`badge ${status || ''}`}><i/>{children || outcomeNames[status || 'unknown'] || status}</span>; }
function SourceBadge({kind}: {kind:string}) { return <span className={`source-tag ${kind==='synthetic'?'synthetic':''}`}>{kind==='synthetic'?'合成演示':kind==='derived'?'派生样例':kind==='live'?'现场执行':'历史实验'}</span>; }
function SourceLabels({run}: {run:Run}) {return <span className="source-labels"><span className="source-tag">{run.origin==='live'?'实时采集':'历史导入'}</span><SourceBadge kind={run.sample_kind}/></span>;}
function DiagnosisLabel({run}: {run:Run}) {const snapshot=run.insight?.diagnosis;return <span>{diagnosisNames[snapshot?.state||'none']||'诊断状态未知'}{snapshot?.latest_job&&['failed','timed_out','interrupted'].includes(snapshot.latest_job.state)&&snapshot.report_count>0?' · 最近作业失败':''}</span>;}
function Loading() { return <div className="loading"><Loader2 size={20} className="spin"/> 正在读取本地记录…</div>; }
function ErrorBox({text}: {text:string}) { return <div role="alert" className="error-box">{text}</div>; }
function Empty({title, children}: {title:string; children?:React.ReactNode}) { return <div className="empty"><FileSearch size={35}/><h3>{title}</h3><p>{children}</p></div>; }
function Warnings({items}: {items:string[]}) { return items.length ? <details className="quality"><summary><ShieldCheck size={16}/> 数据质量提示 <span>{items.length}</span></summary><ul>{items.map(item=><li key={item}>{warningNames[item] || item}</li>)}</ul></details> : null; }

function EvidenceDrawer({id, close, investigation=false}: {id:string; close:()=>void; investigation?:boolean}) {
  const {data,error,loading}=useData<Evidence>('/evidence/'+id);
  const [formatted,setFormatted]=useState(true);
  let displayValue=data?.content;
  if(formatted&&typeof displayValue==='string'){try{displayValue=JSON.parse(displayValue.replace(/^\uFEFF/,''));}catch{/* Plain text is displayed unchanged. */}}
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <dialog ref={dialog} className={'evidence-dialog'+(investigation?' investigation-evidence':'')} onCancel={close} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="drawer-title"><div><span className="eyebrow">原始记录</span><h2>原始证据</h2></div><button className="icon-button" aria-label="关闭证据" onClick={close}><X size={22}/></button></div>
    {loading ? <Loading/> : error ? <ErrorBox text={error}/> : data && <>
      <div className="evidence-meta"><FileJson size={17}/><strong>{data.filename}</strong><span>{data.line ? `第 ${data.line} 行` : data.json_pointer || '完整文件'}</span></div>
      {data.resolution_status!=='resolved'&&<div className="notice">引用{data.resolution_status==='ambiguous'?'存在多个候选':'未能解析到事件'}。下方展示报告保存的原始引用，不代表已建立关联。</div>}
      <div className="evidence-format"><span>{formatted?'格式化展示 · 不修改原件':'原始内容'}</span><button className="text-button" onClick={()=>setFormatted(v=>!v)}>{formatted?'查看原始文本':'格式化展示'}</button></div><pre className="source-code">{pretty(displayValue)}</pre><div className="hash"><span>原始文件 SHA-256</span><code>{data.sha256}</code></div>
    </>}
  </dialog>;
}

function Shell() {
  const [evidence,setEvidence]=useState<string|null>(null);
  const location=useLocation();
  const view=useRunViewState(),isRun=location.pathname.startsWith('/runs/');
  useEffect(()=>{if(!isRun)view.setFocus(false);},[isRun]);
  const health=useData<{version:string;status:string}>('/health');
  useEffect(()=>{setEvidence(null);window.scrollTo(0,0);},[location.pathname]);
  const section=location.pathname.startsWith('/imports')?'数据导入':location.pathname.startsWith('/system')?'运行环境':location.pathname.startsWith('/tasks')?'任务历程':location.pathname.startsWith('/runs')?'运行详情':'运行工作台';
  return <RunViewContext.Provider value={view}><EvidenceContext.Provider value={setEvidence}><div className={"app-shell"+(isRun?" run-shell":"")+(isRun&&view.focus?" run-focus":"")}>
    <aside className="sidebar" hidden={isRun&&view.focus}><Link to="/" className="brand"><div className="brand-mark"><GitBranch size={22}/></div><span>agentops<span className="brand-suffix"> / RCA</span></span></Link>
      <div className="workspace-label"><div className="workspace-avatar">A</div><div>本地工作区<small>任务与诊断</small></div><span className="workspace-dot"/></div>
      <nav><NavLink to="/" end aria-label="运行工作台"><Activity size={18}/><span className="nav-text">运行工作台</span></NavLink><NavLink to="/tasks" aria-label="任务历程"><Layers3 size={18}/><span className="nav-text">任务历程</span></NavLink><NavLink to="/imports" aria-label="数据导入"><ArrowDownToLine size={18}/><span className="nav-text">数据导入</span></NavLink><NavLink to="/system" aria-label="运行环境"><Settings2 size={18}/><span className="nav-text">运行环境</span></NavLink></nav>
<div className="sidebar-foot"><span className={`connection-dot ${health.error?'offline':''}`}/><span>{health.error?'API 未连接':health.loading?'正在连接…':'本地 API 已连接'}</span><code>v{health.data?.version||'0.1'}</code></div>
    </aside>
    <div className="workspace-main"><header className="topbar"><div><span>AgentOps</span><ChevronRight size={14}/><strong>{section}</strong></div><div><span className="local-pill"><Database size={13}/> LOCAL</span><span className="avatar">研</span></div></header>
      <main><Routes><Route path="/" element={<HomePage/>}/><Route path="/tasks" element={<TasksPage/>}/><Route path="/tasks/:taskId" element={<TaskPage/>}/><Route path="/tasks/:taskId/compare" element={<ComparePage/>}/><Route path="/runs/:runId" element={<RunPage/>}/><Route path="/imports" element={<ImportsPage/>}/><Route path="/system" element={<SystemPage/>}/><Route path="*" element={<Empty title="页面不存在"><Link to="/">返回运行工作台</Link></Empty>}/></Routes></main>
      <footer>AGENTOPS / RCA <span>实时与历史工作台 · 所有验收结果保留来源</span></footer>
    </div>{evidence&&<EvidenceDrawer id={evidence} close={()=>setEvidence(null)} investigation={location.pathname.startsWith('/runs/')}/>}</div></EvidenceContext.Provider></RunViewContext.Provider>;
}

function HomePage() {
  const [refresh,setRefresh]=useState(0),[start,setStart]=useState(false);
  const [source,setSource]=useState<HomeSource>(()=>{try{const value=sessionStorage.getItem('agentops.home.source');return value&&value in homeSources?value as HomeSource:'live';}catch{return 'live';}});
  const [updated,setUpdated]=useState<string|null>(null);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{try{sessionStorage.setItem('agentops.home.source',source);}catch{/* Browsing remains available without storage. */}},[source]);
  const {data,error,loading}=useData<WorkbenchOverview>(`/overview?limit=20&source=${source}&include_summary=true`,refresh);
  useEffect(()=>{if(data)setUpdated(new Date().toLocaleTimeString('zh-CN'));},[data]);
  const [busy,setBusy]=useState(false),[actionError,setActionError]=useState('');
  const navigate=useNavigate(),summary=data?.summary||null;
  async function demo(){setBusy(true);setActionError('');try{const result=await api<ImportResult>('/examples/import',{method:'POST'});navigate('/runs/'+result.run_ids[0]);}catch(e){setActionError((e as Error).message);}finally{setBusy(false);}}
  function openStart(){setActionError('');setStart(true);}
  function section(id:string){const heading=document.getElementById(id);heading?.scrollIntoView({block:'start'});heading?.focus({preventScroll:true});}
  return <div className="home-workbench">
    <div className="page-heading"><div><h1>运行工作台</h1><p>监控 Agent 执行，调查失败原因，核对任务检查。</p></div><div className="home-heading-actions"><Link to="/tasks">任务历程<ArrowUpRight size={14}/></Link><button className="button" onClick={openStart}><Terminal size={16}/>开始监控</button></div></div>
    <div className="home-scope-bar"><label>记录来源<select aria-label="记录来源" value={source} onChange={event=>setSource(event.target.value as HomeSource)}>{Object.entries(homeSources).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><span>状态为当前数量 · 用量取最近 20 次入库记录</span><small>{loading?'正在读取…':error?'更新失败':updated?`自动刷新 · ${updated}`:'等待数据'}</small><button className="home-refresh" onClick={()=>setRefresh(value=>value+1)}>刷新</button></div>
    {error&&<div className="home-refresh-error" role="alert">{data?'刷新失败，保留上次数据。':'无法读取运行记录。'} {error}<button className="text-button" onClick={()=>setRefresh(value=>value+1)}>重试</button></div>}
    <HomeOverview key={source} summary={summary} onSection={section}/>
    {summary?.all_runs===0?<section className="home-first-use"><div><h2>让你的第一次运行出现在这里</h2><p>选择接入方式 → 在终端启动 → 打开 Run 链接。也可以先查看无模型演示。</p></div><button className="button" onClick={openStart}>查看接入步骤<ArrowUpRight size={15}/></button></section>:summary&&<CaptureFeedback onStart={openStart} summary={summary} renderSource={run=><SourceLabels run={run}/>}/>}
    {summary&&summary.total_runs===0&&summary.all_runs>0&&<p className="home-dialog-scope">“{homeSources[source]}”下暂无记录；其他来源已有 {summary.all_runs} 次运行。<button className="text-button" onClick={()=>setSource('all')}>查看全部来源</button></p>}
    {loading&&!data?<Loading/>:data&&<div className="workbench-sections">
      <HomeSection samples={summary?.sample.items} renderSource={run=><SourceLabels run={run}/>} id="home-running" count={summary?.running} title="正在运行" description="打开 Run 查看实时采集的步骤。" runs={data.running} empty="所选来源下没有正在运行的 Agent。"/>
      <HomeSection samples={summary?.sample.items} renderSource={run=><SourceLabels run={run}/>} id="home-attention" count={summary?.attention} title="需要处理" description="执行异常、检查未通过、采集不完整或诊断作业失败。" runs={data.attention} empty="所选来源下暂时没有需要处理的运行。"/>
      <HomeSection samples={summary?.sample.items} renderSource={run=><SourceLabels run={run}/>} id="home-recent" title="其他最近运行" description="已在上方出现的 Run 不重复列出；按入库顺序排列。" runs={data.recent} empty="暂无其他运行记录。"/>
    </div>}
    {start&&<MonitorStart close={()=>setStart(false)} demo={demo} busy={busy} error={actionError}/>}
  </div>;
}

function TasksPage() {
  const [refresh,setRefresh]=useState(0);
  const {data:tasks,error,loading}=useData<Task[]>('/tasks',refresh);
  return <TaskIndex tasks={tasks} error={error} loading={loading} onRefresh={()=>setRefresh(value=>value+1)} renderSource={run=><SourceLabels run={run}/>}/>;
}

function Back({to,children}: {to:string;children:React.ReactNode}) {return <Link className="back-link" to={to}><ArrowLeft size={14}/>{children}</Link>;}
function TaskPage() {
  const {taskId}=useParams();const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  const {data:task,error,loading}=useData<Task>('/tasks/'+taskId,refresh);
  if(loading&&!task)return <Loading/>;if(!task)return <ErrorBox text={error}/>;
  return <TaskHistoryView key={task.id} task={task} error={error} renderSource={run=><SourceLabels run={run}/>}/>;
}

function RunPage() {
  const {runId}=useParams();const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  const {data:initial,error,loading}=useData<Run>('/runs/'+runId,refresh);
  const {run,connection}=useLiveRun(initial);
  if(loading&&!run)return <Loading/>;if(!run)return <ErrorBox text={error}/>;
  return <RunWorkspace key={run.run_id} run={run} connection={connection} error={error} sourceLabels={<SourceLabels run={run}/>} diagnosisLabel={<DiagnosisLabel run={run}/>}
    renderDiagnosis={(open,analysis,events,onFullReport)=><AnalysisPanel run={run} analysis={analysis} events={events} onEvidence={open} onFullReport={onFullReport}/>}
    renderValidation={(open,onAnalyze)=><CheckPanel run={run} onEvidence={open} onAnalyze={onAnalyze}/>}
    renderTechnical={(open,analysis)=><EvidenceContext.Provider value={open}><TechnicalPanel run={run} analysis={analysis}/></EvidenceContext.Provider>}
    renderReport={(report,open)=><ReportView report={report} onEvidence={open}/>}/>;
}

function TechnicalPanel({run,analysis}: {run:Run;analysis:RunAnalysis}) {
  const data=analysis.reports,error=analysis.reportError,capabilities=analysis.caps;
  const open=useContext(EvidenceContext);
  return <div className="technical-panel"><DiagnosisJobHistory jobs={analysis.jobs} onEvidence={open}/><details className="technical-group"><summary>算法、模型与来源 {data?.length?`· ${data.length} 份报告`:''}</summary>{error&&<ErrorBox text={error}/>}<p className="muted">当前配置模型：{capabilities?.model||'未配置'}。历史报告使用的模型以其原始记录为准。</p>{data?.map(report=><details className="technical-report" key={report.diagnosis_id}><summary>{report.mode==='analyst_rca'?'RCA':report.origin==='recomputed'?'HGT':'历史'} · {report.summary}</summary><dl className="event-facts"><dt>算法</dt><dd>{report.source_algorithm}</dd><dt>格式 / 来源</dt><dd>{report.format} · {report.origin}</dd><dt>模型状态</dt><dd>{report.model_status} · {report.model_reason||'—'}</dd><dt>输入 SHA-256</dt><dd>{report.input_snapshot_hash||'未提供'}</dd>{report.prompt_sha256&&<><dt>Prompt SHA-256</dt><dd>{report.prompt_sha256}</dd></>}{report.hgt_sha256&&<><dt>HGT SHA-256</dt><dd>{report.hgt_sha256}</dd></>}</dl>{report.input_evidence_id&&<button className="text-button" onClick={()=>open(report.input_evidence_id!)}>输入快照</button>}{report.prompt_evidence_id&&<button className="text-button" onClick={()=>open(report.prompt_evidence_id!)}>实际发送内容</button>}<button className="text-button" onClick={()=>open(report.raw_evidence_id)}>原始报告 / HGT 输出</button>{report.graph&&<GraphPanel graph={report.graph}/>}{(report.provenance||report.usage)&&<details><summary>Provenance / Usage JSON</summary><pre>{pretty({provenance:report.provenance,usage:report.usage})}</pre></details>}</details>)}</details><details className="technical-group"><summary>运行元数据与原始文件</summary><Overview run={run}/></details></div>;
}

function GraphPanel({graph}: {graph:Diagnosis['graph']}) {
  if(!graph)return <section className="panel graph-empty"><GitBranch size={25}/><h3>来源未提供轨迹图</h3><p>旧版报告可以通过事件引用追溯证据。</p></section>;
  const nodes=(graph.macro_nodes||[]).slice(0,8);
  return <section className="panel graph-panel"><h3>轨迹结构图</h3><p>阶段节点 · 关系不等于因果</p><div className="graph-flow">{nodes.map((node,i)=><React.Fragment key={i}><div><span>{String(i+1).padStart(2,'0')}</span>{pretty(node.label||node.title||node.phase||node.id||'节点')}</div></React.Fragment>)}</div><p className="muted">节点按源文件顺序排列，不推断连接关系。</p><details><summary>查看原始节点与关系</summary><pre>{pretty(graph)}</pre></details></section>;
}

function Overview({run}: {run:Run}) {
  const open=useContext(EvidenceContext);
  return <div className="overview-grid"><section className="panel"><h2>运行元数据</h2><dl><div><dt>轮次来源</dt><dd>{run.origin==='live'?'采集会话':'导入清单'}：第 {run.attempt_index} 轮</dd></div><div><dt>Adapter version</dt><dd>{run.adapter_version||'未提供'}</dd></div><div><dt>原始 attempt</dt><dd className="mono">{pretty(run.raw_attempts)}</dd></div><div><dt>历史报告 ok</dt><dd className="mono">{pretty(run.report_ok)}</dd></div><div><dt>采集调用数</dt><dd>{run.tool_call_count} · 包含不同采集层级</dd></div><div><dt>精确调用配对</dt><dd>{run.confirmed_pairs}</dd></div><div><dt>干预事件</dt><dd>{run.intervention_count}</dd></div><div><dt>输入快照 SHA-256</dt><dd className="hash-text">{run.snapshot_hash||'采集尚未完整，暂未生成快照'}</dd></div></dl></section><section className="panel"><h2>原始文件</h2>{run.origin==='live'&&<p className="muted">现场事件逐条保存，可从执行轨迹打开原始接收证据。</p>}<div className="artifact-list">{run.artifacts.map(a=><div key={a.filename}><FileJson size={20}/><div><strong>{a.filename}</strong><small>{a.kind}</small><code>{a.sha256}</code></div></div>)}</div>{run.feedback&&<div className="feedback"><h3>本轮历史反馈</h3><p>文件存在不等于已经验证注入。</p><button className="text-button" onClick={()=>open(run.feedback!.evidence_id)}>查看反馈文件<ArrowUpRight size={14}/></button></div>}</section></div>;
}

function ComparePage() {
  const {taskId}=useParams();const location=useLocation();const {data:task,error,loading}=useData<Task>('/tasks/'+taskId);
  const [invalidSelection,setInvalidSelection]=useState(false);
  const [left,setLeft]=useState('');const [right,setRight]=useState('');
  useEffect(()=>{if(task){
    const params=new URLSearchParams(location.search),requestedLeft=params.get('left'),requestedRight=params.get('right');
    const valid=requestedLeft!==requestedRight&&task.runs.some(run=>run.run_id===requestedLeft)&&task.runs.some(run=>run.run_id===requestedRight);
    setInvalidSelection(!!(requestedLeft||requestedRight)&&!valid);
    setLeft(valid?requestedLeft!:task.runs[0]?.run_id||'');setRight(valid?requestedRight!:task.runs.at(-1)?.run_id||'');
  }},[task,location.search]);
  if(loading)return <Loading/>;if(error||!task)return <ErrorBox text={error}/>;
  const a=task.runs.find(run=>run.run_id===left),b=task.runs.find(run=>run.run_id===right);
  return <><Back to={'/tasks/'+task.id}>返回任务历程</Back><div className="page-heading compact"><div><h1>比较两次运行</h1><p>{task.goal}</p></div></div>
    <div className="compare-selectors">{[[left,setLeft],[right,setRight]].map(([value,setter],index)=><label key={index}><span>{index===0?'基准运行':'对照运行'}</span><select aria-label={index===0?'基准运行':'对照运行'} value={value as string} onChange={event=>{setInvalidSelection(false);(setter as (value:string)=>void)(event.target.value);}}>{task.runs.map(run=><option key={run.run_id} value={run.run_id}>第 {run.attempt_index} 次 · {new Date(run.created_at).toLocaleString('zh-CN')}</option>)}</select></label>)}</div>
    {invalidSelection&&<div className="notice">链接中的运行选择无效，已显示本任务的首末运行。</div>}
    {task.runs.length<2&&<div className="notice">需要两次不同运行才能对比。请返回任务历程查看已有记录。</div>}
    {task.runs.length>=2&&left===right&&<div className="notice">当前选择了同一次运行，请选择不同轮次。</div>}
    {a&&b&&left!==right&&<><section className="panel comparison"><table><thead><tr><th>可核对的事实</th><th>第 {a.attempt_index} 次运行</th><th>第 {b.attempt_index} 次运行</th></tr></thead><tbody><tr><td>任务验收</td><td>{outcomeNames[a.outcome_status]}</td><td>{outcomeNames[b.outcome_status]}</td></tr><tr><td>执行状态</td><td>{executionNames[a.execution_status]}</td><td>{executionNames[b.execution_status]}</td></tr><tr><td>诊断进度</td><td><DiagnosisLabel run={a}/></td><td><DiagnosisLabel run={b}/></td></tr><tr><td>失败线索</td><td>{a.insight?.failure_signals.length||0} 条</td><td>{b.insight?.failure_signals.length||0} 条</td></tr></tbody></table><div className="notice">前后变化是记录到的事实；仅凭轮次顺序不能证明 RCA 假设或干预导致后一次结果。</div><details className="compare-technical"><summary>查看辅助计数</summary><table><thead><tr><th>维度</th><th>第 {a.attempt_index} 次</th><th>第 {b.attempt_index} 次</th></tr></thead><tbody>{[['原始事件',a.event_count,b.event_count],['采集工具调用',a.tool_call_count,b.tool_call_count],['失败工具返回',a.failed_tool_count,b.failed_tool_count]].map(([label,av,bv])=><tr key={label}><td>{label}</td><td>{av}</td><td>{bv}</td></tr>)}</tbody></table></details></section><div className="compare-columns"><CompareDetail run={a}/><CompareDetail run={b}/></div></>}
  </>;
}
function CompareDetail({run}: {run:Run}) {
  const open=useContext(EvidenceContext);const report=run.insight?.diagnosis.featured_report;
  return <section className="panel"><div className="section-heading"><h3>第 {run.attempt_index} 次运行</h3><Link className="text-button" to={'/runs/'+run.run_id}>查看运行详情<ArrowUpRight size={14}/></Link></div><div className="compare-detail-body"><SourceLabels run={run}/><p><strong>验收：</strong>{outcomeNames[run.outcome_status]} · <strong>执行：</strong>{executionNames[run.execution_status]}</p><h4>失败事实</h4>{run.insight?.failure_signals.length?run.insight.failure_signals.map((signal,index)=><div className="compare-signal" key={index}><span>{signal.title}</span>{signal.evidence_id&&<button className="text-button" onClick={()=>open(signal.evidence_id!)}>证据</button>}</div>):<p className="muted">未记录明确失败线索。</p>}<h4>诊断</h4><p><DiagnosisLabel run={run}/>{report&&<> · {report.summary}</>}</p></div></section>;
}

function ImportsPage() {
  const [refresh,setRefresh]=useState(0);const {data:history,error:historyError}=useData<ImportResult[]>('/imports',refresh);
  const [manifest,setManifest]=useState<File|null>(null);const [files,setFiles]=useState<File[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [result,setResult]=useState<ImportResult|null>(null);
  async function submit(e:React.FormEvent) {
    e.preventDefault();if(!manifest||!files.length)return;setBusy(true);setError('');setResult(null);
    try {const body=new FormData();body.append('manifest',manifest);files.forEach(file=>body.append('files',file));setResult(await api<ImportResult>('/imports',{method:'POST',body}));setRefresh(x=>x+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <><div className="page-heading"><div><h1>导入记录</h1><p>导入原始 JSONL、历史诊断与验收文件，保留每条结论的出处。</p></div><span className="version-chip">IMPORT / 01</span></div>
    <div className="import-layout"><form className="panel import-form" onSubmit={submit}><h2>导入任务记录</h2><p className="muted">所有文件仅保存在当前本地工作区。</p><label className="file-picker"><span className="step-label">01 · 导入清单</span><strong><FileJson size={20}/>{manifest?.name||'选择 manifest.json'}</strong><span>声明任务、轮次以及各轮引用的文件名</span><input aria-label="导入清单" type="file" accept=".json" onChange={e=>{setManifest(e.target.files?.[0]||null);setResult(null);}}/></label><label className="file-picker secondary"><span className="step-label">02 · 数据文件</span><strong><Upload size={21}/>{files.length?`已选择 ${files.length} 个文件`:'选择轨迹、报告和验收文件'}</strong><span>JSONL / JSON / Markdown · 单文件不超过 10 MiB</span><input aria-label="数据文件" type="file" multiple accept=".json,.jsonl,.md,.txt" onChange={e=>{setFiles(Array.from(e.target.files||[]));setResult(null);}}/></label>{files.length>0&&<div className="selected-files">{files.map(file=><span key={file.name}><FileText size={12}/>{file.name}</span>)}</div>}{error&&<ErrorBox text={error}/>}<button className="button primary wide" disabled={!manifest||!files.length||busy}>{busy?<Loader2 className="spin" size={17}/>:<ArrowDownToLine size={17}/>} {busy?'校验并导入中…':'校验并导入'}</button>
        {result&&<div className="import-success" role="status"><CheckCircle2 size={21}/><div><strong>{result.duplicate?'记录已存在，未重复导入':'导入完成'}</strong><p>{result.run_ids.length} 轮执行 · {result.warnings.length} 项数据提示</p><Link to={result.run_ids.length===1?'/runs/'+result.run_ids[0]:'/tasks/'+result.task_id}>{result.run_ids.length===1?'打开运行':'打开任务'}<ArrowRight size={14}/></Link></div></div>}
    </form><aside><section className="panel import-guide"><h3>把任务与轮次说清楚。</h3><ol><li><strong>一份清单，对应一个任务</strong><p>每轮指定独立 run_key 和 attempt_index。</p></li><li><strong>原件保留，语义分开</strong><p>执行状态、模型状态与验收结果分别记录。</p></li><li><strong>重复导入不会生成副本</strong><p>同一轮内容变化将被拒绝，避免覆盖历史。</p></li></ol><a className="text-button" href="/api/contracts/import-manifest" target="_blank" rel="noreferrer">查看清单 JSON Schema<ArrowUpRight size={14}/></a></section><div className="notice">上传清单引用的文件即可。不要上传密钥、模型权重或本机 provenance.local.json。</div></aside></div>
    <section className="panel import-history"><div className="section-heading"><h2>最近导入</h2><span className="muted">最多显示 100 次</span></div>{historyError?<ErrorBox text={historyError}/>:history?.length?history.map(item=><div className="import-history-row" key={item.import_id}><CheckCircle2 size={19}/><div><Link to={'/tasks/'+item.task_id}>{item.manifest.task_id}</Link><small>{item.run_ids.length} 轮执行 · {new Date(item.created_at).toLocaleString('zh-CN')}</small></div><SourceBadge kind={item.manifest.sample_kind}/><Link aria-label="查看导入任务" to={'/tasks/'+item.task_id}><ArrowUpRight size={17}/></Link></div>):<Empty title="还没有导入记录"/>}</section>
  </>;
}

function SystemPage() {
  const {data,error,loading}=useData<{version:string;status:string}>('/health');
  const {data:caps}=useData<Capabilities>('/diagnosis/capabilities');
  return <><div className="page-heading"><div><h1>运行环境</h1><p>明确当前可用能力，区分历史记录与实际算法运行。</p></div><Database size={35} className="heading-symbol"/></div>{error&&<ErrorBox text={error}/>}<div className="system-grid"><section className="panel"><Database size={25}/><h2>本地实时与历史工作台</h2><Badge status={data?'passed':'unknown'}>{loading?'连接中':data?'API 已连接':'API 未连接'}</Badge><dl><div><dt>平台版本</dt><dd>{data?.version||'—'}</dd></div><div><dt>存储</dt><dd>SQLite · 本地事务存储</dd></div><div><dt>支持格式</dt><dd>PROBE 旧版 / 增强版历史记录</dd></div></dl></section><section className="panel"><Blocks size={25}/><h2>实际诊断引擎</h2><Badge status={caps?.hgt==='ready'?'passed':'unknown'}>{caps?.hgt==='ready'?(caps?.analyst==='unconfigured'?'HGT 可用 · RCA 未配置':'HGT 可用 · RCA 可手动运行'):'HGT 尚未就绪'}</Badge><p>{caps?.reason||'正在检查隔离环境'}。导入历史报告不会触发新的推理。</p></section><section className="panel"><ShieldCheck size={25}/><h2>现场采集</h2><Badge status="passed">Python SDK + CLI</Badge><p>V0.2 支持 Python 工具包装、进程日志和 SSE 实时展示，可记录独立检查证据。自动修复与重试留待后续。</p></section></div></>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><Shell/></BrowserRouter></React.StrictMode>);
