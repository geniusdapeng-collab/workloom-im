# WorkLoom IM · 基座能力可审计升级机制（base-sync）

> WorkLoom IM 的**基座能力**更新后，只有 main 对应的 `ci-gate` 成功，中央流程才会向全部订阅行业仓
> 推送独立升级分支并创建可审计 PR；**永不直推、永不自动合并行业仓 main**。行业仓心跳只读检测漂移。
> 同步范围由 `sync/base-scope.json` 机器可读声明唯一界定。三端导航、布局、弹层、表单、状态、设计令牌与视觉语言
> 都是 **WorkLoom IM 基座能力**：源码只存在于 `packages/ui`，经稳定 registry 制品与升级 PR 下发，绝不复制。
> 行业属性与演示能力（Bundle、种子数据、行业页面投影与文案）不进入公共能力分发。

## 为什么旧机制会失效（失效根因分析）

| # | 失效模式 | 实证（2026-09 八仓审计） |
|---|---|---|
| 1 | **零自动化**——同步靠人脑记忆 + 手工复制 | 仓内 workflows 只有构建/CI/release，同步类提交全部手工完成 |
| 2 | **范围无机器可读声明**——"哪些是基座能力"靠人肉判断 | 漏同步：V4 定制向导接线不完整被一致推广到 8 仓；误覆盖：`trpc/router.ts` 行业段被覆盖后回滚重打（有提交为证）；`package.json` exports 覆盖致行业模块 `ERR_PACKAGE_PATH_NOT_EXPORTED` 服务瘫痪 |
| 3 | **无对齐状态记录**——漂移无人发现 | 审计时单仓与基座漂移达 78 个文件，无告警无感知 |
| 4 | **行业演示与基座混居**——无边界护栏 | bundles/ 行业包、seed 行业数据、行业文案与基座能力同树共存，同步时全凭自觉 |

本机制针对四条根因逐一设防：**ci-gate 成功事件触发升级 PR**（治 1）、**scope 声明式边界**（治 2）、**state 基线 + 只读心跳检测**（治 3）、**exclude + 下发前黑名单硬校验双保险**（治 4）。

## 架构：双向闭环

```
                 WorkLoom IM（父仓 · 唯一事实源）
                 ├─ sync/base-scope.json      ← 同步范围声明（include/exclude/锚点合并/防污染护栏）
                 ├─ sync/child-repos.json     ← 子仓订阅清单
                 ├─ sync/base-sync.mjs        ← 同步引擎（detect/pull/push 三模式，Node 原生零依赖）
                 └─ .github/workflows/base-sync-push.yml
                            │  workflow_run：main 的 ci-gate 成功
                            │  → 固定升级分支 → 逐仓可审计 PR（不直推 main）
                            ▼
        ┌───────────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼  （7+ 子仓，订阅制扩容）
   workroom-fox  workloom-hotel  hyperreality …
        └─ .github/workflows/base-sync-heartbeat.yml
           行业仓只读心跳：每日 cron + 手动 + push 自检
           落后 → CI 报告；等待基座中央流程创建升级 PR
        └─ .workloom-base-sync.json（对齐基线：lastSyncedBaseSha）
```

**防副本漂移设计**：子仓 workflow 只是触发器——引擎与 scope 每次从基座 main 的 raw URL 实时拉取，
边界规则演进只需改基座一处，全部子仓下次心跳自动生效。

## 同步范围边界（base-scope.json 速览）

- **include（基座能力）**：`packages/{base,runtime,shared,db}`、`apps/server/src`（核心服务）、`apps/desktop`、`apps/web/src/lib`、`scripts`（基座脚本）、共享 CI、`AGENTS.md` 等
- **exclude（行业属性、应用投影与演示能力，不做文件覆盖）**：
  - 行业演示：`bundles/**`、`scripts/seed*`、`demo/**`、`docs/demo`、`mock/**`
  - 本地应用编排层：`apps/web/src/{App.tsx,shell,pages,components,styles,audio,voice}`、`apps/webb/**`、`apps/webc/**`、`apps/site/**`。这些目录只能做路由、权限和行业投影适配；基础交互壳必须实际调用 `@workloom/ui`，由消费门禁证明，不能自建同名组件。
  - 行业服务接线：`trpc/router.ts`、`service/{dialog,kb,store,gateway,ticket,adapters}`、`devtools.ts`
  - 行业 KPI 语义：`captain/{charter,decision,loop,board}`、`tenancy/auth.ts`
  - 数据库纪律：`packages/db/migrations/**` 不自动同步；各行业仓须按自己的迁移编号链在升级 PR 中人工接入并评审
  - 技能体系：`skills/**` 由仓内既有 skill-ops 保鲜环负责分发，base-sync 不碰
- **共享 UI 基座能力**：`packages/ui` 是三端交互壳、组件、令牌、图标和视觉语言的唯一源码，不进入文件复制；`ui-v*` 发布 `@workloom/ui` 后，`sync/ui-upgrade-pr.mjs` 给每个行业仓创建精确版本升级 PR。升级门禁不仅检查版本，还检查三端是否真实渲染共享 `AppShell`、导航、上下文栏、弹层和表单，拒绝本地同名副本及非品牌令牌重定义。
- **anchorMerge（锚点合并，非覆盖）**：`packages/*/package.json`、`tsconfig.json` 等——基座版为底，**子仓独有 exports/deps/include 条目一律保留**（血泪教训：整体覆盖曾致行业模块瘫痪）
- **pollutionGuard（推送前硬校验）**：待同步清单命中 `bundles/`、`seed`、`hotel-baseline`、`ai-pm`、`yunqi`、`ecommerce` 等黑名单关键词，或单次超 200 文件 → 立即中止。**宁可漏报，不可污染。**

## 不可绕过的远程写入门禁

`base-sync.mjs push` 在执行任何远程写入前同时核对：

1. `SYNC_TOKEN` 或 `GH_TOKEN` 存在；
2. `BASE_SYNC_GATE_STATUS=success`；
3. `BASE_SYNC_GATE_SHA` 与当前检出的基座 `HEAD` 完全一致；
4. `BASE_SYNC_GATE_URL` 提供可追溯的门禁运行链接，且基座工作树无未提交变化。

任一条件不成立都会强制降级为 dry-run。`workflow_dispatch` 也固定为 dry-run，不能成为绕过入口。
每个升级 PR 都记录完整基座 SHA、ci-gate 运行链接、复制/合并/跳过数量和最多 50 个变更文件。
升级分支固定为 `chore/workloom-base-<基座SHA前12位>`，重复运行可幂等复用；PR 的目标分支固定为 `main`。
基座仓的 `SYNC_TOKEN` 需对订阅行业仓具备“Contents: write、Pull requests: write”；行业仓本身不保存该凭据。

## 使用方式

### 父仓：基座能力更新后（自动）

正常开发合入 main 后先运行 `ci-gate`。只有该次 main push 的门禁成功，`base-sync-push.yml` 才检出
门禁对应的精确 SHA，并对订阅清单逐仓生成升级 PR。PR 必须继续通过行业仓自己的 CI 和人工评审后再合并。
基座门禁失败、PR 场景门禁、SHA 不匹配、缺凭据或手动触发都不会产生下游写入。

### 子仓：日常开发（自动/半自动）

- 行业仓 heartbeat 只读比较 scope 内文件；发现漂移时在 Job Summary 列出差异并标红提醒。
- 跨仓写凭据只保存在 WorkLoom IM 基座仓，行业仓不配置跨仓写 token。
- 对齐由中央升级 PR 承载；行业方通过 PR 查看 diff、运行 CI、评审并决定合并或驳回。

### 手动操作（任何环境）

```bash
node sync/base-sync.mjs detect --repo /path/to/child          # 检测：落后则退出码 2 + 差异清单
node sync/base-sync.mjs pull   --repo /path/to/child --no-commit  # 本地逐文件拉齐，保留待评审改动
node sync/base-sync.mjs push   --base /path/to/workloom-im --dry-run # 父仓视角：只生成全部子仓计划
# 通用：--dry-run 只看不改 · --json 机器可读 · --base-url 镜像前缀（受限网络）
```

`pull --push` 仅为受控 CI 兼容入口：它同样需要匹配的 ci-gate 证明，并且只推升级分支、创建 PR，
绝不会执行 `main:main`；目标仓不在干净的 main 分支时也会强制 dry-run。日常本地使用请选择 `--no-commit`。

### 新仓接入（一次性，约 2 分钟）

```bash
bash sync/adopt.sh /path/to/new-child            # 或 --path-prefix governance/（子目录形态）
# 然后按提示把新仓注册到基座 sync/child-repos.json；凭据只配置在基座仓
```

adopt.sh 会先校验 B端PC、B端移动、C端移动三个生产入口齐备，锁定 `sync/base-capabilities.json` 的最新稳定 UI，并立即运行共享界面消费门禁；只写依赖但仍使用本地复制壳会被拒绝。随后注入只读心跳 workflow，按 scope **逐文件真实拉齐**其他基座公共能力，写入可复核 SHA，再用同一基座快照逐文件复检为零差异。首次接入不自动提交，便于行业方把基座变化与自己的 Bundle 一起评审。
**继承只带基座能力和治理机制，不带任何行业演示内容**；禁止仅写 `lastSyncedBaseSha` 却没有实际对齐文件。
为保证 SHA 与文件内容一一对应，`adopt.sh` 会拒绝从含未提交变化的基座工作树接入新行业。

如果基座尚无稳定 UI 版本、新仓缺少任一生产客户端，或三端没有实际采用共享壳，接入会直接失败；候选版本不会自动进入新行业。新行业应从已通过当前稳定基座门禁的模板或行业仓创建，因此开仓即继承最新版基座能力。

### 存量行业仓首次迁移

稳定版本升级脚本不会把旧仓“只改依赖号”伪装成已完成迁移。尚未具备移动 B 端或尚未消费共享壳的仓库，升级会明确失败；必须先建立逐仓迁移 PR，补齐三端薄适配层并通过 `verify-ui-consumer.mjs`。首次迁移合并后，后续版本才能只通过稳定制品升级 PR 自动演进。

## 分阶段落地

**MVP（当前已落地）**：scope 边界声明 + 三模式引擎 + ci-gate 后升级 PR + 子仓只读心跳 + adopt.sh +
防污染硬校验 + 锚点合并 + 状态基线 + 无凭据强制 dry-run + 禁止直推 main。

**完整方案（按需演进）**：
1. **合并队列**：行业仓 CI 全绿后仍由代码所有者批准，必要时接 GitHub merge queue；
2. **IM 通知**：升级 PR 失败或等待人工处置时推送企业微信/飞书机器人；
3. **基座版本号**：从 SHA 基线升级为 semver 标签基线（release.yml 打 tag 时联动）。

## 运维手册

| 场景 | 操作 |
|---|---|
| 调整同步边界 | 改 `sync/base-scope.json`（基座 owner 评审）→ 下次心跳全仓生效 |
| 新增子仓 | `bash sync/adopt.sh` + 注册 `child-repos.json`；跨仓写 secret 仅配置在基座仓 |
| 某仓暂缓升级 | 保持升级 PR 未合并并记录原因；不删订阅、不直改基座副本 |
| 升级 PR 的行业仓 CI 红 | 在该 PR 分支解决兼容问题并重新评审，禁止绕过门禁直推 main |
| 紧急暂停 | 暂停基座仓 `base-sync-upgrade-pr` workflow；已创建 PR 保持可审计且不会自动合并 |
| 审计同步历史 | 基座 workflow run + 行业仓升级 PR + `.workloom-base-sync.json` 三方交叉核验 |
