# AGENTS.md — 给 AI Coding Agent 的入场指引

> 你正在 WorkLoom IM仓库中工作。本文件是你进入仓库后**最先要读**的文件。

## 0. 最重要的一件事：你有"手"（本仓自带，生产可用）

**本仓自带完整的电脑/浏览器自动操作能力**（`packages/base/computer-use/`，65 个动作，三层感知：
L1 浏览器 DOM 级零 token / L2 全 GUI 语义树零 token / L3 截图像素级兜底）——**不依赖任何沙箱，
克隆本仓即可用**；在专用工作站/宿主机上同样可安装运行（生产部署见 §0.1）。
不要只用 curl 和日志判断系统行为——你可以像人一样打开浏览器、点击、输入、截图，对运行中的系统做端到端验证。

**30 秒上手（照抄即可）：**

```bash
# 1. 预检（自动安装/拉起 Xvfb 桌面 + Chromium CDP:9222 + VNC:5900/noVNC:6080），必须最先跑
pnpm computer:preflight          # 即 packages/base/computer-use/toolkit/preflight_check.sh

# 2. 连接浏览器并打开本系统 Web 端
pnpm computer '{"action": "browser_connect"}'
pnpm computer '{"action": "browser_goto", "url": "http://localhost:5173"}'

# 3. 读页面结构（零 token）、点击、截图
pnpm computer '{"action": "browser_snapshot"}'
pnpm computer '{"action": "browser_click", "selector": "text=工作台"}'
pnpm computer '{"action": "screenshot"}'
```

> 兼容说明：若你运行在 CodeBuddy 开发沙箱中，沙箱技能的旧路径
> `/root/.codebuddy/skills/computer-use/` 与本仓 toolkit 同栈同源，命令可互换；
> 本仓 `pnpm computer ...` 是首选入口。端到端自检：`pnpm computer:smoke`（12 项全绿=就绪）。

### 0.1 把这套能力装到生产环境（专用工作站）

本能力的全部组件（Xvfb/Chromium CDP/AT-SPI/xdotool/OCR/录屏）都是开源件，仓内 toolkit 自带一键安装器。
给系统配一台专用 Ubuntu 机器（物理机/VM/容器均可），即可拥有与开发环境完全相同的"操作电脑"能力：

```bash
sudo bash packages/base/computer-use/toolkit/install.sh   # 装齐整套桌面栈（一次性）
pnpm computer:preflight && pnpm computer:smoke             # 拉起 + 12 项端到端自检
COMPUTER_USE_TOKEN=<强令牌> pnpm computer:serve            # HTTP 远程驱动（大脑/手分离）
pnpm computer:mcp                                          # 或以 MCP server 供 Agent 原生调用
```

完整部署指南（三种形态 + 安全基线）：[`docs/computer-use-production.md`](docs/computer-use-production.md)。

## 1. 首次启动：先看三端全貌（强制）

```bash
pnpm preview:all     # 一键拉起三端 + 演示数据固化（无需外部模型密钥，需本地 PostgreSQL）
#  🖥 PC 端 B 端工作台        http://localhost:3000
#  📱 B 端移动工作台           http://localhost:3001
#  📱 C 端 AI 服务前台 H5      http://localhost:3002
```

**未完成 preview:all 视为环境初始化未完成。** 验收清单：`PREVIEW_CHECKLIST.md`；Mock 口径：`mock/README.md`。

### 1.1 产品形态：客户端即产品（不走浏览器）

**WorkLoom 的正式产品形态是桌面客户端**（对标 WorkBuddy/微信桌面端），浏览器仅作开发调试辅助。
客户端布局必须按窗口真实可用宽度响应式重排，禁止用固定 1440×900 画布或整页缩放冒充响应式。
PC 工作区支持面板折叠、隐藏、拖拽缩放、恢复默认和全屏；窄窗口中的辅助面板降级为抽屉，正文不得横向溢出。

```bash
pnpm app            # 完整客户端：内嵌 server + 可自由缩放窗口 + 系统托盘 + 单实例锁
pnpm app --dev      # 开发姿态（vite HMR）
pnpm app --smoke    # 冒烟验证（CI/无头环境）
pnpm app:pack       # 打出本机可执行包（release/ 免安装目录）
pnpm app:dist       # 打出正式安装包（win NSIS / mac DMG / linux AppImage+deb）
```

- **关窗 = 最小化到系统托盘**（夜班/自动任务持续运行），托盘菜单「退出」才是真退出；
- server 生命周期由客户端主进程内嵌管理，用户无感知；首次 pnpm install 后 Electron
  二进制若未下载，`pnpm app` 自动补下载（npmmirror 镜像），无需人工干预；
- 未初始化环境（缺 .env）会明确指引先 `pnpm setup`；
- **不要只起 `pnpm -C apps/web dev` 就交付**——正确交付是 `pnpm app`（客户端）
  或 `pnpm preview:all`（浏览器三端预览，仅供开发验收）。

## 2. 一键能力巡游（强烈建议进仓第一件事）

```bash
bash scripts/agent-tour.sh          # 环境+数据+服务+浏览器四层自检（约 1~3 分钟）
bash scripts/agent-tour.sh --full   # 追加种子编排 + 全部测试套件 + 发布门禁
```

巡游全绿 = 你已掌握本仓全部能力的调用方式。**全量能力清单见 [`docs/capability-map.md`](docs/capability-map.md)**；
浏览器操作完整指南见 [`docs/agent-computer-guide.md`](docs/agent-computer-guide.md)。

## 3. 系统怎么跑起来

**一键安装（克隆后推荐第一条命令）：**

```bash
pnpm setup                # = scripts/bootstrap.sh：环境检查 → .env 补全 → pnpm install
                          # → PG17+pgvector（docker compose 自动建容器）→ 迁移+全部种子
                          # → computer-use 桌面栈（Ubuntu+root 自动装；--with-computer 强制 / --skip-computer 跳过）
                          # 幂等，可重复跑；全新 Ubuntu 机器实测 10/10 全绿
```

手动分步（等价于上面一条命令）：

```bash
docker compose up -d postgres    # PG17 + pgvector（首次自动建容器 workloom-im-pg）
cp .env.example .env             # 首次必须（db:* 脚本依赖 --env-file=.env）
pnpm install                     # npm 源受限时用 registry.npmmirror.com
pnpm db:migrate && pnpm db:seed  # 迁移 + 演示种子
pnpm dev                         # server :8787（tRPC /trpc/*）+ web :5173
```

验证服务就绪：`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173` 返回 `200`。
（8787 无 `/healthz`，以进程监听为准；跑测试前**先停掉残留的 8787/5173 服务**，否则 E2E 打错库、后台节拍污染断言。）

## 4. 验证纪律（本仓库硬性要求）

- 改完代码必须跑：`pnpm suite`（445 条）；
- 发布前必须跑：`pnpm release:gate`（未全过禁止发布，见 `docs/release-checklist.md`）
- 改事件/号源代码后跑：`pnpm db:verify-chain`
- **UI 改动必须用浏览器能力实际打开页面截图核对**，禁止"改了就算完成"
- 改了能力面（脚本/包/技能/演示页）必须跑 `pnpm capabilities` 重新生成人类版导览；`pnpm capabilities:check` 校验同步

## 5. 仓库速览

| 目录 | 内容 |
|---|---|
| `apps/server` | tRPC 服务端（:8787） |
| `apps/web` / `apps/webb` / `apps/webc` | B 端 PC 工作台 / B 端移动工作台 / C 端移动服务前台 |
| `packages/ui` | 三端唯一基础组件、设计令牌、图标、布局控制与导航语言源；行业仓禁止复制分叉 |
| `packages/industry-contract` | 行业 Bundle 的跨端 UI 投影契约、中文展示与兼容性校验 |
| `packages/base` | 底座包：workdata（事件/RLS）、fence-engine（围栏 DSL）、captain（数字CEO）、computer-use（生产级电脑/浏览器自动操作，见 docs/computer-use-production.md）等 |
| `bundles/` | 示例、行业与平台 Bundle；差异只能通过契约内配置、投影、权限和业务对象表达 |
| `skills/official/` | 自带技能：release-gate / industry-entry / product-feedback |
| `scripts/` | 测试套件、发布门禁、Bundle/三端投影与 UI 治理、能力巡游、三端预览 |
| `docs/` | 设计规范、方案、测试目录、**capability-map.md**、**agent-computer-guide.md** |

## 附：开源组件更新（oss-watch）

> 可选提醒：本机制不做任何强制检查——只有当你（或你的 Agent）主动发起时才执行；平时想看看有没有可更新项，`pnpm oss:plan` 即可。

- 一键触发：`pnpm oss:watch`（扫描到期组件 → 生成 `docs/oss-update-plan.md`）；`pnpm oss:plan` 只看计划。
- 周期：dsh/前端工具链/浏览器自动化=周检，其余=月检，litellm 等有投毒史组件=事件驱动。
- 纪律：扫描可自动，**升级永不自动**——圈定范围 → 逐项升级 → 按 gate 过门禁（smoke/standard/full/runtime-gate）→ 全绿才发布；dsh 永远单独一批。
- 完整机制：`skills/oss-watch/SKILL.md`；组件登记：`oss-components.json`（新装依赖必须同步登记）。
