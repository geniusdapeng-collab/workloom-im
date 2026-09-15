import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBundleUiProjection, type BundleUiProjection } from "@workloom/base/bundles";
import {
  bindBusinessAdapter,
  registeredBusinessAdapterIds,
} from "./business-registry.js";

describe("服务前台行业适配器契约", () => {
  it("酒店仅由已封装活动 Bundle 的 adapterId 显式启用", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(result).toMatchObject({
      state: "ready",
      bundleId: "hotel",
      installId: "bi-hotel",
      adapter: { id: "hotel.service-front-v1" },
    });
    expect(result.adapter?.kbLexicon?.synonyms).toContainEqual(["会员", "会员卡"]);
  });

  it("AI 产品经理默认包未声明行业适配器，绝不回退酒店", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "ai-pm",
      activeInstalls: [{ id: "bi-aipm", bundleId: "ai-pm" }],
    });
    expect(result.state).toBe("adapter-not-declared");
    expect(result.adapter).toBeNull();
  });

  it("无活动装配、指针冲突、投影篡改和未知适配器均失败关闭", () => {
    expect(bindBusinessAdapter({ workspaceBundleId: "ai-pm", activeInstalls: [] }).adapter).toBeNull();

    const mismatch = bindBusinessAdapter({
      workspaceBundleId: "ai-pm",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(mismatch).toMatchObject({ state: "bundle-mismatch", adapter: null });

    const invalid = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    }, () => { throw new Error("摘要不一致"); });
    expect(invalid).toMatchObject({ state: "projection-invalid", adapter: null });

    const base = loadBundleUiProjection("ai-pm");
    const unknownProjection: BundleUiProjection = {
      ...base,
      bundleId: "unknown",
      ui: {
        ...base.ui,
        serviceFront: { ...base.ui.serviceFront, adapterId: "unknown.service-front-v1" },
      },
    };
    const unknown = bindBusinessAdapter({
      workspaceBundleId: "unknown",
      activeInstalls: [{ id: "bi-unknown", bundleId: "unknown" }],
    }, () => unknownProjection);
    expect(unknown).toMatchObject({ state: "adapter-unknown", adapter: null });
  });

  it("受控注册表不包含通用默认适配器", () => {
    expect(registeredBusinessAdapterIds()).toEqual(["hotel.service-front-v1"]);
  });

  it("其他 Bundle 即使伪造酒店 adapterId，也无权选择酒店实现", () => {
    const hotel = loadBundleUiProjection("hotel");
    const result = bindBusinessAdapter({
      workspaceBundleId: "ai-pm",
      activeInstalls: [{ id: "bi-aipm", bundleId: "ai-pm" }],
    }, () => ({
      ...hotel,
      bundleId: "ai-pm",
      ui: { ...hotel.ui, serviceFront: { ...hotel.ui.serviceFront, adapterId: "hotel.service-front-v1" } },
    }));
    expect(result).toMatchObject({ state: "adapter-untrusted", adapter: null, bundleId: "ai-pm" });
  });

  it("基座网关、通用对话和启动引导不再含酒店数据访问或酒店展示语义", () => {
    const gateway = readFileSync(new URL("../gateway.ts", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("../dialog.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
    const ticket = readFileSync(new URL("../ticket.ts", import.meta.url), "utf8");
    const forbidden = /biz-hotel|hotelBizAdapter|demo_orders|demo_members|云栖酒店|房型价格|客房部|前厅部/;
    expect(gateway).not.toMatch(forbidden);
    expect(dialog).not.toMatch(forbidden);
    expect(store).not.toMatch(forbidden);
    expect(ticket).not.toMatch(forbidden);
  });

  it("通用注册表不直接导入任何具体行业实现", () => {
    const registry = readFileSync(new URL("./business-registry.ts", import.meta.url), "utf8");
    expect(registry).not.toMatch(/service-front-adapter|hotelBizAdapter|industry\/hotel/);
    expect(registry).toContain("business-adapter-catalog");
  });
});
