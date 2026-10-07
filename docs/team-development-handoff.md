# 团队开发交接：代码、AgentTether 与 HGT 权重

更新：2026-10-05。项目目录名为 `agentops-rca`。本文依据当前代码整理；Windows 本地链路已有验收，真实 Agent 在本机执行、226 提供隔离测试 MCP 的拓扑也已验证；平台 API＋诊断 worker 在226的完整部署、每位成员的账号权限与依赖仍需现场核验。文中服务器部署命令是待验证模板。

发布说明：模型连接及接入流程的基线为1c1049d；交接采用包含后续配色与实名分工修订的提交版本。分发时确认该版本已推送，并提供**远端可获取的完整commit SHA**。下方2026-10-02审查是历史快照，本地提交不表示GitHub已包含最新功能。

## 0. 一次交接应交付什么

先读[三人分工与交付要求](project-gaps-and-team-division.md)。建议先做30–45分钟共同演示，再让成员各自在干净目录复现，不能只观看已有实例就视为交接完成。

交付清单：

- 仓库权限、交接版本SHA和各自feature分支；每人一份任务单（目标、负责目录、接口、交付物、验收标准）。
- README和本文；陈志敏阅读采集接入/兼容边界，林亦航阅读HGT/analyst与模型连接，徐安阅读反馈/复跑关系，公共Schema共同协调。
- 可直接运行的无模型synthetic样例；其预期是执行完成、任务检查失败、工具配对、实时事件和原件可查。
- 按需提供获授权私有依赖清单及可信校验值；不发送整个项目、其他成员的虚拟环境、数据库或.env。
- 真实案例的复跑前置条件：原Agent/case、MCP准备步骤、各自模型配置及预算；旧临时端口/容器已清理，不能照抄旧Run链接或脚本就期望复跑。

现场演示顺序：从CLI启动样例→网页实时工具Span→失败检查→错误/原件→RCA预览与人工确认的流程说明→同一Task多轮。说明“后续成功”目前可能是原Agent反馈带来，平台RCA驱动的修复复验是下一阶段工作。无模型入门不要求实际调用RCA。

成员交回：自己的启动截图/Run结果、运行命令、依赖版本、捕获范围/不可用项、首个小PR或任务设计。负责人核对后确认可开始并行开发。

### Git协作模板

每人用自己的GitHub账号；URL不能拼接密钥。下方占位符先替换，`<REMOTE_HANDOFF_COMMIT_SHA>`必须已推送。

```powershell
git clone <TEAM_REPOSITORY_URL> agentops-rca
cd agentops-rca
git switch -c feature/<member>-<topic> <REMOTE_HANDOFF_COMMIT_SHA>
```

完成小步工作后：

```powershell
git status --short
git diff --check
git diff
git add <reviewed-source-paths>
git diff --cached
git commit -m "feat(<module>): <concrete change>"
git push -u origin HEAD
```

在GitHub创建PR，写问题/行为、接口变化、验证结果及限制，由负责人review合并。需要同步main时先确认自己的工作已保存，再fetch/merge；不要为了同步运行reset --hard，也不要三人直接覆盖main或同一服务器目录。公共契约变更先协调，CLI、worker和UI不各自发明字段。

## 1. 成员拿什么，在哪里开发

推荐：GitHub 管平台代码；普通成员本地开发；指定人员在获授权的226环境中维护真实算法联调实例。算法源码、模型文件、凭据和私有实验记录通过独立受控渠道交接。

| 工作 | 从GitHub获取 | 另外需要 | 是否需要HGT权重 |
| --- | --- | --- | --- |
| 页面、Trace、时间轴、事件详情 | 前端、API、合成夹具 | Python / Node依赖 | 否 |
| Collector、SSE、数据导入、状态投影 | 平台、CLI/SDK、测试 | 本地虚拟环境、独立测试数据库 | 否 |
| 分析面板、预览/确认交互开发 | 当前前端与测试 | 合成历史报告、受控Mock；不冒充真实推理 | 否 |
| 真实HGT定位、适配器联调 | 平台worker及配置脚本 | 获授权的AgentTether源码、匹配bundle、独立诊断Python | 是 |
| 真实analyst RCA | 同上 | HGT已就绪，以及获授权的模型服务配置 | 是；另需API凭据 |

补充：陈志敏若使用AgentTether采集桥接，需要获授权的私有采集源码（目前加载三个ops文件），但不需要torch/HGT权重。普通SDK/CLI和Mock测试无需该私有源；相应私有兼容测试在缺源环境明确跳过。

HGT是本地模型推理，本身不使用LLM API key。没有权重时监控、轨迹、上报检查和历史报告仍可用，但不能执行真实HGT；当前联网RCA也依赖成功HGT候选，不能只填key就跳过。

当前worker与API必须在同一主机：API读取本机 `.local/diagnosis-config.json` 并启动其中指定的Python子进程。没有独立“远程HGT URL”配置。若权重仅在226，就让API和诊断worker一起运行在226，再通过SSH转发访问；本地前端可连接该API。把服务器路径直接写进Windows配置不会使其变成远程推理。

## 2. GitHub交接范围与本次核查

提交平台代码、Schema、依赖锁、使用文档和经过审查的小型合成/脱敏夹具。以下不提交：

- AgentTether第三方源码副本、真实 `hgt_normal_model.pt`、其他checkpoint与模型bundle。
- `.env`、SSH私钥、token、服务器登录配置。
- `.local/diagnosis-config.json`、虚拟环境、数据库、私有实验日志和原始遥测。
- 整个项目目录的备份压缩包、模型打包文件和运行产物。

现有 `.gitignore` 已覆盖这些常见位置/后缀；保持原样，不使用 `git add -f` 绕过。**忽略规则不作用于已跟踪文件，也不能擦掉提交历史**，见[GitHub忽略规则](https://docs.github.com/en/get-started/git-basics/ignoring-files)与[历史敏感数据处理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)。Git LFS是大文件存储与传输机制，不能把公开仓库中的模型变成保密文件，见[GitHub LFS说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)。

2026-10-02本地只读核查：

- 本地可达历史共3个提交；当前跟踪文件和这些历史未发现权重后缀、私有配置目录、真实 `.env`、数据库等匹配路径。
- 未发现10MiB及以上的可达文件对象；常见OpenAI/GitHub token、私钥头模式未命中。URL凭据模式的一处命中是测试中的固定拒绝样例，不是真实登录信息。
- 模型/配置探测路径均命中忽略规则；远程URL未包含用户凭据。
- 初稿审查时，本地 `main` 与**缓存的** `origin/main`无提交差异，但存在尚未提交的V0.4前端增量；本次交接发布将该增量与文档一起提交，成员应确认获取包含本文的版本。

以上不是完整保密审计，也没有新fetch或检查GitHub可见性、所有远程分支/标签、Release附件、Actions产物或他人的fork。若发现历史曾含真实凭据/权重，另行协调清理；不要把删除当前文件当作已解决。本轮不改写Git历史、不提交或推送。

## 3. 普通成员：无需权重即可开始

负责人先确认GitHub权限、待交接版本的commit SHA，并将该版本代码/本文一并推送；成员通过自己的GitHub账号认证，不共用token。`<TEAM_REPOSITORY_URL>`替换为实际仓库URL，不在URL中拼接密钥。

Windows PowerShell，Python3.12、Node22或更高：

```powershell
git clone <TEAM_REPOSITORY_URL> agentops-rca
cd agentops-rca
git switch -c feature/<your-name>-<topic>
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.lock
.\.venv\Scripts\python.exe -m pip install -e .
cd apps/web
npm ci
npm run build
cd ../..
.\scripts\start.ps1
```

访问 `http://127.0.0.1:8000`。先不要配置 `.env`或诊断环境；缺少算法应明确显示不可用，不能用假模型结果冒充真实定位。首页可以载入标记为合成的演示记录。

另开终端，在项目根运行真实文件操作/测试的确定性Agent，不调用模型：

```powershell
.\.venv\Scripts\agentops.exe run --sample-kind synthetic --goal "团队接入演示" -- .\.venv\Scripts\python.exe examples/local_agent.py --delay 4 --fail
```

打开CLI打印的Run链接；确认执行结束与任务未通过分别显示、事件更新、错误和检查原件可查看。模型分析按钮因缺算法/凭据不能运行属于预期结果。

开发热更新：一个终端启动8000后端，另一个终端进入 `apps/web` 执行 `npm run dev`，访问5173。已有Vite代理 `/api`指向127.0.0.1:8000，无需修改。具体接入见[V0.2说明](v0.2-agent-integration.md)。

## 4. 需要本地真实HGT的成员

算法负责人在确认团队获准使用/分发后，通过受控服务器目录或其他私下授权渠道提供一个匹配版本的依赖包。SHA-256只能确认拿到的文件与可信版本一致，不替代授权；不要对未知来源权重自行算一个hash就视为可信。

交接清单：

| 依赖 | 必须确认 |
| --- | --- |
| AgentTether源码 | 对应版本/commit或源码树SHA；根目录下包含 `agent_tether/model/bundle.py` |
| HGT bundle | 本次已核对的bundle包含 `manifest.json`与真实 `hgt_normal_model.pt`，两者配套；交接整个匹配bundle |
| 校验清单 | 从算法负责人独立确认权重SHA-256；同时记录manifest/源码版本、文件大小、来源及使用范围 |
| Python环境 | Python3.12；平台与诊断环境分开，使用 `apps/api/diagnosis-requirements.lock` |
| 验证样例 | 经过审查的串行、完整工具调用轨迹；不打包私有数据库和原始实验全集 |

若成员不应拿到原始权重，只授予其使用服务器集成实例的权限。不要通过GitHub Release/LFS/公开网盘补发权重。

建议本机放在仓库外 `D:/AgentOpsPrivate/`，或已忽略的 `vendor/`下；不要复制别人的 `.local/diagnosis-config.json`，其中是原机器绝对路径。

Windows注册示例（所有占位符替换后执行）：

```powershell
py -3.12 -m venv .local/diagnosis-venv
.local/diagnosis-venv/Scripts/python.exe -m pip install -r apps/api/diagnosis-requirements.lock
.venv/Scripts/python.exe scripts/configure-diagnosis.py `
  --python .local/diagnosis-venv/Scripts/python.exe `
  --source "<获授权的AgentTether源码根目录>" `
  --bundle "<匹配manifest和权重的bundle目录>" `
  --expected-weight-sha256 "<算法负责人独立确认的SHA-256>"
```

脚本先校验权重，再试加载；成功才写 `.local/diagnosis-config.json`，每次推理前继续校验源码、权重和manifest。修改算法源码或更换权重后，停止现有诊断作业再重新注册。不能用Git LFS指针文本代替权重。

重新启动后端，查看“运行环境”或 `GET /api/diagnosis/capabilities`，确认HGT就绪。对合成失败Run手动“定位异常步骤（本机）”，核对候选、证据和技术来源；不能将加载成功或异常分数当作准确率/根因概率结论。

若要完整RCA，在“运行环境→管理模型连接”（`/settings/models`）保存自己获授权的服务地址、模型ID和API Key；保存不会发请求。当前支持OpenAI-compatible Chat Completions，HTTPS或本机HTTP，模型/供应商不固定为ChatAnywhere或gpt-5.6-luna；原生Responses/Anthropic不受支持。`.env`仅兼容旧本机配置，不建议把负责人配置复制给成员。只有HGT成功、预览实际请求并人工确认后才调用模型；真实付费调用不作为入门前置。

这是**一个本地工作区默认RCA连接**，没有账户级私人凭据隔离。各人本地实例分别配置；共用服务器实例会共用该工作区连接，应由管理员明确权限与计费归属，不能宣传为每个成员的私人key。被监控Agent自己的模型/key与平台RCA连接是两份独立配置，见[模型连接说明](rca-model-connections.md)。不分发`.local/rca-credentials/`，也不复制加密文件期望在另一Windows用户下使用。

## 5. 226服务器：代码与私有依赖分开部署

可以在226上clone平台；clone带下来的是Git中的代码，**不会自动包含已忽略权重**。算法负责人维护独立的、获授权用户可读的只读依赖目录；联调人员在各自平台目录创建自己的配置，引用该目录。具体主机别名、账号、权限和路径由管理员私下给成员，不在可公开文档中写登录密码或真实内网地址。

建议分开：

```text
<每个成员自己的目录>/agentops-rca/     各自分支、.venv、.local、data
<获授权算法目录>/AgentTether/          指定版本源码，只读
<获授权模型目录>/bundle-<version>/     配套manifest及真实权重，只读
<指定集成实例目录>/agentops-rca/       一人负责发布，不作为所有人的编辑目录
```

Linux模板需要先确认 `python3.12`、Node>=22、Git、SSH已可用；锁文件在Windows环境验证过，Linux轮子可用性、CPU资源、网络和PyG安装尚待实测，不保证直接安装成功，不随意升级依赖后沿用旧验收结果。HGT当前走CPU，本地记录不是GPU部署要求。

```bash
git clone <TEAM_REPOSITORY_URL> agentops-rca
cd agentops-rca
python3.12 -m venv .venv
.venv/bin/python -m pip install -r apps/api/requirements.lock
.venv/bin/python -m pip install -e .
cd apps/web
npm ci
npm run build
cd ../..
python3.12 -m venv .local/diagnosis-venv
.local/diagnosis-venv/bin/python -m pip install -r apps/api/diagnosis-requirements.lock
.venv/bin/python scripts/configure-diagnosis.py \
  --python .local/diagnosis-venv/bin/python \
  --source "<服务器可信源码根目录>" \
  --bundle "<服务器匹配bundle目录>" \
  --expected-weight-sha256 "<负责人独立确认的SHA-256>"
export AGENTOPS_DB="$PWD/.local/server-development.sqlite3"
export AGENTOPS_DIAGNOSIS_CONFIG="$PWD/.local/diagnosis-config.json"
.venv/bin/python -m uvicorn apps.api.main:app --host 127.0.0.1 --port 18000
```

18000仅为示例，每个开发实例由管理员分配不冲突端口。一个实例只有一个Uvicorn worker，不加 `--workers`；不同实例不共写同一个SQLite文件。每个成员有自己的checkout，模板显式定位配置指向自己的注册文件；设置AGENTOPS_DB的隔离实例默认不读取仓库.env，其RCA凭据按数据库主名隔离，应在模型连接页重新设置。不要在上游实验目录启动平台或覆盖已有算法环境，Windows的start.ps1不用在Linux执行。

成员本机通过自己的SSH登录，示例 `<SSH_ALIAS>`替换为获准使用的226主机别名：

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8000:127.0.0.1:18000 <SSH_ALIAS>
```

保持终端运行，访问本机 `http://127.0.0.1:8000`。先确认本机8000未被其他平台实例占用，否则选不同本地端口；本地前端热更新要复用现有代理则需使用8000。用其他端口时CLI的 `--server`也须相应修改。

此时两种开发方式：

- 直接浏览服务器构建页面：展示数据、API、HGT均来自服务器实例。
- 本地 `apps/web`运行 `npm run dev`：访问5173，前端代码在本机， `/api`经本机8000隧道访问226。此模式不要再启动占用8000的本地API。

也可以在成员本机运行Agent，将采集发送到经隧道访问的服务器API（需已安装本地CLI）：

```powershell
.\.venv\Scripts\agentops.exe run --server http://127.0.0.1:8000 --sample-kind synthetic --goal "服务器联调" -- .\.venv\Scripts\python.exe examples/local_agent.py --delay 4 --fail
```

Agent命令仍在成员本机执行；平台后端没有因此获得“运行用户任意命令”的能力。记录会进入服务器数据库，须确认遥测中没有不应共享的代码/凭据；现场spool和其会话token仍留本机忽略目录。

当前产品没有用户/项目访问隔离，SSH授权只控制入口，不会新增平台内数据权限。集成实例的授权访问者可查看该实例记录，并可使用已配置的诊断能力；默认只启用离线HGT、保留analyst未配置，需付费联调时单独约定操作人员与预算。不要把18000直接绑定0.0.0.0开放给互联网。

## 6. 协作、验收与交接责任

普通成员各自分支和环境；约定前端、Collector/API、算法适配、验收文档负责人。通过PR合并到main，集成实例只更新评审后的指定commit。平台版本、源码版本、bundle哈希与诊断环境均记录到交接清单；不共享虚拟环境或复制整库作为默认入门方案。

提交前最小检查：

```powershell
git status --short
git diff --cached --stat
git diff --cached --check
git check-ignore -v .env .local/diagnosis-config.json models/hgt_normal_model.pt
```

同时人工核对暂存diff，不把输出/截图中的key或服务器登录信息带入提交。前端代码/依赖改动执行 `npm run build`；API/Collector改动执行 `.venv/Scripts/python.exe -m pytest tests/integration -q`；浏览器验收用独立8001测试数据库，按[README](../README.md)操作。没有真实算法依赖时相关用例可以明确skip，不能改成“假推理已通过”。

交接完成标准：

1. 新成员能从指定commit安装平台，不拿key/权重也能跑确定性失败Agent、观察Trace、区分退出码和任务检查、看原始证据。
2. 算法联调人员能校验依赖来源和哈希，注册HGT并手动定位，保留候选到事件的证据引用。
3. 服务器维护者实测Linux安装、资源、端口/数据库隔离、SSH访问与SSE实时连接；真实LLM另行授权验收。
4. 用户明确知道分析是假设，检查是独立上报事实；所有成员都不自动触发付费诊断。

尚待负责人补充（通过团队私下渠道）：GitHub仓库权限与交接commit、SSH别名/个人账号、226真实源码与bundle路径、算法再分发许可、Linux验证结果、权重校验清单、集成实例维护者和模型调用权限。本轮已写好流程，没有为完成文档擅自部署服务器或发送依赖。
