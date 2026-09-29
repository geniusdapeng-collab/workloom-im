# M2 动态排雷 · 中间发现（实时更新）

基线：`4ff9943f0e5b331619a67db06af32ec09e9d8616`（.wt-mcd-a，detached）
环境：本地预览（LLM_PROVIDER=mock、IM_DRIVER=mock、simulated 档）· server 8901 · DB wl_mcd_a
档位声明：**本机预览结构验收**（不得写成生产实测）

> 本文件为过程笔记（保留现场与推理链）。**最终交付以 `SUMMARY.md` 为准**；
> 卡片编号已从过程稿 MC-201..207 调整为 MC-301..306（避开 M1 的 MC-1xx 与交付面的 MC-2xx），
> 其中「审批通过后无服务端续跑」并入既有卡 MC-101（不重复上账）。

## 已运行断言脚本（终态）

| 脚本 | 判定断言 | 结果 | 证据 |
|---|---|---|---|
| `m2-01-main-loop.mjs` | 21 | 20 绿 / 1 红（审批后无自动续跑 → MC-101） | `m2-01-main-loop.json` |
| `m2-02-concurrency.mjs` | 13 | 11 绿 / 2 红（MC-301 并发穿透、MC-302 调度器饥饿） | `m2-02-concurrency.json` |
| `m2-03-fault-injection.mjs` | 17 | 17 绿 | `m2-03-fault-injection.json` |
| `m2-04-boundaries.mjs` | 21 | 21 绿 | `m2-04-boundaries.json` |
| `m2-05-state-machine.mjs` | 16 | 12 绿 / 4 红（MC-303 双入口计划不一致、MC-304 假交付、MC-305 无回执重跑、MC-306 缺价带） | `m2-05-state-machine.json` |
| `m2-06-im-callback.mjs` | 8 | 7 绿 / 1 红（IM 批准后不续跑 → MC-101） | `m2-06-im-callback.json` |
| `m2-02-starvation-observe.log` | — | 15 queued / 35s 零推进（调度器饥饿现场） | 同左 |

合计：判定断言 96（88 绿 / 8 红）· 观测记录 11

## 卡片落盘

| 卡 | 发现 | 文件 |
|---|---|---|
| MC-301 | 并发派遣穿透 L3.1 上限 | `cards/M2-MC-301.json` |
| MC-302 | 调度器饥饿（queued ≥10 永久停摆） | `cards/M2-MC-302.json` |
| MC-303 | dispatch(runImmediately)/threads.run 绕过行业规划器 | `cards/M2-MC-303.json` |
| MC-304 | 语义路由缺口 → 无关岗位「完成」 | `cards/M2-MC-304.json` |
| MC-305 | 无回执重跑即 completed（E3.7 绕过） | `cards/M2-MC-305.json` |
| MC-306 | 出厂档案缺 price_bands → R1/R2 不可达 | `cards/M2-MC-306.json` |
| （并入）MC-101 | 审批后无服务端续跑：补 UI/API 与 IM 两条通道实证 | 证据并入本节脚本 JSON |

## 疑似问题（待成卡）

### F1 并发派遣穿透 L3.1 上限（TOCTOU）
- 现场：pre-existing 0，15 路并发 dispatch **全部 200**（应为 10 通过 / 5 个 429）；随后单发探针能正确返回 429（守卫本身工作，只是非原子）。
- 代码位：`apps/server/src/trpc/router.ts:1110-1122`（count 与 INSERT 分属不同语句、无锁/无唯一约束兜底）。
- 影响：工作区实际排队数可超过上限 → 触发 F2。

### F2 调度器饥饿：queued ≥ 上限即整体停摆（没有出口的状态）
- 现场：15 queued / 0 fresh running，35 秒（5 个调度周期）**零推进**，`max(updated_at)` 冻结在 23:11:39。
- 代码位：`apps/server/src/runtime/scheduler.ts:66-90`（并发守卫把 `queued` 计入统计，`>= MAX` 直接 `return undefined`；而 queued 只能靠调度器本身消化 → 自锁）。**恰好 10 条 queued 也会死**。
- 影响：工作区任务永久不执行；只能靠用户逐条点「执行或从中断处继续」解锁（已实测 15 条全部靠人工 `threads.run` 排空）。

### F3 dispatch(runImmediately) 路径绕过行业规划器
- A/B 实测（同一目标「把雅致大床房调价到 510 元」）：
  - `runImmediately:true`（P1「启航」/CommandCard 主路径）→ 通用规划器：3 步空参（s1 `pms.price.read` params={} / s2 `competitor.fetch` / s3 `pms.price.write` params={}，action=工具名）→ 围栏 `rule_impact=[]`，退化为 default review。
  - `runImmediately:false`（调度器路径，T-125）→ 行业规划器：2 步（s2 `action=price.adjust`、`tool=pms.price.write`、`params.price=510`）→ 命中 R1/R2 求值异常 → W-01 降级人审（`params_incomplete`）。
- 代码位：`apps/server/src/trpc/router.ts:1184-1190`（dispatch 直呼 `runQuest`，未传 `fallbackPlanner`）；对比 `apps/server/src/runtime/thread-runner.ts:245-260`（`runQuestForThread` 注入行业规划器）。
- 影响：主入口交付的计划与目标脱节、围栏词表不匹配（调价永远挂起；差评/送物/巡检等退化为通用工具序列）。

### F4 语义路由缺口 → 无关岗位 + 假交付 completed（L4）
- 现场（两条路径都复现）：「处理一条差评并回复」→ 岗位 `competitor-agent`、计划 1 步 `competitor.crawl`、**状态 completed + receipt.synced=true**；全过程没有 `review.reply`。
- 代码位：`apps/server/src/runtime/thread-runner.ts:107-113`（候选全未命中 → `if (ready.length > 0) return ready[0]`，即按 preset_key 字母序取第一个就绪岗位）；路由表 `apps/server/src/runtime/dispatch-routing.ts:39-83` 无「评价/口碑/客服/差评」域。
- 影响：用户目标与交付物无关，却被标为已完成（INV-5 语义面）。

### F5 审批通过后无服务端续跑出口
- 现场：manager 采纳后 21s（3 个调度周期）线程仍 `pending_review`、progress 2/3、该步骤无回执事件；`threads.run` 一调即 completed（含 `经审批 apr-… 批准执行` 留痕）。
- 代码位：`packages/base/review-console/approvals.ts:240-300`（decide 只改审批行）；`apps/server/src/runtime/scheduler.ts:84`（只扫 queued）；`packages/base/captain/loop.ts:196-215`（CEO 节拍同样只改审批行）；`apps/server/src/trpc/router.ts:2750`（IM 手势回调同路径）。
- 影响：从 IM 卡片/CEO 节拍/无人值守路径通过的审批，线程永久停在 pending_review（只有 UI 手动「推进」能解开）。

## 正负对照（实测通过项，详见各脚本 JSON）
- 主链路：dispatch→围栏→pending_review→审批→续跑→回执→completed 全绿（`m2-01`）。
- readonly 审批 403 且不落库；非法手势/空理由驳回被拒（`m2-01`）。
- 8 路并发 decide 恰一生效、其余幂等、仅一条手势事件（`m2-02` A1–A4）。
- 并发写库后哈希链六项检查全绿（`verify-chain` 退出码 0，148 条事件 / 2 个 workspace 段）。
- E3.7 属性断言：全工作区 completed 线程的执行事件 `receipt.synced` 全为 true（无违规样本）。
