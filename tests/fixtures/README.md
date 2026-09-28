# 测试夹具来源

`demo/` 由 `scripts/create_demo.py` 人工构造，模拟已核实的历史格式及状态冲突，但不是真实实验数据，也不是 AgentTether 的诊断输出。所有 ID、代码片段、命令、摘要均为合成内容。

夹具覆盖两轮 attempt=0、调用关联、失败→成功验收、report.ok 冲突、缺失证据和增强版图。`sample_kind=synthetic` 必须在前端可见，不得将其用于评估算法性能。

真实 SWE-bench 记录只导入本机 `data/` 和 SQLite，不纳入 Git。真实样例联调结果记录于文档，原始记录与散列清单保留本地。
