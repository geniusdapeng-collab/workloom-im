# T-2026-0929-0200 · M5 修复规格（给修复会话的任务卡）

> 审计基线：`4ff9943`（origin/main）。每张卡动手前：`git fetch` → 确认问题仍存在 → 再改；提交信息带 `[T-2026-0929-0200]`。
> 纪律：先跑红（断言脚本当前必须失败）→ 改代码 → 断言转绿 → 回归 `pnpm typecheck` + 相关单测。**修复者不读验收结论，验收由另一会话执行。**

## 第 0 批 · 止血

### MC-108（P0）高危岗位守卫空转
- 文件：`packages/runtime/src/loop.ts`（三处 actor + 审批快照），必要时 `packages/runtime/src/assembly.ts` 不加改动。
- 修法：
  1. 三处 `actor: { id: preset.presetKey, type: "agent", fenceBindings: preset.fenceBindings }`（约 422/461/567 行）补 `highRisk: preset.highRisk === true`。
  2. 审批快照（约 534 行区域）补 `high_risk: preset.highRisk === true`。
  3. 高危岗位的**写**步骤一律不得 auto：`const effectiveLevel = input.mode === "agent" ? "review" : (preset.highRisk && toolAccess === "write" ? maxLevel(verdict.level, "review") : verdict.level)`（保持 block 仍熔断）。
  4. 相应单测：`packages/runtime/src/runtime.test.ts` 增用例——`highRisk=true` 的 preset + 命中 auto 的写步骤 → 期望 `pending_review` 且快照 `high_risk=true`。
- 验收断言（当前红 → 修后绿）：`MCD_BASE=... node outputs/mine-clear/T-2026-0929-0200/assertions/m1-highrisk-batch.mjs`

### MC-106（P2，与 MC-108 同批，避免修好 P0 后立即出现可利用面）
- 文件：`packages/base/workdata/gateway.ts#checkHighRiskAuthorization`。
- 修法：
  1. 快照缺少 `object_type`/`object_id`/`action` 任一绑定 → **拒绝**（fail-closed），不再"视为通用授权放行"。
  2. 一次性消费：在同一事务内 `SELECT ... FOR UPDATE` 后，用 `UPDATE approvals SET snapshot = jsonb_set(snapshot,'{used_at}', to_jsonb(now())) ... WHERE approval_id=$1 AND snapshot->>'used_at' IS NULL RETURNING approval_id`；无返回行 → 拒绝（已被消费）。
  3. 保留对 status/expiry/绑定比对的既有校验。
- 验收断言：`node_modules/.bin/tsx --env-file=.env outputs/mine-clear/T-2026-0929-0200/assertions/m1-approval-reuse.mts`（场景 A 两次都拒；场景 B 第一次放行、第二次拒）

## 第 1 批 · 地基

### MC-101（P1）审批通过后自动续跑
- 文件：`packages/base/review-console/approvals.ts#decide`（同事务）+ 复用 `apps/server/src/runtime/scheduler.ts`（不改逻辑）。
- 修法：把"被审事件的 `session_id`/`step_id`"查询提前到 decide 事务内；当 `gesture ∈ {approve, edit}` 且事件属于某线程的步骤级关卡时，同事务 `UPDATE threads SET status='queued', error=NULL, updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='pending_review'`；把 `thread_id` 写进手势事件 `after`（与 reject 分支口径一致）。
- 断言：`node outputs/mine-clear/T-2026-0929-0200/assertions/m1-approval-resume.mjs`（线程 60s 内离开 pending_review；且线程时间线出现 `approval.gesture`，后者依赖 MC-104）

### MC-102 + MC-109（P1）围栏规则可重复加严 + 基线锚点不丢
- 文件：`packages/base/fence-engine/lifecycle.ts`（`fenceRuleRowId`、`activateRuleVersion`）、`apps/server/src/trpc/router.ts`（`fence.confirmDryRun`）。
- 修法：
  1. `fenceRuleRowId(ruleId, workspaceId, version)` → `fr-<rule>-v<version>-<ws>`（version 取该 rule_id 现有行 +1，事务内计算），消除同 rule_id 第二次提案的主键冲突。
  2. 新版本行继承平台基线锚点：若该 rule_id 存在 `is_baseline=true` 的平台行，新行 `is_baseline=true`；激活时**只回滚同来源的旧租户行**（`is_baseline=false`），平台基线行保持 active。
  3. 守卫读取（`checkCandidateAgainstBaseline`）改为：对同一 rule_id，取"当前 active 中最严的一条"为比较基准，而不只是 `is_baseline` 行——保证首次自定义后仍能判定"只可加严"。
  4. 评估期不变：judge 取最严（block > review > auto），平台基线与租户行并存时以更严者生效。
- 断言：`node outputs/mine-clear/T-2026-0929-0200/assertions/m1-fence-rule-change.mjs`（两次加严都生效且版本递增；放宽提案必须 400）

### MC-105（P1）RDAS O 域改用存在的过程
- 文件：`scripts/acceptance/outcome.mjs`。
- 修法：把 `approvals.batchRelease` 换成既有 `approvals.list`（status=pending）+ 过滤本线程事件 + 过滤高危（`snapshot.high_risk===true || tier==='l4_chairman' || snapshot.irreversible===true`）后调用 `approvals.batchApprove`；`interventions` 记录实际放行 id 与跳过原因。若产品决定在基座实现 `batchRelease`，则需同时补围栏/审批/事件留痕与配额（工作量大，默认走前者）。
- 断言（新增，需在修复会话中先写）：`node outputs/mine-clear/T-2026-0929-0200/assertions/m1-outcome-trpc-surface.mjs`（遍历 acceptance 脚本里出现的每个 `/trpc/<path>`，逐个探测；404 "No procedure found" 即红）

## 第 2 批 · 正确性

### MC-104（P2）审批手势事件归属线程
- 文件：`packages/base/review-console/approvals.ts`（decide 与 expireSweep 两处 `gatewayAppendOnClient` 调用）。
- 修法：传入 `sessionId: <被审事件的 session_id>`（decide 已在 MC-101 中提前查到；expireSweep 需按 `approval.event_id` 反查）。
- 断言：`m1-approval-resume.mjs` 打印的线程时间线包含 `approval.gesture`；DB 直查 `approval.gesture` 的 `session_id` 非 NULL。

### MC-103（P2）基线 when 变更路径
- 文件：`apps/server/src/trpc/router.ts#fence.confirmDryRun`、（可选）`packages/base/fence-engine/dsl.ts` 文案。
- 修法（二选一并说明理由）：
  - A：`confirmDryRun` 入参增 `allowWhenChange: z.boolean().optional()`，校验 `dryRunId` 属于同一 rule/版本且已 `confirmed` 后，传 `{ allowWhenChange: true }` 给守卫，并在提案事件里留痕 `allowWhenChange: true`；
  - B：不支持时，把错误文案改为"当前版本不支持改写基线条件（when）；如需变更请新增 rule_id 或仅收紧 level/范围"，与 UI/文档一致。
- 断言：`MCD_WHEN=true node outputs/mine-clear/T-2026-0929-0200/assertions/m1-fence-rule-change.mjs`（A 方案：带 `MCD_ALLOW_WHEN=1` 时可 confirm；不带时 400。B 方案：400 文案命中"不支持改写基线条件"）

## 第 3 批 · 体验

### MC-107（P2）套件端口可覆盖 + 预检
- 文件：`scripts/suite.ts`。
- 修法：`const STUB_PORT = Number(process.env.SUITE_STUB_PORT ?? "8791")`，并在 listen 前做与 `assertSuitePortAvailable` 同型的占用预检（失败信息带端口与覆盖变量名）。
- 断言：`SUITE_SERVER_PORT=8911 SUITE_STUB_PORT=8913 node_modules/.bin/tsx --env-file=<env> scripts/suite.ts`（8791 被占用时仍可整轮跑完）

## 通用回归（每批结束）
```bash
pnpm typecheck
node --test scripts/delivery/mine-clear.test.mjs
pnpm -C packages/runtime test         # runtime 单测（MC-108 用例）
pnpm -C apps/server test             # 服务端单测（审批/围栏接线）
node scripts/delivery/mine-clear.mjs gate --ledger outputs/mine-clear/T-2026-0929-0200/ledger.json
```
