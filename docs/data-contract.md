# 核心数据契约草案 v0.1

状态：V0.1 已落地导入清单、Run、事件、证据、诊断和验收模型。导入清单的可执行校验位于 `apps/api/contracts.py`，导出的 JSON Schema 位于 `packages/contracts/import-manifest.schema.json`。所有导入均标记契约／适配器版本，源字段不直接改写。

实现收敛：Project 在首版为默认本地工作区；历史反馈嵌入 Run，链接和事件等子记录继承 Run 的契约版本。附件原始 UTF-8 文本（含 BOM／原始换行）存入 SQLite，以原字节 SHA-256 追溯；导入清单按规范化 JSON 加文件哈希确定幂等包标识。

限制：单次请求最多32 MiB、单文件10 MiB、最多10轮、40个数据文件、每轮20,000事件。只接受普通文件名，不接收压缩包或服务器文件路径。数据包全部完成校验／插入后一次事务提交；任一轮失败则整体回滚。错误通过 HTTP 返回，不保留半完成任务。

| 对象 | 核心字段 | 关系与约束 |
|---|---|---|
| Project | project_id, name | 首版允许默认项目 |
| TaskExecution | task_id, project_id, external_task_id, goal | 表示同一任务目标；多次尝试共享 |
| Run | run_id, task_id, attempt_index, attempt_source, raw_attempt, parent_run_id, execution_status | 一次执行；attempt_index 与原始 attempt 分开 |
| ImportRecord | import_id, importer_version, source_namespace, package_hash, status, warnings | 去重及来源；不同实验不能仅按任务名合并 |
| Artifact | artifact_id, run_id, kind, sha256, storage_key, encoding, source_label | API 暴露内部 ID，不接受任意主机路径 |
| Event | event_id, run_id, source_span_id, seq, occurred_at, kind, name, parent_source_id, correlation_id, input, output, tool_status, raw_ref | event_id 是平台 ID；源 ID 可能重复或缺失 |
| CorrelationLink | link_id, run_id, from_event_id, to_event_id, relation, basis, status | basis=explicit_id/explicit_parent；status=confirmed/ambiguous/unresolved |
| OutcomeEvidence | outcome_id, run_id, source, status, basis, observed_at, evidence_ref, verification_origin | 状态 passed/failed/unknown；来源 imported/evaluated 区分 |
| DiagnosisReport | diagnosis_id, run_id, origin, source_algorithm, adapter_version, engine_version, input_snapshot_hash, model_status, findings, graph_ref, raw_ref | origin=imported/recomputed；同一 Run 可有多份 |
| EvidenceRef | evidence_id, artifact_id, locator, event_id, resolution_status | locator 为行号范围、JSON Pointer 等；引用需存在性检查 |
| FeedbackRecord | feedback_id, from_run_id, to_run_id, source_diagnosis_id, content_ref | 历史反馈与实际注入分开，不把计划视为执行 |

2026-09-20：V0.2 已追加 capture_sessions、live_receipts 和 live_changes 表（SQLite user_version=2），保留 v0.1 历史导入契约。可执行现场契约位于 `apps/api/live_contracts.py`，导出为 `packages/contracts/live.schema.json`。现场 Run／会话身份由 URL 与会话凭据绑定；事件信封不重复接受可冲突的 run_id/session_id。生产者序号与服务端游标分开，finish 声明最终序号范围，完整后生成快照。详细限制见 [接入说明](v0.2-agent-integration.md)。V0.3 再追加 DiagnosisJob；VerificationRun 的自动编排与受控重试留待后续。

## 状态与事实优先级

- `execution_status`：unknown/running/completed/failed/cancelled，说明宿主执行状况；Submitted 保存为源终止原因。
- `tool_status`：unknown/succeeded/failed，保留原 ok、returncode 等冲突字段。
- `OutcomeEvidence.status`：passed/failed/unknown；missing 规范为 unknown。
- `model_status`：ready/degraded/unavailable/unknown，与任务验收无关。
- 多条验收存在冲突时，按适配器明确的评价依据选定主结果并保留其他证据；规则不明确则显示冲突／unknown。
- 历史 SWE-bench 的 outcome_history 是导入的验收记录，不等于平台新执行测试。τ 场景按 reward_basis 解释结果，不能把 failed_action_checks 非空当最终失败。

## 标识、幂等与引用

导入清单显式给出 `source_namespace + external_task_id + external_run_id/attempt_index`，并记录数据包哈希。相同导入重复执行应返回已有对象；同名任务来自不同实验时不自动合并。源文件的同一轮副本按内容与清单关系去重，不按文件名猜测。

原始文件保持不可变，规范化结果记录 adapter_version；重新诊断绑定输入快照。文件丢失、行号越界或 TU 无映射均保存 unresolved，不伪造证据链接。

四条抽查轨迹的原 attempt 均为 0，证明不能依赖该字段识别轮次。导入清单或迭代目录作为 attempt_index 的依据，并在 attempt_source 中注明。

## 前端展示要求

始终区分源记录、规范化解释、模型诊断。超长输出分页／折叠；时间戳缺失或时区未知保留质量告警；不得把未记录值展示为 0 或成功。图中的 temporal/shared-artifact 边保留关系名，不统一标成因果边。


## V0.3 诊断作业与报告

DiagnosisJob：job_id、run_id、request_id（同 Run 幂等）、state（queued/running/succeeded/failed/cancelled/timed_out/interrupted）、created_at、finished_at、error、diagnosis_id、input_snapshot_hash、input_evidence_id、mode=offline_hgt。首版全局单作业，结束后不覆盖历史结果。

重算 DiagnosisReport 新增 origin=recomputed、job_id、created_at、input_snapshot_hash、input_evidence_id、provenance（adapter_version、源码/权重/manifest SHA-256、依赖版本、mode、analyst、network）。model_status=ready 仅指 HGT 已加载；能力接口整体仍为 degraded。Findings 的每个模型 event_id 回到原始 EvidenceRef，不可解析则显式 unresolved。任务 Outcome 不因模型报告改变。

## V0.3 analyst RCA 扩展

`DiagnosisJob.mode=analyst_rca`，沿用原作业状态机与同 Run 的 request_id 幂等键；新增 `hgt_diagnosis_id`、`hgt_sha256`、`prompt_sha256`、`preview_sha256`、`prompt_evidence_id`、`model`。请求必须回传预览哈希及选定 HGT 报告 ID，服务端重新计算后才发出模型调用。一次作业只允许一个请求，重启后 interrupted 不自动重发。

`DiagnosisReport.format=agenttether-analyst`、`analysis_status=complete` 表示结构化 analyst 响应通过 ID 校验，**不表示根因已得到测试证明**。新增 `verification_suggestion`、`boundary`、`model_confidence_uncalibrated`、`evidence_chain`（逐项 resolved/unresolved）、`prompt_evidence_id`、`usage` 和模型 provenance。根因转折点必须在同快照的 HGT 选中转换中；Findings 的事件引用回到原始 EvidenceRef。模型建议不会写入 Outcome。`GET /api/diagnosis/capabilities` 中 analyst 状态区分 unconfigured、configured、last_call_failed、last_call_succeeded。
