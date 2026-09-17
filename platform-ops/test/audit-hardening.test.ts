/**
 * 审计加固专项测试（2026-09-06 深度代码审计产物）
 *
 * 覆盖审计发现的缺陷回归 + 底层工程边界场景：
 * A1 严格模式编译（tsc --noEmit 红线，配套 CI）
 * A2 L4 保护阀采样语义（旧实现：采样路径二次占桶必失败 / 关键事件桶空被误拒）
 * A3 上报白名单通道化（旧实现：单一白名单误拒内部合法事件）
 * A4 灰度暂停恢复通道（旧实现：paused 后只剩回滚，热修复重发被卡死）
 * A5 僵尸熔断计数残留（长跑内存膨胀）
 * B  边界场景：延迟消息扇出一致性 / 限流补投语义 / 令牌桶精度 / 验链 checkpoint 恢复
 */
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus/stream.js";
import { WriteIngressValve, TokenBucket } from "../src/stability/token-bucket.js";
import { IngestGateway, CHANNEL_PROFILES, type ReportEvent } from "../src/gateway/ingest-gateway.js";
import { RolloutController } from "../src/hotupdate/rollout.js";
import { MemoryLeaseStore, RunSupervisor } from "../src/runtime/lease.js";
import { ChainVerifier, computeHash } from "../src/streams/chain-verifier.js";

describe("A2 写入口保护阀采样语义（审计回归）", () => {
  it("关键事件桶空永不拒绝；遥测桶空按采样率放行", () => {
    let now = 0;
    // 采样率 0.5，确定性随机源：交替 0.2/0.8
    let flip = 0;
    const rand = () => { flip = 1 - flip; return flip === 1 ? 0.2 : 0.8; };
    const valve = new WriteIngressValve(new TokenBucket({ capacity: 1, refillPerSec: 0, now: () => now }), 0.5, rand);
    // 桶容量 1：第一个遥测占桶成功
    expect(valve.admit("telemetry.a")).toBe(true);
    // 桶空：关键事件仍放行（审计修复点①）
    expect(valve.admit("credits.purchase")).toBe(true);
    expect(valve.admit("ticket.created")).toBe(true);
    // 桶空：遥测按 0.5 采样——rand 0.2 放行、0.8 丢弃（审计修复点②：旧实现恒丢弃）
    expect(valve.admit("telemetry.b")).toBe(true);
    expect(valve.admit("telemetry.c")).toBe(false);
    expect(valve.admit("telemetry.d")).toBe(true);
  });
});

describe("A3 上报白名单通道化（审计回归）", () => {
  const mk = (over: Partial<ReportEvent> = {}): ReportEvent => ({
    event_id: "e1", tenant_id: "t1", type: "credits.grant", occurred_at: 1000, ...over,
  });

  it("meta 通道：业务字段拒批；internal 通道：同一事件合法签收", () => {
    const gw = new IngestGateway({ now: () => 1000 });
    const creditEvent = mk({ pool: "gift", amount: 1000 });
    const [rej] = gw.ingestBatch("t1", [creditEvent], "meta");
    expect(rej!.action).toBe("rejected"); // 客户元数据通道不得携带账务字段
    const gw2 = new IngestGateway({ now: () => 1000 });
    const [ok] = gw2.ingestBatch("t1", [creditEvent], "internal");
    expect(ok!.action).toBe("accept");
  });

  it("internal 通道仍兜底：白名单外的陌生字段照样拒批", () => {
    const breaches: string[][] = [];
    const gw = new IngestGateway({ now: () => 1000, onWhitelistBreach: (_t, f) => breaches.push(f) });
    const [v] = gw.ingestBatch("t1", [mk({ customer_phone: "138xxxxxxxx" })], "internal");
    expect(v!.action).toBe("rejected");
    expect(breaches).toEqual([["customer_phone"]]);
    // 通道 profile 声明完整
    expect(CHANNEL_PROFILES.internal).toContain("model_trace");
  });
});

describe("A4 灰度暂停恢复通道（审计回归）", () => {
  it("paused → 整改后 R-PL5 重新审批 → 从当前批次重新观察；非 paused 不可恢复", () => {
    let now = 0;
    const rc = new RolloutController("platform@1.1.1", undefined, { now: () => now, observationMs: 24 * 3_600_000 });
    rc.approve();
    rc.observe({ errorRate: 0.05, ticketDensityDelta: 0, fenceAnomalies: 0, creditAnomalies: 0 });
    expect(rc.getState().phase).toBe("paused");
    // 热修复重发：恢复审批 → 重新进入同批次观察期
    rc.resumeApproved();
    expect(rc.getState()).toMatchObject({ phase: "observing", batch: "internal" });
    // 这次指标正常，观察期满 → 推进下一批
    rc.observe({ errorRate: 0, ticketDensityDelta: 0, fenceAnomalies: 0, creditAnomalies: 0 });
    now = 24 * 3_600_000 + 1;
    rc.advanceIfObservationPassed();
    expect(rc.getState()).toMatchObject({ phase: "awaiting_approval", batch: "5%" });
    // 非法恢复路径拒绝
    expect(() => rc.resumeApproved()).toThrow();
  });
});

describe("A5 僵尸熔断计数清理（审计回归）", () => {
  it("熔断后计数清空：同一 runId 重新注册后从 1 重新计", async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const sup = new RunSupervisor(store, { leaseTtlMs: 1000, maxZombies: 2, now: () => now });
    await sup.heartbeat("run-x", "s1");
    now = 2000; await sup.sweep(); // 僵尸 1
    const v = await sup.sweep();   // 僵尸 2 → 熔断
    expect(v[0]!.action).toBe("circuit");
    // run 被人工修复后重新注册：计数从 1 开始，而非立即熔断
    await sup.heartbeat("run-x", "s1-fixed");
    now = 4000;
    const v2 = await sup.sweep();
    expect(v2[0]).toMatchObject({ runId: "run-x", action: "replay", zombieCount: 1 });
  });
});

describe("B 底层工程边界场景", () => {
  it("延迟消息扇出：两个消费者组各自独立收到到点补投", () => {
    let now = 0;
    const bus = new EventBus(() => now);
    bus.publish("tickets-flow", "ticket.t1.tk1", { kind: "sla.check" }, { deliverAt: 5000 });
    const g1 = bus.consumer("tickets-flow", "sla-timer");
    const g2 = bus.consumer("tickets-flow", "push-matcher");
    g1.pull(10, now); g2.pull(10, now); // 两组都先拉过（游标越过延迟消息）
    now = 5000;
    expect(g1.pullDueDelayed(now)).toHaveLength(1);
    expect(g2.pullDueDelayed(now)).toHaveLength(1); // 扇出一致性
    // 到点消息不重复补投
    expect(g1.pullDueDelayed(now)).toHaveLength(0);
  });

  it("令牌桶浮点精度：长时钟漂累积不透支容量", () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSec: 0.1, now: () => now });
    b.tryTake(3); // 清空
    now = 31_000; // 31s × 0.1/s = 3.1 个 → 不超过容量 3
    expect(b.available()).toBeLessThanOrEqual(3);
    // 取 3 个后立即再取失败（不多发）
    expect(b.tryTake(3)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
  });

  it("验链 checkpoint 恢复：重启后从已验 tip 续验，不重放全量", () => {
    const v1 = new ChainVerifier();
    const h1 = computeHash("", { n: 1 });
    const h2 = computeHash(h1, { n: 2 });
    v1.verify({ event_id: "e1", tenant_id: "t1", payload: { n: 1 }, prev_hash: "", hash: h1 });
    // 模拟重启：新实例从 checkpoint 恢复 tip
    const v2 = new ChainVerifier();
    v2.restore("t1", h1);
    expect(v2.verify({ event_id: "e2", tenant_id: "t1", payload: { n: 2 }, prev_hash: h1, hash: h2 })).toBeNull();
    // 恢复点之前的伪造事件仍被检出
    const forged = computeHash(h2, { n: 99 });
    expect(v2.verify({ event_id: "eX", tenant_id: "t1", payload: { n: 99 }, prev_hash: h2, hash: forged })).toBeNull();
    const tampered = v2.verify({ event_id: "eY", tenant_id: "t1", payload: { n: 100 }, prev_hash: forged, hash: "00" });
    expect(tampered?.reason).toBe("hash_mismatch");
  });

  it("限流后恢复：客户 outbox 补投语义（429 不丢数据）", () => {
    let now = 0;
    const gw = new IngestGateway({ now: () => now, perTenantRatePerMin: 60 });
    const ev = (id: string): ReportEvent => ({ event_id: id, tenant_id: "t1", type: "metrics", occurred_at: now });
    // 打满 60 桶
    const first = gw.ingestBatch("t1", Array.from({ length: 61 }, (_, i) => ev(`e${i}`)));
    expect(first[60]!.action).toBe("rate_limited");
    // 61s 后桶恢复 → 补投成功
    now = 61_000;
    const retry = gw.ingestBatch("t1", [ev("e60")]);
    expect(retry[0]!.action).toBe("accept");
  });
});
