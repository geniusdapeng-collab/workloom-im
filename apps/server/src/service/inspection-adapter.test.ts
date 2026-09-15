import { describe, expect, it } from "vitest";
import { loadBundleUiProjection } from "@workloom/base/bundles";
import { runChecks } from "@workloom/base/inspection";
import { hotelInspectionAdapter } from "../industry/hotel/inspection-adapter.js";
import {
  bindInspectionAdapter,
  registeredInspectionBundleIds,
} from "./inspection-adapter.js";

describe("已验证 Bundle 的巡检行业适配器", () => {
  it("hotel Bundle 通过完整投影校验后才取得酒店巡检适配器", () => {
    const binding = bindInspectionAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "install-hotel", bundleId: "hotel" }],
    });
    expect(binding).toMatchObject({
      state: "ready",
      bundleId: "hotel",
      installId: "install-hotel",
    });
    expect(binding.adapter?.id).toBe("hotel.inspection-v1");
    expect(registeredInspectionBundleIds()).toEqual(["hotel"]);
  });

  it("非酒店 Bundle 没有行业声明时失败关闭，绝不获得酒店探针", () => {
    const binding = bindInspectionAdapter({
      workspaceBundleId: "platform",
      activeInstalls: [{ id: "install-platform", bundleId: "platform" }],
    });
    expect(binding).toMatchObject({
      state: "adapter-not-declared",
      adapter: null,
      bundleId: "platform",
    });
  });

  it("非酒店 Bundle 即使伪造酒店适配器标识也因授权范围失败关闭", () => {
    const platform = loadBundleUiProjection("platform");
    const binding = bindInspectionAdapter({
      workspaceBundleId: "platform",
      activeInstalls: [{ id: "install-platform", bundleId: "platform" }],
    }, () => ({
      ...platform,
      ui: { ...platform.ui, inspection: { enabled: true, adapterId: "hotel.inspection-v1" } },
    }));
    expect(binding).toMatchObject({ state: "adapter-untrusted", adapter: null });
  });

  it("装配指针冲突在选择行业适配器前即失败关闭", () => {
    const binding = bindInspectionAdapter({
      workspaceBundleId: "platform",
      activeInstalls: [{ id: "install-hotel", bundleId: "hotel" }],
    });
    expect(binding).toMatchObject({ state: "bundle-mismatch", adapter: null });
  });

  it("酒店渠道、房态与住客评价阈值均由酒店适配器生成", () => {
    const findings = runChecks(hotelInspectionAdapter.checks, {
      channels: [
        { channel: "渠道甲", parity: true, status: "online" },
        { channel: "渠道乙", parity: false, status: "online" },
        { channel: "渠道丙", status: "offline" },
      ],
      stateUnits: [
        { unit: "房态单元甲", synced: true },
        { unit: "房态单元乙", synced: false },
      ],
      reviews: [
        { id: "review-3", channel: "渠道甲", score: 3 },
        { id: "review-4", channel: "渠道甲", score: 4 },
      ],
      violations: [],
    }, hotelInspectionAdapter.probes);

    expect(findings.find((finding) => finding.objectId === "渠道乙")).toMatchObject({ status: "anomaly", severity: "medium" });
    expect(findings.find((finding) => finding.objectId === "渠道丙")).toMatchObject({ status: "anomaly", severity: "high" });
    expect(findings.find((finding) => finding.objectId === "房态单元乙")).toMatchObject({ status: "anomaly", severity: "medium" });
    expect(findings.find((finding) => finding.objectId === "review-3")).toMatchObject({ status: "anomaly", severity: "high" });
    expect(findings.find((finding) => finding.objectId === "review-4")).toMatchObject({ status: "ok" });
  });
});
