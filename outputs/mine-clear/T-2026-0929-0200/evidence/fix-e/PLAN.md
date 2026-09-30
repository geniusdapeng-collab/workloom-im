# fix_e_semantics · 修复计划（T-2026-0929-0200 · 批 E）

> 修复基线：`.wt-mcd-fe` @ `388c8c8`（= 集成支 task/T-2026-0929-0200 的 HEAD，含批 A–D；避免与批 A 的 decide() 改写冲突）
> 环境：DB `wl_mcd_fe`（migrate 53 + hotel/aipm 种子）、服务 8981（env-fe，local-preview 档）
> 日志：`work/fix-e/red-*.log`（红基线）、`work/fix-e/green-*.log`（绿）

## 范围（ledger 中仅剩的 5 张 open 卡）

| 卡 | 现象（红基线证据） | 修法要点 |
|---|---|---|
| MC-110 | `approveDocument` 先置 active 再补 pending 审批 → 幽灵待办；驳回不回滚（`red-kb.log`：approval_status=pending / doc=active） | 文档生效与审批记录同事务：审批行直接 `approved` + `decided_by/decided_at`（事后留痕不可回滚，UI 明示）；新增 `applyKbPublishAfterApproval` 钩子处理存量 pending 行（approve→生效、reject→退回 pending_review 且不可检索） |
| MC-111 | 5 问 5 答全被 KB FAQ 挤占（`red-ask.log`） | ①searchKB 相关性下限（注入面）；②事实「被问域优先」排序 + 页脚按实际取数来源声明；③补 c_tickets / night_runs 只读事实面 |
| MC-112 | `service.tickets.assign` 重复派单 500（`red-ticket.log`：状态机非法迁移 assigned→assigned，服务端日志 INTERNAL_SERVER_ERROR） | `assignTicketOn` 支持 assigned 原地改派（同值幂等不落事件）；service 路由层把 `ServiceHttpError` 映射为 404/409 语义码 |
| MC-113 | `accounts.inbox.unified` 恒 `groups: []`（`red-ticket.log`）；且只统计审批 | 种子为演示成员建 accounts + 回填 `members.account_id`；`inbox.unified` 增 pendingTickets（未办结工单）并落 P28 卡片 |
| MC-114 | pricing-agent 有 pending 审批却被 blocked 态覆盖（`red-thread.log`：pendingTier/approvalId = null） | `deriveFloor` blocked 分支共存请示信息（pendingTier/approvalId/asking 标志 + 双信息气泡）；前端 Floor 支持从 blocked 员工直达审批卡 |

## 断言（先红后绿）

- 新增 `outputs/.../assertions/f1-*.mjs`（KB 门禁 / ask 覆盖 / 工单改派 / 统一待办 / 楼层共存），全部用真机 tRPC/DB 取证；
- 复用并修正既有 M3 探针：kb 探针的「断点候选」检查按修复后语义改写、ask 探针的账本来源查询改按问题文本匹配（原按 session_id 查不到，sources 恒 null）、thread 探针补 blocked 共存断言。

## 回归

`pnpm typecheck` + `pnpm -C packages/runtime test` + `pnpm -C packages/base test` + `pnpm -C apps/server test`（含 e2e，需 DB）+ `pnpm suite`（端口允许时）+ 既有 M1/M2/M3 探针复跑。
