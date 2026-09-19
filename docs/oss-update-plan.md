# 开源组件更新计划（oss-watch）

> 生成：2026-09-19T10:16:38.000Z ｜ 登记组件有更新 **12** 个 ｜ 直接依赖有更新 **13** 个
> 使用：Agent 按清单组批 → 逐项升级 → 按 gate 过门禁 → 门禁全绿后按协议 §1/§9.5 合并。破坏性/大版本升级须在 PR 显著标注并按 §3 人审放行；人保留叫停与回滚权。

## 一、登记组件更新（待处理：AI 组批执行，破坏性升级人审放行）

| 组件 | 现版 | 最新 | 周期 | 门禁 | 备注 |
|---|---|---|---|---|---|
| `yaml` | 2.9.0 | **2.9.1** | monthly | standard | bundle 与技能 YAML 解析器；与 yaml-governance（治理固定解析器）同版。【2026-09-19 |
| `js-yaml` | 4.2.0 | **5.4.2** | monthly | standard | dsh CLI 配置解析依赖；随 dsh 锁定树升级。【2026-09-19】dsh 0.1.5-rc.2 声明 ^4. |
| `Execa` | 10.0.0 | **10.0.1** | monthly | standard | 子进程调用封装（随 dsh vendor 基线声明，非本仓直接依赖）；【2026-09-19】dsh 锁定树实测仍为 1 |
| `ws` | 8.21.0 | **8.21.3** | monthly | full | WebSocket 服务端；升级后过实时通道与重连用例 |
| `NATS Server（内嵌事件总线）` | v2.11.4 | **v2.15.0** | monthly | full | 官方二进制 pin 版本 + 校验下载；桌面端以 JetStream 形态拉起；二进制缺失时显式降级 memory 形态 |
| `React` | 19.2.8 | **19.3.0** | monthly | full | React 19；与 react-dom、@types/react 同批升级；升级后必须过三端视觉与交互门禁。【2026 |
| `react-dom` | 19.2.8 | **19.3.0** | monthly | full | 必须与 react 严格同版 |
| `pixi.js` | 6.5.10 | **8.21.0** | monthly | full | 当前锁 v6 线（pixi-live2d-display 兼容上限）；升级 v7/v8 必须同步替换 live2d 显示 |
| `Node.js` | 24.19.0 | **v26.9.0** | monthly | full | 引擎下限 >=24（dsh 的 zstd 会话持久化要求）；桌面载荷内嵌 24.19.0，升级需重建载荷并过 app 冒 |
| `pnpm` | 10.14.0 | **12.4.2** | monthly | standard | lockfile v9 格式；升级必须九仓同步（packageManager 字段），否则 frozen-lockfil |
| `npm（桌面载荷安装器）` | 11.17.0 | **12.0.2** | monthly | standard | 载荷安装器版本与 package-lock.json 绑定；升级需重跑 runtime:deps:refresh/ver |
| `Playwright（Python · computer-use 工具链）` | >=1.40.0 | **1.45.1** | monthly | standard | 与 Node 侧 @playwright/test 独立版本线；浏览器二进制由 playwright install 管 |

## 二、执行剧本（逐项）

1. 每项单独 commit：`pnpm update <pkg>@<latest>`（工作区包用 `pnpm -C <包目录> update`）→ 更新 `oss-components.json` 的 current
2. 门禁：smoke=`pnpm typecheck`｜standard=+`pnpm test`｜full=+`pnpm suite`｜runtime-gate=+`bash scripts/dsh-gate.sh`
3. 失败立即回滚该批并在本文件标「⛔ 阻塞」；全绿 → push 并标「✅ 已发布(hash)」
4. dsh 永远单独一批；发布前建议先做仓库快照（git bundle）

## 三、新能力评估（人工裁决区 · 大版本升级必填）

> 底层升级常带来新能力而非仅修复。下列大跨度项请逐项评估「能否产品化」，结论写回本文件。

| 组件 | 跨度 | 发布说明 | 新能力线索与产品化设想（人工填写） |
|---|---|---|---|
| `yaml` | 2.9.0 → 2.9.1（minor/patch） | 见 repo releases |  |
| `js-yaml` | 4.2.0 → 5.4.2（⚠ major） | 见 repo releases |  |
| `Execa` | 10.0.0 → 10.0.1（minor/patch） | 见 repo releases |  |
| `ws` | 8.21.0 → 8.21.3（minor/patch） | 见 repo releases |  |
| `NATS Server（内嵌事件总线）` | v2.11.4 → v2.15.0（minor/patch） | 见 repo releases |  |
| `React` | 19.2.8 → 19.3.0（minor/patch） | 见 repo releases |  |
| `react-dom` | 19.2.8 → 19.3.0（minor/patch） | 见 repo releases |  |
| `pixi.js` | 6.5.10 → 8.21.0（⚠ major） | 见 repo releases |  |
| `Node.js` | 24.19.0 → v26.9.0（⚠ major） | 见 repo releases |  |
| `pnpm` | 10.14.0 → 12.4.2（⚠ major） | 见 repo releases |  |
| `npm（桌面载荷安装器）` | 11.17.0 → 12.0.2（⚠ major） | 见 repo releases |  |
| `Playwright（Python · computer-use 工具链）` | >=1.40.0 → 1.45.1（⚠ major） | 见 repo releases |  |

## 四、直接依赖更新（全量清单扫描结果）

| 包 | 现版 | 最新 | 类型 | 备注 |
|---|---|---|---|---|
| `@types/node` | 24.13.3 | 26.6.2 | dev | — |
| `@types/react` | 19.2.0 | 19.3.0 | dev | — |
| `@types/react-dom` | 19.2.0 | 19.3.0 | dev | — |
| `execa` | 10.0.0 | 10.0.1 | dev | 随 dsh 批次 |
| `js-yaml` | 4.2.0 | 5.4.2 | prod | 随 dsh 批次 |
| `node-addon-require-builtin` | 0.1.4 | 0.1.6 | prod | 随 dsh 批次 |
| `pixi.js` | 6.5.10 | 8.21.0 | prod | — |
| `react` | 19.2.8 | 19.3.0 | dev/prod | — |
| `react-dom` | 19.2.8 | 19.3.0 | dev/prod | — |
| `typescript-governance` | 5.9.3 | 7.0.2 | dev | — |
| `ws` | 8.21.0 | 8.21.3 | dev | 随 dsh 批次 |
| `yaml` | 2.9.0 | 2.9.1 | dev/prod | — |
| `yaml-governance` | 2.9.0 | 2.9.1 | dev | — |

> 说明：直接依赖含传递层升级线索；批量升级前先按「登记组件」批次处理运行时关键路径，避免一次跨度过大。
