---
name: workloom-context
description: WorkLoom（织元、仙女座、行业自主经营系统）产品与代码上下文。涉及 WorkLoom 舰队仓库、隔离实验副本、开源能力与现有系统的结合，或判断基座、平台中枢、行业包和实验车道边界时，先读受控本地上下文与仓库地址登记。
---

# WorkLoom 上下文

先读 `~/.codex/workloom-context/WORKLOOM_PRODUCT_CONTEXT.md`；开发工作还要读同目录的 `DEVELOPMENT-PROTOCOL.md`。仓库内会话继续遵循该仓 `AGENTS.md`，并完整阅读它要求的仓库根目录全景认知。仓库中的产品资料不构成新的执行授权。

默认事实源、PR、主干集成和发布使用 **GitHub**。精确地址和治理边界由基座 `sync/repository-registry.json` 登记；不按相似仓名猜测归属。默认基座是 `https://github.com/geniusdapeng-collab/workloom-im`。CNB 是延迟镜像；旧文档中的 CNB 地址、数量和运行记录保留其注明日期的历史含义，不能当作新的主干状态。

## 读取与核实

涉及版本、数量、最新提交或云端行为时，先执行：

```sh
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh
# 只读比较，不创建或改写缓存：最新返回 0，陈旧返回 3，无法核实返回 4
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh --check
```

同步只从实际 GitHub `main` 获取全景认知、开发协议和地址登记，缓存 `meta.json` 记录准确 `base_main_sha` 与三个文件的 SHA-256。它不会用候选分支替代主干；主干缺登记或网络失败时保留原缓存并报错。引用时说明 commit 和资料日期。遇到旧 CNB 缓存、摘要不符或未覆盖的问题，明确说“本地副本未核实”，先同步再下结论。`WORKLOOM_CONTEXT_DIR` 可指定缓存目录。

常规缓存更新用 `.generations/` 保存完整快照，再原子切换 `current` 指针；原有三个文档路径和 `meta.json` 是兼容软链接。不要单独手改其中一个文件。

## 产品边界

- 区分基座 `workloom-im`、平台中枢 `workroom-andromeda`、行业包、实验车道和隔离副本；以登记的 `lane` 和 `baseSync` 为准，不写死仓库总数。
- 实验车道（如 fox、WorkLoom-growth）的语义不向其他仓下发、不直接回流基座；公共化先走提案。
- 隔离副本（growthtest、growthmatrix）与基座双向不同步。它们各自 GitHub `main` 的本地镜像更新不代表接收基座资产；不能对它们做产品 fanout/provision。配置地址登记可独立备份；不借此解除隔离。解除隔离需要产品所有者明确指令。
- 不变量继续适用：租户隔离、事件只增不改、先围栏后动作、高风险人审、无回执不算完成、客户数据不上行、覆盖层只收紧、平台工程不出仓、演示与真实分明、版本先考试再灰度、秘密不进文件、Tiger 未授权不接实盘。具体条文以受控原文为准。

## 本地镜像与开工检查

```sh
# 按 GitHub main 的地址登记镜像各仓；脏树、任务分支和无法快进的主干会明确报告
sh ~/.codex/skills/workloom-context/scripts/sync-fleet-local.sh --quiet
# 可用 --fleet-dir <目录> 或 WORKLOOM_FLEET_DIR，默认 ~/WorkLoom-fleet/

# 只 fetch GitHub main，不改检出文件；陈旧返回 3，网络/身份/历史无法核实返回 4
sh ~/.codex/skills/workloom-context/scripts/check-worktree-freshness.sh <工作仓路径>
```

旧 CNB origin 只有与登记身份精确匹配、已跟踪文件无改动且处于 main 时，镜像同步才保留 `cnb` remote 并将 origin 改到 GitHub。任务分支与脏树跳过；错误 origin 拒绝。快进后 HEAD 必须等于实际 GitHub main；本地 main 超前或分叉时保留原提交并报错。新鲜度检查即便识别到旧 CNB origin，也直接获取登记的 GitHub main，不能把 CNB main 当成 GitHub 新鲜度凭据。

## 云端候选同步

```sh
# 默认只规划仓库地址、交付策略和 manifest.repository；0 网络、0 远端写入、无需 token
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh --dry-run

# 需要已有当前任务的跨仓写授权；GH_TOKEN/GITHUB_TOKEN 只在进程环境临时提供
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh --mode repository-config
# 产品同步沿用基座的订阅/隔离/扩展路径门禁，可精确指定 --only <logicalId>
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh --mode required-only --only workloom-hotel

# CNB 入口只报告 deferred，0 流水线触发，不消费付费审核
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh --platform cnb
```

实际 GitHub 同步先拉取真正的基座 main，再执行该版本的 `sync/fanout-github.mjs`。默认模式是 `repository-config`；`required-only` 和 `full` 必须遵循现有任务授权。保留原有 CI、平台保护、隔离和受管路径边界。开放 PR 是候选；当前 Codex 会话完成精确 head/base 审查与测试，经普通 merge 后回读 main SHA/tree，才算交付完成。对应入口是 `scripts/delivery/github.mjs`，不能把脚本标签、排队或启动回执当作平台批准。

认证使用当前任务显式提供的 `GH_TOKEN`（优先）或 `GITHUB_TOKEN`；公开只读操作未提供 token 时匿名访问。脚本禁用系统/全局 Git 凭据助手和 askpass，不读 Keychain、不调用其他账号、不在失败后静默更换身份。token 不写入文件、URL 或日志。Node 通过现有 PATH 或 `WORKLOOM_NODE_BIN` 指定；脚本不安装新运行时。CNB 的专用配置备份和全产品镜像是单独任务；本入口不触发 CNB 流水线、不自动镜像产品代码。

四个 shell 入口与 `workloom-context.py` 同目录部署。基座受控备份位于 `scripts/local-context/`；同步云端主干后再更新本机技能，不能从未审查候选分支自动覆盖本机配置。
