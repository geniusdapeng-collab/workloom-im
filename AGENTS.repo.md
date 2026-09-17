# workloom-im 仓库专属指引

> 本文件只适用于 workloom-im。开始实质性工作前，必须先完整阅读根级 AGENTS.md 与 WORKLOOM_PRODUCT_CONTEXT.md；本文件只补充主仓的运行、验证与目录约定，不替代或放宽共享安全不变量。

## 主仓职责

- workloom-im 是公共运行时与公共能力的唯一事实源，也是默认 AI 产品经理版。
- 公共机制先在本仓实现、评测和灰度，再通过受控 base-sync 分发。
- 行业业务语义应留在对应行业 bundle 或子仓；platform-ops、平台账户和平台秘密只属于 Andromeda，不得从本仓向行业仓扩散。
- 修改同步范围、公共 API、事件、围栏、租户、技能或客户端基础设施时，必须评估所有订阅子仓的兼容、迁移和回滚影响。

## 产品入口

WorkLoom 的正式产品形态是桌面客户端；浏览器三端用于开发和验收。

- 环境初始化：pnpm setup
- 桌面客户端源码入口：pnpm app；开发模式：pnpm app --dev（或 pnpm app:dev）；无头主进程冒烟：pnpm app --smoke。三者只依赖 pnpm setup 完成的源码环境，不依赖 dist-payload。
- 浏览器三端预览：pnpm preview:all
- 安装包：先按目标平台执行 scripts/pack-electron-payload.sh，再运行 pnpm app:pack；正式分发包：pnpm app:dist。已打包程序及 WORKLOOM_RENDER_SMOKE=1 必须通过完整载荷校验，不得降级为源码模式。

桌面端必须按窗口真实可用宽度响应式重排，禁止用固定 1440×900 逻辑画布或整页等比缩放冒充响应式。PC 工作区应支持面板折叠、隐藏、拖拽缩放、恢复默认和全屏；窄窗口中的辅助面板降级为抽屉，正文在系统标准缩放和 200% 页面缩放下不得横向溢出。关闭窗口应最小化到托盘，只有托盘“退出”才终止夜班和后台任务。涉及这些行为的修改必须在真实桌面入口验证，不能只启动 apps/web。

浏览器验收以 PREVIEW_CHECKLIST.md 和 mock/README.md 为准。运行测试前先确认没有残留服务占用 8787/5173，避免 E2E 连接错误实例或受到后台节拍干扰。

## 电脑与浏览器操作能力

本仓的电脑操作入口位于 packages/base/computer-use/，覆盖浏览器 DOM、GUI 语义树和截图像素兜底。验证运行中 UI 时优先使用真实交互与截图，而不是只看 curl 或日志。

常用命令：

- 预检并准备桌面环境：pnpm computer:preflight
- 连接和执行动作：pnpm computer '<JSON action>'
- 端到端冒烟：pnpm computer:smoke
- MCP 服务：pnpm computer:mcp

完整开发说明见 docs/agent-computer-guide.md，生产部署与安全基线见 docs/computer-use-production.md。只有在任务明确包含专用工作站部署时，才运行 packages/base/computer-use/toolkit/install.sh 或启动远程控制服务；远程服务令牌必须来自受控秘密存储或本地环境，不得写入命令示例、日志、文档或提交。

## 启动与环境

推荐使用 pnpm setup 完成环境检查、环境文件提示、依赖安装、PostgreSQL/pgvector、迁移、种子和可选电脑操作栈。需要手动排查时按以下顺序定位：

1. docker compose up -d postgres
2. 在本地创建未提交的 .env
3. pnpm install
4. pnpm db:migrate && pnpm db:seed
5. pnpm dev

.env 及其真实值不得提交。不要把 mock、演示回执或体验模式当成真实后端成功。

## 验证要求

按改动面选择验证，并遵守根级 AGENTS.md 的风险升级规则：

- 快速能力巡游：bash scripts/agent-tour.sh
- 包含种子、全套测试和发布门禁的巡游：bash scripts/agent-tour.sh --full
- 常规代码改动：pnpm suite
- 事件、账本或号源改动：额外运行 pnpm db:verify-chain
- 能力面、脚本、包、技能或演示页改动：pnpm capabilities，再运行 pnpm capabilities:check
- UI 改动：启动正确入口，实际操作并截图核对
- 发布候选：pnpm release:gate；未全部通过不得发布

完整能力地图见 docs/capability-map.md，发布要求见 docs/release-checklist.md。不能运行的检查要明确报告原因和未覆盖风险，不能把“未运行”表述为通过。

## 目录速览

| 路径 | 主仓职责 |
|---|---|
| apps/server | tRPC 服务端与公共服务入口 |
| apps/web、apps/webb、apps/webc | B 端 PC、B 端移动与 C 端移动服务前台 |
| packages/ui | 三端唯一基础组件、设计令牌、图标、布局控制、中文显示与交互范式源 |
| packages/industry-contract | 行业 Bundle 的三端投影、兼容性与中文展示契约 |
| apps/desktop | 正式桌面客户端 |
| packages/base | WorkData、围栏、Captain、computer-use 等底座能力 |
| packages/runtime | Agent 与编排运行时 |
| packages/db、packages/shared | 公共数据与类型协议 |
| bundles | 基座内置/示例 bundle；不得据此混入平台专属语义 |
| scripts | 测试、种子、发布、能力生成与开发工具 |
| sync | 基座分发范围、同步引擎、接入与 heartbeat 模板 |
| docs | 设计、验证和能力说明 |

## 开源组件更新

- 查看计划：pnpm oss:plan
- 主动扫描并更新计划：pnpm oss:watch
- 扫描可以自动，依赖升级必须分批、评测并通过对应门禁；高风险依赖单独成批。
- 新增依赖时同步维护 oss-components.json；详细流程见 skills/oss-watch/SKILL.md。
