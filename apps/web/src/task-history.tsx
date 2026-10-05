import {useEffect,useMemo,useState,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Activity,AlertCircle,ArrowLeft,ArrowRight,ArrowUpRight,Check,ChevronRight,Copy,GitCompareArrows,Layers3,Minus,RefreshCw,Search,Terminal,X} from 'lucide-react';
import {diagnosisNames,executionNames,outcomeNames,type Run,type Task} from './api';
import {SegmentedControl} from './run-controls';
import './task-history.css';

type SourceRenderer=(run:Run)=>ReactNode;
function Stamp({run}:{run:Run}) {
  const date=new Date(run.created_at);
  return <time dateTime={run.created_at} title={run.created_at}>{Number.isNaN(date.getTime())?'入库时间未知':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>;
}
export function Fact({kind,run}:{kind:'execution'|'outcome'|'diagnosis';run:Run}) {
  const diagnosis=run.insight?.diagnosis,state=diagnosis?.state||'none';
  const names:Record<string,string>={none:'尚未分析',running:'分析进行中',hypothesis:'待验证假设',localization:'已有定位线索',historical:'附带历史报告',failed:'分析作业失败'};
  const value=kind==='execution'?executionNames[run.execution_status]||'执行状态未知':kind==='outcome'?outcomeNames[run.outcome_status]||'验收未知':names[state]||'诊断状态未知';
  const tone=kind==='execution'?(run.execution_status==='failed'?'failed':run.execution_status==='running'?'running':run.execution_status==='completed'?'completed':'unknown'):kind==='outcome'?(run.outcome_status==='failed'?'failed':run.outcome_status==='passed'?'passed':'unknown'):(state==='failed'?'failed':state==='running'?'running':['hypothesis','localization'].includes(state)?'analysis':'unknown');
  const failedJob=kind==='diagnosis'&&!!diagnosis?.report_count&&diagnosis.latest_job&&['failed','timed_out','interrupted'].includes(diagnosis.latest_job.state);
  return <div className="history-fact"><span className={'history-state '+tone} title={kind==='diagnosis'?diagnosisNames[state]:undefined}>{tone==='failed'?<AlertCircle size={14}/>:tone==='passed'?<Check size={14}/>:tone==='running'?<Activity size={14}/>:tone==='unknown'?<Minus size={13}/>:<i/>}{value}</span>{failedJob&&<small className="history-job-failed">最近作业失败</small>}</div>;
}

export function TaskIndex({tasks,error,loading,onRefresh,renderSource}:{tasks:Task[]|null;error:string;loading:boolean;onRefresh:()=>void;renderSource:SourceRenderer}) {
  const [query,setQuery]=useState('');
  const visible=(tasks||[]).filter(task=>(task.id+' '+task.external_id+' '+task.goal).toLowerCase().includes(query.toLowerCase()));
  return <div className="task-history-page task-index"><div className="page-heading"><div><h1>任务历程</h1><p>查看同一任务的多次运行，比较前后记录。</p></div><Link className="history-button" to="/"><ArrowLeft size={15}/>运行工作台</Link></div>
    <div className="history-list-toolbar"><label className="history-search"><Search size={16}/><input aria-label="搜索任务" placeholder="搜索任务目标或 ID…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清空任务搜索" onClick={()=>setQuery('')}><X size={14}/></button>}</label><span className="history-result-count">{tasks?`${visible.length}${query?` / ${tasks.length}`:''} 个任务`:'读取任务…'}</span><button className="history-button history-refresh" disabled={loading} onClick={onRefresh}><RefreshCw size={14}/>刷新</button></div>
    {error&&<div className="history-error" role="alert">{tasks?'刷新失败，保留上次记录。':'无法读取任务。'} {error}<button onClick={onRefresh}>重试</button></div>}
    {loading&&!tasks?<p className="history-empty">正在读取任务…</p>:<><table className="history-task-table"><thead><tr><th>任务 / 来源</th><th>运行次数</th><th>最新执行</th><th>最新任务检查</th><th><span className="history-sr-only">打开</span></th></tr></thead><tbody>{visible.map(task=>{const latest=task.runs.at(-1);return <tr key={task.id}><td><Link className="history-task-name" to={'/tasks/'+task.id}><span className="history-task-mark"><Layers3 size={17}/></span><div><strong title={task.goal}>{task.goal}</strong><div className="history-task-meta">{latest&&renderSource(latest)}<span title={task.external_id+' · '+task.id}>ID {task.id.slice(0,8)}</span></div></div></Link></td><td data-label="运行次数"><span className="history-count">{task.runs.length}</span><small> 次</small></td><td data-label="最新执行">{latest?<Fact kind="execution" run={latest}/>:<span className="history-unknown">尚无运行</span>}</td><td data-label="任务检查">{latest?<Fact kind="outcome" run={latest}/>:<span className="history-unknown">验收未知</span>}</td><td><Link className="history-row-open" to={'/tasks/'+task.id} aria-label={'打开任务 '+task.external_id}><ArrowUpRight size={17}/></Link></td></tr>})}</tbody></table>
    {!visible.length&&<div className="history-empty-state"><Layers3 size={24}/><strong>{tasks?.length?'没有匹配的任务':'还没有任务记录'}</strong><span>{tasks?.length?'试试其他目标或任务 ID。':'从运行工作台开始监控，或导入已有记录。'}</span>{tasks?.length?<button className="history-button" onClick={()=>setQuery('')}>清空搜索</button>:<Link className="history-button" to="/">打开运行工作台<ArrowRight size={14}/></Link>}</div>}
    <div className="history-list-foot"><span>按任务入库顺序排列</span><span>最新检查结果与执行状态分别保留</span></div></>}
  </div>;
}

function Changes({first,latest}:{first:Run;latest:Run}) {
  return <section className="history-change-strip" aria-label="首末运行变化"><div className="history-change-context"><GitCompareArrows size={18}/><div><strong>第 {first.attempt_index} 次 → 第 {latest.attempt_index} 次</strong><small>首末运行记录</small></div></div>{(['outcome','execution'] as const).map(kind=><div className="history-change-fact" key={kind}><span>{kind==='outcome'?'任务检查':'执行状态'}</span><div><Fact kind={kind} run={first}/><ArrowRight size={14}/><Fact kind={kind} run={latest}/></div></div>)}<small className="history-change-note">结果变化不证明修复成功<br/>或根因假设已验证</small></section>;
}
function Again({task}:{task:Task}) {
  const [copied,setCopied]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{setCopied(false);setError(false);},[task.id]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer);},[copied]);
  async function copy(){try{await navigator.clipboard.writeText(task.id);setCopied(true);setError(false);}catch{setError(true);}}
  return <details className="history-secondary history-again"><summary><Terminal size={16}/>{task.namespace==='live'?'在同一任务下再次运行':'历史任务的归组'}<ChevronRight className="history-disclosure" size={15}/></summary>{task.namespace==='live'?<div className="history-secondary-body"><p>把以下参数加入原来的 <code>agentops run</code> 命令，在自己的终端启动。任务目标和样例类型须与本任务一致。</p><div className="history-task-command"><code>--task-id {task.id}</code><button className="history-button" onClick={()=>void copy()}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'已复制任务 ID':'复制任务 ID'}</button></div>{error&&<p role="alert" className="history-copy-error">复制失败，可选择上方 ID 手动复制，或点击按钮重试。</p>}<small aria-live="polite">{copied?'已复制。 ':''}平台不会自动执行命令，也不会按名称合并运行。</small></div>:<div className="history-secondary-body"><p>这些轮次由导入清单明确归组。后续现场运行默认创建新任务；只有确认目标和样例性质完全一致，才应显式关联已有任务 ID。</p><small>平台不会按任务名称自动合并记录。</small></div>}</details>;
}
export function TaskHistoryView({task,error,renderSource}:{task:Task;error:string;renderSource:SourceRenderer}) {
  // The backend supplies the authoritative attempt order; visual reversal is presentation only.
  const runs=task.runs,first=runs[0],latest=runs.at(-1),signature=runs.map(run=>run.run_id).join('|');
  const [order,setOrder]=useState<'earlier'|'newer'>('earlier');
  const [selected,setSelected]=useState<string[]>(()=>first&&latest&&first!==latest?[first.run_id,latest.run_id]:[]);
  const [selectionHint,setSelectionHint]=useState('');
  useEffect(()=>{const known=new Set(runs.map(run=>run.run_id));setSelected(previous=>previous.filter(id=>known.has(id)));},[signature]);
  const chosen=useMemo(()=>runs.filter(run=>selected.includes(run.run_id)),[runs,selected]);
  const predecessors=useMemo(()=>new Map(runs.map((run,index)=>[run.run_id,runs[index-1]])),[runs]);
  const visible=order==='earlier'?runs:[...runs].reverse();
  const compare=chosen.length===2?'/tasks/'+task.id+'/compare?left='+encodeURIComponent(chosen[0].run_id)+'&right='+encodeURIComponent(chosen[1].run_id):null;
  function toggle(id:string){if(selected.includes(id)){setSelected(selected.filter(value=>value!==id));setSelectionHint('');}else if(selected.length<2){setSelected([...selected,id]);setSelectionHint('');}else setSelectionHint('已选两次运行；请先取消一项，再选择其他轮次。');}
  return <div className="task-history-page task-history-detail"><Link className="history-back" to="/tasks"><ArrowLeft size={14}/>全部任务</Link><div className="history-detail-heading"><div><span className="history-eyebrow">同一任务 · 多次运行</span><h1 title={task.goal}>{task.goal}</h1><div className="history-heading-meta"><span>{runs.length} 次运行</span>{latest&&renderSource(latest)}<span title={task.id}>任务 {task.id.slice(0,8)}</span></div></div>{latest&&<Link className="history-button history-primary" to={'/runs/'+latest.run_id}>打开最新运行<ArrowUpRight size={15}/></Link>}</div>
    {error&&<div className="history-error" role="alert">刷新失败，保留上次记录。 {error}</div>}
    {first&&latest&&runs.length>1&&<Changes first={first} latest={latest}/>}
    <section className="history-runs" aria-label="运行历程"><div className="history-runs-heading"><h2>运行历程 <span>{runs.length}</span></h2><SegmentedControl label="轮次排序" value={order} onChange={setOrder} options={[{value:'earlier',label:'较早在前'},{value:'newer',label:'较新在前'}]}/></div>
      <div className="history-selection-toolbar"><div><GitCompareArrows size={16}/><span>{runs.length>1?'选择两次运行，比较记录到的变化。':runs.length===1?'仅有一次运行；再次运行后可以对比。':'尚无运行记录。'}</span></div><div className="history-selection-actions"><span aria-live="polite">已选 {chosen.length}/2</span>{chosen.length>0&&<button className="history-clear" onClick={()=>{setSelected([]);setSelectionHint('');}}>清空</button>}{compare?<Link className="history-button" to={compare}><GitCompareArrows size={14}/>比较两次运行</Link>:<button className="history-button" disabled title="需要选择同一任务下的两次不同运行">比较两次运行</button>}</div></div>
      {selectionHint&&<p className="history-selection-hint" role="status">{selectionHint}</p>}
      {runs.length?<table className="history-run-table"><thead><tr><th><span className="history-sr-only">选择运行</span></th><th>轮次 / 来源</th><th>执行</th><th>任务检查</th><th>原因分析</th><th>原始事件</th><th><span className="history-sr-only">打开运行</span></th></tr></thead><tbody>{visible.map(run=>{const previous=predecessors.get(run.run_id),changes=previous&&(previous.execution_status!==run.execution_status||previous.outcome_status!==run.outcome_status),captureLost=run.execution_status==='running'&&run.capture_status==='disconnected';return <tr key={run.run_id} className={selected.includes(run.run_id)?'history-selected':''}><td><input type="checkbox" aria-label={'选择第 '+run.attempt_index+' 次运行'} checked={selected.includes(run.run_id)} disabled={runs.length<2} onChange={()=>toggle(run.run_id)}/></td><td><Link className="history-run-name" to={'/runs/'+run.run_id}><strong>第 {run.attempt_index} 次运行</strong><ArrowUpRight size={13}/></Link><div className="history-run-source">{renderSource(run)}</div><small className="history-run-stamp">入库 <Stamp run={run}/></small>{captureLost&&<small className="history-capture-lost">采集失联 · 执行待确认</small>}{(run.capture_integrity==='partial'||run.insight?.attention_reasons.includes('capture_incomplete'))&&<small className="history-capture-lost">采集不完整</small>}</td><td data-label="执行"><Fact kind="execution" run={run}/></td><td data-label="任务检查"><Fact kind="outcome" run={run}/>{previous&&<small className="history-row-change">{run.outcome_status===previous.outcome_status?'与上轮相同':`${outcomeNames[previous.outcome_status]||'验收未知'} → 本轮`}</small>}</td><td data-label="原因分析"><Fact kind="diagnosis" run={run}/></td><td data-label="原始事件"><span className="history-count">{run.event_count.toLocaleString()}</span></td><td><Link className="history-run-open" to={'/runs/'+run.run_id}>查看运行<ArrowUpRight size={14}/></Link>{changes&&<small className="history-change-tag">状态有变化</small>}</td></tr>})}</tbody></table>:<div className="history-empty-state"><Layers3 size={24}/><strong>还没有运行记录</strong><Link className="history-button" to="/">打开运行工作台<ArrowRight size={14}/></Link></div>}
      <div className="history-list-foot"><span>轮次按任务关联记录，不根据时间接近猜测</span><span>具体步骤、证据和分析请打开 Run</span></div>
    </section>
    <div className="history-secondary-group"><Again task={task}/><details className="history-secondary history-technical"><summary><Layers3 size={16}/>任务来源与归组详情<ChevronRight className="history-disclosure" size={15}/></summary><dl><div><dt>任务 ID</dt><dd>{task.id}</dd></div><div><dt>来源命名空间</dt><dd>{task.namespace}</dd></div><div><dt>原始任务标识</dt><dd>{task.external_id}</dd></div><div><dt>轮次依据</dt><dd>{task.namespace==='live'?'启动时明确的任务 ID 与分配的轮次':'导入清单给出的轮次；原始 attempt 另行保存'}</dd></div></dl></details></div>
  </div>;
}
