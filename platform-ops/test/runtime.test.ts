/**
 * 运行时监督测试：心跳租约/僵尸恢复/三次熔断、漏触发对账（cron 重算）、SLO 错误预算。
 * 对应 PRD §18.2/§18.5
 */
import { describe, expect, it } from "vitest";
import { MemoryLeaseStore, RunSupervisor } from "../src/runtime/lease.js";
import { nextCronFire, TriggerWatchdog } from "../src/runtime/trigger-watchdog.js";
import { evaluateSlo, PLATFORM_SLOS } from "../src/runtime/slo.js";

describe("心跳租约与僵尸恢复（§18.2）", () => {
  it("TTL 内续约存活；过期判僵尸 → replay；连续 3 次 → 熔断 + P1 工单", async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const sup = new RunSupervisor(store, { leaseTtlMs: 60_000, maxZombies: 3, now: () => now });
    await sup.heartbeat("run-1", "step-3");
    // 存活期：无僵尸
    expect(await sup.sweep()).toHaveLength(0);
    // 第 1 次僵尸 → replay
    now = 61_000;
    let v = await sup.sweep();
    expect(v).toEqual([{ runId: "run-1", action: "replay", zombieCount: 1 }]);
    // 第 2、3 次 → 熔断
    v = await sup.sweep();
    expect(v[0].action).toBe("replay");
    v = await sup.sweep();
    expect(v[0].action).toBe("circuit");
    expect(v[0].ticket?.level).toBe("P1");
    // 熔断后不再自动 replay
    expect(await sup.sweep()).toHaveLength(0);
  });

  it("完成的 run 不判僵尸", async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const sup = new RunSupervisor(store, { now: () => now });
    await sup.heartbeat("run-2", "step-1");
    await sup.runCompleted("run-2");
    now = 120_000;
    expect(await sup.sweep()).toHaveLength(0);
  });
});

describe("漏触发对账（§18.2-3）", () => {
  it("cron 重算应触发时刻表", () => {
    const base = new Date("2026-09-06T02:00:00+08:00").getTime();
    const next = nextCronFire("30 2 * * *", base); // 每天 02:30
    expect(next).toBe(base + 30 * 60_000);
    const every5 = nextCronFire("*/5 * * * *", base);
    expect(every5).toBe(base + 5 * 60_000);
  });

  it("漏触发 >5min 判 P1；正常触发不误报", () => {
    const now = new Date("2026-09-06T03:00:00+08:00").getTime();
    const wd = new TriggerWatchdog({ now: () => now });
    const triggers = [{ triggerId: "reconcile-daily", cron: "0 2 * * *" }];
    const expected = new Date("2026-09-06T02:00:00+08:00").getTime();
    // 未触发 → P1
    const missed = wd.reconcile(triggers, [], now - 3_600_000);
    expect(missed).toHaveLength(1);
    expect(missed[0].expectedAt).toBe(expected);
    // 已触发 → 无漏报
    const fired = wd.reconcile(triggers, [{ triggerId: "reconcile-daily", firedAt: expected + 1000 }], now - 3_600_000);
    expect(fired).toHaveLength(0);
  });
});

describe("SLO 错误预算（§18.5）", () => {
  it("燃烧率分档：>50% 冻结发布；耗尽告警；对账硬指标差异即冻结资金流", () => {
    const ingest = PLATFORM_SLOS.find((s) => s.name === "ingest-ack")!;
    expect(evaluateSlo(ingest, 100_000, 10).action).toBe("ok");             // 0.01% 错误 < 预算 0.05%×50%
    expect(evaluateSlo(ingest, 100_000, 30).action).toBe("freeze_releases"); // 消耗 60%
    expect(evaluateSlo(ingest, 100_000, 60).action).toBe("alert");           // 预算耗尽
    const reconcile = PLATFORM_SLOS.find((s) => s.name === "reconcile")!;
    expect(evaluateSlo(reconcile, 10_000, 1).action).toBe("freeze_funds");   // 硬指标：1 笔差异即冻结
    expect(evaluateSlo(reconcile, 10_000, 0).action).toBe("ok");
  });
});
