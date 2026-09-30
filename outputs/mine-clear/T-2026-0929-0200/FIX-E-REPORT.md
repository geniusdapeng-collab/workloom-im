# fix_e_semantics · 修复报告（批 E：MC-110 / MC-111 / MC-112 / MC-113 / MC-114）

> 任务号：T-2026-0929-0200　审计基线：`4ff9943`（origin/main）
> 修复基线：`388c8c8`（集成支 HEAD，含批 A–D；本批直接建在其上，合并为快进）
> 修复工作树：`/Users/mac/WorkLoom-fleet/.wt-mcd-fe`（分支 `task/T-2026-0929-0200-fe`，工作树干净）
> 修复提交（5 个，均带任务号）：
> `036f02b` MC-110+MC-112（service/审批/工单）→ `5a44312` MC-111（runtime ask 事实面）
> → `c1f0fbb` MC-113（种子账号 + 统一待办）→ `861c9d1` MC-114（数字职场共存）
> → `0c0a1ad` P28 信息色令牌（HEAD）
> DB：`wl_mcd_fe`（migrate 53 + hotel/aipm 种子；种子按本批改动重跑）　服务端口：8981（env-fe）
> 档位：**local-preview**（真实 PG + 真实服务端 + 真实鉴权 + 出厂默认配置；LLM=mock、IM=mock）
> 秘密扫描：`node scripts/secret-scan.mjs --range 388c8c8 HEAD` → PASS（17 targets）

## 1. 覆盖率声明

| 项 | 结果 |
|---|---|
| 本批 5 张卡的根因文件 | 精读全文：`apps/server/src/service/router.ts`、`service/kb.ts`、`service/ticket.ts`、`service/events.ts`、`trpc/accounts-router.ts`、`packages/runtime/src/ask.ts`、`packages/base/captain/floor.ts`、`scripts/seed.ts`（成员/账号段 + 全文结构）、`scripts/seed-aipm.ts`、`apps/web/src/pages/p0/Floor.tsx`、`p22/P22.tsx`、`p28/P28.tsx`、`service/gateway.ts`（建单/派单段）、`trpc/router.ts`（decide 接线段 + 启动接线段）、`service/e2e.test.ts`（KB/工单段）、`scripts/suite.ts`（KB 事实段）、`packages/runtime/runtime.test.ts` |
| 机检/脚本解析 | 5 张问题卡 + 4 个 M3 探针 + 5 个新建 f1 断言脚本 + `biz_events` 链自检（内联 `canonicalJson/eventHash` 与库内逐条对齐）+ SQL 直查（approvals/c_tickets/members/kb_documents/night_runs） |
| 抽样 | 未抽样：范围文件全部读到底（`router.ts` 3.7k 行项目中仅 KB/工单/审批/接线相关段逐行读，其余段用 `rg` 定位调用面，不计入结论依据） |
| 未读 | 未读文件不作为结论依据；三端其余页面、桌面壳、真实 LLM/IM 通道、CNB 侧流水线归属他批次 |

## 2. 逐卡根因与修法（A 级：代码精读 + 真机实测）

| 卡 | 红基线（修复前实测） | 修法 |
|---|---|---|
| MC-110 | `approveDocument` 先 `UPDATE kb_documents SET status='active'`，再补一条 `status='pending'` 的 approvals 行 → 审批台出现「动作已执行却待办」幽灵条目；在该行点驳回不回滚任何东西（`red-kb.log`：`approval_status=pending / doc=active`，驳回后 `approval=rejected / doc=active / hits=1`） | ① `publishKbDocumentInTx`（router.ts:119）：文档置 active + `kb.publish` 五元事件（带 basis）+ approvals 行 **approved**（`gesture/decided_by/decided_at` + `snapshot.post_hoc`）三写同一 COMMIT；② `approveDocument` 仅接受 `pending_review`，重复批准幂等（`deduped:true`，不新增事件/审批行），返回值带 `status/approvalId`；③ `setStatus(active)` 对待审文档走同一留痕路径（堵住文档抽屉「置为生效」的静默发布面）；④ 新增 `applyKbPublishAfterApproval`（kb.ts:358）并在 `approvals.decide` 接线：approve/edit → 文档生效；**reject → 退回 `pending_review` 且即刻退出客户问答检索**；⑤ P22 文案声明「撤回走停用（同样留痕）」 |
| MC-111 | 5 问 5 答全被 FAQ 挤占：`当前有多少待审批事项？` → 维修报修 FAQ（score 0.533），`mergeKbFacts` 把 KB 排在最前吃满 120 字预算，approvals/threads 事实一条不显示，落款仍写「以上数字均来自事件库实时取数」（`red-ask.log`） | ① `AskFact` 增 `domain`，`mergeKbFacts` 的知识命中标 `kb`；② `orderAskFactsForQuestion/askedAskDomains`（ask.ts:345/360）按「被问域 > 知识库 > 其余」装行；③ `composeAskAnswer` 落款按正文实际事实类型生成（KB-only → 「以上内容来自知识库检索」）；④ `defaultAskFactProvider` 增 `c_tickets`（未办结 + SLA 超时）与 `night_runs`（最近班次/候选数）事实；⑤ `searchKB` 增 `minScore`，ask 注入侧 `ASK_KB_MIN_SCORE=0.65`（实测噪声 0.53~0.64 / 真知识 0.64~0.69），P22 检索面保持宽召回 |
| MC-112 | C 端建单即自动 assigned（gateway 建单链路），B 端「派单」再派触发 `assertTransition('assigned','assigned')` → `ServiceHttpError(409)` 被 tRPC 兜成 **500**（服务端日志：`service.tickets.assign → INTERNAL_SERVER_ERROR: 工单状态机非法迁移：assigned → assigned`） | ① `assignTicketOn`（ticket.ts:173）：`assigned→assigned` 定义**原地改派**——同值幂等 no-op（`changed:false`，不写事件）；异值只更新 `dept/assignee`（状态不变）并追加 `'assign'` 事件（`detail.reassigned=true`）；`processing/done/closed` 仍走状态机断言；② 新增 `ServiceHttpError→TRPCError` 映射（router.ts:70/87）：404→NOT_FOUND、409→CONFLICT、503→SERVICE_UNAVAILABLE（tRPC v11 中间件收不到 throw，改为检查 `next()` 结果并取 `error.cause`）；③ kb/tickets 写过程统一走 `svcWriteProcedure`；④ 服务端日志/事件账本不再把 4xx 语义伪装成故障 |
| MC-113 | 种子只建 `members` 不建 `accounts` → `accountIdOf` 恒 undefined → `accounts.inbox.unified` 恒 `groups: []`（`red-ticket.log`：P28 页面显示"暂无工作区成员关系"）；且端点只统计 approvals | ① `scripts/seed.ts` / `seed-aipm.ts`：为演示成员建 accounts（`acc-demo-hotel-*` / `acc-demo-aipm-*`，演示保留命名空间）并回填 `members.account_id`（幂等，可重复执行）；② `inbox.unified` 增 `pendingTickets`（`c_tickets` created/assigned/processing，与 P22 同口径），审批/工单两次查询各自 fail-soft；③ P28 卡片展示两项计数 |
| MC-114 | `pricing-agent` 既有近 30 分钟 blocked 事件、又有 pending 审批时，`deriveFloor` 的 blocked 分支把 `pendingTier/approvalId` 置 null：楼层看不到「有单待裁」，审批直达号丢失（`red-thread.log`：`state=blocked, pendingTier=null, approvalId=null`，而 `pendingByTier` 里明明有这条审批） | ① `deriveFloor`（floor.ts:255）：blocked 主态保留（V-06 遇阻优先）并并列 asking 信息（`pendingTier/approvalId/asking` + `statusLine「遇阻 · 请示待裁」`）；② 同员工多条 pending 时按 `created_at ASC` 给最早一条直达号，并新增 `pendingCount`（>1 时气泡/状态行显式「共 N 项待裁」，信息不丢）；③ `Floor.tsx`：blocked 且有待裁时气泡「遇阻 · 请您定」，点击直达审批卡（原先仅 asking 可点） |

## 3. 与卡片建议的偏差及理由（须产品复核）

1. **MC-110 未采用「两段式真实门禁」**（卡片 fix_plan 建议 approveDocument 只写 staged + pending，再由审批台批准生效），采用卡片断言显式允许的**第二条分支**：「批准后审批行直接 approved」。理由：
   - P22「待审区」的语义就是**人审动作本身**（按钮文案「批准生效」、横幅「已批准生效，审批中心与事件账本已同步」），改为两段式会让同一个人先"请求"再"批准"自己，且页面文案/交互要整体重做；
   - 幽灵待办与"驳回不回滚"两个原始断点都已消除：记录不再是 pending（无幽灵），存量 pending 行被驳回时文档退回待审并退出检索（有回滚）；
   - 逐条人审不变量（INV-4）由 `actionProcedure("approval.decide")` 守卫承担——发布动作现在要求审批权限（此前只要求 `workspace.write`）。
   - 若产品仍要两段式（上传者与审批者分离），本批的钩子与留痕路径可直接复用：把 `approveDocument` 改回写 pending + `applyKbPublishAfterApproval` 已能在 approve 时生效。
2. **MC-113 未接「告警」计数**：基座无 alerts 表（告警属行业包数据面），本卡只补审批 + 工单两域；P28 头部文案如实写「待审批 / 未办结工单」。
3. **MC-111 相关性下限 0.65 为 hotel 出厂语料校准值**：常量集中在 `ASK_KB_MIN_SCORE`，跨行业语料需要复校（不影响"被问域优先"这条与语料无关的排序口径）。
4. **断言脚本维护**：4 个 M3 探针按修复后语义改写（详见 §5），其中两处是**探针自身的缺陷修正**而非放宽：
   - ask 探针：`biz_events` 查询未设 RLS GUC（恒空）、把取数来源读成不存在的 `after.sources`（实际在 `decision.basis[0]`），导致「账本口径」永远测不到；
   - kb 探针：检索判据用固定口令，被历次运行留下的 active 文档污染（"变更前不可检索"恒假红）；
   - thread 探针：快照投影漏掉 `asking` 字段 → 共存态判定看不到；且"直达号必须等于本次这条"在同员工多条 pending 时过严，改为「有请示信号 + 有直达号 + 待裁总数 ≥1」。

## 4. 验证证据（A 级：真机实测；日志在 `work/fix-e/`，JSON 证据在 `evidence/fix-e/`）

| 卡 | 命令 | 结果 | 证据 |
|---|---|---|---|
| MC-110 | `MCD_BASE=http://127.0.0.1:8981 … node …/f1-kb-publish-gate.mjs` | **19/19**：门禁（待审不入检索）、approved 记录（决策人/手势/post_hoc）、无幽灵待办、重复批准幂等、存量 pending 行 reject→退回待审且检索 0 命中、再批准→恢复、哈希链自检 | `evidence/fix-e/f1-kb-1790706124251.json` |
| MC-110 | `… node m3-linkage-kb.mjs`（改写后） | **18/18** | `evidence/m3-kb-1790706124843.json` |
| MC-111 | `… node f1-ask-coverage.mjs` | **20/20**：待审批 3 项 = 库内 3；进行中线程 = 库内 +1（本次 ask 线程本身）；工单 5 条未办结（SLA 超时 1）；夜班 2026-09-28 决策包（候选 14）；KB 问题走知识库且落款为知识库口径；账本 basis 含 approvals/c_tickets/night_runs，approvals 来源无 `kb:` | `evidence/fix-e/f1-ask-1790706124455.json` |
| MC-111 | `… node m3-linkage-ask.mjs yunqi-hotel`（修正账本读取） | **8/8** | `evidence/m3-ask-1790706125002.json` |
| MC-112 | `… node f1-ticket-reassign.mjs` | **11/11**：同值重复派单 200 且 0 新事件；跨部门改派 200 且 +1 事件、状态不变；已办结再派 **409 CONFLICT**「工单状态机非法迁移：done → assigned」；不存在 **404 NOT_FOUND** | `evidence/fix-e/f1-ticket-1790706124591.json` |
| MC-112/113 | `… node m3-linkage-ticket.mjs`（P28 检查改两段） | **18/18** | `evidence/m3-ticket-1790706125123.json` |
| MC-113 | `… node f1-inbox-unified.mjs` | **10/10**：ai-pm-demo 分组 non-empty（pendingApprovals 4 = 库内）、建单 pendingTickets +1、办结回落；yunqi-hotel 计数一致；跨店隔离；种子 members.account_id 3/3 两库 | `evidence/fix-e/f1-inbox-1790706124692.json` |
| MC-114 | `MCD_BASE=http://127.0.0.1:8981 node …/f1-floor-blocked-asking.mjs` | **11/11**：`state=blocked` + `pendingTier=l2_captain` + `approvalId` + `asking=true` + `pendingCount≥1` + 双信息 statusLine；批准后线程续跑（MC-101 接线回归） | `evidence/fix-e/f1-floor-1790706117609.json` |
| MC-114 | `… node m3-linkage-thread.mjs`（改写判定） | **11/11** | `evidence/m3-thread-1790706160084.json` |
| 回归 | `pnpm typecheck` | 10 包全绿 | `work/fix-e/typecheck.log` |
| 回归 | `pnpm test`（含 mine-clear/payload/release 等 7 批 + oss） | exit=0，fail 0 | `work/fix-e/root-test.log` |
| 回归 | `RUN_DB_TESTS=1 pnpm -C packages/base test` | 52 文件 / **815 通过 / 8 跳过** | `work/fix-e/base-test.log` |
| 回归 | `RUN_DB_TESTS=1 SERVICE_C_TEST_WORKSPACE_ID=ws-yunqi SERVER_E2E_PORT=8983 pnpm -C apps/server exec vitest run src/service/e2e.test.ts` | **101/101**（含新增 4 例：发布留痕/幂等/驳回回滚/直达启用留痕；工单改派 3 例改写） | `work/fix-e/e2e.log` |
| 回归 | `SUITE_SERVER_PORT=8911 SUITE_STUB_PORT=8913 pnpm suite` | **463/463** | `work/fix-e/suite.log` |
| 回归（他批接线） | `m1-approval-resume.mjs` / `m1-highrisk-batch.mjs` / `m1-approval-reuse.mts` / `m3-linkage-reject.mjs` | 全绿（decide 钩子改动未破坏批 A 语义） | `evidence/fix-e/`（本轮输出在终端日志） |

## 5. 复跑入口

```bash
# 0) 服务（当前常驻 8981；重启：work/fix-e/serve-fe.sh <repo> <log> work/env-fe）
bash work/fix-e/serve-fe.sh /Users/mac/WorkLoom-fleet/.wt-mcd-fe work/fix-e/server-8981.log work/env-fe

# 1) 本批 5 个专用断言（应全绿）
cd /Users/mac/WorkLoom-fleet/.wt-mcd-im/outputs/mine-clear/T-2026-0929-0200/assertions
export MCD_BASE=http://127.0.0.1:8981 \
       DATABASE_APP_URL=postgres://workloom_app@127.0.0.1:5432/wl_mcd_fe \
       DATABASE_GATEWAY_URL=postgres://workloom_gateway@127.0.0.1:5432/wl_mcd_fe
node f1-kb-publish-gate.mjs && node f1-ask-coverage.mjs && node f1-ticket-reassign.mjs \
  && node f1-inbox-unified.mjs && node f1-floor-blocked-asking.mjs

# 2) M3 联动探针（本批改写后；另加 reject 探针）
node m3-linkage-kb.mjs && node m3-linkage-ask.mjs yunqi-hotel && node m3-linkage-ticket.mjs \
  && node m3-linkage-thread.mjs && node m3-linkage-reject.mjs

# 3) 台账上账（协调会话执行；已用副本验证通过，58 卡门禁绿）
cd /Users/mac/WorkLoom-fleet/.wt-mcd-im
for id in MC-441 MC-442 MC-443 MC-444 MC-445; do
  node /Users/mac/WorkLoom-fleet/.wt-mcd-fe/scripts/delivery/mine-clear.mjs add \
    --ledger outputs/mine-clear/T-2026-0929-0200/ledger.json \
    --card outputs/mine-clear/T-2026-0929-0200/cards/$id.json
done
node outputs/mine-clear/T-2026-0929-0200/cards/sync-states.mjs   # 把 MC-110..114 翻 fixed 并写入 regression
```

## 6. 环境与遗留状态（交接用）

- `wl_mcd_fe`：已按本批改动重跑 hotel + ai-pm 种子（账号回填、price_bands 在位的批 C 形态）；库内积累多轮探针线程/审批/知识文档（append-only，链完整——f1 脚本内含哈希链自检，最近 50 条逐条通过）。
- 端口：8981（env-fe，local-preview 档）。停止：`lsof -nP -iTCP:8981 -sTCP:LISTEN -t | xargs kill`。
- `.wt-mcd-fe/.env` = `work/env-fe`（gitignored；e2e 子进程按 `--env-file=.env` 拉起，必须有该文件）。
- 断言脚本：`f1-*.mjs`（新增 5 个）与 `m3-linkage-{kb,ask,ticket,thread}.mjs`（按修复后语义改写）都在 `outputs/mine-clear/T-2026-0929-0200/assertions/`（该目录在 `.gitignore` 内，随台账工作树留档）。
- 台账：`cards/fix-E.json`（合并版）与 `cards/MC-441..445.json`（逐卡）已生成并加 `gen-fix-E.mjs`；**尚未写入 `ledger.json`**（避免与协调会话并发写冲突，命令见 §5.3）。

## 7. 未覆盖 / 残留风险

1. **MC-110 两段式门禁未做**（§3.1）——产品裁决项；当前形态下"上传者与审批者分离"只能靠角色权限（`approval.decide`）实现。
2. **历史遗留组合未批量清理**：修复前产生的 `pending kb.publish + 文档已 active` 行，只有被裁决时才收敛；如需一次性清理需单独立卡（涉及账本口径，不宜批量改历史审批行）。
3. **ask 相关性下限为单行业校准**（hotel），换行业语料需复校；"被问域优先"与"落款口径"不依赖语料。
4. **P28 告警域未接入**（基座无 alerts 表）。
5. **桌面端未验收**：P0/P22/P28 的改动只做了 typecheck 与代码走查，未跑桌面壳/截图走查（M6/RDAS 域）。
6. **本批未跑 `pnpm -C apps/server test` 全量**（只跑 e2e 文件）：apps/server 其余测试与 base/runtime 测试已在 `pnpm test`/`pnpm suite` 中覆盖；如需 CI 同口径全量，按 §5 的命令扩展。

## 8. 收尾报告

- **已完成**：5/5 张卡红→绿（红基线 `work/fix-e/red-*.log`、绿证据见 §4），4 个提交、4 个 M3 探针改写、5 个专用断言、4 例 e2e 新增 + 3 例改写、3 例 runtime 单测、1 段 suite 跨仓断言；回归矩阵 typecheck / pnpm test / base 815 / e2e 101 / suite 463 全绿；秘密扫描 PASS；工作树干净。
- **未完成/未覆盖**：见 §7（1–6）。
- **自主追加事项及理由**：
  1. `ServiceHttpError→TRPCError` 映射覆盖到 kb/tickets 全部写过程（MC-112 根因是"服务层语义错误没有出口"，只修 assign 会在下一个服务过程复现）；
  2. `setStatus(active)` 对待审文档走同一发布留痕路径（MC-110 的"三面一致"必须堵住抽屉直启的旁路）；
  3. `pendingCount`（数字职场待裁总数）——同员工多条 pending 时原投影只显示一条，补计数让"信息不丢"可判定；
  4. `appendEventOn` 增可选 `basis`（发布事件需要留"逐条人审"依据，账本可下钻）；
  5. 探针缺陷修正（RLS GUC / basis 字段 / 唯一检索词 / asking 字段）——不修则本批的验收口径无法被检验。
- **采用的假设**：①"待审区批准生效"即逐条人审动作本身（P22 文案与按钮语义）；②演示账号使用 `demo.workloom.local` + 1390000{1,2}00x 保留命名空间；③工单改派按"同值幂等 / 异值留痕"语义；④相关性下限 0.65 以 hotel 语料为准；⑤档位为 local-preview（仅本机预览结构验收，非生产实测）。
- **置信度**：**高**——5 张卡均有红→绿对照（真机 tRPC/DB 取证）+ 全量回归（typecheck/test/base/e2e/suite）+ 他批断言交叉复跑。中置信项：MC-110 两段式门禁的产品裁决（§3.1）、ask 下限的跨行业校准（§7.3）。
- **建议复核**：① `apps/server/src/service/router.ts#publishKbDocumentInTx`（审批行直接 approved 的语义是否接受）；② `packages/runtime/src/ask.ts#ASK_KB_MIN_SCORE` 与 `orderAskFactsForQuestion`（排序口径）；③ `packages/base/captain/floor.ts` blocked 分支的 `pendingCount/asking` 字段是否满足前端与门禁的长期口径。

## 9. 自检表

- [x] 覆盖了任务全部范围，而非挑了容易的部分？（5/5 卡红→绿；未做项逐条列明）
- [x] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？（台账上账命令已给，判断为协调会话避免并发写冲突而主动让位）
- [x] 每个结论/每段代码有依据、可验证、证据等级标注准确？（A 级真机实测 + 文件:行号@提交；探针改动逐条列出）
- [x] 经得起资深工程师逐行审查？（红→绿对照、回归矩阵、链自检、秘密扫描、revert 路径齐备）
