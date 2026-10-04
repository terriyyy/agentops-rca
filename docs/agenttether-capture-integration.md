# AgentTether 采集接入与验收

2026-10-02。开发计划见 [实施计划](agenttether-capture-development-plan.md)。

## 已实现的边界

`agentops_cli.agenttether.AgentTetherCapture` 运行时加载调用方提供的私有 AgentTether 采集模块，实际复用其 `instrument_callable_attr` / `instrument_async_callable_attr`，通过平台 observer 写入原有 SDK/outbox。只加载三个 ops 文件，屏蔽 OTel，不导入完整 Session/monitor，不初始化 HGT/RCA/恢复引擎，也不安装 torch 或读取权重。

这是显式接入：需要指出被观测的对象/调用入口。原来的 `@tool` SDK 和 EnterpriseOps 无桥接模式继续可用。没有将 AgentTether 私有源码或权重复制进 Git；团队成员自行安装获授权的私有源目录即可使用，采集本身不需要 HGT 权重。

| 入口 | 已验证 | 限制 |
|---|---|---|
| `wrap(function, name=..., inputs=..., outcome=...)` | 同步/异步、异常、取消、真实嵌套 parent、process returncode/stdout/stderr | 包装实际边界，不自动发现任意工具；嵌套/并发工具可能不适用于串行 HGT |
| `openai(client)` | OpenAI/AsyncOpenAI Chat Completions 非流式 | current async create 有同步装饰层，已通过 unwrap 修正；stream 原样返回并记录 unsupported，不制造已完成模型区间 |
| `langchain(runnable)` | invoke/ainvoke；bind_tools/bind/with_retry 派生调用 | 必须使用返回代理；不修改 Pydantic 实例，不代替完整 Runnable 操作符协议；记录高层调用边界，内部重试不会冒充多个模型请求 |
| `mcp(session)` | 绑定 call_tool、明确 isError、未知状态 | 不同时包装同一次调度的 MCP 层与高层工具，避免重复计数 |
| `httpx(client, collector_url=...)` | Client/AsyncClient.request 参数与正常/排除路径 | 显式实例补丁，必须提供 collector_url 排除上报服务；平台 Transport 本身使用 urllib，不被该补丁捕获 |

真实验证版本：AgentTether 0.4.0；Python 3.12；openai 2.29.0；httpx 0.28.1；langchain-openai 1.1.11 / langchain-core 1.2.20。其他版本需跑兼容测试。

可选 `capture` 字段保存 adapter/source_version/source_sha256、signal_kind、phase、上游 metadata。source_sha256 为三份采集依赖文件（含相对文件名）的 SHA-256，不是 HGT 权重哈希或整个仓库哈希。字段同时保留在原始证据、Run 事件和 HGT 输入快照；旧 0.2 事件无需添加字段，数据库不迁移。

工具 Call/Return 共享明确 correlation ID，保留两个原始事件，前端继续按现有规则聚合。真实 begin/end 在发生时记录，耗时用 perf_counter；未知 ok 不转成失败，取消明确记录异常。LLM 为 llm 请求/响应事件，当前前端仍显示点；后续可依据可靠配对添加模型区间，不能为了条形图冒充工具。普通 log/verification/Event 仍为点。

精确非负整数 token 用量（input/output/prompt/completion/total/cached/reasoning）可以保留；字符串、布尔值、负值、任意 token 键和凭据继续脱敏。已知实际密钥在序列化限长前按精确值替换。原件仍是经过脱敏与长度限制的记录，不宣称所有原始字段逐字完整。

## 最小使用

```python
from agentops_cli.agenttether import AgentTetherCapture

# 必须位于原有 agentops run / CaptureSession 的采集上下文中。
with AgentTetherCapture(private_source, secrets=[model_key]) as capture:
    capture.openai(openai_client)       # 或者使用下一行的高层入口
    # agent.llm = capture.langchain(agent.llm)
    capture.mcp(mcp_session)
    # 运行原 Agent。不要同时包装同一个模型/工具的多个层级。
```

close 恢复 OpenAI/MCP/HTTPX 的实例补丁；通用 wrap 是返回新函数，LangChain 是返回代理，回滚时恢复原函数/原 Runnable 引用。没有会话时包装透明调用原函数；初始化时私有路径/接口无效会明确失败，不把未安装成功的钩子宣称为可用。运行中的采集失败标记 collection_error，结束时进入 partial；业务异常仍传播。

Capture complete 表示已产生记录完整交付，与覆盖范围不同。unsupported/end_only 记录不推断缺失边界，不能据 complete 宣称完整流式监控。

## EnterpriseOps 使用

原复跑前置条件仍见 [真实 Agent 验收](enterpriseops-real-agent-acceptance.md)：单 case/单并发、可访问测试 MCP、私有 LLM 配置、新 output-folder。旧临时 MCP 已清理，226 HTTPS 信任问题未消失。

在原 `scripts/run_enterpriseops.py` 命令末尾增加：

```powershell
  --agenttether-source '<获授权私有目录，内含 agent_tether/ops/instrumentation.py>'
```

此模式记录 capability/source hash，替换显式模型和工具事件生成入口，保留模型预算/90 秒超时/禁用隐式重试/工具发现预检/独立 SQL 检查/真实轮次关系。使用 LangChain 高层代理，不再额外挂 OpenAI 同一请求，不额外记录底层 MCP 同一个工具。未指定该选项时保持原平台包装路径。

## 无模型自检

启动最新平台后运行（将路径换成自己的私有目录）：

```powershell
$env:PYTHONPATH = "$PWD/packages/collector"
.venv/Scripts/python.exe scripts/check_agenttether_capture.py `
  --agenttether-source '<私有 AgentTether 源目录>'
```

这会执行真实临时文件写入及 Python 断言，产生标记为 **synthetic** 的实时 Run，故意让加法测试失败。页面应同时显示执行完成、任务检查失败、采集完整，两组工具关联；原始 stdout/stderr 与证据可核对。无模型或诊断调用。

当前实机自检 Run：`0f6d52fb7072419b8070393212e1a9b1`，7 事件、2 工具配对、completed/failed/complete；原始证据全解析，HGT 输入快照可构建并排除验收记录，未触发定位/模型推理。这不是 EnterpriseOps 真实案例复跑。

## 自动化验收结果

- 后端/Collector 集成测试 72 通过（两个已有依赖弃用警告）。设置 `AGENTOPS_AGENTTETHER_SOURCE` 才执行私有包装测试；没有私有源的团队环境跳过 3 项，不伪造上游实现。
- 最后增加旧 receipt 哈希兼容检查，受影响采集/协议专项 17 通过；未提供 capture 的旧事件保持原哈希和重传幂等。
- 实际 Agent 环境 SDK 兼容测试 7 通过：sync/async OpenAI、错误/取消、流式透明降级、LangChain 派生调用、MCP、sync/async HTTPX、自进程结果，以及原 EnterpriseOps LLMClient/工具调度接入。所有模型流量通过 MockTransport；0 个真实模型请求。
- 协议用例验证 finish 先到→pending→补传 complete、重复批次 accepted=0、来源与证据保留、任务失败独立、HGT 快照排除独立检查内容、零诊断作业。

```powershell
$env:AGENTOPS_AGENTTETHER_SOURCE = '<私有 AgentTether 源目录>'
.venv/Scripts/python.exe -m pytest tests/integration -q

# 使用装有上述 OpenAI/LangChain 版本的 Agent 环境
$env:PYTHONPATH = "$PWD;$PWD/packages/collector"
$env:AGENTOPS_ENTERPRISEOPS_SOURCE = '<私有 EnterpriseOps-Gym 目录>'
.local/enterpriseops/agent-venv/Scripts/python.exe tests/compat/test_agenttether_sdk.py
```

SDK 初测发现 AsyncOpenAI.create 的同步装饰层，修正后全部通过。原 EnterpriseOps extra_body 参数产生已有配置提示，不影响测试；没有关闭 TLS 校验。

## 待验收 / 延期

2026-10-02 新桥接已完成原 EnterpriseOps 真实 case 复跑：第一轮10/14检查通过，反馈第二轮14/14通过，12模型请求，两轮均采集完整。结果见 [真实复跑验收](agenttether-real-agent-replay.md)。旧成功 Run 88254262789845c2aec716e0c65ccd7c 属于原平台显式包装，不能作为桥接真实成功证明。

226 原环境直接执行、长时间断连和复杂并发仍待现场验收。

完整流式生命周期、Responses/Anthropic、任意框架自动发现、系统资源探针和模型区间 UI 延期。HGT 仍要求完整、无歧义、串行工具轨迹。RCA 仍需手动预览确认，诊断不替代任务检查。
