# vendor/dsh · DeepSeek Harness fork 锁定信息（D12 / B0）

| 项 | 值 |
|---|---|
| 包 | `@deepseek-ai/dsh`（CLI 聚合包；运行时依赖 `@deepseek-ai/dsh-*` / `cordis-plugin-*` 全家桶） |
| 锁定版本 | `0.2.0-rc.2`（npm 发布时间 2026-09-29T09:56:27Z；rc.6→rc.8→0.1.1-rc.1→0.1.2-rc.1→0.1.5-rc.2→0.1.6-alpha.2→0.2.0-rc.2 六次升级） |
| 来源 | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz`（npmmirror 同源分发） |
| integrity（入库时实测） | `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==`（与 registry 元数据逐字符一致 ✅；sha1 `dfc8f7e09cfa96b854d6f0cf3a973ce7f2948925` 同步核对） |
| License | MIT |
| 上游仓库 | `github.com/deepseek-ai/deepseek-harness`（`apps/cli` 目录） |
| 入库日期 | 2026-08-16（rc.6）；2026-08-20 升级 rc.8；2026-08-21 升级 0.1.1-rc.1；2026-09-05 升级 0.1.2-rc.1；2026-09-19 升级 0.1.5-rc.2；2026-09-20 升级 0.1.6-alpha.2；**2026-09-30 升级 0.2.0-rc.2（本轮；npm `latest`/`next` 同指，首次跨 minor 线）** |
| 入库方式 | npm tarball 解压至本目录（`--strip-components=1`），未做任何源码修改 |

## 纪律

- 本目录**只读**：任何修改必须先复制出去再改，保持与上游 0.2.0-rc.2 字节一致，可审计。
- 运行时依赖解析仍走 pnpm（`pnpm add @deepseek-ai/dsh@0.2.0-rc.2` 于使用方包）；本目录是**审计基线 + 文档事实源**，升级前对照 diff。
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

- **0.1.6-alpha.2 变更面（0.1.5-rc.2→0.1.6-alpha.2 实测 diff；2026-09-20 登记）**：
  - 宏观版本线：`0.1.6-alpha.1` → `0.1.6-alpha.2`（npm `latest`/`next` 仍指 `0.1.5-rc.2`，本版本只在 `alpha` tag；按 2026-08-20 项目所有者口径跟进）；
  - 依赖面变化：新增 `dsh-hmr`（替代 `cordis-plugin-hmr`）、`dsh-workflow-ptc`（替代 `dsh-workflow-worker-thread`）、`dsh-mcp-resources`、`dsh-plugin-manager`、`dsh-atomic-write`、`dsh-experimental-agent-team-profile` / `-web-profile`；devDeps 新增 `dsh-experimental-ptc-runtime-python`、移除 `dsh-experimental-code-runtime-python`；
  - 首次随包发布 **TypeScript 类型声明**（`lib/types/*.d.ts`，`files` 白名单同步扩为 `lib/types/*.d.ts`）；
  - 新增能力（alpha.1 汇总）：Web 侧边栏终端（多标签 / Shell 选择 / 刷新保持）、已归档会话列表、MCP 资源发现与 URI 模板、headless 支持 stdin 任务与 `--session-id`/`--json`、SSH 远端工作区、实验性 Browser Use（Playwright MCP + Chromium）；
  - 新增能力（alpha.2）：插件管理页（安装/改配置/实时启停）、回合结束文件改动卡片与逐文件审阅、Office 文档预览（Word/Excel/PowerPoint）、侧边栏浏览器模式访问 URL、侧边栏打开 Subagent 会话与提交计划预览。

## 升级验证（2026-09-20 · 0.1.6-alpha.2）

- 安装纪律：**清 lock 重装**（`packages/runtime/dsh-gate`：旧 lock 与 node_modules 移出 → `pnpm install --ignore-workspace`，pnpm 10.14.0 / Node 24.19.0）。
- E6 dsh-gate 全绿：用例一全链（headless → 工具调用 → 围栏瀑布 deny 优先 → 事件落账，哈希链 24 条逐条重算通过）；用例二 H-5（kill -9 崩溃现场 → 链完整 6 条 + 会话事件重放零重复）。
- 基座回归：`pnpm test` 全绿（base 679 / server 133 / web 67 / webb 6 / webc 21 + 脚本门禁）；`pnpm runtime:deps:verify` 通过；`pnpm oss:check` 随清单重算转绿。

## 0.2.0-rc.2 变更面（0.1.6-alpha.2→0.2.0-rc.2 实测 diff；2026-09-30 登记）

- **宏观版本线**：`0.1.7-alpha.2` → `0.1.7-rc.1` / `0.1.7-rc.2` → `0.2.0-rc.1` / `0.2.0-rc.2`；本轮取 npm `latest` dist-tag = `0.2.0-rc.2`（与 `next` 同指，`alpha` tag 仍停在 `0.1.7-alpha.2`）。这是本仓**首次跨 minor 线**（0.1 → 0.2）。
- **依赖面（名称级实测 diff）**：新增 `dsh-agent-preset`、`dsh-experimental-auto-review`、`dsh-experimental-schedule-bundle`、`dsh-experimental-voice-input-bundle`、`dsh-skill-office`、`dsh-tool-workspace-dependencies`；移除 `dsh-experimental-agent-team-web-profile`。
- **版本声明口径变化（重要）**：家族子包（74 项）由 `^0.1.6-alpha.2` 改为**精确 pin `0.2.0-rc.2`**，cordis 由 `^4.0.2` 改为 `~4.0.4`——上游不再用 caret 表达家族版本，混版风险下降但升级必须整体换。
- **插件兼容性门禁（新）**：安装与 profile 启动会按插件声明的 DSH peer 范围校验运行时版本；不兼容插件需显式豁免：`dsh plugin allow-version <pkg@ver> --dsh-version <exact> --accept-risk`（配套 `revoke-version` / `version-exemptions`）。**`vendor/dsh-im` 0.2.2 未声明 dsh peer 范围，不受该门禁阻断**；但其上游 npm 已到 4.x，属独立评估项（见任务回执）。
- **新增 CLI 能力**：`--dump-config-schema`（导入组合树插件声明的 schema，打印 entry/patch 的 JSON Schema 而不装配，用于审查不受信任插件）。
- **desktop profile 收紧**：npm CLI 拒绝 `--profile desktop` 的插件管理请求，改由 Desktop 内置命令运行时接管。
- **原生依赖新增**：`koffi`（经 `dsh-subprocess-local` 引入）。pnpm 默认阻断其 install 脚本**不影响运行**——平台预编译包 `@koromix/koffi-<platform>` 随 optional deps 安装（本机实测 `darwin_arm64/koffi.node` 就位）；本次未把它加入 `onlyBuiltDependencies`。
- **配置样例面变化**：`config/examples/` 不再随包提供「会话内 Schedule」（迁至 `dsh-experimental-schedule-bundle`）。

## 升级验证（2026-09-30 · 0.2.0-rc.2）

- 安装纪律：**清 lock 重装**（`packages/runtime/dsh-gate`：旧 lock 移出至仓外 → `pnpm install --ignore-workspace`，pnpm 10.14.0 / Node 24.19.0），实装 532 包；本机到 `registry.npmjs.org` 存在 socket 超时，本次安装走 `registry.npmmirror.com` 同源镜像，**完整性仍由 vendor tarball 的 sha512 逐字符核对兜底**（见上表 integrity 行）。
- E6 dsh-gate 全绿：用例一全链（headless → 工具调用 → 围栏瀑布 deny 优先 → 事件落账，哈希链 **24 条**逐条重算通过）；用例二 H-5（kill -9 崩溃现场 → 链完整 **18 条** + 会话事件重放零重复）。
- 门禁可运行性修复（随本轮一并落地）：`scripts/dsh-gate.sh` 的 Mock LLM/围栏规则源端口改为可由 `DSH_GATE_MOCK_PORT` 覆盖（默认仍 8799）；`settings.yaml` 与 `profile.cordis.patch.yml` 改用 `__MOCK_PORT__` 占位。原因：本机 8799 被常驻进程 `~/.codex/deepseek-proxy/proxy.py` 占用，固定端口会让门禁在并行会话环境下不可运行。
- 未执行项（如实登记）：本仓 `pnpm test` / `pnpm runtime:deps:verify` 未在本轮重跑——改动面为 vendor 基线与 dsh-gate pin，未触及 `packages/**`、`apps/**` 生产代码；该组件的指定回归即 E6+H-5（`oss-components.json#gate=runtime-gate`），已全绿。

## 参考文档（上游 repo `docs/`，2026-08-16 核验）

- `docs/architecture.zh.md` — 总体架构
- `docs/capability-seams.zh.md` — 全部能力 seam 与核心服务清单（D12 seam 表的官方依据）
- `docs/cookbook/extension-cookbook.zh.md` — 钩子插件 / 工具插件 / UI 插件 / 协议驱动形态
- `docs/cordis-tutorial/01-first-plugin.zh.md` — Cordis 插件最小范式（`export apply(ctx)`）
- `docs/subsystems/{session,persistence,approval,jobs,skills,invariants,credentials}.zh.md`
- `docs/user/develop/practice/llm-adapter.zh.md` — 自研 LLM adapter 指南
