import { describe, expect, it } from "vitest";
import { composeNavigation, isNavigationActive, navigationEntriesFromBundle } from "./navigation";

describe("共享导航契约", () => {
  it("按客户端与权限过滤，并保持固定分组顺序", () => {
    const entries = composeNavigation({ client: "b-mobile", permissions: new Set(["today.read", "approvals.read"]) });
    expect(entries.some((entry) => entry.capabilityId === "workloom.approvals")).toBe(true);
    expect(entries.some((entry) => entry.capabilityId === "workloom.models")).toBe(false);
    expect(entries[0]?.group).toBe("today");
  });

  it("空授权不会因已登录而获得任何基座入口", () => {
    expect(composeNavigation({ client: "b-pc", permissions: new Set() })).toEqual([]);
  });

  it("旧路由仍能正确高亮语义入口", () => {
    const approvals = composeNavigation({ client: "b-pc" }).find((entry) => entry.capabilityId === "workloom.approvals");
    expect(approvals && isNavigationActive(approvals, "/p4")).toBe(true);
  });

  it("拒绝行业包覆盖基座 capabilityId", () => {
    expect(() => composeNavigation({
      client: "b-pc",
      bundleEntries: [{
        capabilityId: "workloom.today",
        route: "/industry",
        title: "行业首页",
        group: "operations",
        icon: "home",
        clients: ["b-pc"],
        source: "bundle:hotel",
        order: 1,
      }],
    })).toThrow(/重复/);
  });

  it("从 Bundle 契约生成三端条目，且多个权限必须全部满足", () => {
    const bundleEntries = navigationEntriesFromBundle("ai-pm", [{
      capabilityId: "ai-pm.development",
      route: "/development",
      title: "开发场域",
      group: "automation",
      icon: "developer",
      clients: ["pc", "b-mobile"],
      permissions: ["ai-pm.development.read", "ai-pm.workspace.ready"],
    }]);
    expect(bundleEntries[0]?.clients).toEqual(["b-pc", "b-mobile"]);
    expect(composeNavigation({
      client: "b-pc",
      permissions: new Set(["ai-pm.development.read"]),
      bundleEntries,
    }).some((entry) => entry.capabilityId === "ai-pm.development")).toBe(false);
    expect(composeNavigation({
      client: "b-pc",
      permissions: new Set(["ai-pm.development.read", "ai-pm.workspace.ready"]),
      bundleEntries,
    }).some((entry) => entry.capabilityId === "ai-pm.development")).toBe(true);
  });

  it("拒绝行业包越权使用别的命名空间或未知视觉资产", () => {
    expect(() => navigationEntriesFromBundle("hotel", [{
      capabilityId: "other.orders", route: "/orders", title: "订单", group: "operations",
      icon: "home", clients: ["pc"], permissions: [],
    }])).toThrow(/命名空间/);
    expect(() => navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders", route: "/orders", title: "订单", group: "operations",
      icon: "hotel-logo", clients: ["pc"], permissions: [],
    }])).toThrow(/图标/);
    expect(() => navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders", route: "/orders", title: "订单 orderStatus", group: "operations",
      icon: "home", clients: ["pc"], permissions: [],
    }])).toThrow(/中文名称/);
  });
});
