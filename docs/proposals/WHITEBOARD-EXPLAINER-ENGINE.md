# 提案：手绘白板解说引擎（srt-whiteboard）公共化评估

- 提案日期：2026-09-27（Asia/Shanghai）
- 提案来源：`workloom-ai/WorkLoom-growth` 任务卡 T-2026-0926-0020（Issue #188 → PR #194 已合并）
- 基座任务卡：T-2026-0926-0003（Issue #161）
- 现状：**已在实验车道 `WorkLoom-growth` 落地并真机出片**（不是"选型在案"）
- 提请裁决方：产品所有者
- 依据：`docs/DEVELOPMENT-PROTOCOL.md` §14.4「实验验证成功的通用能力必须先走提案任务卡（L2→L1→L0）才能进基座」

> 本文件是**提案**，不是已批准的公共化决定。在获得明确裁决前，本能力只存在于
> `WorkLoom-growth` 与其两个隔离副本，不下发、不回流。

## 一、能力是什么（一句话 + 证据）

**字幕驱动的确定性手绘白板渲染器**：一份口播稿进去，一条带配音、带字幕轨的手绘白板解说片出来；
本地 CPU 渲染、零模型成本、零 API 依赖（线稿阶段可选方舟出图）。

| 项 | 事实 |
|---|---|
| 上游 | [geeklee/srt-whiteboard-animation](https://github.com/geeklee/srt-whiteboard-animation)（MIT），pin `696a724` |
| 落地仓 | `workloom-ai/WorkLoom-growth`，`vendor/srt-whiteboard/` + `apps/server/src/video/whiteboard/**` |
| 事实源 | `docs/whiteboard-engine.md`（引擎能力/局限/验收对照）、`docs/whiteboard-spec-review-2026-09-27.md`（规格 review：11 处修正 + 6 项补齐） |
| 上游缺陷修复 | 3 处本地补丁（跨平台字体 / 解释器版本闸 / 落墨包围盒提速 **5.5×** 且逐帧 PSNR=∞ 证明语义等价），见 `vendor/srt-whiteboard/PINNED.md` |
| 测试 | 白板单测 27 例（含与上游 `parse_srt.py` 真跑比对）+ 基座能力静态回归 16 例 + 既有 346/1193 例零回归 |

## 二、L2 → L1 → L0 逐层判断

### L2（实验语义，留在 growth）

- 销售口播稿与文案（`docs/examples/whiteboard-growth-sales-script.md`）
- 片型 `explainer` 在本产品线的具体用法、幕长档位（默认 26s/幕）
- 与获客行业绑定的表达（"获客五环"之类的叙事模板）

### L1（行业语义，可下发到同行业仓）

- 口播解说片（`kind='explainer'`）这一**片型**本身
- 白板引擎与既有 `talkcraft`（动效口播）并列成为"口播解说"的两种画风
- 白板片的交付口径（带配音 + 软字幕轨 + 入媒资库 `final_cut`）

### L0（公共能力，进基座才谈得上）

候选人只有三块，且**都依赖视频制作子系统的归属决定**（见第三节）：

1. `GenProvider` 接缝的"本地确定性渲染器"形态（`healthy/submit/poll` + `file://` 本地入库）
2. 口播稿→逐句配音→SRT→分幕→标注→渲染→混流的**环节链形状**
3. 断点续跑的任务目录契约（`status.json` + 逐幕产物 + 接管判据）

## 三、真正的阻塞：视频制作子系统不在基座

实测事实（基座 `main@1d0d319`）：

| 检查 | 结果 |
|---|---|
| `apps/server/src/video/` | **不存在**（基座无视频工作室模块） |
| `packages/video-studio/` | **不存在** |
| `bundles/ai-video/` | **不存在**（基座只有 `ai-pm` / `hotel` / `platform`） |
| `packages/db/migrations/` 最高编号 | `0035`（无 `video_projects` / `render_jobs` / 媒资库） |
| `sync/base-scope.json#include` | `packages/base|industry-contract|runtime|shared|db/**`、`apps/server/src/**`、`apps/desktop/**`、`scripts/**` |
| `sync/base-scope.json#exclude` | 含 `vendor/**`、`bundles/**` |

推论（**这是"通过基座 fanout 推送各仓"走不通的根因**）：

1. 白板引擎的运行时（`vendor/srt-whiteboard/**`）与目录登记（`bundles/ai-video/library/media-catalog/**`）
   **都在 base-sync 的 exclude 里**——即使把它搬进基座，fanout 也不会分发；
2. 它依赖的宿主（`render_jobs` / `render_scripts` / `video_assets` / `render-poller` / G8 门）
   在基座**根本不存在**，搬进基座等于把整个视频制作子系统提升为公共能力；
3. 两个隔离副本（`workloom-growthtest` / `workloom-growthmatrix`）按协议 §11 本就
   **不在同步队列内**，fanout 永远到不了它们。

## 四、三条可选路径（请裁决）

| 路径 | 做法 | 成本 | 影响面 | 备注 |
|---|---|---|---|---|
| **A（推荐）逐行业接入** | 以本提案为目标仓的规格，向真正需要口播解说片的行业仓（首选 `hyperreality-system`（ai-video），其次 `workloom`（获客））各开一张任务卡逐仓落地 | 每仓 1 张任务卡，按已验证的移植流程（growthtest/growthmatrix 本轮已跑通一次） | 不动同步边界；各仓按自己迁移号接入 | 与"实验车道不下发"纪律一致；已验证可移植 |
| B 提升为公共能力 | 把 `apps/server/src/video/**` + `packages/video-studio` + `bundles/ai-video` + 迁移链整体提升进基座，并改 `sync/base-scope.json` 的 include/exclude（放开 `vendor/srt-whiteboard/**` 与 `bundles/ai-video/library/media-catalog/**`） | 大：等于把视频制作子系统变成公共资产，需重新评估九仓兼容与三端契约 | 全部订阅仓（9 个） | 属**修改同步边界**，`base-scope.json` 自述"修改本文件即修改同步边界，需基座 owner 评审" |
| C 仅登记不分发 | 在基座 `oss-components.json` / 能力地图登记该引擎形态，明确"各行业仓按需自接" | 极小 | 无 | 不解决"一次接入、多仓可用"，但把事实与证据留在基座 |

## 五、请求裁决的事项

1. 是否批准**路径 A**（逐行业接入）作为默认公共化方式？若是，请指定目标行业仓与优先级。
2. 是否需要**路径 B**（把视频制作子系统提升为公共能力）？这是同步边界变更，需明确授权。
3. 白板引擎的 `vendor/` 是否允许进入 base-sync 分发范围（若走 B，这是必需的前置）。

## 六、本轮已完成的（可复核）

- 隔离副本移植已验证可行：`workloom-growthtest`（迁移 0043，PR #64 已合并）、`workloom-growthmatrix`（迁移 0053，PR #80 已合并）——两仓均落地同一份能力，并通过 typecheck + 32/16 例测试。
- 移植过程中发现并修掉两处**移植敏感点**：迁移号撞车（各仓序列不同步）、
  能力测试写死迁移文件名（已改为按文件名后缀发现 + 编号唯一性断言）。
