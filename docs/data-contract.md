# 核心数据契约草案 v0.1

状态：设计草案，P0 用真实样例验证后再固化为可执行 Schema。所有规范化对象有 `schema_version`，源字段不直接改写。

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

V0.2 追加 DiagnosisJob；V0.3 追加 VerificationRun 与采集会话。首版干预事件可保留为 Event(kind=intervention)，无需先建通用修复编排器。

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
