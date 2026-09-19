# 十仓真机验收执行队列（Step 2 · 逐仓执行）

> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（rdas/v1）｜队列事实源：本文件（每跑完一仓更新状态）｜舰队清单：`sync/child-repos.json`
> 原则：**一次只验一个仓**（避免并发资源与环境互相污染）；每仓一轮结束必须留下 `outputs/acceptance/REPORT.md` + 缺陷工单 + 陷阱清单增量。

## 0. 队列与状态

| 顺序 | 仓库 | 车道 | 主包 | 演示 slug | 端口偏移 | 状态 |
|---|---|---|---|---|---|---|
| 0 | `workloom-ai/WorkLoom-growth`（获客实验车道） | experiment | geo-growth | geo-growth | 0 | **已跑通（作为规范试点）**：70 岗/53 技能矩阵、三端 28 路由、体验 10 项走查、13 项缺陷修复，见 outputs 报告 |
| 1 | `workloom-ai/workloom-im`（基座） | base | ai-pm | ai-pm-demo | 0 | 待执行（优先：它的三端壳被所有仓复用） |
| 2 | `workloom-ai/workloom-hotel` | industry | hotel | yunqi-hotel | 0 | 待执行 |
| 3 | `workloom-ai/workloom`（获客主仓） | industry | geo-growth | geo-growth | 0 | 待执行 |
| 4 | `workloom-ai/hyperreality-system` | industry | ai-video | video-studio | 0 | 待执行 |
| 5 | `workloom-ai/workroom-andromeda` | operations-hub | platform | platform-demo | 0 | 待执行（含账号域 6 岗） |
| 6 | `workloom-ai/panda-cineforge` | industry | ecommerce | panda-group | 0 | 待执行（82 岗体量最大） |
| 7 | `workloom-ai/workroom-eagle` | industry | consulting | eagle-consulting | 0 | 待执行 |
| 8 | `workloom-ai/workroom-fox` | experiment | hotel | yunqi-hotel | 0 | 待执行（3D 舞台需额外录屏证据） |
| 9 | `workloom-ai/workroom-tiger` | industry | trading | tiger-trading | 0 | 待执行（**只允许模拟/纸面**：验收不得触碰真实券商路径） |

## 1. 每仓的执行清单（照抄即用）

```bash
# 0. 拉取最新 + 安装
git -C <repo> pull --ff-only && pnpm install

# 1. 建本仓 profile（示例见 docs/acceptance/profile.example.json；种子见 §2）
#    —— 写清角色/旅程/阈值/路由/启动命令，然后校验：
pnpm acceptance:profile:check

# 2. 起真机（默认 preview:all；特殊仓用 profile.startup.command）
pnpm preview:all

# 3. L0/L1 矩阵 → L3 页面 → L4/L5 走查 → 汇总
pnpm acceptance:matrix --out outputs/acceptance/matrix
pnpm acceptance:ui     --out outputs/acceptance/ui
pnpm acceptance:experience --out outputs/acceptance/experience
pnpm acceptance:report --root outputs/acceptance

# 4. 回归（各仓命令以自身 AGENTS.repo.md / package.json 为准）
pnpm suite && pnpm suite:<domain> && pnpm db:verify-chain && pnpm typecheck && pnpm <release-gate>

# 5. 回执：Issue 五要素（进展/决策/未完成/下一步/分支状态）+ REPORT.md 链接
```

## 2. 各仓 profile 种子（复制到本仓 `acceptance/profile.json` 后按需调整）

> `workspaceId` 可留空：执行器会用 `identity.workspaceSlug` 连库解析（前提：该仓的种子已跑过）。

```jsonc
// workloom-im（基座）
{ "schemaVersion": "workloom.acceptance-profile/v1", "repo": "workloom-ai/workloom-im", "productName": "WorkLoom 织元",
  "lane": "base", "primaryBundle": "ai-pm", "identity": { "workspaceSlug": "ai-pm-demo", "human": "MEM-001" } }

// workloom-hotel
{ "repo": "workloom-ai/workloom-hotel", "productName": "WorkLoom 酒店经营系统",
  "lane": "industry", "primaryBundle": "hotel", "identity": { "workspaceSlug": "yunqi-hotel", "human": "MEM-001" } }

// workloom（获客主仓） / WorkLoom-growth（实验车道，同产品两实例）
{ "repo": "workloom-ai/workloom", "productName": "WorkLoom 获客系统",
  "lane": "industry", "primaryBundle": "geo-growth", "identity": { "workspaceSlug": "geo-growth", "human": "MEM-G01" } }

// hyperreality-system
{ "repo": "workloom-ai/hyperreality-system", "productName": "HyperReality AI 视频经营体",
  "lane": "industry", "primaryBundle": "ai-video", "identity": { "workspaceSlug": "video-studio", "human": "MEM-V01" } }

// workroom-andromeda
{ "repo": "workloom-ai/workroom-andromeda", "productName": "Andromeda 平台运营中枢",
  "lane": "platform", "primaryBundle": "platform", "identity": { "workspaceSlug": "platform-demo", "human": "MEM-001" } }

// panda-cineforge（82 岗，矩阵与走查量大；建议 --fail-on-error 并加 --only 分段跑体验）
{ "repo": "workloom-ai/panda-cineforge", "productName": "Panda CineForge 电商经营系统",
  "lane": "industry", "primaryBundle": "ecommerce", "identity": { "workspaceSlug": "panda-group", "human": "MEM-001" } }

// workroom-eagle
{ "repo": "workloom-ai/workroom-eagle", "productName": "Eagle AI 咨询管理系统",
  "lane": "industry", "primaryBundle": "consulting", "identity": { "workspaceSlug": "eagle-consulting", "human": "MEM-E01" } }

// workroom-fox（实验车道：3D 舞台额外要求录屏 + 帧率证据）
{ "repo": "workloom-ai/workroom-fox", "productName": "Fox 交互实验体",
  "lane": "experiment", "primaryBundle": "hotel", "identity": { "workspaceSlug": "yunqi-hotel", "human": "MEM-001" } }

// workroom-tiger（高风险试验：**只验模拟/纸面**，不得触碰真实券商链路）
{ "repo": "workloom-ai/workroom-tiger", "productName": "Tiger 全球资产管理试验",
  "lane": "industry", "primaryBundle": "trading", "identity": { "workspaceSlug": "tiger-trading", "human": "MEM-T001" } }
```

## 3. 每仓的“本仓专属加验”（写在 profile 与报告的 L8/附加节里）

| 仓库 | 额外必须验的点 |
|---|---|
| workloom-im（基座） | 三端壳/导航契约、桌面壳打包、`@workloom/ui` 消费门禁、base-sync 自身（fanout 干跑） |
| workloom-hotel | 体检→影子→托管三阶段切换；OTA/渠道对账；超售与倒挂看门狗；夜审 |
| workloom（获客） | 双域询盘归因、GEO 能见度采集、发布回执、归因口径 |
| hyperreality-system | 渲染/剪辑管线、素材库权限、发布 RPA、导演评审 |
| workroom-andromeda | 平台账号域 6 岗、密钥保管员红线、客户租户隔离、计费对账 |
| panda-cineforge | 82 岗编制一致性、161 技能安装态、刊登/广告/售后涉钱审批 |
| workroom-eagle | 咨询交付物（诊断报告）质量、199 技能抽样、服务前台知识 |
| workroom-fox | 3D 舞台性能（FPS/首帧）、录音与播报链路、实验路径不下发校验 |
| workroom-tiger | 纸面交易红线、风控围栏、Python 引擎与 governance 壳的一致性 |

## 4. 轮次节奏与预算

- 单仓一轮：**0.5–1 人日**（3D/大编制仓 1–2 天）；
- 每仓至少两轮：第一轮找问题（本轮允许条件通过），修复后再跑一轮**只验证修复项 + 回归**；
- 舰队级：每周 2 仓，5 周跑完 10 仓；之后按发布里程碑做增量复验。

## 4.1 本机就绪度快照（2026-09-19 核，供 Step 2 排期）

| 仓库 | 本机是否存在演示库（库名 / 工作区） | `.env` | 备注 |
|---|---|---|---|
| WorkLoom-growth | ✅ `workloom_growth`：`ws-yunqi`(geo-growth) / `ws-geo` / `ws-video` | 已有（`work/growth` 副本） | 试点已跑通；三端 3000/3001/3002 + 8787 |
| workloom-im（基座） | ⚠️ `workloom_base` 目前只有 `ws-yunqi`(hotel)；基座自身演示应为 `ai-pm-demo` | 需 `pnpm setup`/`.env` | 执行前先种 ai-pm 演示工作区，或改 profile 指向实际工作区 |
| workloom-hotel | ✅ `wl_workloomhote`：`ws-yunqi`(hotel) + `ws-aipm-demo` | 需补 | — |
| workloom（获客主仓） | ✅ `wl_workloom`：`ws-geo`(geo-growth) 等 | 需补 | 与 growth 同产品两实例，注意别互踩端口/库 |
| hyperreality-system | ✅ `wl_hyperreality`：`ws-video`(ai-video) | 需补 | 渲染/发布链路注意 mock 标注 |
| workroom-andromeda | ✅ `wl_workroomandr`：`ws-platform-demo`(platform) | 需补 | 平台账号域 6 岗 + 密钥保管员红线 |
| panda-cineforge | ✅ `wl_pandacinefo(r)`：`ws-panda`(ecommerce) | 需补 | 82 岗，矩阵跑批最久 |
| workroom-eagle | ✅ `workloom_eagle`：`ws-eagle`(consulting) | 需补 | 另有历史评测工作区（`ws-eval-*`）可用于考试院回归 |
| workroom-fox | ⚠️ 未见独立库（复用 hotel 演示） | 需补 | 3D 舞台需额外录屏/FPS 证据 |
| workroom-tiger | ⚠️ Python 引擎，库结构不同 | 需补 | **只验模拟/纸面**，不得接真实券商 |

> `.env` 一律不入库；用各仓 `pnpm setup` / `pnpm doctor` 生成，秘密只走本机环境或受管秘密存储。

## 5. 完成定义（Definition of Done）

1. `outputs/acceptance/REPORT.md` 四段硬性内容齐全，结论明确（通过/条件通过/不通过）；
2. 所有 P0/P1 已修并回归；未修项有工单 + 责任人 + 截止日；
3. 新增陷阱已回写 `docs/acceptance/checklist.v1.json`（经基座 PR）；
4. 本仓 `acceptance/profile.json` 已入库（后续轮次可直接复跑）；
5. Issue 回执五要素齐备。
