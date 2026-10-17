import {useCallback, useEffect, useRef, useState} from 'react';
import {api, type Run} from './api';

export type FeedbackState='draft'|'confirmed'|'cancelled';
export type SectionKey='task'|'failures'|'rca'|'evidence'|'guidance'|'verification';

export const sectionOrder:SectionKey[]=['task','failures','rca','evidence','guidance','verification'];
// Editing never deletes the auto-generated factual indexes; only section text is editable.
export const editableSections:SectionKey[]=['task','rca','guidance','verification'];

export interface FeedbackSection {
  key:SectionKey;title:string;text:string;
  items?:Array<Record<string,unknown>>;
  status?:string;
}
export interface TruncationEntry {section:string;field:string;original_bytes:number;kept_bytes:number;reason:string}
export interface Truncation {
  applied:boolean;policy:string;max_rendered_bytes:number;
  items:TruncationEntry[];omissions:Array<Record<string,unknown>>;
}
export interface Redaction {applied:boolean;matches:number;rules:string[]}
export interface ContentRef {artifact_id:string;evidence_id:string;filename:string;kind:string;sha256:string}
export interface FeedbackRecord {
  schema_version:string;feedback_id:string;from_run_id:string;to_run_id:string|null;
  task_id:string;source_diagnosis_id:string|null;iteration_source:string;
  state:FeedbackState;goal_hash:string;from_run_snapshot_hash:string|null;
  sections:Record<SectionKey,FeedbackSection>;rendered_text:string;content_sha256:string;
  truncation:Truncation;redaction:Redaction;data_quality:string[];
  unresolved_refs:Array<Record<string,unknown>>;
  content_ref:ContentRef|null;delivery:unknown;
  created_at:string;updated_at:string;confirmed_at:string|null;cancelled_at:string|null;cancel_reason:string|null;
}
export interface FeedbackList {items:FeedbackRecord[];total:number}

export const feedbackStateNames:Record<FeedbackState,string>={
  draft:'草稿 · 可编辑',confirmed:'已确认锁定',cancelled:'已取消',
};

export function listFeedback(runId:string):Promise<FeedbackList> {
  return api<FeedbackList>(`/runs/${runId}/feedback?limit=50`);
}
export function createFeedbackDraft(runId:string,sourceDiagnosisId:string|null):Promise<FeedbackRecord> {
  return api<FeedbackRecord>(`/runs/${runId}/feedback/drafts`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({request_id:crypto.randomUUID(),...(sourceDiagnosisId?{source_diagnosis_id:sourceDiagnosisId}:{})}),
  });
}
export function editFeedback(feedbackId:string,sections:Partial<Record<SectionKey,string>>):Promise<FeedbackRecord> {
  const payload=Object.fromEntries(Object.entries(sections).map(([key,text])=>[key,{text}]));
  return api<FeedbackRecord>(`/feedback/${feedbackId}`,{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({sections:payload}),
  });
}
export function confirmFeedback(feedbackId:string,contentSha256:string):Promise<FeedbackRecord> {
  return api<FeedbackRecord>(`/feedback/${feedbackId}/confirm`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content_sha256:contentSha256}),
  });
}
export function cancelFeedback(feedbackId:string,reason:string):Promise<FeedbackRecord> {
  return api<FeedbackRecord>(`/feedback/${feedbackId}/cancel`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason}),
  });
}

export function useFeedback(run:Run) {
  const [records,setRecords]=useState<FeedbackRecord[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const alive=useRef(true),locked=useRef(false);

  const refresh=useCallback(async ()=>{
    const items=await listFeedback(run.run_id);
    if(!alive.current)return items;
    setRecords(items.items);
    setSelectedId(current=>current??(items.items[0]?.feedback_id??null));
    return items;
  },[run.run_id]);

  useEffect(()=>{
    alive.current=true;
    setLoading(true);
    listFeedback(run.run_id).then(items=>{if(alive.current){setRecords(items.items);setSelectedId(items.items[0]?.feedback_id??null);setError('');}})
      .catch(e=>{if(alive.current)setError((e as Error).message);})
      .finally(()=>{if(alive.current)setLoading(false);});
    return()=>{alive.current=false;};
  },[run.run_id]);

  async function perform(action:()=>Promise<FeedbackRecord|FeedbackList|void>) {
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');
    try {await action();}
    catch(e){if(alive.current)setError((e as Error).message);}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  const create=(sourceDiagnosisId:string|null)=>perform(async()=>{
    const record=await createFeedbackDraft(run.run_id,sourceDiagnosisId);
    if(!alive.current)return;
    setRecords(items=>[record,...items.filter(item=>item.feedback_id!==record.feedback_id)]);
    setSelectedId(record.feedback_id);
  });
  const saveEdit=(feedbackId:string,key:SectionKey,text:string)=>perform(async()=>{
    const record=await editFeedback(feedbackId,{[key]:text});
    if(alive.current)setRecords(items=>items.map(item=>item.feedback_id===feedbackId?record:item));
  });
  const confirm=(record:FeedbackRecord)=>perform(async()=>{
    try {
      const updated=await confirmFeedback(record.feedback_id,record.content_sha256);
      if(!alive.current)return;
      setRecords(items=>items.map(item=>item.feedback_id===updated.feedback_id?updated:item));
    } catch(e) {
      // The preview hash can only change through another edit session; reload and ask to re-check.
      if(/反馈预览已变化|不能重复确认/.test((e as Error).message))await refresh();
      throw e;
    }
  });
  const cancel=(feedbackId:string,reason:string)=>perform(async()=>{
    const record=await cancelFeedback(feedbackId,reason);
    if(alive.current)setRecords(items=>items.map(item=>item.feedback_id===feedbackId?record:item));
  });

  const selected=records.find(item=>item.feedback_id===selectedId)||null;
  const eligible=!['running','unknown'].includes(run.execution_status);
  const hasFailureSignals=run.outcome_status==='failed'||run.execution_status==='failed'||run.failed_tool_count>0;
  return {records,selected,select:setSelectedId,loading,error,busy,eligible,hasFailureSignals,create,saveEdit,confirm,cancel};
}
export type FeedbackModel=ReturnType<typeof useFeedback>;
