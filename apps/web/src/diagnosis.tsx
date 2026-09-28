import { useEffect, useRef, useState } from 'react';
import { api, type Run } from './api';

export interface Capabilities {status:string; hgt:string; analyst:string; model?:string|null; reason:string}
interface Job {job_id:string; mode:string; state:string; error:string|null; input_snapshot_hash:string; input_evidence_id:string; created_at:string}
interface Preview {prompt:unknown;prompt_sha256:string;preview_sha256:string;prompt_bytes:number;hgt_diagnosis_id:string;model:string;provider:string;truncated:boolean}
const labels:Record<string,string>={queued:'等待运行',running:'正在定位',succeeded:'定位完成',failed:'诊断失败',cancelled:'已取消',timed_out:'运行超时',interrupted:'运行中断'};
const reasons:Record<string,string>={provider_http_401:'模型密钥无效或已过期',provider_http_403:'当前密钥无权使用该模型',provider_http_429:'模型服务达到调用配额',provider_timeout:'模型服务响应超时',provider_error:'模型服务暂不可用',invalid_model_output:'模型回复格式无法解析',invalid_turning_point:'模型引用了不存在的转换',incomplete_plan:'模型未提供完整的分析计划',prompt_mismatch:'发送预览与作业内容不一致',source_hash_mismatch:'算法源码校验失败',worker_failed:'诊断进程失败，请查看本机日志'};

export function DiagnosisControls({run,onChange}:{run:Run;onChange:()=>void}) {
  const [caps,setCaps]=useState<Capabilities|null>(null);
  const [jobs,setJobs]=useState<Job[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<Preview|null>(null);
  const changed=useRef(onChange);changed.current=onChange;
  const requestId=useRef<string|null>(null);
  const analystRequestId=useRef<string|null>(null);
  useEffect(()=>{
    let disposed=false;let previous='';let timer:ReturnType<typeof setTimeout>;
    setJobs([]);setCaps(null);setError('');setPreview(null);requestId.current=null;analystRequestId.current=null;
    async function poll(){
      try {
        const [capabilities,items]=await Promise.all([api<Capabilities>('/diagnosis/capabilities'),api<Job[]>('/runs/'+run.run_id+'/diagnosis-jobs')]);
        if(disposed)return;
        setCaps(capabilities);setJobs(items);
        const signature=items.map(j=>j.job_id+':'+j.state).join(',');
        if(signature!==previous){previous=signature;changed.current();}
        setError('');
      }catch(e){if(!disposed)setError((e as Error).message);}
      if(!disposed)timer=setTimeout(poll,2000);
    }
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[run.run_id]);
  const active=jobs.some(j=>['queued','running'].includes(j.state));
  const eligible=!['running','unknown'].includes(run.execution_status)&&(run.origin!=='live'||run.capture_integrity==='complete');
  async function start(){
    setBusy(true);setError('');requestId.current ||= crypto.randomUUID();
    try {
      const job=await api<Job>('/runs/'+run.run_id+'/diagnosis-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:requestId.current})});
      requestId.current=null;setJobs(items=>[job,...items.filter(j=>j.job_id!==job.job_id)]);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function cancel(id:string){
    setBusy(true);setError('');
    try{const job=await api<Job>('/diagnosis-jobs/'+id+'/cancel',{method:'POST'});setJobs(items=>items.map(j=>j.job_id===id?job:j));}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function showPreview(){
    setBusy(true);setError('');
    try{setPreview(await api<Preview>('/runs/'+run.run_id+'/analyst-preview'));}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function startAnalyst(){
    if(!preview)return;
    setBusy(true);setError('');analystRequestId.current ||= crypto.randomUUID();
    try{
      const job=await api<Job>('/runs/'+run.run_id+'/analyst-jobs',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({request_id:analystRequestId.current,preview_sha256:preview.preview_sha256,hgt_diagnosis_id:preview.hgt_diagnosis_id})});
      analystRequestId.current=null;setPreview(null);setJobs(items=>[job,...items.filter(j=>j.job_id!==job.job_id)]);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const analystReady=['configured','last_call_succeeded','last_call_failed'].includes(caps?.analyst||'');
  const hgtDone=jobs.some(j=>j.mode==='offline_hgt'&&j.state==='succeeded');
  return <section className="panel diagnosis-controls">
    <div className="section-heading"><div><h2>手动诊断</h2></div><div className="diagnosis-actions"><button className="button" disabled={busy||active||!eligible||caps?.hgt!=='ready'} onClick={start}>运行 HGT 定位</button><button className="button primary" disabled={busy||active||!eligible||!analystReady||!hgtDone} onClick={showPreview}>查看 RCA 发送内容</button></div></div>
    <p className="muted">{caps?.reason||'正在检查诊断环境…'} · RCA 仅在预览并确认后调用 {caps?.model||'已配置模型'}。</p>
    {!eligible&&<p role="status">执行结束且采集完整后才能发起定位。</p>}
    {!hgtDone&&eligible&&<p className="muted">先运行一次 HGT 定位，才能查看 RCA 的发送内容。</p>}
    {preview&&<div className="analyst-preview"><div className="section-heading"><div><h3>即将发送给 {preview.model} 的内容</h3><p>{preview.provider} · {preview.prompt_bytes.toLocaleString('zh-CN')} 字节 · {preview.truncated?'候选片段已截断':'候选片段完整'}</p></div><button className="text-button" onClick={()=>setPreview(null)}>关闭预览</button></div><pre>{JSON.stringify(preview.prompt,null,2)}</pre><p className="muted">这将产生一次模型调用。取消本机作业时，已送达服务商的调用仍可能计费；建议的验证步骤尚未执行。</p><button className="button primary" disabled={busy||active} onClick={startAnalyst}>确认并运行 RCA</button></div>}
    {error&&<p role="alert">{error}</p>}
    {jobs.filter(job=>['queued','running'].includes(job.state)).map(job=><div className="diagnosis-job" key={job.job_id}><strong role="status">{job.mode==='analyst_rca'?'RCA':'HGT'} · {labels[job.state]||job.state}</strong><button className="button" disabled={busy} onClick={()=>cancel(job.job_id)}>取消作业</button></div>)}
  </section>;
}

export function DiagnosisJobHistory({run,onEvidence}:{run:Run;onEvidence:(id:string)=>void}) {
  const [jobs,setJobs]=useState<Job[]>([]),[error,setError]=useState('');
  useEffect(()=>{let disposed=false;let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const items=await api<Job[]>('/runs/'+run.run_id+'/diagnosis-jobs');if(!disposed){setJobs(items);setError('');}}catch(e){if(!disposed)setError((e as Error).message);}
      if(!disposed)timer=setTimeout(poll,5000);}
    void poll();return()=>{disposed=true;clearTimeout(timer);};},[run.run_id]);
  return <details className="technical-group"><summary>HGT / RCA 作业历史 <span>{jobs.length}</span></summary>{error&&<p role="alert">{error}</p>}{!jobs.length&&<p className="muted">尚无本轮诊断作业。</p>}{jobs.map(job=><div className="diagnosis-job" key={job.job_id}><div><strong>{job.mode==='analyst_rca'?'RCA':'HGT'} · {labels[job.state]||job.state}</strong><span className="muted"> · {new Date(job.created_at).toLocaleString('zh-CN')}</span>{job.error&&<p>{reasons[job.error]||job.error}</p>}</div><button className="text-button" onClick={()=>onEvidence(job.input_evidence_id)}>输入快照 · {job.input_snapshot_hash.slice(0,12)}</button></div>)}</details>;
}
