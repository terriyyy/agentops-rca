import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Blocks, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock3, Code2, Database, FileJson, FileSearch, FileText, FlaskConical, GitCompareArrows, GitBranch, Layers3, ListFilter, Loader2, Plus, Search, Settings2, ShieldCheck, Terminal, Upload, X } from 'lucide-react';
import { api, pretty, outcomeNames, executionNames, diagnosisNames, attentionNames, modelNames, warningNames, type Diagnosis, type Evidence, type ImportResult, type Outcome, type Run, type Task, type TraceEvent, type WorkbenchOverview } from './api';
import './styles.css';
import { useLiveRun } from './live';
import { DiagnosisControls, type Capabilities } from './diagnosis';

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
  const health=useData<{version:string;status:string}>('/health');
  useEffect(()=>{setEvidence(null);window.scrollTo(0,0);},[location.pathname]);
  const section=location.pathname.startsWith('/imports')?'数据导入':location.pathname.startsWith('/system')?'运行环境':location.pathname.startsWith('/tasks')?'任务历程':location.pathname.startsWith('/runs')?'运行详情':'运行工作台';
  return <EvidenceContext.Provider value={setEvidence}><div className="app-shell">
    <aside className="sidebar"><Link to="/" className="brand"><div className="brand-mark"><GitBranch size={22}/></div><span>agentops<span className="brand-suffix"> / RCA</span></span></Link>
      <div className="workspace-label"><div className="workspace-avatar">A</div><div>本地工作区<small>任务与诊断</small></div><span className="workspace-dot"/></div>
      <nav><NavLink to="/" end aria-label="运行工作台"><Activity size={18}/><span className="nav-text">运行工作台</span></NavLink><NavLink to="/tasks" aria-label="任务历程"><Layers3 size={18}/><span className="nav-text">任务历程</span></NavLink><NavLink to="/imports" aria-label="数据导入"><ArrowDownToLine size={18}/><span className="nav-text">数据导入</span></NavLink><NavLink to="/system" aria-label="运行环境"><Settings2 size={18}/><span className="nav-text">运行环境</span></NavLink></nav>
<div className="sidebar-foot"><span className={`connection-dot ${health.error?'offline':''}`}/><span>{health.error?'API 未连接':health.loading?'正在连接…':'本地 API 已连接'}</span><code>v{health.data?.version||'0.1'}</code></div>
    </aside>
    <div className="workspace-main"><header className="topbar"><div><span>AgentOps</span><ChevronRight size={14}/><strong>{section}</strong></div><div><span className="local-pill"><Database size={13}/> LOCAL</span><span className="avatar">研</span></div></header>
      <main><Routes><Route path="/" element={<HomePage/>}/><Route path="/tasks" element={<TasksPage/>}/><Route path="/tasks/:taskId" element={<TaskPage/>}/><Route path="/tasks/:taskId/compare" element={<ComparePage/>}/><Route path="/runs/:runId" element={<RunPage/>}/><Route path="/imports" element={<ImportsPage/>}/><Route path="/system" element={<SystemPage/>}/><Route path="*" element={<Empty title="页面不存在"><Link to="/">返回运行工作台</Link></Empty>}/></Routes></main>
      <footer>AGENTOPS / RCA <span>实时与历史工作台 · 所有验收结果保留来源</span></footer>
    </div>{evidence&&<EvidenceDrawer id={evidence} close={()=>setEvidence(null)} investigation={location.pathname.startsWith('/runs/')}/>}</div></EvidenceContext.Provider>;
}

function HomeRun({run}: {run:Run}) {
  return <Link className="workbench-run" to={'/runs/'+run.run_id}>
    <div className="workbench-run-main"><strong>{run.task_goal||run.task_external_id||run.external_run_id}</strong><span>第 {run.attempt_index} 次运行 · {new Date(run.created_at).toLocaleString('zh-CN')}</span></div>
    <SourceLabels run={run}/>
    <div className="workbench-run-states"><span>执行：{executionNames[run.execution_status]||'未知'}</span><span>验收：{outcomeNames[run.outcome_status]||'未知'}</span><span>诊断：<DiagnosisLabel run={run}/></span></div>
    {!!run.insight?.attention_reasons.length&&<div className="workbench-reasons">{run.insight.attention_reasons.map(reason=><span key={reason}>{attentionNames[reason]||reason}</span>)}</div>}
    {run.origin==='live'&&run.execution_status==='running'&&<small>采集器：{run.capture_status==='connected'?'在线':run.capture_status==='disconnected'?'失联，执行状态未确认':'连接中'} · 数据：{run.capture_integrity==='pending'?'接收中':run.capture_integrity||'未知'}</small>}
    <ArrowUpRight size={17}/>
  </Link>;
}

function HomeSection({title,description,runs,empty}: {title:string;description:string;runs:Run[];empty:string}) {
  return <section className="panel workbench-section"><div className="section-heading"><div><h2>{title} <span className="counter">{runs.length}</span></h2><p>{description}</p></div></div>
    {runs.length?<div>{runs.map(run=><HomeRun key={run.run_id} run={run}/>)}</div>:<p className="workbench-empty">{empty}</p>}
  </section>;
}

function HomePage() {
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  const {data,error,loading}=useData<WorkbenchOverview>('/overview?limit=20',refresh);
  const [busy,setBusy]=useState(false);const [actionError,setActionError]=useState('');const [copied,setCopied]=useState(false);
  const navigate=useNavigate();
  const command='.\\.venv\\Scripts\\agentops.exe run --goal "任务目标" -- .\\.venv\\Scripts\\python.exe your_agent.py';
  async function demo(){setBusy(true);setActionError('');try{const result=await api<ImportResult>('/examples/import',{method:'POST'});navigate('/runs/'+result.run_ids[0]);}catch(e){setActionError((e as Error).message);}finally{setBusy(false);}}
  async function copy(){try{await navigator.clipboard.writeText(command);setCopied(true);}catch{setActionError('复制失败；可直接选中命令复制。');}}
  return <>
    <div className="page-heading"><div><h1>运行工作台</h1><p>从一次 Agent 运行开始，观察执行、调查失败，并核对独立验收。</p></div><Link className="button" to="/tasks">查看任务历程<ArrowUpRight size={16}/></Link></div>
    <section className="panel start-panel"><div><span className="eyebrow">开始实时监控</span><h2>在终端启动你的 Agent，打开返回的 Run 链接。</h2><p>平台服务启动后，在另一个终端于项目根目录运行。Agent 仍在本机执行；网页接收运行记录，不替你执行上传的命令。</p><div className="command-line"><code>{command}</code><button className="button" onClick={copy}>{copied?'已复制':'复制命令'}</button></div><p>已有 Python 工具函数可接入 <code>@tool</code> 以记录工具调用；没有独立检查证据时，任务验收保持“未知”。</p></div><div className="start-demo"><strong>先看一份演示记录</strong><p>导入明确标为演示样例的两轮历史数据，直接打开失败运行。演示结果不代表真实诊断效果。</p><button className="button" onClick={demo} disabled={busy}>{busy?'正在载入…':'载入演示样例'}</button><Link className="text-button" to="/imports">导入历史记录<ArrowUpRight size={14}/></Link></div></section>
    {actionError&&<ErrorBox text={actionError}/>}
    {error&&<ErrorBox text={error}/>}
    {loading&&!data?<Loading/>:data&&<div className="workbench-sections">
      <HomeSection title="正在运行" description="打开运行后可实时查看采集到的步骤。" runs={data.running} empty="当前没有正在运行的 Agent；可按上方命令开始一次运行。"/>
      <HomeSection title="需要处理" description="执行异常、验收未通过、采集不完整或诊断作业失败的运行。" runs={data.attention} empty="目前没有需要处理的问题运行。验收未知仍会保留在运行记录中。"/>
      <HomeSection title="其他最近运行" description="已在上方出现的运行不重复列出。" runs={data.recent} empty="暂无其他运行记录。"/>
    </div>}
  </>;
}

function TasksPage() {
  const {data:tasks,error,loading}=useData<Task[]>('/tasks');
  const [query,setQuery]=useState('');
  const visible=(tasks||[]).filter(task=>(task.external_id+' '+task.goal).toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-heading"><div><h1>任务历程</h1><p>一个任务目标可以有多次运行；每一轮的执行、诊断和验收分别保留。</p></div><Link className="button" to="/">返回运行工作台</Link></div>
    <section className="panel task-panel"><div className="section-heading"><div><h2>全部任务 <span className="counter">{tasks?.length||0}</span></h2><p>从任务进入多轮历史；调查具体问题请打开对应运行。</p></div></div>
      <div className="table-toolbar"><label className="search-box"><Search size={17}/><input aria-label="搜索任务" placeholder="搜索任务 ID 或目标…" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>
      {loading?<Loading/>:error?<ErrorBox text={error}/>:!visible.length?<Empty title={tasks?.length?'没有匹配的任务':'还没有任务'}>{tasks?.length?'尝试其他关键词。':<>先从<Link to="/">运行工作台</Link>开始实时监控，或导入历史记录。</>}</Empty>:<div className="table-scroll"><table className="tasks-table"><thead><tr><th>任务目标／来源</th><th>运行次数</th><th>最新一次执行</th><th>最新任务验收</th><th/></tr></thead><tbody>{visible.map(task=>{const latest=task.runs.at(-1);return <tr key={task.id}><td><Link className="task-link" to={'/tasks/'+task.id}><div className="task-icon"><Code2 size={19}/></div><div><strong>{task.goal}</strong><small>{latest&&<SourceLabels run={latest}/>} · {task.external_id}</small></div></Link></td><td>{task.runs.length} 次</td><td>{latest?executionNames[latest.execution_status]:'尚无运行'}</td><td><Badge status={task.outcome_status}/></td><td><Link className="row-arrow" aria-label={'打开任务 '+task.external_id} to={'/tasks/'+task.id}><ArrowUpRight size={19}/></Link></td></tr>})}</tbody></table></div>}
      <div className="table-foot"><span>{visible.length} 条任务</span><span><ShieldCheck size={13}/>此处验收是最新一轮结果</span></div>
    </section>
  </>;
}

function Back({to,children}: {to:string;children:React.ReactNode}) {return <Link className="back-link" to={to}><ArrowLeft size={14}/>{children}</Link>;}
function RunCard({run}: {run:Run}) {
  return <Link className="run-card" to={'/runs/'+run.run_id}><div className="run-card-top"><span className="run-number">第 {run.attempt_index} 次运行</span><SourceLabels run={run}/></div><h3>{new Date(run.created_at).toLocaleString('zh-CN')} <ArrowUpRight size={16}/></h3><div className="run-card-facts"><div><span>执行状态</span><strong>{executionNames[run.execution_status]}</strong></div><div><span>任务验收</span><strong>{outcomeNames[run.outcome_status]}</strong></div><div><span>诊断进度</span><strong><DiagnosisLabel run={run}/></strong></div></div><div className="run-card-foot"><span>{formatNumber(run.event_count)} 条事件</span><span>{run.insight?.attention_reasons.length?run.insight.attention_reasons.map(reason=>attentionNames[reason]||reason).join(' · '):'查看这次运行'}</span></div></Link>;
}
function TaskPage() {
  const {taskId}=useParams();const [refresh,setRefresh]=useState(0);const [copied,setCopied]=useState(false);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  const {data:task,error,loading}=useData<Task>('/tasks/'+taskId,refresh);
  if(loading)return <Loading/>;if(error||!task)return <ErrorBox text={error}/>;
  const first=task.runs[0],latest=task.runs.at(-1);
  return <><Back to="/tasks">全部任务</Back><div className="page-heading compact"><div><div className="eyebrow">同一目标的运行历程</div><h1>{task.goal}</h1><p>已记录 {task.runs.length} 次运行；每轮执行、诊断和验收各自保留。</p></div>{task.runs.length>1&&<Link className="button" to={'/tasks/'+task.id+'/compare'}><GitCompareArrows size={17}/>比较两次运行</Link>}</div>
    {first&&latest&&task.runs.length>1&&<section className="panel task-change"><h2>从第 {first.attempt_index} 次到第 {latest.attempt_index} 次</h2><p>任务验收：{outcomeNames[first.outcome_status]} → {outcomeNames[latest.outcome_status]}；执行状态：{executionNames[first.execution_status]} → {executionNames[latest.execution_status]}。</p><small>这里只陈述记录到的变化，不证明诊断或干预导致了后一次结果。</small></section>}
    <div className="section-heading standalone"><div><h2>运行历程</h2><p>打开某一轮，查看事实、失败线索、根因假设与独立验收。</p></div></div>
    <div className="run-grid">{task.runs.map(run=><RunCard key={run.run_id} run={run}/>)}</div>
    {task.namespace==='live'?<section className="panel continue-task"><h2>在同一任务下再次运行</h2><p>在本机终端启动 Agent 时传入以下任务 ID，并保持原任务目标和样例类型一致。平台不会自动执行命令，也不会按名称猜测两轮的关系。</p><div className="command-line"><code>--task-id {task.id}</code><button className="button" onClick={async()=>{try{await navigator.clipboard.writeText(task.id);setCopied(true);}catch{setCopied(false);}}}>{copied?'已复制任务 ID':'复制任务 ID'}</button></div><p>需要把此参数加入原来的 <code>agentops run</code> 命令；目标及样例类型必须与本任务相同。</p></section>:<section className="panel continue-task"><h2>历史任务的归组</h2><p>这些轮次由导入清单明确归组。后续现场运行默认创建新任务；只有确认目标和样例性质完全相同时，才应显式关联已有任务 ID。平台不会按名称自动合并。</p></section>}
    <details className="panel task-technical"><summary>查看任务来源与归组详情</summary><dl><div><dt>任务 ID</dt><dd className="mono">{task.id}</dd></div><div><dt>来源命名空间</dt><dd>{task.namespace}</dd></div><div><dt>原始任务标识</dt><dd>{task.external_id}</dd></div><div><dt>轮次依据</dt><dd>{task.namespace==='live'?'明确的任务 ID 与启动时分配的轮次':'导入清单给出的轮次；原始 attempt 另行保存'}</dd></div></dl></details>
  </>;
}

function FailureEvidence({run}: {run:Run}) {
  const open=useContext(EvidenceContext);
  const signals=run.insight?.failure_signals||[];
  const primary=signals.find(signal=>signal.kind==='event'&&signal.evidence_id)||signals.find(signal=>signal.kind==='outcome')||signals[0];
  const remaining=signals.filter(signal=>signal!==primary);
  return <section className="journey-step failure-section" id="failure-evidence"><div className="journey-heading"><span>调查入口</span><div><h2>失败事实与证据</h2><p>仅展示已记录的异常和未通过检查；线索本身不是根因。</p></div></div>
    {primary?<div className="failure-focus"><div className="failure-focus-label"><span className="failure-pulse"/>优先核查的线索 <small>{primary.kind==='outcome'?'独立验收':primary.kind==='execution'?'进程结果':'执行步骤'}</small></div><div className="failure-focus-main"><div><strong>{primary.error_signature||primary.title}</strong>{primary.error_signature&&<p>步骤：{primary.title}</p>}</div>{primary.evidence_id?<button className="button" onClick={()=>open(primary.evidence_id!)}>查看原始证据<ArrowUpRight size={15}/></button>:<a className="text-button" href="#trace-preview">查看相邻步骤<ArrowUpRight size={14}/></a>}</div><p>这是当前记录中可优先核查的事实，不表示平台已确认根因。</p></div>:<div className="journey-empty failure-neutral">{run.execution_status==='running'?'运行仍在进行；目前尚无明确失败线索。':run.outcome_status==='unknown'?'尚无明确失败线索，任务验收也缺少独立证据。':'本轮未记录可定位的失败步骤。'}</div>}
    {!!remaining.length&&<div className="signal-list"><div className="signal-list-heading">其他已记录线索 <span>{remaining.length}</span></div>{remaining.map((signal,index)=><div className="signal-row" key={(signal.event_id||signal.kind)+index}><div><strong>{signal.title}</strong>{signal.error_signature&&<p>{signal.error_signature}</p>}<small>{signal.kind==='outcome'?'独立验收记录':signal.kind==='execution'?'进程结果':'执行事件'}</small></div>{signal.evidence_id?<button className="text-button" onClick={()=>open(signal.evidence_id!)}>查看原始证据<ArrowUpRight size={14}/></button>:<span className="muted">{signal.kind==='execution'?'可在轨迹中检查':'没有可定位的原始引用'}</span>}</div>)}</div>}
    {run.origin==='live'&&run.execution_status!=='running'&&run.capture_integrity!=='complete'&&<p className="notice">采集数据尚未完整，当前线索可能遗漏执行步骤。</p>}
  </section>;
}

function TracePreview({run,expanded,onToggle}: {run:Run;expanded:boolean;onToggle:()=>void}) {
  const open=useContext(EvidenceContext);
  const offset=Math.max(0,run.event_count-8);
  const {data,error,loading}=useData<{items:TraceEvent[];total:number}>('/runs/'+run.run_id+'/events?offset='+offset+'&limit=8',run.event_count);
  return <section className="trace-preview" id="trace-preview"><div className="trace-preview-heading"><div><span className="eyebrow">执行过程</span><h3>{run.execution_status==='running'?'实时步骤':'最近步骤'}</h3><p>按原始顺序展示；步骤先后不能证明因果。</p></div><span>{formatNumber(run.event_count)} 条事件</span></div>
    {error?<ErrorBox text={error}/>:loading&&!data?<Loading/>:data?.items.length?<div className="trace-preview-list">{data.items.map(event=><button className={'trace-preview-row'+(event.tool_status==='failed'||event.error_signature?' failed':'')} key={event.event_id} onClick={()=>open(event.evidence_id)}><span className="trace-preview-position">{String(event.position+1).padStart(3,'0')}</span><span className="trace-preview-name"><strong>{event.name}</strong><small>{event.kind}{event.tool_status==='failed'?' · 工具失败':''}</small></span><span className="trace-preview-output">{pretty(event.output??event.input)}</span><ArrowUpRight size={14}/></button>)}</div>:<p className="trace-preview-empty">尚无执行事件；采集到的步骤会在这里出现。</p>}
    <div className="trace-preview-foot"><span>点击步骤可核对原始记录；完整轨迹支持搜索、筛选与分页。</span><button className="button" aria-expanded={expanded} onClick={onToggle}>{expanded?'收起完整轨迹':run.execution_status==='running'?'查看实时轨迹':'查看完整轨迹'}<ArrowUpRight size={14}/></button></div>
    {expanded&&<div className="trace-full" id="full-trace"><TracePanel run={run}/></div>}
  </section>;
}

function InvestigationRail({run}: {run:Run}) {
  return <aside className="investigation-rail" aria-label="本轮调查索引"><div className="rail-inner"><span className="eyebrow">本轮调查</span><strong className="rail-outcome">{outcomeNames[run.outcome_status]||'验收未知'}</strong><span className="rail-execution">执行：{executionNames[run.execution_status]||'未知'}</span><nav aria-label="跳转到调查内容"><a href="#failure-evidence"><span>01</span>失败事实</a><a href="#trace-preview"><span>02</span>执行步骤</a><a href="#diagnosis"><span>03</span>根因假设</a><a href="#verification"><span>04</span>独立验收</a></nav><p>诊断结论需要核对证据；任务验收由独立检查决定。</p><Link to={'/tasks/'+run.task_id}>查看同一任务的运行历程 <ArrowUpRight size={13}/></Link></div></aside>;
}

function RunRelations({run}: {run:Run}) {
  const {data:task}=useData<Task>('/tasks/'+run.task_id);
  const index=task?.runs.findIndex(item=>item.run_id===run.run_id)??-1;
  const previous=index>0?task?.runs[index-1]:null;
  const next=index>=0?task?.runs[index+1]:null;
  return <section className="journey-step"><div className="journey-heading"><span>关联</span><div><h2>同一任务的其他运行</h2><p>同一目标下的轮次可比较结果；先后变化本身不能证明诊断或干预导致成功。</p></div></div><div className="panel relation-panel"><div>{previous?<Link to={'/runs/'+previous.run_id}>← 第 {previous.attempt_index} 次运行 · {outcomeNames[previous.outcome_status]}</Link>:<span className="muted">此前没有其他运行</span>}</div><Link to={'/tasks/'+run.task_id}>查看完整任务历程</Link><div>{next?<Link to={'/runs/'+next.run_id}>第 {next.attempt_index} 次运行 · {outcomeNames[next.outcome_status]} →</Link>:<span className="muted">暂无后续运行</span>}</div></div></section>;
}

function RunPage() {
  const {runId}=useParams();const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),3000);return()=>clearInterval(timer);},[]);
  const {data:initial,error,loading}=useData<Run>('/runs/'+runId,refresh);
  const {run,connection}=useLiveRun(initial);
  const [showTrace,setShowTrace]=useState(false);const [showTechnical,setShowTechnical]=useState(false);
  useEffect(()=>{setShowTrace(false);setShowTechnical(false);},[runId]);
  if(loading&&!run)return <Loading/>;if(!run)return <ErrorBox text={error}/>;
  return <div className="run-page"><Back to="/">返回运行工作台</Back><div className="page-heading compact run-page-head"><div><div className="eyebrow">运行详情 <SourceLabels run={run}/></div><h1>{run.task_goal||'Agent 运行'}</h1><p>第 {run.attempt_index} 次运行 · {new Date(run.created_at).toLocaleString('zh-CN')} · <Link to={'/tasks/'+run.task_id}>查看所属任务</Link></p></div></div>
    <section className="run-facts" aria-label="本轮状态"><div className="run-facts-intro"><span className="eyebrow">本轮事实</span><strong>执行结果与任务结果分别判断</strong></div><div className="run-status"><div><span>执行状态</span><strong>{executionNames[run.execution_status]||'未知'}</strong><small>进程退出码：{run.exit_code??'未提供'}</small></div><div className={'outcome-state '+(run.outcome_status==='failed'?'failed':'')}><span>任务验收</span><strong>{outcomeNames[run.outcome_status]||'未知'}</strong><small>独立检查；无证据则未知</small></div><div><span>诊断进度</span><strong><DiagnosisLabel run={run}/></strong><small>报告不改变验收</small></div><div><span>采集数据</span><strong>{run.origin==='live'?({pending:'接收中／待补齐',complete:'完整',partial:'不完整',unknown:'未知'} as Record<string,string>)[run.capture_integrity||'unknown']:'历史导入'}</strong><small>{run.origin==='live'?'现场采集完整性':'按来源文件核对'}</small></div></div></section>
    {run.origin==='live'&&<div className="live-monitor" role="status"><div><span className={'connection-dot '+(connection!=='connected'?'offline':'')}/><strong>{connection==='connected'?'网页实时连接':connection==='reconnecting'?'网页断线 · 正在重连':'正在建立实时连接'}</strong><span>采集器：{({connected:'在线',disconnected:'失联 · 执行状态未确认',finished:'已结束'} as Record<string,string>)[run.capture_status||'']||'连接中'}</span></div><div><span>已收到 {formatNumber(run.event_count)} 条事件</span><span>丢失告警：{run.dropped_events||0}</span></div></div>}
    {error&&<p className="notice" role="status">暂时无法刷新运行详情，正在显示已收到的记录。</p>}
    <Warnings items={run.warnings}/>
    <div className="run-workspace"><div className="run-investigation">
      <FailureEvidence run={run}/>
      <TracePreview run={run} expanded={showTrace} onToggle={()=>setShowTrace(value=>!value)}/>
      <section className="journey-step diagnosis-section" id="diagnosis"><div className="journey-heading"><span>待验证</span><div><h2>根因假设与证据</h2><p>先核对线索，再决定是否手动定位或调用模型；诊断不等于任务验收。</p></div></div>{run.execution_status==='running'?<p className="run-pending">本轮仍在执行。结束并补齐采集后，可手动发起本机定位；联网 RCA 仍须预览并确认。</p>:<DiagnosisPanel run={run}/>}</section>
      <section className="journey-step verification-section" id="verification"><div className="journey-heading"><span>独立结论</span><div><h2>独立任务验收</h2><p>仅依据有来源的检查记录判断目标是否达成；模型建议的验证步骤尚未执行。</p></div></div>{run.execution_status==='running'&&run.outcome_status==='unknown'?<p className="run-pending">尚未收到独立检查结果，任务验收保持“未知”。</p>:<OutcomePanel run={run}/>}</section>
      <RunRelations run={run}/>
      <section className="journey-step technical-section"><div className="journey-heading"><span>资料</span><div><h2>深入核查</h2><p>原始文件、算法数据和运行元信息仍可追溯。</p></div></div><button className="button" aria-expanded={showTechnical} onClick={()=>setShowTechnical(value=>!value)}>{showTechnical?'收起技术详情':'查看技术详情'}</button>{showTechnical&&<div className="deep-panel"><Overview run={run}/></div>}</section>
    </div><InvestigationRail run={run}/></div>
  </div>;
}

function TracePanel({run}: {run:Run}) {
  const open=useContext(EvidenceContext);const [kind,setKind]=useState('');const [q,setQ]=useState('');const [search,setSearch]=useState('');const [offset,setOffset]=useState(0);const [follow,setFollow]=useState(run.origin==='live');
  useEffect(()=>{const t=setTimeout(()=>{setSearch(q);setOffset(0);},200);return()=>clearTimeout(t);},[q]);
  const {data,error,loading}=useData<{items:TraceEvent[];total:number}>('/runs/'+run.run_id+'/events?'+new URLSearchParams({kind,q:search,offset:String(offset),limit:'50'}),run.event_count);
  useEffect(()=>{if(follow&&!search&&!kind&&data)setOffset(Math.max(0,Math.floor((data.total-1)/50)*50));},[data?.total,follow,search,kind]);
  return <section className="panel"><div className="table-toolbar"><div className="event-filters">{[['','全部事件'],['tool_call','工具调用'],['tool_return','工具返回'],['llm','LLM'],['log','进程日志'],['event','生命周期']].map(([key,label])=><button key={key} className={kind===key?'selected':''} onClick={()=>{setKind(key);setOffset(0);setFollow(false);}}>{label}</button>)}</div><label className="search-box narrow"><Search size={16}/><input aria-label="搜索事件" placeholder="搜索事件或错误…" value={q} onChange={e=>setQ(e.target.value)}/></label></div>
    {run.origin==='live'&&<div className="live-toolbar"><span>{follow?'跟随最新事件页':'已暂停跟随 · 可查看旧记录'}</span><button className="text-button" onClick={()=>{setFollow(v=>!v);if(!follow){setKind('');setQ('');}}}>{follow?'暂停跟随':'跟随最新'}</button></div>}
    <div className="trace-head"><span>位置 / 类型</span><span>事件与内容摘要</span><span>证据</span></div>
    {loading?<Loading/>:error?<ErrorBox text={error}/>:!data?.items.length?<Empty title="没有匹配的事件">尝试调整搜索条件。</Empty>:data.items.map(event=><button className="trace-row" key={event.event_id} onClick={()=>open(event.evidence_id)}><div className="trace-position"><span className="mono">{String(event.position+1).padStart(3,'0')}</span><span className={'event-kind '+event.kind}>{event.kind==='tool_call'?<Terminal size={15}/>:event.kind==='llm'?<Blocks size={15}/>:event.kind==='tool_return'?<ArrowLeft size={15}/>:<Circle size={12}/>}</span><span>{event.kind}</span></div><div className="trace-content"><div><strong>{event.name}</strong>{event.tool_status==='failed'&&<span className="tiny-error">工具失败</span>}{event.duration_ms!==null&&<span className="duration">{event.duration_ms} ms</span>}</div><p>{pretty(event.output??event.input)}</p></div><span className="line-ref">{event.line?'L'+event.line:'事件'}<ArrowUpRight size={13}/></span></button>)}
    <div className="table-foot"><span>{data?.total||0} 条事件 · 保留不同采集层级</span><div className="pagination"><button className="icon-button" aria-label="上一页" disabled={offset===0} onClick={()=>{setFollow(false);setOffset(Math.max(0,offset-50));}}><ChevronLeft size={16}/></button><span>{Math.floor(offset/50)+1} / {Math.max(1,Math.ceil((data?.total||0)/50))}</span><button className="icon-button" aria-label="下一页" disabled={loading||offset+50>=(data?.total||0)} onClick={()=>{setFollow(false);setOffset(offset+50);}}><ChevronRight size={16}/></button></div></div>
  </section>;
}

function ReportView({report}: {report:Diagnosis}) {
  const open=useContext(EvidenceContext);
  const kind=report.mode==='analyst_rca'?'hypothesis':report.origin==='recomputed'?'localization':'historical';
  return <div className="report-view"><section className="panel diagnosis-summary"><div className="section-heading"><div><h3>{kind==='hypothesis'?'待验证的根因假设':kind==='localization'?'本机定位线索':'来源附带的历史报告'}</h3><p>{kind==='hypothesis'?'模型建议尚未得到独立检查证明。':kind==='localization'?'定位结果并非完整根因解释。':'此报告并非本平台对现场 Run 的重新诊断。'}</p></div><button className="text-button" onClick={()=>open(report.raw_evidence_id)}>查看源报告<ArrowUpRight size={14}/></button></div><p>{report.summary}</p></section>
    {report.findings?.length>0&&<section className="panel findings"><div className="section-heading"><h3>报告引用的证据 <span className="counter">{report.findings.length}</span></h3></div>{report.findings.map((finding,index)=><article className="finding" key={index}><div className={'finding-marker '+finding.severity}>{index+1}</div><div><h3>{finding.title}</h3>{finding.description&&<p>{finding.description}</p>}<div className="evidence-chips">{finding.evidence.map((ref,j)=><button className={'evidence-chip '+ref.resolution_status} key={j} onClick={()=>open(ref.evidence_id)}><FileText size={13}/>{ref.label}{ref.resolution_status!=='resolved'?' · 引用待解析':''}<ArrowUpRight size={12}/></button>)}{!finding.evidence.length&&<span className="muted">来源未提供事件引用</span>}</div></div></article>)}</section>}
    {kind==='hypothesis'&&<section className="panel guidance-panel"><h3>建议与适用边界</h3>{report.guidance&&<><strong>建议操作</strong><p>{report.guidance}</p></>}<strong>建议验证 · 尚未执行</strong><p>{report.verification_suggestion||'报告未提供具体步骤'}</p>{report.boundary&&<><strong>适用边界</strong><p>{report.boundary}</p></>}</section>}
    <details className="panel report-technical"><summary>查看报告来源与技术详情</summary><div><p>来源：{report.source_algorithm} · {report.format} · {report.origin==='imported'?'历史导入':'本平台生成'}</p>{report.model_reason&&<p>{report.model_reason}</p>}{report.prompt_evidence_id&&<button className="text-button" onClick={()=>open(report.prompt_evidence_id!)}>查看实际发送内容</button>}{report.input_evidence_id&&<button className="text-button" onClick={()=>open(report.input_evidence_id!)}>追溯输入快照</button>}{report.provenance&&<pre>{pretty(report.provenance)}</pre>}{report.graph&&<GraphPanel graph={report.graph}/>}<p className="hash-text">输入快照：{report.input_snapshot_hash||'来源未提供'}</p></div></details>
  </div>;
}

function DiagnosisPanel({run}: {run:Run}) {
  const [revision,setRevision]=useState(0);
  const {data,error,loading}=useData<Diagnosis[]>('/runs/'+run.run_id+'/diagnoses',revision);
  const open=useContext(EvidenceContext);
  const selectedId=run.insight?.diagnosis.featured_report?.diagnosis_id;
  const featured=data?.find(report=>report.diagnosis_id===selectedId)||data?.[0];
  const others=data?.filter(report=>report.diagnosis_id!==featured?.diagnosis_id)||[];
  const latestJob=run.insight?.diagnosis.latest_job;
  return <>
    <div className="panel diagnosis-progress"><strong><DiagnosisLabel run={run}/></strong><p>{latestJob&&['failed','timed_out','interrupted'].includes(latestJob.state)&&run.insight?.diagnosis.report_count?'已有报告仍保留；最近一次诊断作业未成功。':run.insight?.diagnosis.state==='none'?'本轮尚无诊断报告。':'报告只提供线索或待验证的解释，不能替代独立验收。'}</p></div>
    {loading&&!data?<Loading/>:error?<ErrorBox text={error}/>:featured?<ReportView report={featured}/>:<div className="panel journey-empty">尚无报告。可在下方手动开始本机定位；联网 RCA 还需要预览实际发送内容并再次确认。</div>}
    <DiagnosisControls run={run} onChange={()=>setRevision(value=>value+1)} onEvidence={open}/>
    {!!others.length&&<details className="report-history"><summary>查看其他报告与历史版本（{others.length}）</summary>{others.map(report=><ReportView key={report.diagnosis_id} report={report}/>)}</details>}
  </>;
}

function GraphPanel({graph}: {graph:Diagnosis['graph']}) {
  if(!graph)return <section className="panel graph-empty"><GitBranch size={25}/><h3>来源未提供轨迹图</h3><p>旧版报告可以通过事件引用追溯证据。</p></section>;
  const nodes=(graph.macro_nodes||[]).slice(0,8);
  return <section className="panel graph-panel"><h3>轨迹结构图</h3><p>阶段节点 · 关系不等于因果</p><div className="graph-flow">{nodes.map((node,i)=><React.Fragment key={i}><div><span>{String(i+1).padStart(2,'0')}</span>{pretty(node.label||node.title||node.phase||node.id||'节点')}</div></React.Fragment>)}</div><p className="muted">节点按源文件顺序排列，不推断连接关系。</p><details><summary>查看原始节点与关系</summary><pre>{pretty(graph)}</pre></details></section>;
}

function OutcomePanel({run}: {run:Run}) {
  const {data,error,loading}=useData<Outcome[]>('/runs/'+run.run_id+'/outcomes',run.event_count);const open=useContext(EvidenceContext);
  if(loading)return <Loading/>;if(error)return <ErrorBox text={error}/>;
  return <section className="panel outcomes"><div className="section-heading"><div><h2>独立验收记录</h2><p>{run.origin==='live'?'现场上报的独立检查证据；检查本身由接入方执行。':'来源提供的历史结果，不代表平台已重新执行测试。'}</p></div><Badge status={run.outcome_status}/></div>{!data?.length?<Empty title="没有验收证据">任务结果保持未知。</Empty>:data.map(outcome=><div className="outcome-row" key={outcome.outcome_id}><div><Badge status={outcome.status}/><strong>{outcome.source}</strong><span className="source-tag">{run.origin==='live'?'现场检查事件':outcome.authoritative?'独立验收文件':'报告 / 遥测证据'}</span></div><p>{outcome.summary||'来源未提供摘要'}</p><div className="outcome-footer"><span>评价依据 <code>{pretty(outcome.basis)}</code>{outcome.reward!==null&&<> · reward <code>{outcome.reward}</code></>}</span><button className="text-button" onClick={()=>open(outcome.evidence_id)}>追溯验收记录<ArrowUpRight size={14}/></button></div></div>)}</section>;
}

function Overview({run}: {run:Run}) {
  const open=useContext(EvidenceContext);
  return <div className="overview-grid"><section className="panel"><h2>运行元数据</h2><dl><div><dt>轮次来源</dt><dd>{run.origin==='live'?'采集会话':'导入清单'}：第 {run.attempt_index} 轮</dd></div><div><dt>原始 attempt</dt><dd className="mono">{pretty(run.raw_attempts)}</dd></div><div><dt>历史报告 ok</dt><dd className="mono">{pretty(run.report_ok)}</dd></div><div><dt>采集调用数</dt><dd>{run.tool_call_count} · 包含不同采集层级</dd></div><div><dt>精确调用配对</dt><dd>{run.confirmed_pairs}</dd></div><div><dt>干预事件</dt><dd>{run.intervention_count}</dd></div><div><dt>输入快照 SHA-256</dt><dd className="hash-text">{run.snapshot_hash||'采集尚未完整，暂未生成快照'}</dd></div></dl></section><section className="panel"><h2>原始文件</h2>{run.origin==='live'&&<p className="muted">现场事件逐条保存，可从执行轨迹打开原始接收证据。</p>}<div className="artifact-list">{run.artifacts.map(a=><div key={a.filename}><FileJson size={20}/><div><strong>{a.filename}</strong><small>{a.kind}</small><code>{a.sha256}</code></div></div>)}</div>{run.feedback&&<div className="feedback"><h3>本轮历史反馈</h3><p>文件存在不等于已经验证注入。</p><button className="text-button" onClick={()=>open(run.feedback!.evidence_id)}>查看反馈文件<ArrowUpRight size={14}/></button></div>}</section></div>;
}

function ComparePage() {
  const {taskId}=useParams();const {data:task,error,loading}=useData<Task>('/tasks/'+taskId);
  const [left,setLeft]=useState('');const [right,setRight]=useState('');
  useEffect(()=>{if(task){setLeft(task.runs[0]?.run_id||'');setRight(task.runs.at(-1)?.run_id||'');}},[task]);
  if(loading)return <Loading/>;if(error||!task)return <ErrorBox text={error}/>;
  const a=task.runs.find(run=>run.run_id===left),b=task.runs.find(run=>run.run_id===right);
  return <><Back to={'/tasks/'+task.id}>返回任务历程</Back><div className="page-heading compact"><div><h1>比较两次运行</h1><p>{task.goal}</p></div></div>
    <div className="compare-selectors">{[[left,setLeft],[right,setRight]].map(([value,setter],index)=><label key={index}><span>{index===0?'基准运行':'对照运行'}</span><select aria-label={index===0?'基准运行':'对照运行'} value={value as string} onChange={event=>(setter as (value:string)=>void)(event.target.value)}>{task.runs.map(run=><option key={run.run_id} value={run.run_id}>第 {run.attempt_index} 次 · {new Date(run.created_at).toLocaleString('zh-CN')}</option>)}</select></label>)}</div>
    {left===right&&<div className="notice">当前选择了同一次运行，请选择不同轮次。</div>}
    {a&&b&&<><section className="panel comparison"><table><thead><tr><th>可核对的事实</th><th>第 {a.attempt_index} 次运行</th><th>第 {b.attempt_index} 次运行</th></tr></thead><tbody><tr><td>任务验收</td><td>{outcomeNames[a.outcome_status]}</td><td>{outcomeNames[b.outcome_status]}</td></tr><tr><td>执行状态</td><td>{executionNames[a.execution_status]}</td><td>{executionNames[b.execution_status]}</td></tr><tr><td>诊断进度</td><td><DiagnosisLabel run={a}/></td><td><DiagnosisLabel run={b}/></td></tr><tr><td>失败线索</td><td>{a.insight?.failure_signals.length||0} 条</td><td>{b.insight?.failure_signals.length||0} 条</td></tr></tbody></table><div className="notice">前后变化是记录到的事实；仅凭轮次顺序不能证明 RCA 假设或干预导致后一次结果。</div><details className="compare-technical"><summary>查看辅助计数</summary><table><thead><tr><th>维度</th><th>第 {a.attempt_index} 次</th><th>第 {b.attempt_index} 次</th></tr></thead><tbody>{[['原始事件',a.event_count,b.event_count],['采集工具调用',a.tool_call_count,b.tool_call_count],['失败工具返回',a.failed_tool_count,b.failed_tool_count]].map(([label,av,bv])=><tr key={label}><td>{label}</td><td>{av}</td><td>{bv}</td></tr>)}</tbody></table></details></section><div className="compare-columns"><CompareDetail run={a}/><CompareDetail run={b}/></div></>}
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
