import { describe, expect, it } from "vitest";
import { assertBundleCompatibility, parseBundleManifest, satisfiesCompatibility } from "./index.js";

const manifest = {
  schemaVersion: "workloom.bundle/v1",
  name: "@workloom/example",
  version: "1.2.3",
  workloom: {
    industry: "example",
    displayName: "示例行业",
    description: "用于验证契约",
    status: "stable",
    owner: "WorkLoom",
    compatibility: { base: ">=0.1.0 <1.0.0", ui: ">=0.1.0 <1.0.0", contract: "1.0.0" },
    provides: { presets: [], fences: [], skills: [], schemas: [], ui: [], serviceFront: [], seeds: [] },
    ui: {
      schemaVersion: "workloom.bundle.ui/v1",
      terminology: {}, navigation: { slots: [] }, home: { widgets: [] }, objects: [], workflows: [],
      serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
      theme: { brand: {} }, permissions: [], experiments: [],
    },
  },
};

describe("行业包契约", () => {
  it("解析完整三端投影并拒绝重复语义路由", () => {
    expect(parseBundleManifest(manifest).workloom.industry).toBe("example");
    const invalid: Record<string, any> = structuredClone(manifest);
    invalid.workloom.ui.navigation.slots = [
      { capabilityId: "industry.one", title: "入口一", route: "/industry/one", group: "经营", icon: "report", clients: ["pc"], permissions: [] },
      { capabilityId: "industry.two", title: "入口二", route: "/industry/one", group: "经营", icon: "report", clients: ["pc"], permissions: [] },
    ];
    expect(() => parseBundleManifest(invalid)).toThrow();
  });

  it("兼容范围失败关闭", () => {
    expect(satisfiesCompatibility("0.3.0", ">=0.1.0 <1.0.0")).toBe(true);
    expect(satisfiesCompatibility("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
    expect(() => assertBundleCompatibility(parseBundleManifest(manifest), { base: "1.0.0", ui: "0.1.0" })).toThrow("兼容性校验失败");
  });

  it("行业只能覆盖品牌白名单字段", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.theme.brand.danger = "#000";
    expect(() => parseBundleManifest(invalid)).toThrow();
  });

  it("服务前台适配器必须使用受约束标识，且未声明时保持通用基座", () => {
    expect(parseBundleManifest(manifest).workloom.ui.serviceFront.adapterId).toBeUndefined();
    const valid = structuredClone(manifest) as Record<string, any>;
    valid.workloom.ui.serviceFront.enabled = true;
    valid.workloom.ui.serviceFront.identityPolicy = "phone";
    valid.workloom.ui.serviceFront.adapterId = "example.service-front-v1";
    expect(parseBundleManifest(valid).workloom.ui.serviceFront.adapterId).toBe("example.service-front-v1");

    const invalid = structuredClone(valid) as Record<string, any>;
    invalid.workloom.ui.serviceFront.adapterId = "../../hotel";
    expect(() => parseBundleManifest(invalid)).toThrow(/能力标识格式不正确/);
  });

  it("用户可见名称不能直接释放英文代码字段", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.navigation.slots = [{
      capabilityId: "example.orders", title: "order_status", route: "/orders",
      group: "operations", icon: "report", clients: ["pc"], permissions: [],
    }];
    expect(() => parseBundleManifest(invalid)).toThrow(/必须包含中文/);
  });
});
