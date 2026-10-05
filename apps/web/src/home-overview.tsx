import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Activity,AlertCircle,ArrowUpRight,Check,ChevronRight,Copy,Layers3,Terminal,X} from 'lucide-react';
import {executionNames,outcomeNames,type HomeSource,type HomeSummary,type Run} from './api';
import {usageNumber} from './run-usage';
import {SegmentedControl} from './run-controls';
import './home-overview.css';

export const homeSources:Record<HomeSource,string>={live:'真实实时',imported:'真实历史',synthetic:'合成演示',all:'全部来源'};

function HomeDialog({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();trigger?.isConnected&&trigger.focus({preventScroll:true});};},[]);
  return <dialog ref={ref} className="home-dialog" aria-label={title} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}><header><strong>{title}</strong><button className="icon-button" aria-label="关闭概览详情" onClick={close}><X size={18}/></button></header><div className="home-dialog-body">{children}</div></dialog>;
}

export function HomeOverview({summary,onSection}:{summary:HomeSummary|null;onSection:(id:string)=>void}) {
  const [detail,setDetail]=useState<'runs'|'tokens'|null>(null);
  return <>
    <section className="home-overview" aria-label="运行概览">
      <button disabled={!summary} onClick={()=>onSection('home-running')}><span><Activity size={15}/>正在运行<small>当前</small></span><strong>{usageNumber(summary?.running)}</strong><small>打开实时执行<ChevronRight size={12}/></small></button>
      <button disabled={!summary} onClick={()=>onSection('home-attention')}><span><AlertCircle size={15}/>需要处理<small>当前</small></span><strong className={summary?.attention?'attention-value':''}>{usageNumber(summary?.attention)}</strong><small>查看异常与未通过检查<ChevronRight size={12}/></small></button>
      <button disabled={!summary} onClick={()=>setDetail('runs')}><span><Layers3 size={15}/>最近入库运行</span><strong>{usageNumber(summary?.sample.count)}</strong><small>最近 {summary?.sample.limit||20} 次记录<ChevronRight size={12}/></small></button>
      <button disabled={!summary} onClick={()=>setDetail('tokens')}><span>已记录 Token</span><strong>{usageNumber(summary?.tokens.value)}</strong><small>{summary?`${summary.tokens.with_total}/${summary.tokens.responses} 条模型响应有总用量`:'读取用量…'}<ChevronRight size={12}/></small></button>
    </section>
    {detail&&summary&&<HomeDialog title={detail==='tokens'?'最近运行的用量':'最近入库运行'} close={()=>setDetail(null)}>
      <p className="home-dialog-scope">{homeSources[summary.source]} · 最近 {summary.sample.limit} 次入库记录，当前 {summary.sample.count} 次。此范围按记录创建顺序，不代表历史 Agent 的执行时间范围。</p>
      {detail==='tokens'&&<p className="home-dialog-scope">只汇总已观察到的 Agent 响应用量；缺失显示 —，RCA 自身用量不计入。{summary.tokens.uncertain_events>0&&`另有 ${summary.tokens.uncertain_events} 条模型事件无法确定调用归属，未计入。`}</p>}
      <div className="home-sample-list">{summary.sample.items.map(item=><Link key={item.run_id} to={'/runs/'+item.run_id}><div><strong>{item.goal}</strong><small>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.origin==='live'?'实时采集':'历史导入'} · {item.sample_kind==='synthetic'?'合成演示':item.sample_kind==='derived'?'派生样例':'真实记录'}</small></div><div><strong>{detail==='tokens'?usageNumber(item.tokens):outcomeNames[item.outcome_status]||'验收未知'}</strong><small>{detail==='tokens'?`${item.with_total}/${item.responses} 响应有总用量`:'打开本次运行'}</small></div><ArrowUpRight size={15}/></Link>)}</div>
      {!summary.sample.count&&<p className="home-dialog-scope">所选来源下还没有运行记录。</p>}
    </HomeDialog>}
  </>;
}

export function CaptureFeedback({summary,renderSource,onStart}:{summary:HomeSummary;renderSource:(run:Run)=>ReactNode;onStart:()=>void}) {
  const feedback=summary.feedback;
  if(!feedback)return <section className="home-capture empty" aria-label="接入反馈"><Terminal size={17}/><div><strong>{summary.source==='imported'?'历史记录不包含实时接入反馈':summary.source==='live'?'等待真实 Agent 接入':'尚无所选来源的实时记录'}</strong><span>{summary.source==='imported'?'切换至“真实实时”，查看实时 Agent 的接入情况。':'点击“开始监控”，在终端运行接入命令。API 在线并不表示已有 Agent 上报。'}</span></div><button className="home-capture-guide" onClick={onStart}>查看接入步骤<ChevronRight size={14}/></button></section>;
  const run=feedback.run;
  const captureBad=run.capture_integrity==='partial'||!!run.dropped_events||(run.execution_status==='running'&&run.capture_status==='disconnected');
  const ended=['completed','failed','cancelled'].includes(run.execution_status);
  const captureState=captureBad?'warning':run.execution_status==='running'?(feedback.events?'receiving':'waiting'):ended?'ended':'unknown';
  const captureLabel=captureBad?'采集异常':run.execution_status==='running'?(feedback.events?'正在接收':'等待上报'):ended?(feedback.events?'执行结束':'未收到事件'):'状态未确认';
  const checkpoints=[
    {key:'events',label:'执行事件',ready:feedback.events>0,text:feedback.events?`${feedback.events} 条已收到`:'等待首条事件'},
    {key:'tools',label:'工具调用',ready:feedback.tools.observed>0,text:feedback.tools.observed?`${feedback.tools.observed} 次 · ${feedback.tools.paired} 组返回`:'尚未记录工具调用'},
    {key:'usage',label:'模型用量',ready:feedback.with_total>0,text:feedback.model_responses?`${feedback.with_total}/${feedback.model_responses} 响应有总用量`:'尚未记录模型响应'},
    {key:'checks',label:'任务检查',ready:feedback.outcomes>0,text:feedback.outcomes?outcomeNames[run.outcome_status]||'验收未知':'未收到检查记录'},
  ];
  return <section className="home-capture" aria-label="接入反馈">
    <div className="home-capture-heading"><div className="home-capture-title"><strong>接入反馈</strong><span className={'home-capture-state '+captureState}><i/>{captureLabel}</span><small>最新实时记录</small></div><Link className="home-capture-run" to={'/runs/'+run.run_id}><strong title={run.task_goal||run.external_run_id}>{run.task_goal||run.external_run_id}</strong><ArrowUpRight size={14}/></Link>{renderSource(run)}<small className="capture-run-state">{run.execution_status==='running'?run.capture_status==='disconnected'?'采集器失联 · 执行待确认':'运行中':executionNames[run.execution_status]||'执行状态未知'}</small></div>
    <div className="home-capture-checks">{checkpoints.map(point=>{const failed=point.key==='checks'&&point.ready&&run.outcome_status==='failed';return <Link key={point.key} to={'/runs/'+run.run_id} className={failed?'received check-failed':point.ready?'received':'waiting'}>{failed?<AlertCircle size={16}/>:point.ready?<Check size={16}/>:<span className="capture-wait-dot"/>}<div><span>{point.label}</span><strong className={failed?'failed-check':''}>{point.text}</strong></div><ChevronRight className="capture-check-open" size={12}/></Link>;})}</div>
    <div className="home-capture-foot"><small className="home-capture-note"><span className={run.capture_integrity==='partial'?'capture-incomplete':''}>事件交付：{({complete:'完整',partial:'不完整',pending:'待补齐',unknown:'未知'} as Record<string,string>)[run.capture_integrity||'unknown']||'未知'}</span> · 此处核对已上报的数据；采集完整不代表所有工具和模型操作均已接入。</small>{(!feedback.events||captureBad)&&<button className="home-capture-guide" onClick={onStart}>查看接入步骤<ChevronRight size={14}/></button>}</div>
  </section>;
}

export function MonitorStart({close,demo,busy,error}:{close:()=>void;demo:()=>void;busy:boolean;error:string}) {
  const [mode,setMode]=useState<'agent'|'example'>('agent'),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState('');
  const copyVersion=useRef(0);
  const command=mode==='agent'?'.\\.venv\\Scripts\\agentops.exe run --goal "任务目标" -- .\\.venv\\Scripts\\python.exe your_agent.py':'.\\.venv\\Scripts\\agentops.exe run --sample-kind synthetic --goal "本地加法任务" -- .\\.venv\\Scripts\\python.exe examples/local_agent.py --delay 4 --fail';
  async function copy(){const version=copyVersion.current;try{await navigator.clipboard.writeText(command);if(version===copyVersion.current){setCopied(true);setCopyError('');}}catch{if(version===copyVersion.current)setCopyError('复制失败，可直接选中命令复制。');}}
  useEffect(()=>{copyVersion.current++;setCopied(false);setCopyError('');return()=>{copyVersion.current++;};},[mode]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2500);return()=>clearTimeout(timer);},[copied]);
  return <HomeDialog title="开始监控" close={close}><div className="monitor-intro"><Terminal size={24}/><div><strong>从终端启动，在这里观察</strong><p>复制命令不会执行 Agent；数据到达后才会显示接入结果。</p></div></div><div className="monitor-modes"><SegmentedControl label="接入方式" value={mode} options={[{value:'agent',label:'已有 Python Agent'},{value:'example',label:'无模型演示'}]} onChange={setMode}/></div>
    <ol className="monitor-steps"><li><strong>保留平台服务，打开另一个终端</strong><span>进入项目根目录，使用已安装本项目命令行工具的 Python 环境。</span></li><li><strong>{mode==='agent'?'替换入口和任务目标，执行命令':'执行本地示例，观察事件与失败检查'}</strong><div className="monitor-command"><code>{command}</code><button onClick={copy}><Copy size={14}/>{copied?'已复制':'复制命令'}</button></div></li><li><strong>打开终端返回的 Run 链接</strong><span>网页持续显示已采集的步骤；首页接入反馈可核对已收到的数据。</span></li></ol>
    {copied&&<p className="monitor-copy-status" role="status">命令已复制；请在另一个终端运行。</p>}
    {mode==='agent'?<div className="monitor-coverage"><strong>这条命令能采集什么？</strong><dl><dt>进程与日志</dt><dd>CLI 启动并记录退出状态、stdout / stderr。</dd><dt>工具调用</dt><dd>Python 工具接入 <code>@tool</code> 或已有适配器后才有调用与返回。</dd><dt>模型与用量</dt><dd>需要对应模型／框架适配；服务未提供 usage 时不显示 Token 总量。</dd><dt>任务检查</dt><dd>测试／规则通过 <code>verification</code> 上报；退出码 0 不等于任务通过。</dd></dl><details><summary>查看最小 Python 工具接入示例</summary><pre>{'from agentops_cli import tool, verification\n\n@tool\ndef add(a, b):\n    return a + b\n\nresult = add(2, 3)\nverification("passed" if result == 5 else "failed", source="python-assertion",\n             basis="add(2, 3) == 5")'}</pre></details></div>:<p className="monitor-example-note">示例不调用模型，明确标为合成演示。<code>--fail</code> 演示进程正常退出、任务检查未通过。</p>}
    {(error||copyError)&&<p className="home-start-error" role="alert">{error||copyError}</p>}
    <div className="monitor-footer"><button className="text-button" onClick={demo} disabled={busy}>{busy?'正在载入…':'直接载入历史演示'}</button><Link to="/imports">导入历史记录<ArrowUpRight size={14}/></Link><Link to="/system">检查运行环境<ArrowUpRight size={14}/></Link></div>
  </HomeDialog>;
}
