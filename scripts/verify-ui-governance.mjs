#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findContentSafetyRisks,
  findDiagnosticIsolationRisks,
  findEntryStyleRisks,
  findIconAccessibilityRisks,
  findSharedIconRisks,
  findStylesheetLayoutRisks,
  findTypographyRisks,
  findViewportRisks,
  findRawDynamicValueRisks,
  findVisibleLanguageRisks,
} from "./ui-governance-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const errors = [];
const manifest = readJson("sync/base-capabilities.json");
const uiPackage = readJson("packages/ui/package.json");
const scope = readJson("sync/base-scope.json");

if (manifest.releasePolicy !== "base-first-stable-only") errors.push("基座发布策略必须为 base-first-stable-only");
if (manifest.ui.package !== uiPackage.name) errors.push("共享 UI 清单包名与 package.json 不一致");
if (manifest.ui.candidateVersion !== uiPackage.version) errors.push("共享 UI 候选版本与 package.json 不一致");
if (manifest.ui.latestStableVersion && manifest.ui.latestStableVersion !== uiPackage.version) {
  errors.push("latestStableVersion 只能指向当前已验收并将发布的包版本");
}
if (manifest.clientFoundation?.candidateVersion !== uiPackage.version) {
  errors.push("三端客户端基座候选版本必须与共享 UI 包版本一致");
}
if (manifest.clientFoundation?.latestStableVersion !== manifest.ui.latestStableVersion) {
  errors.push("三端客户端基座与共享 UI 的 latestStableVersion 必须一致");
}
if (manifest.clientFoundation?.distribution !== "stable-tag-upgrade-pr") {
  errors.push("三端客户端基座必须通过稳定标签升级 PR 分发");
}
if (!Number.isInteger(manifest.clientFoundation?.maxManagedFiles) || manifest.clientFoundation.maxManagedFiles > 2000) {
  errors.push("三端客户端基座缺少合理的受管文件数上限");
}
const foundationCapability = scope.clientFoundationCapability;
if (foundationCapability?.distribution !== "stable-tag-upgrade-pr") {
  errors.push("base-scope 未登记三端客户端基座稳定标签分发能力");
}
if (foundationCapability?.conflictPolicy !== "previous-source-sha256-fail-close") {
  errors.push("三端客户端基座必须采用旧来源 SHA-256 冲突关闭策略");
}
for (const clientRoot of ["apps/web", "apps/webb", "apps/webc"]) {
  if (!scope.exclude.includes(`${clientRoot}/**`)) errors.push(`${clientRoot} 必须排除普通 base-sync，防止双通道覆盖`);
}
const registryCapability = scope.registryCapabilities?.find?.((entry) => entry.package === manifest.ui.package);
if (!registryCapability) errors.push("base-scope 未把共享 UI 声明为 registry 基座能力");
else {
  if (registryCapability.source !== "packages/ui/**") errors.push("共享 UI registry 能力源码必须唯一指向 packages/ui/**");
  for (const client of ["apps/web", "apps/webb", "apps/webc"]) {
    if (!registryCapability.consumers?.includes(client)) errors.push(`共享 UI registry 能力缺少消费者 ${client}`);
  }
  if (registryCapability.consumerGate !== "scripts/verify-ui-consumer.mjs") errors.push("共享 UI 缺少实际消费防分叉门禁");
}

for (const packagePath of ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"]) {
  const packageJson = readJson(packagePath);
  if (packageJson.dependencies?.[manifest.ui.package] !== "workspace:*") {
    errors.push(`${packagePath} 必须在基座仓消费 workspace:* 唯一源码`);
  }
}

for (const entryPath of ["apps/web/src/main.tsx", "apps/webb/src/main.tsx", "apps/webc/src/main.tsx"]) {
  const source = readFileSync(join(root, entryPath), "utf8");
  for (const risk of findEntryStyleRisks(source)) errors.push(`${entryPath}：${risk}`);
}

for (const indexPath of ["apps/web/index.html", "apps/webb/index.html", "apps/webc/index.html"]) {
  const source = readFileSync(join(root, indexPath), "utf8");
  for (const risk of findViewportRisks(source)) errors.push(`${indexPath}：${risk}`);
}

const pcTokenPath = "apps/web/src/styles/tokens.css";
const pcTokens = readFileSync(join(root, pcTokenPath), "utf8");
for (const match of pcTokens.matchAll(/^\s*(--(?:color|font|text|spacing|radius|animate)-[\w-]+):\s*([^;]+);/gm)) {
  const [, name, value] = match;
  if (name.startsWith("--color-scene-")) continue;
  if (!value.includes("var(--wl-")) {
    errors.push(`${pcTokenPath} 的旧令牌 ${name} 必须只做 --wl-* 兼容别名`);
  }
}
if (/^\s*--wl-[\w-]+\s*:/m.test(pcTokens)) {
  errors.push(`${pcTokenPath} 不得重新定义 --wl-*；共享语义令牌只能来自 packages/ui`);
}
const pcIndex = readFileSync(join(root, "apps/web/index.html"), "utf8");
if (!pcIndex.includes('data-wl-theme="dark"')) errors.push("PC 客户端未声明共享 dark 主题，兼容别名可能解析到错误主题");

const pcAppSource = readFileSync(join(root, "apps/web/src/App.tsx"), "utf8");
const developerPageSource = readFileSync(join(root, "apps/web/src/pages/p25/P25.tsx"), "utf8");
const playwrightSource = readFileSync(join(root, "playwright.config.ts"), "utf8");
for (const risk of findDiagnosticIsolationRisks(developerPageSource, pcAppSource, playwrightSource)) {
  errors.push(`授权开发诊断：${risk}`);
}

for (const required of [
  "packages/industry-contract/package.json",
  "packages/ui/src/tokens.css",
  "packages/ui/src/content-safety.css",
  "packages/ui/src/language.ts",
  "sync/set-ui-version.mjs",
  "sync/client-foundation.mjs",
  "sync/ui-upgrade-pr.mjs",
  "scripts/verify-client-foundation-consumer.mjs",
]) {
  if (!existsSync(join(root, required))) errors.push(`缺少 UI 基座治理文件：${required}`);
}

const rootPackage = readJson("package.json");
if (!rootPackage.scripts?.["bundle:governance"]) errors.push("根包缺少 bundle:governance 行业契约门禁");
const ciSource = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
if (!ciSource.includes("pnpm bundle:governance")) errors.push("CI 未执行行业包契约门禁");

const contentSafetyPath = "packages/ui/src/content-safety.css";
const contentSafety = readFileSync(join(root, contentSafetyPath), "utf8");
for (const risk of findContentSafetyRisks(contentSafety, pcTokens)) {
  errors.push(`${contentSafetyPath}：${risk}`);
}

const uiSource = ["packages/ui/src/language.ts", "packages/ui/src/tokens.css", "packages/ui/src/content-safety.css"]
  .map((path) => readFileSync(join(root, path), "utf8"))
  .join("\n")
  .toLowerCase();
for (const forbidden of ["云栖酒店", "总导演", "hotel-baseline", "panda-cineforge"]) {
  if (uiSource.includes(forbidden.toLowerCase())) errors.push(`共享 UI 基座混入行业语义：${forbidden}`);
}

function clientFiles(directory) {
  const absolute = join(root, directory);
  const rows = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dev" || entry.name === "__tests__") continue;
      rows.push(...clientFiles(relative));
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      rows.push(relative);
    }
  }
  return rows;
}

function clientStyleFiles(directory) {
  const absolute = join(root, directory);
  const rows = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...clientStyleFiles(relative));
    else if (entry.name.endsWith(".css")) rows.push(relative);
  }
  return rows;
}

function allClientComponentFiles(directory) {
  const absolute = join(root, directory);
  const rows = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      rows.push(...allClientComponentFiles(relative));
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      rows.push(relative);
    }
  }
  return rows;
}

const languageRisks = [];
for (const filePath of [
  ...clientFiles("apps/web/src"),
  ...clientFiles("apps/webb/src"),
  ...clientFiles("apps/webc/src"),
]) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findVisibleLanguageRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findRawDynamicValueRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findTypographyRisks(source)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findIconAccessibilityRisks(source)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findSharedIconRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
}
const regularClientFiles = new Set([
  ...clientFiles("apps/web/src"),
  ...clientFiles("apps/webb/src"),
  ...clientFiles("apps/webc/src"),
]);
for (const filePath of [
  ...allClientComponentFiles("apps/web/src"),
  ...allClientComponentFiles("apps/webb/src"),
  ...allClientComponentFiles("apps/webc/src"),
]) {
  if (regularClientFiles.has(filePath)) continue;
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findSharedIconRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findIconAccessibilityRisks(source)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
}
for (const filePath of [
  ...clientStyleFiles("apps/web/src"),
  ...clientStyleFiles("apps/webb/src"),
  ...clientStyleFiles("apps/webc/src"),
]) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findStylesheetLayoutRisks(source)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
}
if (languageRisks.length > 30) {
  errors.push(...languageRisks.slice(0, 30), `另有 ${languageRisks.length - 30} 项客户端语言问题未列出`);
} else {
  errors.push(...languageRisks);
}

if (errors.length) {
  console.error(`❌ UI 同源门禁失败（${errors.length} 项）`);
  for (const error of errors) console.error(`  · ${error}`);
  process.exit(1);
}
console.log(`✅ UI 同源门禁通过：${uiPackage.name}@${uiPackage.version}（稳定版：${manifest.ui.latestStableVersion ?? "尚未发布"}）`);
