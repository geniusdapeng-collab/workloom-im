/**
 * 热更新测试：版本键缓存（invalidate 广播/围栏 60s 强制 TTL/围栏变更方向红线）+
 * 灰度状态机（R-PL5 每批必审/24h 观察期/超阈值自动暂停/审批回滚）。对应 PRD §19.1/§19.2/§19.4
 */
import { describe, expect, it } from "vitest";
import { AssetCache, fenceChangeDirection, FENCE_FORCE_TTL_MS } from "../src/hotupdate/asset-cache.js";
import { RolloutController, BATCH_ORDER } from "../src/hotupdate/rollout.js";

describe("资产热更新缓存（§19.1）", () => {
  it("invalidate 广播后下次读取即新版本（秒级生效，无重启）", async () => {
    const cache = new AssetCache({ now: () => 0 });
    let version = "v1";
    const loader = async () => ({ kind: "skill" as const, key: "kb-harvest", version, data: { v: version } });
    const first = await cache.get("skill", "kb-harvest", loader);
    expect(first.version).toBe("v1");
    version = "v2";
    expect((await cache.get("skill", "kb-harvest", loader)).version).toBe("v1"); // 仍命中旧缓存
    cache.invalidate("skill", "kb-harvest"); // 激活事件广播
    expect((await cache.get("skill", "kb-harvest", loader)).version).toBe("v2"); // 新版本
  });

  it("围栏规则 60s 强制 TTL 兜底：即使无 invalidate 也最迟 1 分钟生效", async () => {
    let now = 0;
    const cache = new AssetCache({ now: () => now });
    let version = "strict-v1";
    const loader = async () => ({ kind: "fence" as const, key: "R-PL1", version, data: {} });
    await cache.get("fence", "R-PL1", loader);
    version = "strict-v2";
    now = FENCE_FORCE_TTL_MS + 1;
    expect((await cache.get("fence", "R-PL1", loader)).version).toBe("strict-v2");
  });

  it("围栏变更方向红线：放宽=loosen（须双人复核），收紧=tighten（快速通道）", () => {
    expect(fenceChangeDirection("block", "review")).toBe("loosen");
    expect(fenceChangeDirection("review", "auto")).toBe("loosen");
    expect(fenceChangeDirection("auto", "block")).toBe("tighten");
    expect(fenceChangeDirection("review", "review")).toBe("neutral");
  });
});

describe("灰度发布状态机（§19.2）", () => {
  it("完整链路：每批 R-PL5 必审 → 观察 24h → 内部→5%→50%→100% → 完成", () => {
    let now = 0;
    const rc = new RolloutController("platform@1.1.0", undefined, { now: () => now, observationMs: 24 * 3_600_000 });
    expect(BATCH_ORDER).toEqual(["internal", "5%", "50%", "100%"]);
    for (const batch of BATCH_ORDER) {
      expect(rc.getState()).toEqual({ phase: "awaiting_approval", batch });
      expect(() => rc.advanceIfObservationPassed()).not.toThrow(); // 未批准不可推进
      rc.approve(); // R-PL5 人审
      expect(rc.getState()).toMatchObject({ phase: "observing", batch });
      rc.observe({ errorRate: 0, ticketDensityDelta: 0.05, fenceAnomalies: 0, creditAnomalies: 0 });
      now += 24 * 3_600_000 + 1; // 观察期满
      rc.advanceIfObservationPassed();
    }
    expect(rc.getState()).toEqual({ phase: "completed" });
  });

  it("观察期超阈值 → 自动暂停（不等人）→ 审批后快照回滚", () => {
    const rc = new RolloutController("platform@1.1.0");
    rc.approve();
    const r = rc.observe({ errorRate: 0.05, ticketDensityDelta: 0, fenceAnomalies: 0, creditAnomalies: 0 });
    expect(r.ok).toBe(false);
    expect(rc.getState()).toMatchObject({ phase: "paused", batch: "internal" });
    rc.rollbackApproved("snapshot-platform-1.0.0", "错误率 5% 超阈值");
    expect(rc.getState()).toMatchObject({ phase: "rolled_back", toSnapshot: "snapshot-platform-1.0.0" });
  });
});
