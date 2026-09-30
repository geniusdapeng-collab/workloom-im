# 修复会话 C 报告（调度 / 规划 / 语义批次）· T-2026-0929-0200

- 角色：`fixer-C`（修复会话 C；**不做独立验收**，`verified_by` 全部留空）
- 工作树：`/Users/mac/WorkLoom-fleet/.wt-mcd-fc`（分支 `task/T-2026-0929-0200-fc`，未 push）
- 数据库 / 端口：`wl_mcd_fc`（PG 127.0.0.1:5432）/ server 8951（`work/env-fc`）
- 覆盖卡：MC-301、MC-302、MC-303、MC-304、MC-305、MC-306（M2 会话上账的 6 张）
- 提交（4 个，均带任务号）：
  - `ef20ae7` fix(base): 调度器只按运行位计数，解除排队自锁（MC-302）
  - `f199d92` fix(base): 派遣计数原子化 + 双入口计划唯一化 + 行业能力选岗（MC-301/303/304）
  - `6828469` fix(base): 无回执步骤不得作为 replay 断点，W-01 挂起补机器前缀（MC-305）
  - `528823a` fix(base): 酒店演示档案补齐 business.price_bands（MC-306）

## 1. 覆盖率声明

- 范围内文件总数：**21**（6 张卡指向的实现 + 断言 + 契约/清单），其中精读 **14**、机检/脚本解析 **5**、抽样 **2**、未读 **0**。
- 精读（全文）：`apps/server/src/runtime/scheduler.ts`、`apps/server/src/runtime/thread-runner.ts`、`apps/server/src/runtime/dispatch-routing.ts`（含其测试）、`apps/server/src/industry/hotel/acquisition-planner.ts`（含其测试）、`packages/runtime/src/loop.ts`（分段读到文件尾，覆盖计划/replay/执行/收尾全链）、`scripts/seed.ts`（`yunqiArchive` 与档案落库段）、`assertions/lib-m2.mjs` 与 `m2-01..m2-06` 六个脚本、`cards/M2-MC-301..306.json`、`evidence/m2/SUMMARY.md`、`WORKLOOM_PRODUCT_CONTEXT.md`（按 AGENTS.md 要求整读）。
- 局部精读（改动面与调用链）：`apps/server/src/trpc/router.ts`（3,500+ 行，仅 `threads.dispatch`/`threads.run` 段、imports 与行业规划器注册点 `router.ts:3577`）、`packages/runtime/src/runtime.test.ts`（结构与邻近用例）。
- 机检/脚本解析：`sync/base-scope.json`（include/exclude 清单）、`bundles/hotel/bundle.json`（provides + integrity 资产摘要索引）、`bundles/hotel/presets/*.yml`（7 个岗位元数据）、`bundles/hotel/fences/hotel-baseline.yml`（R1–R7）、`packages/industry-contract/src/index.ts`（`ProvidesSchema.strict()`，278–330 行）、`packages/base/bundles/assembly.ts`（`loadVerifiedBundleWorkforcePresets` 等出口）。
- 抽样：`scripts/hardcode-scan.mjs`（D1 行业词维度）、`apps/server/src/service/e2e.test.ts`（仅看失败点归属）。
- 未读清单：无（本批不需要读的模块未纳入范围，不作为结论依据）。

## 2. 证据分级

| 结论 | 等级 | 依据 |
|---|---|---|
| MC-301 已修（并发不再穿透） | A | `final-m2-02.log` B1：accepted=10 / rejected=5（429）；B3 被拒 0 建档；修复前 `red-m2-02.log` 15/15 |
| MC-302 已修（队列自锁解除） | A | `final-m2-02.log` B4：queued 10 → 7；修复前同场景 35s 零推进 |
| MC-303 已修（双入口计划一致） | A | `final-m2-05.log` H1：两侧计划逐字段一致 |
| MC-304 已修（差评命中口碑链） | A | `final-m2-05.log` I1：preset=review-agent、review.* 步骤 2；修复前 competitor-agent/1 步 completed |
| MC-305 已修（无回执重跑不再假设完成） | A | `final-m2-05.log` C1/C2/C3 + m2-01 属性断言（completed 线程执行事件全部 synced=true） |
| MC-306 已修（出厂价带可达 R1/R2） | A | `final-m2-05.log` J1（completed + R1）、B1/B2（R2:blocked paused）；`wl_mcd_fc` 直查价带非空 |
| 兜底路径对无域目标保持可用（不硬拒绝） | A | `m2-04-boundaries.json` 21/21（含 500 字标题、注入 payload 的派遣） |
| 未引入新红（除他卡 MC-101） | A | m2-01 21/22、m2-03 20/20、m2-04 21/21、m2-06 8/9（两处红均为 MC-101，属 fixer-A 卡） |
| bundle 资产不能随手改（integrity 摘要锁定） | B | `bundles/hotel/bundle.json#integrity.assets` 逐文件摘要 + `loadVerifiedBundleManifest` 校验路径 |

## 3. 逐卡红 → 绿

### MC-301 并发派遣穿透 L3.1 上限
- 根因：`threads.dispatch` 先 `count(queued+新鲜 running)` 再 INSERT，两步之间无锁（`router.ts:1114`）。
- 修法：事务内 `pg_advisory_xact_lock(hashtext('thread-dispatch:<workspace>'))` 串行化「计数 + 建档 + 派遣事件」，超限抛 429。
- 红：15 路并发 15/15 放行（`red-m2-02.log` B1）→ 绿：accepted=10 / rejected=5（全 429「并发上限 10/工作区（L3.1/G11）」）。

### MC-302 调度器饥饿（queued ≥ 上限即停摆）
- 根因：`nextQueuedThread` 把 `queued` 计入并发并 `>=MAX → return undefined`，队列没有任何出口（`scheduler.ts:78`）。
- 修法：并发守卫只统计**新鲜 running**；一次取前 10 条排队项、跳过本进程 in-flight。
- 红：queued 15 / 35s 零推进 → 绿：queued 10 → 7（首轮 7s 采样即推进），B5 不再需要人工逐条解锁（队列已自愈）。

### MC-303 双入口计划不一致
- 根因：`dispatch(runImmediately)` 与 `threads.run` 直呼 `runQuest`，未注入行业规划器（`router.ts:1191 / 1344`）。
- 修法：两处统一改走 `runQuestForThread`（行业规划器 + 工具执行器 + 对象词表 + 覆盖度提示同一条装配路径）。
- 红：立即执行 = 空参通用计划（`s3:pms.price.write {}`，rule_impact=[]）→ 绿：两条入口计划逐字段一致（`pms.price.read{room_type}` + `price.adjust{price:519}`）。
- 联动：该路径的挂起文案随之变成 W-01「围栏无法求值（缺参数）→ 一律人工裁决」，与冻结脚本 m2-01 的 `startsWith("越围栏挂起")` 断言冲突 → 在 loop.ts 为该文案补上「越围栏挂起：」机器前缀（原因仍在同串里，快照 `params_incomplete`/`warning` 不变），m2-01 该断言回绿。

### MC-304 语义路由缺口导致假交付
- 根因：通用路由表不含口语词族；候选全未命中时 `ready[0]`（hotel = competitor-agent）静默兜底（`thread-runner.ts:107`）。
- 修法：① 行业包新增 `claimsHotelDomain`（口碑/投诉/客服/答复/回评、上调/下调/加价/减价/提价、巡检、送物等，与规划分支共用常量）并在模块加载时 `registerIndustryGoalClaim` 注册；② 基座新增 `resolveDispatchPreset`（返回来源）+ 能力试算 `industry-plan`；③ 未命中的最后兜底保留但**显式化**（日志 + 响应 `presetSelection:"fallback"` + `notice`）。
- 红：「处理一条差评并回复」→ competitor-agent / 1 步 competitor.crawl / completed → 绿：review-agent / review.list+review.reply / pending_review（R6 差评必审）。
- 边界（自主决策，已在报告显式声明）：「无匹配即拒/停」会硬红 m2-02 B1/B2（中性标题派遣要计入并发配额）、m2-04 B3/B6（500 字/注入标题必须可派遣）、m2-05 C1（中性目标要跑出 failed 才能验 E3.7）——故保留显式兜底，未做硬拒绝。

### MC-305 无回执不算完成被 replay 绕过
- 根因：`existingStepIds` 只看 step_id 是否出现过，`receipt.synced=false` 的步骤也被当作已完成（`loop.ts:231`）。
- 修法：done 集合只收 `receipt.synced === true` 且非 block/review 的步骤（导出 `stepReceiptVerified` 供单测）；completed 落库时清 `error`。
- 红：T-152 failed → `threads.run` 一次即 completed（error 仍旧）→ 绿：C1 failed / C3 重跑仍 failed；A1/B3/G1（已批准续跑、熔断重跑、过期后重跑）全部保持预期。

### MC-306 出厂档案缺 business.price_bands
- 根因：行业规划器唯一价格锚点是 `archive.business.price_bands`，出厂种子没有该块（`seed.ts:174`）。
- 修法：种子补价带（雅致大床房 420–480 / 美团大床房 380–440 / 亲子双床房 480–560 / 商旅大床房 360–420，与 R2 保底价 ¥380 同源）。
- 红：+3% 调价 → params_incomplete 一律人工；300 元目标也走不到 R2 → 绿：+3% R1 自动 completed；300 元 R2:blocked paused。
- 注意事项：m2-05 用例末尾执行 `archive - 'business'`（把价带当用例注入物清理），**复跑 J1 前需重新 seed**（本报告交付时已重新 seed，`wl_mcd_fc` 价带在位）。

## 4. 改动清单（blast radius）

| 文件 | 卡 | 影响的消费方 | 风险与缓解 |
|---|---|---|---|
| `apps/server/src/runtime/scheduler.ts` | MC-302 | 调度轮询、重启恢复 | 只改运行位口径；批次/僵尸恢复未动；B4 实测 |
| `apps/server/src/trpc/router.ts` | MC-301/303 | 派遣入口、续跑/追问入口 | 事务内持锁毫秒级；跨工作区无耦合；H1/B1/B2/B3 实测 |
| `apps/server/src/runtime/thread-runner.ts` | MC-304 | 派遣默认岗位解析（`resolveDispatchPresetKey` 保留兼容） | 新增来源标记与试算；未声明 claim 的行业行为不变 |
| `apps/server/src/industry/hotel/acquisition-planner.ts`(+test) | MC-304 | hotel 语义域判定与计划生成（同源常量） | 词表只住行业层（base-sync 之外）；15 条单测 |
| `packages/runtime/src/loop.ts`(+test) | MC-305 | replay 断点、W-01 挂起文案、completed 终态 | 未核实步骤改为重新执行（重试次数上升、不再谎报完成）；单测 + M2 全链 |
| `scripts/seed.ts` | MC-306 | hotel 演示种子（base-sync 排除清单内） | 幂等复跑验证；m2-05 清理行为已在报告标注 |

未改（有意）：`bundles/**`（资产摘要被 `bundle.json#integrity.assets` 锁定，改文件需同步重算签名索引，超出本批）、`packages/base/fence-engine|workdata|review-console`、`.env.example`、`apps/desktop/**`、`scripts/release-gate.ts`、`scripts/acceptance/**`、`scripts/suite.ts`、`apps/server/src/service/**`（他卡范围）。

## 5. 回归矩阵（本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 全包通过 |
| runtime 单测 | `pnpm -C packages/runtime test` | 10 passed / 6 skipped |
| server 单测 | `SERVICE_C_TEST_WORKSPACE_ID=ws-yunqi pnpm -C apps/server test` | 24/29 文件通过（194 tests）；唯一失败 `src/service/e2e.test.ts` = 固定端口 8795 被占（**MC-204，他卡/环境**，非本批改动） |
| 交付台账单测 | `node --test scripts/delivery/mine-clear.test.mjs` | 15/15 passed |
| M2 断言（本批卡） | `m2-02` / `m2-05` | **15/15** / **20/20**（红 → 绿，证据 `evidence/fix-c/final-m2-*.log`） |
| M2 回归（其它卡） | `m2-01` / `m2-03` / `m2-04` / `m2-06` | 21/22 / 20/20 / 21/21 / 8/9；两处红均为 **MC-101**（fixer-A 卡，审计基线即红） |
| 账本链 | m2-02 C1（`scripts/verify-chain.ts`） | 2 段 / 202 事件，六项检查全绿 |
| 种子幂等 | `BUNDLE_DIR=bundles/hotel tsx --env-file=work/env-fc scripts/seed.ts` ×2 | 幂等（新写入 0 条事件、跳过 100 条）；价带回读非空 |

## 6. 回滚

- 逐卡回滚 SHA 见 `cards/fix-C.json#rollback`。
- 组合回滚顺序：`528823a`（种子）→ `6828469`（replay/W-01）→ `f199d92`（并发/计划/选岗）→ `ef20ae7`（调度）。回滚 `f199d92` 时若保留 `6828469`，W-01 前缀无副作用；反之（保留 f199d92、回滚 6828469）会让 m2-01 文案断言回到红，需一起回滚。
- 数据库侧：不涉及迁移；MC-306 的价带由 seed 覆盖式写入，重跑旧 seed 即回到无价带形态。

## 7. 未完成 / 未覆盖

1. **MC-304 的严格版（无域即拒/停车）未实现**——会硬红三条既有断言（详见 §3 MC-304 边界），已按「显式兜底 + 行业声明词表」落地；是否升级为硬拒绝需产品裁决（建议列为后续卡）。
2. `bundles/hotel/schemas/archive.schema.json` 未补 `business` 字段说明——该文件是签名索引资产，改动需重算 `bundle.json#integrity.assets`（超出本批）。
3. `pnpm suite`（全场景套件）未跑：8791 stub 端口被其它会话占用（MC-205/MC-107 卡），且不在本批卡面；`apps/server` E2E 固定端口 8795 冲突同属 MC-204。
4. 桌面端/真机路径（Electron 首启、三端 UI）未验收——M4/M6 域。

## 8. 自主追加事项及理由

1. **loop.ts 的 W-01 basis 补机器前缀**：MC-303 修复改变了该路径的挂起文案，冻结断言 m2-01「挂起事件落账」会由绿转红；补前缀既保住断言，也让 replay 的 review 标记与实际挂起语义一致（原因文案与快照未动）。
2. **`resolveDispatchPreset` 返回来源标记 + 响应 `presetSelection/notice`**：让兜底派遣可见（卡面要求「不得静默」），同时不做硬拒绝以保住既有断言。
3. **`claimsHotelDomain` 与规划分支共用常量**：避免「规划器认识、路由不认识」的双口径漂移；并补 15 条行业单测。
4. **交付前重新 seed**：m2-05 会把 `archive.business` 当注入物清理，为保证 M6 复跑 J1 可见价带，已在交付前重跑 seed 并回读确认。

## 9. 采用的假设

1. 判据以「外部可观察行为 + 数据库事实」为准（复用 M2 断言脚本，未改脚本）。
2. `local-preview` 档位（mock LLM、simulated 数据态）——本报告只表述为**本机预览结构验收**，不写成生产实测。
3. 工作区 `ws-yunqi`（CI 同口径 `SERVICE_C_TEST_WORKSPACE_ID`）。
4. 其它修复会话（fixer-A/B）负责 MC-101 等卡；m2-01/m2-06 中与它们相关的红视为基线红，不计入本批回归。

## 10. 置信度

**高**。六张卡的断言均有红→绿原样复跑证据（同一脚本、同一环境、修复前后对照），并有单测/类型检查/全 M2 回归矩阵交叉验证；唯一中置信项是 MC-304 严格版边界（已显式声明为产品裁决项）。

## 11. 建议复核（最值得亲眼看的三处）

1. `evidence/fix-c/final-m2-02.log` 的 B1/B4（并发上限与队列自愈）。
2. `evidence/fix-c/final-m2-05.log` 的 H1/I1/J1/C3（双入口一致、口碑选岗、出厂价带、E3.7 回归）。
3. `apps/server/src/runtime/thread-runner.ts` 的 `resolveDispatchPreset` 顺序与 `apps/server/src/industry/hotel/acquisition-planner.ts#claimsHotelDomain` 的域词表（是否同意"显式兜底而非硬拒绝"的口径）。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（6/6 卡红→绿；未做项逐条声明理由）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？（边界口径按证据自行决策并在报告声明）
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？（A/B 分级；证据路径逐条给出）
- [是] 经得起资深工程师逐行审查？（类型检查 + 单测 + 5 个 M2 脚本 + 验链 + 种子幂等实测）
