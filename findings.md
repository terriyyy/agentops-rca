# 方案审查发现

## 2026-09-27：Run Detail 视觉审查后的实现依据

- 当前 `RunPage` 把 01–05 的章节说明、四列等权状态、失败列表、报告卡、验收卡纵向串联；完整轨迹排在最末尾。失败 Run 首屏不能同时查看关键线索与相邻事件，原始证据以抽屉打开后需要往返。
- `ReportView` 中摘要、引用证据、建议和技术详情连续采用 `panel`，削弱了待验证根因假设与独立验收之间的语义边界。`TracePanel` 已有搜索、过滤、分页和 live 跟随，应该复用而不是新建事件数据对象。
- 现有 `run.insight.failure_signals` 含明确失败事件和证据引用，足以形成失败焦点；不要依据报告摘要伪造错误步骤或因果顺序。来源双轴、独立验收和模型预览控制继续保留。
- 首轮新页面截图显示状态带、失败聚焦、最近事件轨道和右侧调查索引已形成不同节奏；桌面首屏可同时看到执行完成/验收未通过及原始失败证据入口。390px 无横向溢出，但展开完整轨迹会产生很长的页面，应保持默认折叠。首轮失败焦点以工具名 `bash` 为大标题，错误签名反而是次级；需要改为优先突出明确错误签名。
- 证据侧栏打开后仍能看到失败焦点及状态带，原始文件行号与 SHA-256 保留；移动端单列截图无横向溢出。正在运行且暂无事件的页面仍完整铺陈诊断作业和空验收，增大无效滚动；应在运行期间折成简短待处理提示，结束后再显示完整内容。
- 复核截图显示错误签名已成为失败焦点标题；运行中页面只显示不可操作诊断/未知验收的简短说明，完整控件在执行结束后出现。首页测试原本假设刚导入的 Run 永远排第一，与真实的运行中优先顺序冲突，已改为按目标记录定位，不改产品排序。

## 2026-09-27：V0.4 工作流实施核查

- 既有首页曾把任务最新执行与诊断报告混成一条概览，历史报告存在时仍可能显示“尚未诊断”。共享只读投影以 Run 实际持久化报告和最新作业分别计算，保持首页、Task、Run 的结论一致。
- 导入报告、离线 HGT 定位和 analyst RCA 假设属于不同来源及结论级别；旧报告与新作业失败可以同时成立。执行结束、独立验收、采集完整性和网页 SSE 连接也独立记录。
- 失败线索只来自失败执行、明确错误事件或未通过的独立验收，并保留原始证据 ID；不以模型摘要或前后轮先后关系推断真实根因。
- 浏览器测试的导入 409 是相同任务／轮次键对应不同包的正确保护行为。E2E 清单隔离后通过，不需要放松导入幂等规则。

## 黑白控制台改版

- 用户明确偏好阿里云式白底深字系统字体；旧 CSS 大量 9–12px 和低对比灰绿文字是可读性问题来源。改为系统字体栈，Windows 中文回退 Microsoft YaHei；颜色与字号按角色统一。
- 阿里云外层文档页可访问，内嵌业务控制台在独立浏览器显示未登录；仅确认其基础系统字体配置，不声称复刻完整登录后业务页面。
- 改版保留全部实时和证据交互，浏览器 4 项回归通过；手机以重排替代压缩字号。

## V0.2 编码核查

- 核心交付已通过 40 项后端／进程、4 项浏览器及生产构建检查。服务中断补传、SSE 续接、Ctrl+Break、硬杀失联、独立验收与进程状态差异均验证。主机样本 SSE→DOM 延迟 p95 最终为 560 ms（100 条合成协议事件）。

- AgentTether session 初始化 Observer；Observer 模块顶层引用 reporting.generate_report，采集入口并非与报告依赖完全隔离。主自动 patch 跳过 stream=True；未找到算法目录明确的独立 LICENSE（tau2 的 LICENSE 不覆盖算法目录）。本版不复制或修改第三方源码，先提供显式 Python 工具包装，保留兼容的 tool_call/tool_return/correlation_id 语义。
- 用户进一步明确：确定性 Python 工具型测试 Agent 是 V0.2 核心验收对象，真实模型 Agent 兼容性验收保持 pending，禁止为完成主链路主动调用付费模型；平台与 RCA 本版均不需要模型推理。
- 首版实现选用 SQLite outbox（CLI 与子进程共享）、每生产者连续序号和事件 ID 去重、24 小时会话凭据、SQLite 持久化 SSE 游标；spool 默认 .agentops/ 并被 Git 忽略。

## 2026-09-20：实时监控优先的路线调整

- 用户确认目标使用流程是终端启动 Agent、网页实时查看执行，然后诊断；本轮要求先调整 V0.2 计划。
- 总计划、README、契约说明与 V0.1 验收限制中仍有旧版“V0.2 诊断／V0.3 采集重试”描述，已统一改为“V0.2 实时监控／V0.3 实际诊断”。
- 单条启动命令不能保证任意 Agent 的语义可见性；计划将进程输出与结构化工具适配分别验收，优先核查 AgentTether 现有采集入口。
- 现有 SQLite schema 为 user_version=1，Run 具有 snapshot_hash，历史事件 position 唯一；live 接入需要兼容迁移，不能直接把可变执行当历史不可变快照。源序号与持久化 SSE 游标需分开。
- V0.2 不依赖 HGT；确定性模型替身仅用于自动化测试，真实 Agent 接入单独验收。断线不等于任务失败，进程退出不等于验收成功。

## V0.1 实现后的确认

- 原始附件以不可变文本存入SQLite，与事件和报告同事务，避免外部文件存储与DB出现半提交；后续体量增长再迁移。
- 主真实样例完整导入得到1351条事件及575对调用关联；第二轮报告与独立验收存在来源冲突，平台保留告警并以明确的独立验收文件为主依据。
- 公开测试夹具为人工合成，未再分发原始论文、算法代码或实验日志；真实数据仅本机验证。
- 精确ID无法定位的历史诊断引用仍为unresolved。阶段图只展示源节点与原始关系，不把列表顺序绘制成推断因果边。
- 锁定依赖后在Python3.12、Node24、Edge完成验收。实现结构及限制见docs/v0.1-validation.md，V0.2/V0.3尚未实现。

## 第一版规划与提交边界

- 项目目录已改为 agentops-rca；仓库内旧项目目录名检索未发现残留。新增文档使用相对链接，机器配置保存在被忽略的 `.local/workspace.json`。
- 首版先交付历史导入、任务／Run 对照、验收与诊断证据追溯；HGT 实际诊断和现场重试分开验收。
- 原始报告、analysis_sources 及其全文／服务器记录保留本地并忽略；本文件的主机／绝对源目录已改为符号引用，原件备份在 `.local/`。
- 拟用 Python API、TypeScript 前端；单机 V0.1 使用 SQLite，后续按并发需要再考虑 PostgreSQL。当前不安装依赖、不生成应用代码。

## 后续论文澄清
- 已读2607.06273v1.pdf中方法采集、相关工作、Table IV及仓库声明，并渲染核对第4、10、11页。
- PROBE为算法专名；原报告Probe为通用探针，命名造成歧义。后续工程采集层改称Collector。
- AgentTether本身包含采集+诊断+指导+记忆+干预，不能缩减理解为只接收外部trace的RCA函数。
- 论文将PROBE作为前作方法比较，AgentTether增加图定位/在线/跨轮状态；不能仅凭此断言代码库直接升级关系。
- 本地HGT权重是LFS指针，准确说本地权重未落地；未证明上游缺权重或核心源码缺失。

## 已读材料
- 完整读取开发md建议：769段、8952字；ACtrail：192段、8140字；两份DOCX均无内嵌图片，ACtrail中的图号只有文字。
- 申报书21页，重点为低侵入采集、自动RCA、反馈修复；仅作项目背景，不沿用其中技术路线和竞品结论。
- 方向稿建议 Hybrid Observability、Correlator、NormalizedTrace、AgentTether adapter，定位 Evidence-driven RCA & Repair。

## 已核查代码
- agent_tether/schema/types.py 的 Span 更像事件；evidence/schema.py、runtime/run_view.py、recovery/types.py 为不同层次模型，不能直接等同平台OTel Span。
- unitizer.py 通过 correlation_id 连接 tool_call/tool_return，主要在 return 时生成TU；recent_belief/last_feedback是顺序全局状态。并行/未返回调用是重要兼容风险。
- unitizer.status_from_return 先判 ok=True 或 rc=0 为成功，可能掩盖非零rc或错误字段；run_view中另有payload业务状态优先逻辑，两者不一致。
- extract_artifacts 与 claims_from_text 当前返回空列表；系统证据不会自动进入图。
- generate_report 无条件 validate_llm_config，LLM主诊断被 model_status.ok 门控；无HGT时不是等价完整RCA。
- reporting/graph_findings.py 的 run-local检测使用 hierarchical_graph + graph_anomaly；与HGT并列。

## 2026-09-19 服务器样例核查补充

- Z 映射到 ${EXPERIMENTS_ROOT}；通过现有 SSH 访问 ${ENHANCED_SOURCE} 成功，原始数据未修改。
- success_failed_pairs 清单含 SWE-bench 29、AIOpsLab 15、EnterpriseOps-Gym 12；29 个 SWE outcome_history 中 18 个 unresolved→resolved，11 个 missing→resolved。
- 选定 sympy__sympy-13031：两轮 JSONL 784/567 条，334/241 对调用，correlation_id 完整；attempt 均为0，必须依据目录/验收历史规范化；第二轮 run_meta.ok=false 但验收历史 resolved，不能混用状态。
- probe_enhance 有 67 个核心 Python 文件，AgentTether 68；共同路径67，其中32文本相同、7简单改名后相同；额外 live/adapter.py，harness 和 reporting 有实际功能差异。高度同源但无Git历史，无法断定精确版本沿革。
- Probe/.probe/model_bundle/hgt_normal_model.pt 及 probe_enhance 对应文件均192203015字节，SHA256均 fea6468f6ee51968df9d729365c952ca17747b5f0c22d66bc79315d21ccfa1a7，与原LFS目标完全相同。没有复制或替换桌面文件。
- probe_enhance tau数据中1400 JSONL、1394 agentops_report；task_071 两轮 DB reward0→1，第二轮9条PROBE_INTERVENTION。两轮历史模型状态均failed_to_load(torch/PyG)、rca.mode=bundle_missing，不能视为完整HGT复现。
- 核查报告：服务器实验记录与样例核查.md；机器摘要：analysis_sources/server_records_audit.json、sample_quality_audit.json。

## 早期工具限制记录
- 捆绑Python无fitz；改用pypdf成功抽取21页文本，不安装算法依赖，不调用外部模型。

## 进一步确认
- hgt_normal_model.pt 是Git LFS指针；目标192203015字节，sha256 fea6468f6ee51968df9d729365c952ca17747b5f0c22d66bc79315d21ccfa1a7。未下载或执行。
- RecoveryEngine._bundle_grounded_verification 的 ok 只检查模型包加载，并非任务修复验证。
- 隔离加载原仓库两个纯模块的局部检查确认：ok=True/rc=1时TU状态success；仅有tool_call生成0个TU；并行调用B先返回时A的observation使用B结果；extract_artifacts返回空。
- 补充：model/hgt_normal.py 的 _structured_artifacts 另会从call_input和return_output_payload提取结构化路径。因此不能声称整个HGT无artifact能力；但不存在任意SystemEvent自动接入。
- graph_anomaly是当前run内部拟合的Isolation Forest，阈值0.5/top10，不能把run-local直接当成实时诊断服务。
- 主auto instrumentation的OpenAI类patch跳过stream=True；SDK覆盖需能力矩阵。
- live/memory.py只是RingBuffer。跨轮repair memory在skill_router.build_runtime_memory、guidance/feedback、correction和harness state。
- README声称skills目录/CLI命令，但目录不存在，路由已内联于skill_router；说明文档漂移。
- tau2 adapter提取evaluation_criteria.actions并写evaluator_detail；feedback/builder可使用expected_actions。这是评测反馈可用性风险，未审定全部实验或认定结果无效。
- OpenTelemetry官方文档：zero-code主要覆盖支持的库，应用自定义逻辑通常仍需instrumentation。watchdog事件无通用PID字段；psutil为快照/采样，不保证完整系统事件。
- AcTrail AtomGit正文访问失败；公众号内容已读，搜索索引发现仓库README，但不声称审计过其实现。
- 申报书11-14页已渲染，12页图与文字核对；Poppler报缺字体警告但产出可读。


## 2026-09-20 V0.3 离线诊断

已核对并本地加载真实 HGT 权重，第三方源码未改动。源码／权重／manifest 固定哈希；独立 Python CPU worker、SQLite v3 作业、幂等／超时／取消／重启、不可变输入及证据映射、页面操作已实现。真实失败测试轨迹约 18 秒产生定位并解析全部引用。原有 40 项后端回归与新增 11 项诊断检查通过；浏览器实际触发 HGT、查看快照和证据通过。保留完整 analyst RCA 与真实模型 Agent 兼容性 pending，没有调用 LLM。详细验收与范围见 docs/v0.3-validation.md。

## 2026-09-26 完整 RCA 计划核查

- 用户已在被 Git 忽略的根目录 `.env` 配好 ChatAnywhere；本地检查仅确认三个配置项存在，不读取或记录密钥值。此前用户授权的最小连接测试已用 `gpt-5.6-luna` 成功返回，模型服务可用。
- 当前 `diagnosis_worker.py` 在加载权重前调用 `block_network()`；主进程启动作业时白名单环境变量不传 `OPS_OPENAI_*`。现有离线作业不能仅凭 `.env` 变成 analyst 作业，应保留离线模式并增加显式网络模式。
- 上游 `LLMRecoveryAnalyst.analyze_to_plan()` 接受 `CriticalSubtrajectory`、`CriticalTransition`、diagnostic_signals、rca_result；输出 `RecoveryPlan | None` 和分析元数据。结构化计划要求 operation、verification、boundary；失败与非 JSON 时可能返回 `plan=None`，且原实现捕获并回传异常文字。
- 上游 `RecoveryEngine.recover()` 会重新 unitize、评分与选择，并在 analyst 失败时回退到 bundle 计划；其 `verification.ok` 只表示模型包可用，不能视为任务验收通过。直接调用原 `LLMRecoveryAnalyst` 并用当前 HGT 已选择的 TU 构造结构化输入，可避免重复评分；要明确标记为 HGT + analyst 接入，而非声称复现整个 `generate_report` 管线。
- 模型输出的转折点 ID、证据链和计划均为待核验假设；平台必须校验引用属于该次快照，不能把上游 fallback 或自报 confidence 标记为已证实根因。当前报告表允许并存历史、HGT 与新报告，作业表有 mode 字段，可扩展而无需覆盖。
- 网络调用最重要的新边界是明确点击、提示即将发送的片段、输入脱敏与长度上限、单次请求/无自动重试、凭据不进入作业配置/数据库/日志、取消后可能已产生服务商调用。这些应先于真实样例验收实现。

## 2026-09-26 analyst 接入实测

- 使用真实 HGT 选中 TU 组装 `CriticalSubtrajectory`，再调用原 `LLMRecoveryAnalyst.analyze_to_plan()` 可以返回结构化 `RecoveryPlan`。这是平台适配流程，未运行原 `RecoveryEngine` 全管线。
- 真实服务在 1000 输出 token 限制下返回不完整结构；2500 上限的后续手动请求成功。这是模型输出波动与长度约束的实际风险，不能在失败时静默 fallback 或自动重复计费。
- 报告的根因说明与操作建议可引用原始事件，但一次合成样例仅证明接入链路；需要更多有人工标注的失败/成功配对轨迹才能评估准确率。未知引用应标 unresolved，模型置信度不等于校准概率，独立验收不被覆盖。
- 工具采集文字中的任意自由文本可能躲过模式脱敏；预览展示实际发送片段是必要边界。取消子进程不能保证撤回服务商已收到的请求。
- 相对 SQLite 路径在不同进程工作目录下会破坏 worker 输出写入；Store 初始化时固定绝对路径，并保留回归。旧 HGT 报告无原始选中 TU，不能从摘要安全地反推 analyst 输入，须重新定位。

## 2026-09-27 产品体验审查：当前平台初步发现

- V0.4 开发核对：`/api/tasks` 返回 Task 加全部 Runs，并只按最新一轮 `outcome_status` 给任务聚合；没有诊断作业/报告摘要，前端首页当前把所有非运行中的 live Run 写成“尚未诊断”。`/api/runs/{id}/diagnoses` 与 `/diagnosis-jobs` 可分别查本轮报告和作业；诊断状态需组合表达，不能从引擎能力或执行结束推断。
- `origin=live/imported` 与 `sample_kind=synthetic/historical/derived/live` 是两轴。真实 CLI 可产生 `origin=live, sample_kind=synthetic`，单一 SourceBadge 会损失来源方式。
- 当前 RunPage 以四 Tab 承载 Trace/Diagnosis/Outcome/Overview；现有 TracePanel 支持分页、搜索、跟随，EvidenceDrawer 保留原文/哈希，DiagnosisControls 保留预览哈希+人工确认。适合重组而非删除数据能力。
- 诊断作业按 run_id 排序，报告按 run_id 倒序；同一 Run 可以有旧报告又有最新作业失败。HGT 成功只是定位，analyst RCA 报告仍待验证；前端 `hgtDone` 仅看曾成功作业，而服务端预览严格要求当前快照与算法版本相符。

- 只读核对 `apps/web/src/main.tsx`、`diagnosis.tsx`、`live.ts` 及本地既有桌面截图。当前首页主 CTA 是“导入记录”，次级入口是“载入合成样例”；没有在页面提供新的实时监控命令或接入路径。首屏 4 个 KPI 分别是任务记录、执行尝试、原始事件、最新验收未通过；没有运行中或最近失败的专门入口。截图中的首屏主要被概览卡和任务表占据。
- 任务详情先列任务目标和多轮 Run 卡；只有多轮时显示“对照两轮执行”。实时再次执行需要 CLI 显式 `--task-id`，页面没有提示或关联命令。默认每次 CLI 启动新 Task。
- Run 详情先展示四栏：宿主执行、任务验收、诊断引擎/历史报告模型状态、原始事件；然后实时连接/采集状态、四个 Tab：执行轨迹、诊断报告、验收证据、运行概览。失败样例截图中“执行完成”“验收未通过”“RCA 已配置”并列，最有解释力的失败工具返回和断言埋在轨迹下方。
- 诊断 Tab 同时显示 HGT 与 RCA 操作，RCA 必须先有本轮 HGT；历史/HGT/RCA 报告在同一报告列表。HGT 与 RCA 语义及费用边界靠文案解释，新手仍需知道两阶段流程。执行轨迹按原始事件行显示英文 kind/JSON，证据为弹窗；多个 Tab 分割了故障、诊断与验收的上下文。
- `apps/web/src/main.tsx` 当前首页任务表“诊断来源”对现场 Run 仅根据执行中与否给“执行中·待诊断/尚未诊断”，没有查本次真实诊断报告；已诊断 Run 仍可能显示“尚未诊断”，属于可能误导的状态投影。
- 本机 8000 服务在本轮开始时未运行；使用既有页面截图作视觉证据、当前代码作行为证据，不假装已打开在线控制台。
- 官方 Phoenix 文档确认 Trace→Span、Project→Traces，并有单独 Tracing、Annotations/Evaluation、Sessions 学习路径；其文档将质量评估与链路状态区分。AgentLoop 官方 Demo 中心称其为可观测、评估、优化闭环；后续须打开具体 Playground/产品页面，不从营销文案臆测控制台布局。
- AgentLoop 官方文档（2026）给出真实入口：AgentSpace 内默认 AI 应用列表，可按 traceId 直达 Trace 详情、按 session-explorer 打开会话；QuickStart 从空间/接入中心、SDK 采集，到 Agent 总览中的会话/对话/用户/Token/耗时，再看 Trace。公开 Playground 壳可访问，但其嵌入控制台内容尚未从文本接口取到，不能对具体首屏像素/卡片作确定断言。
- LangSmith 官方 tracing quickstart 是先配置项目/API key/环境变量和埋点，运行应用，再从 Tracing→默认 Project→Trace 行进入；Trajectory 展示对话，Details 展示嵌套工具和模型调用树。其 QuickStart 还提供公开 trace 例子，并明确后续筛选和分析路径。
- AgentOps 官方 quickstart 为安装 SDK→`agentops.init`→运行→终端打印 session 深链；额外用 `@session`/`@agent`/`@operation` 形成层级。该资料足以证明接入路径，不足以断言登录后首页卡片顺序。
- Langfuse 官方 docs 为 first trace 提供入门流程；Session 可聚合多条 Trace 回放，对 Trace/Session/Observation 可标注 Score，质量判定与链路层级分开。Trace 页强调高价值输入/输出的可读性，避免原始 JSON；公开文档有 UI 截图/示例工程但未直接登录控制台。
- Braintrust 官方教材/文档说明项目 Experiments 表展示汇总分数、错误数、时延、token/cost，可对两次实验做逐用例 improved/regressed 对照；这是 eval 实验比较，与本平台同 Task 的执行轮次不是同一个概念。
- Weave 官方文档说明项目 Traces 页有过滤表和可展开的指标侧栏，Latency/Cost/Tokens 图可点回具体 Trace；属于高数据量分析路径，不宜直接当作本地小样本首页原型。
- OpenAI Agents SDK 官方文档：tracing 默认启用，Trace 是一次 workflow 的端到端操作，Span 包含工具、模型、handoff、guardrail；可给关联 Trace 设 group_id；Quickstart 跑完后进入 Dashboard Trace viewer。公开文档未给出可核对的首页卡片或失败 RCA 界面，不能将其想象成自动根因平台。
- Datadog Agent Observability 官方文档：每次应用请求为 Trace，嵌套 Span；Trace Explorer 支持 Trace/Span 查询，Operational Insights 汇总错误率、时延、tokens，Insights 对反复出现的成本/可靠性问题给 root cause、impact、supporting evidence、recommended fix。属于运营层聚合与多请求问题识别，和单条本地 Run 的手动 RCA 不同。
- New Relic AI Monitoring 官方文档：AI responses 是跨实体的概览表，可从有误或不准确的响应行进入 trace/span 错误详情；AI entities 可按应用实体查看 APM 指标。对“从问题条目进入具体证据”的路径有参考意义，生产监控规模不宜照搬。
- Helicone 官方 quickstart 是通过 AI Gateway 在 2 分钟内记录首个 LLM 请求；公开资料强调请求、成本、时延/会话归组，故对工具/文件/任务验收的覆盖不能假定与本平台相同。登录后控制台未直接访问，首页视觉与 RCA 能力只标有限证据。
- Sentry 官方 Issue Details 文档说明 issue 顶部先给错误消息、出现次数、影响用户；主体默认打开上下文较全的 Recommended event，关联 stack trace/breadcrumbs/tags。该“失败先行”的工作流是补充参考，但 Sentry 的 issue 聚合与 Agent 的单次任务诊断不是同一数据对象。
- AgentLoop QuickStart 具体证实接入中心按技术栈选择探针/SDK；接入后 AI Agent 可观测页先看 Trace 数、平均耗时、Token 趋势和最新 Trace 列表，点击 Trace ID 看各 Span 的输入输出、工具参数、耗时与 Token；Agent 总览另列会话、对话、用户、Token 和平均耗时。其公开 Demo shell 未提供可验证的内部首屏截图，优先使用此官方操作指南和官方深链文档。
- LangSmith 官方 Filter traces 文档明确项目页可切换 Threads/Traces/Runs，`status:error` 可按 Root/Any run 等作用域过滤，能找失败工具调用和低 feedback。术语层级精细但新手门槛也可能高；不是无条件可照搬。
- Weave 官方 Trace view 是左侧可排序/分页 Trace 表、中央层级树、右侧所选 Op 详情；有成本/时延/tokens 开关和时间线/火焰图/图等视图。官方 Comparison view 允许多条 Trace 或版本对照、指定 baseline、只看变化，说明多轮对比可作为独立工作流而非仅 KPI。
- Helicone 官方 quickstart 是账户/API Key→Gateway 首个请求→数秒后 Requests 页查看；它的第一对象是 LLM Request，与本项目 Task/Run/Tool/Evidence 层级明显不同。
- GitHub Actions 官方工作流运行页明确显示运行中/结束、结束后的 success/failure/cancelled，失败步骤自动展开，可直达日志行；重跑 workflow/失败 job 会生成新的运行记录。这是“先显示故障步骤”及执行轮次语义的补充对照，但不是 Agent RCA。
- 用本机 Edge 只读打开 Phoenix 公共 Demo：`https://phoenix-demo.arize.com/` 落到 Projects，项目卡显示 Traces、Sessions、Latency P50；进入 demo_agents 后先到 Spans 页面，顶部 Traffic/Spans by status 图，Spans/Traces/Sessions/Metrics 标签，表格列含 status、kind、name、input、output、error、annotations、latency、tokens、cost。此为直接观察真实公共控制台；其数据量和分析型表格与本地单任务 RCA 不同。
- 本机 Edge 打开 AgentLoop Playground：外层页面正常，但嵌入 iframe 通过临时 federation 登录跳转，7 秒内未呈现内部正文；不能声称实测内部首屏。AgentOps 公共 app 跳转登录页。Phoenix 公共 Demo 可直接访问，故本轮竞品证据分为“直接观察公共控制台”“官方操作文档”“仅公开壳/登录”。
- 当前体验主要不是黑白视觉问题：本地截图已有一致的黑白灰与清晰状态色；P0 是首页主路径指向历史导入且没有实时接入提示，失败 Run 上首屏没有呈现最关键失败事实。P1 是 Task/Run/Attempt 与进程/验收/诊断概念的翻译层不足、HGT→RCA 依赖和费用边界需要理解内部术语、再次执行需用户记住 task_id、诊断/验收/原始证据跨 Tab 分散；另有首页“诊断来源”可与真实报告状态不一致。P2 是首屏 KPI 与故障任务不匹配、比较页偏汇总计数、原始事件/证据缺少渐进解释；P3 是残余英文工程标签和版本号。
# 2026-09-28 Run Detail 参考图核对

- 01 的主要模式是紧凑 trace 导航与固定选中项详情；02 只用于真实开始时间/持续时间；03 用错误及之前上下文；04 用可展开失败日志。保持浅色主题，不复制品牌、Dark UI、业务对象。
- 现有 TraceEvent API 含 position/occurred_at/duration_ms/correlation_id，但前端没有可靠 parent id。可先按真实顺序排列，可信时间存在时画事件位置/持续区间，不从顺序或名称生成层级。
- EvidenceDrawer 使用 modal，会阻断连续选择；本轮 Run 内证据改用固定 inspector，其他页面继续使用原 drawer。

- 实际后端事件 payload 已含 source_span_id/parent_source_id，前端原类型没有声明；本轮可直接使用，无需新增 API。唯一 source id 解析、完整 parent、无环才启用树；有明确时区的时间才画位置点；唯一 correlation 配对且时间与记录 duration 一致才画区间。
- 首次 1366×768 截图：文档高度等于窗口高度，轨迹与右侧独立滚动；诊断作业保持手动。已为合成历史样例的 ts/duration 不一致采用点视图，不把 1 秒离散示例当成真实工具耗时。

- 最终桌面截图人工核查：1366×768 的失败事件选择、内联日志与右侧输入/错误可同时阅读；1920×1080 的真实来源父子树中 stdout 保持根层普通事件，没有挂到相邻工具下面。dock 独立滚动，页面不再按章节增长。窄屏列宽回归已通过。

## 2026-09-28 Tool Execution 聚合与底部面板

- 后端 `normalizer.correlate` 只凭明确 `correlation_id` 建立 `call_return` confirmed；前端原有 `traceModel` 已要求唯一 call/return、同名且调用位置先于返回。当前 SDK 的工具包装在调用与返回写入同一随机 correlation ID，但每条有各自原始事件与证据 ID。
- 前端现有 API 未直接返回关联 link 列表，UI 只能按上述明确 ID 保守重建显示；无 ID、重复、不同名、顺序反常及冲突父 ID 均保留原始行。聚合行映射回 call 与 return 的原始 event_id，返回事件证据引用也能定位到该行。
- 当前 `RunWorkspace` 已有限高可收起 dock，但 `DiagnosisPanel` 默认展开报告 Findings、指导与作业历史，Run Page 技术入口另开临时 tab，导致下半部仍像长文档。已改为常驻三 tab，假设只显示摘要/关键引用/边界与建议，完整报告手动展开；作业历史和算法原件在技术详情折叠。
- 两个相同时间戳不能证明 0ms 区间，只有结束时间严格晚于开始且与来源 duration 一致时才画时间条；来源自己给的 duration 仍可作为数值展示。
