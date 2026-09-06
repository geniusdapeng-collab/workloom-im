# platform-ops · 仙女座运营运维系统 —— 平台一方工程能力

> **一方资产边界（必读）**：本目录是**平台官方自用的服务治理工程能力**（PRD V3.0 第十五~二十一章），
> 只存在于 `workroom-andromeda` 仓。它不是通用基座能力，**永不进入 base-sync 同步流**——
> 同步护栏：`sync/base-scope.json` pollutionGuard 黑名单含 `platform-ops`（推送前硬校验中止）+
> `sync/child-repos.json` andromeda `extraExclude: ["platform-ops/**"]`（仓级追加排除）。
> 平台的服务治理细节（限流阈值/熔断参数/告警路由/容量水位）一旦同步到客户侧子仓即构成信息泄露。

## 与 PRD 工程篇的映射

| 模块 | PRD 章节 | 内容 |
|---|---|---|
| `src/bus/stream.ts` | §17.3 / ADR-1 | 事件总线（四条 Stream 拓扑/消费者组扇出/deliver-at 延迟消息/ack+背压/位点重放） |
| `src/bus/outbox-relay.ts` | §17.1 | transactional outbox 中继：先落库后上总线，至少一次 + 消费幂等 |
| `src/streams/projector.ts` | §16.3/§16.6 | 投影器框架：1s 微批降写放大、event_id 幂等、checkpoint 重放安全 |
| `src/streams/credit-balance.ts` | §16.3 | 积分三池余额投影（HSET bal:{tenant}）+ cache-aside；**钱的路径不走缓存** |
| `src/streams/anomaly-detector.ts` | §16.3/§18.4 | 3σ 基线 + 单笔阈值异常检测 → credit.anomaly → R-PL1 必人审 |
| `src/streams/sla-timer.ts` | §16.4/§17.4 | SLA 延迟计时（deliver-at 替代扫表，扫表仅兜底对账） |
| `src/streams/chain-verifier.ts` | §16.2-4 | 哈希链流式增量校验，断链 P0 |
| `src/gateway/push-gateway.ts` | §17.5/ADR-4 | 推送匹配（租户隔离/订阅过滤/载荷<2KB 纪律/免打扰/轮询兜底协议） |
| `src/gateway/ingest-gateway.ts` | §17.2/§9.2 | 上报网关（字段白名单拒整批/幂等签收/租户限流退避/乱序窗口） |
| `src/stability/token-bucket.ts` | §20.2 | 四级令牌桶 + L4 写入口保护阀（关键事件永不采样） |
| `src/stability/circuit-breaker.ts` | §20.3 | provider 熔断器（>50%/1min → 断 30s → 半开）+ 降级链 + 核心路径永不降级 |
| `src/stability/slow-lane.ts` | §20.1 | noisy neighbor 慢车道（超配额 10 倍切低优先级队列） |
| `src/runtime/lease.ts` | §18.2 | 心跳租约 TTL 60s / 僵尸 replay / 连续 3 次熔断 + P1 需介入工单 |
| `src/runtime/trigger-watchdog.ts` | §18.2-3 | cron 应触发表独立重算对账，漏触发 >5min 即 P1 |
| `src/runtime/slo.ts` | §18.5 | SLO 登记与错误预算燃烧率（对账硬指标无预算，差异即冻结资金流） |
| `src/hotupdate/asset-cache.ts` | §19.1/§19.4 | 版本键缓存 + asset.invalidate 广播；围栏 60s 强制 TTL + 变更方向红线 |
| `src/hotupdate/rollout.ts` | §19.2 | 灰度状态机：内部→5%→50%→100%（R-PL5 每批必审，24h 观察期超阈值自动暂停） |
| `src/capacity/load-model.ts` | §21.1/§21.3 | 万租户负载模型（写容量 4 倍余量）+ 伸缩阶梯 + 水位检项分级 |

## 工程形态说明（起步阶梯 §21.3）

- 本包为**起步形态**（<500 租户）：事件总线/缓存/租约存储提供内存实现，**接口即生产语义**——
  集群化时以同接口替换为 NATS JetStream / Redis / PG 适配器，上层流处理器零改动；
- 所有时间源注入式（`now: () => number`），时钟纪律：服务端时间为唯一权威（§20.4）；
- 测试：`pnpm exec vitest run platform-ops/test`（43 个用例覆盖全部模块的纪律性断言）。

## 与 bundles/platform 的关系

`bundles/platform/`（平台运营包）是**业务资产**：谁干活、按什么规矩干活（班组/围栏/技能/策略）。
`platform-ops/` 是**工程资产**：这些业务跑在什么底座上（实时面/推送/监督/热更新/稳定性/容量）。
两者同仓部署、同边界保护，共同构成仙女座运营运维系统。
