# AgentTether 采集复用评估

日期：2026-10-02。范围：本地 `D:/桌面/AgentTether-9416/agent_tether`，包版本 0.4.0；这是本平台当前配置的算法源码目录。另只读确认 226 `/home/zhaochenyu/probe_enhance/probe/probe/ops/instrumentation.py` 有相同名称和行号的包装函数，未宣称服务器整个版本逐字相同或已重新运行。

结论：AgentTether 确有自己的采集层，先前只突出 HGT/RCA 用途的解释不够完整。它提供的可复用接口种类比当前平台 SDK 多，值得接入；但不能据此认定整套更可靠或自动全覆盖。推荐复用采集包装和语义字段，保留平台传输、证据和状态语义。本轮没有替换产品代码、复制第三方源码到仓库、调用模型或运行 HGT。

## 具体能力比较

| 能力 | AgentTether 当前源码 | 平台当前实现 | 迁移判断 |
|---|---|---|---|
| 工具边界 | 通用同步/异步包装、MCP call_tool、SWE communicate/execute、subprocess.run、工具装饰器 | SDK 同步/异步装饰器；EnterpriseOps 显式调度适配 | 复用通用目标包装以减少每种 Agent 的重复代码；仍需指明真实目标对象 |
| 模型 | OpenAI/LiteLLM/Anthropic 自动补丁；单独 LangChain invoke/ainvoke/派生 Runnable 包装 | EnterpriseOps 显式记录实际异步模型请求/响应/错误，限定重试 | 接口更丰富，但当前自动/显式入口存在适配问题，需先修复并测覆盖 |
| 诊断上下文 | tool schema、task context、intent、step_idx、round、usage/capacity、error_signature | 通用事件与检查基础字段，具体适配器补充上下文 | 可以增加结构化来源字段；推断的 intent/error 需和执行事实区分 |
| ID/时间 | correlation、seq、duration、Schema 中的 parent；多数通用包装用 time.time | correlation、per-producer seq、单调时钟测耗时、保守配对 | 保留可靠源 ID；Schema 有 parent 不等于默认形成真实调用树 |
| 本地保存/实时交付 | 主 emitter 逐行 append JSONL；另有可选 OTel export | SQLite outbox、确认重传、去重、心跳、finish、SSE、采集完整性 | 保留平台 Collector 作为可靠交付层，不用 JSONL emitter 替换它 |
| 证据/状态/凭据 | 保存原始输入/输出；多数失败静默降级；JSONL emitter 不统一脱敏 | 有界脱敏、原件引用/hash、未知状态与 task outcome 分离 | 新入口必须经过平台脱敏和事实映射；采集失败不得只 no-op 后显示完整 |

核心采集模块未找到 CPU、内存、网络 IO 的采样实现。这里的丰富上下文和语义信号不能称为完整操作系统探针。它也不会让原本未执行的工具产生 Call/Return。

## 源码依据与兼容性检查

以下行号相对该本地 `agent_tether/agent_tether/`：

- `ops/instrumentation.py:213` / `:300`：同步/异步通用包装；`:551` LangChain；`:807` MCP；`:828`、`:850` SWE 环境；`:895` subprocess；`:936` HTTPX。
- `auto.py:57` 的 `enable_auto_instrumentation` 与 `session.py:110` → `ops/instrumentation.py:1277` 的 `auto_instrument_all` 是不同路径。后者自动挂钩不会自动接入 LangChain Runnable 或任意 MCP 对象，不能把文件里有某个函数解释成默认都启用。
- `ops/instrumentation.py:1061`：OpenAI 自动补丁针对 `Completions.create`；`:1091` 附近 `stream=True` 直接返回原实现，未挂钩 AsyncCompletions。
- `ops/instrumentation.py:673`、`:762` 以及 factory 包装尝试 setattr 到 Runnable 实例，失败后直接 return。
- `live/observer.py:187`：LLM_RESPONSE 记录结束时刻、usage 和 latency；它不是天然带真实 start/end 的完整 LLM 区间。
- `live/observer.py:262`：`ok=None` 且无其他错误签名时，`if not ok` 会写入 tool_failed 信号，迁移要保留 unknown，不直接将其映射为实际失败。
- `live/observer.py:367` 与 `live/emitter.py:15`：Span 生成及 JSONL 追加；主要 on_tool_call/on_tool_return 没有提供 parent 参量，不能假定数据已带父子关系。当前 emitter 的本地文件协议也没有本平台 ACK/outbox。
- `monitoring.py:52` / `session.py:45` / `session.py:368`：公开默认包含报告和 LLM RCA 开关；collector 入口必须显式禁用自动报告/自动 RCA/干预，不沿用默认 finish 流程。

为了避免只凭文档判断，隔离抽取原包装函数，用当前 Agent 环境的真实 SDK 和 `httpx.MockTransport` 验证。结果是 **0 个真实网络请求，0 次模型调用**，不是完整 AgentTether 运行验收。

| 检查 | 实测 |
|---|---|
| OpenAI 同步 Chat Completions 自动包装 | 记录 1 次 |
| 同一补丁下 AsyncOpenAI Chat Completions | 新增记录 0 |
| 同一补丁下 stream=True | 新增记录 0 |
| 显式 LangChain 包装当前 ChatOpenAI.ainvoke | LLM 与调用边界记录均为 0；实例挂钩未生效 |
| HTTPX Client.request 的输入映射 | method 被记录为 Client 对象，url 被记录为 GET；input_builder 忽略了类方法的 self |

环境：openai 2.29.0、httpx 0.28.1、langchain-openai 1.1.11 / langchain-core 1.2.20。私有检查脚本及结果在 `.local/research/agenttether_capture_check.py` 和 `agenttether-capture-proof.json`。这些结论限定于当前源码、入口及版本；不扩展为所有 AgentTether 分支或所有 LangChain 宿主均不可用。

## 推荐接入边界

```text
Agent / 原有 AgentTether 工具与模型包装
    → 平台 observer 适配（映射来源、事实、ID、真实时间；排除自我采集）
    → 脱敏 + 现有 Collector/outbox
    → 现有 API / 原始证据 / SSE / Run Workspace
    → 用户显式触发 HGT，再预览确认 RCA
```

可以提供实现 `on_tool_call`、`on_tool_return`、`on_llm_end` 等方法的平台 observer，用来承接 AgentTether 包装。优先接这个接口，避免通过其完整 session 生命周期自动进入报告、干预或恢复逻辑。JSONL 历史导入是另一条独立路线；实时接入不能只在任务结束后读取整个文件。

传输入口保留源 span/correlation、来源时间和版本；明确哪些是实际动作、哪些是派生提示。源 Schema 的 meta/intent/step_idx 等字段在当前 live 接口没有完整统一传递，需要版本化字段或有明确映射的扩展容器，不能默默丢字段。先保留源原件，再分别投影页面与 HGT 输入。

LLM 需要真实开始/结束或可靠请求响应关联，才能成为时间条。仅有响应 latency 不能无条件反推出墙钟 start_time。子进程、HTTP 请求和高层业务工具可能同时记录同一动作，需要标记采集层级并避免重复计数；不能把 HTTPX 对 Collector 的上报请求再次采集，形成递归。

HGT 目前仍只支持串行完整工具轨迹。扩大采集覆盖不等于 HGT 自动支持并发，不能为适配诊断而改写发生顺序、制造配对或默认推断父节点。新采集器也不能把任务检查塞进模型定位答案中。

## 建议实施顺序及通过标准

1. 固定当前源码和 SDK 版本；新增 observer bridge，依赖放在获授权的私有源码位置，复用模块而不是将全部源码/权重复制进 GitHub。
2. 修复并验证实际使用路径：AsyncOpenAI、LangChain ainvoke/bind_tools、MCP 工具、HTTPX 参数、异常/超时/取消。先用无网络测试证明钩子已生效，失败明确显示采集能力不足。
3. 补充真实 LLM 起止、用量/上下文字段和 unknown 映射；保留日志点、普通事件点和原始证据。保持模型用量数值不会被凭据 token 脱敏误伤。
4. 用同一 Agent/case 做计数对照：模型请求、响应、工具调用、返回、独立检查数量与原宿主一致；不能只凭“事件更多”判定更好。进一步测试独立工具失败和取消路径。
5. 验证平台断线重传/完整性及 HGT 输入兼容。诊断和验收保持独立，不自动调用付费模型，不自动修复 Agent。

此路线增加采集可复用性，不重构 Run-centric 产品对象、不更换页面布局。要解决之前的“日志淹没执行步骤”，还需要前端默认呈现与日志层级优化，换采集器本身不会减少日志噪声。
