# 开发任务取消的作用域与提交顺序

`cancelTask(workspaceId, taskId, actor)` 复用当前可信服务作用域。入口先核对工作区参数与作用域，再使用现有 `serviceTx` 和应用角色读取任务。任务查询显式限定 `workspace_id` 和 `id`，并持有 `FOR UPDATE` 行锁；RLS 同时限定租户和工作区。

只有 `draft`、`confirmed`、`running`、`auditing`、`rejected`、`failed` 允许取消。找不到任务、任务属于其它作用域、状态已变为 `pending_approval`／`released`／`canceled`、任务仓库不可见或数据库拒绝操作时，调用失败。该次调用不会取消机床、丢弃工作树或提交任务与业务事件变更。仓库被停用仍允许其所属任务取消。

同一事务内按顺序执行：

1. 锁定并重读当前任务和允许状态。
2. 验证同工作区仓库，读取同工作区该任务的最新会话。
3. 更新任务为 `canceled`，并要求 `RETURNING id` 恰好返回一行。
4. 使用 `appendEventOn` 写入 `dev.task.cancel` 业务事件。
5. 成功提交后，才调用已授权任务的实时机床 `cancel()`，并清理所读取的所属会话工作树。

任务更新、事件写入或 COMMIT 任一失败都会由现有事务封装回滚，调用方收到错误，原生子进程与 Git 尚未被触碰。对同一空闲任务并发取消时，行锁使后续调用重读已提交的 `canceled` 状态，因此只有一个请求提交任务迁移和取消事件。

成功返回仍为 `{ ok: true, status: "canceled" }`。本变更没有新增 API、字段、索引、迁移或依赖。`FOR UPDATE` 的等待与重读行为依据 [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)；COMMIT 失败测试使用 [PostgreSQL 17 constraint trigger](https://www.postgresql.org/docs/17/sql-createtrigger.html)。

`apps/server/src/service/devtools.cancel.pg.test.ts` 运行 29 条真实私有 PostgreSQL、应用角色、Git 和本地 Node 子进程断言，覆盖无效作用域、关联仓库隔离、允许与禁止状态、真实权限拒绝、任务／事件／COMMIT 故障、零行更新、锁竞争、特殊任务标识、并发单次提交及正常取消。原有开发机床线程持久化和原始取消断言另行保持并回归。

后续后台失败处理是否再次改变取消终态、消耗返修轮次，以及 Git 清理失败是否如实传递，分别由 MC-035、MC-036 独立处理；MC-034 的通过不代表这些问题已修复。数据库提交与进程／文件系统之间没有跨系统事务，提交后进程或 Git 的失败也不会撤销已经提交的取消事件。
