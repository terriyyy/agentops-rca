import {useEffect,useRef,useState} from 'react';
import {api,type Diagnosis,type Run} from './api';
import type {Capabilities,Job,Preview} from './diagnosis';

// One per-Run lifecycle shared by the toolbar, panels and resources.
// Reading records never starts localization or a model job.
export function useRunAnalysis(run:Run) {
  const [reports,setReports]=useState<Diagnosis[]>([]),[reportError,setReportError]=useState(''),[loading,setLoading]=useState(true);
  const [caps,setCaps]=useState<Capabilities|null>(null),[jobs,setJobs]=useState<Job[]>([]);
  const [pollError,setPollError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<Preview|null>(null),[revision,setRevision]=useState(0),[selectedId,setSelectedId]=useState<string|null>(null);
  const alive=useRef(true),locked=useRef(false),requestId=useRef<string|null>(null),analystRequestId=useRef<string|null>(null);
  const projection=JSON.stringify(run.insight?.diagnosis||{});
  useEffect(()=>{
    alive.current=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let previous='';
    async function poll(){
      try{
        const [capabilities,items]=await Promise.all([api<Capabilities>('/diagnosis/capabilities',{signal:controller.signal}),api<Job[]>(`/runs/${run.run_id}/diagnosis-jobs`,{signal:controller.signal})]);
        if(controller.signal.aborted)return;
        setCaps(capabilities);setJobs(items);setPollError('');
        const signature=items.map(job=>`${job.job_id}:${job.state}`).join(',');
        if(signature!==previous){previous=signature;setRevision(value=>value+1);}
      }catch(e){if(!controller.signal.aborted)setPollError((e as Error).message);}
      if(!controller.signal.aborted)timer=setTimeout(poll,2000);
    }
    void poll();return()=>{alive.current=false;controller.abort();clearTimeout(timer);};
  },[run.run_id]);
  useEffect(()=>{
    const controller=new AbortController();
    api<Diagnosis[]>(`/runs/${run.run_id}/diagnoses`,{signal:controller.signal}).then(items=>{setReports(items);setReportError('');setLoading(false);}).catch(e=>{if(!controller.signal.aborted){setReportError((e as Error).message);setLoading(false);}});
    return()=>controller.abort();
  },[run.run_id,projection,revision]);
  const featuredId=run.insight?.diagnosis.featured_report?.diagnosis_id;
  const selected=reports.find(report=>report.diagnosis_id===(selectedId||featuredId))||reports.find(report=>report.diagnosis_id===featuredId)||reports[0]||null;
  const active=jobs.find(job=>['queued','running'].includes(job.state)),projectedJob=run.insight?.diagnosis.latest_job;
  const activeJob=active||(['queued','running'].includes(projectedJob?.state||'')?projectedJob:null);
  const latestJob=jobs[0]||projectedJob;
  const eligible=!['running','unknown'].includes(run.execution_status)&&(run.origin!=='live'||run.capture_integrity==='complete');
  const analystReady=['configured','last_call_succeeded','last_call_failed'].includes(caps?.analyst||'');
  const hgtDone=jobs.some(job=>job.mode==='offline_hgt'&&job.state==='succeeded');
  const canLocate=eligible&&caps?.hgt==='ready'&&!activeJob&&!busy,canPreview=eligible&&caps?.hgt==='ready'&&hgtDone&&analystReady&&!activeJob&&!busy;
  const actionLabel=activeJob?(activeJob.mode==='analyst_rca'?'正在分析原因':'正在定位异常'):reports.some(r=>r.mode==='analyst_rca')?'查看原因分析':reports.some(r=>r.origin==='imported')?'查看历史分析':hgtDone||reports.some(r=>r.origin==='recomputed')?'继续分析原因':run.outcome_status==='failed'||run.execution_status==='failed'||run.failed_tool_count>0?'分析失败原因（RCA）':'分析本次运行（RCA）';
  async function perform(action:()=>Promise<void>){
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    try{await action();}catch(e){if(alive.current)setError((e as Error).message);}finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  function start(){if(!canLocate)return;void perform(async()=>{
    requestId.current ||= crypto.randomUUID();
    const job=await api<Job>(`/runs/${run.run_id}/diagnosis-jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:requestId.current})});
    if(!alive.current)return;requestId.current=null;setPreview(null);setJobs(items=>[job,...items.filter(item=>item.job_id!==job.job_id)]);setRevision(value=>value+1);
  });}
  function showPreview(){if(!canPreview)return;void perform(async()=>{
    setPreview(null);analystRequestId.current=null;const result=await api<Preview>(`/runs/${run.run_id}/analyst-preview`);if(alive.current)setPreview(result);
  });}
  function closePreview(){setPreview(null);analystRequestId.current=null;}
  function startAnalyst(){if(!preview||!canPreview)return;const snapshot=preview;void perform(async()=>{
    analystRequestId.current ||= crypto.randomUUID();
    try{
      const job=await api<Job>(`/runs/${run.run_id}/analyst-jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:analystRequestId.current,preview_sha256:snapshot.preview_sha256,hgt_diagnosis_id:snapshot.hgt_diagnosis_id})});
      if(!alive.current)return;analystRequestId.current=null;setPreview(null);setJobs(items=>[job,...items.filter(item=>item.job_id!==job.job_id)]);setRevision(value=>value+1);
    }catch(e){if(alive.current&&/预览已变化|同快照|重新.*定位/.test((e as Error).message)){setPreview(null);analystRequestId.current=null;}throw e;}
  });}
  function cancel(id:string){void perform(async()=>{
    const job=await api<Job>(`/diagnosis-jobs/${id}/cancel`,{method:'POST'});if(alive.current){setJobs(items=>items.map(item=>item.job_id===id?job:item));setRevision(value=>value+1);}
  });}
  return {reports,reportError,loading,caps,jobs,pollError,error,busy,preview,selected,selectReport:setSelectedId,activeJob,latestJob,eligible,hgtDone,analystReady,canLocate,canPreview,actionLabel,start,showPreview,closePreview,startAnalyst,cancel};
}
export type RunAnalysis=ReturnType<typeof useRunAnalysis>;
