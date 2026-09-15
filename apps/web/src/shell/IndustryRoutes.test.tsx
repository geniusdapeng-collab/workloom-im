import { createElement } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navigationEntriesFromBundle } from "@workloom/ui";
import {
  buildIndustryRouteRegistry,
  industryRouteMatchesBundle,
  resolveIndustryRouteAccess,
  validateIndustryCapabilityId,
  validateIndustryRoutePath,
} from "./IndustryRoutes";

const page = createElement("main", null, "行业页面");

describe("B 端 PC 行业扩展路由契约", () => {
  it("默认无扩展时不增加任何路由", () => {
    expect(buildIndustryRouteRegistry({})).toEqual({ routes: [], error: null });
  });

  it("受管 App 只接通用注册表，不直接导入行业页面", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(appSource).toContain("INDUSTRY_ROUTE_REGISTRY.routes.map");
    expect(appSource).not.toMatch(/from\s+["'][^"']*\/extensions\//);
  });

  it("接受行业命名空间、语义地址和动态详情页", () => {
    const registry = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [
          { path: "/orders", capabilityId: "hotel.orders", element: page },
          { path: "/orders/:orderId", capabilityId: "hotel.orders", element: page },
        ],
      },
    });
    expect(registry.error).toBeNull();
    expect(registry.routes.map((route) => route.path)).toEqual(["/orders", "/orders/:orderId"]);
  });

  it("任一声明无效时整组扩展失败关闭", () => {
    const registry = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [
          { path: "/orders", capabilityId: "hotel.orders", element: page },
          { path: "/approvals/export", capabilityId: "hotel.export", element: page },
        ],
      },
    });
    expect(registry.routes).toEqual([]);
    expect(registry.error?.message).toContain("不得覆盖基座地址");
  });

  it("拒绝重复匹配模式、基座能力和危险地址语法", () => {
    const duplicate = buildIndustryRouteRegistry({
      "../extensions/orders/routes.tsx": {
        industryRoutes: [
          { path: "/orders/:id", capabilityId: "hotel.orders", element: page },
          { path: "/orders/:orderId", capabilityId: "hotel.orders", element: page },
        ],
      },
    });
    expect(duplicate.routes).toEqual([]);
    expect(duplicate.error?.message).toContain("路由重复");
    expect(() => validateIndustryCapabilityId("workloom.approvals")).toThrow("行业命名空间");
    expect(() => validateIndustryRoutePath("/:path")).toThrow("首段");
    expect(() => validateIndustryRoutePath("/orders/*")).toThrow("不受支持");
  });

  it("只接受服务端已验证 Bundle 中同能力、同路径域的导航", () => {
    const entries = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
      permissions: ["hotel.orders.read"],
    }]);
    expect(industryRouteMatchesBundle({ path: "/orders/:orderId", capabilityId: "hotel.orders" }, entries)).toBe(true);
    expect(industryRouteMatchesBundle({ path: "/inventory", capabilityId: "hotel.orders" }, entries)).toBe(false);
    expect(industryRouteMatchesBundle({ path: "/orders", capabilityId: "hotel.inventory" }, entries)).toBe(false);
  });

  it("以服务端 navigationPermissions 的过滤结果作为唯一放行依据", () => {
    const knownEntries = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
      permissions: ["hotel.orders.read"],
    }]);
    const definition = { path: "/orders/:orderId", capabilityId: "hotel.orders" };
    expect(resolveIndustryRouteAccess(definition, knownEntries, [])).toBe("forbidden");
    expect(resolveIndustryRouteAccess(definition, knownEntries, knownEntries)).toBe("granted");

    const noPermission = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
    }]);
    expect(resolveIndustryRouteAccess(definition, noPermission, noPermission)).toBe("misconfigured");
  });
});
