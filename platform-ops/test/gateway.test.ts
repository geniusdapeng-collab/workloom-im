/**
 * 网关测试：推送匹配（租户隔离/订阅过滤/载荷纪律/免打扰/轮询兜底）+
 * 上报网关（白名单拒批/幂等签收/限流退避/乱序窗口）。对应 PRD §17.2/§17.5
 */
import { describe, expect, it } from "vitest";
import { inQuietHours, MemoryConnectionRegistry, pollingFallback, PushMatcher, type PushEvent } from "../src/gateway/push-gateway.js";
import { IngestGateway, type ReportEvent } from "../src/gateway/ingest-gateway.js";

describe("推送匹配器（§17.5）", () => {
  const ev: PushEvent = { eventId: "e1", tenantId: "t1", topic: "ticket.status", summary: "工单已立项", occurredAt: 1000 };

  it("租户隔离：事件只推给本租户连接", async () => {
    const reg = new MemoryConnectionRegistry();
    await reg.set("c1", { tenantId: "t1", memberId: "m1", topics: ["ticket.status"] });
    await reg.set("c2", { tenantId: "t2", memberId: "m2", topics: ["ticket.status"] });
    const matcher = new PushMatcher(reg, () => 1000);
    const hits = await matcher.match(ev);
    expect(hits.map((h) => h.connId)).toEqual(["c1"]); // t2 收不到
  });

  it("订阅过滤：未订阅主题不推；告警级别阈值过滤", async () => {
    const reg = new MemoryConnectionRegistry();
    await reg.set("c1", { tenantId: "t1", memberId: "m1", topics: ["approval.pending"] });
    await reg.set("c2", { tenantId: "t1", memberId: "m2", topics: ["alert"], alertLevel: "P1" });
    const matcher = new PushMatcher(reg, () => 1000);
    expect(await matcher.match(ev)).toHaveLength(0); // c1 未订阅 ticket.status
    const p2: PushEvent = { ...ev, topic: "alert", level: "P2" };
    expect(await matcher.match(p2)).toHaveLength(0); // P2 < 订阅阈值 P1
    const p0: PushEvent = { ...ev, topic: "alert", level: "P0" };
    expect(await matcher.match(p0)).toHaveLength(1);
  });

  it("载荷纪律：只推 ID+类型+摘要，超长摘要截断", async () => {
    const reg = new MemoryConnectionRegistry();
    await reg.set("c1", { tenantId: "t1", memberId: "m1", topics: ["ticket.status"] });
    const matcher = new PushMatcher(reg, () => 1000);
    const huge: PushEvent = { ...ev, summary: "x".repeat(5000) };
    const hit = (await matcher.match(huge))[0]!;
    expect(Buffer.byteLength(JSON.stringify(hit.frame))).toBeLessThan(2048);
    expect(Object.keys(hit.frame).sort()).toEqual(["event_id", "summary", "topic", "ts"]);
  });

  it("免打扰：窗口内非 P0 不推，P0 豁免", () => {
    const night = new Date("2026-09-06T02:00:00").getTime();
    expect(inQuietHours(night, "22:00-08:00")).toBe(true);
    expect(inQuietHours(night + 8 * 3_600_000, "22:00-08:00")).toBe(false); // 10:00
  });

  it("降级协议：WS 断连回退现有轮询参数", () => {
    expect(pollingFallback("ticket.status").intervalMs).toBe(5000);
    expect(pollingFallback("approval.pending").intervalMs).toBe(10_000);
  });
});

describe("上报网关（§17.2）", () => {
  const mk = (over: Partial<ReportEvent> = {}): ReportEvent => ({
    event_id: "e1", tenant_id: "t1", type: "ticket.status", occurred_at: 1000, ...over,
  });

  it("白名单外字段：拒整批 + 告警（数据红线工程执行面）", () => {
    const breaches: string[][] = [];
    const gw = new IngestGateway({ now: () => 1000, onWhitelistBreach: (_t, f) => breaches.push(f) });
    const verdicts = gw.ingestBatch("t1", [mk(), mk({ event_id: "e2", order_detail: "客户订单明文" })]);
    expect(verdicts.every((v) => v.action === "rejected")).toBe(true);
    expect(breaches).toEqual([["order_detail"]]);
  });

  it("幂等签收：重复 event_id 返回 duplicate 不入库", () => {
    const gw = new IngestGateway({ now: () => 1000 });
    const a = gw.ingestBatch("t1", [mk()])[0]!;
    expect(a.action).toBe("accept");
    const b = gw.ingestBatch("t1", [mk()])[0]!;
    expect(b.action).toBe("duplicate");
  });

  it("租户级限流：超额 429 + 退避指引（不丢数据，outbox 补投）", () => {
    let now = 0;
    const gw = new IngestGateway({ now: () => now, perTenantRatePerMin: 60 }); // 1/s
    const events = Array.from({ length: 70 }, (_, i) => mk({ event_id: `e${i}` }));
    const verdicts = gw.ingestBatch("t1", events);
    const limited = verdicts.filter((v) => v.action === "rate_limited");
    expect(limited.length).toBeGreaterThan(0);
    expect((limited[0] as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("乱序窗口：超 5min 的迟到事件走迟到通道单独标记", () => {
    const now = 10 * 60_000;
    const gw = new IngestGateway({ now: () => now });
    const v = gw.ingestBatch("t1", [mk({ occurred_at: 0 })])[0]!; // 早 10 分钟
    expect(v.action).toBe("late");
  });
});
