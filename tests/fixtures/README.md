# 测试夹具来源

`demo/` 由 `scripts/create_demo.py` 人工构造，模拟已核实的历史格式及状态冲突，但不是真实实验数据，也不是 AgentTether 的诊断输出。所有 ID、代码片段、命令、摘要均为合成内容。

夹具覆盖两轮 attempt=0、调用关联、失败→成功验收、report.ok 冲突、缺失证据和增强版图。`sample_kind=synthetic` 必须在前端可见，不得将其用于评估算法性能。

真实 SWE-bench 原始记录只导入本机 `data/` 和 SQLite，不纳入 Git。真实样例联调结果记录于文档，私有原始记录与散列清单保留本地。

`team-enterpriseops/` 是单独审查过的真实 EnterpriseOps-Gym 两轮记录的脱敏衍生包，标记为 `sample_kind=derived`，可供团队通过现有数据导入接口载入。保留工具配对、真实时间和用量、独立检查及一份历史分析报告的事件引用；完整提示词、邮件正文、自由文本日志、端点、路径和原始标识符移除或替换。第二轮由原 Agent 的验收反馈推动，不是平台 RCA 修复闭环。能力与脱敏边界见该目录 README。
