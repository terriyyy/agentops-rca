import type {TraceEvent} from './api';

export type TraceRow = {id:string;kind:'tool_span';call:TraceEvent;returned:TraceEvent;events:TraceEvent[];position:number;name:string} | {id:string;kind:'event';event:TraceEvent;events:TraceEvent[];position:number;name:string};
export const rowPrimary = (row:TraceRow) => row.kind==='tool_span'?row.call:row.event;
export const rowFailure = (row:TraceRow) => row.events.some(isFailure);
export const rowDuration = (row:TraceRow) => row.kind==='tool_span'?(row.returned.duration_ms??(callInterval(row.call,row.returned)?eventTime(row.returned)!-eventTime(row.call)!:null)):(row.event.duration_ms??null);

export const isFailure = (event:TraceEvent) => event.tool_status==='failed'||!!event.error_signature;
export const kindLabel = (kind:string) => ({tool_call:'Tool · 调用',tool_return:'Tool · 返回',llm:'LLM',log:'Log',event:'Event',agent:'Agent',verification:'Validation'} as Record<string,string>)[kind]||kind;
export function durationLabel(ms:number|null|undefined) {
  if(ms==null||!Number.isFinite(ms)||ms<0)return '—';
  if(ms>=1000)return `${(ms/1000).toFixed(2)} s`;
  if(ms>0&&ms<1)return `${ms.toFixed(2)} ms`;
  return `${ms<10?Number(ms.toFixed(1)):Math.round(ms)} ms`;
}
// A timezone is required. Imported timestamps are never replaced by import time.
export function eventTime(event:TraceEvent) {
  const value=event.occurred_at;
  if(!value||!/(Z|[+-]\d{2}:?\d{2})$/i.test(value))return null;
  const time=Date.parse(value);return Number.isFinite(time)?time:null;
}
export function callInterval(event:TraceEvent,pair:TraceEvent|undefined) {
  if(event.kind!=='tool_call'||!pair)return null;
  const start=eventTime(event),end=eventTime(pair);
  if(start===null||end===null||end<=start)return null;
  // Inconsistent historical timestamps must not produce a confident duration bar.
  if(pair.duration_ms!=null&&Math.abs(end-start-pair.duration_ms)>Math.max(10,pair.duration_ms*.2))return null;
  return {start,end};
}
// The visible page uses a linear window over its recorded event times. A paired
// tool's return is part of that window even though it shares one UI row.
export function pageTimeWindow(rows:TraceRow[],runStart:number|null,runEnd:number|null) {
  const times=rows.flatMap(row=>row.events.map(eventTime).filter((time):time is number=>time!==null));
  if(times.length<2)return {start:runStart,end:runEnd,scope:'run' as const};
  const start=Math.min(...times),end=Math.max(...times);
  return end>start?{start,end,scope:'page' as const}:{start:runStart,end:runEnd,scope:'run' as const};
}
// Tick positions use the displayed window, while labels remain relative to the
// beginning of the entire Run. Zooming therefore never resets the Run clock.
export function timelineTicks(start:number|null,end:number|null,origin:number|null=start) {
  if(start===null||end===null||end<=start)return [];
  const range=end-start,rough=Math.max(1,range/4),power=10**Math.floor(Math.log10(rough));
  const step=([1,2,5,10].find(factor=>factor*power>=rough)||10)*power;
  const base=origin??start,firstOffset=Math.ceil((start-base)/step)*step;
  const count=Math.min(6,Math.floor((end-base-firstOffset)/step)+1);
  return Array.from({length:count},(_,index)=>{
    const offset=firstOffset+index*step,seconds=offset/1000;
    const label=offset===0?'0 ms':offset>=1000?`${Number.isInteger(seconds)?seconds:Number(seconds.toFixed(Math.max(0,3-Math.floor(Math.log10(step)))))} s`:`${Math.round(offset)} ms`;
    return {offset,percent:(base+offset-start)/range*100,label};
  });
}
export function objectValue(value:unknown):Record<string,unknown> {
  if(typeof value==='string'){try{return objectValue(JSON.parse(value));}catch{return {};}}
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}
export function traceModel(events:TraceEvent[]) {
  const ids=new Map<string,TraceEvent[]>();const correlations=new Map<string,TraceEvent[]>();
  for(const event of events){
    if(event.source_span_id)ids.set(event.source_span_id,[...(ids.get(event.source_span_id)||[]),event]);
    if(event.correlation_id)correlations.set(event.correlation_id,[...(correlations.get(event.correlation_id)||[]),event]);
  }
  const pairs=new Map<string,TraceEvent>();
  for(const group of correlations.values()){
    const calls=group.filter(e=>e.kind==='tool_call'),returns=group.filter(e=>e.kind==='tool_return');
    if(calls.length===1&&returns.length===1&&calls[0].name===returns[0].name&&calls[0].position<returns[0].position&&
      !(calls[0].parent_source_id&&returns[0].parent_source_id&&calls[0].parent_source_id!==returns[0].parent_source_id)){
      pairs.set(calls[0].event_id,returns[0]);pairs.set(returns[0].event_id,calls[0]);
    }
  }
  const parent=new Map<string,string>();let reliable=true;
  for(const event of events){
    if(!event.parent_source_id)continue;
    const candidates=ids.get(event.parent_source_id)||[];
    if(candidates.length!==1||candidates[0].event_id===event.event_id){reliable=false;continue;}
    parent.set(event.event_id,candidates[0].event_id);
  }
  for(const id of parent.keys()){
    const seen=new Set([id]);let current=parent.get(id);
    while(current){if(seen.has(current)){reliable=false;break;}seen.add(current);current=parent.get(current);}
  }
  const rows:TraceRow[]=[];const rowForEvent=new Map<string,string>();
  for(const event of events){
    if(rowForEvent.has(event.event_id))continue;
    const returned=event.kind==='tool_call'?pairs.get(event.event_id):null;
    const row:TraceRow=returned&&returned.kind==='tool_return'
      ?{id:event.event_id,kind:'tool_span',call:event,returned,events:[event,returned],position:event.position,name:event.name}
      :{id:event.event_id,kind:'event',event,events:[event],position:event.position,name:event.name};
    rows.push(row);for(const item of row.events)rowForEvent.set(item.event_id,row.id);
  }
  const rowParent=new Map<string,string>();
  if(reliable)for(const row of rows){const parentId=parent.get(rowPrimary(row).event_id);const mapped=parentId&&rowForEvent.get(parentId);if(mapped&&mapped!==row.id)rowParent.set(row.id,mapped);}
  const times=events.map(eventTime).filter((time):time is number=>time!==null);
  const start=times.length?Math.min(...times):null,end=times.length?Math.max(...times):null;
  return {pairs,rows,rowForEvent,rowParent,parent:reliable?parent:new Map<string,string>(),hasTree:reliable&&rowParent.size>0,
    start,end,hasTimeline:start!==null&&end!==null&&end>start,timeCount:times.length};
}
