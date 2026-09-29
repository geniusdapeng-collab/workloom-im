# M3 联动排雷报告（状态投影保真度）· T-2026-0929-0200

> 阶段：MCD v1.0 模板④「M3 联动排雷」（B3 档）
> 仓库 / 基线：`workloom-im` `/Users/mac/WorkLoom-fleet/.wt-mcd-im` @ `4ff9943`（分支 `task/T-2026-0929-0200`）
> 环境：`local-preview`（本机预览：真实 PG17 + 真实服务端 + 真实鉴权 + 种子数据；LLM=mock、IM=mock）
> 执行会话：`/root/mcd_linkage`（发现者；修复与独立验收由其他会话承担）
> 时间：2026-09-29 23:05–23:42（Asia/Shanghai）

## 覆盖率声明

- 范围内文件总数：**29**；精读：**14**；机检/脚本解析：**10**；抽样：**5**；未读：**0**（范围内）
- 范围定义：联动图（§2）中出现的「状态源头 / 数据源 / 投影逻辑 / UI 映射」四类文件 + 其可运行面。
- 未读/范围外（明确声明，不计入上表）：三端其余 20+ 页面模块、`apps/desktop`、`apps/site`、`packages/base` 其余 20+ 域实现、全套测试文件（仅精读 `e2e.test.ts` G 段 920–975）、真实 LLM 提供方路径（`LLM_PROVIDER≠mock`）、真实 IM/微信/支付宝通道、桌面打包与发行链路。
- 精读清单（14）：`packages/base/captain/floor.ts`（全文）、`apps/server/src/runtime/thread-runner.ts`（全文）、`apps/server/src/runtime/scheduler.ts`（全文）、`packages/base/review-console/approvals.ts`（140–380）、`packages/runtime/src/ask.ts`（70–300）、`apps/server/src/service/router.ts`（1–305 + 全量过程名机检）、`apps/server/src/service/ticket.ts`（1–200）、`apps/server/src/service/gateway.ts`（1–60 / 205–265 / 412–700）、`apps/server/src/trpc/accounts-router.ts`（1–120 / 520–594）、`apps/server/src/trpc/router.ts`（1039–1500 / 3300–3400 / 3503–3554）、`apps/server/src/service/kb.ts`（1–380）、`apps/server/src/service/e2e.test.ts`（920–975）、`apps/web/src/pages/p28/P28.tsx`（全文 80 行）、`packages/ui/src/language.ts`（60–140 + `clientStatusLabel`）。
- 机检清单（10，B 级证据）：三端状态枚举覆盖扫描（`apps/web`、`apps/webb`、`apps/webc`、`packages/ui`）、`threads.status` CHECK 约束与迁移 `0049`、页面→tRPC 调用面清单（p1/p2/p3/p4/p22/p28/floor/webc）、DB 计数与抽样（`members`/`accounts`/`threads`/`approvals`/`biz_events`/`c_tickets`/`kb_documents`）、HTTP 探针（`threads.*`/`approvals.*`/`captain.theater`/`accounts.inbox.unified`/`nightShift.current`/`service.*`/`/c/*`）。
- 抽样清单（5，仅用于定位行号与交叉印证，不作为独立结论依据）：`apps/web/src/pages/p22/P22.tsx`（工单卡/文档抽屉片段）、`apps/web/src/components/star-ring/StarRing.tsx`（状态映射片段）、`apps/webb/src/App.tsx`（grep 命中行）、`apps/webc/src/lib/api.ts` + `pages/TicketsPage.tsx`（片段）、`packages/base/{night-shift,im-channels}`（片段）。

## 1. 证据分级（A/B/C/D，逐条）

| 结论 | 等级 | 依据 |
|---|---|---|
| MC-110 知识库「先执行后补审批」幽灵待办 + 驳回不回滚 | **A** | 真机 `m3-kb-1790695144646.json` + 代码 `service/router.ts:182`、`approvals.ts:175` |
| MC-111 ask 助手答非所问、系统事实被 KB 命中挤掉、取数口径不实 | **A** | 真机 5 问 5 答 `m3-ask-1790695521766.json` + 账本 basis + 代码 `ask.ts:175/278`、`kb.ts:311` |
| MC-112 重复派单 500（assigned→assigned） | **A** | 真机 `m3-ticket-1790695253479.json`（响应原文 500）+ 代码 `ticket.ts:174`、`gateway.ts:210`、`e2e.test.ts:952` |
| MC-113 P28 统一待办出厂演示恒空 | **A**（含设计意图注记） | 真机 `m3-thread-*.json`/`m3-ticket-*.json` 的 `accounts.inbox.unified={"groups":[]}` + DB（`members.account_id` 全 NULL、`accounts` 0 行）+ 代码 `accounts-router.ts:559` |
| MC-114 数字职场 blocked 压制 asking、请示直达号不可见 | **A** | 真机 `m3-thread-1790696247065.json`（S1 楼层快照）+ 代码 `floor.ts:231/235` |
| MC-101 增补：批准后跨面口径不一致（待办面清零 / 执行面挂起） | **A** | 真机 `m3-thread-1790696247065.json`（20s 窗口，各面快照） |
| MC-104 增补：驳回路径线程时间线缺 `approval.gesture` | **A** | 真机 `m3-reject-1790696508787.json` |
| 健康面 §4 全部条目 | **A** | 同一批真机探针断言输出 |
| 「三端状态枚举无缺口」 | **B** | 机检：`packages/ui/language.ts` 的 `STATUS_LABELS` 覆盖 `cancelled/queued/paused/...`，`dictText` 兜底回落到 `clientStatusLabel` |
| 桌面壳 / 真实 LLM / 真实 IM 通道的联动 | **D** | 未覆盖（范围外，环境为 mock） |

## 2. 联动图（状态变更 → 数据源 → 投影逻辑 → UI 映射，带代码位置）

```
【链路 1 · 任务线程 threads.status】
threads.dispatch (apps/server/src/trpc/router.ts:1039) ─┐
threads.run     (apps/server/src/trpc/router.ts:1303) ─┤
packages/runtime/src/loop.ts:456-556（review 挂起 → UPDATE threads）─┘
        │  写
        ├─ 数据源：threads(plus agent_id/progress/closed_at) · biz_events(session_id=threadId)
        ├─ 投影：threads.list:1040 / get:1200（含 X-02 直达号） / events:1234 / settledSince:1262
        │        captain.theater:3309（pendingByTier 查询 :3317 / ticker / floor）
        │        deriveFloor（packages/base/captain/floor.ts:143-262：running/queued/asking/blocked/celebrating/idle）
        │        secretary（apps/server/src/service/secretary.ts:180/428 摘要口径）
        └─ UI：apps/web P1(列表)/P2(详情+推进)/StarRing(卡片+播报) · apps/webb App.tsx(移动待办)

【链路 2 · 审批 approvals.status】
approvals.decide (packages/base/review-console/approvals.ts:175)
IM 手势回调      (packages/base/im-channels/callback.ts:132 → decide)
        │  写 approvals + biz_events(approval.gesture / approval.expired)
        ├─ 投影：approvals.list (router.ts:1403) · theater.pendingByTier (router.ts:3317)
        │        accounts.inbox.unified (accounts-router.ts:559) · nightShift.current (router.ts:2017)
        │        联动钩子：围栏提案激活 (router.ts:1356 定义 / :1433 调用) · HR 汰换 (router.ts:1446) · 驳回→线程 cancelled (approvals.ts:296)
        └─ UI：P4 审批台 · P3 夜班决策包 · P28 统一待办 · webb 待办卡

【链路 3 · 知识文档 kb_documents.status】
service.kb.upsertDocument (service/router.ts:86，落 pending_review)
service.kb.approveDocument (service/router.ts:182，置 active + kb.publish 事件 + approvals 行)
      │ 数据源：kb_documents · kb_chunks · biz_events(kb.*) · approvals(kb.publish)
      ├─ 投影：searchKB (service/kb.ts:311，仅 d.status='active') → C 端 dialog(/c/chat)
      │        ask 事实面 mergeKbFacts (packages/runtime/src/ask.ts:175) → composeAskAnswer:278（120 字闸）
      └─ UI：P22 知识库（待审区/检索预览）· apps/webc 问答

【链路 4 · 工单 c_tickets.status】
/c/tickets (service/gateway.ts:568) → createTicketFlow(210)：createTicketOn → assignTicketOn（自动 assigned）
service.tickets.assign/advance/complete (service/router.ts:223/238/260) → ticket.ts:160-260
      │ 数据源：c_tickets · c_ticket_events · c_notifications（pushMessage）
      ├─ 投影：service.tickets.list/timeline (:211/:217) · service.stats.overview (:303) · /c/tickets /c/notifications
      └─ UI：P22 工单台（分派/开始/办结/时间线）· apps/webc TicketsPage（客户侧 + 时间线 + 通知）

【链路 5 · 助手问答 ask】
threads.dispatch(mode=ask) → runAsk (packages/runtime/src/ask.ts:396)
      │ 数据源：biz_events · approvals · threads · fence_rules · org_memory · kb 命中
      └─ 投影：composeAskAnswer:278（120 字预算）→ 事件 ask.answer（basis 记 sources）→ P0 对话框 / 移动端
```

## 3. 联动断点清单

| 卡号 | 断点面 | 实证（真机） | 根因（file:line@commit） | 修法要点 | 验收断言 |
|---|---|---|---|---|---|
| MC-101（增补） | 审批→执行面：批准后审批台/剧场/统一待办全部清零，线程仍 `pending_review`，无任何面提示「已批准待续跑」；IM 入口同样不续跑 | `evidence/m3-thread-1790696247065.json` | `apps/server/src/runtime/scheduler.ts:84@4ff9943`（只扫 queued）+ `approvals.ts:296@4ff9943`（仅 reject 联动） | decide 钩子内把步骤级线程重新入队（queued）或直接在事务后 `runQuestForThread`；移动/IM 通道同享 | `node .../m3-linkage-thread.mjs`（20s 窗口断言线程离开 pending_review） |
| MC-110 | 知识库→审批台：批准动作先执行、审批行后置 pending（幽灵待办）；驳回后文档仍 active 且仍被检索/问答引用 | `evidence/m3-kb-1790695144646.json` | `apps/server/src/service/router.ts:182@4ff9943` | 文档保持 staged+pending，批准时由 decide 钩子置 active；驳回保持 pending_review | `node .../m3-linkage-kb.mjs`（pending 与实际生效一致性 + 驳回回滚） |
| MC-111 | 问答→业务域：问待审批/工单/夜班均得到无关 FAQ，系统事实一条不展示，却落款「以上数字均来自事件库实时取数」 | `evidence/m3-ask-1790695521766.json` | `packages/runtime/src/ask.ts:175@4ff9943`（KB 优先）+ `:278`（120 字闸）+ `apps/server/src/service/kb.ts:311@4ff9943`（无相关性下限） | KB 相关性阈值；按被问域优先装行；未引用 KB 时去掉取数落款；补工单/夜班事实面 | `node .../m3-linkage-ask.mjs yunqi-hotel`（5 类问题逐一断言 sources/答案） |
| MC-112 | C 端建单→B 端派单：建单即 `assigned`，B 端再次派单 `assigned→assigned` 抛 500（应幂等或 409） | `evidence/m3-ticket-1790695253479.json` | `apps/server/src/service/ticket.ts:174@4ff9943` | assigned 态走「原地改派」分支；tRPC 层映射 `ServiceHttpError`；修 e2e 弱断言 | `node .../m3-linkage-ticket.mjs`（重复派单不得 5xx） |
| MC-113 | 跨店统一待办：出厂演示下恒 `{"groups":[]}`（members.account_id 全 NULL），且只统计审批、工单/告警未纳入 | `evidence/m3-thread-*.json`（S0/S2）+ `evidence/m3-ticket-*.json` | `apps/server/src/trpc/accounts-router.ts:559@4ff9943` + `scripts/seed.ts:540@4ff9943` | 种子建账号并关联；或演示身份兜底解析；inbox 增工单待办计数 | `node .../m3-linkage-thread.mjs`（inbox 快照）+ 工单探针复查 |
| MC-114 | 数字职场：同一员工「30 分钟内 blocked + 新 pending 请示」时只显示遇阻，`approvalId/pendingTier` 为 null，请示不可直达 | `evidence/m3-thread-1790696247065.json` | `packages/base/captain/floor.ts:235@4ff9943`（blocked 分支不带审批信息） | 照 X-05 共存口径：blocked 同时携带 asking 信息与直达号 | `node .../m3-linkage-thread.mjs`（asking/approvalId 断言） |
| MC-104（增补） | 线程时间线：驳回让线程进 `cancelled`（联动生效），但 `threads.events` 看不到 `approval.gesture`——谁驳回的不可见 | `evidence/m3-reject-1790696508787.json` | `packages/base/review-console/approvals.ts:254@4ff9943` | decide 写手势事件时带 `sessionId`（或 threads.events 支持 links 投影） | `node .../m3-linkage-reject.mjs`（事件序列含 approval.gesture） |

补充观察（未单独上账，供修复时留意）：
- P22 工单台只在 `status=created` 渲染「分派」按钮，而 C 端链路建单一律自动 `assigned`——UI 上无从改派/换部门（与 MC-112 同源，建议一并设计改派入口）。
- `accounts.inbox.unified` 的注释自述「告警/工单由行业包数据面补充，结构先行」，属**已声明的数据源缺口**；MC-113 处理时应同步更新该声明或补齐实现。
- MC-104 同一处：`expireSweep` 的 `approval.expired` 同样无 `session_id`（超时升级在线程时间线也不可见）。

## 4. 健康面清单（防修复误伤，逐项真机取证）

| 健康面 | 证据 | 说明 |
|---|---|---|
| 派遣→围栏挂起：`threads.dispatch(runImmediately)` → `pending_review` + `approvals` 行（tier=l2_captain）+ `threads.get.pending_approval_id` 直达号 | `m3-thread-1790696247065.json` | X-02 直达入口有效 |
| 批准→续跑闭环的授权留痕（#34）：显式 `threads.run` 后续跑写事件 `basis=["经审批 apr-… 批准执行（E3.3 恢复闭环）"]` | `m3-thread-1790696247065.json` | 路径本身可用，缺的是自动触发（MC-101） |
| 驳回→线程终态联动（GR-10）：`cancelled` | `m3-reject-1790696508787.json` | 与批准分支不对称（批准不续跑），修复时勿破坏 |
| 结算流水（X-08）：`threads.settledSince` 同时返回 completed 与 cancelled 线程 | `m3-reject-1790696508787.json` | 织伴「补播报」数据源 |
| 驳回→组织记忆：`mem-reject-<enum>` 落 `org_memory` 且 `memory.list` 可读 | `m3-kb-1790695144646.json` + `memory.list` 实录 | 校准闭环有效 |
| 剧场计数：`captain.theater.pendingByTier` 随审批增减（l2_captain 6→5） | `m3-thread-1790696247065.json` | 与审批台同源 |
| C 端工单全链路：提交→受理通知→B 端可见→派单/推进/办结→客户侧状态/时间线/办结通知→统计 +2 | `m3-ticket-1790695253479.json` | 除重复派单外全部通过 |
| 知识库状态门禁：`pending_review` 不入检索 → `active` 即被检索 → C 端问答引用（72 小时） | `m3-kb-1790695144646.json` | 检索面与状态门禁有效 |
| 工作区隔离（负面对照）：ws-yunqi 读取 ws-aipm-demo 工单列表不含目标单 | `m3-ticket-1790695253479.json` | RLS 面未见越权 |
| 三端状态枚举覆盖（机检）：`STATUS_LABELS` 含 `queued/running/pending_review/paused/completed/failed/cancelled` | 机检（B 级） | 未发现「生产-消费枚举不匹配」 |
| 事件归属口径（机检）：`who.type=agent` 事件 928 条中 924 条 `who.id` 为 preset_key（其余 4 条为套件探针夹具 `agt-*-stmumspbkm`），与 `deriveFloor` 的 asking/blocked/lastAction 口径一致 | 机检（B 级） | 未发现「归属错配」；夹具命名会出现在楼层气泡（测试噪声，非产品路径） |

## 5. 探针（可复跑脚本）与结果

| 脚本 | 结果 | 证据 |
|---|---|---|
| `assertions/m3-linkage-thread.mjs`（派遣→批准→各面快照） | 9/11（2 项断点：自动续跑、楼层 asking 压制） | `evidence/m3-thread-1790696247065.json` |
| `assertions/m3-linkage-kb.mjs`（待审→生效→检索→C 端→事后驳回） | 16/17（1 项断点：幽灵审批/驳回不回滚） | `evidence/m3-kb-1790695144646.json` |
| `assertions/m3-linkage-ticket.mjs`（C 端工单→B 端处置→回看） | 15/17（2 项：重复派单 500、统一待办未覆盖工单） | `evidence/m3-ticket-1790695253479.json` |
| `assertions/m3-linkage-ask.mjs`（5 类问答事实面覆盖） | 4/6（2 项：审批/线程事实未进答案、来源口径不实） | `evidence/m3-ask-1790695521766.json` |
| `assertions/m3-linkage-reject.mjs`（驳回→终态→时间线→结算） | 6/7（1 项：手势事件不进线程时间线） | `evidence/m3-reject-1790696508787.json` |

复跑命令（服务端 `:8899` 以出厂 `.env` 起）：

```bash
cd /Users/mac/WorkLoom-fleet/.wt-mcd-im
for s in thread kb ticket ask reject; do
  MCD_BASE=http://127.0.0.1:8899 node outputs/mine-clear/T-2026-0929-0200/assertions/m3-linkage-$s.mjs
done
```

自证与偏差说明：
- 探针 1 首轮的第 3 条失败为**断言口径写错**（把审批留痕断言成 `task.step` 动作名）；已改为校验事件 `basis` 含「经审批 <审批号>」，复跑通过（9/11）。首轮证据 `m3-thread-1790694619945.json` 保留备查。
- 探针 3 第 2 条失败（统一待办未纳入工单）与探针 4 的 2 条失败已分别落为 MC-113 / MC-111，非脚本缺陷。
- 执行期间共享环境 `:8899` 服务端进程曾退出（非本探针导致），已用出厂 `.env` 原口径重启（`node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts`），环境档位仍为 `local-preview`。

## 收尾报告

- 已完成：联动图（5 条链路，标代码位置）；5 个真机探针脚本（可复跑）与 5 份证据 JSON；6 张问题卡上账（MC-110/111/112/113/114 新建 + MC-101/MC-104 增补跨面证据）；健康面 10 项对照；台账 `status` 显示 14 张卡、门禁仅因 MC-108（P0，非本阶段）判红。
- 未完成/未覆盖：真实 LLM 路径与真实 IM/微信通道的联动（环境为 mock）；桌面壳与行业仓（hotel/fox 等）联动；`/c/chat` 工单草稿确认链路（`confirmTicket`）与语音/视听层联动未测；三端真实浏览器 UI 走查（仅查 API/DB 面，未截图）。
- 自主追加事项及理由：①把 MC-101/MC-104 两张既有卡做了跨面证据增补（避免重复上账、补上移动/IM 入口与逐面快照）；②重启了退出的共享服务端（探针需要真机，环境档位与配置未变）；③把「P22 只对 created 显示分派」「expireSweep 无 session_id」等观察写进报告供修复参考（未单独开卡，避免与 MC-112/MC-104 重复）。
- 采用的假设：①以 ws-yunqi（hotel 演示工作区）作为主联动场景、ws-aipm-demo 作为 C 端网关默认工作区（`SERVICE_C_WORKSPACE_ID` 出厂值）；②「审批通过应自动续跑」以 MCD 模板「依赖客户端见证才生效」为准绳判定为断点（基座注释亦自述存在「审批自动续跑」路径）；③统一待办的口径取其代码注释与 P28 文案（审批/告警/工单）。
- 置信度：**高**——六项断点均有真机响应原文 + 事实源直查 + 代码行号三方互证；扣分项为前端未做浏览器实拍（API/DB 面已取证）与 mock 态限制。
- 建议复核（最值得亲自看的三处）：①`m3-ask-1790695521766.json` 的 5 条答案原文（助手答非所问最直观）；②`m3-kb-1790695144646.json` 里「审批 pending 而文档已 active」与驳回后仍可检索；③`m3-thread-1790696247065.json` 中批准后 20s 各面快照（待办清零 vs 线程挂起）。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（M3 模板 3 项任务：联动图 / 逐面断点真机取证 / 问答入口数据源覆盖——均完成；联动通过的面也已列出）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？（全程自主推进，仅重启环境属必要恢复动作）
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？（断点均 A 级：真机 + 代码行号；枚举覆盖为 B 级并已标注）
- [是] 经得起资深工程师逐行审查？（脚本、证据 JSON、台账卡、本报告均可复跑复读；断言口径偏差已自曝并修正）
