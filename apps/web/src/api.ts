export interface Run {
  run_id: string; task_id: string; external_run_id: string; attempt_index: number;
  raw_attempts: unknown[]; execution_status: string; source_final_status: string;
  report_ok: boolean | null; outcome_status: string; model_status: string; origin: string; adapter_version?: string;
  source_algorithm: string; sample_kind: string; event_count: number; tool_call_count: number;
  failed_tool_count: number; confirmed_pairs: number; intervention_count: number;
  warnings: string[]; created_at: string; snapshot_hash: string | null;
  capture_status?: string; capture_integrity?: string; exit_code?: number | null;
  ended_at?: string | null; dropped_events?: number; last_seen_at?: string;
  feedback: { text: string; evidence_id: string } | null;
  artifacts: {kind: string; filename: string; sha256: string}[];
  task_goal?: string; task_external_id?: string;
  insight?: RunInsight;
}
export interface FailureSignal {kind:string;title:string;event_id:string|null;evidence_id:string|null;event_kind?:string;error_signature?:string|null}
export interface DiagnosisSnapshot {
  state:string;report_count:number;report_kinds:string[];
  featured_report:{diagnosis_id:string;kind:string;summary:string;origin:string}|null;
  latest_job:{job_id:string;mode:string;state:string;error:string|null}|null;
}
export interface RunInsight {diagnosis:DiagnosisSnapshot;failure_signals:FailureSignal[];attention_reasons:string[]}
export type HomeSource='live'|'imported'|'synthetic'|'all';
export interface HomeSample {run_id:string;goal:string;created_at:string;origin:string;sample_kind:string;outcome_status:string;tokens:number|null;responses:number;with_total:number}
export interface HomeSummary {
  source:HomeSource;running:number;attention:number;total_runs:number;all_runs:number;
  sample:{limit:number;count:number;items:HomeSample[]};
  tokens:{value:number|null;responses:number;with_total:number;uncertain_events:number};
  feedback:{run:Run;events:number;tools:{observed:number;paired:number;failed:number;unpaired_calls:number};model_responses:number;with_total:number;outcomes:number}|null;
}
export interface WorkbenchOverview {running:Run[];attention:Run[];recent:Run[];summary?:HomeSummary}
export interface ModelUsage {input_tokens:number|null;output_tokens:number|null;total_tokens:number|null;source:string;total_derived:boolean;warnings:string[]}
export interface ModelCall {event_id:string;evidence_id:string|null;start_event_id:string|null;end_event_id:string|null;position:number;state:string;response_only:boolean;model:string|null;duration_ms:number|null;usage:ModelUsage|null}
export interface RunMetrics {
  run_id:string;event_count:number;in_progress:boolean;time:{recorded_ms:number|null;timed_events:number};
  llm:{observed:number;completed:number;pending:number;failed:number;response_only:number;ambiguous_events:number;unclassified_events:number;calls:ModelCall[]};
  tokens:{input:{value:number|null;responses:number};output:{value:number|null;responses:number};total:{value:number|null;responses:number};with_usage:number;responses:number;conflicting_responses:number};
  tools:{observed:number;paired:number;failed:number;unpaired_calls:number};
}
export interface Task { id: string; namespace: string; external_id: string; goal: string; sample_kind: string; runs: Run[]; outcome_status?: string }
export interface TraceEvent {
  source_span_id?: string | null; parent_source_id?: string | null;
  event_id: string; kind: string; name: string; position: number; line: number; occurred_at: string | null;
  input: unknown; output: unknown; tool_status: string; evidence_id: string; correlation_id: string | null;
  error_signature: string | null; duration_ms: number | null;
}
export interface Ref {evidence_id: string; resolution_status: string; event_id: string | null; label: string}
export interface Diagnosis {
  input_snapshot_hash?: string; input_evidence_id?: string; prompt_evidence_id?: string; prompt_sha256?: string; hgt_sha256?: string; provenance?: Record<string,unknown>; created_at?: string;
  mode?: string; verification_suggestion?: string; boundary?: string; evidence_chain?: {claim:string;resolution_status:string}[];
  usage?: {prompt_tokens?:number;completion_tokens?:number}|null; model_confidence_uncalibrated?:number;
  diagnosis_id: string; format: string; model_status: string; model_reason: string | null;
  summary: string; origin: string; source_algorithm: string; raw_evidence_id: string;
  findings: {title: string; severity: string; description: string; evidence: Ref[]}[];
  graph: {macro_nodes?: Record<string, unknown>[]; micro_nodes?: Record<string, unknown>[]; edges?: Record<string, unknown>[]; statistics?: Record<string, unknown>} | null;
  runtime_memory: unknown; guidance: string | null;
}
export interface Outcome {outcome_id: string; status: string; source: string; basis: unknown; summary: string; authoritative: boolean; evidence_id: string; reward: number | null; source_kind?:string; verification_origin?:string; observed_at?:string|null}
export interface Evidence {evidence_id: string; filename: string; line: number | null; json_pointer: string | null; resolution_status: string; sha256: string; content: unknown; event_id: string | null}
export interface ImportResult {import_id: string; task_id: string; run_ids: string[]; duplicate: boolean; warnings: string[]; created_at: string; manifest: {task_id: string; sample_kind: string; source_namespace: string}}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '请求失败，请检查导入文件或稍后重试');
  return value as T;
}
export function pretty(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '—'; }
export const outcomeNames: Record<string, string> = {passed:'验收通过', failed:'验收未通过', unknown:'验收未知'};
export const executionNames: Record<string, string> = {completed:'执行完成', failed:'执行失败', running:'执行中', cancelled:'已取消', unknown:'执行状态未知'};
export const diagnosisNames: Record<string,string> = {none:'尚未诊断',running:'诊断作业进行中',hypothesis:'已有待验证根因假设',localization:'已有定位线索',historical:'附带历史报告',failed:'最近诊断作业失败'};
export const attentionNames: Record<string,string> = {execution_failed:'执行异常',task_failed:'任务验收未通过',capture_incomplete:'采集不完整',diagnosis_job_failed:'最近诊断作业失败'};
export const modelNames: Record<string,string> = {ready:'历史模型已加载', unavailable:'历史模型不可用', degraded:'历史模型降级', unknown:'历史模型未声明'};
export const warningNames: Record<string,string> = {
  attempt_overridden_by_manifest:'轮次由导入清单确定，保留原始 attempt', report_ok_differs_from_outcome:'报告 ok 与任务验收结果不一致',
  outcome_conflict:'同级验收证据冲突，结果标为未知', outcome_sources_disagree:'不同来源的验收结果存在差异',
  outcome_missing:'缺少任务验收记录', diagnosis_missing:'来源未提供诊断报告',
  diagnosis_evidence_unresolved:'部分诊断引用无法定位到事件', diagnosis_evidence_ambiguous:'部分诊断引用对应多个候选事件',
  missing_correlation_id:'部分调用缺少关联 ID', call_return_unresolved:'存在未配对的调用或返回', call_return_ambiguous:'调用关联 ID 重复，未强制配对',
  duplicate_source_span_id:'源事件 ID 重复', timestamp_timezone_missing:'部分时间戳未提供时区', timestamp_missing_or_invalid:'部分时间戳缺失或无效', tool_status_conflict:'工具 ok 与退出码冲突，保留原始证据',
};
