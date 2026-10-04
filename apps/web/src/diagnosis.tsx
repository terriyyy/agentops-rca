import {useEffect,useRef} from 'react';
import {Loader2,Search,Sparkles} from 'lucide-react';
import {pretty,type Run} from './api';
import type {RunAnalysis} from './run-analysis';

export interface Capabilities {status:string;hgt:string;analyst:string;model?:string|null;reason:string}
export interface Job {job_id:string;mode:string;state:string;error:string|null;input_snapshot_hash:string;input_evidence_id:string;created_at:string}
export interface Preview {prompt:unknown;prompt_sha256:string;preview_sha256:string;prompt_bytes:number;hgt_diagnosis_id:string;model:string;provider:string;truncated:boolean}
const labels:Record<string,string>={queued:'等待运行',running:'运行中',succeeded:'完成',failed:'未完成',cancelled:'已取消',timed_out:'超时',interrupted:'已中断'};
const reasons:Record<string,string>={provider_http_401:'模型密钥无效或已过期',provider_http_403:'当前密钥无权使用该模型',provider_http_429:'模型服务达到调用配额',provider_timeout:'模型服务响应超时',provider_error:'模型服务暂不可用',invalid_model_output:'模型回复格式无法解析',invalid_turning_point:'模型引用了不存在的转换',incomplete_plan:'模型未提供完整的分析计划',prompt_mismatch:'发送预览与作业内容不一致',source_hash_mismatch:'算法源码校验失败',worker_failed:'诊断进程失败，请查看本机日志'};
export const jobReason=(value:string)=>reasons[value]||value;

export function DiagnosisControls({run,analysis}:{run:Run;analysis:RunAnalysis}) {
  const a=analysis;
  const previewRef=useRef<HTMLElement>(null);
  useEffect(()=>{if(a.preview)previewRef.current?.scrollIntoView({block:'nearest'});},[a.preview?.preview_sha256]);
  const unavailable=!a.eligible?(['running','unknown'].includes(run.execution_status)?'执行结束且状态明确后，才能开始分析。':'现场采集完整后，才能开始分析。'):a.caps?.hgt!=='ready'?(a.caps?'本机定位环境尚未就绪。':'正在检查分析环境…'):!a.hgtDone?'先完成本机定位，再预览模型发送内容。':!a.analystReady?'模型分析未配置或暂不可用；已有记录仍可查看。':null;
  return <section className={'diagnosis-controls'+(a.preview?' has-preview':'')} aria-label="分析本次运行">
    {!a.preview&&<>
      <div className="analysis-action-heading"><strong>{a.activeJob?'作业进行中':a.hgtDone?'继续原因分析':'开始原因分析'}</strong><span>手动启动</span></div>
      {a.activeJob?<div className="analysis-active" role="status"><Loader2 size={15} className="spin"/><strong>{a.activeJob.mode==='analyst_rca'?'原因分析':'异常定位'} · {labels[a.activeJob.state]||a.activeJob.state}</strong><button className="text-button" disabled={a.busy} onClick={()=>a.cancel(a.activeJob!.job_id)}>取消作业</button></div>:<div className="analysis-action-buttons">
        <button className={'button'+(!a.hgtDone?' primary':' secondary')} disabled={!a.canLocate} onClick={a.start}><Search size={14}/>{a.hgtDone?'重新定位异常步骤（本机）':'定位异常步骤（本机）'}</button>
        <button className={'button'+(a.hgtDone?' primary':' secondary')} disabled={!a.canPreview} onClick={a.showPreview}><Sparkles size={14}/>预览并分析原因</button>
      </div>}
      <p className="analysis-action-note" role="status">{unavailable||'先预览实际发送内容；人工确认后才会调用模型。'}{a.caps&&!a.analystReady&&!unavailable?.includes('模型分析未配置')?' 模型分析未配置或暂不可用。':''}</p>
      {a.latestJob&&['failed','timed_out','interrupted','cancelled'].includes(a.latestJob.state)&&!a.activeJob&&<p className="analysis-job-error" role="status">最近一次分析{labels[a.latestJob.state]}。{a.reports.length>0?'已有报告仍保留。':''}{a.latestJob.error?jobReason(a.latestJob.error):''}</p>}
    </>}
    {(a.error||a.pollError)&&<p role="alert">{a.error||a.pollError}</p>}
    {a.preview&&<section ref={previewRef} className="analyst-preview" aria-label="模型发送预览"><div className="preview-heading"><div><span>人工确认后发送</span><strong>{a.preview.model}</strong></div><button className="text-button" onClick={a.closePreview}>关闭预览</button></div><div className="preview-scroll"><p>{a.preview.provider} · {a.preview.prompt_bytes.toLocaleString('zh-CN')} 字节 · {a.preview.truncated?'候选片段已截断':'候选片段完整'}</p><details open><summary>实际发送内容 · 请在确认前核对</summary><pre>{pretty(a.preview.prompt)}</pre></details><details><summary>发送快照与校验</summary><dl><dt>Preview SHA-256</dt><dd>{a.preview.preview_sha256}</dd><dt>Prompt SHA-256</dt><dd>{a.preview.prompt_sha256}</dd><dt>定位报告 ID</dt><dd>{a.preview.hgt_diagnosis_id}</dd></dl></details></div><div className="preview-confirm"><p>确认后产生一次模型调用。建议的检查尚未执行；取消已送达服务商的调用仍可能计费。</p><button className="button primary" disabled={!a.canPreview} onClick={a.startAnalyst}>确认发送并开始分析</button></div></section>}
  </section>;
}

export function DiagnosisJobHistory({jobs,onEvidence}:{jobs:Job[];onEvidence:(id:string)=>void}) {
  return <details className="technical-group"><summary>HGT / RCA 作业历史 <span>{jobs.length}</span></summary>{!jobs.length&&<p className="muted">尚无本轮诊断作业。</p>}{jobs.map(job=><div className="diagnosis-job" key={job.job_id}><div><strong>{job.mode==='analyst_rca'?'RCA':'HGT'} · {labels[job.state]||job.state}</strong><span className="muted"> · {new Date(job.created_at).toLocaleString('zh-CN')}</span>{job.error&&<p>{jobReason(job.error)}</p>}</div><button className="text-button" onClick={()=>onEvidence(job.input_evidence_id)}>输入快照 · {job.input_snapshot_hash.slice(0,12)}</button></div>)}</details>;
}
