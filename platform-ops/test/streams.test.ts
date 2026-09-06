/**
 * 流处理器测试：投影器（微批/幂等/checkpoint）、积分余额投影（三池/cache-aside/钱不走缓存）、
 * 3σ 异常检测、SLA 延迟计时、增量验链。对应 PRD §16.2-16.4 / §17.4
 */
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus/stream.js";
import { MemoryCheckpointStore, Projector } from "../src/streams/projector.js";
import { applyCreditEvents, MemoryBalanceCache, readBalance, type CreditEvent } from "../src/streams/credit-balance.js";
import { CreditAnomalyDetector } from "../src/streams/anomaly-detector.js";
import { SlaTimer } from "../src/streams/sla-timer.js";
import { ChainVerifier, computeHash } from "../src/streams/chain-verifier.js";

describe("投影器框架（§16.3 微批 + §16.6 幂等）", () => {
  it("微批窗口合并 + event_id 去重 + checkpoint 推进", async () => {
    let now = 0;
    const bus = new EventBus(() => now);
    const applied: string[] = [];
    const cp = new MemoryCheckpointStore();
    const group = bus.consumer("credits-ledger", "balance-projector");
    const pj = new Projector({
      name: "balance", group, checkpoints: cp, windowMs: 1000, now: () => now,
      apply: async (batch) => { for (const m of batch) applied.push((m.payload as { event_id: string }).event_id); },
    });
    bus.publish("credits-ledger", "credits.t1", { event_id: "e1" });
    bus.publish("credits-ledger", "credits.t1", { event_id: "e1" }); // 重复投递（至少一次语义）
    bus.publish("credits-ledger", "credits.t1", { event_id: "e2" });
    await pj.tick(); // now=0，未到窗：只缓冲
    expect(applied).toHaveLength(0);
    now = 1001;      // 到窗 flush
    await pj.tick();
    expect(applied).toEqual(["e1", "e2"]); // 去重后只投影一次
    expect(await cp.get("balance")).toBe(3);
  });
});

describe("积分余额投影（§16.3）", () => {
  const events: CreditEvent[] = [
    { event_id: "g1", tenant_id: "t1", type: "credits.grant", pool: "gift", amount: 1000 },
    { event_id: "p1", tenant_id: "t1", type: "credits.purchase", pool: "principal", amount: 5000 },
    { event_id: "m1", tenant_id: "t1", type: "model.call", model_trace: { credits: 120 } },
    { event_id: "m2", tenant_id: "t1", type: "model.call", model_trace: { credits: 80 } },
  ];

  it("三池投影：入账分池、出账合并（微批降写放大）", async () => {
    const cache = new MemoryBalanceCache();
    await applyCreditEvents(cache, events);
    const bal = await cache.hgetall("bal:t1");
    expect(bal.gift).toBe(1000);
    expect(bal.principal).toBe(5000 - 200);
  });

  it("cache-aside：未命中回源 PG 并回填；命中则直达缓存", async () => {
    const cache = new MemoryBalanceCache();
    let pgCalls = 0;
    const pg = async () => { pgCalls++; return { gift: 100 }; };
    const first = await readBalance(cache, "t2", pg);
    expect(first.source).toBe("pg");
    const second = await readBalance(cache, "t2", pg);
    expect(second.source).toBe("cache");
    expect(pgCalls).toBe(1); // 只回源一次
  });
});

describe("异常扣费检测（§16.3：3σ / 单笔阈值 → R-PL1 必人审）", () => {
  it("单笔超阈值立即告警（冷启动即生效）", () => {
    const det = new CreditAnomalyDetector({ singleTxThreshold: 500 });
    const hit = det.observe({ event_id: "m1", tenant_id: "t1", type: "model.call", model_trace: { credits: 600 } });
    expect(hit?.kind).toBe("single_over_threshold");
  });

  it("窗口速率超基线 3σ 告警；正常波动不误报", () => {
    let now = 0;
    const det = new CreditAnomalyDetector({ singleTxThreshold: 10_000, minSamples: 5, bucketMs: 60_000, now: () => now });
    // 建立基线：10 个窗口、每窗 100
    for (let b = 0; b < 10; b++) {
      now = b * 60_000;
      det.observe({ event_id: `base${b}`, tenant_id: "t1", type: "model.call", model_trace: { credits: 100 } });
    }
    // 正常窗口：不告警
    now = 10 * 60_000;
    expect(det.observe({ event_id: "n1", tenant_id: "t1", type: "model.call", model_trace: { credits: 100 } })).toBeNull();
    // 异常窗口：基线 mean=100, std≈0 时退化为单笔阈值兜底；构造有方差基线
    const det2 = new CreditAnomalyDetector({ singleTxThreshold: 10_000, minSamples: 5, bucketMs: 60_000, now: () => now });
    const base = [80, 120, 90, 110, 100, 95, 105, 85, 115, 100];
    base.forEach((v, b) => {
      now = b * 60_000;
      det2.observe({ event_id: `b${b}`, tenant_id: "t2", type: "model.call", model_trace: { credits: v } });
    });
    now = 10 * 60_000;
    const normal = det2.observe({ event_id: "ok", tenant_id: "t2", type: "model.call", model_trace: { credits: 110 } });
    expect(normal).toBeNull();
    now = 11 * 60_000;
    const spike = det2.observe({ event_id: "spike", tenant_id: "t2", type: "model.call", model_trace: { credits: 900 } });
    expect(spike?.kind).toBe("rate_3sigma");
  });
});

describe("SLA 延迟计时（§16.4/§17.4：deliver-at 替代扫表）", () => {
  it("建单排程延迟消息；到期未解决 → P1 升级事件；已解决不升级", () => {
    let now = 1_000;
    const bus = new EventBus(() => now);
    const timer = new SlaTimer(bus, undefined, () => now);
    const deadline = timer.schedule({ ticketId: "tk1", tenantId: "t1", status: "处理中", intent: "bug_report" });
    expect(deadline).toBe(1_000 + 5 * 60_000); // 故障类 ≤5min
    // 延迟消息已入总线
    expect(bus.logOf("tickets-flow")).toHaveLength(1);
    // 到期：已解决 → 不升级
    const ok = timer.onDeadline({ ticketId: "tk1", tenantId: "t1", status: "已解决", intent: "bug_report" });
    expect(ok.escalated).toBe(false);
    // 到期：未解决 → P1 + ops-signals 升级事件
    timer.schedule({ ticketId: "tk2", tenantId: "t1", status: "处理中", intent: "bug_report" });
    const breach = timer.onDeadline({ ticketId: "tk2", tenantId: "t1", status: "处理中", intent: "bug_report" });
    expect(breach).toEqual({ escalated: true, to: "incident-responder" });
    const sig = bus.logOf("ops-signals")[0].payload as { kind: string; level: string; escalate_to: string };
    expect(sig).toMatchObject({ kind: "sla.breach", level: "P1", escalate_to: "incident-responder" });
  });
});

describe("哈希链增量校验（§16.2-4：断链 P0）", () => {
  it("正常链通过；prev 断链与 hash 篡改均被检出", () => {
    const v = new ChainVerifier();
    const h1 = computeHash("", { a: 1 });
    expect(v.verify({ event_id: "e1", tenant_id: "t1", payload: { a: 1 }, prev_hash: "", hash: h1 })).toBeNull();
    const h2 = computeHash(h1, { a: 2 });
    expect(v.verify({ event_id: "e2", tenant_id: "t1", payload: { a: 2 }, prev_hash: h1, hash: h2 })).toBeNull();
    // prev 断链
    const bad1 = v.verify({ event_id: "e3", tenant_id: "t1", payload: { a: 3 }, prev_hash: "00", hash: "11" });
    expect(bad1?.reason).toBe("prev_mismatch");
    // hash 篡改
    const bad2 = v.verify({ event_id: "e4", tenant_id: "t1", payload: { a: 99 }, prev_hash: h2, hash: h2 });
    expect(bad2?.reason).toBe("hash_mismatch");
  });
});
