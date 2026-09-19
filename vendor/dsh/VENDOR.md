# vendor/dsh · DeepSeek Harness fork 锁定信息（D12 / B0）

| 项 | 值 |
|---|---|
| 包 | `@deepseek-ai/dsh`（CLI 聚合包；运行时依赖 `@deepseek-ai/dsh-*` / `cordis-plugin-*` 全家桶） |
| 锁定版本 | `0.1.5-rc.2`（npm 发布时间 2026-09-10T14:57:10Z；rc.6→rc.8→0.1.1-rc.1→0.1.2-rc.1→0.1.5-rc.2 四次升级） |
| 来源 | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz`（npmmirror 同源分发） |
| integrity（入库时实测） | `sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==`（与 registry 元数据逐字符一致 ✅） |
| License | MIT |
| 上游仓库 | `github.com/deepseek-ai/deepseek-harness`（`apps/cli` 目录） |
| 入库日期 | 2026-08-16（rc.6）；2026-08-20 升级 rc.8；2026-08-21 升级 0.1.1-rc.1；2026-09-05 升级 0.1.2-rc.1；2026-09-19 升级 0.1.5-rc.2 |
| 入库方式 | npm tarball 解压至本目录（`--strip-components=1`），未做任何源码修改 |

## 纪律

- 本目录**只读**：任何修改必须先复制出去再改，保持与上游 0.1.5-rc.2 字节一致，可审计。
- 运行时依赖解析仍走 pnpm（`pnpm add @deepseek-ai/dsh@0.1.5-rc.2` 于使用方包）；本目录是**审计基线 + 文档事实源**，升级前对照 diff。
- **升级触发条件（2026-08-20 项目所有者新决策，取代原「稳定 1.x 才升级」旧口径）**：官方仓库任何新版本（**包括 rc/beta/alpha 预发布**）即触发升级，不得等待稳定版、不得以任何理由跳过；升级前跑契约测试/门禁全绿。
- **0.1.2-rc.1 变更面（0.1.1-rc.1→0.1.2-rc.1 实测 diff）**：
  - **新增嵌入式 profile 形态**：`sdk` / `sdk-minimal`（JSON-RPC stdio 为 SDK client 服务）、`acp`（Agent Client Protocol stdio）——dsh 可作为 agent 服务嵌入外部客户端（编辑器等）；
  - agent-presets 从随包目录改为 `dsh.configTrees` 挂载（`config/` 不再随包发布，`scanRoster: true`）；
  - profile manifest 新增 `patchReload` 生命周期（`live` 监视 patch 热重载 / `startup` 仅启动时应用一次）；
  - 全家桶子包统一 bump 0.1.2-rc.1；cordis 4.0.1→4.0.2；新增 `@agentclientprotocol/sdk`、`ws`、`schemastery` 依赖；
  - 图像处理能力进附件链路（`dsh-attachment-local` 引入 `sharp@^0.35.3`，`ImageVariantId` 导出）。
- **0.1.5-rc.2 变更面（0.1.2-rc.1→0.1.5-rc.2 实测 diff；2026-09-19 登记）**：
  - 宏观版本线：`0.1.3-alpha.1/2` → `0.1.5-alpha.1/2` → `0.1.5-rc.1/2`（本轮取 npm `latest` dist-tag = `0.1.5-rc.2`；`alpha` tag 已到 `0.1.6-alpha.2`，**不在本次范围**）；
  - 全家桶子包统一 bump `0.1.5-rc.2`（含新增子包 `dsh-http-proxy`、`dsh-tool-present`；均按 `^0.1.5-rc.2` 上锁，semver 预发布元组规则保证不会漂到 0.1.6 线）；
  - 新增能力（rc.1 汇总口径）：`DeepSeek-V41-Flash`（`deepseek-flash`）模型适配器、Web 任意类型文件上传、可继续对话子代理的消息排队/编辑/Steer、反馈弹窗确认；rc.2 为反馈与交付卡片体验修复；
  - 出站网络请求遵循 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`（0.1.3-alpha.1 起）；
  - 本次锁定树内传递依赖实测：`js-yaml 4.3.2`（dsh 声明 `^4.2.0`，**不跟 npm latest 5.x**）、`node-addon-require-builtin 0.1.6`、`ws 8.21.3`、`sharp 0.35.4`、`cordis 4.0.2`、`schemastery 3.18.2`、`execa 10.0.0`（dsh devDeps 声明，未浮动到 10.0.1）。
- **0.1.2 升级实测坑位（2026-09-05 登记）**：
  ① **Node 版本硬要求**：`dsh-session-persistence-jsonl` 使用 `node:zlib` 的 `createZstdDecompress`（Node ≥22.15，官方 engines ≥24）——Node 22.13 直接启动失败，gate 与生产运行须 Node 24（本仓 CI 已 ≥24）；
  ② 升级后必须**清 lock 重装**（旧 lock 会把全家桶钉在混版，`dsh-llm-deepseek` 与 `dsh-attachment` 错版报 `ImageVariantId` 导出缺失）；
  ③ sharp 原生模块走 `@img/sharp-linux-x64` 可选依赖链，干净安装即自动就位（无需手动 rebuild）。
- 历史坑位（仍有效）：`node-pty` 需 pnpm 侧批准构建脚本（dsh ≥0.1.1-rc.2 已移除该依赖，旧 profile 残留时才需要）。已在 `.dsh profile` 与本仓库根 `package.json` 双处声明。

## 升级验证（2026-09-05）

- E6 dsh-gate 全绿（Node v24.9.0）：用例一全链（headless → 工具调用 → 围栏瀑布 deny 优先 → 事件落账，哈希链 38 条逐条重算通过）；用例二 H-5（kill -9 崩溃现场 → 链完整 26 条 + 重放零重复事件）。

## 升级验证（2026-09-19 · 0.1.5-rc.2）

- 安装纪律：**清 lock 重装**（`packages/runtime/dsh-gate`：删旧 lock + 删 node_modules → `pnpm install --ignore-workspace`，pnpm 10.14.0 / Node 24.19.0），避免全家桶混版；`node-pty` 仍在锁定树内，`onlyBuiltDependencies` 放行预构建通过。
- E6 dsh-gate 全绿（Node v24.19.0）：用例一全链（headless → 工具调用 → 围栏瀑布 deny 优先 → 事件落账，哈希链 24 条逐条重算通过）；用例二 H-5（kill -9 崩溃现场 → 链完整 20 条 + 会话事件重放零重复）。
- 变更统计：`packages/runtime/dsh-gate/pnpm-lock.yaml` 全量重算（564 包）；`@deepseek-ai/*` 家族整体 0.1.2-rc.1 → 0.1.5-rc.2。

## 参考文档（上游 repo `docs/`，2026-08-16 核验）

- `docs/architecture.zh.md` — 总体架构
- `docs/capability-seams.zh.md` — 全部能力 seam 与核心服务清单（D12 seam 表的官方依据）
- `docs/cookbook/extension-cookbook.zh.md` — 钩子插件 / 工具插件 / UI 插件 / 协议驱动形态
- `docs/cordis-tutorial/01-first-plugin.zh.md` — Cordis 插件最小范式（`export apply(ctx)`）
- `docs/subsystems/{session,persistence,approval,jobs,skills,invariants,credentials}.zh.md`
- `docs/user/develop/practice/llm-adapter.zh.md` — 自研 LLM adapter 指南
