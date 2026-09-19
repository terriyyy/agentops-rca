# Git 与资料管理

## 提交范围

提交开发计划、整理后的事实、文档、后续应用代码、迁移、依赖锁文件及经审查的小型夹具。`task_plan.md`、`findings.md`、`progress.md` 按 planning-with-files 工作流维护；公开版本不保留服务器登录信息和原始私有材料。

以下内容保留本地、默认忽略：

- `analysis_sources/`：论文／申报书全文、图片、对话材料、服务器核查脚本与 JSON。
- 两份原始中文审查报告：包含本机／服务器路径，适合在本机查阅。
- `.local/`：本机配置、原规划备份和提交审查摘要。
- `.env*`（经审查的 example 除外）、私钥、凭据、IDE 配置。
- 模型权重、第三方算法副本、原始遥测、数据库、日志、上传与运行产物。
- Python/Node 依赖、缓存、编译与测试产物。

不全局忽略 JSON/JSONL、Markdown 或所有图片，避免隐藏未来合法 Schema、测试夹具和产品资产。不能因为 `.gitignore` 已配置就跳过暂存内容检查；已跟踪文件不受新增忽略规则保护。

每次提交前：

```powershell
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached
```

不要把密钥放入命令行、Git remote URL、文档示例或 Git 提交。如果真实凭据已进入历史，单纯删除文件不能撤销泄露，需要撤销凭据并处理历史。

## 本地路径

项目当前目录名为 `agentops-rca`。后续命令都在项目根目录执行，文档内链接使用相对路径。外部算法、实验和模型路径作为机器配置保留在 `.local/` 或未跟踪的环境文件中。

现有机器的原始审查资料无需搬进仓库；克隆本项目的其他成员按开发阶段需要自行配置已获授权的数据来源。Git 只管理当前项目，不初始化或修改外部算法目录及挂载盘。

## 首次推送到 GitHub

先在 GitHub 创建空仓库 `agentops-rca`，不要预建 README、许可证或 .gitignore；可先选私有可见性，后续再决定发布。以下 `YOUR_ACCOUNT` 是占位符，需要替换为自己的用户或组织名。

```powershell
cd D:\Projects\agentops-rca
git remote add origin https://github.com/YOUR_ACCOUNT/agentops-rca.git
git remote -v
git push -u origin main
```

如果已经存在 origin，先用 `git remote -v` 核对；仅在确需改址时使用 `git remote set-url origin <新地址>`。HTTPS 认证使用本机凭据管理器／GitHub 支持的认证方式，不能把 token 拼进 URL。

Initial commit 只在本机创建，本次不创建 GitHub 仓库、不添加远程、不推送。Git 提交作者沿用本机现有 Git 配置；推送会公开给有仓库访问权限的人，包括提交中的作者信息。
