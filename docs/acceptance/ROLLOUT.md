# 十仓真机验收执行队列（RDAS v3.1 · 逐仓执行）

> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（rdas/v3.1）｜检查单：`docs/acceptance/checklist.v3.json`（276 项）｜队列事实源：本文件（每跑完一仓更新状态）
> 原则：**一次只验一个仓**（避免并发资源与环境互相污染）；每仓一轮结束必须留下 `outputs/acceptance/REPORT.md`（v3 模板）+ 缺陷工单 + 陷阱清单增量 + 验收债。
> v3 新增：U 域体验（56 项）、O 域交付（55 项）、ADR/HIR 自主交付（16 项）、L16 资产治理（6 项）、舰队机制（8 项）、T-19–T-50 陷阱、12 条红线。
> **v3.1 新增（2026-09-20）**：P 域生产实测（18 项）——环境档位（本机预览 / 真实客户端 / 生产部署）、内置模型真实触发（DeepSeek V4.1 Flash + Seedream 5.0 + Seedance 2.5）、配额与成本硬闸（图 ≤8 张、视频 ≤3 段且各 10–15s）、工具循环过围栏 + 哈希链账本、T-51–T-54 陷阱。**本机预览（LLM_PROVIDER=mock）不再构成“真机验收完成”。**

## 0. 队列与状态

| 顺序 | 仓库 | 车道 | 主包 | 演示 slug | 状态 |
|---|---|---|---|---|---|
| 0 | `workloom-ai/WorkLoom-growth` | experiment | geo-growth | geo-growth | v1/v2 试点已跑通；**v3 待复验（ADR/HIR + U 域）** |
| 1 | `workloom-ai/workloom-im` | base | ai-pm | ai-pm-demo | **v3 优先（三端壳被所有仓复用）** |
| 2 | `workloom-ai/workloom-hotel` | industry | hotel | yunqi-hotel | 待执行 |
| 3 | `workloom-ai/workloom` | industry | geo-growth | geo-growth | 待执行 |
| 4 | `workloom-ai/hyperreality-system` | industry | ai-video | video-studio | 待执行 |
| 5 | `workloom-ai/workroom-andromeda` | operations-hub | platform | platform-demo | 待执行（账号域 6 岗） |
| 6 | `workloom-ai/panda-cineforge` | industry | ecommerce | panda-group | 待执行（82 岗体量最大） |
| 7 | `workloom-ai/workroom-eagle` | industry | consulting | eagle-consulting | 待执行 |
| 8 | `workloom-ai/workroom-fox` | experiment | hotel | yunqi-hotel | 待执行（3D 舞台需录屏/FPS 证据） |
| 9 | `workloom-ai/workroom-tiger` | industry | trading | tiger-trading | 待执行（**只允许模拟/纸面**） |

## 0.1 隔离副本通道（growthtest / growthmatrix，默认不进队列）

`workloom-growthtest`（AI超增长·实验版）与 `workloom-growthmatrix`（骇客帝国·实验版）是登记在
`sync/child-repos.json#isolatedRepos` 的**隔离副本**（协议 §11，双向不同步）。它们**不进上面的十仓队列**，验收规则如下：

1. **触发**：只有产品所有者点名（"对 XX 隔离副本跑 RDAS"）才执行；不参与舰队默认轮次、不计入舰队总表分母。
2. **规格来源**：以**该仓自己的**计划/账本为规格——growthmatrix 用 `docs/GROWTHMATRIX-EXECUTION-PLAN.md` + `docs/GROWTHMATRIX-DEV-LEDGER.md`；growthtest 用 `CHANGELOG.md` + 提交信息 + 代码内产品决定注释。不得拿基座全景认知的冻结副本当验收依据。
3. **不变偏离声明（强制）**：报告必须单列"与基座不变量的有意偏离 + 补偿控制"。已知偏离：两仓均做**去审批化**（下线审批中心/任务中心与统一待办审批状态；补偿控制 = 业务链路关卡 G1–G10 / G-GEO1 / G-GEO2 / G-VIS1 等 + 服务端 `approvalsRouter` 与 `review-console` 保留 + 各业务页就地放行）。这类偏离按产品决定记录，**不判缺陷，也不得作为基座通过证据**。
4. **证据边界**：报告首页必须标注"隔离副本 · 不作为基座证据"；其结论只对该副本自身有效，公共化需另开提案任务卡（L2→L1→L0）。
5. **回队条件**：产品所有者明确指令 + 统一产品身份（productId / appId / 端口 / 演示工作区）+ 关闭或显式声明与基座不变量的冲突项 + 移出 `isolatedRepos` 并写入 `children`（再按正常十仓+口径执行）。

## 1. 每仓执行清单（v3）

```bash
# 0. 准备
git -C <repo> pull --ff-only && pnpm install
# 1. profile v2（角色/旅程/任务/阈值/结果契约/AL/夹具过滤）
pnpm acceptance:profile:check
# 2. 起真机
pnpm preview:all
# 3. L 基础层
pnpm acceptance:matrix      --out outputs/acceptance/matrix
pnpm acceptance:ui          --out outputs/acceptance/ui
pnpm acceptance:experience  --out outputs/acceptance/experience
# 4. U 体验域（axe/键盘/缩放/目标尺寸/动效；人工读屏与真实用户另跑）
pnpm acceptance:ux          --out outputs/acceptance/ux
# 5. O 交付域（任务套件；未配置则 configured=false，O 记“未验证”）
pnpm acceptance:outcome     --out outputs/acceptance/outcome --trials 5
# 6. 红队（发布前/季度）
pnpm acceptance:redteam     --out outputs/acceptance/redteam
# 7. P 域生产实测（v3.1；真实模型 + 配额台账；缺凭据整批 blocked，不得写通过）
#    本机预览（default）：只证明管道，不构成生产证据
pnpm acceptance:live        --env local-preview --out outputs/acceptance/live
#    真实客户端（已安装桌面客户端：server 8787 / web 5173）
pnpm acceptance:live        --env client-runtime --out outputs/acceptance/live
#    生产部署（profile.environment.target 必须显式声明地址；默认只读）
pnpm acceptance:live        --env deployed --out outputs/acceptance/live --require-live
#    编排器最小侵入档（不装依赖/不种子/不起本机预览/不关停目标）：
node scripts/acceptance/fleet-run.mjs --repo <repo> --env client-runtime --live-only
# 8. ADR/HIR 自主交付率（M1 遥测；M4 离线审计人工补）
pnpm acceptance:autonomy    --out outputs/acceptance/autonomy --all
# 9. 长跑（发布前 24h 起，季度 7d/28d）
pnpm acceptance:soak        --out outputs/acceptance/soak --hours 24
# 10. 覆盖率 + v3.1 报告
pnpm acceptance:coverage    --checklist docs/acceptance/checklist.v3.json --out outputs/acceptance/coverage.json
pnpm acceptance:report      --root outputs/acceptance
# 11. 回归（仅本机预览档位；生产档位跳过，证据以 P 域实测与目标探测为准）
pnpm suite && pnpm suite:<domain> && pnpm db:verify-chain && pnpm typecheck && pnpm release:gate
```

## 2. profile v2 要点（完整示例见 `docs/acceptance/profile.example.json`）

- `schemaVersion: workloom.acceptance-profile/v2`；
- `ux`：personas / journeys / tasks / research（真实用户配额、量表、方法）；
- `outcome`：roles（role/agentPreset/AL/deliverableUnit/minSubstance/kpis/attribution/guardrails）、taskSuites、receipts；
- `autonomy`：interventionTaxonomy H0–H4、fixtureFilters（必须过滤 suite 夹具）、windows、targetPrecisionPp、offlineAuditSample；
- `thresholds`：v2 原有 + 任务成功率/SUS/SEQ/CSAT/ADR-1/HIR-NI/H3+H4/HMPO/pass^k/目标尺寸/缩放/axe；
- `soak`：24/168/672 小时与指标。

各仓 profile 种子（workspaceId 可留空，用 identity.workspaceSlug 解析）：

| 仓库 | primaryBundle | workspaceSlug | dataMode |
|---|---|---|---|
| workloom-im | ai-pm | ai-pm-demo | simulated |
| workloom-hotel | hotel | yunqi-hotel | simulated |
| workloom / WorkLoom-growth | geo-growth | geo-growth | simulated |
| hyperreality-system | ai-video | video-studio | simulated |
| workroom-andromeda | platform | platform-demo | simulated |
| panda-cineforge | ecommerce | panda-group | simulated |
| workroom-eagle | consulting | eagle-consulting | simulated |
| workroom-fox | hotel | yunqi-hotel | simulated |
| workroom-tiger | trading | tiger-trading | simulated（只验纸面/模拟） |

## 3. 各仓专属加验（写入 profile 与报告）

| 仓库 | 额外必须验 |
|---|---|
| workloom-im | 三端壳/导航契约、桌面壳打包、`@workloom/ui` 消费门禁、base-sync 自身（fanout 干跑） |
| workloom-hotel | 体检→影子→托管三阶段切换；渠道对账；超售/倒挂看门狗；夜审；ADR/HIR 按前台/客房/收益分层 |
| workloom / growth | 双域询盘归因、GEO 可见度采集、发布回执、归因口径、实验车道不回流 |
| hyperreality-system | 渲染/剪辑管线、素材权限、发布 RPA、导演评审、每结果成本（渲染额度） |
| workroom-andromeda | 账号域 6 岗、密钥保管员红线、租户隔离、计费对账、平台工程不出仓 |
| panda-cineforge | 82 岗一致性、161 技能安装态、刊登/广告/售后涉钱审批、任务挑食与分母注水检查 |
| workroom-eagle | 诊断报告质量、199 技能抽样、服务前台知识、AI 不可替身场景（C-R4） |
| workroom-fox | 3D 舞台 FPS/首帧、音视频链路、实验路径不下发 |
| workroom-tiger | 纸面交易红线、风控围栏、Python 引擎与治理壳一致性、**不得触真实券商** |

## 4. 轮次节奏与预算（v3）

- 冒烟 S：2–4h（T1 52 项；脚本自动 + 人工抽查）；
- **生产实测轮 P（v3.1，新增）**：30–60 分钟（P 域 18 项 + 目标探测；真实模型调用 8 条任务、图 ≤8 张、视频 ≤3 段）；
- 标准轮 R1/R2：1–2 人日（T1 + 变更相关 T2 + 红线项）；
- 全量轮 F：3–5 人日（T1+T2；含真实用户研究、红队、真实设备矩阵）；
- 长跑轮 L：24h 起，季度 7d/28d（每季度至少 1 个行业仓）；
- 舰队节奏：每周 2 仓，5 周一轮；重大模型/包/提示变更触发复验（徽章 90 天 TTL）。

## 5. 完成定义（v3 DoD）

1. `outputs/acceptance/REPORT.md` 含 v3.1 硬性内容：覆盖率声明 / 证据分级 / 收尾报告 / 自检表 + L/U/O/P 四层判定 + U/O 记分卡 + P 域记分卡 + ADR/HIR 表；
2. 12 条红线逐条检查，红线 0；P0 全绿；P1 有工单/期限；
3. ADR/HIR：夹具过滤披露、H1/H2/H3/H4 分布、Wilson CI、HMPO 估算方法、AVR 四象限结论；未达 AVR 五条不得写“AI 自主价值提升”；
4. O 域无真实模型/无业务数据时只写“结构合规 / 能力未验证”；P 域必须声明 environment.kind，本机预览档位写“未验证”；
5. 生产实测配额（图 ≤8 张、视频 ≤3 段且各 10–15s、总 ≤45s、成本上限）在 `budget-ledger.jsonl` 可复算，超限任务逐条披露；
6. 新增陷阱回写 `docs/acceptance/checklist.v3.json`（基座 PR）；验收债登记到期日；
7. 本仓 `acceptance/profile.json`（v2 + environment/live）入库；Issue 回执五要素齐备。
