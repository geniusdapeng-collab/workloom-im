import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { generatePcPageRegistry } from "./generate-pc-page-registry.mjs";
import { loadPcPageRegistry } from "../packages/base/bundles/pc-page-registry.mjs";
import { workloomPcPageRegistry } from "./vite-pc-page-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("递归生成请求在创建子进程前失败关闭", () => {
  const previous = process.env.WORKLOOM_PC_REGISTRY_WORKER;
  process.env.WORKLOOM_PC_REGISTRY_WORKER = "1";
  try {
    assert.throws(() => generatePcPageRegistry(root), /递归生成/);
  } finally {
    if (previous === undefined) delete process.env.WORKLOOM_PC_REGISTRY_WORKER;
    else process.env.WORKLOOM_PC_REGISTRY_WORKER = previous;
  }
});

test("实际 PC 入口重复生成稳定，公共首页与行业真实路由同时存在", () => {
  const first = generatePcPageRegistry(root);
  const second = generatePcPageRegistry(root);
  assert.equal(first.digest, second.digest);
  assert.equal(first.routes.filter((route) => route.source === "base").length, 54);
  assert.ok(first.routes.some((route) => route.source === "industry"));
  assert.ok(first.routes.some((route) => route.path === "/" && route.source === "base"));
  assert.ok(first.routes.some((route) => route.path === "/p31" && route.source === "base"));
});

for (const invalid of ["missing-element", "missing-module", "duplicate", "foreign-reserved", "invalid-export"]) {
  test(`真实扩展发现器拒绝 ${invalid}，不产出部分路由登记`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "wl-actual-route-fixture-"));
    try {
      const web = join(fixture, "apps/web");
      mkdirSync(join(web, "src/shell"), { recursive: true });
      mkdirSync(join(web, "src/extensions/fixture"), { recursive: true });
      writeFileSync(join(web, "package.json"), '{"type":"module"}\n');
      symlinkSync(join(root, "apps/web/node_modules"), join(web, "node_modules"), "dir");
      cpSync(join(root, "apps/web/src/shell/IndustryRoutes.tsx"), join(web, "src/shell/IndustryRoutes.tsx"));
      writeFileSync(join(web, "src/shell/NavigationAccess.tsx"), "export function useNavigationAccess() { throw new Error('夹具不渲染权限边界'); }\n");
      writeFileSync(join(web, "src/App.tsx"), `import React from 'react';\nexport const BASE_ROUTE_REGISTRY = [{ path: '/', element: React.createElement('main') }];\n`);
      const valid = `{ path: '/fixture/orders', capabilityId: 'fixture.orders', element: React.createElement('main'), legacyPaths: ['/p40'] }`;
      const text = invalid === "missing-module" ? "import React from 'react'; import Missing from './missing-page'; export const industryRoutes = [{ path: '/fixture/orders', capabilityId: 'fixture.orders', element: React.createElement(Missing) }];"
        : invalid === "invalid-export" ? "export const industryRoutes = {};"
        : `import React from 'react'; export const industryRoutes = [${invalid === "missing-element" ? valid.replace("React.createElement('main')", "null")
          : invalid === "foreign-reserved" ? valid.replace("/fixture/orders", "/tasks")
          : `${valid}, ${valid}`}];`;
      writeFileSync(join(web, "src/extensions/fixture/routes.tsx"), text);
      assert.throws(() => generatePcPageRegistry(fixture), /生成真实工作台页面登记失败/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("真实构建同时绑定打包脚本与 public 复制文件，正式读取无需 Vite 或 React", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "wl-pc-public-build-"));
  try {
    const web = join(fixture, "apps/web");
    mkdirSync(join(web, "src/shell"), { recursive: true });
    mkdirSync(join(web, "public"), { recursive: true });
    writeFileSync(join(web, "package.json"), '{"type":"module"}\n');
    symlinkSync(join(root, "apps/web/node_modules"), join(web, "node_modules"), "dir");
    cpSync(join(root, "apps/web/src/shell/IndustryRoutes.tsx"), join(web, "src/shell/IndustryRoutes.tsx"));
    writeFileSync(join(web, "src/shell/NavigationAccess.tsx"), "export function useNavigationAccess() { throw new Error('夹具不渲染权限边界'); }\n");
    writeFileSync(join(web, "src/App.tsx"), "import React from 'react'; export const BASE_ROUTE_REGISTRY = [{ path: '/', element: React.createElement('main') }];\n");
    writeFileSync(join(web, "src/main.ts"), "document.body.textContent = '真实构建夹具';\n");
    writeFileSync(join(web, "index.html"), '<html><body><script type="module" src="/src/main.ts"></script></body></html>\n');
    writeFileSync(join(web, "public/vendor.js"), "window.fixtureVendor = true;\n");
    writeFileSync(join(web, "public/help.html"), "<html><body>随包页面</body></html>\n");
    const requireWeb = createRequire(join(root, "apps/web/package.json"));
    const { build } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
    await build({ root: web, configFile: false, plugins: [workloomPcPageRegistry()], logLevel: "error" });
    rmSync(join(web, "node_modules"));
    const registry = loadPcPageRegistry({ root: fixture, production: true });
    assert.ok(registry.artifacts["vendor.js"]);
    assert.ok(registry.artifacts["help.html"]);
    assert.ok(Object.keys(registry.artifacts).some((name) => name.startsWith("assets/") && name.endsWith(".js")));
    writeFileSync(join(web, "dist/vendor.js"), "window.fixtureVendor = 'tampered';\n");
    assert.throws(() => loadPcPageRegistry({ root: fixture, production: true }), /构建文件与页面登记不一致/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
