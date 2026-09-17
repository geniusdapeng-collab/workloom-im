/**
 * 容量模型测试：伸缩阶梯、水位检项分级。对应 PRD §21.1/§21.3/§18.4
 */
import { describe, expect, it } from "vitest";
import { levelOf, LOAD_MODEL, scaleTierFor, TIER_ACTIONS, waterLevels } from "../src/capacity/load-model.js";

describe("容量模型（第二十一章）", () => {
  it("负载模型：写入容量对峰值留 4 倍余量", () => {
    expect(LOAD_MODEL.writeTpsCapacity / LOAD_MODEL.peakWriteTps).toBe(4);
    expect(LOAD_MODEL.dailyEventsWithTelemetry).toBe(4_000_000);
  });

  it("伸缩阶梯：起步→成长→规模→超规模", () => {
    expect(scaleTierFor(100)).toBe("bootstrap");
    expect(scaleTierFor(1000)).toBe("growth");
    expect(scaleTierFor(5000)).toBe("scale");
    expect(scaleTierFor(60_000)).toBe("hyper");
    expect(TIER_ACTIONS.bootstrap.join()).toContain("ClickHouse 退化为 PG 物化视图");
    expect(TIER_ACTIONS.hyper.join()).toContain("分库");
  });

  it("水位检项：主从延迟 >30s 升 P1；积压 >5 万 P1（HPA 扩容信号）", () => {
    const levels = waterLevels({ pgReplicationLagSec: 35, jetstreamBacklog: 60_000, redisMemoryRatio: 0.5, writeTps: 300 });
    expect(levelOf(levels.find((l) => l.check === "pg_replication_lag")!)).toBe("P1");
    expect(levelOf(levels.find((l) => l.check === "jetstream_backlog")!)).toBe("P1");
    expect(levelOf(levels.find((l) => l.check === "redis_memory")!)).toBe("ok");
    expect(levelOf(levels.find((l) => l.check === "write_tps")!)).toBe("ok");
  });
});
