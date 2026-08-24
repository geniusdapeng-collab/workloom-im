---
name: workloom-release-gate
description: WorkLoom 发布上线前三链路校验门禁（强制红线，自动调用）。凡是使用 WorkLoom 底座的产品（WorkLoom GEO / HyperReality / 酒店等）交付或更新版本前，必须执行三条主链路全量回归：ASK 问答模式、QUEST 任务模式、自动化任务编排。任一未过 = 禁止发布。触发场景：发布、上线、交付版本、push 前检查、release、发版。
---

# WorkLoom 发布上线前三链路校验（强制红线）

## 触发即执行

当用户表达「发布 / 上线 / 交付版本 / 发版 / push 这一版」意图，且目标仓库使用 WorkLoom 底座（识别特征：`packages/base`、`packages/runtime`、`scripts/suite.ts`、`pnpm-workspace.yaml` 含 `apps/* + packages/*`）时，**必须**先执行本门禁，再谈发布。不得跳过。

## 三条主链路（以 WorkLoom 实际三模式为准）

| 链路 | 校验要点 | 门禁用例 |
|---|---|---|
| **ASK 问答模式** | 一句话问答响应正常，覆盖常见场景，无超时/报错/空返回 | 演示工作区真实提问：意图路由 = ask、应答非空（>10 字）、via 留痕、30s 内返回 |
| **QUEST 任务模式** | 一句话自动拆解多步骤任务，创建→拆解→执行流程完整 | 真实目标派遣：拆解 ≥2 步、线程可回读、事件流留痕完整 |
| **自动化任务编排** | 编排引擎正常，触发条件、执行逻辑、回调机制无误 | 触发器在位启用（每工作区 ≥3）、节拍执行→回调落账 +1、全库哈希链验链一致 |

## 标准执行流程

```bash
# ① 环境就绪（仓库根目录）
docker start workloom-im-pg 2>/dev/null   # PostgreSQL 17 + pgvector
pnpm db:migrate && pnpm db:seed && pnpm db:seed:video   # 有 geo 域再加 pnpm db:seed:geo
pnpm -C apps/server dev &                  # API :8787（web 非必需）

# ② 底座回归（双保险）
pnpm suite          # 全场景套件（445 用例，含 E2E 权限矩阵）
pnpm suite:geo      # 存在 bundles/geo-growth 时执行（77 用例）

# ③ 三链路门禁（强制红线）
pnpm release:gate   # 12 项校验（工作区自适应）；任一失败 exit 1 = 禁止发布
```

## 环境适配规则

- **沙箱环境**：`LLM_PROVIDER=mock`（内置 AI 模型驱动，确定性剧本兜底，离线全链路可跑）
- **线上环境**：`LLM_PROVIDER=deepseek|moonshot|zhipu|openai` + 独立部署端点/密钥
- 门禁启动时自动打印当前环境口径，发布记录必须注明。

## 发布强制红线

1. 三条主链路测试未全部通过 → **禁止发布**，无例外。
2. 历史教训：曾有版本发布后出现 ASK 模式故障——每次发布前必须主链路全量回归。
3. 发布前同步确认：`git status` 干净、迁移已应用（`pnpm db:migrate` 无 pending）、验链通过（`pnpm db:verify-chain`）。

## 缺陷档案（门禁实战擒获，排查时先对照）

| 症状 | 根因 | 修复落点 |
|---|---|---|
| 第二次派遣即 `duplicate key threads_pkey` | 可读号按本区分配 + 主键全库唯一 + PG 不支持 `\d` 正则 | 迁移 0016 号源函数（SECURITY DEFINER 全库最大值） |
| 事件「写入成功」却查不到 | 号源查询在 RLS 上下文内只见本区，撞他域号段被幂等静默吞掉 | 迁移 0015 `biz_events_max_event_no` 绕 RLS 全租户口径 |
| 线程号指数爆炸（T-133111…，20 位溢出） | pg 驱动 bigint 返回 string，`+1` 变字符串拼接 | 调用点 `Number()` 转换 |
| 围栏该 review 却全 block | DSL 不支持 `in`/`contains_any` + 缺失路径即抛错 | expr.ts DSL 扩展 + 缺失路径比较语境宽容 |
| QUEST 内容域目标只拆 1 步 | planQuest 模板仅酒店域 | loop.ts 内容生产链五步模板 + dispatch 注入 llmCall |
| 装配校验他域 Bundle 恒红 | 探针被 RLS 锁在当前工作区 | assembly.ts 切 Bundle 属地查验 |
| mock 测试报「mock 未覆盖 SQL」 | 号源函数 SQL 未注册进测试 mock | 测试文件补 `biz_events_max_event_no` 匹配 |

## 跨产品同步纪律

- 底座修复（`packages/base`、`packages/runtime`、`apps/server`、`packages/db/migrations`）必须同步到全部 WorkLoom 系列仓库（当前：workloom、hyperreality-system），并逐库验证：`suite + base 单测 + typecheck + release:gate` 全绿后分别 push。
- 发布门禁 `scripts/release-gate.ts` 为工作区自适应设计，直接拷贝即可在其他底座产品使用。

## 记忆锚点

- 组织记忆：`org_memory.mem-release-gate-*`（ws-yunqi / ws-video / ws-geo，SOP，confidence 0.95）
- 政策文档：`docs/release-checklist.md`
- 可执行门禁：`scripts/release-gate.ts`（`pnpm release:gate`）
