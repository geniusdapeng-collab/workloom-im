/**
 * 稳定性测试：令牌桶（四级限流）、写入口保护阀（关键事件永不采样）、
 * 熔断器（50%/1min → 断开 30s → 半开）、降级链、慢车道。对应 PRD §20.1-20.3
 */
import { describe, expect, it } from "vitest";
import { TokenBucket, WriteIngressValve } from "../src/stability/token-bucket.js";
import { CircuitBreaker, pickProvider, DEGRADATION_PLAYBOOK, BLAST_RADIUS } from "../src/stability/circuit-breaker.js";
import { SlowLaneRouter } from "../src/stability/slow-lane.js";

describe("令牌桶与写入口保护阀（§20.2）", () => {
  it("匀速补充 + 突发容量 + 退避时长", () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 10, refillPerSec: 1, now: () => now });
    for (let i = 0; i < 10; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.retryAfterMs(1)).toBe(1000);
    now = 5000; // 补充 5 个
    expect(b.available()).toBe(5);
  });

  it("L4 保护阀：账务/审批/工单永不采样，遥测可被降级", () => {
    let now = 0;
    const valve = new WriteIngressValve(new TokenBucket({ capacity: 2, refillPerSec: 0, now: () => now }), 0);
    expect(valve.admit("credits.grant")).toBe(true);
    expect(valve.admit("credits.grant")).toBe(true);
    expect(valve.admit("credits.grant")).toBe(false); // 桶空：关键事件也只是等桶，绝不进采样
    // 遥测类：桶空且采样率 0 → 丢弃（允许，§20.2 非关键事件采样降级）
    expect(valve.admit("telemetry.span")).toBe(false);
  });
});

describe("熔断器与降级链（§20.3）", () => {
  it("失败率 >50%/1min → 断开 30s → 半开试探 → 闭合", () => {
    let now = 0;
    const cb = new CircuitBreaker({ minCalls: 4, now: () => now });
    cb.record(true); cb.record(false); cb.record(false); cb.record(false); // 75% 失败
    expect(cb.getState()).toBe("open");
    expect(cb.allow()).toBe(false);
    now = 29_000;
    expect(cb.allow()).toBe(false); // 30s 未到
    now = 31_000;
    expect(cb.allow()).toBe(true);  // 半开试探放行
    cb.record(true);                // 试探成功
    expect(cb.getState()).toBe("closed");
  });

  it("半开试探失败 → 再断开", () => {
    let now = 0;
    const cb = new CircuitBreaker({ minCalls: 2, now: () => now });
    cb.record(false); cb.record(false);
    expect(cb.getState()).toBe("open");
    now = 31_000;
    cb.allow();
    cb.record(false);
    expect(cb.getState()).toBe("open");
  });

  it("降级链：跳过熔断 provider；全链熔断返回 null（排队+P0）", () => {
    const main = new CircuitBreaker({ minCalls: 2, now: () => 0 });
    main.record(false); main.record(false); // 主熔断
    const backup = new CircuitBreaker();
    expect(pickProvider([{ name: "main", breaker: main }, { name: "backup", breaker: backup }])).toBe("backup");
    const backup2 = new CircuitBreaker({ minCalls: 2, now: () => 0 });
    backup2.record(false); backup2.record(false);
    expect(pickProvider([{ name: "main", breaker: main }, { name: "backup", breaker: backup2 }])).toBeNull();
  });

  it("降级预案纪律：核心路径永不降级", () => {
    const cores = Object.values(DEGRADATION_PLAYBOOK).filter((p) => p.core);
    for (const c of cores) expect(c.degraded).toBe("永不降级");
    expect(BLAST_RADIUS.redis_down).toContain("降级不宕机");
  });
});

describe("慢车道（§20.1 noisy neighbor）", () => {
  it("单租户超配额 10 倍切慢车道；回落恢复；他租户不受影响", () => {
    let now = 0;
    const router = SlowLaneRouter.fromQuotas(
      [{ tenantId: "noisy", quotaPerMin: 10 }, { tenantId: "quiet", quotaPerMin: 10 }],
      { now: () => now },
    );
    for (let i = 0; i < 50; i++) router.route("quiet");
    expect(router.isInSlowLane("quiet")).toBe(false);
    for (let i = 0; i < 101; i++) router.route("noisy");
    expect(router.isInSlowLane("noisy")).toBe(true);
    expect(router.isInSlowLane("quiet")).toBe(false); // 邻居不受影响
    now = 61_000; // 新窗口回落
    for (let i = 0; i < 5; i++) router.route("noisy");
    expect(router.isInSlowLane("noisy")).toBe(false);
  });
});
