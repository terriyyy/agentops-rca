# 方案审查发现

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
