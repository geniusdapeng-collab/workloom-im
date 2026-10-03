# 开发机床会话的外部线程身份

`dispatchTask` 返回的 `sessionId` 标识本系统的开发会话。适配器 `started.threadId` 和终态 `result.threadId` 标识外部机床线程，保存在现有 `dev_sessions.thread_id` 文本字段，用于实时查询及返修续跑。外部身份保持原值，数据库不增加表、字段或迁移。

收到 `started` 时，服务沿用派发入口捕获的可信 tenant/workspace 双作用域。线程身份 UPDATE 明确把参数转换为 `text`，并与 `started` 事件 INSERT 放在同一 `serviceTx` 中提交。回调返回后，独立数据库连接可以读到已提交身份和事件；任一 SQL 失败时，该事务回滚。提供身份但会话记录不可见或已移除时也进入失败路径。

缺少 `threadId` 时保留已知值。显式提供空文本仍按既有文本契约保存；Unicode、引号及换行通过参数化 SQL 原样往返。重复或并发的 `started` 回调按本会话的队列顺序保存。

会话结束时先等待在途的 `started` 保存。正常保存后，缺少终态身份保留已知值，另一个外部终态身份继续按既有规则覆盖。启动信息保存失败时，终态保持 `error`，任务保持 `failed`；这一基础设施错误不会触发代码回收、发布审批或自动返修再派。

保存失败会取消运行中的机床会话，记录包含原 SQLSTATE 的脱敏日志，并尝试写入 `error` 事件及任务失败说明。错误事件或任务状态的补充写入也失败时，另记带上下文和原 SQLSTATE 的日志。原生 stdout 发出的事件回调不被会话管理器等待，所以这一失败路径在服务内完成处理，避免未处理的 Promise 拒绝。

实施时比较了两种做法：

| 做法 | 成本与适用前提 | 风险与选择 |
| --- | --- | --- |
| 只为 UPDATE 参数定型并向调用方抛出错误 | SQL 改动较少；需要事件发出方等待并处理回调拒绝 | 现有 stdout 发出方不会等待，终态也可能先于保存完成，因此不采用 |
| 参数定型、启动身份及事件原子提交、服务内故障记录和终态等待 | 需要会话内保存队列及失败状态；复用现有作用域、事务和事件表 | 使数据库回执与后续任务状态一致，本次采用 |

新增 `apps/server/src/service/devtools.thread.pg.test.ts` 使用独占 Unix PostgreSQL、真实应用角色及 Git 仓库。数据库、RLS、外键、事务和实际 SQL 均运行；可控边界是纯合成机床 emitter，其中两例运行原生 `startSession` 和本地合成子进程。

| 维度 | 用例数 | 验证行为 |
| --- | ---: | --- |
| 正常 | 1 | 会话仍在运行时可读到已提交的外部身份 |
| 边界 | 6 | 缺身份、保留已知身份、空文本、特殊字符及长文本、20 次重复、20 个并发回调 |
| 权限 | 3 | 缺可信作用域、外租户/外工作区派发拒绝、产品实际 SQL 的跨作用域隔离 |
| 回归 | 4 | 实际 SQL 的非空和空参数、终态保留及覆盖、返修续跑输入身份 |
| 错误 | 6 | 真实 42501/23514、事件 INSERT 失败回滚身份、补充写入失败留证、原生取消与资源释放、快速结束等待在途 SQL |

原有 `devtools.scope.pg.test.ts` 四条断言和 standalone 开发机床校验继续保留。测试环境必须由任务专属 helper 准备：显式配置新建 Unix 数据库的 owner/app/gateway URL，应用与网关角色须为 `NOSUPERUSER`、`NOBYPASSRLS`。设置 `RUN_DB_TESTS=1`、`DEVTOOLS_THREAD_TASK_OWNED=1` 后运行：

```bash
pnpm exec vitest run apps/server/src/service/devtools.thread.pg.test.ts \
  apps/server/src/service/devtools.scope.pg.test.ts \
  --maxWorkers=1 --no-file-parallelism --testTimeout=30000
```

独立交付证据目录中的 `devtools-thread-regression.py` 提供 `regression`、`full` 和 `types` 三种模式；每次创建新的物理源快照与随机数据库名称，并保留原始逐例结果和 PostgreSQL 日志。`full` 另外执行原 raw scope、closure、两次种子及旧库升级断言。测试禁止借用客户数据库或真实凭据，不调用外部模型。上述结果属于本机合成验证；独立 M6 验证和真实机床供应商运行仍需在对应环境执行。

参数定型依据 [PostgreSQL PREPARE 文档](https://www.postgresql.org/docs/17/sql-prepare.html) 的参数类型规则。失败识别保留 SQLSTATE，定义见 [PostgreSQL Error Codes](https://www.postgresql.org/docs/17/errcodes-appendix.html)。
