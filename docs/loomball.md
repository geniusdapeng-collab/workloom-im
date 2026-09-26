# 织球 LoomBall · AI 班组状态表情球（基座公共化 T-2026-0926-0001）

> 一句话：**用一只球把「班组此刻在干什么」变得看得见**——名册、织伴、任务页三处共用一套
> 真实信号映射；开关一关，全部回退到既有静态形象。

> 来源：Growth 实验车道（L2）验证成功后按协议 §10.2 公共化到基座（L1→L0）。
> 上游：`grok-ball`（MIT，tycoding）→ 在 `apps/web/src/vendor/loomball/` 以内联 vendor 形态接入，
产品内统一命名「织球 LoomBall」。署名、去商标、改动边界见
[`apps/web/src/vendor/loomball/NOTICE.md`](../apps/web/src/vendor/loomball/NOTICE.md)。

**基座版信号口径**：基座没有视频 run 注册表，因此班组状态眼只用**本组件已有的真实轮询**——
待人审（收件箱 `kind=judge`）→ `51 待审批`；红线（`level=red`）→ `34 出错`；勿扰时段空闲 → `52 夜班值守`；
其余 → `02 待机`。`activeRuns`（"班组正在干活"）保持 0：宁可显示待机，也不假装在干活；
行业仓（如 Growth）接了自己的 run 聚合（`video.studio.active`）后即可补上这一段。

## 1. 定位（不要误用）

| 是 | 不是 |
|---|---|
| 岗位/班组的**工作状态指示器**（思考、检索、渲染、待审批、夜班值守、出错） | ❌ 不是数字员工，没有岗位职能 |
| 名册/线程/织伴角落态的**轻量可视化层** | ❌ 不是视频素材、不进成片 |
| 与文字 chip **同源**的冗余表达（球 aria-hidden，语义靠文字） | ❌ 不替代织伴大形象、语音、对话与记忆面板 |

## 2. 三处接入面（改映射层就要走查这三处）

| # | 接入面 | 位置 | 形态 | 驱动信号 |
|---|---|---|---|---|
| A | 数字员工名册 | `apps/web/src/pages/p8/P8.tsx` | 每张员工卡左侧 44px 织球（默认静态，hover 激活；忙/待审批的员工常驻动画） | `roster.list` 的 `lastAction / lastActionAt / pendingApprovals / blockedRecent` |
| B | 织伴 | `apps/web/src/components/loommate/LoomMate.tsx` | 小角落态（mini 圆球）= 织球 56px | 收件箱（待审/红线）+ 勿扰时段（行业仓可再叠 run 聚合） |
| C | 任务页 | `apps/web/src/pages/p2/P2.tsx` | 标题行 40px 织球 + 状态 chip | 线程 `status`（`pending_review` = 待人审） |

> 与实施规格 v1.0 的差异（真机核对后修正，逐条留痕见任务卡 #184）：
> ① 规格的 `emotionOfAgent({currentRun,lastAction})` 字段在名册投影里不存在 → 服务端补真实信号；
> ② 规格的 C 面「studio run 球」挂不到 P2（run 注册表与线程无外键）→ 改为线程状态球，
> `emotionOfRun` 仍保留给真实 `video.studio.status` 投影使用；
> ③ 规格的 `widget_size==='small'` 分支实际不存在（真实小角落态是 `mini` 圆球）→ 两处都接。

## 3. 映射表（唯一事实源：`apps/web/src/components/loomball/agent-emotion.ts`）

| 表情 ID | 文案 | 触发条件（全部来自真实信号） | 语义色 |
|---|---|---|---|
| `02` | 待机 | 没有任何近期信号 | 灰 |
| `32` | 处理中 | 90s 内有动作，但不属于渲染/检索/输出族 | 蓝 |
| `50` | 渲染中 | 90s 内动作匹配 `render|gen|bgmwrite|subtitlewrite|colorwrite|visualwrite|mix|grade|burn` | 蓝 |
| `40` | 检索资料 | 90s 内动作匹配 `intel|research|search|collect|scan|retrieve|probe` | 蓝 |
| `39` | 输出中 | 90s 内动作匹配 `publish|reply|comment|post|send|submit|draft|deliver|export` | 蓝 |
| `51` | 待审批 | 该岗位有 pending 审批单；或全局有 pending 审批；或 run 停在 G8/G9/G10；或线程 `pending_review` | 金 |
| `34` | 出错 | 岗位 `status=invalid`；或近 1h 有围栏阻断事件；或 run `failed` | 红 |
| `33` | 已完成 | run `finished`；线程 `completed` | 绿 |
| `52` | 夜班值守 | 夜班岗位在夜班窗口内在线；或用户在勿扰时段且系统空闲 | 蓝 |

优先级（同一时刻多个条件命中时）：**出错 > 待审批 > 干活中 > 夜班 > 待机**。

自定义表情（`50/51/52`）用上游公开 API `config.register()` 注册，ID 属官方预留的 `50+` 自定义段；
三条都是**完整声明式配置**（上游不支持继承/变体），只复用既有 25 组眼环与既有动画原语。

## 4. 防抖与性能

- 最小驻留 1.5s（`MIN_DWELL_MS`）；出错态**立即生效**并驻留 6s（`FAILURE_HOLD_MS`），
  避免轮询抖动让球"神经质"（名册 10s / 任务页 5s / 织伴 20s）。
- 列表默认 `autostart:false` → 上游 `lite` 静态缩略图，零 rAF；
  只有忙碌/待审批的岗位常驻动画，其余 hover/focus 才激活（同一时刻最多一条 `pointermove` 监听）。
- 尊重系统 `prefers-reduced-motion: reduce`：一律静态。

## 5. 运维与回退

| 项 | 值 |
|---|---|
| 总开关 | `VITE_LOOMBALL=1`（默认，不配即开）/ `0`=全部回退（等尺寸空盒；不创建实例、不注册表情、不挂监听、不启动 rAF） |
| 回退后的形态 | 名册保留既有"夜班在线/只读/待命"文案位置改为纯文案 chip；织伴小角落态回到 Mao 海报球；任务页不显示球 |
| 依赖 | 无新增 npm 依赖；引擎为随仓 vendor（118KB 单文件，零运行依赖）。注意：关开关只是**不运行**引擎，模块本身仍随包加载（这是刻意的简化；要连产物一起剔除需改为动态 import） |
| 升级上游 | 更新 `vendor/loomball/grok-ball.js` + `grok-ball.ts` + `PINNED` → 重跑 `agent-emotion.test.ts` / `engine.test.ts` / `LoomBall.test.tsx` / `provenance.test.ts` → 真机走查三处接入面 |
| 登记 | `oss-components.json`（weekly 扫描，升级永不自动） |

## 6. 验证清单（真机）

1. 名册页 78 岗同屏：静态球不启动动画循环（浏览器 Performance 采样，见任务卡证据）；
2. 名册页把某岗位灌入一条 90s 内动作事件 → 该球变 `32/50` 且 chip 同步；造一条 pending 审批 → 球变 `51`；
3. 织伴小角落态：起一个 run → 球变 `32`；造 pending 审批 → `51`；勿扰时段空闲 → `52`；
4. 任务页：线程 `pending_review` → `51`；`completed` → `33`；`failed` → `34`（出错驻留 6s）；
5. `VITE_LOOMBALL=0` 构建 → 三处全部回退，既有页面测试全绿（零回归）；
6. 业务代码零上游商标字样（`provenance.test.ts` 闸门）。
