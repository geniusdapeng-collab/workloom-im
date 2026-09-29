-- 0053 · 队列/任务列表 ORDER BY created_at DESC 覆盖索引（MC-209，来源：M4 交付面实测）
--
-- 实测（20,334 审批 / 3,042 线程 / 101,580 事件的 ws-yunqi）：
--   approvals.list / captain.theater 的排序计划为 `Sort(quicksort)` 覆盖本工作区全量
--   (workspace_id, status) 行后再 Limit —— 既有 idx_approvals_ws_status 不含 created_at，
--   idx_threads_ws_status 同理；工作区跑满一年量级后每次打开统一待办/任务页成本随总行数线性上涨。
--
-- 口径：只补索引，不改查询与返回契约；DESC 与生产查询 `ORDER BY created_at DESC NULLS LAST`
-- 的常用路径对齐（NULLS LAST 时 INDEX SCAN 仍可用，反向扫用于 ASC 场景）。
-- 幂等：IF NOT EXISTS，重复执行无副作用；建索引在迁移事务内完成（非 CONCURRENTLY）。

CREATE INDEX IF NOT EXISTS idx_approvals_ws_status_created_at
  ON approvals (workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_ws_created_at
  ON threads (workspace_id, created_at DESC);
