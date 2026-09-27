# 舰队自动更新机制（本地 + 云端）

> 适用：基座 `workloom-im` 与 `sync/child-repos.json#children` 里的全部子仓（含实验车道 fox / growth）。
> **不适用**：`sync/child-repos.json#isolatedRepos` 登记的隔离副本（`workloom-growthtest` / `workloom-growthmatrix`）——
> 它们双向不同步（基座不下发、本仓不回流），扫描 / 纳管 / fanout 一律跳过，规则见 `docs/DEVELOPMENT-PROTOCOL.md` §11。
> 事实源：`sync/child-repos.json`（订阅关系）、`sync/base-scope.json`（同步边界）、本文件（机制说明）。
> 落点：2026-09-19 起，云端“基座 → 子仓”的资产分发不再依赖人工开 PR；治理资产仍需显式审查合并。本地舰队镜像每日尝试跟随。

## 0. 一页速览

| 层 | 做什么 | 载体 | 触发 | 人工介入 |
|---|---|---|---|---|
| 云端 · 资产分发 | 基座根级资产 → 每个子仓一条 `sync/base-*` PR；仅非执行性资产且门禁全绿时自动合并，治理资产走显式审查 | `sync/fanout-cnb.mjs` + `sync/merge-sync-prs.mjs`（`.cnb.yml#base-sync-fanout`） | 每 30 分钟 cron；`api_trigger_base_sync`；本地兜底脚本 | 治理路径需显式审查 |
| 云端 · 新仓纳管 | 扫描组织发现新 WorkLoom 仓 → 开扫描任务卡 + 纳管 PR（标签/分支保护/协议资产/门禁 stage）；隔离副本只单列报告、不纳管 | `scripts/tools/fleet-scan.mjs --issue --provision` | 每日 09:00（Asia/Shanghai）cron | 审合并 PR |
| 云端 · 代码基线 | `packages/**`、`apps/**` 等运行时代码升级 | `sync/base-sync.mjs push` / fanout `--mode full` | AI/API 触发（默认不跑；升级批次由任务卡驱动） | AI 合并（门禁全绿 + 冷却期，协议 §1/§9.5） |
| 本地 · 文档副本 | 全景认知 + 开发协议落到 `~/.codex/workloom-context/`，供 WorkLoom 会话直接引用 | `~/.codex/skills/workloom-context/scripts/sync-context.sh` | Codex automation `workloom`（每日 09:00）+ 手动 | 无需 |
| 本地 · 代码克隆 | `~/WorkLoom-fleet/` 十个订阅仓 + 两个隔离副本都跟随各自云端 `main`；新订阅仓自动克隆 | `~/.codex/skills/workloom-context/scripts/sync-fleet-local.sh` | 同上 | 无需（脏树自动跳过） |
| 本地 · 云端兜底 | 用本机令牌触发云端 fanout 流水线（跨仓开关未开时的替代通道） | `~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh` | 手动 / automation | 无需 |

## 1. 云端资产分发（fanout）

### 1.1 它解决什么

基座改动后，九个子仓（八个行业仓 + 实验车道 growth）必须拿到**同一份**全景认知、开发协议与 AGENTS 受控区块，同时不得覆盖行业语义。
人工逐仓开 PR 的时代（2026-09-19 之前：一轮 9 个 PR，全靠会话手工创建）已经结束；含治理资产的 PR 仍需逐仓显式审查：

```bash
# 基座仓内（CI 或本地干净克隆）
node sync/fanout-cnb.mjs --mode required-only            # 只处理根级受控资产
node sync/merge-sync-prs.mjs                             # 条件自动合并：非执行性同步 + 普通代码车道（治理路径跳过）
```

### 1.2 幂等与“不打扰”规则

1. **先比对，再克隆**：脚本用 CNB API 读子仓 `main` 上的 `.workloom-base-sync.json`，把它记录的
   `requiredRootAssetsSha256` 与基座当前资产摘要逐项比对；只有真漂移的子仓才会被 `git clone`。
   → 舰队巡检可以在流水线里每 30 分钟跑一次，绝大多数轮次只花几次 API 调用。
2. **资产摘要为准，不以基座 sha 为准**：基座只改代码、没动根级资产时，`required-only` 模式不产生任何 PR
   （避免“每天 9 条空 PR”噪声）。`--mode full` 才比较 `lastSyncedBaseSha`。
3. **在途去重**：子仓已存在 `sync/base-*` 的 open PR 时跳过，不重复开门。
4. **分支名 = 内容指纹**：`sync/base-<基座sha8>[-full]`；同名分支已存在（例如 PR 被关掉后）时不强推、不覆盖，
   只报告，避免任何形式的强制推送。
5. **隔离副本不参与**：`isolatedRepos` 里的仓即使被误写进 `children`，也会在 fanout 入口被过滤（报告 `skippedIsolated`），
   不 clone、不推送、不开 PR。

### 1.3 自动合并的边界（协议 §9.4）

`sync/merge-sync-prs.mjs` 的免审同步车道只合并同时满足以下条件的 PR：

1. 源分支是 `sync/base-*`（存量 `docs/context-*` 需显式传 `--legacy-doc-sync`，仅用于收口）；
2. **改动文件全部**落在非执行性资产白名单：`WORKLOOM_PRODUCT_CONTEXT.md`、
   `AI-AUTONOMOUS-OPERATIONS.md`、`.workloom-base-sync.json`；
3. 该 PR 非 WIP、无 `risk/review` / `risk/block` 标签，**全部**状态检查都是 `success`，
   且平台明确返回 `mergeable_state=mergeable`。缺失标签清单或合并状态也拒绝；
4. 入队后、实际合并前，源分支 HEAD、目标 `main`、改动路径、门禁与风险状态仍一致。

`AGENTS.md`、开发协议、`sync/**`、验收规范与执行器、工作流是治理资产。
同步 PR 触及其中任何一个路径，就算门禁全绿也只保留为待显式审查的 PR；
回落代码车道不会豁免治理路径。基座一次变更若同时改普通资产和治理资产，
子仓整条 PR 等审查，不能用 fanout 的 `pr-opened` 或 `.workloom-base-sync.json`
更新来宣称分发完成。

改动文件清单取自 `GET /{repo}/-/git/compare/main...<head>`（**完整路径**）。
注意 `GET /pulls/{n}/files` 的 `filename` 会丢目录（实测把 `docs/DEVELOPMENT-PROTOCOL.md` 报成
`DEVELOPMENT-PROTOCOL.md`），不能用于白名单判定。

任何动到 `packages/**`、`apps/**`、`bundles/**` 的 PR —— 也就是**运行时代码与行业语义** —— 不进
"纯同步"免审通道，但按协议 §1 / §9.5 走**代码车道**：全部门禁 success、平台可合并、非 WIP、
无 `risk/review` / `risk/block` 标签、分支最近提交已过 10 分钟冷却期，且不落在治理/高风险路径
（`.cnb.yml`、迁移、`platform-ops/**`、`bundles/platform/**` 等）时，由 `merge-sync-prs.mjs`
串行合并（同仓每轮最多一条）。非纯同步的 `sync/base-*-full` 波次按同一规则处理；
非执行性资产（本文件 §1.3 白名单）在波次里放行；混有治理资产的 full 波次留待显式审查。

### 1.4 权限模型（谁给谁开权限）

| 通道 | 令牌 | 能力 | 备注 |
|---|---|---|---|
| 定时任务（每 30 分钟） | 触发者（最后改 crontab 的人）的 `CNB_TOKEN` | **默认仅当前仓** | 需要根组织管理员在「组织设置 → 仓库管控」勾选**允许定时任务跨仓操作**，令牌才升级为“根组织范围” |
| API 触发 `api_trigger_base_sync` | 调用者令牌（例如个人访问令牌） | 调用者本身的权限 | 本地兜底脚本 `fleet-cloud-sync.sh` 走这条；不依赖组织开关 |
| 子仓 PR 门禁 | 子仓自己的 `CNB_TOKEN` | 当前仓 | 子仓流水线不申请任何跨仓权限 |

未开组织开关时，cron 会以 `🔒 权限不足` 告警收尾并**保持绿**（`--tolerate-scope-error`），
不会每半小时刷一次红灯；此时云端自动更新改由「API 触发」或本地兜底脚本承担。

### 1.5 失败模式与处置

| 现象 | 根因 | 处置 |
|---|---|---|
| `🔒 权限不足` | 定时任务跨仓开关未开 | 开组织开关；或改用 API 触发 / 本地兜底 |
| `CNB 429 Too many requests` | 舰队级巡检触发限流 | 已在 `scripts/tools/cnb-api.mjs` 内置指数退避重试（尊重 `Retry-After`），无需人工 |
| 子仓 PR 门禁红 | 代码漂移、行业化改动冲突 | fanout 与合并器都会跳过；修复至门禁全绿后重新判定车道，治理路径仍需显式审查 |
| 子仓 PR 门禁绿但停在队列 | PR 含 `sync/**`、`AGENTS.md`、协议、验收执行器或工作流等治理资产 | 审核路径与固定源 SHA，按协议 §3 放行后由会话内 AI 合并；逐仓核验合并 SHA |
| `verify-lock-conflict` 拒绝 | 同仓另有 open PR 改了同一路径（例如 `.workloom-base-sync.json`） | 先合并/关闭在途 PR；fanout 下次巡检会重开一条干净 PR |
| 子仓 state 显示“已漂移”但无内容变更 | 基座 sha 变了、资产没变 | `required-only` 不产生 PR，属预期 |

## 2. 云端新仓纳管

`scripts/tools/fleet-scan.mjs` 每天 09:00（Asia/Shanghai）扫描 `workloom-ai` 组织：

- 仓库根存在 `product.manifest.json#schemaVersion = workloom.product/*` → 判为 WorkLoom 仓；
  否则退化看 `.workloom-base-sync.json` / `bundles/*/bundle.json`；
- 已纳管集合 = 基座 + `sync/child-repos.json#children`；差集里的新仓会被
  `--issue`（开 `src/auto` 扫描任务卡）与 `--provision`（建立标签/分支保护/协议资产/门禁 stage 并开纳管 PR）覆盖；
- 实验车道新仓要按协议 §10.1 在清单里补 `lane/experimentNote/experimentPaths/industryExtensionPaths`，
  否则 `experiment-guard.mjs --check` 会在基座门禁里报警；
- 有意与基座拆分的**隔离副本**按协议 §11 写入顶层 `isolatedRepos`（`syncPolicy: none-in-none-out` + `note` + `isolatedSince`）：
  `fleet-scan` 把它计入"已知"并单列报告，`--issue` / `--provision` 一律跳过；`provision-protocol.mjs` 默认拒绝为它建纳管 PR；
  隔离仓若混进 `children`，`experiment-guard --check` 报 `ISOLATED_IN_CHILDREN` 并在基座门禁判红。

纳管 PR 合并后，新仓在下一次 fanout 巡检（≤30 分钟）自动进入资产分发，并在本地 `sync-fleet-local.sh`
下一次运行时自动克隆到 `~/WorkLoom-fleet/`。

## 3. 本地副本

```bash
# 文档副本（全景认知 + 开发协议）→ ~/.codex/workloom-context/
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh          # 同步
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh --check  # 只判断是否过期（退出码 3=过期）

# 十个订阅仓 + 两个隔离副本 → ~/WorkLoom-fleet/（新仓自动 clone；脏树跳过，不覆盖任何本地改动）
sh ~/.codex/skills/workloom-context/scripts/sync-fleet-local.sh [--quiet]

# 云端兜底：用本机令牌触发 fanout 流水线（等云端跑完再返回）
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh [--mode required-only|full] [--dry-run]
```

Codex automation `workloom`（每日 09:00）按顺序跑前两条，**无变化不通知**。

## 4. 人的角色：裁决与叫停（不再逐 PR 点合并）

- 合并执行：AI / 流水线（门禁全绿 + 串行，一次一个）；人保留随时叫停、要求回滚的权利；
- 高风险裁决：真实资金 / 实盘、生产秘密与生产配置、协议文本语义变更（协议 §3）——PR 必须显著标注并提供回滚路径；
- `risk/review` 放行：由人移除标签或在 Issue / 会话里给出明确指令，放行后仍由 AI 执行合并；
- `risk/block` 与治理路径（`.cnb.yml`、迁移、`platform-ops/**`、`bundles/platform/**`）不经无人值守通道。

## 5. 验证与排障命令

```bash
node --test sync/fanout-rules.test.mjs sync/merge-sync-prs.test.mjs # 白名单/合并前复核/漂移判定单测
node sync/fanout-cnb.mjs --dry-run --json                     # 只报告：谁漂移、谁在途、谁对齐
node sync/fanout-cnb.mjs --only workloom-ai/workroom-tiger    # 只处理单仓
node sync/merge-sync-prs.mjs --dry-run --json                 # 只报告：两条车道各自会合谁、为什么不合
node sync/merge-sync-prs.mjs --no-code                        # 只跑纯同步车道（排障/回滚用）
```

CI 内可手动触发同一流水线（`BASE_SYNC_DRY_RUN=1` 只报告不落地）：

```bash
curl -X POST -H "Authorization: Bearer $CNB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"branch":"main","event":"api_trigger_base_sync","env":{"BASE_SYNC_DRY_RUN":"1"}}' \
  https://api.cnb.cool/workloom-ai/workloom-im/-/build/start
```

## 6. 回滚

- 关掉自动合并：删除 `.cnb.yml` 中 `crontab: */30 * * * *` 条目（或把 `BASE_SYNC_MODE` 改为 `off` 并停用该 job），
  纯同步 PR 会继续产生但不再自动合并；
- 关掉 fanout：删除 `api_trigger_base_sync` 与 30 分钟 cron 两条；
- 单仓豁免（仍属订阅、只是少同步某些文件）：在 `sync/child-repos.json` 该仓条目里加 `extraExclude`，或临时关闭该仓在途 PR（fanout 见在途 PR 即跳过）；
- 单仓隔离（完全不收不发，如 growthtest / growthmatrix）：把该仓从 `children` 移到顶层 `isolatedRepos`（协议 §11），fanout / 扫描 / 纳管会同时跳过；
- 全部回滚：`git revert` 引入 fanout 的提交；已合并的文档同步可用子仓 `git revert` 回退（纯文本，无副作用）。
