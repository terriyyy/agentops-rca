import {useEffect,useState} from 'react';
import type {Run} from './api';

export function useLiveRun(initial:Run|null) {
  const [latest,setLatest]=useState<Run|null>(null);
  const [connection,setConnection]=useState('connecting');
  const id=initial?.origin==='live'?initial.run_id:null;
  useEffect(()=>{
    if(!id)return;
    setConnection('connecting');
    const source=new EventSource('/api/runs/'+id+'/stream');
    const update=(event:MessageEvent)=>{setLatest(JSON.parse(event.data));setConnection('connected');};
    source.addEventListener('update',update);
    source.addEventListener('status',update);
    source.onerror=()=>setConnection('reconnecting');
    return()=>source.close();
  },[id]);
  // SSE carries the changing raw Run. The read-only investigation projection
  // comes from the periodically refreshed detail response.
  const run:Run|null=initial&&latest?.run_id===initial.run_id
    ? {...initial,...latest,insight:initial.insight,task_goal:initial.task_goal,task_external_id:initial.task_external_id}
    : initial;
  return {run,connection};
}
