import { describe, expect, it } from "vitest";
import { MirroredEventBus } from "./event-bus/mirrored.js";
import { NatsBackend, TcpNatsConnection } from "./event-bus/adapters/nats.js";
import { FakeNatsServer } from "./event-bus/testing/fake-nats.js";

const SPECS = [
  { name: "events-core", subjects: ["events-core.>"], retention: "limits" as const },
  { name: "tickets-flow", subjects: ["tickets-flow.>"], retention: "workqueue" as const },
];

describe("dbg nats delay restore", () => {
  it("延迟消息重启后必达", async () => {
    const now = { t: 3_601_000 };
    const server = new FakeNatsServer();
    await server.start();
    let bus = new MirroredEventBus(new NatsBackend(new TcpNatsConnection(server.url())), SPECS, () => now.t, 10);
    await bus.start();
    bus.publish("events-core", "ev.t.d", { x: 9 }, { deliverAt: now.t + 1000 });
    await bus.flush();
    await bus.close();
    now.t += 1000;
    bus = new MirroredEventBus(new NatsBackend(new TcpNatsConnection(server.url())), SPECS, () => now.t, 10);
    await bus.start();
    await bus.flush();
    console.log("after lift log:", bus.logOf("events-core").length);
    await new Promise(r=>setTimeout(r,300));
    await bus.flush();
    console.log("after settle log:", bus.logOf("events-core").length);
    const g = bus.consumer("events-core", "d-g");
    await bus.flush();
    const due = g.pull(10, now.t).filter((m) => (m.payload as { x?: number }).x === 9);
    console.log("due:", due.length);
    expect(due).toHaveLength(1);
    await bus.close();
    await server.stop();
  }, 25000);
});
