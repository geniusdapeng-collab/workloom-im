#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findUiReleaseWorkflowRisks } from "../sync/ui-release-workflow-contract.mjs";
import { industryAssetDependencyRisks, provableRelativeSurfaceImports, registeredServiceWorkerRisks } from "./verify-ui-consumer.mjs";
import {
  findBundleDisplayLanguageRisks,
  findBannerAlertContractRisks,
  findClientTextSinkRisks,
  findComponentMatrixIsolationRisks,
  findContentSafetyRisks,
  findDiagnosticIsolationRisks,
  findEntryStyleRisks,
  findHtmlVisibleLanguageRisks,
  findIconAccessibilityRisks,
  findSharedIconRisks,
  findStylesheetLayoutRisks,
  findStylesheetGeneratedContentRisks,
  findStylesheetSurfaceRisks,
  findTypographyRisks,
  findViewportRisks,
  findRawDynamicValueRisks,
  findUnmanagedSurfaceRisks,
  findPcExtensionNavigationRisks,
  findVisibleLanguageRisks,
  isBundleUiConfig,
  isClientPublicHtml,
  findClientWebManifestRisks,
  isClientWebManifest,
  isClientSurfaceSource,
  isIndustryExtensionStylesheet,
  isPcIndustryNavigationSource,
  GOVERNED_INDUSTRY_EXTENSION_PATHS,
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
if (JSON.stringify(manifest.clientFoundation?.allowedIndustryExtensionPaths)
  !== JSON.stringify(GOVERNED_INDUSTRY_EXTENSION_PATHS)) {
  errors.push("clientFoundation 行业可写路径必须与 UI 导航治理覆盖范围逐项一致");
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
if (!registryCapability) errors.push("base-scope 未把共享 UI 声明为稳定 Release 制品能力");
else {
  if (registryCapability.source !== "packages/ui/**") errors.push("共享 UI Release 制品源码必须唯一指向 packages/ui/**");
  if (registryCapability.distribution !== "stable-github-release-upgrade-pr") {
    errors.push("共享 UI 必须通过稳定 GitHub Release 升级 PR 分发");
  }
  for (const client of ["apps/web", "apps/webb", "apps/webc"]) {
    if (!registryCapability.consumers?.includes(client)) errors.push(`共享 UI Release 制品缺少消费者 ${client}`);
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
  for (const risk of findHtmlVisibleLanguageRisks(source, indexPath)) errors.push(`${indexPath}:${risk.line} ${risk.rule}（${risk.text}）`);
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
const componentMatrixSource = readFileSync(join(root, "apps/web/src/pages/dev/DevMatrix.tsx"), "utf8");
const playwrightSource = readFileSync(join(root, "playwright.config.ts"), "utf8");
const productManifest = existsSync(join(root, "product.manifest.json")) ? readJson("product.manifest.json") : null;
const developerPagePath = "apps/web/src/extensions/ai-pm/P25.tsx";
const developerRoutePath = "apps/web/src/extensions/ai-pm/routes.tsx";
const hasDeveloperPage = existsSync(join(root, developerPagePath));
const hasDeveloperRoute = existsSync(join(root, developerRoutePath));
if (hasDeveloperPage !== hasDeveloperRoute || (productManifest?.defaultBundle === "ai-pm" && !hasDeveloperPage)) {
  errors.push("AI 产品经理开发场域必须由页面与行业路由成对提供");
} else if (hasDeveloperPage && hasDeveloperRoute) {
  const developerPageSource = readFileSync(join(root, developerPagePath), "utf8");
  const developerRouteSource = readFileSync(join(root, developerRoutePath), "utf8");
  for (const risk of findDiagnosticIsolationRisks(developerPageSource, pcAppSource, playwrightSource, developerRouteSource)) {
    errors.push(`授权开发诊断：${risk}`);
  }
}
for (const risk of findComponentMatrixIsolationRisks(componentMatrixSource, pcAppSource, playwrightSource)) {
  errors.push(`组件矩阵诊断：${risk}`);
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
const expectedUiRepository = "git+https://github.com/geniusdapeng-collab/workloom-im.git";
if (uiPackage.license !== "Apache-2.0") errors.push("共享 UI 包必须声明与主仓一致的 Apache-2.0 许可证");
if (uiPackage.repository?.type !== "git" || uiPackage.repository?.url !== expectedUiRepository
  || uiPackage.repository?.directory !== "packages/ui") {
  errors.push("共享 UI 包 repository 必须精确指向 workloom-im/packages/ui，防止制品来源漂移");
}
const uiReleaseSource = readFileSync(join(root, ".github/workflows/ui-release.yml"), "utf8");
for (const risk of findUiReleaseWorkflowRisks(uiReleaseSource)) errors.push(`共享 UI 发布：${risk}`);

const contentSafetyPath = "packages/ui/src/content-safety.css";
const contentSafety = readFileSync(join(root, contentSafetyPath), "utf8");
for (const risk of findContentSafetyRisks(contentSafety, pcTokens)) {
  errors.push(`${contentSafetyPath}：${risk}`);
}
for (const risk of findBannerAlertContractRisks(
  readFileSync(join(root, "packages/ui/src/components.tsx"), "utf8"),
  readFileSync(join(root, "packages/ui/src/components.css"), "utf8"),
  readFileSync(join(root, "apps/web/src/components/hud/feedback.tsx"), "utf8"),
)) errors.push(`共享告警条：${risk}`);

const uiSource = ["packages/ui/src/language.ts", "packages/ui/src/tokens.css", "packages/ui/src/content-safety.css"]
  .map((path) => readFileSync(join(root, path), "utf8"))
  .join("\n")
  .toLowerCase();
for (const forbidden of ["云栖酒店", "总导演", "hotel-baseline", "panda-cineforge"]) {
  if (uiSource.includes(forbidden.toLowerCase())) errors.push(`共享 UI 基座混入行业语义：${forbidden}`);
}

function projectFiles(directory) {
  const absolute = join(root, directory);
  const rows = [];
  const rootStat = readdirRootStat(absolute, directory);
  if (!rootStat) return rows;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${relative} 不得使用符号链接隐藏或逃逸 UI 治理扫描`);
    } else if (entry.isDirectory()) rows.push(...projectFiles(relative));
    else rows.push(relative);
  }
  return rows;
}

function readdirRootStat(absolute, directory) {
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    errors.push(`${directory} 不得使用符号链接隐藏或逃逸 UI 治理扫描`);
    return null;
  }
  if (!stat.isDirectory()) {
    errors.push(`${directory} 不是 UI 治理目录`);
    return null;
  }
  return stat;
}

function clientStyleFiles(directory) {
  const absolute = join(root, directory);
  const rows = [];
  const rootStat = readdirRootStat(absolute, directory);
  if (!rootStat) return rows;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${relative} 不得使用符号链接隐藏或逃逸 UI 样式治理扫描`);
    } else if (entry.isDirectory()) rows.push(...clientStyleFiles(relative));
    else if (/\.(?:css|scss)$/i.test(entry.name)) rows.push(relative);
  }
  return rows;
}

const languageRisks = [];
const clientSurfaceFiles = [
  ...projectFiles("apps/web/src"),
  ...projectFiles("apps/webb/src"),
  ...projectFiles("apps/webc/src"),
  ...projectFiles("packages/ui/src"),
  ...projectFiles("apps/web/public"),
  ...projectFiles("apps/webb/public"),
  ...projectFiles("apps/webc/public"),
].filter((filePath) => isClientSurfaceSource(filePath) || isPcIndustryNavigationSource(filePath));
const trustedRelativeSurfaces = provableRelativeSurfaceImports(root, clientSurfaceFiles);
for (const filePath of clientSurfaceFiles) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findVisibleLanguageRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findRawDynamicValueRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findClientTextSinkRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findUnmanagedSurfaceRisks(source, filePath, {
    trustedRelativeSurfaceImports: trustedRelativeSurfaces.get(filePath) ?? [],
  })) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  for (const risk of findPcExtensionNavigationRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  if (/\.(?:tsx|jsx)$/i.test(filePath) && filePath !== "apps/web/src/pages/dev/DevMatrix.tsx") {
    for (const risk of findTypographyRisks(source)) {
      languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
    }
    // packages/ui 本身是 Icon 注册表和可访问组件的定义处；业务端继续禁止另造图标。
    if (filePath.startsWith("apps/")) {
      for (const risk of findIconAccessibilityRisks(source)) {
        languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
      }
      for (const risk of findSharedIconRisks(source, filePath)) {
        languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
      }
    }
  }
}
for (const filePath of [
  ...projectFiles("apps/webc/public"),
  ...projectFiles("bundles"),
].filter(isBundleUiConfig)) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findBundleDisplayLanguageRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.path}=${risk.text.slice(0, 60)}）`);
  }
}
for (const filePath of [
  ...projectFiles("apps/web/public"),
  ...projectFiles("apps/webb/public"),
  ...projectFiles("apps/webc/public"),
].filter(isClientWebManifest)) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findClientWebManifestRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.path ?? "$"}=${risk.text.slice(0, 60)}）`);
  }
}
for (const filePath of [
  ...projectFiles("apps/web/public"),
  ...projectFiles("apps/webb/public"),
  ...projectFiles("apps/webc/public"),
].filter(isClientPublicHtml)) {
  const source = readFileSync(join(root, filePath), "utf8");
  for (const risk of findHtmlVisibleLanguageRisks(source, filePath)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
}
for (const clientRoot of ["apps/web", "apps/webb", "apps/webc"]) {
  languageRisks.push(...registeredServiceWorkerRisks(root, clientRoot));
}
languageRisks.push(...industryAssetDependencyRisks(root));
for (const filePath of [
  ...clientStyleFiles("packages/ui/src"),
  ...clientStyleFiles("apps/web/src"),
  ...clientStyleFiles("apps/webb/src"),
  ...clientStyleFiles("apps/webc/src"),
  ...clientStyleFiles("apps/web/public"),
  ...clientStyleFiles("apps/webb/public"),
  ...clientStyleFiles("apps/webc/public"),
]) {
  const source = readFileSync(join(root, filePath), "utf8");
  if (!filePath.startsWith("packages/ui/")) {
    for (const risk of findStylesheetLayoutRisks(source)) {
      languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
    }
  }
  for (const risk of findStylesheetGeneratedContentRisks(source)) {
    languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
  }
  if (isIndustryExtensionStylesheet(filePath)) {
    for (const risk of findStylesheetSurfaceRisks(source, filePath)) {
      languageRisks.push(`${filePath}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
    }
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
