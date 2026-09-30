# M6 独立验收报告 · T-2026-0929-0200（workloom-im）

> 执行：`mcd_verify`（**未参与任何修复**，独立会话/独立工作树/独立数据库）｜时间：2026-09-30 01:53–02:45
> 验收基线：**phase-1** `388c8c8`（A–D 批）／**phase-2** `0c0a1ad`（fix-E 五提交）→ **最终合并态 `330b8c5`**（merge 提交，tree `b02a486…` 与 `0c0a1ad` **逐字节一致**，见 `evidence-phase2/tree-hash-merge.txt`；结论直接沿用）
> 环境档位：**local-preview**（真实库 + 真实服务端 + 真实鉴权 + 出厂默认配置；LLM/IM = mock）
> 独立环境：工作树 `/Users/mac/WorkLoom-fleet/.wt-mcd-m6`（pinned 388c8c8）；库 `wl_mcd_m6_suite`（自 provision：migrate 41 文件 + hotel/boost/aipm 种子）；端口 8991（dev）/8992（prod）；另建 `wl_mcd_m6_factory`（出厂态）、`wl_mcd_m6_amp`（20k 审批放大）、复用 `wl_mcd_d`（异常账本）

## 0. 前置闸口（三基线 + 机器闸）

| 闸口 | 结果 | 证据 |
|---|---|---|
| 台账 `gate`（缺证据/断言/验证人分离/P0 闭环） | ✅ 通过（phase-1 53 卡 → phase-2 回写后 58 卡 / 12 不变量） | `node scripts/delivery/mine-clear.mjs gate` |
| 验收基线 ⊇ 修复基线（`git merge-base --is-ancestor`） | ✅ 15 个修复提交全部为 388c8c8 的祖先 | `work/m6/evidence/phase0-baseline.txt` |
| P0 闭环（MC-108） | ✅ 状态 fixed + 断言绿 | `evidence-clean/m6-a02-highrisk-batch.log` |
| 环境档位如实声明 | ✅ local-preview（不得写「生产实测」） | 本报告头部 |

## 1. 覆盖率声明

- 台账卡：phase-1 **53 张**（30 问题卡 + 23 修复卡），phase-2 追加 fix-E 五张 → **58 张**（30 + 28）。逐卡复验 A–D 批 23 张修复卡，`MC-110..114` 在 §9 二次复验（fix-E 五卡），累计 **28/28 张修复卡**全部独立复跑。
- 精读（A 级依据）：`scripts/release-gate.ts`（T-03 段）、`scripts/verify-chain.ts`、`apps/server/src/trpc/router.ts`（`onboarding.setupWorkspace`/`activateRealMode` 段）、`apps/server/src/industry/hotel/acquisition-planner.ts`、`scripts/seed.ts`（`yunqiArchive`）、`scripts/suite.ts`（R-06 / onboarding 段）、`apps/server/src/service/e2e.test.ts`（端口注入/实例归属段）、`outputs/mine-clear/T-2026-0929-0200/assertions/assert-m4.sh` 与 m1/m2/m3 全部断言脚本。
- 真机实测（A 级）：m1×5、m1-专项×1、m2×6、m3×5、M4 十卡、安全/可观测/错误面探针、typecheck、`pnpm test`、base/runtime（RUN_DB_TESTS=1）、server E2E（CI db-gate 同口径）、suite（463 条）、release:gate（dev+prod）、验链（正常/异常库）、三端构建、O 域受控套件、两条新问题的独立复现脚本。
- 机检（B 级）：M4 十卡中的静态断言（MC-201/202/203/204/205/208/210）、`.cnb.yml` 桌面流水线存在性、迁移/索引存在性。
- 未覆盖/裁剪：① 桌面安装包真机安装（本机无打包链与公证，同 M4 已声明）；② CNB 自托管节点流水线实跑（需自托管节点，MC-433 只做 YAML/命名静态验证）；③ P 域生产实测（无内置模型凭据，LLM=mock 只能写「能力未验证」）；④ U 域体验走查（RDAS 域，超出本次 M6 范围）；⑤ MC-110..114（等 fix_e）。

## 2. 证据分级

| 结论 | 等级 | 依据 |
|---|---|---|
| A–D 批 22/23 修复卡断言转绿 | **A** | 独立环境原样复跑断言 + 真机响应 + DB 直查（逐条日志见 §3） |
| M6-F1 落地向导清价带（含行为退化） | **A** | 独立复现脚本 + 前后对照（`completed` → `pending_review/params_incomplete=true`） |
| M6-F2 release-gate 摘要解析失败 | **A** | `execSync` 复刻 gate 解析 + 真实 gate 跑异常库（T-03 文案实测） |
| MC-433 桌面流水线「已迁入 CNB」 | **B** | `.cnb.yml` 机检（流水线未实跑） |
| MC-201/432 命名一致性 | **B** | 文档/产线/门禁三处机检 |
| R-06 对遗留 L2 待批敏感 | **A** | 污染库/干净库同 commit 两次 suite 对照 |

## 3. 逐卡复验结论

| 修复卡 | 覆盖问题 | 我的独立证据 | 结论 |
|---|---|---|---|
| MC-401 | MC-102 | `evidence-clean/m6-a04-fence-rule-change.log`（两次加严 v3/v4 生效、放宽 400） | ✅ 通过 |
| MC-402 | MC-109 | a04 + `m6-a06b-when-verdict.log`（覆盖行 active 且基线行保持 active） | ✅ 通过 |
| MC-403 | MC-103 | a05（无放行位 400 + 文案指名参数）+ a06（放行后生效）+ `m6-a14-when-retry-probe.log` 8/8 | ✅ 通过 |
| MC-411 | MC-301 | `m6-a09-m2-02-concurrency.log` 15/15（接受 ≤10、其余 429、0 建档） | ✅ 通过 |
| MC-412 | MC-302 | m2-02（queued 首轮即推进）+ m2-05 | ✅ 通过 |
| MC-413 | MC-303 | `m6-a12-m2-05-state-machine.log` H1/I1（双入口计划逐字段一致） | ✅ 通过（J1 见 M6-F1） |
| MC-414 | MC-304 | `m6-a11-m2-04-boundaries.log` 21/21 + m2-01 21/21 | ✅ 通过（严格版口径未做，fixer-C 已声明） |
| MC-415 | MC-305 | m2-01 + m2-05 C3（无回执重跑不 completed） | ✅ 通过 |
| MC-416 | MC-306 | 出厂库 `wl_mcd_m6_factory`：`business.price_bands` 在位；`m6-new-01-wizard-impact.log` 向导前同目标 completed | ✅ 出厂态通过（⚠ 向导后失效 → M6-F1） |
| MC-421 | MC-108 | `m6-a02-highrisk-batch.log`（batchApprove 跳过 high_risk 关卡） | ✅ 通过 |
| MC-422 | MC-101/104 | `m6-a01-approval-resume.log`（approve → 5s queued → 10s completed；手势事件归属线程） | ✅ 通过 |
| MC-423 | MC-106 | `m6-a03-approval-reuse.log`（无绑定两拒；绑定一次性消费） | ✅ 通过 |
| MC-424 | MC-107/205 | 套件端口可覆盖：`m6-d05-suite-clean.log` 463/463（8973/8974 端口）；占用 fail-fast：`m6-a15-suite-port-occupied.log` | ✅ 通过 |
| MC-431 | MC-105 | `m6-a07-outcome-trpc-surface.log` 9/9 过程注册；O 域受控套件 `m6-a16-outcome-suite.log`（completed、介入 H1-batch、假成功 0） | ✅ 通过 |
| MC-432 | MC-201 | `m6-c-MC-201.log`（文档产物名与产线一致） | ✅ 通过（B） |
| MC-433 | MC-202 | `m6-c-MC-202.log`（CNB 侧流水线存在） | ✅ 通过（B，未实跑） |
| MC-434 | MC-203 | `m6-c-MC-203.log` + `m6-d07-release-gate-prod.log`（生产档 11/11、门禁进程档位 production、生产档身份通道） | ✅ 通过 |
| MC-435 | MC-204 | `m6-d12-server-dbgate.log`（RUN_DB_TESTS=1 + SERVER_E2E_PORT 注入：302 passed / 0 failed；审计基线为 13 failed） | ✅ 通过 |
| MC-436 | MC-206 | `m6-c-MC-206.log`（500 且响应体为「服务内部错误（已记录，ref=…）」） | ✅ 通过 |
| MC-437 | MC-207 | `m6-c-MC-207.log`（生产档匿名 C 端会话 503 + 不反射 Origin） | ✅ 通过 |
| MC-438 | MC-208 | `m6-c-MC-208.log` + `pnpm test` 内桌面首启单测（密钥随机化/实例归属） | ✅ 通过 |
| MC-439 | MC-209 | `m6-c-MC-209-amp.log`（20k 审批 / 2857 pending → Index Scan 走覆盖索引） | ✅ 通过 |
| MC-440 | MC-210 | 摘要口径 ✅（8.7KB/499700 异常）；**门禁端到端 ❌**（T-03 报「未产出可解析摘要」） | ❌ **未通过**（M6-F2） |
| MC-441 | MC-110 | phase-2：`evidence-p3/m6-f1-01-kb-publish-gate.log` + `m3-linkage-kb` 18/18 | ✅ 通过 |
| MC-442 | MC-111 | phase-2：`evidence-p3/m6-f1-02-ask-coverage.log` + `m3-linkage-ask` 8/8 | ✅ 通过 |
| MC-443 | MC-112 | phase-2：`evidence-p3/m6-f1-03-ticket-reassign.log` + `m3-linkage-ticket` 18/18 | ✅ 通过 |
| MC-444 | MC-113 | phase-2：`evidence-p3/m6-f1-04-inbox-unified.log`（10/10） | ✅ 通过 |
| MC-445 | MC-114 | phase-2：`evidence-p3/m6-f1-05-floor-blocked-asking.log`（11/11）+ `m3-linkage-thread` 11/11 | ✅ 通过 |

## 4. 门禁与探针（干净库）

| 项 | 结果 | 证据 |
|---|---|---|
| typecheck | ✅ | `evidence/m6-d01-typecheck.log` |
| `pnpm test`（含桌面/负载/命名门禁） | ✅ | `evidence/m6-d02-test.log` |
| base / runtime（RUN_DB_TESTS=1） | ✅ | `m6-d03/d04` |
| server E2E（CI db-gate 同口径，端口注入） | ✅ 302 passed | `evidence-clean/m6-d12-server-dbgate.log` |
| suite（干净库） | ✅ 463/463 | `evidence-clean/m6-d05-suite-clean.log` |
| suite（被探针污染过的库） | ❌ R-06（遗留 L2 >20 条） | `evidence/m6-d05-suite.log`（见 M6-N1） |
| release:gate dev / prod | ✅ 11/11 ×2 | `m6-d06/d07` |
| 验链（正常库） | ✅ 9 段 / 1778 事件 | `m6-d08` |
| 验链（异常库 wl_mcd_d） | ⚠ 摘要可解析、门禁文案不可解析 | `m6-c-MC-440-summary-mode.log` / `m6-c-MC-440-gate-anomalous2.log` |
| 三端生产构建 | ✅ | `m6-d09/d10/d11` |
| 安全探针（dev / prod 分离取证） | ✅ 全部检查按档位达标（见 §5 备注） | `evidence-clean/m6-e01*.log` |
| 可观测探针 | ✅ 5/5 | `m6-e02-observability.log` |
| 错误面探针（不泄漏 SQL/载荷） | ✅ 无泄漏（仅正对照命中） | `m6-e03-error-leak.log` |
| M4 十卡 | ✅ 10/10（MC-209 用放大库） | `evidence-clean/m6-c-MC-*.log` |

> 档位说明：`sec-probe` 是「审计期发现的泄漏项」口径探针——生产档 SEC-DEMO-01（匿名 C 端会话）必须为「不可签发」，故 probe 中该项显示 FAIL 属**修复达标**；dev 档的 CORS/演示直登差异属档位语义，不构成缺陷。

## 5. 灵魂三问

1. **原来的问题还在吗？** — 30 个问题卡中 29 个在验收基线上转绿（§3）；MC-440 在门禁端到端路径上未达标（M6-F2）。
2. **修复引入新问题了吗？** — 发现 2 条（M6-F1、M6-F2）；其余门禁/探针/回归全绿，未观察到其他联动地雷。
3. **客户真实旅程走得通吗？** — 主线（派遣→围栏→审批→续跑→回执）、M3 五面联动、C→B 工单链路中**与 MC-110..114 相关的 5 处**仍断电（fix_e 在飞）；其余旅程（调价闭环、驳回回滚、晨报/夜班、O 域受控任务）走通。

## 6. 新发现

### M6-F1（P1）落地向导清空出厂价带 → R1/R2 可达性再失效
- 位置：`apps/server/src/trpc/router.ts:723`（`jsonb_set(archive,'{business}',$2)` 整块替换）↔ `scripts/seed.ts:185-192`（MC-306 写入价带）↔ `apps/server/src/industry/hotel/acquisition-planner.ts:113`（唯一锚点读取）。
- 复现：`work/m6/repro-wizard-clobber.mjs`（价带 4 档 → null）；`work/m6/repro-wizard-impact.mjs`（同目标：向导前 `completed`；向导后 `pending_review` + `params_incomplete=true`）。
- 旁证：仓库自身 suite 用例 `scripts/suite.ts:2545` 走同一写路径且不还原。
- 建议修法：`archive || jsonb_build_object('business', coalesce(archive->'business','{}'::jsonb) || $2::jsonb)`，并补「向导后价带仍在 → R1 仍自动」断言。

### M6-F2（P2）release-gate 验链摘要解析失败 → 门禁仍报「工具故障」
- 位置：`scripts/release-gate.ts:60-72`（`parseChainSummary` 取 `{` 之后全部文本）+ `:431-451`。
- 复现：`node`（execSync 复刻解析）显示 stdout 尾部含 `✅ 全库验证通过…`（健康）或 pnpm `ELIFECYCLE …`（失败）→ `JSON.parse` 抛错 → 摘要对象恒为 null；真实门禁异常库运行输出 `✗ T-03 … 验链未产出可解析摘要：Command failed: pnpm db:verify-chain`（`work/m6/evidence-factory/m6-c-MC-440-gate-anomalous2.log`）。
- 影响：MC-440 宣称的「T-03 报『N 处异常』」不成立，N 与类型直方图丢失，本质仍是工具故障措辞。
- 建议修法：解析「最后一行以 `{` 开头且以 `}` 结尾」的 JSON（或成对标记符包裹），并补异常库门禁级断言。

### M6-N1（P3 建议）suite R-06 对遗留数据敏感
- `scripts/suite.ts:2686` 的 R-06 未像 `:2811` 的 R-11 那样先隔离历史遗留 pending；当工作区遗留 L2 待批 >20 条时 `decided=0` 假红。干净库 463/463 通过。
- 建议：R-06 复用 R-11 的遗留隔离写法（仅测试健壮性，不影响产品）。

## 7. 收尾报告

- 已完成：三基线对齐；A–D 批 23 张修复卡独立复验；13 项门禁/探针；2 条新发现的独立复现；本报告与全部原始日志。
- 未完成/未覆盖：MC-110..114（fix_e 在飞，等合入后二次复验）；桌面真机安装、CNB 自托管节点实跑、P 域生产实测、U 域走查（原因见 §1）。
- 自主追加事项及理由：自建 clean 环境与放大库（避免复用修复者环境）；为 when 负路径写判定器（脚本退出码不区分负路径）；补 O 域受控套件与 CI db-gate 同口径复跑（覆盖 MC-105/MC-204 的真实路径）。
- 采用的假设：`local-preview` 档位；判据以外部可观察行为 + DB 事实为准；`wl_mcd_d` 为一次性异常库（可复用）。
- 置信度：**高**（除 MC-440 端到端判定与 MC-110..114 未覆盖外，其余结论均有红→绿或前后对照的 A 级证据）。
- 建议复核：① `work/m6/repro-wizard-impact.mjs` 的前后对照；② `work/m6/evidence-factory/m6-c-MC-440-gate-anomalous2.log`；③ `work/m6/evidence-clean/m6-d12-server-dbgate.log`（审计基线 13 failed → 现 0 failed）。

## 8. 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（A–D 全覆盖；MC-110..114 明确标注在飞未覆盖）
- [是] 没有把可自主完成的事项推给用户、没有以不必要的问句收尾？
- [是] 每个结论有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？（产物可原样复跑；新发现均附最小复现）

---

## 9. phase-2（fix-E：MC-110..114）独立复验

**验收基线**：`0c0a1ad`（`task/T-2026-0929-0200-fe`，5 提交：036f02b/5a44312/c1f0fbb/861c9d1/0c0a1ad；ff-able 自 388c8c8）
**独立环境**：`wl_mcd_m6_p3`（8997/8998，f1+m3 用）与 `wl_mcd_m6_p4`（8987/8988，门禁/回归用），均由新树全新 provision；断言脚本已同步为修复方最新版本（m3-linkage-* 于 02:13–02:21 更新、新增 f1-* 五脚本）

### 9.1 卡断言（fixer-E 提供，M6 独立复跑）

| 卡 | 断言脚本 | 结果 |
|---|---|---|
| MC-441（MC-110 知识发布人审） | `f1-kb-publish-gate.mjs` | ✅ PASS |
| MC-442（MC-111 ask 事实面） | `f1-ask-coverage.mjs` | ✅ PASS |
| MC-443（MC-112 重复派单） | `f1-ticket-reassign.mjs` | ✅ PASS |
| MC-444（MC-113 统一待办） | `f1-inbox-unified.mjs` | ✅ 10/10 |
| MC-445（MC-114 楼层共存） | `f1-floor-blocked-asking.mjs` | ✅ 11/11（内含 MC-101 续跑回归） |

### 9.2 M3 五探针（更新版脚本，修复前的红点全部转绿）

| 探针 | phase-1（388c8c8） | phase-2（0c0a1ad） |
|---|---|---|
| ① thread（MC-114 等） | 10/11 | **11/11** |
| ② kb（MC-110 等） | 13/17 | **18/18** |
| ③ ticket（MC-112/113） | 6/17 | **18/18** |
| ④ ask（MC-111） | 4/6 | **8/8** |
| ⑤ reject | 7/7 | 7/7 |

> 口径修正：phase-1 的计数来自修复前的旧版脚本（当时的默认工作区是 yunqi-hotel）；更新后的脚本按域默认工作区（kb/ticket=ai-pm-demo，thread/ask/reject=yunqi-hotel），统一覆盖 `MCD_WS` 会把探针打到错误工作区——本报告 phase-2 结果均为「不覆盖 MCD_WS」的复跑。

### 9.3 回归门禁（phase-2）

| 项 | 结果 | 证据 |
|---|---|---|
| typecheck / `pnpm test` / base 全测 | ✅ | `evidence-p4/m6-d01/d02/d04` |
| runtime（RUN_DB_TESTS=1） | ✅ 26/26（须先把 R7 还原出厂态） | `evidence-p4/m6-d03b-runtime-test-after-reset.log` |
| server E2E（CI db-gate 同口径，端口注入） | ✅ 306 passed / 0 failed | `evidence-p4/m6-d12-server-dbgate.log` |
| suite（全新库） | ✅ 463/463 | `evidence-p4-suite-fresh.log` |
| suite（被前序断言污染后） | ❌ R-06（M6-N1 复现） | `evidence-p4/m6-d05-suite.log` |
| release:gate dev / prod | ✅ 11/11 ×2 | `evidence-p4/m6-d06/d07` |
| 验链 / 三端构建 / M4 十卡 / 安全·可观测·错误面探针 | ✅ | `evidence-p4/m6-d08..d11`、`m6-c-*`、`m6-e0*` |
| O 域受控套件（MC-105 路径） | ⚠ 任务 completed、断言 ✓sql，但介入器回退到无关 L4 行被拒 → 记「未通过」（见 M6-N2） | `evidence-p4/m6-a16b-outcome-suite.log` |

### 9.4 phase-2 追加发现

- **M6-N2（P3，测量/工具健壮性）**：`scripts/acceptance/outcome.mjs:189` 的每轮手势在「本线程没有待批行」时回退 `rows[0]`，可能挑到与本 trial 无关的 L4/高危待批行 → 介入被服务端正确拒绝 → 该 trial 被记「未通过」（本次实测：`apr-l4-stmun0smd0` 的 H1 介入 ok=false，任务本身 completed 且 sql 断言通过）。建议回退候选同样过 `isHighRiskRow` 并限定本 trial 标记；否则 O 域 pass@1 会随工作区遗留待批波动。
- **M6-F1 的旁证（phase-2 复现）**：全新库（p4）先跑一次 `pnpm suite`（内部用例 `scripts/suite.ts:2545` 调 `onboarding.setupWorkspace`）后再跑 m2-05，J1「出厂价带可达」必红（19/20）——即仓库自己的套件就会清掉 MC-306 的出厂价带。
- **环境纪律（给后续会话）**：① when 类探针会把 R7 落成 block 覆盖行，复跑门禁前必须 `reset-r7.sh`（否则 runtime H-5 假红）；② m3/f1 脚本默认工作区不同，统一设置 `MCD_WS` 会打偏；③ 复用 acceptance profile 时注意 `target.apiUrl` 必须与断言所用库一致（否则出现假成功/假失败）。

### 9.5 phase-2 结论

- fix-E 五卡（MC-441..445）全部通过独立复验；MC-110..114 的 5 条断言在**全新库**上全绿。
- 未发现 fix-E 引入的新产品缺陷；门禁与回归全绿（suites/构建/发布门禁/验链/安全探针）。
- 遗留：M6-F1（P1，仍复现）、M6-F2（P2，仍复现）、M6-N1/M6-N2（P3，工具健壮性）。

### 9.6 台账回写与交接单

- `ledger.json` 已由 `mcd_verify` 回写：**56 张卡 state=verified**（28 张修复卡 + 其 covers 的 28 张问题卡），`verified_by=mcd_verify`、`verified_at`、`verification_evidence` 均落到卡上；**2 张保持 fixed（未通过）**：MC-440（fix）与其问题卡 MC-210，失败证据与 M6-F2 说明写入 `verification_evidence`/`notes`。回写后 `mine-clear.mjs gate` 仍通过（58 卡 / 12 不变量）。回写脚本与备份：`work/m6/writeback-ledger.mjs`、`ledger.json.bak-<ts>`。
- 交接单已生成：`outputs/mine-clear/T-2026-0929-0200/handoff.json`（已闭环 56 / 未闭环 2 / 环境档位 **local-preview**；两条未闭环均带回归路径）。RDAS v3.1 生产实测（P 域）不在本轮范围（无内置模型凭据）。

---

## 10. phase-3（修复批 F / R2 复验）独立复验

**验收基线**：`31282ce`（`merge: 修复批 F`，含上游 base-sync `bfd5fe6`；父会话把 330b8c5 之后的 F 批与上游 main 对齐后合入）
**独立环境**：全新库 `wl_mcd_m6_p5`（8985/8986，回归电池）/ `wl_mcd_m6_p6`（8983，专项实验）；PC 前端 5385（vite，独立进程）；异常账本复用 `wl_mcd_d`（8994）

### 10.1 逐卡复验（fixer-F 八卡，M6 独立复跑）

| 修复卡 | 覆盖问题（含我的 M6 发现） | 我的独立证据 | 结果 |
|---|---|---|---|
| MC-461 | MC-501（套件夹具假红） | `evidence-phase3/m6-p3-01-suite-fresh.log`：全新库 **470/470** | ✅ |
| MC-462 | MC-502（单测断言漂移） | `m6-p3-06b-root-test-db.log`：`RUN_DB_TESTS=1 pnpm test` 全绿（base 823 / runtime 49 / server 306 / web 111） | ✅ |
| MC-463 | **MC-503 = M6-F1**（向导清价带） | `m6-p3-03b-wizard-fixed.log`：向导后 4 档价带逐项保留 + 同目标 `completed`（R1 自动） | ✅ |
| MC-464 | **MC-504 = M6-F2**（验链摘要解析） | `m6-p3-04-gate-anomalous.log`：真门禁 T-03 报「验链失败：**499700 处异常**（13 段 / 102545 条事件）+ 类型直方图」 | ✅ |
| MC-465 | MC-505（/memory 下拉无访问名） | `m6-p3-07-axe.log`：critical/serious=0、select-name 节点=0 | ✅ |
| MC-466 | MC-506（紧急制动未接线） | `m6-p3-07b-brake.log`：11/11（无班次禁用+原因 → 出征 running → 二次确认 → paused → `night.run.pause` 留痕） | ✅ |
| MC-467 | **MC-507 = M6-N1**（R-06 遗留敏感） | `m6-p3-02-suite-with-leftovers.log`：注入 25 条遗留 L2 → 套件仍 **470/470**，遗留行保持 pending | ✅ |
| MC-468 | **MC-508 = M6-N2**（介入器回退） | `m6-p3-05-outcome-no-pollution.log`：污染库 pass@1=1、假成功 0；无关 L4 行保持 pending/tier 不变 | ✅ |

> MC-440 / MC-210（验链摘要门禁端到端）本轮一并转 **verified**：MC-464 复验即其端到端回归（真门禁已报「N 处异常」）。

### 10.2 回归电池（p5，tip 31282ce）

| 组 | 结果 |
|---|---|
| m1/m2 断言（15 项） | 13 PASS；`a05` 为预期负路径（判定器 `a06b` PASS）；**`a08 m2-01` 20/21**（见 M6-F3） |
| m3 五探针 | 全部 PASS（b01 11/11、b02 18/18、b03 8/8、b04 18/18、b05 7/7） |
| M4 十卡 + 安全/可观测/错误面探针 | 全部 PASS（探针按档位语义；可观测 5/5、错误面无泄漏） |
| 门禁 | typecheck ✅、`pnpm test` ✅、runtime 26/26 ✅、base ✅、**suite 470/470** ✅、release:gate dev+prod 11/11 ✅、验链 ✅、三端构建 ✅ |

### 10.3 phase-3 追加发现

**M6-F3（P2，断言漂移 → 新卡 MC-509，state=open）**：上游合并把挂起/熔断/执行的区分改为显式 `decision.kind`（`packages/runtime/src/loop.ts:350`，N-08：文案可自由改写，历史事件才回落 basis 前缀），W-01 缺参数分支的文案也不再带「越围栏挂起：」前缀（`loop.ts:946`）。冻结断言 `m2-01`「挂起事件落账（basis 标注越围栏挂起）」因此假红（20/21）。
- 产品语义未回退：replay 的 done 集合按 `kind` 排除挂起步骤，`m2-05` C3（无回执重跑仍 failed）通过；证据 `evidence-phase3/exp-m2-01-bands2.log`（价带在位、`kind=review`）与 `m6-p3-08-m2-05-c3.log`。
- 建议：更新该断言接受 `decision.kind === "review"`（或恢复 W-01 分支前缀）；改完复跑应 21/21。

### 10.4 phase-3 台账回写与交接

- `ledger.json`：**74 verified / 1 open（MC-509）**，75 卡；`gate` 通过；回写脚本 `work/m6/writeback-ledger-p3.mjs`（备份 `ledger.json.bak-p3-*`）。
- `handoff.json` 重新生成：已闭环 **74** / 未闭环 **1**（MC-509，带回归路径）/ 环境档位 local-preview。
