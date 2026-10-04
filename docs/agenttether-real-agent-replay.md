# AgentTether 桥接真实 Agent 复跑验收

2026-10-02。用户授权复跑原 EnterpriseOps-Gym 邮箱整理 case，使用仓库配置模型，并在网页观察实时事件和真实任务检查。

## 结果

同一任务 `6b6959746dc143a19c5ba48db3cb89cb`，按原 Agent 反馈逻辑实际执行两轮，没有强制将结果标为成功。

| 检查项 | 第一轮 | 第二轮 |
|---|---|---|
| Run | 7af4add942c044849cef8bc07ad8e6d2 | 25306a1934194c62bdd14fff81b1a491 |
| 执行 | completed / exit 0 | completed / exit 0 |
| 任务检查 | failed，10/14 通过 | passed，14/14 通过 |
| 采集完整性 | complete / 0 丢失 | complete / 0 丢失 |
| Agent 模型请求/响应 | 5/5 | 7/7 |
| 工具调用/返回/可靠配对 | 7/7/7 | 10/10/10 |
| 原始采集事件 | 138 | 170 |
| 事件证据 API 解析 | 138/138 | 170/170 |
| SSE 观察 | 22 次状态变化；running 时事件 1→127，结束 138 | 29 次状态变化；running 时事件 1→159，结束 170 |

第一轮未通过检查涉及匹配邮件的 Work Coordination 标签、线程回复的 Needs Follow-Up 标签。14 个实际 SQL 检查中这两种名称各出现两次，因此记录 4 条失败；上游按名称聚合的统计与逐项记录数量不同。第二轮全部实际检查通过。

查看 [成功的第二轮](http://127.0.0.1:8000/runs/25306a1934194c62bdd14fff81b1a491) 或 [第一轮](http://127.0.0.1:8000/runs/7af4add942c044849cef8bc07ad8e6d2)。在 Tool Execution 类型筛选下查看逻辑工具 Span；在任务检查面板查看检查来源、SQL 依据和 expected/actual/passed 原始结果。

## 执行范围与证据

真实 Agent 原源码副本在本机执行；本机 HTTPS 调用仓库 gpt-5.6-luna，模型总请求 12 次。226 专属 network-none 邮箱容器，通过回环代理和 SSH 本地转发提供模拟邮箱 MCP；79 工具发现预检成功，5 所选工具均存在。TLS 校验保持开启，没有修改原服务器 Agent 环境或旧案例。

本次启用 `--agenttether-source`，模型和工具事件均记录 agenttether-observer-0.1 / AgentTether 0.4.0 的采集来源，三份 ops 文件哈希 `40d4490bf3420fef5a48eca30feb16bd2de616e89ec0ba48dd4fc904592ffd45`。所有模型/工具事件的来源哈希已核对，不以旧显式包装 Run 代替桥接验收。

两轮真实 SQL 检查仍由原 benchmark 执行，平台只采集结果。所有采集原件 SHA-256 校验通过，实际 API Key 未进入原件。浏览器分别捕获两轮 running/finished 页面，pageerror 为空；SSE 在运行期间接收增长事件，不是运行结束后一次导入。

网页实时的是事件流：模型请求、完整响应、工具调用/返回、日志及检查结果。此次模型调用是非流式返回，没有逐 token 输出，未将普通日志伪装成持续区间。

本次采集脚本未请求 HGT/RCA。验收过程中第一轮另外出现一项成功的 offline_hgt 作业（创建于执行结束后），其来源未在本次旁路记录中归因；不宣称零诊断作业，也不将该结果用于任务验收。两轮均无 analyst_rca 作业，没有新增付费诊断调用。

私有运行材料在 `.local/enterpriseops/tether-replay-20261002/`：receipt、acceptance-proof、逐轮 SSE、运行结果、运行中/结束截图和浏览器检查。均被 Git 忽略，不提交实际配置或模型请求内容。

## 清理与边界

原 Agent 已结束；本次容器、226 回环代理、SSH 转发、临时模型配置及服务器临时文件已清理。项目 `.env`、平台服务、两轮记录与证据保留，可以继续在网页查看。

本结果验证的是同一个真实邮箱案例、当前 SDK 版本和串行 ReAct 编排。它不代表任意 Agent、并发编排、长任务、完整流式模型或226原地 HTTPS执行已通过。新增的低层桥接兼容测试和自检说明见 [采集接入](agenttether-capture-integration.md)。本轮没有修改产品代码或提交/推送 Git。
