# WorkLoom 织元（基座）· 独立验收报告（RDAS v3.1 / MCD 验收轮）

> 执行：`mcd_acceptance`（**未参与任何修复**；独立检出 / 独立数据库 / 独立端口）｜时间：2026-09-30 02:46–04:05（Asia/Shanghai）
> 验收基线（冻结）：`workloom-im@b67d651`（tree `729ca613…`，detached；= `task/T-2026-0929-0200` tip，含 `330b8c5` 批 E + `bfd5fe6` 对齐云端 main + `53b6f4f`/`b67d651` 收口）
> 环境档位：**local-preview**（真实库 + 真实服务端 + 真实鉴权 + 出厂种子；LLM/IM = mock）。**不得据此宣称生产验收**。
> 专用环境：检出 `/Users/mac/WorkLoom-fleet/workloom-im-mcdacc`（含未跟踪标记 `ACCEPTANCE-CHECKOUT.md`）；库 `wl_mcd_acc`（2026-09-30 03:18 重建：migrate 42 文件 + hotel/boost/ai-pm 三种子）；端口 server 8991 / PC 5391 / B 移动 5392 / C 移动 5393。
> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（rdas/v3.1）｜检查单：`docs/acceptance/checklist.v3.json`（276 项）｜自动报告基线：`REPORT.auto-v3.md`（本文件为人工复核后的裁决版）。

**整体判定：不通过**（红线 #6「发布门禁未全绿」命中：冻结态 `pnpm suite` 469/470、`pnpm test` 2 败；另红线 #10 部分命中：U5-01 无障碍 P0 级项未达标）。
**可修复性**：两处门禁红均为**测试/夹具侧**缺陷（产品拒绝语义正确，已用绑定夹具实证 470/470）；另有 2 条 M6 遗留缺陷（M6-F1/F2）在冻结态仍存、1 项 P2 体验缺口（紧急制动未接线）、1 项无障碍缺陷。修复后按 §11 复验路径可进入 R2 复验。

---

## 1. 环境与资产指纹（缺一报告无效）

```
commit=b67d65169d33acd138bbb76da562323280877fcb   tree=729ca613fed39df7a24e5cd233a205cbaca93136
branch=detached (task/T-2026-0929-0200 tip)      worktree=workloom-im-mcdacc
database=wl_mcd_acc  migrations=42（含 0053_approval_one_time_consumption / 0054_approval_queue_covering_indexes）
env=local-preview  llmProvider=mock  imDriver=mock  dataMode=simulated
workspace=ai-pm-demo（主）/ ws-yunqi（酒店演示）   bundle=ai-pm + hotel（出厂三种子）
ports=server 8991 / pc 5391 / bMobile 5392 / cMobile 5393
node=v24.19.0   os=macOS 15.7.3 (24G419)   playwright=chromium-1243（仓内依赖）
checklist=rdas/v3.1(276)   profile=workloom.acceptance-profile/v2（临时副本仅改端口，内容与原 profile 等价）
```

**基线冻结说明（重要）**：本检出 HEAD 在 02:52–02:53 被外部会话由 `330b8c5` 移动至 `b67d651`（reflog 可查）。发现后立即改为**以 `b67d651` 为冻结基线**，**全部自动化域（matrix/ui/experience/ux/live/coverage）在 03:20 之后统一重跑**；此前跨基线的首轮产物未作为结论依据（仅保留在 `work/acc/` 供对照）。`b67d651` 同时是 `main`/`origin/main`（6c14e66/7c94732）的后代（`git merge-base --is-ancestor` 全绿）。

**夹具与污染披露**：验收自身写入的夹具（walkthrough 审批、live PROD-01 派单、回归套件用例）未清理，冻结库残留：`biz_events=4176`、`threads=102`、`approvals=980`（以套件夹具为主，前缀 `suite.*/apr-suite-*/apr-e-*` 可过滤）；`ws-yunqi` 的 `profiles.archive.business` 在回归期间被仓库自身 E2E 落地向导用例（note=「E2E 向导验收」）覆盖（即 M6-F1 现象），已用幂等种子复位（price_bands 4 档在位）。

## 2. 覆盖率声明（硬性）

检查单 276 项 · 机械覆盖（`coverage.json`）：**pass 34 / evidence-present 25 / not-run 46 / manual-missing 157 / fail 14**；T1（52 项）未完成 32 项。

人工裁决后（本报告口径，逐项依据见 §13 索引）：

| 调整 | 项 | 裁决 | 依据 |
|---|---|---|---|
| L3-01…L3-10（10 项，机械红） | **产品侧改判 pass**；执行器侧登记缺陷 R2-F8 | 受控补丁复验 14/14 agents、20/20 skills、34/34 routes（`ui-verified/ui-probe.json`），原始执行器期望「成员档案」而 UI 为「员工档案」（文案批次 5d0ee16 后未同步） |
| L5-01（机械红） | 产品侧改判 pass（测量假红）；执行器侧登记 R2-F9 | 直测：首页真实文案「待您拍板」，执行器正则（待决/待我拍板/需你拍板/待审）0 命中 → 等待循环空转 18s；真实首价值 ≤5.0s（`mcdacc-exp01-copy-check.log`） |
| L4-03（机械红） | 改判 pass（状态依赖） | 首跑时 ai-pm 工作区**无线程**（账本按线程聚合，空态文案给出下一步）；派活后复跑 EXP-03 通过（1 次点击进入决策链路） |
| L5-03 | **fail**（保留） | 对比度抽样 49 节点 / 1 违规：「单击画面快进」3.88:1 < 4.5:1（R2-F7，P3） |
| P2-06（机械红） | 改判 not-run（未验证） | 本机 mock 档位 PROD-01 未完成（派单线程停 `pending_review`），不得据此判失败或通过 |

裁剪与理由（§9.4 三要素）：

1. **真机设备矩阵 / 弱网 / 中断注入 / 读屏实测**（U5-03/U6-02/U6-03/U6-04 等）——环境不具备（无真手机、无 NVDA/VoiceOver 录制条件）；影响：U 域无障碍与跨端结论只能到 B/C 级；建议随下一轮补。
2. **真实用户研究（U0-05/U1-01/U1-03/U2-01/U7-03 等 157 项人工）**——需招募真实用户（每角色 ≥5 人）与量表；本轮以「自动可执行域 + 机检」替代；影响：U 记分卡中的成功率/满意度/认知负荷为**未验证**。
3. **P 域真实模型任务（P0–P3）**——无内置模型凭据（且为 local-preview）；影响：只能写「未验证」。**未产生任何真实模型调用与费用**（预约台账保守记 ¥29.9 估算，不代表已发生）。
4. **24h 长跑 / 红队 / CNB 自托管实际流水线 / 桌面安装包真机安装**——时间与环境不具备；影响：O5/O6/红线 #6 的 CNB 实跑维度只能给本地 CI 等价证据（B 级）。

## 3. 结果总览（L / U / O / P 四层判定）

| 层 | 判定 | 关键证据 | 主要缺口 |
|---|---|---|---|
| L 基础 | **不通过** | typecheck ✅；verify-chain ✅（2 段 138 事件；套件后 4210/3991 事件一致）；release:gate **11/11** ✅；matrix 14/14+20/20 ✅；ui 34/34 路由（补丁复验）✅ | **`pnpm suite` 469/470、`pnpm test` 2 败（测试/夹具侧，R2-F1）→ 红线 #6** |
| U 体验 | **条件通过** | ux **38/39**；experience 7/10（裁决后 9/10）；术语 0 缺陷；静置打扰 0；C 端首响 0.6s | U5-01 `/memory` select 无访问名（axe critical，R2-F5）；EXP-04 紧急制动不可执行（R2-F6）；真实用户研究未做 |
| O 交付 | **未验证**（结构合规） | outcome `configured=false`（任务套件未配置，已生成模板）；autonomy 交付件 0 → ADR/HIR n/a | 无业务结果数据/无真实模型；ADR/HIR 无法计算 |
| P 生产实测 | **未验证**（不得写通过） | live：9 任务 = 8 blocked（缺凭据）+ 1 failed（mock 下派单未完成） | 环境档位 local-preview；需凭据 + 真实模型复跑 |

## 4. U 域记分卡（逐项给数）

| 维度 | 指标 | 阈值 | 实测 | 判定 |
|---|---|---|---|---|
| 首价值 | 首屏见价值（跳过仪式后） | ≤20s | **≤5.0s**（直测；执行器假红 24.3s） | ✅（R2-F9 工具缺陷） |
| 审批 | 单件裁决 | ≤30s | 3.1s，三手势齐备（推进/校准/制动+批量），写回提示 ✅ | ✅ |
| 派活 | 模糊需求→拆解 | ≤60s / ≤3 步 | T-106 派发 0.02s；详情可读 | ✅ |
| 溯源 | 结论→事件/回执 | ≤2 次点击 | 1 次点击进入决策链路（派活后） | ✅（状态依赖） |
| 移动端 | 390px 无横向溢出 | 0 溢出 | 0 溢出，任务内容可见 | ✅ |
| C 端 | 首响 / 转人工 / 不编造 | ≤30s | 0.6s；转工单+转人工入口在位；边界外问题明确「不敢编造」 | ✅ |
| 制动 | 入口可达 + 二次确认 + 撤回 | 可用 | 顶栏制动**恒禁用**（未接 onConfirm）；夜班中心需夜班在跑；ai-pm 演示区无夜班运行 → 全链不可执行 | ❌（R2-F6，P2） |
| 无障碍 | axe critical/serious | 0 | **1**（`/memory` 选择框无访问名，critical） | ❌（R2-F5，P2） |
| 键盘/缩放/目标尺寸 | 6 路由 | 0 违规 | 键盘 6/6、缩放 6/6、目标尺寸 6/6 通过 | ✅ |
| 对比度 | ≥4.5:1（小字） | 0 违规 | 49 抽样 / 1 违规（3.88:1） | ⚠（R2-F7，P3） |
| 打扰 | 静置 20s 非 P0 打扰 | 0 | 0 | ✅ |
| 术语 | 裸码/裸 id/ISO | 0 | 0 | ✅ |

## 5. P 域记分卡（生产实测）

| 项 | 结果 |
|---|---|
| 环境档位 | `local-preview`（**非** client-runtime/deployed）→ P 域整体「未验证」 |
| 目标指纹 | server http://127.0.0.1:8991（本机预览）；无客户端运行时/部署地址 |
| 模型任务 | LLM-R1/T1/M1/G1、IMG-01/02、VID-01/02 **blocked（凭据未配置）**；无真实调用、无产物、无外部回执 |
| 产品派单 | PROD-01 **failed**（mock 档 + 线程停 `pending_review`，未达完成断言；非假成功——未宣告完成） |
| 配额台账 | `budget-ledger.jsonl` 9 条预约/提交记录；`budget-summary.json` 保守口径 llmCalls 4 / images 3 / clips 2 / 24s / ≈¥29.9（估算，未实际发生）/ 墙钟 8.02min |
| 结论 | **P 域未验证**；任何「生产验收通过」表述无效（T-51/T-52） |

## 6. O 域记分卡（交付结果）

| 项 | 结果 |
|---|---|
| 任务套件 | `acceptance/outcomes/` 无套件 → `configured=false`（模板已生成） |
| pass@1 / pass^k | 未测量（无套件、无真实模型） |
| 业务结果/对账 | 未验证（无业务数据源接入） |
| 假成功 | live PROD-01 以环境状态判分（`pending_review`）→ 未发现假成功；M6 轮假成功探针结论沿用 |
| 结论 | 结构合规、能力与结果**未验证**（不得写「通过」） |

## 7. ADR/HIR 表（本轮无有效样本）

| 角色 | AL(声明/实测) | N | ADR-1 | HIR-NI | HMPO | 说明 |
|---|---|---|---|---|---|---|
| （profile.outcome.roles 未配置） | — | 0 | n/a | n/a | n/a | `autonomy.mjs`：交付件 0；夹具过滤规则已声明（suite.*/apr-suite-*/apr-e-*/T-suite） |

轮内观察值（不作为指标）：`ws-yunqi` 活跃审批夹具 44+ 件（套件产生），审批台单件裁决 3.1s（EXP-02）。**未做 M3/M4（影子/离线审计）**，不能宣称自主价值。

## 8. 红线检查（12 条）

| # | 红线 | 判定 | 依据 |
|---|---|---|---|
| 1 | 治理被绕过 | 未发现 | M6 断言复跑（m1-reuse 无绑定全拒）、gate 11/11、围栏 dry-run ✅ |
| 2 | 关键任务不可完成 | 未命中 | 派活/审批/溯源/移动/C 端主链均实测可用；审批后 5s 自动续跑 |
| 3 | 演示与真实混淆 | 未发现 | dataMode=simulated 横幅在位；live PROD-01 判分用环境状态 |
| 4 | 秘密与客户数据 | 未发现（限定证据域） | 本轮未跑 secret-scan（沿用 M6 轮 PASS，见 §12）；报告/日志无凭据 |
| 5 | 无回执宣告完成 | 未发现 | PROD-01 停 `pending_review` 未被宣告完成 |
| 6 | **发布门禁未全绿** | **命中** | `pnpm suite` 469/470（Z-11 夹具）；`pnpm test` 814/2（消息/顺序）；CNB 自托管未实跑（本地 CI 等价复跑为证） |
| 7 | 假成功 | 未发现 | 状态断言 + 账本直查（M6 轮 0 例沿用；本轮 PROD-01 判 failed） |
| 8 | 越权自主 | 未发现 | m1-approval-reuse：无绑定拒绝、绑定一次性消费；m2-02 并发 15/15 |
| 9 | 结果不可对账/造假 | **未验证**（非命中） | O 域无套件/无业务数据 |
| 10 | 体验/无障碍阻断 | **部分命中** | U5-01 未达「0 critical/serious」；未观察到 P0 任务被阻断（/memory 非 P0 旅程） |
| 11 | AI 未披露/合成未标注 | 未发现 | C 端/工作台 AI 身份披露在位（EXP-09 实测） |
| 12 | 红线判定依赖 LLM 评审 | 未命中 | 本轮全部判定基于脚本/DB/环境状态，无 LLM 裁决 |

## 9. 统计与校准

- 用户研究：**未做**（U0-05/U7-03/U7-05 未执行）→ 满意度/成功率类指标只能 B/C 级。
- 任务多次试验：**未做**（O 域无套件；P 域无凭据）；pass^k 无法计算。
- 置信区间/评分者一致性：不适用（本轮无问卷/双评）。任何「显著」「提升」表述在本轮均无依据。

## 10. 失败与修复清单（本轮发现）

| ID | 级别 | 标题 | 位置/证据 | 判定与建议 |
|---|---|---|---|---|
| **R2-F1** | **P1（门禁红）** | `pnpm test` 2 败：合并批次「绑定校验」与「一次性消费」的**文案/顺序漂移**；夹具用未绑定审批，先触发 MC-106 拒绝 | `packages/base/workdata/workdata.test.ts:180-187`（期望 `/已被消费/`）、`:375-377`（期望 `/缺少绑定/`）；实测消息＝「未绑定任何写动作（缺 snapshot.action）」。证据 `r2-pnpm-test2.log` | 产品拒绝行为**正确**（m1-reuse 已证：绑定件第二次写才报「已被消费」）。修法：夹具补 `snapshot.action` 绑定；期望文案对齐为 `未绑定任何写动作`（或统一两处消息） |
| **R2-F2** | **P1（门禁红）** | `pnpm suite` 1 败：Z-11「启动补扫」夹具缺 `snapshot.action` → 补扫按 MC-106 fail-closed 拒绝，`resumed=0` | `scripts/suite.ts:4180-4187`；日志 `r2-suite.log`（scheduler 诊断行）。**对照实验**：夹具补 `action:"desktop.gui"` 后 `470/470`、日志「僵尸线程续跑 T-z-… → completed」（`r2-suite-boundfixture.log`） | 产品正确、夹具过期。修法：夹具绑定动作；可顺带断言「无绑定件被拒」为独立用例 |
| **R2-F3** | **P2（产品）** | M6-F1 仍存：落地向导整块替换 `business` → 出厂价带被清，R1/R2 可达性失效 | `apps/server/src/trpc/router.ts:723`（`jsonb_set(archive,'{business}',$2)`）；复现 `r2-f1-wizard-clobber.log`（4 档 → null）；**旁证**：套件 E2E 向导用例把 `business` 写成 `note:"E2E 向导验收"` | 建议 `jsonb_build_object('business', coalesce(archive->'business','{}'::jsonb) \|\| $2::jsonb)` + 断言「向导后价带仍在」 |
| **R2-F4** | **P2（产品/工具）** | M6-F2 仍存：`release-gate` 验链摘要解析失败 → T-03 报「未产出可解析摘要」，丢失 N 与类型直方图 | `scripts/release-gate.ts:60-72`；复现 `r2-f2-parse-repro.log`（parse=null；stdout 尾部 `ELIFECYCLE`）；真机门禁异常库日志 `mcdacc-f2-release-gate-anom*.log`（T-03 文案） | 解析「最后一行 `{…}`」或按标记成对截取；补异常库门禁级断言 |
| **R2-F5** | **P2（无障碍，WCAG AA）** | `/memory` 来源清算下拉框无访问名（axe `select-name` critical） | `apps/web/src/pages/p23/P23.tsx:372`；节点级证据 `mcdacc-axe-memory.log` | 加 `<label>`/`aria-label`（如「选择需要清算的来源成员」） |
| **R2-F6** | **P2（体验/掌控）** | 顶栏「紧急制动」恒禁用（`Bridge.tsx:220` 未传 `onConfirm`）；可执行制动仅在夜班中心且需夜班在跑；ai-pm 演示区无夜班运行 → 全链不可执行 | `apps/web/src/components/hud/EmergencyBrake.tsx`（组件头注释自称「永远可见可用」）；EXP-04 evidence | 产品裁决：接线顶栏制动或明确「制动仅夜班中心可用」并在演示区提供事件入口 |
| **R2-F7** | **P3** | 首页「单击画面快进」对比度 3.88:1（<4.5） | `experience-report.json#dimensions.contrast` | 提亮文案色或放大字号 |
| **R2-F8** | **P3（工具）** | `ui-probe.mjs` 期望「成员档案」，UI 已改为「员工档案」（5d0ee16）→ **14 条假红** | `scripts/acceptance/ui-probe.mjs:144`；对照 `ui-verified/` | 正则改为 `/(成员\|员工)档案 · \S/`（建议上游同步，避免全舰队假红） |
| **R2-F9** | **P3（工具）** | `experience.mjs` EXP-01 期望「待决/待我拍板/需你拍板/待审」，UI 为「待您拍板」→ 空转 18s、假 24.3s/待决 0 | `scripts/acceptance/experience.mjs:88-95`；`mcdacc-exp01-copy-check.log` | 正则补 `待您拍板`；同时把「等待价值出现」判据与计时解耦 |
| **R2-F10** | **P3（工具/序）** | EXP-03 在无线程工作区首跑必红（账本按线程聚合；空态文案已给下一步） | `experience` 首轮 vs 派活后复跑均通过 | 走查顺序先派活，或账本页增设跨线程视图（产品可选） |
| **R2-F11** | **P3** | 2 个员工档案页（competitor-scout / user-listener）出现 React HTML 嵌套警告 | `ui-probe.json`（R2 两轮均现） | 修正无效嵌套（%s 占位需 dev 环境还原） |

**复验轮（本轮同时确认 M6 修复在合并后仍成立）**：`m1-approval-resume` ✅（审批→5s completed、手势入时间线）、`m1-approval-reuse` ✅（无绑定拒/绑定一次性）、`m2-02-concurrency` ✅ 15/15（含 4210 事件验链）、`m3-linkage-thread` ✅ 11/11（直达号/职场请示/自动续跑/授权留痕）。

## 11. 验收债与豁免

| 债 | 内容 | 到期建议 |
|---|---|---|
| R2-F1/R2-F2 修复 | 夹具绑定 + 文案对齐（测试侧） | **发布前必须**（红线 #6） |
| R2-F3/R2-F4 修复 | M6-F1/F2（产品侧） | 发布前必须（P2；F2 影响故障时刻可读性） |
| R2-F5 修复 | `/memory` 访问名 | 下一轮前（P2） |
| R2-F6 裁决 | 制动接线或口径澄清 | 下一轮前（P2） |
| R2-F7/R2-F11 | 对比度、嵌套警告 | 可排期（P3） |
| R2-F8/R2-F9/R2-F10 | 执行器漂移（建议上游基座修，全舰队受益） | 下一轮前（否则每仓假红） |
| 未执行域 | 真机矩阵/弱网/中断/读屏/真实用户研究/长跑/红队/P 域真实模型/桌面安装包/CNB 自托管实跑 | 按 RDAS 轮次规划 |

豁免：**无**（本轮未向产品所有者申请任何红线豁免）。

## 12. 未覆盖与遗留

- 用户研究、真机设备、读屏、弱网与中断注入、长跑、红队、M3/M4 自主价值测量：见 §2 裁剪理由。
- P 域真实模型与客户端运行时：缺凭据/未安装客户端；本轮**未发生任何真实付费调用**。
- 桌面安装包真机安装、CNB 自托管节点流水线实跑：与 M6 轮同口径未覆盖（本地 CI 等价复跑已做）。
- `secret-scan`：本轮未重跑（沿用 M6 轮 PASS；建议随修复批次回归）。
- M6 全量 30 断言未逐条复跑：以「4 条变更面定向断言 + 回归套件/门禁 + 本轮 11 项新发现」替代（如实声明，非全量）。

## 13. 证据分级与索引

- **A 级（代码精读 + 真机实测/对照实验）**：R2-F1（代码+实测消息）、R2-F2（绑定夹具对照 470/470）、R2-F3（前后对照复现）、R2-F4（真实 pnpm 输出复刻解析）、R2-F5（axe 节点级）、R2-F8/F9（真实 DOM 对照）、L/U 记分卡数字、M6 断言复跑 4/4、typecheck/verify-chain/release:gate。
- **B 级（全量机检/脚本聚合）**：`coverage.json`、`matrix-summary.json`、`ui-probe.json`、`live-report.json`、机械判定。
- **C/D 级**：CNB 自托管实跑（未做，D）、桌面安装（未做，D）、真实用户研究（未做，D）。
- 索引：`outputs/acceptance/evidence-index.json`；原始回归日志归档 `outputs/acceptance/regression/`，定向复现/取证归档 `outputs/acceptance/evidence-r2/`（会话工作区 `work/acc/` 保留同源副本）。

## 14. 收尾报告

- **已完成**：基线冻结与指纹（含 HEAD 移动处置）；matrix/ui(+补丁复验)/experience/ux/live/outcome/autonomy/coverage/report 全链重跑；回归四件套（typecheck/verify-chain/release:gate/suite/test，CI 等价口径）；M6-F1/F2 在冻结态复现；M6 变更面断言 4 条复跑；11 条新发现落盘并给出修复建议；验收债与未覆盖清单。
- **未完成/未覆盖**：§12 所列（用户研究、真机、长跑、红队、P 域、桌面、CNB 实跑、M6 全量断言）。
- **自主追加事项及理由**：①以 `b67d651` 重定基线（HEAD 被外部移动，未停在旧基线以免结论过期）；②隔离验证执行器漂移并做受控 1 行补丁复验（避免 14 条假红被当成产品缺陷）；③用「绑定夹具对照实验」区分产品缺陷 vs 测试缺陷；④定向复跑 M6 变更面断言（合并触碰审批/调度面）。
- **采用的假设**：`wl_mcd_acc` 为一次性验收库（可重建，已 pg_dump 备份于 `work/acc/evidence/wl_mcd_acc-pre-rebaseline.dump`）；`wl_mcd_d` 为可复用异常账本库；「测试/夹具侧缺陷」判定以对照实验为准（非豁免）。
- **置信度**：**高**（红线 #6、R2-F1..F4 均有 A 级证据；U/O/P 未验证项与人工裁剪均已显式声明）。**限制**：CNB 自托管与桌面安装未实跑（D 级）。
- **建议复核**：① `r2-suite-boundfixture.log`（判 R2-F2 的关键对照）；② `r2-f2-parse-repro.log` + `mcdacc-f2-release-gate-anom2.log`（M6-F2 全链）；③ `mcdacc-axe-memory.log`（无障碍修复目标）。

## 15. 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（L 自动化 + U 自动化 + O/P 档位判定 + 回归 + 遗留复核；未覆盖项逐条声明）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论有依据、证据等级标注准确？（A/B/C/D + 原始日志路径；机械红逐条裁决）
- [是] 经得起资深工程师逐行审查？（红线 #6 与三处门禁红均给出对照实验或节点级证据；执行器补丁已还原，`git status` 仅剩标记文件与新增验收产物）
