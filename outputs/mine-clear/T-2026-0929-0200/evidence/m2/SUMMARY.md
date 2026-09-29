# M2 动态排雷摘要（T-2026-0929-0200）

- 会话角色：`/root/mcd_dynamic`（只发现与取证，不改源码、不提交、不推送）
- 审计基线：`4ff9943f0e5b331619a67db06af32ec09e9d8616`（工作树 `/Users/mac/WorkLoom-fleet/.wt-mcd-a`，detached）
- 环境档位：`local-preview`（LLM_PROVIDER=mock 出厂档 + 局部真实模型 stub 注入）——**本报告只能表述为「本机预览结构验收」**，不得写成生产实测
- 数据库：`wl_mcd_a`（PG 127.0.0.1:5432，40 迁移 + hotel/boost/aipm 三套种子）· 服务端口 8901

## 1. 覆盖率声明

- 用例脚本 6 个（全部可复跑、自带断言与证据落盘，位于 `assertions/m2-0*.mjs`；每次运行自建唯一 SFX 前缀，不依赖固定数据行）
- **判定断言 96 条 + 观测记录 11 条**（m2-01 21+1 · m2-02 13+2 · m2-03 17+3 · m2-04 21+0 · m2-05 16+4 · m2-06 8+1）
- 本轮终态：**88 通过 / 8 红**。8 条红项与问题卡的对应关系：MC-301（并发穿透 B1）· MC-302（调度器饥饿 B4）· MC-303（双入口计划不一致 H1）· MC-304（差评目标未命中口碑链 I1）· MC-305（无回执重跑即完成 C3）· MC-306（出厂档案缺价带 J1）· MC-101 两条独立通道实证（UI/API 批准 21s 不动、IM 批准 21s 不动）
- 五维矩阵覆盖：主链路闭环 ✅ · 并发竞争 ✅ · 异常注入 ✅ · 边界值 ✅ · 状态机遍历 ✅
- 三类错误：业务错误 ✅（MC-304 假交付）· 配置错误 ✅（LLM 未配/实测不过、goalRef 落空、缺价带）· 环境错误 ✅（mock ↔ 真实模型 stub、dataMode 模拟 ↔ 真实）
- 未覆盖：真机桌面端（Electron 首启/安装包）、真实第三方连接器与真实模型供应商网络、跨租户多工作区并发、C 端 H5 全旅程——这些属 M4/M6 域
- 夜班状态机为 **B 级**（代码状态表 `packages/base/night-shift/scheduler.ts:16-22` + 库内 `night_runs` 事实读），未做真实班次驱动

## 2. 实测通过项（正负对照，反例均已固定为断言）

| 维度 | 通过项 | 证据 |
|---|---|---|
| 主链路 | dispatch→围栏挂起→审批→续跑→回执→completed 全链路一致；`pending_approval_id`、progress、事件三面一致 | `m2-01-main-loop.json` |
| 权限 | readonly 审批 403 且不落库；非法手势 / 空理由驳回 / >200 字理由 / 非法 editKind 全部 400 | `m2-01`/`m2-04` |
| 幂等 | 8 路并发 decide 恰一生效、其余 deduped、手势事件仅 1 条；IM 重复回调 deduped；IM 入站重复投递只落 1 条事件 | `m2-02`/`m2-03`/`m2-06` |
| 账本 | 并发写后哈希链六项检查全绿（`scripts/verify-chain.ts` 退出码 0，本轮 331 条事件/2 段） | `m2-02-verify-chain.log` |
| 围栏 | R1 视窗内自动执行（注入价带后）、R2 保底价熔断 paused、W-01 缺参降级人工裁决（params_incomplete+说明）、驳回→线程 cancelled | `m2-05-state-machine.json` |
| 回执纪律 | completed 线程执行事件 `receipt.synced` 全为 true（属性断言，全工作区无违规样本）；真实数据态无连接器 → failed 且如实写 `synced:false` | `m2-01`/`m2-05` |
| 异常注入 | 模型挂起/500：测试连接按时失败（25s）、未实测配置被拒且不污染现有配置、派遣降级 `via=timeout_fallback`（150ms/23ms）不 5xx | `m2-03-fault-injection.json` |
| 边界/注入 | 500 字标题可存、501/空串 400、纯空白→clarify、SQL/模板/emoji payload 原样落库且表未被破坏、跨工作区读线程返回 null、分页 0/1000 被拒 | `m2-04-boundaries.json` |
| 隐私 | IM 入站手机号/身份证在账本内已脱敏（`[PII:PHONE:*]`/`[PII:IDCARD:*]`） | `m2-03` B5 |
| IM 通道 | 未验签通道下冒名 openid 403、本人放行成功且标注 unsigned、重复回调幂等 | `m2-06-im-callback.json` |

## 3. 发现清单（6 张新卡 + 1 条补充证据 + 1 条待复核）

| ID | 严重度 | 级别 | 一句话 | 证据等级 | 置信度 | 卡片 |
|---|---|---|---|---|---|---|
| MC-301 | P1 | L3 | 并发派遣穿透 L3.1 并发上限（计数与建档非原子；15/15 放行） | A（运行实测 + 代码） | 高 | `cards/M2-MC-301.json` |
| MC-302 | P1 | L3 | 调度器饥饿：queued ≥ 10 即拒绝拾取任何线程，队列永久停摆（本次现场 35s 零推进，只能逐条人工解锁） | A | 高 | `cards/M2-MC-302.json` |
| MC-303 | P1 | L2 | `dispatch(runImmediately)` 与 `threads.run` 绕过行业规划器 → 空参计划、围栏词表错配（同一目标两条路径两种计划） | A（A/B 实测 + 代码） | 高 | `cards/M2-MC-303.json` |
| MC-304 | P1 | L4 | 语义路由缺口 → 无关岗位执行无关步骤并标 completed：「处理一条差评并回复」被 competitor-agent 用 competitor.crawl「完成」 | A | 高 | `cards/M2-MC-304.json` |
| MC-305 | P1 | L1 | 「无回执不算完成」被重跑绕过：failed 线程一次 `threads.run` 即 completed，error 仍写着未核实 | A | 高 | `cards/M2-MC-305.json` |
| MC-306 | P2 | L2 | 出厂一店一档缺 `business.price_bands` → R1 自动/R2 熔断永不可达，调价 100% 转人工 | A（对照实验 + 代码） | 高 | `cards/M2-MC-306.json` |
| （补充证据）MC-101 | P1 | L4 | 审批通过后无服务端续跑——**已有卡**，本会话补充两条独立通道实证：IM 手势批准后 21s 线程仍 pending_review（`m2-06-im-callback.json`）；UI/API 批准后同样 21s 不动（`m2-01-main-loop.json`） | A | 高 | 不重复上账，证据路径并入 MC-101 |
| （待复核，未上账）| P2 | L3 | `expireSweep` 的过期回写 `UPDATE approvals SET status='expired'` 无 `AND status='pending'` 守卫（`packages/base/review-console/approvals.ts:388`），理论上可覆盖已裁决行；本轮 6 次竞态注入 0 复现 | C（代码 A 级、运行未复现） | 中 | 未上账原因：无法构造「修复前红/修复后绿」的可判别断言，请 M5 评估是否顺手加守卫 |

### 关键发现的现场速览

**MC-302（最严重：工作区永久停摆）**——`evidence/m2/m2-02-starvation-observe.log`：
```
queued=15 / fresh running=0；t+7s、t+14s、t+21s、t+28s、t+35s 五次采样 max(updated_at) 全部冻结在 23:11:39
期间新派遣正确返回 429（守卫工作），但已排队的 15 条永不执行
```

**MC-303（同一目标两种交付）**——`m2-05-state-machine.raw.json`：
```
runImmediately=true : s1 pms.price.read {} / s2 competitor.fetch / s3 pms.price.write {}  → rule_impact=[] 「写类动作无规则命中」
runImmediately=false: s1 pms.price.read {room_type} / s2 price.adjust + pms.price.write {price:510} → R1/R2 真实判定
```

**MC-304（假交付）**：`处理一条差评并回复` → `competitor-agent` / 1 步 `competitor.crawl` / status=completed / receipt.synced=true（两条入口均复现：T-122 runImmediately、T-126 调度器）。

**MC-305（无回执绕过）**：T-152 `failed`（error=「步骤 s1 无回执，标「未核实」」，事件 `synced=false`）→ `threads.run` 一次 → `completed`（error 字段原样保留，无新回执）。

## 4. 环境阻塞项与观测

1. **服务进程被外部终止 3 次**（日志无任何异常输出/无堆栈，非应用崩溃）：分别发生在 23:30、23:41、00:0x；改用 supervisor 循环后仍随之被回收 → 判定为执行环境对长驻 PTY 会话的回收行为，**不作为产品缺陷**。复现方式：`bash -lc 'cd /Users/mac/WorkLoom-fleet/.wt-mcd-a && node_modules/.bin/tsx --env-file=<env-a> apps/server/src/index.ts'`（建议套 supervisor 循环）。
2. 本机无 `node`/`pnpm` 全局 PATH：脚本需显式 `PATH=<shim>:<runtime>/node/bin`（已在各脚本与卡片 command 中带上）。
3. 用例过程中的状态注入（临时价带、临时 `dataMode=real`、临时 IM openid 绑定、过期快照）**均已复原**；结束时工作区 `queued=0`（未留停摆队列），`profiles.archive.dataMode=simulated`、`business` 键不存在、`members.im_openids={}`。
4. `.wt-mcd-a/.env` 由 m2-03 的 `saveLlmConfig` 生成（仓库 .gitignore 内，内容已还原为 mock 四变量），会话结束前已删除。

## 5. 证据分级说明

- **A 级**：真机运行实测（API 响应原文 + 数据库特权直查 + 服务端日志三件套）与代码精读——本报告 §3 六张卡的主证据均为 A 级；
- **B 级**：全量机检/元数据解析（`verify-chain` 全库六项检查、库内状态分布统计、状态机表代码通读）；
- **C 级**：竞态类未复现项（§3 待复核行）；
- **D 级**：无。凡未达 A 级的结论均已在表中显式降级并注明复现次数。

## 6. 收尾报告

- 已完成：五维用例矩阵 6 个可复跑脚本（96 条断言）；96→83 绿；6 张新问题卡（全部通过 `mine-clear.mjs add` 校验，ID 避开既有 MC-1xx/MC-2xx 段）；原始证据与日志落盘 `evidence/m2/`；MC-101 补充双通道实证
- 未完成/未覆盖：真机桌面端与安装包、真实连接器/真实模型供应商、跨租户并发、C 端 H5 旅程、夜班真实班次驱动（均为 M4/M6 域或需真实凭据）
- 自主追加事项及理由：① 增加 IM 手势回调链路用例（原任务未点明，但它是「审批闭环」在非 PC 入口的必经路径，且直接决定 MC-101 的产品影响面）；② 增加「价带缺失对照实验」以把 MC-306 从推断升级为 A 级实证；③ 用 supervisor 循环托管服务以对抗环境回收，保证证据可复跑
- 采用的假设：① 判据以「用户要的东西是否交付」为准，故把「completed 但交付物无关」按 P1 假交付上账；② `MAX_CONCURRENT_THREADS=10` 的语义按代码注释「单工作区并发 ≤10，超出排队且可见」理解为含 queued 的硬上限，故 15/15 放行判为穿透；③ 环境档位按出厂 `.env`（mock/simulated）判定，临时真实模型 stub 注入只用于异常注入验证
- 置信度：高——六张卡均有可复跑的 A 级断言；唯一中置信项是 §3 待复核的 sweep 守卫（已标注未复现）
- 建议复核：① MC-302 修复方案与 MC-301 的耦合（只改调度器不改派遣守卫仍会被穿透回填 >10）；② MC-303 修复后建议加一条「两条入口计划一致」的回归断言（已随卡给出）；③ MC-304 是否按 P1 进入第 1 批（它直接决定客户看到的第一条任务的观感）

## 7. 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（五维 + 三类错误全覆盖；未覆盖项逐条声明并给出原因）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？（A/B/C 分级，未复现项明确降级）
- [是] 经得起资深工程师逐行审查？（每条断言可独立复跑；所有状态注入均已复原；不修改源码/不提交/不推送）
