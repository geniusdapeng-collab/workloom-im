#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findBundleDisplayLanguageRisks,
  findClientWebManifestRisks,
  findClientTextSinkRisks,
  findHtmlVisibleLanguageRisks,
  findIndustryConfigDisplayRisks,
  findIndustryConfigImports,
  findIndustryEmbeddedUiReferences,
  findIndustryHtmlResourceReferences,
  findPcExtensionNavigationRisks,
  findRawDynamicValueRisks,
  findStylesheetGeneratedContentRisks,
  findStylesheetLayoutRisks,
  findStylesheetSurfaceRisks,
  findStylesheetImports,
  findServiceWorkerRegistrations,
  findSurfaceModuleFacts,
  findUnmanagedSurfaceRisks,
  findVisibleLanguageRisks,
  findWorkerScriptImports,
  isBundleUiConfig,
  isClientPublicHtml,
  isClientWebManifest,
  isClientSurfaceSource,
  isIndustryExtensionStylesheet,
  isIndustryExtensionSource,
  isIndustryUiConfig,
  isPcIndustryNavigationSource,
} from "./ui-governance-rules.mjs";

const BUTTON_COMPONENTS = Object.freeze(["Button", "IconButton"]);
const FORM_CONTROL_COMPONENTS = Object.freeze(["Input", "Select", "Textarea", "Checkbox", "Switch"]);

const CLIENT_CONTRACTS = Object.freeze([
  {
    packagePath: "apps/web/package.json",
    root: "apps/web",
    marker: "b-pc",
    groups: [
      ["OverlayManager"],
      ["SideNavigation"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      BUTTON_COMPONENTS,
      FORM_CONTROL_COMPONENTS,
    ],
  },
  {
    packagePath: "apps/webb/package.json",
    root: "apps/webb",
    marker: "b-mobile",
    groups: [
      ["OverlayManager"],
      ["AppShell"],
      ["BottomTabs"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      BUTTON_COMPONENTS,
      FORM_CONTROL_COMPONENTS,
    ],
  },
  {
    packagePath: "apps/webc/package.json",
    root: "apps/webc",
    marker: "c-mobile",
    groups: [
      ["OverlayManager"],
      ["AppShell"],
      ["BottomTabs"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      BUTTON_COMPONENTS,
      FORM_CONTROL_COMPONENTS,
    ],
  },
]);

const DUPLICATE_COMPONENTS = new Map([
  ...[
    "AppShell", "Avatar", "Badge", "BannerAlert", "BottomTabs", "Button", "Card", "Chart", "Checkbox", "Combobox",
    "ConfirmDialog", "Delta", "Dialog", "Drawer", "EmptyState", "ErrorState", "ExportDialog", "FilterBar",
    "FullscreenSurface", "Grid", "IconButton", "Input", "Link", "Overlay", "OverlayManager", "Popover", "Radio",
    "ResizablePanel", "SectionNavigation", "Select", "Sheet", "SideNav", "SideNavigation", "Skeleton", "SplitView", "StatusChip", "Switch",
    "Table", "Tag", "Textarea", "Timeline", "Toast", "Tooltip", "TopContextBar", "WorkspaceSwitcher",
    "HeaderNav", "HeaderNavigation", "HorizontalNav", "HorizontalNavigation", "NavTabs", "NavigationTabs", "PageNav", "PageNavigation", "TopNav", "TopNavigation",
  ].map((name) => [name, name]),
  ["SkeletonBlock", "Skeleton"],
  ["SkeletonList", "Skeleton"],
  ["LoadingSkeleton", "Skeleton"],
  ["EmptyView", "EmptyState"],
  ["NoDataState", "EmptyState"],
  ["StatusBadge", "StatusChip"],
]);
const REQUIRED_STYLES = ["tokens.css", "content-safety.css", "components.css"];
const DEFAULT_ALLOWED_TOKENS = ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"];
const GOVERNANCE_TYPESCRIPT = "npm:typescript@5.9.3";
const GOVERNANCE_STATE = ".workloom-ui-governance.json";
const GOVERNANCE_SCHEMA = "workloom.ui-governance-state/v1";
const GOVERNANCE_UPDATE_POLICY = "stable-upgrade-pr-only";
const GOVERNANCE_FILES = Object.freeze([
  "scripts/verify-ui-consumer.mjs",
  "scripts/ui-governance-rules.mjs",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function governanceStateErrors(repo) {
  const errors = [];
  const statePath = join(repo, GOVERNANCE_STATE);
  if (!existsSync(statePath)) return [`缺少 ${GOVERNANCE_STATE}，无法证明行业仓治理脚本来自稳定升级 PR`];
  const stateStat = lstatSync(statePath);
  if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
    return [`${GOVERNANCE_STATE} 必须是仓内非符号链接普通文件`];
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [`${GOVERNANCE_STATE} 不是有效 JSON`];
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${GOVERNANCE_STATE} 顶层必须是 JSON 对象`];
  }
  if (state.schemaVersion !== GOVERNANCE_SCHEMA) {
    errors.push(`${GOVERNANCE_STATE} schemaVersion 必须为 ${GOVERNANCE_SCHEMA}`);
  }
  if (state.updatePolicy !== GOVERNANCE_UPDATE_POLICY) {
    errors.push(`${GOVERNANCE_STATE} updatePolicy 必须为 ${GOVERNANCE_UPDATE_POLICY}`);
  }
  if (state.dependency !== GOVERNANCE_TYPESCRIPT) {
    errors.push(`${GOVERNANCE_STATE} dependency 必须为 ${GOVERNANCE_TYPESCRIPT}`);
  }
  for (const path of GOVERNANCE_FILES) {
    const expected = state.files?.[path]?.sha256;
    if (!/^[0-9a-f]{64}$/u.test(expected ?? "")) {
      errors.push(`${GOVERNANCE_STATE} 缺少 ${path} 的有效 SHA-256 指纹`);
      continue;
    }
    const absolute = join(repo, path);
    if (!existsSync(absolute)) {
      errors.push(`治理文件缺失：${path}`);
      continue;
    }
    const parent = lstatSync(dirname(absolute));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      errors.push(`治理文件父目录必须是仓内非符号链接目录：${dirname(path)}`);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      errors.push(`治理文件必须是仓内非符号链接普通文件：${path}`);
      continue;
    }
    if (sha256(readFileSync(absolute)) !== expected) {
      errors.push(`${path} 与 ${GOVERNANCE_STATE} 指纹不一致`);
    }
  }
  return errors;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const rootStat = lstatSync(dir);
  if (rootStat.isSymbolicLink()) throw new Error(`UI 治理目录禁止符号链接：${dir}`);
  if (!rootStat.isDirectory()) throw new Error(`UI 治理扫描根不是目录：${dir}`);
  const files = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(name)) continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`UI 治理目录禁止符号链接：${full}`);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function resolvePublicScript(publicRoot, reference, baseDirectory = "") {
  if (!reference || /[\\\0\r\n]/u.test(reference) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
    return { error: `必须使用 public 内静态本地路径：${reference || "空路径"}` };
  }
  let clean = reference.split(/[?#]/u, 1)[0];
  try { clean = decodeURIComponent(clean); } catch { return { error: `路径编码无效：${reference}` }; }
  const parts = (clean.startsWith("/") ? clean.slice(1) : join(baseDirectory, clean)).replaceAll("\\", "/").split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return { error: `路径逃逸 public：${reference}` };
      normalized.pop();
    } else normalized.push(part);
  }
  const relativePath = normalized.join("/");
  if (!relativePath) return { error: `路径未指向 Worker 文件：${reference}` };
  const absolute = resolve(publicRoot, ...normalized);
  if (relative(publicRoot, absolute).split(/[\\/]/u).some((part) => part === "..")) return { error: `路径逃逸 public：${reference}` };
  if (!existsSync(absolute)) return { error: `已注册 Worker 不存在：${relativePath}` };
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return { error: `已注册 Worker 必须是非符号链接普通文件：${relativePath}` };
  return { absolute, relativePath };
}

/** 扫描真实注册目标及其本地 importScripts 依赖，文件名不再构成绕过边界。 */
export function registeredServiceWorkerRisks(repoPath, clientRoot) {
  const repo = resolve(repoPath);
  const publicRoot = join(repo, clientRoot, "public");
  const sourceRoot = join(repo, clientRoot, "src");
  const errors = [];
  const publicFiles = walk(publicRoot);
  const registrationFiles = [
    ...walk(sourceRoot).filter((file) => /\.[cm]?[jt]sx?$/i.test(file)),
    ...publicFiles.filter((file) => isClientPublicHtml(relative(repo, file).replaceAll("\\", "/"))),
    join(repo, clientRoot, "index.html"),
  ].filter((file) => existsSync(file));
  const queue = [];
  for (const file of registrationFiles) {
    const source = readFileSync(file, "utf8");
    const sourceName = relative(repo, file).replaceAll("\\", "/");
    for (const reference of findServiceWorkerRegistrations(source, sourceName)) {
      if (reference.rule) {
        errors.push(`${sourceName}:${reference.line} ${reference.rule}（${reference.text}）`);
        continue;
      }
      const resolved = resolvePublicScript(publicRoot, reference.path);
      if (resolved.error) errors.push(`${sourceName}:${reference.line} ${resolved.error}`);
      else queue.push(resolved);
    }
  }
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.absolute)) continue;
    visited.add(current.absolute);
    const fileName = `${clientRoot}/public/${current.relativePath}`;
    const source = readFileSync(current.absolute, "utf8");
    for (const risk of [
      ...findVisibleLanguageRisks(source, fileName),
      ...findRawDynamicValueRisks(source, fileName),
      ...findClientTextSinkRisks(source, fileName),
    ]) errors.push(`${fileName}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
    for (const reference of findWorkerScriptImports(source, fileName)) {
      if (reference.rule) {
        errors.push(`${fileName}:${reference.line} ${reference.rule}（${reference.text}）`);
        continue;
      }
      const resolved = resolvePublicScript(publicRoot, reference.path, dirname(current.relativePath));
      if (resolved.error) errors.push(`${fileName}:${reference.line} ${resolved.error}`);
      else queue.push(resolved);
    }
  }
  return errors;
}

function collectNamedImports(source) {
  const imported = new Map();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']@workloom\/ui["']/g)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [original, alias] = part.split(/\s+as\s+/).map((value) => value.trim());
      if (original) imported.set(original, alias || original);
    }
  }
  return imported;
}

function isRendered(source, alias) {
  return new RegExp(`<${alias}(?:\\s|/?>)`).test(source);
}

function contractLabel(group) {
  if (group === BUTTON_COMPONENTS) return `共享操作按钮（${group.join("、")} 至少一种）`;
  if (group === FORM_CONTROL_COMPONENTS) return `共享表单控件（${group.join("、")} 至少一种）`;
  return group.length === 1 ? group[0] : `以下任一组件：${group.join("、")}`;
}

/**
 * 相对 surface import 默认关闭；只有目标文件导出能静态证明直接委托共享表面时，
 * 才为当前使用文件生成精确的本地绑定白名单。缺文件、第三方转发和多级转发均不放行。
 */
export function provableRelativeSurfaceImports(repoPath, files) {
  const repo = resolve(repoPath);
  const normalizedFiles = [...new Set(files.map((file) => {
    const absolute = resolve(repo, file);
    return relative(repo, absolute).replaceAll("\\", "/");
  }))];
  const fileSet = new Set(normalizedFiles);
  const facts = new Map();
  for (const relativeFile of normalizedFiles) {
    if (!/\.[cm]?[jt]sx?$/i.test(relativeFile)) continue;
    facts.set(relativeFile, findSurfaceModuleFacts(readFileSync(join(repo, relativeFile), "utf8"), relativeFile));
  }
  const resolveModule = (fromFile, specifier) => {
    const rawTarget = resolve(dirname(join(repo, fromFile)), specifier);
    const suffixes = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"];
    const candidates = [rawTarget];
    const extension = extname(rawTarget);
    if (extension) {
      const withoutExtension = rawTarget.slice(0, -extension.length);
      candidates.push(...suffixes.map((suffix) => `${withoutExtension}${suffix}`));
    } else {
      candidates.push(...suffixes.map((suffix) => `${rawTarget}${suffix}`));
      candidates.push(...suffixes.map((suffix) => join(rawTarget, `index${suffix}`)));
    }
    for (const candidate of candidates) {
      const relativeCandidate = relative(repo, candidate).replaceAll("\\", "/");
      if (fileSet.has(relativeCandidate)) return relativeCandidate;
    }
    return null;
  };
  const result = new Map();
  for (const [relativeFile, moduleFacts] of facts) {
    const trusted = new Set();
    for (const binding of moduleFacts.relativeImports) {
      const target = resolveModule(relativeFile, binding.sourceName);
      const targetExports = target ? new Set(facts.get(target)?.provableExports ?? []) : new Set();
      if (binding.importedName === "*") {
        for (const exported of targetExports) {
          if (exported !== "default") trusted.add(`${binding.localName}.${exported}`);
        }
      } else if (targetExports.has(binding.importedName)) trusted.add(binding.localName);
    }
    result.set(relativeFile, trusted);
  }
  return result;
}

function industryAssetBoundary(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");
  const match = normalized.match(/^(apps\/(?:web|webb|webc)\/(?:src\/(?:extensions|projections|config\/industry|theme\/industry)|public\/industry))\/(.+)$/u);
  if (!match) return null;
  const root = match[1];
  const remainder = match[2];
  const categoryNeedsBundleBoundary = /\/(?:extensions|projections|public\/industry)$/u.test(root);
  if (!categoryNeedsBundleBoundary || !remainder.includes("/")) return root;
  return `${root}/${remainder.split("/", 1)[0]}`;
}

function isWithinRelativeBoundary(target, boundary) {
  return Boolean(boundary && (target === boundary || target.startsWith(`${boundary}/`)));
}

function resolveIndustryAsset(repo, sourceFile, reference, kind) {
  const sourceRelative = relative(repo, sourceFile).replaceAll("\\", "/");
  const boundary = industryAssetBoundary(sourceRelative);
  const rawTarget = resolve(dirname(sourceFile), reference);
  const rawRelative = relative(repo, rawTarget).replaceAll("\\", "/");
  if (rawRelative === ".." || rawRelative.startsWith("../") || !isWithinRelativeBoundary(rawRelative, boundary)) {
    return { error: `行业资源依赖越出当前扩展边界：${reference}` };
  }
  let candidates = [rawTarget];
  if (kind === "stylesheet" && !extname(rawTarget)) {
    const leaf = basename(rawTarget);
    candidates = [
      `${rawTarget}.css`, `${rawTarget}.scss`,
      join(dirname(rawTarget), `_${leaf}.scss`),
      join(rawTarget, "index.css"), join(rawTarget, "index.scss"), join(rawTarget, "_index.scss"),
    ];
  }
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) return { error: `行业本地资源不存在：${reference}` };
  const targetRelative = relative(repo, target).replaceAll("\\", "/");
  if (!isWithinRelativeBoundary(targetRelative, boundary)) return { error: `行业资源依赖越出当前扩展边界：${reference}` };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) return { error: `行业本地资源必须是非符号链接普通文件：${targetRelative}` };
  if (kind === "stylesheet" && !/\.(?:css|scss)$/i.test(targetRelative)) {
    return { error: `行业样式依赖只能指向 CSS/SCSS：${targetRelative}` };
  }
  if (kind === "脚本" && !/\.(?:[cm]?js)$/i.test(targetRelative)) {
    return { error: `行业 HTML 脚本只能指向本地 JS/MJS/CJS：${targetRelative}` };
  }
  if (kind === "样式" && !/\.css$/i.test(targetRelative)) {
    return { error: `行业 HTML 样式只能指向本地 CSS：${targetRelative}` };
  }
  return { absolute: target, relativeFile: targetRelative };
}

function industryBundleContext(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");
  const client = normalized.match(/^(apps\/(?:web|webb|webc))\//u)?.[1];
  if (!client) return null;
  const publicMatch = normalized.match(/^apps\/(?:web|webb|webc)\/public\/industry\/([^/]+)\//u);
  if (publicMatch) return { client, bundle: publicMatch[1] };
  const sourceMatch = normalized.match(/^apps\/(?:web|webb|webc)\/src\/(?:extensions|projections|config\/industry|theme\/industry)\/([^/]+)\//u);
  if (sourceMatch) return { client, bundle: sourceMatch[1] };
  return null;
}

function resolveEmbeddedIndustryHtml(repo, sourceFile, reference) {
  const sourceName = relative(repo, sourceFile).replaceAll("\\", "/");
  const context = industryBundleContext(sourceName);
  if (!context) return { error: `无法从来源路径证明嵌入界面的行业边界：${sourceName}` };
  const publicBoundary = join(repo, context.client, "public", "industry", context.bundle);
  let target;
  if (reference.startsWith("/")) {
    const expectedPrefix = `/industry/${context.bundle}/`;
    if (!reference.startsWith(expectedPrefix)) return { error: `嵌入界面绝对路径必须位于 ${expectedPrefix}` };
    target = resolve(join(repo, context.client, "public"), `.${reference}`);
  } else if (/\.html?$/i.test(sourceName)) {
    target = resolve(dirname(sourceFile), reference);
  } else {
    return { error: "行业 TSX 嵌入界面必须使用 /industry/<当前行业>/... 的绝对静态路径" };
  }
  const targetName = relative(repo, target).replaceAll("\\", "/");
  const boundaryName = relative(repo, publicBoundary).replaceAll("\\", "/");
  if (!isWithinRelativeBoundary(targetName, boundaryName)) return { error: `嵌入界面越出当前 public/industry 边界：${reference}` };
  if (!/\.html?$/i.test(targetName)) return { error: `嵌入界面必须指向受审 HTML：${targetName}` };
  if (!existsSync(target)) return { error: `嵌入界面 HTML 不存在：${targetName}` };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) return { error: `嵌入界面 HTML 必须是非符号链接普通文件：${targetName}` };
  return { absolute: target, relativeFile: targetName };
}

/**
 * 行业可写目录的文本资源依赖图：配置导入需 machine/display 分区，CSS/SCSS
 * 与 HTML 资源必须留在当前扩展边界且为普通本地文件。
 */
export function industryAssetDependencyRisks(repoPath) {
  const repo = resolve(repoPath);
  const errors = [];
  const allFiles = CLIENT_CONTRACTS.flatMap((client) => [
    ...walk(join(repo, client.root, "src")),
    ...walk(join(repo, client.root, "public")),
  ]);
  const relativeFiles = new Map(allFiles.map((file) => [relative(repo, file).replaceAll("\\", "/"), file]));
  const strictConfigs = new Set();
  const embeddedHtmlTargets = [];
  for (const [sourceName, sourceFile] of relativeFiles) {
    if (!isClientSurfaceSource(sourceName) && !isIndustryExtensionSource(sourceName)) continue;
    const source = readFileSync(sourceFile, "utf8");
    for (const reference of findIndustryConfigImports(source, sourceName)) {
      if (reference.rule) {
        errors.push(`${sourceName}:${reference.line} ${reference.rule}（${reference.text}）`);
        continue;
      }
      const target = resolve(dirname(sourceFile), reference.path);
      const targetName = relative(repo, target).replaceAll("\\", "/");
      if (isIndustryExtensionSource(sourceName)
        && (!isIndustryUiConfig(targetName) || !isWithinRelativeBoundary(targetName, industryAssetBoundary(sourceName)))) {
        errors.push(`${sourceName}:${reference.line} 行业 JSON/YAML 导入越出当前可治理扩展边界（${reference.path}）`);
        continue;
      }
      if (!isIndustryUiConfig(targetName)) continue;
      if (!existsSync(target)) {
        errors.push(`${sourceName}:${reference.line} 行业 JSON/YAML 不存在（${reference.path}）`);
        continue;
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        errors.push(`${sourceName}:${reference.line} 行业 JSON/YAML 必须是非符号链接普通文件（${targetName}）`);
        continue;
      }
      strictConfigs.add(targetName);
    }
    if (isIndustryExtensionSource(sourceName) && /\.[cm]?[jt]sx?$/i.test(sourceName)) {
      for (const reference of findIndustryEmbeddedUiReferences(source, sourceName)) {
        if (reference.rule) {
          errors.push(`${sourceName}:${reference.line} ${reference.rule}（${reference.text}）`);
          continue;
        }
        const resolved = resolveEmbeddedIndustryHtml(repo, sourceFile, reference.path);
        if (resolved.error) errors.push(`${sourceName}:${reference.line} ${resolved.error}`);
        else embeddedHtmlTargets.push(resolved.absolute);
      }
    }
  }
  for (const [fileName, file] of relativeFiles) {
    if (!isIndustryUiConfig(fileName)) continue;
    for (const risk of findIndustryConfigDisplayRisks(readFileSync(file, "utf8"), fileName, {
      requirePartition: strictConfigs.has(fileName),
    })) errors.push(`${fileName}:${risk.line} ${risk.rule}（${risk.path}=${risk.text.slice(0, 72)}）`);
  }

  const visitedStyles = new Set();
  const styleQueue = [...relativeFiles]
    .filter(([fileName]) => isIndustryExtensionStylesheet(fileName))
    .map(([, file]) => file);
  while (styleQueue.length > 0) {
    const file = styleQueue.shift();
    if (!file || visitedStyles.has(file)) continue;
    visitedStyles.add(file);
    const fileName = relative(repo, file).replaceAll("\\", "/");
    for (const reference of findStylesheetImports(readFileSync(file, "utf8"), fileName)) {
      if (reference.rule) {
        errors.push(`${fileName}:${reference.line} ${reference.rule}（${reference.text}）`);
        continue;
      }
      const resolved = resolveIndustryAsset(repo, file, reference.path, "stylesheet");
      if (resolved.error) errors.push(`${fileName}:${reference.line} ${resolved.error}`);
      else styleQueue.push(resolved.absolute);
    }
  }

  const visitedHtml = new Set();
  const htmlQueue = [...relativeFiles]
    .filter(([fileName]) => isIndustryExtensionSource(fileName) && /\.html?$/i.test(fileName))
    .map(([, file]) => file)
    .concat(embeddedHtmlTargets);
  while (htmlQueue.length > 0) {
    const file = htmlQueue.shift();
    if (!file || visitedHtml.has(file)) continue;
    visitedHtml.add(file);
    const fileName = relative(repo, file).replaceAll("\\", "/");
    for (const reference of findIndustryHtmlResourceReferences(readFileSync(file, "utf8"), fileName)) {
      if (reference.rule) {
        errors.push(`${fileName}:${reference.line} ${reference.rule}（${reference.text}）`);
        continue;
      }
      const resolved = reference.kind === "嵌入界面"
        ? resolveEmbeddedIndustryHtml(repo, file, reference.path)
        : resolveIndustryAsset(repo, file, reference.path, reference.kind);
      if (resolved.error) errors.push(`${fileName}:${reference.line} ${resolved.error}`);
      else if (reference.kind === "嵌入界面") htmlQueue.push(resolved.absolute);
    }
  }
  return errors;
}

export function verifyUiConsumerRepo(repoPath, { allowMissingClients = false, requireGovernanceState = false } = {}) {
  const repo = resolve(repoPath);
  const errors = requireGovernanceState ? governanceStateErrors(repo) : [];
  const statePath = join(repo, ".workloom-ui.json");
  if (!existsSync(statePath)) return [...errors, "缺少 .workloom-ui.json，无法证明行业仓消费的是已发布基座 UI"];

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [...errors, ".workloom-ui.json 不是有效 JSON"];
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(state.version ?? "")) errors.push("UI 版本必须是精确 semver，禁止 latest、范围或 workspace 引用");
  if (state.updatePolicy !== "upgrade-pr-only") errors.push("更新策略必须为 upgrade-pr-only");
  if (existsSync(join(repo, "packages/ui"))) errors.push("行业仓存在 packages/ui 公共源码副本；必须删除并消费 registry 制品");
  let rootPackage = {};
  try {
    rootPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  } catch {
    errors.push("缺少或无法读取根 package.json，不能执行行业扩展 AST 治理");
  }
  const governanceTypescript = rootPackage.devDependencies?.["typescript-governance"]
    ?? rootPackage.dependencies?.["typescript-governance"];
  if (governanceTypescript !== GOVERNANCE_TYPESCRIPT) {
    errors.push(`行业仓必须精确依赖 typescript-governance=${GOVERNANCE_TYPESCRIPT}，确保 UI AST 门禁可复现`);
  }

  const required = CLIENT_CONTRACTS.map((client) => client.packagePath);
  const exactClientList = (value) => Array.isArray(value)
    && value.length === required.length
    && required.every((path) => value.includes(path))
    && new Set(value).size === required.length;
  if (!exactClientList(state.requiredClientPackages)) {
    errors.push(`.workloom-ui.json requiredClientPackages 必须精确登记固定三端：${required.join("、")}`);
  }
  if (!exactClientList(state.connectedClientPackages)) {
    errors.push(`.workloom-ui.json connectedClientPackages 必须证明固定三端均已接入：${required.join("、")}`);
  }
  const allowedTokens = new Set(state.allowedIndustryOverrides ?? DEFAULT_ALLOWED_TOKENS);
  const allGovernedFiles = CLIENT_CONTRACTS.flatMap((client) => [
    ...walk(join(repo, client.root, "src")),
    ...walk(join(repo, client.root, "public")),
  ]).filter((file) => {
    const relativeFile = relative(repo, file).replaceAll("\\", "/");
    return isClientSurfaceSource(relativeFile) || isPcIndustryNavigationSource(relativeFile);
  });
  const trustedRelativeSurfaces = provableRelativeSurfaceImports(repo, allGovernedFiles);
  errors.push(...industryAssetDependencyRisks(repo));

  for (const client of CLIENT_CONTRACTS) {
    const packagePath = join(repo, client.packagePath);
    if (!existsSync(packagePath)) {
      if (!allowMissingClients) errors.push(`缺少生产客户端：${client.packagePath}`);
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch {
      errors.push(`${client.packagePath} 不是有效 JSON`);
      continue;
    }
    const actual = packageJson.dependencies?.[state.package];
    if (actual !== state.version) errors.push(`${client.packagePath} 必须精确依赖 ${state.package}@${state.version}，当前为 ${actual ?? "未接入"}`);

    const entryPath = join(repo, client.root, "src/main.tsx");
    if (!existsSync(entryPath)) {
      errors.push(`${client.root} 缺少生产入口 src/main.tsx`);
      continue;
    }
    const entry = readFileSync(entryPath, "utf8");
    for (const style of REQUIRED_STYLES) {
      if (!entry.includes(`@workloom/ui/${style}`)) errors.push(`${client.root}/src/main.tsx 缺少共享样式 ${style}`);
    }

    const sourceFiles = walk(join(repo, client.root, "src"))
      .filter((file) => /\.(?:tsx|jsx)$/.test(file) && !/\.test\.(?:tsx|jsx)$/.test(file));
    const source = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    if (!source.includes(`data-workloom-client="${client.marker}"`)) {
      errors.push(`${client.root} 缺少客户端身份标记 data-workloom-client="${client.marker}"`);
    }
    const imports = collectNamedImports(source);
    for (const group of client.groups) {
      const consumed = group.some((name) => {
        const alias = imports.get(name);
        return alias && isRendered(source, alias);
      });
      if (!consumed) errors.push(`${client.root} 未实际渲染共享基座组件 ${contractLabel(group)}`);
    }

    for (const file of sourceFiles) {
      const base = file.split("/").pop()?.replace(/\.(?:tsx|jsx)$/, "") ?? "";
      const fileCanonical = DUPLICATE_COMPONENTS.get(base);
      if (fileCanonical) errors.push(`${relative(repo, file)} 与共享基座组件 ${fileCanonical} 同义，疑似本地复制分叉`);
      const localSource = readFileSync(file, "utf8");
      for (const [name, canonical] of DUPLICATE_COMPONENTS) {
        if (new RegExp(`(?:export\\s+)?(?:function|class)\\s+${name}\\b|(?:export\\s+)?const\\s+${name}\\s*=`).test(localSource)) {
          errors.push(`${relative(repo, file)} 本地定义 ${name}（共享语义 ${canonical}），必须改为共享组件或使用明确的行业复合组件名`);
        }
      }
    }

    const governedFiles = [
      ...walk(join(repo, client.root, "src")),
      ...walk(join(repo, client.root, "public")),
    ].filter((file) => {
      const relativeFile = relative(repo, file).replaceAll("\\", "/");
      return isClientSurfaceSource(relativeFile) || isPcIndustryNavigationSource(relativeFile);
    });
    for (const file of governedFiles) {
      const relativeFile = relative(repo, file).replaceAll("\\", "/");
      const localSource = readFileSync(file, "utf8");
      for (const risk of [
        ...findVisibleLanguageRisks(localSource, relativeFile),
        ...findRawDynamicValueRisks(localSource, relativeFile),
        ...findClientTextSinkRisks(localSource, relativeFile),
        ...findUnmanagedSurfaceRisks(localSource, relativeFile, {
          trustedRelativeSurfaceImports: trustedRelativeSurfaces.get(relativeFile) ?? [],
        }),
        ...findPcExtensionNavigationRisks(localSource, relativeFile),
      ]) {
        errors.push(`${relativeFile}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
      }
    }

    for (const file of walk(join(repo, client.root, "public"))) {
      const relativeFile = relative(repo, file).replaceAll("\\", "/");
      if (isBundleUiConfig(relativeFile)) {
        for (const risk of findBundleDisplayLanguageRisks(readFileSync(file, "utf8"), relativeFile)) {
          errors.push(`${relativeFile}:${risk.line} ${risk.rule}（${risk.path}=${risk.text.slice(0, 60)}）`);
        }
      }
      if (isClientWebManifest(relativeFile)) {
        for (const risk of findClientWebManifestRisks(readFileSync(file, "utf8"), relativeFile)) {
          errors.push(`${relativeFile}:${risk.line} ${risk.rule}（${risk.path ?? "$"}=${risk.text.slice(0, 60)}）`);
        }
      }
      if (isClientPublicHtml(relativeFile)) {
        for (const risk of findHtmlVisibleLanguageRisks(readFileSync(file, "utf8"), relativeFile)) {
          errors.push(`${relativeFile}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
        }
      }
    }

    errors.push(...registeredServiceWorkerRisks(repo, client.root));

    const styleFiles = [
      ...walk(join(repo, client.root, "src")),
      ...walk(join(repo, client.root, "public")),
    ].filter((candidate) => /\.(?:css|scss)$/i.test(candidate));
    for (const file of styleFiles) {
      const css = readFileSync(file, "utf8");
      const relativeFile = relative(repo, file).replaceAll("\\", "/");
      for (const match of css.matchAll(/(--wl-[A-Za-z0-9-]+)\s*:/g)) {
        if (!allowedTokens.has(match[1])) errors.push(`${relativeFile} 重新定义共享令牌 ${match[1]}，行业仓只允许品牌变量`);
      }
      for (const risk of [
        ...findStylesheetLayoutRisks(css),
        ...findStylesheetGeneratedContentRisks(css),
        ...(isIndustryExtensionStylesheet(relativeFile) ? findStylesheetSurfaceRisks(css, relativeFile) : []),
      ]) {
        errors.push(`${relativeFile}:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
      }
    }

    const indexPath = join(repo, client.root, "index.html");
    if (existsSync(indexPath)) {
      for (const risk of findHtmlVisibleLanguageRisks(readFileSync(indexPath, "utf8"), `${client.root}/index.html`)) {
        errors.push(`${client.root}/index.html:${risk.line} ${risk.rule}（${risk.text.slice(0, 72)}）`);
      }
    }
  }

  for (const file of walk(join(repo, "apps"))) {
    if (!/\.(?:css|scss|tsx?|jsx?|html)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (/design-system\/(?:tokens|components)/.test(source)) errors.push(`${relative(repo, file)} 仍引用旧版设计副本`);
  }
  return [...new Set(errors)];
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const repo = resolve(value("--repo", "."));
  const errors = verifyUiConsumerRepo(repo, {
    allowMissingClients: args.includes("--allow-missing-clients"),
    requireGovernanceState: args.includes("--require-governance-state"),
  });
  if (errors.length) {
    console.error(`❌ 行业仓 UI 消费门禁失败（${errors.length} 项）`);
    for (const error of errors) console.error(`  · ${error}`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(join(repo, ".workloom-ui.json"), "utf8"));
  console.log(`✅ 三端实际消费 ${state.package}@${state.version} 的共享壳、弹层、表单与样式；未发现公共 UI 源码副本`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
