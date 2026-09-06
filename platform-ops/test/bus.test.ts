/**
 * 实时面测试：事件总线（扇出/延迟消息/背压/重放）+ outbox relay（先落库后上总线/续发）
 * 对应 PRD §17.1/§17.3
 */
import { describe, expect, it } from "vitest";
import { EventBus, STREAM_TOPOLOGY } from "../src/bus/stream.js";
import { MemoryOutboxStore, OutboxRelay } from "../src/bus/outbox-relay.js";

describe("事件总线（§17.3 JetStream 语义）", () => {
  it("四条流拓扑声明齐备", () => {
    expect(Object.keys(STREAM_TOPOLOGY)).toEqual(["events-core", "credits-ledger", "tickets-flow", "ops-signals"]);
    expect(STREAM_TOPOLOGY["credits-ledger"].consumers).toContain("anomaly-detector");
  });

  it("扇出：一条事件多个消费者组各自独立消费", () => {
    const bus = new EventBus(() => 1000);
    bus.publish("events-core", "ev.t1.ticket.created", { event_id: "e1" });
    const g1 = bus.consumer("events-core", "projector");
    const g2 = bus.consumer("events-core", "chain-verifier");
    expect(g1.pull(10, 1000)).toHaveLength(1);
    expect(g2.pull(10, 1000)).toHaveLength(1); // 组2 不受影响
  });

  it("deliver-at 延迟消息：到点前不可见，到点后补投", () => {
    let now = 1000;
    const bus = new EventBus(() => now);
    bus.publish("tickets-flow", "ticket.t1.tk1", { kind: "sla.check" }, { deliverAt: 5000 });
    const g = bus.consumer("tickets-flow", "sla-timer");
    expect(g.pull(10, now)).toHaveLength(0);       // 未到点
    now = 5000;
    expect(g.pullDueDelayed(now)).toHaveLength(1);  // 到点补投
  });

  it("背压：maxAckPending 满则停止投递，ack 后恢复", () => {
    const bus = new EventBus(() => 1000);
    for (let i = 0; i < 5; i++) bus.publish("ops-signals", "ops.x.y", { i });
    const g = bus.consumer("ops-signals", "alert-aggregator", 3); // maxAckPending=3
    expect(g.pull(10, 1000)).toHaveLength(3);
    expect(g.pull(10, 1000)).toHaveLength(0); // 背压
    const first = bus.logOf("ops-signals")[0];
    g.ack(first.seq);
    expect(g.pull(10, 1000)).toHaveLength(1); // ack 后恢复投递
  });

  it("重放：从指定位点重建投影输入", () => {
    const bus = new EventBus(() => 1000);
    for (let i = 0; i < 4; i++) bus.publish("events-core", "ev.t1.x", { i });
    const replayed = bus.replay("events-core", 2);
    expect(replayed.map((m) => (m.payload as { i: number }).i)).toEqual([2, 3]);
  });

  it("积压深度：HPA 伸缩信号", () => {
    const bus = new EventBus(() => 1000);
    for (let i = 0; i < 5; i++) bus.publish("events-core", "ev.t1.x", { i });
    expect(bus.backlog("events-core", "projector")).toBe(5);
    bus.consumer("events-core", "projector").pull(3, 1000);
    expect(bus.backlog("events-core", "projector")).toBe(2);
  });
});

describe("outbox relay（§17.1 先落库后上总线）", () => {
  it("未发布行被中继到总线并标记已发布；崩溃后续发不重复入库", async () => {
    const store = new MemoryOutboxStore();
    const bus = new EventBus(() => 1000);
    store.append({ eventId: "e1", tenantId: "t1", stream: "events-core", subject: "ev.t1.ticket.created", payload: { a: 1 } });
    store.append({ eventId: "e2", tenantId: "t1", stream: "credits-ledger", subject: "credits.t1", payload: { amount: 100 } });
    const relay = new OutboxRelay(store, bus);
    expect(await relay.pumpOnce()).toBe(2);
    expect(bus.logOf("events-core")).toHaveLength(1);
    expect(bus.logOf("credits-ledger")).toHaveLength(1);
    // 第二轮：无未发布行 → 不重发（发布位点持久化）
    expect(await relay.pumpOnce()).toBe(0);
    expect(bus.logOf("events-core")).toHaveLength(1);
    // 事件携带 event_id/tenant_id（消费者幂等键）
    const msg = bus.logOf("events-core")[0].payload as { event_id: string; tenant_id: string };
    expect(msg.event_id).toBe("e1");
    expect(msg.tenant_id).toBe("t1");
  });
});
