# safety/ · 仙女座运维安全保障机制（一方资产）

> 对焦方案 V1.0 已批准实施（2026-09-06）。本目录与 `platform-ops/src/safety/` 共同构成四层防线：
> **事前预防 / 事中控制 / 事后恢复 / 容灾切换**。
> 本目录自身在保护清单内（safety-self：C3 双人复核 + 沙箱演练）——**改保险丝须另一把保险丝同意**。

## 目录与模块映射

| 资产 | 位置 | 防线 |
|---|---|---|
| 保护清单单一事实源 | `safety/protected-paths.json` | 事前（防误删误改硬边界） |
| 变更分级器（C0-C3，就高不就低） | `platform-ops/src/safety/change-classifier.ts` | 事前 |
| 保护清单闸（deny/require/冷静期/带外检测） | `platform-ops/src/safety/protected-paths.ts` | 事前 + 事中 |
| 变更闸门流水线（G1-G6 + hotfix 快轨） | `platform-ops/src/safety/change-gate.ts` | 事前 |
| 影响范围分析（依赖反索引/schema 兼容/扇出预估） | `platform-ops/src/safety/blast-radius.ts` | 事前（T6 级联放大总闸） |
| 熔断体系（全局变更冻结/资产熔断/围栏异动 3σ） | `platform-ops/src/safety/change-freeze.ts` | 事中 |
| 主备切换（fencing token/探针/切换判定/回切规划） | `platform-ops/src/safety/standby.ts` | 容灾 |
| 沙箱验证（S-1/S-2 声明式剧本，G5 闸） | `platform-ops/src/safety/sandbox.ts` | 事前 |
| CI 闸门 | `.github/workflows/safety-gate.yml` | 事前（workflow 不在同步范围） |
| CI 保护清单闸入口 | `platform-ops/bin/guard-diff.mts` | 事前 |
| 镜像备份（工蜂/CNB 双托管，已对焦落点） | `platform-ops/bin/mirror-backup.mjs` + `safety/mirror-targets.example.json` | 事后 |
| 故障演练手册 | 本文件 §演练制度 | 事后 + 容灾 |

## 已对焦的关键决策

1. **AI 开发体一律走 PR + 闸门**（永不直推 main；紧急修复走 hotfix 快轨，不跳考试院硬轨）；
2. **P0 授权自动主备切换**：探针连续 3 分钟全断 + 备库健康 + 抢到 fencing 租约，三条件齐备先斩后奏；
3. **镜像备份落点：工蜂/CNB 双托管**（异构托管，防平台级事故）；
4. 实施顺序 P1→P5 全量（本次全部落地）。

## 故障演练制度（每季度一次，演练即考试）

| 演练科目 | 注入方式 | 验收标准 | 时限 |
|---|---|---|---|
| 杀主库 | 停 PG 主进程 | 备库自动提升（三条件自动切换），写入恢复 | RTO ≤60s |
| 杀 Redis | 清空实例 | 降级不宕机：限流退单机桶、投影回源 PG；重放重建 | RTO ≤10min |
| 误删保护文件 | 模拟 AI 误删 fence-engine | CI 保护清单闸 deny + 镜像仓恢复 | 恢复 ≤30min |
| 备库带病切换 | 备库延迟 >60s 时请求切换 | 切换被拒（forbid）+ 告警 | 即时 |
| 断链注入 | 篡改一条事件 hash | 增量验链 P0 + 事件库只读化 | 检测 <5s |

演练报告进知识库；未达标项进整改工单；**恢复能力不是文档，是每季度真刀真枪验过的**。

## 应急六步（P0/P1 通用）

发现（监控/告警）→ 宣告（事件+级别+值班人确认）→ 止血（熔断/冻结/切换——先止住再诊断）→
诊断（账本时间线+trace）→ 恢复（回滚/切换/重建）→ 复盘（根因五问+整改工单+**转化为新考题/新围栏**）。
