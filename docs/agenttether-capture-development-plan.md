# AgentTether 采集桥接实施计划

2026-10-02；范围：采集兼容与 EnterpriseOps 接入，不重新设计页面，不迁移权重或私有算法源码。

## 架构

Agent 的显式入口 → 私有 AgentTether 通用 sync/async 包装 → 平台 observer → 脱敏/outbox → 原有 API、证据、SSE。

仅加载 ops/instrumentation 及其纯采集依赖，不使用 AgentTether Session/monitor/auto_report，不启用报告、HGT、RCA、恢复或 OTel 外发。私有源码路径由调用方指定；记录版本与文件哈希。保留现有 SDK 作为无私有依赖的使用方式。

## 阶段与验收

- [x] A1：隔离加载与 observer bridge。源 call/return、correlation、真实 parent、meta、未知状态可追溯；采集错误明确标记；取消不得误记成功。通用入口必须实际调用外部原函数，不复制源码。
- [x] A2：同步/异步入口兼容。可逆补丁；LangChain 用委托代理避免 Pydantic setattr，覆盖 bind_tools/bind/with_retry 派生调用；OpenAI Chat Completions sync/async；MCP 实际错误与未知结果；HTTPX 正确解析绑定方法且排除 Collector 地址。保留业务结果、异常、取消和已有重试策略。
- [x] A3：协议和 EnterpriseOps。兼容性可选 capture 字段保存采集来源/信号/meta；有限数值 token 用量保留，凭据继续脱敏；现有适配器增加显式 AgentTether 路径选项，保留预算/超时/独立检查/多轮归组。
- [x] A4：无付费验收。真实 OpenAI/LangChain SDK + MockTransport 验证正常、错误、取消、派生工具调用；Collector → API → 证据 → HGT 输入快照，重传不重复、完整性可见、验收不进入定位输入。不调用任何模型，不运行 HGT/RCA 推理。
- [x] A5：交付接入说明、能力边界及测试结果。固定已验证版本；文档说明私有依赖分发、可选启用与回滚，确认敏感信息/源码/权重未进入 Git。

## 本轮边界

优先解决当前真实 Agent 使用的异步非流式 LangChain/OpenAI + MCP 路径。流式 Chat Completions 需要消费生命周期（首 token/耗尽/提前关闭）独立设计，本轮透明保留原流对象并明确上报“不支持完整流式采集”，不将创建流当作请求完成。Responses、Anthropic、任意框架自动发现和系统指标延期。

LLM 保留真实请求/响应 ID 与耗时，仍使用 llm 事件，不冒充 tool；当前 UI 仅将可靠工具配对显示 Span，模型区间投影另行处理。普通日志仍为点。不会为美观制造层级或时间。

真实付费案例再次运行作为后续现场验收：当前本轮先完成 MockTransport/协议证明；226 TLS 与隔离 MCP 资源需重新准备，不能用旧 Run 冒充新桥接已验收。

Capture complete 表示已产生事件的可靠交付，不表示任何 Agent 都已全覆盖；能力声明独立记录。执行完成≠任务通过，诊断≠验收，付费诊断仍人工预览确认。

后续验收更新（2026-10-02）：用户授权的新桥接真实案例复跑已完成，第二轮14/14通过；详情见 agenttether-real-agent-replay.md。原实施阶段无付费测试边界保持如上，逐 token 采集仍延期。
