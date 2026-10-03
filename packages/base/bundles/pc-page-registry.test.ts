import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBundleManifest, type BundleManifest } from "@workloom/industry-contract";
import {
  loadPcPageRegistry,
  parsePcPageRegistry,
  pcPageSourceHashes,
  registeredBundlePcPages,
  sealPcPageRegistry,
  validateBundlePcCases,
  type PcPageDefinition,
  type PcPageRegistry,
} from "./pc-page-registry.mjs";

const sources = { "apps/web/src/App.tsx": "0".repeat(64) };
const routes: PcPageDefinition[] = [
  { path: "/", source: "base", legacyPaths: [] },
  { path: "/p2/:threadId", source: "base", legacyPaths: [] },
  { path: "/tasks/:threadId", source: "base", legacyPaths: [] },
  { path: "/hotel/orders", source: "industry", capabilityId: "hotel.orders", legacyPaths: ["/p13"] },
  { path: "/hotel/orders/:orderId", source: "industry", capabilityId: "hotel.orders", legacyPaths: ["/p13/:orderId"] },
  { path: "/retail/orders", source: "industry", capabilityId: "retail.orders", legacyPaths: ["/p40"] },
];
const registry = () => sealPcPageRegistry({ routes, sources });
const manifest = (): BundleManifest => parseBundleManifest({
  schemaVersion: "workloom.bundle/v1", name: "@workloom/hotel", version: "1.0.0",
  workloom: {
    industry: "hotel", displayName: "页面登记合成夹具", description: "用于页面和权限边界测试的合成行业包",
    status: "draft", owner: "测试成员", example: false,
    compatibility: { base: ">=0.1.0 <1.0.0", ui: ">=0.1.0 <1.0.0", contract: "2.0.0" },
    provides: {},
    ui: {
      schemaVersion: "workloom.bundle.ui/v1",
      navigation: { slots: [{ capabilityId: "hotel.orders", title: "订单", route: "/hotel/orders", group: "operations", icon: "history", clients: ["pc"], permissions: ["hotel.orders.read"] }] },
      home: { widgets: [] }, serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
      theme: { brand: {} }, permissions: ["hotel.orders.read"],
    },
  },
});
const cases = (...pages: string[]) => ({ cases: pages.map((page) => ({ page, name: "默认状态" })) });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { root: string; value: PcPageRegistry } {
  const root = mkdtempSync(join(tmpdir(), "wl-pc-registry-test-"));
  roots.push(root);
  for (const [path, text] of [
    ["apps/web/src/App.tsx", "// 合成源码：只验证载荷完整性，不用作真实页面验收证据\n"],
    ["apps/web/src/shell/IndustryRoutes.tsx", "// 合成行业入口\n"],
  ]) {
    const file = join(root, path!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text!);
  }
  const value = sealPcPageRegistry({ routes, sources: pcPageSourceHashes(root) });
  const file = join(root, "apps/web/src/projections/pc-page-registry.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return { root, value };
}

describe("PC 页面登记与本行业权限契约", () => {
  it("公共参数页面、真实行业主路径和历史别名均可校验；其他行业页面不进入本包", () => {
    const actual = registry();
    const owned = manifest();
    expect(validateBundlePcCases(cases("p2", "/tasks/:threadId", "p13", "/hotel/orders/:orderId"), actual, owned).ok).toBe(true);
    expect(registeredBundlePcPages(actual, owned)).not.toContain("p40");
  });

  it.each([
    { label: "未知编号", page: "p999" },
    { label: "伪造语义地址", page: "/hotel/missing" },
    { label: "跨行业历史别名", page: "p40" },
    { label: "跨行业主地址", page: "/retail/orders" },
    { label: "不规范地址", page: "//hotel/orders" },
    { label: "参数值冒充模式", page: "/tasks/unknown-thread" },
  ])("$label 不可通过 cases.pages 自行注册", ({ page }) => {
    const document = { ...cases(page), pages: [page] };
    const checked = validateBundlePcCases(document, registry(), manifest());
    expect(checked.ok).toBe(false);
    expect(checked.detail).toContain(page);
  });

  it.each([
    { label: "能力不匹配", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.capabilityId = "hotel.other"; } },
    { label: "路径不匹配", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.route = "/hotel/other"; } },
    { label: "相似路径前缀", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.route = "/hotel/order"; } },
    { label: "仅移动端", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.clients = ["b-mobile"]; } },
    { label: "空权限", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.permissions = []; } },
    { label: "权限未声明", change: (bundle: BundleManifest) => { bundle.workloom.ui.permissions = []; } },
    { label: "权限越过命名空间", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots[0]!.permissions = ["retail.orders.read"]; bundle.workloom.ui.permissions = ["retail.orders.read"]; } },
    { label: "包越过命名空间", change: (bundle: BundleManifest) => { bundle.workloom.industry = "copycat"; } },
    { label: "无导航", change: (bundle: BundleManifest) => { bundle.workloom.ui.navigation.slots = []; } },
  ])("$label 时主路径与历史别名共同拒绝，公共页面仍可用", ({ change }) => {
    const owned = manifest();
    change(owned);
    expect(validateBundlePcCases(cases("p13", "/hotel/orders"), registry(), owned).ok).toBe(false);
    expect(validateBundlePcCases(cases("p2"), registry(), owned).ok).toBe(true);
  });

  it.each([null, {}, { cases: [] }, { cases: "伪造清单" }, { cases: [{ page: "p2" }] }, { cases: [{ page: 2, name: "默认" }] }, { cases: [{ page: "p2", name: " " }] }])("空或非法用例 %j 失败关闭", (document) => {
    expect(validateBundlePcCases(document, registry(), manifest()).ok).toBe(false);
  });

  it("重复引用同页不同状态合法；重复路由匹配模式、历史别名和无效参数则拒绝整个登记", () => {
    expect(validateBundlePcCases(cases("p13", "p13"), registry(), manifest())).toMatchObject({ ok: true, pages: ["p13"], caseCount: 2 });
    expect(() => sealPcPageRegistry({ routes: [...routes, { path: "/tasks/:otherId", source: "base", legacyPaths: [] }], sources })).toThrow(/重复路由/);
    expect(() => sealPcPageRegistry({ routes: [...routes, { path: "/retail/other", source: "industry", capabilityId: "retail.other", legacyPaths: ["/p13"] }], sources })).toThrow(/重复路由/);
    expect(() => sealPcPageRegistry({ routes: [{ ...routes[3]!, path: "/hotel/orders/:orderId", legacyPaths: ["/p13/:differentId"] }], sources })).toThrow(/历史地址/);
  });

  it.each(["/hotel/*", "/hotel/../orders", "/hotel/orders?x=1", "/hotel/orders#x", "/hotel/orders/"])("非法路由 %s 不能进入登记", (path) => {
    expect(() => sealPcPageRegistry({ routes: [{ ...routes[3]!, path, legacyPaths: [] }], sources })).toThrow();
  });

  it("摘要不可用于伪装改过的页面清单；版本和未知字段均拒绝", () => {
    expect(() => parsePcPageRegistry({ ...registry(), routes: [...routes, { path: "/hotel/fake", source: "base", legacyPaths: [] }] })).toThrow(/摘要不一致/);
    expect(() => parsePcPageRegistry({ ...registry(), schemaVersion: "unknown" })).toThrow(/格式无效/);
    expect(() => parsePcPageRegistry({ ...registry(), approved: true })).toThrow(/格式无效/);
  });

  it("页面登记上界可判定：1000 条真实形状可解析，1001 条拒绝整个登记", () => {
    const bounded: PcPageDefinition[] = Array.from({ length: 1000 }, (_, index) => ({
      path: `/registered-${index}`, source: "base", legacyPaths: [],
    }));
    expect(sealPcPageRegistry({ routes: bounded, sources }).routes).toHaveLength(1000);
    expect(() => sealPcPageRegistry({ routes: [...bounded, { path: "/overflow", source: "base", legacyPaths: [] }], sources }))
      .toThrow(/格式无效/);
  });
});

describe("PC 登记在仓库和正式载荷中的完整性", () => {
  it("缺失、损坏或摘要不一致时拒绝，不能回退固定页面表", () => {
    const { root, value } = fixtureRoot();
    const path = join(root, "apps/web/src/projections/pc-page-registry.json");
    unlinkSync(path);
    expect(() => loadPcPageRegistry({ root, production: false })).toThrow(/登记不可用/);
    writeFileSync(path, "{broken");
    expect(() => loadPcPageRegistry({ root, production: false })).toThrow(/登记不可用/);
    writeFileSync(path, JSON.stringify({ ...value, digest: "0".repeat(64) }));
    expect(() => loadPcPageRegistry({ root, production: false })).toThrow(/摘要不一致/);
  });

  it.each(["changed", "added", "removed", "foreign"])("来源 %s 时旧登记不可继续使用", (mode) => {
    const { root } = fixtureRoot();
    const app = join(root, "apps/web/src/App.tsx");
    if (mode === "removed") unlinkSync(app);
    else if (mode === "added") writeFileSync(join(root, "apps/web/src/new-route.tsx"), "export {};\n");
    else writeFileSync(app, mode === "foreign" ? "// 另一个产品的来源\n" : "// 已修改来源\n");
    expect(() => loadPcPageRegistry({ root, production: false })).toThrow(/来源|过期|其他产品|真实路由入口/);
  });

  it("生产只认真实入口和脚本，不用源码登记兜底；文件篡改或额外脚本均拒绝", () => {
    const { root, value } = fixtureRoot();
    expect(() => loadPcPageRegistry({ root, production: true })).toThrow(/登记不可用/);
    const directory = join(root, "apps/web/dist");
    mkdirSync(join(directory, "assets"), { recursive: true });
    writeFileSync(join(directory, "pc-page-registry.json"), JSON.stringify(value));
    expect(() => loadPcPageRegistry({ root, production: true })).toThrow(/真实客户端构建文件/);
    const bytes = { "index.html": '<html><script src="assets/main.js"></script></html>', "assets/main.js": "export const fixture = true;\n" };
    for (const [path, text] of Object.entries(bytes)) writeFileSync(join(directory, path), text);
    const artifacts = Object.fromEntries(Object.entries(bytes).map(([path, text]) => [path, createHash("sha256").update(text).digest("hex")]));
    writeFileSync(join(directory, "pc-page-registry.json"), JSON.stringify(sealPcPageRegistry({ ...value, artifacts })));
    expect(loadPcPageRegistry({ root, production: true }).digest).not.toBe(value.digest);
    writeFileSync(join(directory, "assets/main.js"), "export const tampered = true;\n");
    expect(() => loadPcPageRegistry({ root, production: true })).toThrow(/构建文件与页面登记不一致/);
    writeFileSync(join(directory, "assets/main.js"), bytes["assets/main.js"]);
    writeFileSync(join(directory, "assets/injected.js"), "export {};\n");
    expect(() => loadPcPageRegistry({ root, production: true })).toThrow(/文件清单/);
  });

  it("重复和并发纯读取稳定，登记和原始 Bundle 结构不被改写", async () => {
    const { root } = fixtureRoot();
    const before = readFileSync(join(root, "apps/web/src/projections/pc-page-registry.json"), "utf8");
    const owned = manifest();
    const input = JSON.stringify(owned);
    const checks = await Promise.all(Array.from({ length: 32 }, async () => validateBundlePcCases(cases("p2", "p13"), loadPcPageRegistry({ root, production: false }), owned)));
    expect(checks.every((result) => result.ok)).toBe(true);
    expect(JSON.stringify(owned)).toBe(input);
    expect(readFileSync(join(root, "apps/web/src/projections/pc-page-registry.json"), "utf8")).toBe(before);
  });
});
