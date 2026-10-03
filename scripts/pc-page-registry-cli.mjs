#!/usr/bin/env node
/** 独立 CLI/worker 入口，不由 Vite 配置导入，避免配置打包重新执行 main。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPcPageRegistryInWorker, generatePcPageRegistry } from "./generate-pc-page-registry.mjs";
import { PC_PAGE_REGISTRY_SOURCE } from "../packages/base/bundles/pc-page-registry.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const root = resolve(option("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
try {
  if (process.argv.includes("--worker")) {
    const output = option("--output");
    if (!output) throw new Error("隔离构建进程缺少输出路径");
    await collectPcPageRegistryInWorker(root, resolve(output));
  } else {
    const registry = generatePcPageRegistry(root);
    const output = resolve(option("--output") ?? join(root, PC_PAGE_REGISTRY_SOURCE));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(`工作台页面登记已生成：${registry.routes.length} 条实际路由，${Object.keys(registry.sources).length} 个来源文件`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
