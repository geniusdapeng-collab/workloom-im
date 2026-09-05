# WorkLoom IM · 基座能力双向同步机制（base-sync）

> 一套固化在云端仓库代码中的双向同步机制：WorkLoom IM 的**基座能力**更新后自动推送到全部子仓；
> 子仓通过心跳主动检测并拉齐。同步范围由 `sync/base-scope.json` 机器可读声明唯一界定——
> **行业属性与演示能力（bundles/、种子数据、行业页面与文案等）永不进入任何同步流程**。

## 为什么旧机制会失效（失效根因分析）

| # | 失效模式 | 实证（2026-09 八仓审计） |
|---|---|---|
| 1 | **零自动化**——同步靠人脑记忆 + 手工复制 | 仓内 workflows 只有构建/CI/release，同步类提交全部手工完成 |
| 2 | **范围无机器可读声明**——"哪些是基座能力"靠人肉判断 | 漏同步：V4 定制向导接线不完整被一致推广到 8 仓；误覆盖：`trpc/router.ts` 行业段被覆盖后回滚重打（有提交为证）；`package.json` exports 覆盖致行业模块 `ERR_PACKAGE_PATH_NOT_EXPORTED` 服务瘫痪 |
| 3 | **无对齐状态记录**——漂移无人发现 | 审计时单仓与基座漂移达 78 个文件，无告警无感知 |
| 4 | **行业演示与基座混居**——无边界护栏 | bundles/ 行业包、seed 行业数据、行业文案与基座能力同树共存，同步时全凭自觉 |

本机制针对四条根因逐一设防：**自动化 CI 触发**（治 1）、**scope 声明式边界**（治 2）、**state 基线 + 心跳检测**（治 3）、**exclude + 推送前黑名单硬校验双保险**（治 4）。

## 架构：双向闭环

```
                 WorkLoom IM（父仓 · 唯一事实源）
                 ├─ sync/base-scope.json      ← 同步范围声明（include/exclude/锚点合并/防污染护栏）
                 ├─ sync/child-repos.json     ← 子仓订阅清单
                 ├─ sync/base-sync.mjs        ← 同步引擎（detect/pull/push 三模式，Node 原生零依赖）
                 └─ .github/workflows/base-sync-push.yml
                            │  父→子推送：main 上基座路径变更 → 逐子仓对齐+推送
                            ▼
        ┌───────────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼  （7+ 子仓，订阅制扩容）
   workroom-fox  workloom-hotel  hyperreality …
        └─ .github/workflows/base-sync-heartbeat.yml
           子→父心跳：每日 cron + 手动 + push 自检
           落后 → 有 SYNC_TOKEN 自动拉齐推送 / 无则 CI 标红提醒
        └─ .workloom-base-sync.json（对齐基线：lastSyncedBaseSha）
```

**防副本漂移设计**：子仓 workflow 只是触发器——引擎与 scope 每次从基座 main 的 raw URL 实时拉取，
边界规则演进只需改基座一处，全部子仓下次心跳自动生效。

## 同步范围边界（base-scope.json 速览）

- **include（基座能力）**：`packages/{base,runtime,shared,db}`、`apps/server/src`（核心服务）、`apps/desktop`、`apps/web/src/lib`、`scripts`（基座脚本）、共享 CI、`AGENTS.md` 等
- **exclude（行业属性/演示能力，永不同步）**：
  - 行业演示：`bundles/**`、`scripts/seed*`、`demo/**`、`docs/demo`、`mock/**`
  - 行业壳层：`apps/web/src/{App.tsx,shell,pages,components,styles,audio,voice}`、`apps/webc/**`、`apps/site/**`
  - 行业服务接线：`trpc/router.ts`、`service/{dialog,kb,store,gateway,ticket,adapters}`、`devtools.ts`
  - 行业 KPI 语义：`captain/{charter,decision,loop,board}`、`tenancy/auth.ts`
  - 数据库纪律：`packages/db/migrations/**` 走 append-only 特判（只新增、已有文件漂移即跳过告警——sha256 账本纪律）
  - 技能体系：`skills/**` 由仓内既有 skill-ops 保鲜环负责分发，base-sync 不碰
- **anchorMerge（锚点合并，非覆盖）**：`packages/*/package.json`、`tsconfig.json` 等——基座版为底，**子仓独有 exports/deps/include 条目一律保留**（血泪教训：整体覆盖曾致行业模块瘫痪）
- **pollutionGuard（推送前硬校验）**：待同步清单命中 `bundles/`、`seed`、`hotel-baseline`、`ai-pm`、`yunqi`、`ecommerce` 等黑名单关键词，或单次超 200 文件 → 立即中止。**宁可漏报，不可污染。**

## 使用方式

### 父仓：基座能力更新后（自动）

正常开发推 main 即可——`base-sync-push.yml` 仅在基座路径（paths 过滤）变更时触发，
自动对订阅清单逐仓对齐并推送。行业演示能力（bundles/seed/页面）的变更不会触发本 workflow。

### 子仓：日常开发（自动/半自动）

- **全自动**（已配 `SYNC_TOKEN` secret）：每日心跳检测到落后即自动拉齐+推送，无感；
- **半自动**（未配 secret）：心跳 CI 标红 + Summary 列出待对齐清单，人工执行：
  ```bash
  # 子仓本地（需 GH_TOKEN 环境变量，repo 权限 PAT）
  node <基座仓>/sync/base-sync.mjs pull --repo . --push
  ```

### 手动操作（任何环境）

```bash
node sync/base-sync.mjs detect --repo /path/to/child          # 检测：落后则退出码 2 + 差异清单
node sync/base-sync.mjs pull   --repo /path/to/child --push   # 拉齐并推送
node sync/base-sync.mjs push   --base /path/to/workloom-im    # 父仓视角：推送到全部子仓
# 通用：--dry-run 只看不改 · --json 机器可读 · --base-url 镜像前缀（受限网络）
```

### 新仓接入（一次性，约 2 分钟）

```bash
bash sync/adopt.sh /path/to/new-child            # 或 --path-prefix governance/（子目录形态）
# 然后按提示：① 把新仓注册到 sync/child-repos.json；② 配置 SYNC_TOKEN secret
```

adopt.sh 只做三件幂等的事：注入心跳 workflow（cron 按仓名错峰）、初始化基线状态、打印后续两步指引。
**继承只带机制，不带任何行业演示内容**——新仓首次对齐时按 scope 拉取的也仅是基座能力。

## 分阶段落地

**MVP（当前已落地）**：scope 边界声明 + 三模式引擎 + 父→子推送 CI + 子仓心跳 CI + adopt.sh +
防污染硬校验 + 锚点合并 + 迁移 append-only + 状态基线。

**完整方案（按需演进）**：
1. **PR 模式**（`SYNC_MODE=pr`）：同步改动开 PR 而非直推，借子仓既有 ci-gate 自动验证后合并——更稳，适合协作者增多后；
2. **同步后验证门**：push 模式在子仓侧先跑 `pnpm -C apps/server test` 再推（当前依赖子仓 CI 事后兜底）；
3. **IM 通知**：对齐结果推送企业微信/飞书机器人；
4. **基座版本号**：从 SHA 基线升级为 semver 标签基线（release.yml 打 tag 时联动）。

## 运维手册

| 场景 | 操作 |
|---|---|
| 调整同步边界 | 改 `sync/base-scope.json`（基座 owner 评审）→ 下次心跳全仓生效 |
| 新增子仓 | `bash sync/adopt.sh` + 注册 child-repos.json + 配 secret |
| 某仓不想自动推 | 该仓不配 `SYNC_TOKEN`（保持半自动提醒） |
| 同步后子仓 CI 红 | 看红的原因：多为子仓行业层与新版基座接口不兼容——在子仓修行业层（机制保证基座文件与父仓逐字节一致） |
| 紧急暂停 | 父仓 workflow 临时 `on: workflow_dispatch`（注释 push 触发） |
| 审计同步历史 | 子仓 `git log --grep="base-sync"`；状态见 `.workloom-base-sync.json` |
