# EnterpriseOps-Gym 真实 Agent 监控验收

日期：2026-10-02。结论：已验证一个真实 ReAct Agent 的模型、MCP 工具、实时采集和独立检查闭环。

## 执行范围与位置

使用服务器 `/home/zhaochenyu/swe-project/Probe/EnterpriseOps-Gym` 的原始 Python 源码、`configs/probe_iter2_case` 唯一案例，以及该案例引用的 email SQL seed。案例要求创建 Work Coordination / Needs Follow-Up 标签，按线程整理邮件并保持草稿不变。这是隔离的模拟邮箱数据库，不是真实用户邮箱。

模型使用项目 `.env` 的 `OPS_OPENAI_API_BASE_URL`、`OPS_OPENAI_API_KEY` 和 `OPS_OPENAI_MODEL`；本次模型为 `gpt-5.6-luna`。原命令的 qwen 配置未使用。本次用户授权的是 Agent 自身模型调用，平台没有触发 HGT 或 RCA。

执行拓扑：

```text
本机 EnterpriseOps-Gym 原源码副本 + 显式采集适配器
├─ HTTPS → 仓库配置的模型代理（正常证书校验）
├─ SSH 本地转发 → 226 loopback MCP 桥接 → network-none email 测试容器
└─ HTTP loopback → 本机 AgentOps API:8000 → SSE → Run Detail
```

226 的系统 CA 和 certifi 均不能验证外部 HTTPS，模型和 PyPI 都返回 self-signed certificate。因此本次采用上面的执行位置，没有关闭 TLS 校验、添加未知证书或修改原 Agent 环境。**原命令在 226 上直接完成整个流程仍待验证**，需要先修复可信证书/网络配置。

## 已通过的真实验收

成功 Run：`88254262789845c2aec716e0c65ccd7c`；Task：`32c053c274af46cab78f2edf36b9b41f`。

查看：[真实 Agent Run](http://127.0.0.1:8000/runs/88254262789845c2aec716e0c65ccd7c)。需要本机平台服务运行。

| 项目 | 实测结果 |
|---|---|
| Execution | completed，exit code 0 |
| Task Outcome | passed，由原 benchmark SQL 检查给出 |
| Capture Integrity | complete，0 丢失告警 |
| 反馈轮次 | 1；首轮通过后按原逻辑停止，没有强制第二轮 |
| 模型请求 | 成功测试 5 次请求、5 次响应 |
| 工具执行 | 9 次调用、9 次返回、9 组 confirmed call_return |
| 工具明细 | list_labels ×1，list_messages ×1，create_label ×2，get_thread ×2，modify_message ×3 |
| 保存事件 | 151 条：event 3、log 119、llm 10、tool_call 9、tool_return 9、verification 1 |
| 独立检查 | 14 条原始 SQL 检查全部通过 |
| 证据追溯 | 151 条事件的证据引用均可解析，均有 SHA-256 |
| SSE | 实际观察到运行中事件数从 1 持续增长至 151，随后 completed / passed / complete |
| 浏览器 | 运行中和结束页面截图；无 pageerror；工具筛选后显示 9 个逻辑 Span，Call/Return 详情联动正常 |
| 平台诊断 | 0 份报告，没有自动模型分析 |
| 凭据 | API Key 不在已跟踪文件、新代码或采集证据中；私有运行文件被 Git 忽略 |

原配置的 14 个 verifier 包含 7 个重复名称；原 benchmark 结果按名称保存，最终统计是 7/7。适配器在每次实际检查完成时记录，平台保留 14/14，不改写上游结果。SQL 查询、expected、actual、passed 和检查来源保存在 Outcome Evidence 中，平台没有重新执行这些检查。

运行材料在 `.local/enterpriseops/`：`acceptance-proof.json`、`receipt.json`、`stream-proof.json`、`ui-proof.json`、`results-toolcheck/`、`agent.log`、运行中/结束截图和 `real-agent-tools.png`。这些是本机私有材料，不提交仓库。

## 预检失败与修正

1. 226 的 HTTPS 证书校验失败，独立平台环境安装也受到影响。改用本机独立 Agent 环境；原两套环境均未修改。
2. Windows 系统代理导致 HTTPX 回环 MCP 请求返回 502。适配进程显式将 localhost / 127.0.0.1 加入 NO_PROXY，保留外部 TLS 校验。
3. 临时容器 HTTP 桥接最初漏传压缩响应头，原 Agent 工具发现失败并返回空工具列表。那次真实测试产生两轮 failed Outcome，但两轮执行和采集都完成；不是模拟失败。它只调用模型 2 次，记录保留在 `first-observed-run/` 和平台原 Run 中。修正桥接后，使用原 MCPClient 无模型预检，确认连接成功、79 个工具可发现、全部 5 个所选工具存在，才执行成功测试。

本次总模型请求为 **7 次**（上述失败测试 2 次 + 成功测试 5 次），并非仅 5 次。无额外 RCA/反馈总结模型请求，未查询实际费用。

## 接入实现

- `packages/collector/agentops_cli/session.py`：串行嵌入式 CaptureSession；每次实际执行建立一个 Run，沿用现有持久化 outbox、重传、心跳和 finish 协议。
- `scripts/run_enterpriseops.py`：独立、显式启用的 EnterpriseOps-Gym 接入入口。复用原 evaluate、ReAct、MCP 和 verifier；运行期挂钩，不改上游源码。每个反馈尝试独立建 Run，共享 Task。
- `tests/integration/test_capture_session.py`：检查轮次归组、执行与验收分离、异常结束、未知检查状态、已知模型/MCP 凭据脱敏。

工具 correlation ID 在真实调度入口创建，并贯穿实际返回；duration 使用 perf_counter 测量。工具 Call / Return 有明确关联，UI 可聚合为 Span。未生成 parent-child 层级。模型请求/响应、日志、验收和运行边界仍是各自事件，不伪造模型 Span 或运行瀑布图。

适配器限制一个 case、串行 ReAct、一个样本外层执行、最多两个真实反馈尝试。关闭 SDK / LangChain 隐式重试，每个模型请求限时 90 秒，总模型请求上限默认 20。工具发现不完整时停止，不再继续调用模型。禁用旧 PROBE 的隐式 RCA；原 Agent 用户 prompt 及工具选择保持不变。

采集为显式观测范围：模型、Agent 调度的 MCP 工具、logging、独立检查以及 Run 边界。并不表示自动捕获所有第三方程序、所有 stdout 或操作系统事件。字段经过脱敏、长度/数量限制；Capture complete 代表生成的采集事件已完整交付，不保证任意原内容逐字无截断。现有通用脱敏规则也会隐藏名称含 token 的 usage_metadata 字段，本轮未修改这个规则。

## 复跑入口

必须先准备原 Agent 源码、原 case 和 seed 文件、独立 Python 环境以及可访问的测试 MCP 服务；这些不是 Git 仓库内的公开 fixtures。

本机 Agent 环境本次安装版本：Python 3.12，langchain-openai 1.1.11，langchain-core 1.2.20，openai 2.29.0，datasets 4.8.2，httpx 0.28.1，pydantic 2.12.5；另有 aiohttp、nest-asyncio、tqdm、python-dotenv、tabulate。重要 Agent 依赖版本对齐原服务器运行环境；平台 `.venv` 不安装这些额外依赖。

从项目根目录创建临时私有 LLM 配置（只读取 Key，不打印）：

```powershell
@'
import json
from pathlib import Path
from dotenv import dotenv_values
c = dotenv_values('.env')
p = Path('.local/enterpriseops/llm.private.json')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps({
    'llm_provider': 'vllm',
    'llm_model': c['OPS_OPENAI_MODEL'],
    'llm_api_key': c['OPS_OPENAI_API_KEY'],
    'llm_api_endpoint': c['OPS_OPENAI_API_BASE_URL'],
    'temperature': 0.1,
    'max_tokens': 4096,
}), encoding='utf-8')
'@ | .local/enterpriseops/agent-venv/Scripts/python.exe -
```

`vllm` 在原 Agent 中代表支持自定义 base URL 的 OpenAI-compatible 客户端，并不表示此次部署了 vLLM 模型服务。上游 `openai` 分支忽略自定义 endpoint，故本次不选该分支。

runtime case 副本仅把 `mcp_server_url` 指向当前可用的测试服务，把 seed 路径改成执行机绝对路径。当前 `.local/enterpriseops/configs` 指向临时端口 18003；本轮临时服务已清理，**先重新准备 MCP 服务并更新副本 endpoint，不能直接照抄命令期待旧临时服务仍在**。

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONPATH='D:/Projects/agentops-rca/packages/collector'
.local/enterpriseops/agent-venv/Scripts/python.exe scripts/run_enterpriseops.py `
  --source D:/Projects/agentops-rca/.local/enterpriseops/source `
  --server http://127.0.0.1:8000 `
  --configs-folder D:/Projects/agentops-rca/.local/enterpriseops/configs `
  --llm-config D:/Projects/agentops-rca/.local/enterpriseops/llm.private.json `
  --output-folder D:/Projects/agentops-rca/.local/enterpriseops/results-next `
  --receipt D:/Projects/agentops-rca/.local/enterpriseops/receipt-next.json `
  --spool-dir D:/Projects/agentops-rca/.local/enterpriseops/spool `
  --max-model-calls 20
```

直接运行适配入口，**不要再套 `agentops run`**，避免嵌套采集会话。上游按输出文件跳过已运行样本，复跑应使用新的 output-folder。执行结束后删除临时 `llm.private.json`，项目 `.env` 留在原处。

已清理本轮新建的两只测试容器、MCP 桥接进程、SSH 本地转发，以及本机/226 临时模型配置。平台服务和持久化 Run 保留，可以继续查看。没有修改或停止服务器原有 Agent、服务、容器，没有提交/推送本轮更改。

## 尚未验证

- 在 226 的原 Python 环境与原命令位置直接完成全链路。
- 其他 EnterpriseOps case、Planner/Decomposing 编排和并发；CaptureSession 是进程级串行接口。
- 真正的工具错误恢复、长任务、模型超时/断连及在线流量下断线补传；本次实际失败来自工具发现准备问题，成功 case 没有工具错误。
- 将此次真实 Run 送入 AgentTether HGT / RCA；仍需用户显式定位、预览和确认。

本次 8 项采集/适配回归测试通过，compileall 与 git diff --check 通过；没有修改前端或后端业务语义。实测后补充了已知 MCP 凭据日志脱敏和 JSON-RPC/MCP 错误判定的无模型回归，不为这些小修正重复付费运行。
