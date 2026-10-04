# 方案审查发现

## Run 控件第一批实施结果（2026-10-04）

现有缩放/适配/跟随/类型筛选和步骤切换已经存在，采用组件整理而非重复增加功能。新增 SegmentedControl 保留原 aria-pressed 语义并支持方向键；CodeViewer 只展示原字符串，换行与行号不会改变复制内容/文件 SHA。展开阅读使用原生 dialog，保留选择/时间窗与焦点；证据定位仍使用现有 API/关系。筛选标签仅显示显式条件，清空不重置步骤预设，不恢复实时跟随。

首次视觉验收发现 inline-flex 代码行中的换行被当作空白，后续行沿横向排布；改为 flex 块行，新增行坐标/换行宽度断言。工具栏高度收敛，保留 1366 桌面 RCA 调查阅读空间；复制播报使用独立 aria-live，避免与证据定位的状态提示混淆。最终 27 项浏览器测试全部通过，覆盖 CLI/SSE 重连、过滤/复制、键盘、真实时间和证据联动；只用合成数据，实际 Run 页面只读。

真实截图：.local/controls-before-{1366,1440}.png、controls-after-{1366,1440}.png、controls-reader-1440.png；均被 Git 忽略。没有新增外部请求依赖、模型调用或后端行为。

最终补充：原件读取的内部定位不能递增请求版本，否则定位完成的finally会被错误跳过，页面停留“定位证据…”；真实截图发现后已修正为仅新用户选择/关闭/切换递增，新增完成状态断言，最后16条调查/工作区回归全部通过。四张真实Run前后及原件/检查截图复拍，页面错误为0；无真实模型或HGT推理。

## 2026-10-04：RCA侧面板交付验收

S1/S2/S3完成，待用户预览。Run Header RCA入口+全高右侧原因分析/独立检查+38px底部状态条；原件peek→真实事件→返回分析保持滚动/焦点/选择，迟到请求不能覆盖新选择。显示原文节选而非生成短结论，无支持/反驳或根因置信度虚构。结构化SQL/JSON检查依据默认收起，结果与摘要/来源优先；所有字段、SHA与原件入口保留。

生产构建/diff检查通过；30项唯一浏览器用例通过，1项真实SymPy来源条件跳过（先整组29+1，最后19条定向18+1含新结构化检查用例）。验证桌面完整调查空间、3尺寸无横向溢出、成功引用仍成功、验收冲突/未知与RCA独立、人工预览确认、过期预览、跨页与迟到证据、保留旧报告和作业取消入口、原文全文。真实Run只读1366/1440前后及原件/检查截图保存.local；未启动真实模型/HGT/Agent。8000保留预览，本轮8001隔离DB服务结束后关闭。代码未提交/推送，已记录skill计划与实施。



## RCA侧面板实施审查（2026-10-04）

S1/S2实现：RCA入口进入Run Header，事件详情与Run级原因分析/任务检查共享全高侧面板，各自独立滚动、持续挂载，底部仅38px状态入口。分析面板默认结论→真实证据行→下一步检查；手动定位/预览动作贴近面板底部，发送内容占完整面板，人工确认逻辑不改。技术资料与完整报告仍按需drawer。可靠配对的两条Ref合为证据行，但参数/返回原件入口独立，成功记录不会因引用被改为失败。

小屏桌面实拍后调整：长报告默认取首句原文并标注“摘要原文节选”，展开与完整报告保留全部原文；无合适句界时仅CSS折叠，不生成或关键词分类结论。修正旧dock通用CSS的证据居中与操作区底部24px边距，使1366可看清证据行。普通详情宽度与分析宽度独立，Escape、预览和选中保持。证据读取请求加版本检查，关闭/切换后迟到响应不能夺走用户选择。

旧RunWorkspace dock初始180–260px，手动高度保留；AnalysisPanel宽正文+300px常驻操作栏，报告与操作占空间不均。新方案将Run级内容移为右侧模式，event组件独立、分析/检查挂载保持；底部只提供状态入口和资料。字段只有summary/findings/boundary/verification_suggestion，不能仅根据自然语言关键词伪造“已找到根因/证据不足”机器状态，更不能把成功的被引用工具显示为失败因果。首轮保留摘要原文3–5行可展开，根因始终待验证、历史与定位有独立标签；未来短摘要需明确算法字段。本轮不改变报告。

证据按真实Ref→event/traceModel映射；仅可靠工具配对的UI行可聚合调用返回，引用去重只按原始evidence_id，不吞原件。行状态来自事件，引用含义仅“报告引用”，点击真实定位并提供原件peek/完整事件入口。独立检查仍读outcomes，不由报告填补。再次运行功能尚未开发，不添加误导可执行按钮，Task历程链接已有真实路由。

## 2026-10-04：分段用量 UI 开发

- U4审查：Run默认展示全部时序记录，真实Run170条中日志占多数，现有只有类型过滤。原上下键只改选择而未移动DOM焦点，连续按键可能停在同一下一行；分栏宽度固定，无事件定位链接。按原结构做交互层修正，模型请求/响应仍保持真实事件。

- U3截图验证：1366/1440/390均无横向溢出。真实实时范围5条，0正在运行/3待处理，64572已记录Token，覆盖12/19响应；最新Run170事件/10工具/7响应有用量/任务检查通过，未重跑Agent。失败检查反馈用红色异常图标，绿勾只用于已收到数据或通过检查。
- U3审查：首页轮询/api/overview，每桶最多20条，接入说明始终铺开。桶数组长度不能当全量当前数；新增只读summary选项同时过滤桶与统计，默认API保持原形状兼容。
- U3采用最近20次入库记录范围，不增趋势/百分比/虚构吞吐。接入反馈以最新实时Run为对象，历史导入不会显示成正在接入；4个检查点来自事件、工具配对、响应Token和outcomes。刷新错误保留旧数据并提示，不把服务在线等同Agent在线。
- rg使用Windows通配符路径apps/web/src/*.css报错，改为目录与-g过滤；无产品文件受影响。


- 用户接受调研的四项优化，要求先提交基线，并在第一段UI完成时展示后等待反馈，不整页重构。
- 两轮真实响应带usage_metadata，第二轮7次响应总量41448（input40413/output1035）；LLM_REQUEST+RESPONSE共14事件，不能计14调用。
- 当前无活动诊断作业，8000未监听。启动本地服务截取基线，不启动Agent、模型或HGT。
- 第一段增加只读Run指标API与局部用量组件。首页聚合延期到视觉反馈后；没有价格配置不展示虚构费用。
- 提交前已扫描114候选文件，未发现密钥/权重/私有运行文件；基线测试70通过，3个私有来源条件用例跳过。
- U1取特定SDK来源usage/usage_metadata/response_metadata.token_usage；输入/输出/总量保留覆盖数、来源总量冲突、推导标记；缓存/推理子项不重复相加，不估算费用。不解析生成正文里的usage。
- LLM按producer+correlation及正确顺序唯一配对；重复关联排除，无法关联的请求不猜配响应；仅响应可单独计数。工具只按原始调用计数，唯一配对返回单独统计。
- 实际成功Run25306a1934194c62bdd14fff81b1a491的只读API确认7模型/10工具、input40413/output1035/total41448、总量覆盖7/7；没有重新执行Agent/付费模型/HGT。
- Run摘要采用白底紧凑统计带，不新增Dashboard卡片；点击模型/工具筛选并选中步骤，Token明细每行定位响应，可继续打开已有原始证据。小屏默认调查高度适度压紧，保留拖动和既有业务语义。
- 真实截图.local/usage-before-1366.png、usage-after-1366.png及1440版本，usage-model-calls.png、usage-model-detail.png；均为忽略的本地截图。首页/全局字号/预设筛选尚未实施，待首段视觉反馈。


## 2026-10-02：EnterpriseOps-Gym真实接入预检

- 本次服务器平台使用专属环境/数据库，监控数据暂留服务器，不混入正式本机库。邮件容器采用network-none与本机回环代理，保留MCP上下文头；容器只运行模拟邮件数据库，没有外部邮件网络。
- 同版本平台锁文件安装遇到镜像缺annotated-doc版本、官方源证书自签验证失败；不关闭TLS校验，尝试项目声明的requirements.in兼容范围，实际版本将独立冻结并在服务器验证，不改原环境或本机锁文件。
- 适配使用显式LLM边界/Agent工具调度/VerifierEngine，保留原业务返回及反馈决策；取消原Agent隐式LLM重试、设20次模型调用上限及90秒单次超时。本次是有限兼容性测试，不能冒称复现原命令全部重试策略。

- 服务器可通过既有SSH访问；用户给定的工作目录与另一套Python解释器均存在。实际使用给定解释器Python3.13.9，具备httpx/langchain_openai；工作目录自己的venv缺依赖，不能替换使用。
- probe_iter2_case只有一个邮件MCP案例，5种可选工具、14项SQL检查（7个名字重复）。原executor按名字保存字典会折叠重复结果；适配层需保留实际逐项执行结果，不能伪造额外检查或以Agent自述验收。
- localhost案例MCP服务未启动；现有email镜像可用，实际容器内部端口8005。选择创建专属回环端口的测试容器，不启动/覆盖旧实验容器或修改原案例。
- 原executor内置反馈迭代，两次execute_single_run是真实尝试，可各建一个平台Run并保持task_id。原evaluate另有默认5次整例重试，测试限制为1次整例以避免错误重复付费。
- 旧PROBE自动finish默认生成LLM RCA；本次通过其明确支持的AGENT_SRE_PATH=/nonexistent禁用旧监控，不启用平台RCA，仅采集Agent自身LLM/工具和已有检查。未加载外部收集器时原反馈只用检查失败信息。
- 代理配置复用仓库.env中的base/model/key。该Agent的openai分支不接受自定义base；vllm分支实际是OpenAI兼容ChatOpenAI，支持自定义base，保留现有provider契约。密钥只进入0600私有运行配置。
- 初次docker全量ps超时，images匹配过宽导致冗余输出；改为已确认email镜像的ancestor过滤后成功。无模型调用或原环境更改。

## 2026-10-02：团队交接核对

- 本地可达历史3提交：权重/私有配置/数据库路径无命中，无>=10MiB对象；常见key/token/私钥模式无命中，URL凭据唯一命中为测试拒绝样例。未fetch、未审查远程可见性/其他分支附件，本结果不能保证GitHub全范围安全。.local/team-handoff-git-audit.json保留本地摘要，不含密钥。
- 缓存origin/main与本地main无提交差异，但最新V0.4前端增量未提交，交接前需由用户另行授权审查提交/推送，成员才能clone到最新结果。
- 本机真实bundle只含manifest.json和hgt_normal_model.pt；源码loader使用torch.load(...weights_only=False)，只应对获授权可信来源运行配置检查，不能以自行计算hash代替来源认证。跨平台独立虚拟环境/注册配置，Linux轮子与服务器安装待实测。

- .gitignore已有.env、.local、vendor、models、checkpoints、pt/pth/ckpt/safetensors及数据库/日志忽略；GitHub官方说明忽略不作用于已跟踪文件，删除工作树文件也不能清除历史。需要核对本地可达历史，不能仅凭规则宣布远程安全。
- configure-diagnosis.py使用独立Python、可信AgentTether源码根、包含manifest.json与hgt_normal_model.pt的bundle及独立可信权重SHA-256；成功才保存本机.local/diagnosis-config.json。配置不能跨Windows/Linux直接复制。
- 当前诊断worker在API所在主机直接启动子进程，非远程HGT服务；本地前端+服务器API可通过SSH转发联调，但本地API没有远程权重路径/推理后端自动接入能力。Vite /api代理固定127.0.0.1:8000。
- API是无产品身份认证的单用户本地应用，一Uvicorn worker/独立数据库；226共享开发应各自目录/端口/库或指定一个集成实例，不能各成员在同目录并发改源码或多个API写一库。Linux安装与服务器真实路径尚未验证。
- Git LFS解决大文件传输，不是隐私隔离；本任务建议私下、获授权的依赖分发，不把权重改上传LFS。官方来源：https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage；https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository。

## 2026-09-30：Run分析面板实施核对

- useRunAnalysis集中当前Run报告、配置、作业、选定报告、预览和操作锁；Workspace引用也直接使用同一报告集合，不再重复拉取。作业历史改为消费相同jobs，technical只按需展示。
- Run首屏提供分析/查看动作；Selected Error和失败任务检查可进入同一Run面板。两主Tab为原因分析/任务检查，分析记录计数明确为报告数；更多资料和完整报告使用原生dialog抽屉，Escape关闭并恢复焦点。
- 检查source_kind已核对normalizer实际值outcome/report/telemetry及live上报；补充前端可选类型，不改API。冲突与unknown使用Run投影，历史报告不能写任务结论。
- 1366/1920实看正式Run截图：白底、实心蓝/失败红；bar像素宽度与before完全一致。检查一条记录时dock180px，原因面板260px，均无页面溢出；检查来源标明平台未复跑。
- 摘要用实际DOM溢出检测控制原文展开入口，证据移到摘要后；关键限制保留于有界滚动面板。全文、全部字段JSON及原件在按需资料中保留。没有前端模型摘要或语义改写。
- 新增测试覆盖选中不改类型色/失败色、不改时间几何，报告历史/全文/上下文，关闭/过期预览与手动定位。额外核对冲突结果、缺采集/配置与未解析引用；模型调用使用Mock，真实HGT仅本机离线。

## 2026-09-30：纯白背景与实心 Timeline 条补充调研（完成，实施待办）

- 用户新增要求：总体基础背景为纯白；Timeline条提高饱和度和对比度，采用实心填充；仅写入规划，尚未实施。
- 当前styles.css根背景为#f7f8fa；run-console已是#fff，但局部表头/底部栏/日志背景和低饱和时间条形成灰淡观感。duration-bar为#a9ccd3、失败#e4aaa0、选中#91b4dd，问题不只是透明度；不应错误声称所有时间条都使用opacity。
- Datadog官方Trace View明确区间长度表达相对耗时、颜色默认按service（也可host/container）、错误可高亮。Grafana官方Trace View提供共享时间线和critical path深色段；本项目没有关键路径数据，不能借深色段伪造关键路径。
- 已核对真实界面截图/源码，确定类型与状态的颜色优先级、背景范围和验收标准，新增D2V并入现有实施顺序；细则见docs/v0.4-white-surface-solid-timeline.md。

- 已实际重看之前保存的Datadog官方控制台截图：白底共享时间区间、实心黄/蓝/绿/紫条、错误红标；Langfuse公开Trace实测截图中SPAN为蓝条、generation为粉紫条、选中行有浅色底。不是以营销配图猜样式。
- 固定Langfuse源码TimelineDense约1569–1578行明确：hue表示类型，选中使用ring，不能因hover/selected将GENERATION改成代表SPAN的蓝色。默认可见bar不应因状态选择变透明；本项目采纳稳定类型色+轮廓，失败采用独立红标。
- 研究访问记录：Datadog直接open及猜测Langfuse trace-timeline路径抓取失败；Datadog搜索返回的官方文档可读，并有已保存官方界面截图；Langfuse使用固定源码/既有公开Trace截图。不声称本轮新登录控制台或取得Codex实际背景色值。
- 计划采用#fff全站基础画布；Run白底共享轴，类型实心色、失败红、选中浅行底+深轮廓，保留类型标签/错误图标。Tool可靠区间为条，LLM仅响应/普通日志/检查记录仍为点；不按名字造LLM Span，不画critical path。
- 候选色值的理论对比度已按sRGB计算：六种bar/point颜色对白底均超过4.5:1，对建议#EAF2FF选中底均超过4:1。该计算不是界面验收；实施仍需检查实际computed style、alpha与截图。用户要求纯白基础画布，不等于清除所有语义交互底色。

## 2026-09-30：原因分析与任务检查开发规划

- 固定实施方向：Run首屏分析动作 + 底部原因分析/任务检查；分析记录计数指报告数量，技术资料进入次级入口。Tab和折叠本身不是问题，改造重点为用户目的、入口权重和按需证据。
- 已核对实际代码：RunWorkspace当前三种DockMode及244px默认高度；DiagnosisControls已有eligible、成功HGT前提、GET预览、确认POST及快照哈希绑定。首屏入口复用同一生命周期，不另起模型流程或放宽资格。
- 推荐先整理当前Run状态与操作控制，再改入口/容器、结果/证据、引导预览；防止首页式“已有报告却显示未分析”的投影漂移在新入口复现。旧报告和新作业失败必须共存。
- 前端可以组织已有summary/findings/guidance/boundary/outcomes，但不能安全改写所有历史自由文本。原文按需保留，重要不确定性可见；模型内容契约作为单独延期项。
- 所有证据用既有openEvidence解析与回跳；逻辑Span合并不删除调用/返回原件。检查缺actual/expected时明确缺失；报告来源与独立测试来源区别保留。
- D0–D5与验收场景已写入docs/v0.4-run-analysis-development-plan.md。无需新增后端接口/持久化实体；本轮只规划，前一轮未提交的产品代码保持原状。

## 2026-09-30：底部诊断/任务检查面板调研

- Sentry官方2025-05截图已实看：Issue右侧Seer Initial Guess短句+明显Find Root Cause按钮；当前2026-09 Autofix文档核对阶段、支持证据链到代码/遥测。年份区分，不将旧图当当前像素模板。
- 本地API持久化 RCA 已含 findings.description（failed_assumption）、evidence_chain（ID引用而非自然语言因果路径）、guidance、verification_suggestion、boundary；可先用现有字段分块，但不能凭字符串变成已证明的因果链。prompt只要求简体中文和specific hypothesis，不约束短句/篇幅，文案过长不仅是CSS问题。
- 建议方向：首屏Trace上方Run级“分析失败原因”+失败上下文第二入口，底部保留可调高工作面板但改“原因分析/任务检查”两种用户意图，技术资料进入次级菜单。保持右侧只服务选中事件，避免1366px再常驻第三列。
- 原因结果分“已知事实/可能原因/相关证据/下一步检查”，待验证标记一次，未知具体说明；不能把模型摘要短句化成更强结论。任务检查先结果、依据、来源，缺少actual不编造，验收通过不自动验证诊断。
- 不使用研究平台的自动诊断/修复/PR、聊天或HypothesisTree能力作为当前功能。扩大RCA可发现性与执行付费推理独立。


- 已实际浏览官方产品界面截图：Datadog Trace View 显示主图+可调高度的selected-span tabs；LangSmith Chat官方图是Dataset右侧侧栏（只能证明侧栏模式，Trace适用性来自文档）；Sentry 2026-09-21 Code Changes显示阶段折叠、带日期/状态的反馈时间线与CI失败；GitHub Actions官方失败日志图是按step展开+行号，不是全篇报告。
- 不笼统声称“成熟产品不用tab/折叠”：Datadog有context tabs，Langfuse有Scores tab；Sentry有阶段展开。可借鉴的是对象、权重与按需证据，而不是控件禁用。
- 证据类型必须区分：实际访问Langfuse公开Trace（上一轮）、本轮官方界面截图、官方操作流程；未登录Sentry/Datadog/LangSmith客户控制台，未触发分析或模型调用。


- 当前 DiagnosisPanel 原样铺 summary、boundary、guidance、verification_suggestion；重复诊断状态和待验证说明，前三条证据 ref.label 可仅为事件ID。根因假设计数实际 report_count，含历史/定位/模型报告，不能当作独立根因数量。
- DiagnosisControls 暴露 HGT/analyst 前置条件；RCA 预览必须有 succeeded offline_hgt 作业，GET预览不调用模型、确认才POST analyst-jobs。提升入口不能绕过条件。
- OutcomePanel 只有 status/source/basis/summary/evidence，不含 expected/actual 结构字段；可呈现断言，不能从 assertion failed 编造实际输出。检查来源可能为独立文件，也可能为报告/遥测，不能一律标为独立测试。
- 官方资料核对：Sentry Autofix RCA/方案/代码是阶段、支持展开证据；Datadog错误Trace提供就地调查入口；LangSmith Chat是trace上下文侧栏（原Polly）；Langfuse确实使用Scores tab。问题不是tab/折叠本身，而是入口、三者等权、默认全文和语义。
- 研究访问限制：部分web抓取Sentry/Datadog失败，改真实Edge浏览官方文档。Sentry issue-fix 重定向到 autofix；猜测Datadog /bits_ai/trace_analysis 返回404，需从TraceView真实链接查找。读取长文时本机GBK不能编码特殊字符，后续只输出精简字段并使用UTF-8。


## 2026-09-30：Langfuse Timeline 研究（已实际核查）

- 真实 Edge 浏览器访问用户提供的 public project 首页与 Traces 列表：页面先 Redirecting，最终跳转 /auth/sign-in，需要登录；未尝试绕过访问控制。静态抓取只返回 Loading。
- GitHub REST API 触发匿名限流，改为 filter=blob:none 的只读 Git 克隆至被忽略的 .local/research/langfuse。固定研究源码提交为 646c15a60ebeeda0f0a2b6c92bfb1f9e3adab82e。
- 当前源码存在 TraceTimelineDense/TimelineDense.tsx、TraceTimelineCompact.tsx、TraceTree.tsx 与 timeline/layout/viewTransform/viewport 等纯展示计算。官方 Trace URLs 文档提供无需登录的 public 单条 Trace；已通过官方文档给出的单条公开 Trace 访问真实详情。
- 实际进入官方公开 Trace 2d6b96f2-0a4d-4366-99a5-1ad558c66e99 成功：3.09 秒，Tree/Timeline/Graph 切换；qa→retrieval→vector-store/context-encoding 的真实层级、WARNING、generation 及固定右侧 Preview/Log View 可见。此单条 Trace 无需登录，项目目录页仍需登录。
- 固定版本 dense 源码通过共同 selectedId 和 onSelect 联动详情；统一时间坐标支持 fit/focus/zoom/pan。density.ts 指定鼠标行高约26px、触摸44px，bar 通常约0.6行高，标签12/13px；本项目用户要求更大可读字号，采用更宽松行高，不照搬密度值。

- 已实际切换 Timeline 并点击 generation：选中行与 bar 同步高亮、右侧更新同一 observation 的 Preview/Log View；共享垂直刻度贯穿各行，不存在每行灰色 track。真实浏览器量测行高26px、bar18px；成功操作 Zoom in 与 Fit whole trace，轴窗口从0–4秒变为2–4秒再恢复。
- 本项目采取42px单行、14px步骤名、13px详情正文；不伪造 TRACE根节点、GENERATION区间或缺失的 parent。公开项目列表需登录与公开单条 Trace 可访问的事实区分保留。

## 2026-09-28：长 Run 时间轴比例尺

- 用户截图对应的导入 Run 有 784 原始事件，来源时间总跨度约 868.25 秒。前 100 条事件只覆盖约 65.3 秒；其中工具耗时从约 0.1 秒到 21.52 秒。以整轮时间为唯一线性轴，绝大多数区间必然被压到数像素。
- 当前列表一次只展示 50 个逻辑行，故可对这些行的真实事件时间单独确定线性窗口，保持条形的起点和长度同一比例。轴标签仍从 Run 起点算，必须显示“本页 / 整轮”当前范围以免误读。
- 只有可靠调用/返回双端时间能画区间。仅提供 `duration_ms` 的普通事件或不一致的配对仍只画时间点；不能为改善观感虚构开始时间或拉伸毫秒级耗时。

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

## 2026-09-28 状态配色与时间轴续改

- 当前 1366px 工作区左侧轨迹宽约 680px；时间列使用 `minmax(70px,.55fr)`，刻度只有左右与中点三枚，文本很浅，span 区间条 7–9px 高但颜色与选中/失败区分不足。
- `traceModel` 已只从带时区的 `occurred_at` 建立 Run 时间域，`callInterval` 仅对唯一明确关联、严格递增且与来源 duration 一致的 Call/Return 返回区间。可强化这些已验证区间的 bar；普通事件仍只能绘时刻点，不能根据单条 `duration_ms` 猜测起止。
- 来源字段已有四类顶部状态、`kind`、`tool_status`、报告引用 event_id；可以在前端派生只用于样式的状态与 referenced row，无需新增 API 或改写事实。
- 浏览器实测旧刻度与行内时间背景相差约 8.7px，根因是刻度位于滚动容器外，行内容受稳定滚动条预留宽度影响。已把刻度行移入轨迹滚动容器并设 sticky；专项浏览器断言两者左边缘差小于 1px。
- 1366×768 与 1920×1080 截图核查：状态带使用克制的蓝/绿/红/紫/灰点；工具、LLM、日志、验证类型只在小图标底色区分。唯一可靠的工具区间显示有起点/长度的 bar，失败尾端红色终点；普通事件为点，缺时间不画轴点。

### EnterpriseOps secure execution relocation
服务器226的系统CA与certifi均无法验证外部HTTPS（模型与PyPI均为self-signed certificate）；未关闭校验或发送模型请求。删除服务器临时密钥文件。改为本机独立Agent环境运行原evaluate/Agent/SQL case源码副本，通过SSH本地转发连接226的network-none隔离email MCP；模型从本机安全HTTPS调用，平台采集到本机8000。服务器原代码与Agent环境保持不变。

### EnterpriseOps-Gym real Agent acceptance completed
成功Run 88254262789845c2aec716e0c65ccd7c / Task 32c053c274af46cab78f2edf36b9b41f：5次真实模型请求、9次工具调用/返回confirmed pair、14条SQL检查全通过、151事件证据全可解析、completed/passed/complete。SSE记录实际running期间1→151事件；浏览器运行中/完成截图无pageerror，工具筛选9行，选中Call/Return显示正常。早期桥接压缩头错误导致无工具的真实failed两轮，已保留并修复；此轮总模型请求7次，没有RCA/HGT。
代码交付CaptureSession、显式EnterpriseOps串行接入和8项无模型回归；补充MCP/JSONRPC明确错误判定、未知状态保留、已知凭据repr日志脱敏、NO_PROXY回环绕过及工具发现前置检查。compileall通过。私有API证据及Git已跟踪/新代码检查均无模型Key。临时2容器/proxy/tunnel与本机/服务器LLM私有配置已清理；原服务器服务/环境、仓库.env和平台8000服务保留。详细命令、位置变化和限制见docs/enterpriseops-real-agent-acceptance.md；实测证明在.local/enterpriseops/且被Git忽略。226直接执行与其他Agent/并发/真正工具失败恢复仍pending。未提交或推送。

### AgentTether采集审查：入口与模块
本地9416/agent_tether版本0.4.0有两套入口：monitor→enable_auto_instrumentation较保守，AgentTetherSession→auto_instrument_all更广；ops/instrumentation含通用sync/async属性包装、LangChain Runnable、MCP call_tool、env、subprocess、HTTP、OpenAI/LiteLLM/Anthropic。live/observer提供kind/correlation/seq/attempt/round/step_idx/task/tools/context，emitter仅append JSONL，无平台outbox/ack/重传协议。Schema声明parent字段不代表实际已产生父子关系。monitor默认generate_report=True且finish(enable_llm_rca=True)，迁移需禁用诊断自动调用。后续核查具体异步/流式补丁、敏感信息与线程行为，不先承诺全覆盖。

### AgentTether采集审查：兼容性与实测
静态确认自动OpenAI class补丁只挂Completions.create，stream=True直接绕过；auto_instrument_all不调用LangChain/MCP通用包装。隔离抽取未修改上游函数，使用openai2.29/httpx0.28/langchain-openai1.1.11 + MockTransport（0真实请求）：sync OpenAI记录1，async/stream新增0；显式LangChain包装对当前ChatOpenAI.ainvoke也记录0（setattr失败被吞）；HTTPX Client.request包装的input_builder遗漏self，method记录为Client对象、url变成GET。证据.local/research/agenttether-capture-proof.json，未跑完整AgentTether宿主/真实模型，不能扩展为所有版本都不支持。observer的on_tool_return把ok=None且无sig转tool_failed信号；JSONL不统一脱敏/ack/outbox，Schema parent字段不会由主要call/return入口自动填入，on_llm_end仅结束记录的latency而非真实起止Span。当前核心未发现CPU/memory/network采样。

### AgentTether采集迁移评估完成
审查当前9416/0.4.0采集模块与服务器probe_enhance同名函数结构，补充docs/agenttether-collection-review.md。原函数隔离、真实SDK+MockTransport确认同步OpenAI1/异步0/流式0，LangChain ainvoke包装当前对象记录0，HTTPX输入method/url错位；0真实网络/费用。模块接口多于平台，但可靠采集交付与证据不能整体替换。推荐observer bridge+具体入口修正、保留outbox/API/SSE、禁用自动报告/RCA/干预；未改源码/后端/前端/真实样例或复制私有算法。完整行为/其他版本未实测，边界已列出。

### 桥接实施边界
实际私有模块为 source/agent_tether/ops/instrumentation.py；通用包装的取消误判与 Pydantic 实例 setattr 均需兼容层处理，源码不修改。模型仍为 llm 事件，工具有可靠关联才配对。
OpenAI2.29 的 AsyncCompletions.create 公共方法有同步装饰层，异步判定需 inspect.unwrap；这是实际 SDK 测试才发现的兼容性问题。
兼容审查补充：LiveEvent 新 capture=None 默认不能改变旧 0.2 encoded hash；ingest 对未提供元数据的事件移除该字段后哈希，新增回归核对旧 receipt hash 与重传幂等。
桥接验证完成：真实SDK7项均成功，包括原EnterpriseOps LLMClient/AgentOrchestrator方法（生命周期/MCP为模拟，无真实case结论）；0f6d52fb7072419b8070393212e1a9b1为新增合成实机采集证明。Capture complete不等于框架全覆盖；旧Run不追补事件。采集来源SHA是3个ops文件，不是权重/全仓库SHA。

### 新桥接真实验收
新AgentTether桥接来源hash40d4490...真实两轮通过：第一10/14，反馈第二14/14。两轮均工具完整、SSErunning更新、Capture complete；独立检查与执行/诊断分离。第一次验收证明因现场另有一项offline_hgt作业而不能断言零作业，保留实际结果，不将其计为自动模型调用。226 TLS原地执行和逐token流式依旧未验证。

## U4交付观察（2026-10-04）

真实成功Run25306a1934194c62bdd14fff81b1a491有170原始记录：可靠调用配对后160逻辑行，其中131普通日志、29非普通日志步骤。默认步骤预设保留工具、LLM、检查和异常日志；LLM仍是原始Event（仅有duration不建立起止区间），工具唯一关联才聚合，现有证据映射保持。全部事件可恢复原始行；筛选时不重新编造树。

左右分栏在桌面支持指针/键盘，限制轨迹至少440px、详情至少310px；窄轨迹使用容器查询收起冗余时间说明，viewport不足1020时沿用固定布局，不硬塞拖动。选中事件本机链接支持真实调用/返回事件定位，不是互联网共享或权限系统。视图偏好只存浏览器session、按Run隔离。实时新增数按原始event_count，不等同于新增工具Span，也不等同于Token流。键盘选择已修正DOM焦点交接，搜索框不会被方向键劫持。
