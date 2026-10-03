# 竞品扫描的持久化与失败回执

`service.aipm.competitorScan` 只有在页面抓取完成、内容非空，而且当前租户与工作区的快照事务提交后，才返回 `mock: false`。它不调用模型。首次抓取返回 `changed: false`；后续抓取使用已提交的完整页面文本摘要判断变化。

调用方继续传入 `targets: [{ name, url }]`，服务返回 `{ reports: [...] }`。每条报告保留 `name`、`url`、`changed`、`snippet`、`mock`。成功时不含 `error`；失败时新增 `error: "scope" | "fetch" | "snapshot"`，同时返回 `mock: true`、`changed: false` 和简短的中文失败提示。

| `error` | 发生位置 | 行为 |
| --- | --- | --- |
| `scope` | 缺少可信双作用域、工作区不匹配、注册锚点不可见或预检失败 | 在 HTTP 前结束该批扫描 |
| `fetch` | URL 无效、协议不是 HTTP/HTTPS、URL 含用户信息、网络失败、HTTP 非成功状态、正文读取超时或页面文本为空 | 保留已有快照 |
| `snapshot` | 数据库读写权限、锁等待、快照内容或归属冲突、写入或提交失败 | 回滚事务并保留已有快照 |

服务日志只记录失败阶段，不记录 URL、页面、数据库错误或上游响应体。单条失败不会阻止同一批中其他目标返回已提交的成功回执。

## 身份与存储

服务先消费认证调用链已有的 `tenantId`、`workspaceId`，再通过应用角色和双 GUC 下的 RLS 查询验证真实注册工作区。查询的工作区与租户必须同时等于调用链的值，不通过属主反查推导租户。

快照沿用 `org_memory` 的合法 `kind: "pattern"`、`scope: "workspace"`、`status: "active"`，不改迁移、合法 kind 检查或 RLS。记录 ID 为：

```text
mem-comp-v1- + SHA256(JSON.stringify([
  "workloom.aipm/competitor-snapshot@1", tenantId, workspaceId, exactRequestedUrl
]))
```

`content` 是带版本的 JSON，包含 `schema`、`tenantId`、`workspaceId`、原样请求的 `url` 和完整规范化文本的 SHA256 `hash`。不保存原始 HTML、页面文本或展示名。新记录的 `source_events` 是空数组；更新已有合法快照时只更新 `content`，保留来源事件、置信度、创建时间、嵌入和其他元数据。

URL 以调用方传入的完整字符串区分身份，查询使用精确 ID 和作用域参数。URL 中的百分号、下划线、引号、Unicode 或子串关系不参与 `LIKE` 匹配。不同租户、不同工作区或不同 URL 字符串各有自己的首个基线。更改展示名不改变身份。

已有记录的归属、kind、scope、status、JSON schema、URL 和完整摘要格式必须有效。损坏记录、召回记录、其他记忆或同 ID 的外国作用域记录都会使扫描返回 `snapshot` 失败，不覆盖或重新激活它们。旧的 URL 全局短 ID 不作为新命名空间的基线。

## 抓取与原子比较

每次调用保留前 6 个目标的顺序。服务层空列表返回空报告，不抓取或查询数据库。HTTP 使用原来的 12 秒截止信号，覆盖响应头和正文读取；非成功 HTTP 响应和没有可见规范化文本的页面都视为失败。

正文使用轻量 HTML 文本提取：去除大小写不敏感的 script/style 区块和标签，折叠空白并去掉首尾空白。比较摘要覆盖完整提取文本，不在第 4000 个字符截断；返回的 `snippet` 继续最多 300 个字符。服务不执行页面 JavaScript，也不渲染浏览器 DOM。

HTTP 完成后，服务在短事务内设置 5 秒 `lock_timeout`，按完整快照 ID 获取事务级 advisory lock，再对当前合法基线执行 `SELECT ... FOR UPDATE`、验证、比较和有条件的 upsert。更新要求归属与元数据仍然匹配，旧内容也必须等于事务中读取的内容。成功写入返回值再次校验，事务提交后才发出成功报告。

这使同一页面的并发首次抓取都得到 `changed: false`；并发抓到相同的新内容时，只有真正完成从旧摘要到新摘要提交的请求得到 `changed: true`。数据库连接、SQL、触发器、提交或锁等待失败都不会留下成功报告。事务锁随提交或回滚释放，语义依据 [PostgreSQL 的显式锁文档](https://www.postgresql.org/docs/17/explicit-locking.html)；有条件的 upsert 和 `RETURNING` 依据 [INSERT 文档](https://www.postgresql.org/docs/17/sql-insert.html)。

## 回归验证

`apps/server/src/service/aipm.snapshot.pg.test.ts` 使用真实 loopback HTTP 和真实应用角色事务，覆盖正常、边界、错误、权限、回归、跨作用域隔离、历史保留、实际写入与 COMMIT 拒绝、同 URL 并发。测试没有替换 fetch、SQL 或提交。

该测试随通常的 Vitest 测试发现运行；`RUN_DB_TESTS` 未设置为 `1` 时跳过。启用时要求明确的 owner/app/gateway 三条连接，并且数据库名以 `aipm_proof_` 开头、连接到 `/tmp/wl-aipm-proof-` 下的独占 Unix socket。测试在操作前检查无 TCP 数据库监听，应用和网关角色均不是超级用户且不具备 `BYPASSRLS`。不接触客户数据库。

排雷任务的独占外层脚本会捕获当前源码，将所有 `@workloom/*` 内部别名绑定到该物理源码，完整迁移后执行两次原生 seed，并复跑冻结的原始 6 条断言、扩展矩阵、原生测试、相邻作用域/GitHub 测试、严格类型和原生事件链验证。扩展矩阵额外实测响应头和正文的 12 秒超时、连接拒绝、5 秒真实锁等待、catalog 恢复与全部保留历史摘要。每次使用新的证据标签，独立验收使用封存的源码和同一 argv 复跑。
