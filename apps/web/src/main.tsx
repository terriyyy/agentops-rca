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
import {useData} from './read-data';
import {RunComparison} from './run-comparison';
import {ImportsPage,SystemPage} from './onboarding-pages';
import './experience-finish.css';
import {StatusGuide} from './status-guide';
import {Brand} from './brand';
import {ModelSettingsPage} from './model-settings';

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
  const [refresh,setRefresh]=useState(0);
  const {data,error,loading}=useData<Evidence>('/evidence/'+id,refresh);
  const [formatted,setFormatted]=useState(true);
  let displayValue=data?.content;
  if(formatted&&typeof displayValue==='string'){try{displayValue=JSON.parse(displayValue.replace(/^\uFEFF/,''));}catch{/* Plain text is displayed unchanged. */}}
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;const node=dialog.current;node?.showModal();return()=>{node?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[]);
  return <dialog ref={dialog} className={'evidence-dialog'+(investigation?' investigation-evidence':'')} aria-label="原始证据" onCancel={event=>{event.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="drawer-title"><div><span className="eyebrow">原始记录</span><h2>原始证据</h2></div><button className="icon-button" aria-label="关闭证据" onClick={close}><X size={22}/></button></div>
    {loading ? <Loading/> : error ? <><ErrorBox text={error}/><button className="button" onClick={()=>setRefresh(value=>value+1)}>重试读取证据</button></> : data && <>
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
  const section=location.pathname.startsWith('/settings/models')?'模型连接':location.pathname.startsWith('/imports')?'数据导入':location.pathname.startsWith('/system')?'运行环境':location.pathname.startsWith('/tasks')?'任务历程':location.pathname.startsWith('/runs')?'运行详情':'运行工作台';
  return <RunViewContext.Provider value={view}><EvidenceContext.Provider value={setEvidence}><div className={"app-shell"+(isRun?" run-shell":"")+(isRun&&view.focus?" run-focus":"")}>
    <aside className="sidebar" hidden={isRun&&view.focus}><Brand/>
      <div className="workspace-label"><div className="workspace-avatar">A</div><div>本地工作区<small>任务与诊断</small></div><span className="workspace-dot"/></div>
      <nav><NavLink to="/" end aria-label="运行工作台"><Activity size={18}/><span className="nav-text">运行工作台</span></NavLink><NavLink to="/tasks" aria-label="任务历程"><Layers3 size={18}/><span className="nav-text">任务历程</span></NavLink><NavLink to="/imports" aria-label="数据导入"><ArrowDownToLine size={18}/><span className="nav-text">数据导入</span></NavLink><NavLink to="/system" aria-label="运行环境"><Settings2 size={18}/><span className="nav-text">运行环境</span></NavLink></nav>
<div className="sidebar-foot"><span className={`connection-dot ${health.error?'offline':''}`}/><span>{health.error?'API 未连接':health.loading?'正在连接…':'本地 API 已连接'}</span><code>{health.data?.version?'v'+health.data.version:'—'}</code></div>
    </aside>
    <div className="workspace-main"><header className="topbar"><div><span>AgentOps</span><ChevronRight size={14}/><strong>{section}</strong></div><div><StatusGuide/><span className="local-pill" title="当前工作区数据保存在本地后端"><Database size={13} aria-hidden="true"/>本地工作区</span></div></header>
      <main><Routes><Route path="/" element={<HomePage/>}/><Route path="/tasks" element={<TasksPage/>}/><Route path="/tasks/:taskId" element={<TaskPage/>}/><Route path="/tasks/:taskId/compare" element={<ComparePage/>}/><Route path="/runs/:runId" element={<RunPage/>}/><Route path="/imports" element={<ImportsPage/>}/><Route path="/system" element={<SystemPage/>}/><Route path="/settings/models" element={<ModelSettingsPage/>}/><Route path="*" element={<Empty title="页面不存在"><Link to="/">返回运行工作台</Link></Empty>}/></Routes></main>
      <footer>AGENTOPS / RCA <span>实时与历史工作台 · 所有验收结果保留来源</span></footer>
    </div>{evidence&&<EvidenceDrawer id={evidence} close={()=>setEvidence(null)} investigation={location.pathname.startsWith('/runs/')}/>}</div></EvidenceContext.Provider></RunViewContext.Provider>;
}

function HomePage() {
  const location=useLocation();
  const [refresh,setRefresh]=useState(0),[start,setStart]=useState(()=>new URLSearchParams(location.search).get('start')==='monitor');
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
  function closeStart(){setStart(false);if(new URLSearchParams(location.search).has('start'))navigate({pathname:'/',search:''},{replace:true});}
  useEffect(()=>{if(new URLSearchParams(location.search).get('start')==='monitor')setStart(true);},[location.search]);
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
    {start&&<MonitorStart close={closeStart} demo={demo} busy={busy} error={actionError}/>}
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
  return <div className="technical-panel"><DiagnosisJobHistory jobs={analysis.jobs} onEvidence={open}/><details className="technical-group"><summary>报告来源与模型记录 {data?.length?`· ${data.length} 份报告`:''}</summary>{error&&<ErrorBox text={error}/>}<p className="muted">当前配置模型：{capabilities?.model||'未配置'}。下方模型记录属于报告生成时的配置。<Link to="/settings/models">管理模型连接</Link></p>{data?.map(report=>{
    const metadata=report.provenance&&typeof report.provenance==='object'?report.provenance as Record<string,unknown>:{};
    return <details className="technical-report" key={report.diagnosis_id}>
      <summary><span className="technical-report-title">{report.mode==='analyst_rca'?'模型原因分析':report.origin==='recomputed'?'本机异常定位':'历史分析'}<small>{report.created_at?new Date(report.created_at).toLocaleString('zh-CN'):'来源未提供时间'}</small></span></summary>
      <div className="technical-report-model"><span>报告模型</span><strong>{typeof metadata.model_requested==='string'?metadata.model_requested:report.mode==='analyst_rca'?'来源未提供':'本机定位 / 无分析模型调用'}</strong></div>
      {report.input_evidence_id&&<button className="text-button" onClick={()=>open(report.input_evidence_id!)}>输入快照</button>}{report.prompt_evidence_id&&<button className="text-button" onClick={()=>open(report.prompt_evidence_id!)}>实际发送内容</button>}<button className="text-button" onClick={()=>open(report.raw_evidence_id)}>原始报告</button>
      <details className="technical-metadata"><summary>算法版本、校验与原始元数据</summary><dl className="event-facts"><dt>算法</dt><dd>{report.source_algorithm}</dd><dt>格式 / 来源</dt><dd>{report.format} · {report.origin}</dd><dt>模型状态</dt><dd>{report.model_status} · {report.model_reason||'—'}</dd><dt>输入 SHA-256</dt><dd>{report.input_snapshot_hash||'未提供'}</dd>{report.prompt_sha256&&<><dt>Prompt SHA-256</dt><dd>{report.prompt_sha256}</dd></>}{report.hgt_sha256&&<><dt>HGT SHA-256</dt><dd>{report.hgt_sha256}</dd></>}</dl>
      {report.graph&&<details><summary>轨迹结构与原始节点</summary><GraphPanel graph={report.graph}/></details>}{(report.provenance||report.usage)&&<details><summary>来源与用量 JSON</summary><pre>{pretty({provenance:report.provenance,usage:report.usage})}</pre></details>}</details>
    </details>;
  })}</details><details className="technical-group"><summary>运行元数据与原始文件</summary><Overview run={run}/></details></div>;
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
  const {taskId}=useParams(),open=useContext(EvidenceContext);
  const [refresh,setRefresh]=useState(0);
  const {data:task,error,loading}=useData<Task>('/tasks/'+taskId,refresh);
  if(loading&&!task)return <Loading/>;
  if(!task)return <div><Back to="/tasks">返回任务历程</Back><ErrorBox text={error}/><button className="button" onClick={()=>setRefresh(v=>v+1)}>重试</button></div>;
  return <RunComparison key={task.id} task={task} error={error} onRefresh={()=>setRefresh(v=>v+1)} renderSource={run=><SourceLabels run={run}/>} onEvidence={open}/>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><Shell/></BrowserRouter></React.StrictMode>);
