# fix_b_fence · 修复报告（M5 · 围栏批次 MC-102 / MC-109 / MC-103）

> 任务号：T-2026-0929-0200　审计基线：`4ff9943`（origin/main）
> 修复工作树：`/Users/mac/WorkLoom-fleet/.wt-mcd-fb`（分支 `task/T-2026-0929-0200-fb`）
> 修复提交：`4e52948`　DB：`wl_mcd_fb`　服务端口：8941　档位：local-preview（真库 + 真服务 + 真鉴权）

## 1. 范围与假设

- 收到的工作卡正文缺失，按会话名 `fix_b_fence` + `outputs/mine-clear/T-2026-0929-0200/PLAN-fixes.md`
  推定范围为「第 1 批 地基 · 围栏」+「第 2 批 MC-103」＝ **MC-102、MC-109、MC-103**。
  第 1 批的 MC-101/MC-105（审批续跑 / RDAS O 域）与第 2 批 MC-104（审批手势线程归属）不在本会话范围，
  以避免与 `fix_a_core` 在 `packages/base/review-console/**` 上撞车。
- 未触碰 `packages/base/review-console/**`、`packages/runtime/**`、`scripts/suite.ts`（分别属其它卡）。

## 2. 根因与修法（A 级：代码精读 + 真机实测）

| 卡 | 根因（基线 `4ff9943`） | 修法（提交 `4e52948`） |
|---|---|---|
| MC-102 | `fenceRuleRowId()` 固定 `fr-<rule>-vnext-<ws>`（lifecycle.ts:165），同 rule_id 第二次提案必然撞主键；router `INSERT ... ON CONFLICT (id) DO NOTHING`（router.ts:2246）静默丢内容；`activateFenceRuleAfterApproval`（router.ts:1389）见状态非 pending 即幂等早退 → **审批 200 approved、规则永不生效** | 行 ID 版本化 `fr-<rule>-v<N>-<ws>`（lifecycle.ts:171）；新增 `nextRuleRowIdentity()` 事务内按历史最大版本 +1 分配行 ID/版本/锚点事实（lifecycle.ts:199）；router 的插入改为「冲突即重算版本重试，5 次仍冲突则显式 CONFLICT 报错」，不再静默（router.ts:2286-2302）；提案事件 `after` 携带 `ruleRowId/version/inheritedBaseline`（router.ts:2318-2330），激活按该行回写；旧事件（无行 ID）在 `activateFenceRuleAfterApproval` 内按 rule_id 反查待激活行（router.ts:1375-1392） |
| MC-109 | `activateRuleVersion` 把同 rule_id 的 **全部** active 行（含 `is_baseline=true` 的平台基线）转 `rolled_back`（lifecycle.ts:288），且守卫只认 `is_baseline` 行（dsl.ts:216）→ 首次自定义后锚点消失、放宽提案一路放行 | 激活只回滚旧租户覆盖行（`is_baseline=false`），平台基线保持 active（lifecycle.ts:370-373）；守卫锚点改为「同 rule_id 最严 active 行」（dsl.ts:215-231），覆盖行按基线身份参与单调比对 |
| MC-103 | 拒绝文案让客户用 `allowWhenChange`，但该参数在产品路径上不存在（dsl.ts:197 文案 vs router zod 入参无此键），客户无路可走 | `fence.confirmDryRun` 新增显式入参 `allowWhenChange`（router.ts:2237），按 dry-run 归属 + pending 校验后放行 when 改写（router.ts:2253-2285）；放行事实写入提案事件 `after.allowWhenChange` 并经 `fenceActivationFromProposal` 带到**激活期**（lifecycle.ts:223-250、354）；拒绝文案改为指名可达路径（dsl.ts:197） |

### 2.1 与修复规格（PLAN-fixes.md）的一处偏差及理由

规格 §2 写「若该 rule_id 存在 is_baseline=true 的平台行，**新行 is_baseline=true**」。本实现**不**把租户覆盖行标成基线行，而是
① 保留平台基线行 active（锚点不丢）；② 守卫锚点取最严 active 行；③ 提案事件留痕 `inheritedBaseline`。理由（均为代码事实）：

- `packages/base/night-shift/scheduler.ts:140` 的围栏版本快照按 `status='active' AND is_baseline=true ... LIMIT 1` 取值，同 rule_id 两条 active 基线行会让快照口径漂移；
- `apps/web/src/pages/p5/P5.tsx:74-75` 用 `is_baseline` 区分「集团基线 ×N / 客户自定义 ×N」，继承标记会让「客户已自定义」从计数里消失，与覆盖层模型（PRODUCT_CONTEXT §3.5「客户配置以覆盖层叠加，围栏只能收紧」）冲突；
- 两条 active 行同时带基线标记会使「每个 rule_id 同一时刻只有一条 active 基线」的既有假设失效。

## 3. 验证证据（A 级：真机实测；日志在 `work/fix-b/`）

| 断言 | 命令（工作目录 `work/fix-b`） | 结果 | 证据 |
|---|---|---|---|
| 基线红灯（修复前） | `MCD_BASE=http://127.0.0.1:8941 node …/assertions/m1-fence-rule-change.mjs` | exit 1：attempt2 未生效、attempt3 放宽未被拒 | `red-1-fence.log` |
| MC-102/109 绿灯（修复后） | 同上（先 `psql -f reset-r7.sql`） | exit 0：attempt1 v2/review、attempt2 v3/block（v2 rolled_back）、attempt3 400 | `green-1-fence.log` |
| MC-102/109 绿灯 + DB 直查 | 同上，跑完立刻 `SELECT id,version,level,is_baseline,status FROM fence_rules WHERE rule_id='R7'` | exit 0；DB：`fr-r7-v1`（hotel-baseline/v1，auto，is_baseline=t，**active**）/ `fr-r7-v2`（review，rolled_back）/ `fr-r7-v3`（block，**active**） | `green-4-fence-with-dbstate.log` |
| MC-103 无放行位必须拒 | `MCD_WHEN=true … m1-fence-rule-change.mjs` | 400 且文案含 `allowWhenChange=true`（参数可达） | `green-2-when-blocked.log` |
| MC-103 显式放行端到端 | `MCD_WHEN=true MCD_ALLOW_WHEN=1 …` | exit 0：两次 when 改写审批通过且真正生效 | `green-3-when-allowed.log` |
| MC-103 专项探针（含 dry-run 不被拒消耗） | `node when-retry-probe.mjs` | 8/8 OK：400 → 同 dryRunId + allowWhenChange → 200 → 审批 → 覆盖行 active + 基线行 active | `when-retry-probe.log` |
| 单元/集成 | `RUN_DB_TESTS=1 vitest run packages/base/fence-engine` | 57/57 通过（含新增 MC-102/109 真库用例、MC-109 锚点纯函数用例、MC-103 放行/拒绝用例） | `vitest-fence-2.log` |
| 包级回归 | `RUN_DB_TESTS=1 vitest run`（`packages/base`） | 52 文件 / 815 通过 / 8 跳过 | 命令输出 |
| 运行时回归 | `RUN_DB_TESTS=1 vitest run`（`packages/runtime`） | 15/15 通过（首跑 1 失败＝本人断言把 R7 收紧成 block 的**数据**副作用，`reset-r7.sql` 复位后全绿，见 §5） | 命令输出 |
| 服务端回归 | `RUN_DB_TESTS=1 vitest run`（`apps/server`） | 26 文件通过；`service/contract.test.ts`、`service/e2e.test.ts` 因缺 `SERVICE_C_TEST_WORKSPACE_ID` 夹具在 import 期失败——**与本次改动无关**：在未修改的 `.wt-mcd-c` 上以同一命令复现同样 2 个失败 | 命令输出 |
| 全场景套件 | `TOOL_UNVERIFIED_RATE=0 tsx --env-file=.env scripts/suite.ts` | **463/463 通过**（服务层 418 + HTTP E2E 45） | `suite-2.log` |
| 类型检查 | `pnpm typecheck` | 全仓通过 | 命令输出 |
| 交付脚本自检 | `node --test scripts/delivery/mine-clear.test.mjs` | 15/15 通过 | 命令输出 |
| 台账门禁 | `node scripts/delivery/mine-clear.mjs gate --ledger …/ledger.json` | **未过（2 项）**：MC-205 `state=covered` 缺 `covered_by`；MC-108（P0）未闭环——两张卡均不在本会话范围 | 命令输出 |
| 秘密扫描 | `pnpm secrets:scan:staged` | PASS（5 个目标） | 命令输出 |

> 首次 `suite` 运行失败（HTTP E2E `server 启动超时`）的原因：`.wt-mcd-fb` 缺 `.env`，套件的
> `pnpm -C apps/server start` 依赖 `--env-file=../../.env`。补齐 `.env`（= `work/env-fb` 副本，gitignored）后 463/463 通过。

## 4. 复跑入口

```bash
# 0) 服务（当前已常驻；需要自起时先停旧进程：pkill -f "env-fb apps/server/src/index.ts"）
bash /Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/fix-b/serve-8941.sh &

# 1) 复位 R7 到出厂基线态（反复复跑断言用）
PGPASSWORD=workloom /Users/mac/.local/pg17/bin/psql -h 127.0.0.1 -p 5432 -U postgres -d wl_mcd_fb \
  -f /Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/fix-b/reset-r7.sql

# 2) 主断言（应 exit 0）
cd /Users/mac/WorkLoom-fleet/.wt-mcd-im/outputs/mine-clear/T-2026-0929-0200/assertions
MCD_BASE=http://127.0.0.1:8941 node m1-fence-rule-change.mjs
# 3) when 改写两态
MCD_BASE=http://127.0.0.1:8941 MCD_WHEN=true node m1-fence-rule-change.mjs
MCD_BASE=http://127.0.0.1:8941 MCD_WHEN=true MCD_ALLOW_WHEN=1 node m1-fence-rule-change.mjs
```

## 5. 环境与遗留状态（交接用）

- `wl_mcd_fb`：R7 已复位为出厂基线态（1 行 active / is_baseline=true / level=auto）；ws-yunqi 无 pending fence 行。
  断言与套件会在 `biz_events` 追加提案/手势事件（append-only，链完整）。
- 端口 8941 由 fix_b 的 supervisor 常驻（代码 = `4e52948`）。停掉它：`pkill -f "env-fb apps/server/src/index.ts"`（只匹配本会话实例）。
- `.wt-mcd-fb/.env` 已按 `work/env-fb` 写入（gitignored，套件 HTTP E2E 依赖它）。
- 断言脚本 `m1-fence-rule-change.mjs` 已扩展 `MCD_ALLOW_WHEN`（默认行为不变，向后兼容其他卡的使用）。

## 6. 未覆盖 / 残留风险

1. **激活期拒绝后的残留态**：若某提案审批通过后激活期守卫才拒绝（并发加严等），审批已是 `approved`、规则行停在
   `pending_approval`，客户端收到 500 与可复现原因。未引入新状态值（`fence_rules.status` 有 CHECK 约束，
   新增 `rejected` 需要迁移 + UI 文案，超出本批范围）。此路径在正常串行提案下不会触发（本批已实测全绿）。
2. **UI 未做真机走查**：本次未改前端；`fence.rules` 列表在改动前就可能同 rule_id 返回多行（全局 `*` 基线 + 工作区行），
   P5 与 roster 航道许可均已按「最严级别」取数（router.ts:2484-2499）。
3. `MCD_WHEN` 放行位是「显式确认 + 审批手势」双闸，但没有对 when 文本做语义等价校验（沿用既有契约）。

## 7. 台账更新建议（由台账所有者落盘，避免并发写冲突）

```json
[
  {"id": "MC-102", "state": "fixed", "fixed_by": "fix_b_fence", "fixed_commit": "4e52948",
   "regression": {"command": "MCD_BASE=http://127.0.0.1:8941 node outputs/mine-clear/T-2026-0929-0200/assertions/m1-fence-rule-change.mjs",
                  "evidence": "work/fix-b/green-1-fence.log"}},
  {"id": "MC-109", "state": "fixed", "fixed_by": "fix_b_fence", "fixed_commit": "4e52948",
   "regression": {"command": "同上（第 3 次放宽提案必须 400；DB 回读基线行仍 active）",
                  "evidence": "work/fix-b/green-1-fence.log"}},
  {"id": "MC-103", "state": "fixed", "fixed_by": "fix_b_fence", "fixed_commit": "4e52948",
   "regression": {"command": "MCD_WHEN=true MCD_ALLOW_WHEN=1 node … m1-fence-rule-change.mjs；不带 MCD_ALLOW_WHEN 时必须 400 且文案含 allowWhenChange=true",
                  "evidence": "work/fix-b/green-2-when-blocked.log / green-3-when-allowed.log / when-retry-probe.log"}}
]
```
