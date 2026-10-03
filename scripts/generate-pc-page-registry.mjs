#!/usr/bin/env node
/** 从 PC 真正消费的路由和 React 页面元素生成登记；DOM/Vite 只存在于隔离构建子进程。 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  assertPcPageSources,
  PC_PAGE_REGISTRY_SOURCE,
  pcPageSourceHashes,
  sealPcPageRegistry,
} from "../packages/base/bundles/pc-page-registry.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const CLI = join(dirname(SCRIPT), "pc-page-registry-cli.mjs");
const DEFAULT_ROOT = resolve(dirname(SCRIPT), "..");

export async function collectPcPageRegistryInWorker(root, output) {
  if (process.env.WORKLOOM_PC_REGISTRY_WORKER !== "1") throw new Error("工作台页面登记必须在受控隔离进程内生成");
  const web = join(root, "apps/web");
  const requireWeb = createRequire(join(web, "package.json"));
  const [{ JSDOM }, { createServer }, react] = await Promise.all([
    import(pathToFileURL(requireWeb.resolve("jsdom")).href),
    import(pathToFileURL(requireWeb.resolve("vite")).href),
    import(pathToFileURL(requireWeb.resolve("react")).href),
  ]);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://workloom-build.invalid" });
  for (const name of ["window", "document", "localStorage", "CustomEvent", "HTMLElement", "HTMLCanvasElement"]) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  }
  const sources = pcPageSourceHashes(root);
  let server;
  try {
    // 无网络监听、无测试模拟模块；Vite 按实际配置发现所有 extension routes.ts(x)。
    server = await createServer({
      root: web,
      server: { middlewareMode: true },
      appType: "custom",
      ssr: { noExternal: ["@workloom/ui"] },
      logLevel: "error",
    });
    const app = await server.ssrLoadModule("/src/App.tsx");
    const industry = await server.ssrLoadModule("/src/shell/IndustryRoutes.tsx");
    if (!Array.isArray(app.BASE_ROUTE_REGISTRY) || app.BASE_ROUTE_REGISTRY.length === 0) {
      throw new Error("PC 实际入口没有导出公共路由登记");
    }
    if (!industry.INDUSTRY_ROUTE_REGISTRY || industry.INDUSTRY_ROUTE_REGISTRY.error) {
      throw industry.INDUSTRY_ROUTE_REGISTRY?.error ?? new Error("PC 行业路由登记不可用");
    }
    const routes = [];
    for (const definition of app.BASE_ROUTE_REGISTRY) {
      if (!react.isValidElement(definition.element)) throw new Error(`公共路由缺少真实页面元素：${definition.path}`);
      routes.push({ path: definition.path, source: "base", legacyPaths: [] });
    }
    for (const definition of industry.INDUSTRY_ROUTE_REGISTRY.routes) {
      if (!react.isValidElement(definition.element)) throw new Error(`行业路由缺少真实页面元素：${definition.path}`);
      routes.push({ path: definition.path, source: "industry", capabilityId: definition.capabilityId, legacyPaths: [...(definition.legacyPaths ?? [])] });
    }
    const registry = sealPcPageRegistry({ routes, sources });
    assertPcPageSources(registry, root);
    writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`);
  } finally {
    if (server) await server.close();
    dom.window.close();
  }
}

export function generatePcPageRegistry(root = DEFAULT_ROOT) {
  if (process.env.WORKLOOM_PC_REGISTRY_WORKER === "1") throw new Error("拒绝工作台页面登记递归生成");
  const temporary = mkdtempSync(join(tmpdir(), "wl-pc-pages-"));
  const output = join(temporary, "registry.json");
  try {
    execFileSync(process.execPath, [CLI, "--worker", "--root", resolve(root), "--output", output], {
      cwd: root,
      timeout: 45000,
      killSignal: "SIGKILL",
      env: { ...process.env, WORKLOOM_PC_REGISTRY_WORKER: "1" },
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(readFileSync(output, "utf8"));
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`生成真实工作台页面登记失败：${detail}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
