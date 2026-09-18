#!/usr/bin/env node
/**
 * WorkLoom 三端客户端基座分发器。
 *
 * 公共组件由 @workloom/ui 分发；本脚本负责同样不可分叉的三端应用壳、导航、
 * 布局、状态接线和客户端 API 契约。来源只能是 base-capabilities.json 登记的
 * ui-v* 稳定标签。目标文件通过上一稳定版逐文件 SHA-256 验真：行业仓一旦
 * 直接修改受管文件，升级立即 fail closed，不会静默覆盖。
 *
 *   scaffold --repo <行业仓根> [--path-prefix governance/] [--version x.y.z] [--dry-run]
 *   upgrade  --repo <行业仓根> [--path-prefix governance/] [--version x.y.z] [--dry-run]
 *   inspect  --repo <行业仓根> [--path-prefix governance/] [--json]
 *   verify-source [--version x.y.z] [--json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUiReleaseArtifact } from "./set-ui-version.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SYNC_DIR = dirname(SCRIPT_PATH);
const DEFAULT_BASE_DIR = resolve(SYNC_DIR, "..");
const STATE_SCHEMA = "workloom.client-foundation-state/v1";
const CLIENTS = Object.freeze({
  bPc: "apps/web",
  bMobile: "apps/webb",
  cMobile: "apps/webc",
});

function parseArgs(argv) {
  const value = (name, fallback = undefined) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    mode: argv[0],
    repo: value("--repo"),
    pathPrefix: value("--path-prefix", ""),
    baseDir: value("--base-dir", DEFAULT_BASE_DIR),
    version: value("--version"),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
  };
}

function run(command, args, cwd, encoding = "utf8") {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || `${command} 执行失败`).trim();
    throw new Error(detail.slice(0, 2000));
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeRelativePath(input, label, { allowEmpty = false } = {}) {
  const path = String(input ?? "").replace(/\/$/, "");
  if (allowEmpty && !path) return "";
  const parts = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.includes("\n")
    || path.includes("\r")
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} 必须是仓库内安全相对路径：${input ?? ""}`);
  }
  return path;
}

function assertContained(root, target, label) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} 逃逸出受控目录：${target}`);
  }
  return resolvedTarget;
}

function assertNoSymlinkPath(rootDir, target, label, { allowMissing = true } = {}) {
  const lexicalRoot = resolve(rootDir);
  const lexicalTarget = assertContained(lexicalRoot, target, label);
  const physicalRoot = realpathSync(lexicalRoot);
  let cursor = physicalRoot;
  for (const part of relative(lexicalRoot, lexicalTarget).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`${label} 不允许 symlink：${relative(physicalRoot, cursor)}`);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) break;
      throw error;
    }
  }
  return lexicalTarget;
}

function globToRegExp(glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "\u0000");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function validateFoundationConfig(manifest) {
  const config = manifest?.clientFoundation;
  if (!config || config.schemaVersion !== "workloom.client-foundation/v1") {
    throw new Error("base-capabilities.json 缺少 clientFoundation v1 契约");
  }
  if (config.distribution !== "stable-tag-upgrade-pr") {
    throw new Error("三端客户端基座必须通过 stable-tag-upgrade-pr 分发");
  }
  if (!Number.isInteger(config.maxManagedFiles) || config.maxManagedFiles < 3 || config.maxManagedFiles > 2000) {
    throw new Error("clientFoundation.maxManagedFiles 必须是 3–2000 的受控整数");
  }
  if (!Array.isArray(config.managedRoots) || config.managedRoots.length !== 3) {
    throw new Error("clientFoundation.managedRoots 必须且只能登记三个客户端");
  }
  const roots = config.managedRoots.map((path) => normalizeRelativePath(path, "managed root"));
  if (new Set(roots).size !== roots.length || Object.values(CLIENTS).some((path) => !roots.includes(path))) {
    throw new Error("clientFoundation.managedRoots 必须覆盖 B端PC、B端移动、C端移动且不得重复");
  }
  for (const entry of config.requiredEntries ?? []) normalizeRelativePath(entry, "required entry");
  for (const pattern of [...(config.allowedIndustryExtensionPaths ?? []), ...(config.ignoredRuntimePaths ?? [])]) {
    if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..") || pattern.includes("\\")) {
      throw new Error(`客户端路径规则非法：${pattern}`);
    }
  }
  for (const path of config.protectedRootFiles ?? []) normalizeRelativePath(path, "protected root file");
  if (!config.protectedRootFiles?.includes("product.manifest.json")) {
    throw new Error("product.manifest.json 必须登记为受保护身份资产");
  }
  if (!/^refs\/tags\/ui-v\{version\}$/.test(config.stableSourceRefPattern ?? "")) {
    throw new Error("稳定客户端基座来源必须固定为 refs/tags/ui-v{version}");
  }
  return config;
}

export function resolveStableFoundationVersion(manifest, requestedVersion) {
  const config = validateFoundationConfig(manifest);
  const stable = config.latestStableVersion;
  if (!/^\d+\.\d+\.\d+$/.test(stable ?? "")) {
    throw new Error("基座尚未发布稳定三端客户端基座；新行业脚手架与下游升级均已阻断");
  }
  if (requestedVersion && requestedVersion !== stable) {
    throw new Error(`三端客户端基座只能采用 latestStableVersion=${stable}；拒绝 ${requestedVersion}`);
  }
  if (manifest.releasePolicy !== "base-first-stable-only") {
    throw new Error("releasePolicy 必须为 base-first-stable-only");
  }
  if (manifest.ui?.latestStableVersion !== stable) {
    throw new Error(`三端客户端基座 ${stable} 与共享 UI 稳定版 ${manifest.ui?.latestStableVersion ?? "未登记"} 不一致`);
  }
  resolveUiReleaseArtifact(manifest, stable);
  return stable;
}

function readGitJson(baseDir, ref, path) {
  return JSON.parse(run("git", ["show", `${ref}:${path}`], baseDir));
}

/** 从不可变稳定标签读取三端源，不读取当前工作树。 */
/**
 * 仓级"实验扩展路径"（实验车道）：与全局 allowedIndustryExtensionPaths 合并后生效。
 * 用途：fox / growth 等实验仓在 apps/* 内的深度定制（游戏化等）不属于基座能力，
 * 升级三端基座时不得被判为 ILLEGAL_INDUSTRY_APP_PATH，也不得被覆盖。
 */
export function normalizeExtraExtensionPaths(paths = []) {
  const list = Array.isArray(paths) ? paths : [];
  for (const pattern of list) {
    if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..")) {
      throw new Error(`非法实验扩展路径：${pattern}`);
    }
  }
  return list;
}

export function effectiveExtensionPaths(config, extra = []) {
  return [...(config.allowedIndustryExtensionPaths ?? []), ...normalizeExtraExtensionPaths(extra)];
}

export function loadStableFoundationSnapshot(baseDir, manifest, requestedVersion, options = {}) {
  const root = realpathSync(resolve(baseDir));
  const config = validateFoundationConfig(manifest);
  const version = resolveStableFoundationVersion(manifest, requestedVersion);
  const sourceRef = config.stableSourceRefPattern.replace("{version}", version);
  const sourceCommit = run("git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], root).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`无法解析稳定来源 ${sourceRef}`);

  const taggedManifest = readGitJson(root, sourceRef, "sync/base-capabilities.json");
  const taggedConfig = validateFoundationConfig(taggedManifest);
  if (
    taggedConfig.latestStableVersion !== version
    || taggedManifest.ui?.latestStableVersion !== version
    || taggedManifest.releasePolicy !== "base-first-stable-only"
  ) {
    throw new Error(`${sourceRef} 内未自证为 ${version} 稳定基座`);
  }
  const taggedUiPackage = readGitJson(root, sourceRef, "packages/ui/package.json");
  if (taggedUiPackage.version !== version) {
    throw new Error(`${sourceRef} 的 @workloom/ui 版本 ${taggedUiPackage.version ?? "未登记"} 与稳定版 ${version} 不一致`);
  }
  const configuredArtifact = resolveUiReleaseArtifact(manifest, version);
  const taggedArtifact = resolveUiReleaseArtifact(taggedManifest, version);
  if (
    configuredArtifact.url !== taggedArtifact.url
    || configuredArtifact.assetName !== taggedArtifact.assetName
    || configuredArtifact.sha512 !== taggedArtifact.sha512
  ) {
    throw new Error(`${sourceRef} 的 GitHub Release 制品契约与当前稳定清单不一致`);
  }

  const tree = run("git", ["ls-tree", "-rz", sourceRef, "--", ...config.managedRoots], root, null);
  const records = tree.toString("utf8").split("\0").filter(Boolean);
  const files = new Map();
  for (const record of records) {
    const match = /^(\d+)\s+blob\s+[0-9a-f]+\t(.+)$/.exec(record);
    if (!match) throw new Error(`稳定来源包含不支持的 tree 记录：${record.slice(0, 160)}`);
    const [, mode, rawPath] = match;
    const path = normalizeRelativePath(rawPath, "stable source path");
    if (mode === "120000") throw new Error(`稳定客户端基座禁止 symlink：${path}`);
    if (matchesAny(path, config.ignoredRuntimePaths ?? [])) continue;
    // 基座仓自身可为默认示例 Bundle 保留行业投影，但稳定客户端快照必须过滤
    // 这些文件，确保下游只保留/生成自己的行业资产而不会继承基座示例品牌。
    if (matchesAny(path, effectiveExtensionPaths(config, options?.extraAllowedIndustryExtensionPaths))) continue;
    if ((config.protectedRootFiles ?? []).includes(path)) throw new Error(`稳定基座包含受保护身份资产：${path}`);
    const content = run("git", ["show", `${sourceRef}:${path}`], root, null);
    files.set(path, { content, mode: mode === "100755" ? 0o755 : 0o644 });
  }
  for (const entry of config.requiredEntries) {
    if (!files.has(entry)) throw new Error(`稳定客户端基座缺少真实生产入口：${entry}`);
  }
  if (files.size > config.maxManagedFiles) {
    throw new Error(`稳定客户端基座文件数 ${files.size} 超过上限 ${config.maxManagedFiles}`);
  }
  return materializeUiVersion({ version, sourceRef, sourceCommit, uiArtifact: taggedArtifact, files }, manifest);
}

/** 将基座工作区依赖 materialize 为下游可安装的精确稳定 UI 版本。 */
export function materializeUiVersion(snapshot, manifest) {
  const uiArtifact = resolveUiReleaseArtifact(manifest, snapshot.version);
  if (snapshot.uiArtifact && (
    snapshot.uiArtifact.url !== uiArtifact.url
    || snapshot.uiArtifact.assetName !== uiArtifact.assetName
    || snapshot.uiArtifact.sha512 !== uiArtifact.sha512
  )) {
    throw new Error("客户端基座快照的 GitHub Release 制品契约与稳定清单不一致");
  }
  const files = new Map(snapshot.files);
  for (const packagePath of manifest.ui.requiredClientPackages) {
    const file = files.get(packagePath);
    if (!file) throw new Error(`客户端基座缺少 package.json：${packagePath}`);
    const packageJson = JSON.parse(file.content.toString("utf8"));
    packageJson.dependencies ??= {};
    packageJson.dependencies[manifest.ui.package] = snapshot.version;
    files.set(packagePath, {
      ...file,
      content: Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`),
    });
  }
  return { ...snapshot, uiArtifact, files };
}

function validateProductIdentity(repoRoot) {
  const productPath = assertNoSymlinkPath(repoRoot, join(repoRoot, "product.manifest.json"), "产品身份", { allowMissing: false });
  let product;
  try {
    product = JSON.parse(readFileSync(productPath, "utf8"));
  } catch (error) {
    throw new Error(`product.manifest.json 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (
    product?.role === "base"
    || typeof product?.role !== "string"
    || !product.role
    || typeof product.productId !== "string"
    || !product.productId.trim()
    || typeof product.repository !== "string"
    || !product.repository.trim()
    || typeof product.demoWorkspaceSlug !== "string"
    || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(product.demoWorkspaceSlug)
    || typeof product.demoMemberNo !== "string"
    || !/^[A-Z][A-Z0-9-]{1,31}$/.test(product.demoMemberNo)
    || typeof product.release?.appId !== "string"
    || !product.release.appId.trim()
    || product.release.appId === "com.workloom.im"
    || !Number.isInteger(product.desktop?.portOffset)
    || product.desktop.portOffset <= 0
  ) {
    throw new Error("新行业必须先提供独立且非基座的 product.manifest.json 身份、appId 与正整数端口偏移");
  }
  for (const [key, entry] of Object.entries(CLIENTS)) {
    if (product.clients?.[key]?.enabled !== true || product.clients[key].entry !== entry) {
      throw new Error(`product.manifest.json 必须启用 ${key} 并登记入口 ${entry}`);
    }
  }
  return { path: productPath, hash: sha256(readFileSync(productPath)), product };
}

function readFoundationState(targetRoot, config, { required = false, extraAllowedIndustryExtensionPaths = [] } = {}) {
  const stateFile = config.stateFile;
  const statePath = assertNoSymlinkPath(targetRoot, join(targetRoot, stateFile), "客户端基座 state");
  if (!existsSync(statePath)) {
    if (required) throw new Error(`缺少 ${stateFile}；存量仓须先完成受管文件迁移`);
    return null;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`${stateFile} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (state.schemaVersion !== STATE_SCHEMA || !/^\d+\.\d+\.\d+$/.test(state.version ?? "") || typeof state.managedFiles !== "object") {
    throw new Error(`${stateFile} 契约无效；拒绝猜测旧基座指纹`);
  }
  if (Object.keys(state.managedFiles).length > config.maxManagedFiles) {
    throw new Error(`${stateFile} 受管文件数超过上限 ${config.maxManagedFiles}`);
  }
  if (state.sourceRef !== `refs/tags/ui-v${state.version}` || !/^[0-9a-f]{40}$/.test(state.sourceCommit ?? "")) {
    throw new Error(`${stateFile} 未登记同版稳定标签与不可变来源提交`);
  }
  if (JSON.stringify(state.clients) !== JSON.stringify(CLIENTS)) {
    throw new Error(`${stateFile} 未完整登记 PC/B移动/C移动三端映射`);
  }
  if (JSON.stringify(state.allowedIndustryExtensionPaths) !== JSON.stringify(config.allowedIndustryExtensionPaths)) {
    throw new Error(`${stateFile} 的行业扩展白名单被修改`);
  }
  for (const [path, entry] of Object.entries(state.managedFiles)) {
    normalizeRelativePath(path, "state managed path");
    if (!config.managedRoots.some((root) => path.startsWith(`${root}/`))) {
      throw new Error(`${stateFile} 的受管文件逃逸出三端根：${path}`);
    }
    if (matchesAny(path, effectiveExtensionPaths(config, extraAllowedIndustryExtensionPaths))) {
      throw new Error(`${stateFile} 不得把行业扩展登记成基座受管文件：${path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "") || ![420, 493].includes(entry?.mode)) {
      throw new Error(`${stateFile} 的文件指纹无效：${path}`);
    }
  }
  return state;
}

function walkFiles(root, relativeRoot = "", ignoredPatterns = []) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  const result = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`目标客户端目录禁止 symlink：${path}`);
    if (entry.isDirectory()) {
      if (matchesAny(`${path}/__workloom_probe__`, ignoredPatterns)) continue;
      result.push(...walkFiles(root, path, ignoredPatterns));
    }
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function fileMode(path) {
  return (lstatSync(path).mode & 0o111) ? 0o755 : 0o644;
}

function makeState(snapshot, manifest) {
  const config = validateFoundationConfig(manifest);
  return {
    schemaVersion: STATE_SCHEMA,
    baseRepository: manifest.baseRepository,
    version: snapshot.version,
    sourceRef: snapshot.sourceRef,
    sourceCommit: snapshot.sourceCommit,
    updatePolicy: "upgrade-pr-only",
    clients: CLIENTS,
    allowedIndustryExtensionPaths: config.allowedIndustryExtensionPaths,
    managedFiles: Object.fromEntries([...snapshot.files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [
      path,
      { sha256: sha256(file.content), mode: file.mode },
    ])),
  };
}

function validateSnapshot(snapshot, manifest, extraAllowedIndustryExtensionPaths = []) {
  const config = validateFoundationConfig(manifest);
  if (!/^\d+\.\d+\.\d+$/.test(snapshot?.version ?? "")) throw new Error("客户端基座快照版本必须是精确稳定 semver");
  resolveStableFoundationVersion(manifest, snapshot.version);
  const expectedArtifact = resolveUiReleaseArtifact(manifest, snapshot.version);
  if (
    snapshot?.uiArtifact?.type !== expectedArtifact.type
    || snapshot.uiArtifact.assetName !== expectedArtifact.assetName
    || snapshot.uiArtifact.url !== expectedArtifact.url
    || snapshot.uiArtifact.sha512 !== expectedArtifact.sha512
  ) {
    throw new Error("客户端基座快照缺少同版 GitHub Release URL 与 SHA-512 证明");
  }
  if (!/^refs\/tags\/ui-v\d+\.\d+\.\d+$/.test(snapshot?.sourceRef ?? "")) throw new Error("客户端基座快照必须来自 ui-v* 稳定标签");
  if (!/^[0-9a-f]{40}$/.test(snapshot?.sourceCommit ?? "")) throw new Error("客户端基座快照缺少不可变来源提交");
  if (!(snapshot.files instanceof Map)) throw new Error("客户端基座快照缺少文件映射");
  if (snapshot.files.size > config.maxManagedFiles) throw new Error(`客户端基座快照文件数超过上限 ${config.maxManagedFiles}`);
  for (const [rawPath, file] of snapshot.files) {
    const path = normalizeRelativePath(rawPath, "snapshot path");
    if (!config.managedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`客户端基座快照逃逸出三端受管根：${path}`);
    }
    if ((config.protectedRootFiles ?? []).includes(path)) throw new Error(`客户端基座快照不得包含受保护身份资产：${path}`);
    if (matchesAny(path, effectiveExtensionPaths(config, extraAllowedIndustryExtensionPaths))) throw new Error(`客户端基座快照不得占用行业扩展路径：${path}`);
    if (!Buffer.isBuffer(file?.content) || ![0o644, 0o755].includes(file?.mode)) throw new Error(`客户端基座快照文件无效：${path}`);
  }
  for (const entry of config.requiredEntries) {
    if (!snapshot.files.has(entry)) throw new Error(`客户端基座缺少真实生产入口：${entry}`);
  }
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function resolvePhysicalTarget(root, targetRoot) {
  const physical = realpathSync(resolve(targetRoot));
  assertContained(root, physical, "行业基座目录");
  assertNoSymlinkPath(root, physical, "行业基座目录", { allowMissing: false });
  return physical;
}

/**
 * 生成完整升级计划。先收集全部冲突，只有零冲突时 apply 才会写入，因此不会
 * 出现“覆盖一半才发现行业定制”的不完整迁移。
 */
export function planClientFoundation({ repoRoot, targetRoot = repoRoot, manifest, snapshot, mode = "upgrade", extraAllowedIndustryExtensionPaths = [] }) {
  if (!['scaffold', 'upgrade'].includes(mode)) throw new Error(`未知客户端基座模式：${mode}`);
  const config = validateFoundationConfig(manifest);
  validateSnapshot(snapshot, manifest, extraAllowedIndustryExtensionPaths);
  const root = realpathSync(resolve(repoRoot));
  const target = resolvePhysicalTarget(root, targetRoot);
  if (!lstatSync(target).isDirectory()) throw new Error("行业基座目录必须存在");
  const identity = validateProductIdentity(root);
  const state = readFoundationState(target, config, { extraAllowedIndustryExtensionPaths });
  if (state && state.baseRepository !== manifest.baseRepository) {
    throw new Error(`客户端基座来源不一致：${state.baseRepository ?? "未登记"}`);
  }
  if (state && state.updatePolicy !== "upgrade-pr-only") {
    throw new Error("客户端基座 updatePolicy 必须为 upgrade-pr-only");
  }
  if (state && compareSemver(snapshot.version, state.version) < 0) {
    throw new Error(`拒绝把三端客户端基座从 ${state.version} 降级到 ${snapshot.version}`);
  }
  if (state && state.version === snapshot.version && state.sourceCommit !== snapshot.sourceCommit) {
    throw new Error(`稳定标签 ${snapshot.sourceRef} 的来源提交发生变化；拒绝接受同版本异内容`);
  }
  const previous = state?.managedFiles ?? {};
  const next = makeState(snapshot, manifest);
  const operations = [];
  const conflicts = [];

  for (const path of new Set([...Object.keys(previous), ...snapshot.files.keys()])) {
    const destination = assertNoSymlinkPath(target, join(target, path), `受管文件 ${path}`);
    const beforeExists = existsSync(destination);
    const beforeHash = beforeExists ? sha256(readFileSync(destination)) : null;
    const beforeMode = beforeExists ? fileMode(destination) : null;
    const oldEntry = previous[path];
    const newFile = snapshot.files.get(path);

    if (oldEntry && beforeExists && beforeHash !== oldEntry.sha256) {
      if (!newFile || beforeHash !== sha256(newFile.content)) {
        conflicts.push({
          code: "MANAGED_FILE_MODIFIED",
          path,
          message: "行业仓已直接修改受管客户端文件；请先把差异迁入 Bundle/theme/projection/config/extension 路径",
          expectedPreviousSha256: oldEntry.sha256,
          actualSha256: beforeHash,
        });
        continue;
      }
    }
    if (!oldEntry && beforeExists && newFile && beforeHash !== sha256(newFile.content)) {
      conflicts.push({
        code: "UNTRACKED_MANAGED_FILE",
        path,
        message: "既有客户端文件没有可信旧基座指纹且内容不同；拒绝把它猜作可覆盖文件",
        actualSha256: beforeHash,
      });
      continue;
    }
    if (oldEntry && !beforeExists && newFile) {
      conflicts.push({
        code: "MANAGED_FILE_DELETED",
        path,
        message: "行业仓删除了旧基座受管文件；请先恢复旧版或完成显式迁移",
        expectedPreviousSha256: oldEntry.sha256,
      });
      continue;
    }

    if (!newFile) {
      if (beforeExists) operations.push({ action: "delete", path, beforeHash, beforeMode });
      continue;
    }
    const nextHash = sha256(newFile.content);
    if (!beforeExists) operations.push({ action: "create", path, nextHash, nextMode: newFile.mode });
    else if (beforeHash !== nextHash || beforeMode !== newFile.mode) {
      operations.push({ action: "update", path, beforeHash, nextHash, beforeMode, nextMode: newFile.mode });
    }
  }

  const known = new Set([...Object.keys(previous), ...snapshot.files.keys()]);
  for (const managedRoot of config.managedRoots) {
    for (const diskPath of walkFiles(target, managedRoot, config.ignoredRuntimePaths ?? [])) {
      if (known.has(diskPath)) continue;
      if (matchesAny(diskPath, effectiveExtensionPaths(config, extraAllowedIndustryExtensionPaths))) continue;
      if (matchesAny(diskPath, config.ignoredRuntimePaths ?? [])) continue;
      conflicts.push({
        code: "ILLEGAL_INDUSTRY_APP_PATH",
        path: diskPath,
        message: "客户端根内的行业差异只能位于 Bundle/theme/projection/config/extension 白名单路径",
      });
    }
  }

  const stateContent = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const statePath = join(target, config.stateFile);
  const currentStateHash = existsSync(statePath) ? sha256(readFileSync(statePath)) : null;
  const nextStateHash = sha256(stateContent);
  if (currentStateHash !== nextStateHash) {
    operations.push({ action: currentStateHash ? "update-state" : "create-state", path: config.stateFile, nextHash: nextStateHash });
  }
  return {
    schemaVersion: "workloom.client-foundation-plan/v1",
    mode,
    version: snapshot.version,
    sourceRef: snapshot.sourceRef,
    sourceCommit: snapshot.sourceCommit,
    productId: identity.product.productId,
    identitySha256: identity.hash,
    targetRoot: relative(root, target) || ".",
    state,
    nextState: next,
    stateContent,
    operations,
    conflicts,
    ready: conflicts.length === 0,
  };
}

function restoreFile(path, backup) {
  if (!backup.exists) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, backup.content);
  chmodSync(path, backup.mode);
}

export function applyClientFoundation({ repoRoot, targetRoot = repoRoot, manifest, snapshot, mode = "upgrade", dryRun = false, extraAllowedIndustryExtensionPaths = [] }) {
  const root = realpathSync(resolve(repoRoot));
  const target = resolvePhysicalTarget(root, targetRoot);
  const plan = planClientFoundation({ repoRoot: root, targetRoot: target, manifest, snapshot, mode, extraAllowedIndustryExtensionPaths });
  if (!plan.ready) {
    const summary = plan.conflicts.slice(0, 8).map((item) => `${item.code}:${item.path}`).join("、");
    const error = new Error(`客户端基座存在 ${plan.conflicts.length} 个冲突，拒绝覆盖：${summary}`);
    error.plan = plan;
    throw error;
  }
  if (dryRun) return { ...plan, dryRun: true, applied: false };

  const config = validateFoundationConfig(manifest);
  const identityBefore = sha256(readFileSync(join(root, "product.manifest.json")));
  const backups = new Map();
  try {
    for (const operation of plan.operations) {
      const path = assertNoSymlinkPath(target, join(target, operation.path), `写入 ${operation.path}`);
      backups.set(path, existsSync(path)
        ? { exists: true, content: readFileSync(path), mode: lstatSync(path).mode & 0o777 }
        : { exists: false });
      if (operation.action === "delete") {
        rmSync(path);
      } else if (operation.path === config.stateFile) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, plan.stateContent);
        chmodSync(path, 0o644);
      } else {
        const source = snapshot.files.get(operation.path);
        mkdirSync(dirname(path), { recursive: true });
        assertNoSymlinkPath(target, path, `写入 ${operation.path}`);
        writeFileSync(path, source.content);
        chmodSync(path, source.mode);
      }
    }
    const identityAfter = sha256(readFileSync(join(root, "product.manifest.json")));
    if (identityAfter !== identityBefore || identityAfter !== plan.identitySha256) {
      throw new Error("product.manifest.json 身份在客户端基座应用期间发生变化；已回滚");
    }
    const verification = planClientFoundation({ repoRoot: root, targetRoot: target, manifest, snapshot, mode, extraAllowedIndustryExtensionPaths });
    if (!verification.ready || verification.operations.length !== 0) {
      throw new Error("客户端基座落盘后验真失败；已回滚");
    }
    return { ...verification, dryRun: false, applied: true, filesTouched: plan.operations.map((item) => item.path) };
  } catch (error) {
    for (const [path, backup] of [...backups.entries()].reverse()) restoreFile(path, backup);
    throw error;
  }
}

/** 不需要目标稳定源即可验证现有 state 是否仍可信，供发布前盘点使用。 */
export function inspectClientFoundationState({ repoRoot, targetRoot = repoRoot, manifest, extraAllowedIndustryExtensionPaths = [] }) {
  const config = validateFoundationConfig(manifest);
  const root = realpathSync(resolve(repoRoot));
  const target = resolvePhysicalTarget(root, targetRoot);
  const issues = [];
  let identity;
  try {
    identity = validateProductIdentity(root);
  } catch (error) {
    issues.push({ code: "INVALID_PRODUCT_IDENTITY", path: "product.manifest.json", message: String(error.message) });
  }
  let state;
  try {
    state = readFoundationState(target, config, { extraAllowedIndustryExtensionPaths });
  } catch (error) {
    issues.push({ code: "INVALID_CLIENT_FOUNDATION_STATE", path: config.stateFile, message: String(error.message) });
  }
  if (!state) {
    issues.push({ code: "MISSING_CLIENT_FOUNDATION_STATE", path: config.stateFile, message: "缺少三端客户端基座指纹清单" });
    return { identity, state: null, issues };
  }
  if (config.latestStableVersion && state.version !== config.latestStableVersion) {
    issues.push({
      code: "CLIENT_FOUNDATION_VERSION_DRIFT",
      path: config.stateFile,
      message: `三端客户端基座当前为 ${state.version}，目标稳定版为 ${config.latestStableVersion}`,
    });
  }
  for (const [path, entry] of Object.entries(state.managedFiles)) {
    const destination = assertNoSymlinkPath(target, join(target, path), `检查 ${path}`);
    if (!existsSync(destination)) {
      issues.push({ code: "MANAGED_FILE_MISSING", path, message: "受管客户端文件缺失" });
    } else if (sha256(readFileSync(destination)) !== entry.sha256 || fileMode(destination) !== entry.mode) {
      issues.push({ code: "MANAGED_FILE_MODIFIED", path, message: "受管客户端文件已偏离登记基座指纹" });
    }
  }
  const known = new Set(Object.keys(state.managedFiles));
  for (const managedRoot of config.managedRoots) {
    for (const diskPath of walkFiles(target, managedRoot, config.ignoredRuntimePaths ?? [])) {
      if (known.has(diskPath)) continue;
      if (matchesAny(diskPath, effectiveExtensionPaths(config, extraAllowedIndustryExtensionPaths))) continue;
      if (matchesAny(diskPath, config.ignoredRuntimePaths ?? [])) continue;
      issues.push({
        code: "ILLEGAL_INDUSTRY_APP_PATH",
        path: diskPath,
        message: "客户端根内存在未登记且不在行业扩展白名单的文件",
      });
    }
  }
  return { identity, state, issues };
}

function resolveTarget(repo, prefix) {
  if (!repo) throw new Error("缺少 --repo <行业仓根目录>");
  const lexicalRoot = resolve(repo);
  const repoRoot = realpathSync(resolve(run("git", ["rev-parse", "--show-toplevel"], lexicalRoot).trim()));
  if (realpathSync(lexicalRoot) !== repoRoot) throw new Error("--repo 必须指向行业仓 Git 根目录");
  const normalizedPrefix = normalizeRelativePath(prefix, "--path-prefix", { allowEmpty: true });
  const targetRoot = normalizedPrefix ? join(repoRoot, normalizedPrefix) : repoRoot;
  assertNoSymlinkPath(repoRoot, targetRoot, "--path-prefix", { allowMissing: false });
  return { repoRoot, targetRoot, prefix: normalizedPrefix };
}

function outputReport(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const verb = report.dryRun ? "计划" : report.applied ? "已应用" : "已验证";
    process.stdout.write(`✅ 三端客户端基座 ${report.version ?? report.state?.version ?? "未登记"}${verb}：${report.operations?.length ?? 0} 项变更\n`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!['scaffold', 'upgrade', 'inspect', 'verify-source'].includes(options.mode)) {
    throw new Error("用法：client-foundation.mjs <scaffold|upgrade|inspect|verify-source> [--repo <行业仓根>] [--path-prefix ...] [--version x.y.z] [--dry-run] [--json]");
  }
  const manifest = JSON.parse(readFileSync(join(SYNC_DIR, "base-capabilities.json"), "utf8"));
  if (options.mode === "verify-source") {
    const snapshot = loadStableFoundationSnapshot(options.baseDir, manifest, options.version);
    const report = {
      schemaVersion: "workloom.client-foundation-source/v1",
      version: snapshot.version,
      sourceRef: snapshot.sourceRef,
      sourceCommit: snapshot.sourceCommit,
      uiArtifact: snapshot.uiArtifact,
      managedFileCount: snapshot.files.size,
      clients: CLIENTS,
      verified: true,
    };
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`✅ 稳定三端客户端基座 ${snapshot.version} 已验真：${snapshot.files.size} 个受管文件 · ${snapshot.sourceCommit.slice(0, 12)}\n`);
    return;
  }
  const { repoRoot, targetRoot } = resolveTarget(options.repo, options.pathPrefix);
  if (options.mode === "inspect") {
    const report = inspectClientFoundationState({ repoRoot, targetRoot, manifest });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(report.issues.length ? `❌ 三端客户端基座存在 ${report.issues.length} 项漂移\n` : "✅ 三端客户端基座指纹完整\n");
    if (report.issues.length) process.exitCode = 2;
    return;
  }
  const snapshot = loadStableFoundationSnapshot(options.baseDir, manifest, options.version);
  const report = applyClientFoundation({
    repoRoot,
    targetRoot,
    manifest,
    snapshot,
    mode: options.mode,
    dryRun: options.dryRun,
  });
  outputReport(report, options.json);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    if (error?.plan) process.stderr.write(`${JSON.stringify(error.plan, null, 2)}\n`);
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
