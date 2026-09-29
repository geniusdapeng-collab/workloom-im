# M4 交付面验证报告（workloom-im · T-2026-0929-0200）

> 审计基线：`4ff9943f0e5b331619a67db06af32ec09e9d8616`（task/T-2026-0929-0200）
> 环境档位：**local-preview（本机真实数据库 + 真实服务端 + 真实鉴权；出厂默认配置）** —— 不是生产实测
> 执行会话：M4 交付面子会话（发现者；未参与修复）
> 本报告只覆盖 M4（装得上 / 跑得起 / 用得稳 / 攻不破）；M1/M2/M3 见各自报告段

## 覆盖率声明

- 范围内交付面项：**11 项**（构建门禁 3 / 安装自包含 3 / 安全边界 5 类 / 性能 1 / 可观测 1）
- 精读（A 级）：`scripts/release-gate.ts`、`scripts/suite.ts`（端口与 stub 段）、
  `apps/server/src/index.ts`、`apps/server/src/service/gateway.ts`（限流/会话/工单段）、
  `apps/server/src/service/channels.ts`、`apps/server/src/trpc/context.ts`、
  `apps/server/src/trpc/router.ts`（auth/approvals/batch 段）、`packages/base/tenancy/auth.ts`、
  `apps/desktop/electron/bootstrap.cjs`（载荷校验→首装配置→DB 引导段）、`.cnb.yml`（static-gate / db-gate 全段）、
  `electron-builder.yml`、`scripts/bootstrap.sh`、`scripts/preview-all.sh`、`scripts/pack-electron-payload.sh`、
  `packages/db/migrations/{0001,0007,0030}.sql`、`.env.example`
- 机检/脚本解析（B 级）：`.cnb.yml` 流水线全景 grep、发布工作流产物名 grep、全仓 `NODE_ENV|JWT_SECRET|SERVICE_C_*` 引用扫描
- 真机实测（A 级）：见「过程实录」——全新库安装+门禁、28 项安全探针、5 项可观测探针、4 接口性能探针、
  端口劫持三件套实证、发布门禁生产/开发双档对照
- 抽样（C 级）：无
- 未读（D 级）：桌面安装包**未实际构建**（`pack-electron-payload.sh` + electron-builder 需拉取 Node/PG/nats 二进制与公证链，
  本机无网络到 github.com），因此「装得上」的结论来自载荷装配代码 + 载荷/首启单测（A）+ 发布产线配置（A），
  不是从 DMG/EXE 实跑得出

## 结论速览

| 交付面 | 结论 | 关键证据 |
|---|---|---|
| 构建与门禁（默认口径） | **通过** | typecheck 9s 全绿；`pnpm test` 39s 全绿（257 条 DB 集成按门槛跳过，README 已声明） |
| 构建与门禁（CI db-gate 口径） | **不通过** | 全新库上 `apps/server` E2E 13 条失败（MC-204 端口劫持）；`pnpm suite` 因 8791 占用崩溃（MC-205/MC-107） |
| 发布红线门禁 | **形态相关** | 开发档 11/11 准许发布；生产档 5/11（MC-203） |
| 安装自包含 | **代码与单测通过，打包未实跑** | 载荷完整性 fail-closed、首启随机化、升级保留配置均有断言且全绿；缺口见 MC-207/MC-208 |
| 安全边界 | **通过（1 项配置缺口）** | 28/28 探针通过；唯一缺口是出厂 `.env.example` 的演示直登开关（MC-207） |
| 性能 | **通过（1 项结构性隐患）** | 20k 审批 / 101k 事件下四接口 p95 ≤ 28ms，500ms SLO 无违例；队列无覆盖索引（MC-209） |
| 可观测 | **通过** | 5xx → 服务端日志（path/code/ref）+ `system.error` 事件；恢复后自愈；4xx 不写系统错误 |

## 过程实录（可复跑）

1. **全新环境安装 + 门禁**（`work/m4/fresh-install-gate.sh`）：新建库 → `.env.example` 派生 `.env` →
   迁移（40 文件）→ seed-aipm → 幂等验证 → hotel 种子 ×2 → verify-chain → shared/base/runtime/server 测试 → suite
   （附：三端生产构建 `pnpm -C apps/{web,webb,webc} build` 全绿，耗时 4s/1s/2s；
   PC 端主 chunk 2,617.91 kB（gzip 745.93 kB）触发 Vite >500kB 体积告警 —— 记录在案，未上账）
2. **安全探针** 28 项：绑定地址（仅 127.0.0.1）、CORS（非回环不回 ACAO）、跨工作区读线程返回 null/[]、
   跨工作区审批裁决被拒且状态不变（正对照：本区可读）、队列仅含本区条目、readonly 派单/审批 403、
   注入式标题按字面存储且不破坏库、超长标题 400、C 端用户隔离 404、`/c/chat` 超长 400、非法 kind 400、
   每用户限流 429、无/伪造/错钥令牌 401、生产档演示直登 403
3. **端口劫持三件套**：外部进程占 8795（E1）→ 其 `/health` 自述与真实服务完全同形（E2）→
   同命令拉起自有服务立即 EADDRINUSE（E3）→ 套件仍在外部实例上断言（E4/E5）
4. **发布门禁双档对照**：同一 commit、同一 DB，仅差 `NODE_ENV`
5. **可观测探针**：临时收回 `workloom_app` 对 approvals 的 SELECT → 500 → 日志 + 事件 → 授权恢复 → 接口自愈
6. **性能探针**：先测基线，再插入 20k 审批 + 3k 线程 + 100k 事件后复测，并取 `EXPLAIN (ANALYZE, BUFFERS)`

## 证据分级（结论逐条）

| 结论 | 等级 | 依据 |
|---|---|---|
| 服务默认只绑回环、生产档 CORS 仅回环来源 | A | 代码 `apps/server/src/index.ts:32-42,166-169` + `lsof` 实测 + 响应头实测 |
| 三端生产构建可通过 | A | 三次构建实测 exit=0；PC 端体积告警已记录 |
| 仓库未配置 lint 门禁（无 eslint/biome 配置） | B | 全仓机检；静态质量由 `typecheck` + `ui:governance` + `product:verify` + `capabilities:check` 承担，本报告不将"lint 全绿"列为通过项 |
| 跨租户读/裁决不泄露、只读角色 403、批量高危逐条跳过 | A | 28 项探针实测 + DB 状态前后对照 |
| 5xx 有日志与事件留痕、无吞错 | A | 可观测探针实测（日志行含 ref、`system.error` 计数 0→1） |
| 5xx 回传内部实现细节 | A | 实测响应体 `permission denied for table approvals`、约束名回落 |
| 出厂 `.env.example` 使生产档开放匿名 C 端会话 | A | 实测 `POST /c/session` → 200 + token（NODE_ENV=production） |
| 发布门禁与生产档互斥 | A | 双档实测 5/11 vs 11/11 + 代码定位 |
| 桌面首启随机化集合缺 `SERVICE_C_SECRET` | A（代码）+ B（单测覆盖范围） | `bootstrap.cjs:948-951` 与 `bootstrap.test.cjs` 断言清单 |
| 队列/任务列表无 ORDER BY 覆盖索引 | A | `EXPLAIN` 实测 + 放大前后时序 |
| 桌面安装包可零依赖首启 | A（代码/单测）**未实跑** | `bootstrap.cjs` 载荷校验段 + `bootstrap.test.cjs` 全绿 |
| GitHub Releases 是否仍在供货 | **D** | 本机到 github.com 直连与代理均不可达，无法核实 |

## 本会话上账（10 张问题卡）

| 卡号 | 级别 | 标题 | 断言信号 |
|---|---|---|---|
| MC-201 | P1 | 客户安装指引承诺的 WorkLoom-macOS.zip 在产线不存在 | `assert-m4.sh MC-201` |
| MC-202 | P1 | 桌面发布链路只在 GitHub，CNB 无桌面流水线 | `assert-m4.sh MC-202` |
| MC-203 | P1 | 发布门禁与生产档运行时互斥（5/11 vs 11/11） | `assert-m4.sh MC-203` |
| MC-204 | P1 | E2E 固定端口 8795 且不校验实例归属（假红/假绿） | `assert-m4.sh MC-204` |
| MC-205 | P2 | suite stub 端口 8791 硬编码（与 MC-107 同源，以 MC-107 为修复锚点） | `assert-m4.sh MC-205` |
| MC-206 | P2 | tRPC 未脱敏，5xx 回传表名/约束名 | `assert-m4.sh MC-206` |
| MC-207 | P2 | 演示直登开关随出厂配置进入生产档 | `assert-m4.sh MC-207` |
| MC-208 | P2 | 桌面首启不随机化 C 端签名密钥 | `assert-m4.sh MC-208` |
| MC-209 | P2 | 队列/任务 ORDER BY 无覆盖索引 | `assert-m4.sh MC-209` |
| MC-210 | P2 | 验链子进程 1MB 缓冲，异常账本报 ENOBUFS | `assert-m4.sh MC-210` |

全部断言当前为 **FAIL（问题存在）**，修复后应转 PASS；断言脚本随台账放在
`outputs/mine-clear/T-2026-0929-0200/assertions/assert-m4.sh`。

## 收尾报告

- **已完成**：构建与门禁（默认口径 + CI db-gate 口径 + 发布门禁双档）、安装自包含代码与单测审查、
  安全边界 28 项真机探针、可观测 5 项探针、真实数据量性能探针（含 EXPLAIN）、10 张问题卡上账、
  11 项门禁结果写入台账 `gates`
- **未完成/未覆盖**：① 桌面安装包未实际构建与首启实跑（需拉取平台二进制，本机网络不可达）；
  ② GitHub Actions 可用性无法核实（同上）；③ UI 层（三端页面）未做视觉/交互验收——属 M3/RDAS 域
- **自主追加事项及理由**：① 额外做了「端口劫持」因果链实证（M4 清单只要求"记录耗时与警告"，但
  E2E 门禁的失败无法解释来源时结论不可信，故补证）；② 额外把台账 `gates` 填满 11 项，使 M6 能直接复核
- **采用的假设**：① 以 `.env.example` 派生 `.env` 作为"客户拿到手的出厂形态"；
  ② 以本机 PG17 + 独立库替代 docker compose 的 PG 容器（容器与本机库版本一致）；
  ③ `ws-yunqi` 作为验收工作区（CI 同口径 `SERVICE_C_TEST_WORKSPACE_ID`）
- **置信度**：**高**（安全/可观测/性能/门禁均有真机响应与 DB 前后对照；仅"装得上"一项为代码+单测级，
  已显式降级声明）
- **建议复核**：① MC-203 的生产/开发双档对照日志（复制即验）；② MC-204 的端口劫持三件套；
  ③ MC-207 的 `POST /c/session` 生产档实测响应

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？（M4 清单 5 项全做；2 项因环境受限显式声明）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？（D 级项已单列）
- [是] 经得起资深工程师逐行审查？（断言脚本自带 fail-closed 守卫，避免连接失败被读成"通过"）
