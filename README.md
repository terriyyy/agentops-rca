# agentops-rca

面向本地代码／运维 Agent 的实时监控、故障调查与独立验收平台。诊断阶段可手动使用 AgentTether 的离线 HGT 和 analyst RCA。

V0.1 历史工作台与 V0.2 实时监控已实现：历史导入、命令启动 Python Agent、工具／日志采集、SSE 实时页面、补传、中断处理、独立验收证据与两轮对照。V0.2 核心以确定性工具 Agent 验收，随后已验证一个真实 EnterpriseOps-Gym Agent 的两轮采集与独立检查，见[真实桥接复跑](docs/agenttether-real-agent-replay.md)；不代表任意Agent、并发、完整逐token流式或226原地执行均受支持。V0.3 已接入真实权重的离线 HGT 定位，以及手动触发的 AgentTether analyst RCA 假设与证据追溯。平台RCA驱动的修复复验仍待开发。

V0.4 将入口改为以 Run 为中心的工作台：首页直接展示正在运行和需要处理的 Run；Run 详情使用执行轨迹主视图、固定选中事件详情和 Run 级根因假设／独立验收面板；Task 页只承担同一目标下的多轮历史与前后对照。执行完成不代表任务验收通过，诊断报告也不改变验收结论。

V0.3 使用与能力限制见 [离线 HGT 验收说明](docs/v0.3-validation.md)和 [analyst RCA 验收说明](docs/v0.3-analyst-validation.md)。在已结束 Run 的 Trace 工具栏进入“分析失败原因（RCA）”，或查看已有原因分析；先手动定位异常步骤，再预览实际发送内容并确认模型调用。原因分析与任务检查分别保留假设和独立检查，完整报告、分析记录与技术资料按需打开。新环境通过“运行环境 → 管理模型连接”配置自己的服务地址、模型和 API Key，详见 [模型连接与凭据管理](docs/rca-model-connections.md)。未配置模型仍可监控，真实离线定位另需可信算法源码与权重。

## 启动

需要 Python 3.12（已在该版本验证）、Node.js 22 或更高版本。Windows PowerShell 首次安装：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.lock
.\.venv\Scripts\python.exe -m pip install -e .
cd apps/web
npm ci
npm run build
cd ../..
.\scripts\start.ps1
```

浏览器访问 **http://127.0.0.1:8000**。前后端由同一个本地服务提供，Ctrl+C 停止；数据库默认在被忽略的 `data/agentops.sqlite3`。当前机器已经安装依赖并完成构建，再次启动只需执行 `scripts/start.ps1`。如果 PowerShell 执行策略限制脚本，可直接运行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8000
```

这是单用户本地应用，绑定回环地址；没有实现互联网部署所需的身份认证。`AGENTOPS_DB` 可指定其他本机数据库文件。前端开发时分别运行后端和 `apps/web` 下的 `npm run dev`，访问 5173 端口；修改后端 Python 代码后需重启服务，或在开发环境使用 Uvicorn `--reload`。

## 首次体验与真实记录

平台启动后，在另一个终端的项目根目录运行以下命令，再打开 CLI 输出的执行链接：

```powershell
.\.venv\Scripts\agentops.exe run --sample-kind synthetic --goal "本地工具任务" -- .\.venv\Scripts\python.exe examples/local_agent.py --delay 4
```

示例执行真实文件操作和测试，决策为确定性逻辑，不调用模型。添加 `--fail` 可演示“进程退出码为 0，但任务验收失败”。已有 Agent 的 `@tool` 接入、同任务多轮、补传与能力边界见 [V0.2 接入说明](docs/v0.2-agent-integration.md)。默认 spool 位于被忽略的 `.agentops/`，会话凭据有效期 24 小时。

- 首页点击“载入演示样例”可直接打开失败 Run，沿页面查看历史报告和独立验收；样例始终标记为**合成演示**，不代表真实诊断效果。
- 数据导入页选择 `manifest.json`，再选择该清单引用的 JSONL、报告、验收和反馈文件。示例清单位于 [tests/fixtures/demo/manifest.json](tests/fixtures/demo/manifest.json)。
- 团队可导入[真实两轮脱敏体验包](tests/fixtures/team-enterpriseops/README.md)：启动平台后执行 `.\.venv\Scripts\python.exe scripts/import_package.py tests/fixtures/team-enterpriseops`。展示 7→10 次工具执行、10/14→14/14 条检查和已有报告证据；无需 Key 或权重，标记为历史导入／派生样例。第二轮由原 Agent 的检查反馈推动，不代表平台 RCA 修复闭环；完整提示词、邮件正文及自由文本日志已移除。
- 已有 SWE-bench 案例可以用 `scripts/prepare_history.py --source <案例目录> --out data/imports/<新目录>` 生成私有导入包。原始数据不修改；`provenance.local.json` 不上传、不提交。
- 服务启动后也可执行 `.venv/Scripts/python.exe scripts/import_package.py data/imports/<目录>`。重复导入保持幂等；相同 Run 内容发生变化会被拒绝。
- 单轮导入后直接打开 Run；多轮导入后打开 Task 历程，再进入具体 Run 或前后对照。Run 页默认优先显示执行步骤，切换“全部事件”可查看普通日志；点击步骤在右侧核对错误、输入输出和原件。顶部 RCA 入口打开 Run 级原因分析侧面板，检查结果独立保留；报告证据可定位轨迹。运行元信息从“运行资料”打开。来源未提供的时间、关系、证据、验收或报告不补造。详情见 [Run Workspace](docs/v0.4-run-workspace.md)。

不会读取 `.local/workspace.json` 自动扫描外部目录，也不会自动启动模型或运行日志中的命令。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest tests/integration -q
cd apps/web
npm run build
```

浏览器验收需要 Microsoft Edge。启动独立测试数据服务：

```powershell
$env:AGENTOPS_DB = "$PWD/.local/e2e.sqlite3"
.\.venv\Scripts\python.exe -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8001
```

另开终端，在 `apps/web` 下执行 `npx playwright test`。测试使用合成夹具，检查导入、对照、证据跳转及窄屏布局；不会修改主工作区数据库。执行后在该终端移除 `AGENTOPS_DB` 环境变量或关闭终端，避免后续启动误用测试数据库。

运行时校验源为 [contracts.py](apps/api/contracts.py)，可用 `scripts/export_contract.py` 更新 [JSON Schema](packages/contracts/import-manifest.schema.json)。后端 API 文档位于 `/docs`。

## 开发入口

- [AgentTether 采集接入](docs/agenttether-capture-integration.md)：私有采集模块桥接、无模型自检、EnterpriseOps 可选接入与兼容性边界。
- [团队开发交接](docs/team-development-handoff.md)：成员无权重开发、私有算法依赖分发、226服务器隔离联调、SSH转发及Git核查边界。
- [当前阶段与三人分工](docs/project-gaps-and-team-division.md)：徐安的RCA反馈迭代、陈志敏的接入采集、林亦航的RCA优化，以及交付效果、接口与验收标准。
- [第一版开发计划](docs/v1-development-plan.md)：范围、模块、页面、阶段和验收标准。
- [V0.2 实时监控开发计划](docs/v0.2-development-plan.md)：接入边界、采集与传输、实时页面、开发顺序及验收清单。
- [V0.2 接入与演示](docs/v0.2-agent-integration.md)：可执行命令、工具 SDK、补传及真实模型兼容性验收。
- [V0.2 验收记录](docs/v0.2-validation.md)：协议、进程、浏览器检查与已知限制。
- [V0.4 Run-centric 开发计划](docs/v0.4-development-plan.md)：工作流、状态边界与阶段验收。
- [V0.4 验收记录](docs/v0.4-validation.md)：实际交付、自动化与浏览器验证、待办边界。
- [核心数据契约](docs/data-contract.md)：任务、执行、事件、验收和诊断之间的关系。
- [V0.1 验收记录](docs/v0.1-validation.md)：实现范围、真实数据联调与限制。
- [Git 与资料管理](docs/repository-guide.md)：敏感资料、Git 检查与后续 GitHub 推送。
- [task_plan.md](task_plan.md)：当前工作及开发阶段状态。
- [findings.md](findings.md)：已核实事实与限制，主机标识已去除。
- [progress.md](progress.md)：完成记录。

## 开发约定

项目目录名为 `agentops-rca`。仓库内引用使用相对路径；数据、算法源目录、模型文件和服务凭据在开发接入时通过本机配置指定，不写死服务器地址。

原始材料、实验记录及机器相关核查报告仅保留本地并由 `.gitignore` 排除。换一台机器克隆本仓库不会自动获得这些文件、算法代码或模型权重。未来允许提交经过审查的小型脱敏测试夹具，存放于 `tests/fixtures/`；不提交整个实验数据集。

历史 PROBE 报告与当前 AgentTether 重新运行的报告必须注明来源。执行完成、任务验收通过和诊断引擎可用是三个不同状态。

现阶段不纳入第三方算法源码或权重；后续复用前核实其许可证与再分发条件。本仓库暂不代替第三方作者授予许可。
