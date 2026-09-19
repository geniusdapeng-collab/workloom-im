#!/usr/bin/env node
/**
 * WorkLoom 共享 UI + 三端客户端基座的下游发布门禁与升级 PR 编排。
 *
 * 发布严格分成两个阶段：
 * 1. --preflight：只读克隆全部八个下游仓，确认清单与访问能力，同时把迁移缺口
 *    结构化输出。存量仓未迁移不反向锁死基座稳定制品，只有清单/访问失败才阻断发布。
 * 2. --rollout：确认 canonical GitHub Release 中已存在目标稳定制品，并从同一 ui-v* 不可变标签
 *    读取三端应用壳，再按 child-repos.json 的波次处理。受管文件经旧版 SHA-256
 *    验真；行业修改冲突会 fail closed。只创建独立 PR，不直推 main。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUiConsumerRepo } from "../scripts/verify-ui-consumer.mjs";
import { ADOPTION_SCRIPTS, ADOPTION_WORKFLOW } from "./install-adoption-assets.mjs";
import { GOVERNANCE_FILES, GOVERNANCE_STATE, installUiGovernance } from "./install-ui-governance.mjs";
import {
  applyClientFoundation,
  inspectClientFoundationState,
  loadStableFoundationSnapshot,
  resolveStableFoundationVersion,
} from "./client-foundation.mjs";
import { resolveUiReleaseArtifact, resolveUiVersion, setUiVersion } from "./set-ui-version.mjs";
import { bindUiLockfileIntegrity } from "./ui-lockfile-integrity.mjs";

const syncDir = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(syncDir, "..");
// 舰队规模：八行业仓 + WorkLoom-growth；增删舰队成员时同步更新（配合 sync/child-repos.json）
const EXPECTED_DOWNSTREAM_COUNT = 9;
const CANONICAL_BASE_REPOSITORY = "workloom-ai/workloom-im";
const RELEASE_PAYLOAD_SCHEMA = "workloom.ui-release-payload/v1";
const RELEASE_GOVERNANCE_PAYLOAD_PATHS = Object.freeze([
  ...GOVERNANCE_FILES,
  ...ADOPTION_SCRIPTS,
  "sync/ui-consumer-template.yml",
  "sync/base-capabilities.json",
  "sync/child-repos.json",
  // 这些控制器会决定从标签读取什么、写入哪些下游文件以及如何验真，属于 rollout
  // TCB；仅封存最终 payload 而不封存控制器本身，脏工作树仍可绕过全部门禁。
  "sync/ui-upgrade-pr.mjs",
  "sync/client-foundation.mjs",
  "sync/set-ui-version.mjs",
  "sync/install-ui-governance.mjs",
  "sync/install-adoption-assets.mjs",
  "sync/ui-lockfile-integrity.mjs",
]);
const PRODUCT_CLIENTS = Object.freeze({
  bPc: "apps/web",
  bMobile: "apps/webb",
  cMobile: "apps/webc",
});

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const legacyValidate = argv.includes("--validate-only");
  const verifyArtifact = argv.includes("--verify-artifact");
  if (verifyArtifact && argv.includes("--rollout")) {
    throw new Error("--verify-artifact 与 --rollout 不得同时使用");
  }
  const repositories = (value("--repos") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    mode: verifyArtifact ? "verify-artifact" : argv.includes("--rollout") ? "rollout" : "preflight",
    requestedVersion: value("--version"),
    reportPath: value("--report"),
    wave: value("--wave")?.trim() || undefined,
    repositories,
    dryRun: argv.includes("--dry-run") || legacyValidate,
  };
}

export function sanitizedSubprocessEnvironment(ambient = process.env, explicit = {}) {
  const subprocessEnvironment = { ...ambient };
  // 跨仓写 token 只留在升级编排器内存中。pnpm/npm/verifier 与普通 git 子进程
  // 不得继承它；只有显式传入 canonicalGitEnvironment(token) 的 canonical 网络操作
  // 才获得一次性 extraheader，PR API 则直接使用内存中的 token。
  for (const key of Object.keys(subprocessEnvironment)) {
    if (
      /^(?:SYNC_TOKEN|CNB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AUTHORIZATION|HTTP_AUTHORIZATION)$/iu.test(key)
      || /^NPM_CONFIG_/iu.test(key)
      || /^GIT_CONFIG(?:_|$)/iu.test(key)
      || /^(?:GIT|SSH)_ASKPASS$/iu.test(key)
      || /^GIT_HTTP_/iu.test(key)
    ) delete subprocessEnvironment[key];
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (/^(?:SYNC_TOKEN|CNB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AUTHORIZATION|HTTP_AUTHORIZATION)$/iu.test(key)
      || /^NPM_CONFIG_/iu.test(key)) continue;
    subprocessEnvironment[key] = value;
  }
  return subprocessEnvironment;
}

function run(command, commandArgs, cwd, env = {}) {
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: sanitizedSubprocessEnvironment(process.env, env),
  }).trim();
}

function normalizeRepositoryPath(path, label = "升级路径") {
  const value = String(path ?? "");
  if (
    !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} 必须是 Git 仓内安全相对路径：${JSON.stringify(value)}`);
  }
  return value;
}

function parseNulPaths(value, label) {
  return String(value ?? "")
    .split("\0")
    .filter(Boolean)
    .map((path) => normalizeRepositoryPath(path, label));
}

function sortedUniquePaths(paths, label) {
  return [...new Set(paths.map((path) => normalizeRepositoryPath(path, label)))].sort((left, right) => left.localeCompare(right));
}

function listWorkingTreeChanges(repoRoot, declaredPaths = []) {
  const tracked = parseNulPaths(
    run("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], repoRoot),
    "工作树变更路径",
  );
  const untracked = parseNulPaths(
    run("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], repoRoot),
    "未跟踪变更路径",
  );
  // 新 clone 不携带 ignored 文件。若安装器创建了一个被目标仓 ignore 的声明资产，
  // 也必须把它识别为实际变化并让后续显式 git add fail closed，不能误报 already-current。
  const declaredUntracked = declaredPaths.length
    ? parseNulPaths(
      run("git", ["--literal-pathspecs", "ls-files", "--others", "-z", "--", ...declaredPaths], repoRoot),
      "声明资产的未跟踪路径",
    )
    : [];
  return sortedUniquePaths([...tracked, ...untracked, ...declaredUntracked], "工作树变更路径");
}

export function assertExactUpgradePathSet({ allowedPaths, changedPaths, stagedPaths = changedPaths }) {
  const allowed = new Set(sortedUniquePaths(allowedPaths, "升级白名单路径"));
  const changed = sortedUniquePaths(changedPaths, "实际变更路径");
  const staged = sortedUniquePaths(stagedPaths, "已暂存路径");
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length) {
    throw new Error(`升级产生未声明变更，拒绝暂存：${unexpected.join("、")}`);
  }
  const changedSet = new Set(changed);
  const omitted = changed.filter((path) => !staged.includes(path));
  const extra = staged.filter((path) => !changedSet.has(path));
  if (omitted.length || extra.length) {
    throw new Error([
      "升级暂存路径与实际变更不一致",
      omitted.length ? `遗漏：${omitted.join("、")}` : "",
      extra.length ? `额外：${extra.join("、")}` : "",
    ].filter(Boolean).join("；"));
  }
  return changed;
}

/**
 * rollout 只暂存本轮安装器明确声明且确实发生变化的文件。先把工作树实际路径与
 * 白名单比对，再逐路径 git add，最后从 index 反查并要求与原实际集合完全相等；
 * pnpm/verifier 生成任何额外资产或发生遗漏时均 fail closed。
 */
export function stageExactUpgradeChanges({ repoRoot, allowedPaths }) {
  const allowed = sortedUniquePaths(allowedPaths, "升级白名单路径");
  const changed = listWorkingTreeChanges(repoRoot, allowed);
  assertExactUpgradePathSet({ allowedPaths: allowed, changedPaths: changed });
  if (!changed.length) return [];
  run("git", ["--literal-pathspecs", "add", "--", ...changed], repoRoot);
  const staged = parseNulPaths(
    run("git", ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"], repoRoot),
    "已暂存路径",
  );
  assertExactUpgradePathSet({ allowedPaths: allowed, changedPaths: changed, stagedPaths: staged });
  const unstaged = sortedUniquePaths([
    ...parseNulPaths(run("git", ["diff", "--name-only", "--no-renames", "-z", "--"], repoRoot), "未暂存路径"),
    ...parseNulPaths(run("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], repoRoot), "未跟踪路径"),
  ], "未暂存路径");
  if (unstaged.length) {
    throw new Error(`逐路径暂存后仍有未暂存变更，拒绝提交：${unstaged.join("、")}`);
  }
  return changed;
}

function canonicalGitEnvironment(token) {
  const environment = { GIT_TERMINAL_PROMPT: "0" };
  if (!token) return environment;
  // 凭据只经子进程环境传递，绝不写入 remote URL、日志或仓库配置。
  return {
    ...environment,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://cnb.cool/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`cnb:${token}`).toString("base64")}`,
  };
}

function repositoryUrl(repo) {
  return `https://cnb.cool/${repo}.git`;
}

const READ_ONLY_CLONE_ATTEMPTS = 3;
const READ_ONLY_CLONE_BACKOFF_MS = 100;

function waitSynchronously(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function redactCloneDiagnostic(value, token = "") {
  let text = String(value ?? "");
  const encodedToken = token ? encodeURIComponent(token) : "";
  const basicToken = token ? Buffer.from(`x-access-token:${token}`).toString("base64") : "";
  for (const secret of [token, encodedToken, basicToken].filter(Boolean)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(authorization:\s*(?:basic|bearer)\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function classifyCloneFailure(value) {
  const diagnostic = String(value ?? "").toLowerCase();
  if (/authentication failed|could not read username|permission denied|invalid credentials|access denied/u.test(diagnostic)) {
    return "authentication";
  }
  if (/repository not found|does not appear to be a git repository|not found/u.test(diagnostic)) {
    return "repository-unavailable";
  }
  if (/too many requests|rate.?limit|http[^\n]*429/u.test(diagnostic)) return "rate-limited";
  if (/rpc failed|http\/2|http\/1\.1|stream .*closed|early eof|tls|connection (?:reset|closed|timed out|refused)|operation timed out|could not resolve host|network is unreachable|remote end hung up|failed to connect/u.test(diagnostic)) {
    return "network-transient";
  }
  return "unknown";
}

function cloneFailureMetadata(error, token = "") {
  if (error?.code === "WORKLOOM_READ_ONLY_CLONE_FAILED") {
    return {
      classification: error.classification,
      attempts: error.attempts,
      diagnostic: redactCloneDiagnostic(error.diagnostic ?? error.message, token),
    };
  }
  const raw = error?.stderr ? String(error.stderr) : error?.message ?? error;
  const diagnostic = redactCloneDiagnostic(raw, token) || "Git 未返回诊断信息";
  return { classification: classifyCloneFailure(diagnostic), attempts: 1, diagnostic };
}

function readOnlyCloneError({ child, failures }) {
  const finalFailure = failures.at(-1) ?? { classification: "unknown", diagnostic: "Git 未返回诊断信息" };
  const error = new Error(
    `${child.repo} 只读克隆失败（${finalFailure.classification}，${failures.length} 次）：${finalFailure.diagnostic}`,
  );
  error.code = "WORKLOOM_READ_ONLY_CLONE_FAILED";
  error.classification = finalFailure.classification;
  error.attempts = failures.length;
  error.diagnostic = finalFailure.diagnostic;
  return error;
}

function prefixedPath(child, path) {
  const prefix = child.pathPrefix?.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${path}` : path;
}

function blocker(code, path, message, remediation, phase = "phase-2") {
  return { code, phase, path, message, remediation };
}

const PHASE_ONE_CODES = new Set([
  "MISSING_PATH_PREFIX",
  "MISSING_CLIENT_PACKAGE",
  "INVALID_CLIENT_PACKAGE",
  "MISSING_CLIENT_ENTRY",
  "MISSING_PRODUCT_MANIFEST",
  "INVALID_PRODUCT_MANIFEST",
  "INVALID_PRODUCT_ROLE",
  "PRODUCT_REPOSITORY_MISMATCH",
  "INCOMPLETE_PRODUCT_IDENTITY",
  "PRODUCT_CLIENT_NOT_ENABLED",
  "INVALID_ROOT_PACKAGE",
  "UNPINNED_PACKAGE_MANAGER",
  "MISSING_GOVERNANCE_COMMAND",
  "MISSING_BUILD_POLICY",
  "DEFAULT_BRANCH_NOT_MAIN",
]);

function readJson(path, label, blockers, child, code, publicPath) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    blockers.push(blocker(
      code,
      publicPath ?? prefixedPath(child, relative(child.__workdir, path)),
      `${label} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`,
      `修复 ${label} 后重新运行发布前预检。`,
    ));
    return undefined;
  }
}

export function validateChildInventory(children, waveOrder) {
  if (!Array.isArray(children) || children.length !== EXPECTED_DOWNSTREAM_COUNT) {
    throw new Error(`下游清单必须且只能包含 ${EXPECTED_DOWNSTREAM_COUNT} 个仓库，当前为 ${Array.isArray(children) ? children.length : 0}`);
  }
  const names = children.map((child) => child?.repo).filter(Boolean);
  if (names.length !== children.length || new Set(names).size !== names.length) {
    throw new Error("下游清单存在空仓库名或重复仓库；拒绝发布");
  }
  if (!Array.isArray(waveOrder) || waveOrder.length === 0 || new Set(waveOrder).size !== waveOrder.length) {
    throw new Error("child-repos.json 必须提供无重复的 uiRolloutWaveOrder");
  }
  for (const child of children) {
    if (!waveOrder.includes(child.uiRolloutWave)) {
      throw new Error(`${child.repo} 未登记有效 uiRolloutWave；拒绝无序 rollout`);
    }
  }
  return true;
}

export function validateRelease(manifest, packageJson, version) {
  if (manifest.baseRepository !== CANONICAL_BASE_REPOSITORY) {
    throw new Error(`稳定发布基座必须为 ${CANONICAL_BASE_REPOSITORY}`);
  }
  if (!manifest.ui.latestStableVersion) throw new Error("base-capabilities.json 尚未登记 latestStableVersion");
  if (manifest.releasePolicy !== "base-first-stable-only") throw new Error("releasePolicy 必须为 base-first-stable-only");
  if (manifest.ui.latestStableVersion !== version) throw new Error(`稳定清单版本 ${manifest.ui.latestStableVersion} 与目标版本 ${version} 不一致`);
  if (packageJson.version !== version) throw new Error(`@workloom/ui 包版本 ${packageJson.version} 与目标版本 ${version} 不一致`);
  resolveStableFoundationVersion(manifest, version);
  resolveUiReleaseArtifact(manifest, version);
  return true;
}

/**
 * 只读盘点可以在首个稳定版尚未发布时针对当前候选版运行；它不授予发布或 rollout
 * 权限。rollout 仍只接受 latestStableVersion，并继续校验 GitHub Release 不可变制品。
 */
export function resolvePreflightTarget(manifest, packageJson, requestedVersion) {
  const version = requestedVersion
    ?? manifest.ui.candidateVersion
    ?? manifest.ui.latestStableVersion
    ?? packageJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`盘点目标必须是精确 semver，当前为 ${version ?? "未登记"}`);
  const allowed = new Set([manifest.ui.candidateVersion, manifest.ui.latestStableVersion, packageJson.version].filter(Boolean));
  if (!allowed.has(version)) throw new Error(`盘点目标 ${version} 未登记为候选版、稳定版或当前 UI 包版本`);
  const foundationAllowed = new Set([
    manifest.clientFoundation?.candidateVersion,
    manifest.clientFoundation?.latestStableVersion,
  ].filter(Boolean));
  if (!foundationAllowed.has(version)) throw new Error(`盘点目标 ${version} 未登记为三端客户端基座候选版或稳定版`);
  if (manifest.releasePolicy !== "base-first-stable-only") throw new Error("releasePolicy 必须为 base-first-stable-only");
  return {
    version,
    channel: version === manifest.ui.latestStableVersion ? "stable" : "candidate",
  };
}

/**
 * 检查一个已克隆行业仓是否完成发布前存量迁移。
 * 该函数只读；所有问题均保留机器可读 code/path，供 CI 和迁移台账消费。
 */
export function inspectMigratedConsumer(repoRoot, child, manifest) {
  const prefix = child.pathPrefix?.replace(/^\/+|\/+$/g, "") ?? "";
  const workdir = prefix ? join(repoRoot, prefix) : repoRoot;
  const context = { ...child, __workdir: workdir };
  const blockers = [];

  if (!existsSync(workdir)) {
    blockers.push(blocker(
      "MISSING_PATH_PREFIX",
      prefix || ".",
      `行业基座目录不存在：${prefix || "."}`,
      "先完成基座目录接入或修正 child-repos.json 的 pathPrefix。",
      "phase-1",
    ));
    return blockers;
  }

  for (const packagePath of manifest.ui.requiredClientPackages) {
    const absolutePackagePath = join(workdir, packagePath);
    if (!existsSync(absolutePackagePath)) {
      const clientName = packagePath.includes("apps/webb/") ? "B 端移动客户端" : packagePath.includes("apps/webc/") ? "C 端移动客户端" : "B 端 PC 客户端";
      blockers.push(blocker(
        "MISSING_CLIENT_PACKAGE",
        prefixedPath(child, packagePath),
        `缺少 ${clientName}：${packagePath}`,
        `先从基座迁移 ${packagePath.replace(/\/package\.json$/, "")} 生产客户端，再进入对应升级波次。`,
      ));
      continue;
    }
    readJson(absolutePackagePath, packagePath, blockers, context, "INVALID_CLIENT_PACKAGE");
    const entryPath = packagePath.replace(/package\.json$/, "src/main.tsx");
    if (!existsSync(join(workdir, entryPath))) {
      blockers.push(blocker(
        "MISSING_CLIENT_ENTRY",
        prefixedPath(child, entryPath),
        `客户端只有目录声明但缺少生产入口：${entryPath}`,
        "完成真实生产客户端迁移，禁止用空 package.json 占位绕过阶段一。",
      ));
    }
  }

  // 产品身份是 Git 仓根级受保护资产；即使 Tiger 的基座代码位于 governance/，
  // 也绝不能把安装包身份埋进 pathPrefix 或被基座同步覆盖。
  const productPath = join(repoRoot, "product.manifest.json");
  let product;
  if (!existsSync(productPath)) {
    blockers.push(blocker(
      "MISSING_PRODUCT_MANIFEST",
      "product.manifest.json",
      "缺少产品身份清单 product.manifest.json",
      "先登记独立 productId、release.appId、desktop.portOffset 与三端入口，禁止由基座覆盖行业身份。",
    ));
  } else {
    product = readJson(productPath, "product.manifest.json", blockers, context, "INVALID_PRODUCT_MANIFEST", "product.manifest.json");
  }
  if (product) {
    if (typeof product.role !== "string" || !product.role || product.role === "base") {
      blockers.push(blocker(
        "INVALID_PRODUCT_ROLE",
        "product.manifest.json",
        "行业仓 product.manifest.json 必须登记非 base 的产品角色",
        "按行业经营体、运营中枢或试验田角色登记产品身份。",
      ));
    }
    if (product.repository !== child.repo) {
      blockers.push(blocker(
        "PRODUCT_REPOSITORY_MISMATCH",
        "product.manifest.json",
        `产品清单 repository 应为 ${child.repo}，当前为 ${product.repository ?? "未登记"}`,
        "修正产品仓库身份，避免安装包和发布证据串仓。",
      ));
    }
    if (
      typeof product.productId !== "string"
      || !product.productId.trim()
      || typeof product.release?.appId !== "string"
      || !product.release.appId.trim()
      || product.release.appId === "com.workloom.im"
      || !Number.isInteger(product.desktop?.portOffset)
      || product.desktop.portOffset <= 0
    ) {
      blockers.push(blocker(
        "INCOMPLETE_PRODUCT_IDENTITY",
        "product.manifest.json",
        "行业仓必须登记独立 productId、非基座 release.appId 与正整数 desktop.portOffset",
        "完成安装包身份和本地端口隔离后再进入该仓 rollout 波次。",
      ));
    }
    for (const [key, entry] of Object.entries(PRODUCT_CLIENTS)) {
      const declared = product.clients?.[key];
      if (declared?.enabled !== true || declared?.entry !== entry) {
        blockers.push(blocker(
          "PRODUCT_CLIENT_NOT_ENABLED",
          "product.manifest.json",
          `产品清单必须启用 ${key} 并将入口登记为 ${entry}`,
          "补齐三个生产客户端的 enabled 与 entry，行业差异只通过 Bundle/投影表达。",
        ));
      }
    }
  }

  const rootPackagePath = join(workdir, "package.json");
  const rootPackage = existsSync(rootPackagePath)
    ? readJson(rootPackagePath, "根 package.json", blockers, context, "INVALID_ROOT_PACKAGE")
    : undefined;
  if (!rootPackage || rootPackage.packageManager !== "pnpm@10.14.0") {
    blockers.push(blocker(
      "UNPINNED_PACKAGE_MANAGER",
      prefixedPath(child, "package.json"),
      `行业基座必须固定 packageManager=pnpm@10.14.0，当前为 ${rootPackage?.packageManager ?? "未登记"}`,
      "固定与基座一致的 pnpm 版本，避免安装策略和锁文件被不同主版本改写。",
      "phase-1",
    ));
  }
  if (
    !rootPackage?.scripts?.["product:verify"]
    || !rootPackage?.scripts?.["bundle:governance"]
    || !(rootPackage?.devDependencies?.tsx || rootPackage?.dependencies?.tsx)
  ) {
    blockers.push(blocker(
      "MISSING_GOVERNANCE_COMMAND",
      prefixedPath(child, "package.json"),
      "行业仓缺少可执行的产品身份或 Bundle 治理命令",
      "接入 product:verify、bundle:governance 与固定 tsx 执行器；消费工作流会直接运行这些门禁。",
      "phase-1",
    ));
  }
  const workspacePolicyPath = join(workdir, "pnpm-workspace.yaml");
  const workspacePolicy = existsSync(workspacePolicyPath) ? readFileSync(workspacePolicyPath, "utf8") : "";
  if (!/onlyBuiltDependencies\s*:/u.test(workspacePolicy) || !/^\s*-\s+node-pty\s*$/mu.test(workspacePolicy)) {
    blockers.push(blocker(
      "MISSING_BUILD_POLICY",
      prefixedPath(child, "pnpm-workspace.yaml"),
      "行业仓未在工作区配置中显式允许桌面原生依赖构建",
      "把 onlyBuiltDependencies 放入 pnpm-workspace.yaml，并至少登记 node-pty。",
      "phase-1",
    ));
  }

  const statePath = join(workdir, ".workloom-ui.json");
  let state;
  if (!existsSync(statePath)) {
    blockers.push(blocker(
      "MISSING_UI_STATE",
      prefixedPath(child, ".workloom-ui.json"),
      "缺少共享 UI 消费状态 .workloom-ui.json",
      "先完成存量三端接入并登记精确稳定版本、三端清单与 upgrade-pr-only 策略。",
    ));
  } else {
    state = readJson(statePath, ".workloom-ui.json", blockers, context, "INVALID_UI_STATE");
  }
  if (state) {
    if (state.package !== manifest.ui.package) {
      blockers.push(blocker(
        "UI_PACKAGE_MISMATCH",
        prefixedPath(child, ".workloom-ui.json"),
        `共享 UI 包必须为 ${manifest.ui.package}，当前为 ${state.package ?? "未登记"}`,
        "改为消费基座发布的唯一共享 UI 包。",
      ));
    }
    if (state.updatePolicy !== "upgrade-pr-only") {
      blockers.push(blocker(
        "INVALID_UPDATE_POLICY",
        prefixedPath(child, ".workloom-ui.json"),
        `更新策略必须为 upgrade-pr-only，当前为 ${state.updatePolicy ?? "未登记"}`,
        "禁止自动直推 main；所有稳定升级必须经独立 PR。",
      ));
    }
    if (!/^\d+\.\d+\.\d+$/.test(state.version ?? "")) {
      blockers.push(blocker(
        "NON_STABLE_UI_VERSION",
        prefixedPath(child, ".workloom-ui.json"),
        `存量消费版本必须为精确稳定 semver，当前为 ${state.version ?? "未登记"}`,
        "先锁定已发布稳定版本，禁止 latest、范围、workspace 或候选版本。",
      ));
    }
    const required = new Set(state.requiredClientPackages ?? []);
    const connected = new Set(state.connectedClientPackages ?? []);
    for (const packagePath of manifest.ui.requiredClientPackages) {
      if (!required.has(packagePath) || !connected.has(packagePath)) {
        blockers.push(blocker(
          "UI_STATE_MISSING_CLIENT",
          prefixedPath(child, ".workloom-ui.json"),
          `共享 UI 状态未完整登记生产客户端 ${packagePath}`,
          "完成 B 端 PC、B 端移动、C 端移动三端迁移，并同时写入 requiredClientPackages 与 connectedClientPackages。",
        ));
      }
    }
  }

  // 结构齐备后再执行完整消费契约，避免只放空壳文件绕过发布门禁。
  if (state && manifest.ui.requiredClientPackages.every((path) => existsSync(join(workdir, path)))) {
    for (const message of verifyUiConsumerRepo(workdir)) {
      blockers.push(blocker(
        "UI_CONSUMER_CONTRACT_FAILED",
        prefix || ".",
        message,
        "按 @workloom/ui 三端消费契约完成迁移；禁止复制公共组件、令牌或视觉体系。",
      ));
    }
  }

  if (manifest.clientFoundation && existsSync(workdir)) {
    const foundation = inspectClientFoundationState({ repoRoot, targetRoot: workdir, manifest });
    for (const issue of foundation.issues.filter((item) => item.code !== "INVALID_PRODUCT_IDENTITY")) {
      blockers.push(blocker(
        issue.code,
        prefixedPath(child, issue.path),
        issue.message,
        issue.code === "MANAGED_FILE_MODIFIED"
          ? "把行业差异迁入 Bundle/theme/projection/config/extension 白名单路径，恢复旧基座文件后重试；禁止静默覆盖。"
          : "通过三端客户端基座稳定升级 PR 建立或修复逐文件指纹；不得手工标记完成。",
      ));
    }
  }

  const seen = new Set();
  return blockers.map((item) => ({
    ...item,
    phase: PHASE_ONE_CODES.has(item.code) ? "phase-1" : item.phase,
  })).filter((item) => {
    const key = `${item.code}\0${item.path}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function cloneChildReadOnly(child, attemptRoot, token = "", options = {}) {
  const maxAttempts = options.maxAttempts ?? READ_ONLY_CLONE_ATTEMPTS;
  const backoffMs = options.backoffMs ?? READ_ONLY_CLONE_BACKOFF_MS;
  const sleep = options.sleep ?? waitSynchronously;
  const cloneRunner = options.cloneRunner ?? (({ args, cwd, env }) => run("git", args, cwd, env));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("公开下游只读克隆重试次数必须为 1 到 5 的整数");
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 2_000) {
    throw new Error("公开下游只读克隆退避必须为 0 到 2000 毫秒");
  }

  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptDirectory = mkdtempSync(join(attemptRoot, `clone-attempt-${attempt}-`));
    const checkout = join(attemptDirectory, "repository");
    try {
      cloneRunner({
        attempt,
        target: checkout,
        args: [
          "-c",
          "http.version=HTTP/1.1",
          "clone",
          "--depth",
          "1",
          "--no-tags",
          repositoryUrl(child.repo),
          checkout,
        ],
        cwd: baseDir,
        env: canonicalGitEnvironment(token),
      });
      if (!existsSync(join(checkout, ".git"))) {
        throw new Error("git clone 未生成可验证的工作树");
      }
      return checkout;
    } catch (error) {
      const raw = error?.stderr ? String(error.stderr) : error?.message ?? error;
      const diagnostic = redactCloneDiagnostic(raw, token) || "Git 未返回诊断信息";
      const classification = classifyCloneFailure(diagnostic);
      failures.push({ classification, diagnostic });
      rmSync(attemptDirectory, { recursive: true, force: true });

      const retryable = ["network-transient", "rate-limited", "unknown"].includes(classification);
      if (!retryable || attempt === maxAttempts) throw readOnlyCloneError({ child, failures });
      sleep(backoffMs * attempt);
    }
  }
  throw readOnlyCloneError({ child, failures });
}

export function preflightChildren({ children, waveOrder, manifest, version, targetChannel = "stable", token = "", cloneChild = cloneChildReadOnly }) {
  validateChildInventory(children, waveOrder);
  const repositories = [];
  for (const child of children) {
    const temp = mkdtempSync(join(tmpdir(), "workloom-ui-preflight-"));
    try {
      const checkout = cloneChild(child, temp, token) ?? temp;
      const defaultBranch = run("git", ["branch", "--show-current"], checkout);
      const headSha = run("git", ["rev-parse", "HEAD"], checkout);
      const blockers = inspectMigratedConsumer(checkout, child, manifest);
      if (defaultBranch !== "main") {
        blockers.push(blocker(
          "DEFAULT_BRANCH_NOT_MAIN",
          ".git/HEAD",
          `默认分支为 ${defaultBranch || "未知"}，升级 PR 的受保护基线要求 main`,
          "统一默认分支或在发布治理中显式迁移后再重试。",
          "phase-1",
        ));
      }
      const stageOneBlockers = blockers.filter((item) => item.phase === "phase-1");
      const phaseTwoBlockers = blockers.filter((item) => item.phase === "phase-2");
      const workdir = child.pathPrefix ? join(checkout, child.pathPrefix.replace(/\/$/, "")) : checkout;
      let currentVersion = null;
      let currentFoundationVersion = null;
      try {
        currentVersion = JSON.parse(readFileSync(join(workdir, ".workloom-ui.json"), "utf8")).version ?? null;
      } catch {
        // 缺失/损坏已由 inspectMigratedConsumer 给出结构化 blocker。
      }
      try {
        currentFoundationVersion = JSON.parse(readFileSync(join(workdir, manifest.clientFoundation.stateFile), "utf8")).version ?? null;
      } catch {
        // 缺失/损坏已由 inspectMigratedConsumer 给出结构化 blocker。
      }
      const stageOneReady = stageOneBlockers.length === 0;
      const targetVersionApplied = stageOneReady
        && phaseTwoBlockers.length === 0
        && currentVersion === version
        && currentFoundationVersion === version;
      repositories.push({
        repo: child.repo,
        pathPrefix: child.pathPrefix || ".",
        wave: child.uiRolloutWave,
        headSha,
        accessStatus: "accessible",
        migrationStatus: targetVersionApplied ? "current" : stageOneReady ? "phase-2-upgrade-required" : "phase-1-blocked",
        stageOneReady,
        targetVersionApplied,
        currentVersion,
        currentFoundationVersion,
        status: targetVersionApplied ? "current" : stageOneReady ? "upgrade-ready" : "migration-blocked",
        blockers,
      });
    } catch (error) {
      const failure = cloneFailureMetadata(error, token);
      repositories.push({
        repo: child.repo,
        pathPrefix: child.pathPrefix || ".",
        wave: child.uiRolloutWave,
        accessStatus: "unreachable",
        migrationStatus: "unknown",
        stageOneReady: false,
        targetVersionApplied: false,
        currentVersion: null,
        currentFoundationVersion: null,
        status: "unreachable",
        blockers: [blocker(
          "CLONE_FAILED",
          ".",
          `只读克隆失败（${failure.classification}，已尝试 ${failure.attempts} 次）：${failure.diagnostic}`,
          "检查仓库可访问性和 SYNC_TOKEN 只读权限后重试；不得跳过该仓发布。",
          "access",
        )].map((item) => ({
          ...item,
          failureClass: failure.classification,
          attempts: failure.attempts,
        })),
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const accessibleCount = repositories.filter((item) => item.accessStatus === "accessible").length;
  const stageOneReadyCount = repositories.filter((item) => item.stageOneReady).length;
  const currentCount = repositories.filter((item) => item.targetVersionApplied).length;
  const unreachableCount = repositories.length - accessibleCount;
  return {
    schemaVersion: "workloom.ui-downstream-preflight/v1",
    phase: "pre-publish",
    generatedAt: new Date().toISOString(),
    baseRepository: manifest.baseRepository,
    targetVersion: version,
    targetChannel,
    targetArtifacts: {
      sharedUi: `${manifest.ui.package}@${version}`,
      clientFoundation: `ui-v${version}`,
      clientFoundationDistribution: manifest.clientFoundation.distribution,
    },
    requiredRepositoryCount: EXPECTED_DOWNSTREAM_COUNT,
    waveOrder,
    // ready/baseReleaseReady 只表达“基座可发布”，绝不把存量迁移完成度混进稳定制品门禁。
    ready: accessibleCount === EXPECTED_DOWNSTREAM_COUNT,
    baseReleaseReady: accessibleCount === EXPECTED_DOWNSTREAM_COUNT,
    allMigrationsCurrent: currentCount === EXPECTED_DOWNSTREAM_COUNT,
    summary: {
      accessible: accessibleCount,
      unreachable: unreachableCount,
      stageOneReady: stageOneReadyCount,
      phaseOneBlocked: EXPECTED_DOWNSTREAM_COUNT - stageOneReadyCount - unreachableCount,
      current: currentCount,
    },
    repositories,
  };
}

function waveIndex(waveOrder, wave) {
  return waveOrder.indexOf(wave);
}

/**
 * 选择本次 rollout 波次。默认只选择最早尚未完成的波次；显式 wave/仓白名单
 * 也不能越过未完成的更早波次，因此优先级顺序是可执行约束，而不是文档建议。
 */
export function selectRolloutBatch({ children, waveOrder, repositories, wave, repositoryWhitelist = [] }) {
  const states = new Map(repositories.map((item) => [item.repo, item]));
  const incompleteWaves = waveOrder.filter((candidate) => children
    .filter((child) => child.uiRolloutWave === candidate)
    .some((child) => !states.get(child.repo)?.targetVersionApplied));
  const earliestIncomplete = incompleteWaves[0] ?? null;

  let selectedWave = wave;
  let mode = "explicit-wave";
  if (repositoryWhitelist.length) {
    const unknown = repositoryWhitelist.filter((repo) => !children.some((child) => child.repo === repo));
    if (unknown.length) throw new Error(`仓白名单包含未知仓库：${unknown.join("、")}`);
    const waves = [...new Set(children.filter((child) => repositoryWhitelist.includes(child.repo)).map((child) => child.uiRolloutWave))];
    if (waves.length !== 1) throw new Error("单次仓白名单只能属于同一 rollout 波次");
    if (wave && wave !== waves[0]) throw new Error(`--wave ${wave} 与仓白名单所属波次 ${waves[0]} 不一致`);
    selectedWave = waves[0];
    mode = "repository-whitelist";
  } else if (!selectedWave) {
    selectedWave = earliestIncomplete;
    mode = "next-in-order";
  }

  if (selectedWave && !waveOrder.includes(selectedWave)) throw new Error(`未知 rollout 波次：${selectedWave}`);
  const blockedByEarlierWave = Boolean(
    selectedWave
    && earliestIncomplete
    && waveIndex(waveOrder, selectedWave) > waveIndex(waveOrder, earliestIncomplete),
  );
  const selected = selectedWave
    ? children.filter((child) => child.uiRolloutWave === selectedWave && (!repositoryWhitelist.length || repositoryWhitelist.includes(child.repo)))
    : [];
  return { mode, selectedWave, earliestIncomplete, blockedByEarlierWave, selected };
}

export function canCreateUpgradePr(repositoryState) {
  return repositoryState?.accessStatus === "accessible"
    && repositoryState.stageOneReady === true
    && repositoryState.targetVersionApplied !== true;
}

const ROLLOUT_FAILURE_STATUSES = new Set(["failed", "blocked-phase-1", "blocked-by-earlier-wave"]);

export function rolloutHasFailure(results) {
  return results.some((result) => ROLLOUT_FAILURE_STATUSES.has(result.status));
}

export function assertIndependentUpgradeBranch(branch) {
  if (!/^chore\/workloom-ui-v\d+\.\d+\.\d+$/.test(branch) || branch === "main") {
    throw new Error(`非法升级分支 ${branch}；rollout 只能写入独立 chore/workloom-ui-v* 分支`);
  }
  return true;
}

export function buildUpgradePullRequestBody(version) {
  return [
    "此 PR 由 WorkLoom IM 基座稳定版本发布流程创建。",
    "",
    `- 共享 UI：\`@workloom/ui@${version}\`（精确稳定版本）`,
    `- 客户端基座：\`ui-v${version}\`（同一不可变稳定标签）`,
    "- 更新范围：B 端 PC、B 端移动、C 端移动的应用壳、导航、布局、状态与 API 接线（缺一不可）",
    "- 冲突保护：逐文件比对上一稳定版 SHA-256，行业改动不静默覆盖",
    "- 行业差异：仅保留 Bundle、主题白名单、投影、配置和 extension 路径",
    "",
    "合并前必须由 `workloom-ui-contract` 工作流实际通过：",
    "- 共享 UI 消费契约与三端客户端基座指纹门禁",
    "- 产品身份一致性与全量行业 Bundle 契约、资产和完整性门禁",
    "- 三端逐一 typecheck 与生产 build",
    "- 仓库现有 pnpm 测试；仓根存在 Python 测试时同时运行 pytest",
    "- Playwright 对三端生产预览的基础主入口、首帧及稳定帧横向溢出冒烟",
    "",
    "本流程从不直推 main，也禁止复制公共组件或在受管客户端文件中硬编码行业差异。",
  ].join("\n");
}

export function renderConsumerWorkflow(pathPrefix = "") {
  if (typeof pathPrefix !== "string" || pathPrefix.includes("\\") || pathPrefix.startsWith("/")) {
    throw new Error(`非法消费仓 pathPrefix：${String(pathPrefix)}`);
  }
  const parts = pathPrefix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || !/^[-A-Za-z0-9_.]+$/.test(part))) {
    throw new Error(`非法消费仓 pathPrefix：${pathPrefix}`);
  }
  const repoDir = parts.join("/") || ".";
  return readFileSync(join(syncDir, "ui-consumer-template.yml"), "utf8").replaceAll("__REPO_DIR__", repoDir);
}

async function createPullRequest({ repo, token, branch, version }) {
  assertIndependentUpgradeBranch(branch);
  const title = `chore(base): 升级 WorkLoom 三端客户端基座至 ${version}`;
  const payload = {
    title,
    head: branch,
    base: "main",
    body: buildUpgradePullRequestBody(version),
  };
  // 同 head/base 的 PR 已存在时保持幂等：先查 open PR，避免把「已在验证」误判为失败。
  const openListUrl = `https://api.cnb.cool/${repo}/-/pulls?state=open&base_ref=main&page_size=100`;
  try {
    const listResponse = await fetch(openListUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (listResponse.ok) {
      const listed = await listResponse.json();
      const items = Array.isArray(listed) ? listed : (listed?.data ?? []);
      const existing = items.find((item) => (item?.head?.ref ?? item?.sourceBranch) === branch);
      if (existing) return { html_url: "已存在", number: existing.number ?? existing.id };
    }
  } catch {
    // 列表查询失败不阻断创建路径；后续创建会给出更明确的错误。
  }
  const response = await fetch(`https://api.cnb.cool/${repo}/-/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.ok) return response.json();
  const detail = await response.text();
  // 422/409 通常代表相同 head/base 的 PR 已存在；保持幂等并交给现有 PR 继续验证。
  if ((response.status === 422 || response.status === 409)
    && /already exists|已存在/iu.test(detail)) return { html_url: "已存在" };
  throw new Error(`创建 PR 失败 ${response.status}: ${detail.slice(0, 500)}`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 未返回有效 JSON`);
  }
}

function validIntegrity(value) {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const sha512Integrity = (value) => `sha512-${createHash("sha512").update(value).digest("base64")}`;

/**
 * 只允许公开 canonical GitHub Release 下载。--disable 阻断用户 .curlrc 注入，
 * 初始 URL 与重定向都限制 HTTPS；返回的是实际下载字节的 SHA-512，不信任
 * Release API 或文件名中自报的摘要。
 */
export function readCanonicalGithubReleaseArtifact({
  manifest,
  targetVersion,
  ambientEnvironment = process.env,
  execute = execFileSync,
}) {
  const artifact = resolveUiReleaseArtifact(manifest, targetVersion);
  let output;
  try {
    output = execute("curl", [
      "--disable",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto", "=https",
      "--proto-redir", "=https",
      "--max-redirs", "5",
      "--connect-timeout", "30",
      "--max-time", "300",
      "--", artifact.url,
    ], {
      cwd: baseDir,
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedSubprocessEnvironment(ambientEnvironment, { GIT_TERMINAL_PROMPT: "0" }),
    });
  } catch {
    throw new Error(`无法从 canonical GitHub Release 下载 ${artifact.assetName}`);
  }
  if (!Buffer.isBuffer(output) && !(output instanceof Uint8Array)) {
    throw new Error(`canonical GitHub Release ${artifact.assetName} 未返回二进制制品`);
  }
  const bytes = Buffer.from(output);
  if (bytes.length === 0) throw new Error(`canonical GitHub Release ${artifact.assetName} 为空制品`);
  return {
    url: artifact.url,
    assetName: artifact.assetName,
    integrity: sha512Integrity(bytes),
    size: bytes.length,
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalizedRemoteIdentity(value) {
  const remote = String(value ?? "").trim();
  if (!remote || /[\0\r\n]/u.test(remote)) throw new Error("canonical origin URL 无效");
  const scp = remote.match(/^git@([^:]+):(.+)$/u);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+|\.git\/?$/gu, "")}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)) {
    let url;
    try { url = new URL(remote); } catch { throw new Error("canonical origin URL 无效"); }
    if (url.password || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) {
      throw new Error("canonical origin URL 禁止内嵌凭据");
    }
    if (url.protocol === "file:") return `file:${resolve(decodeURIComponent(url.pathname))}`;
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\.git\/?$/gu, "")}`;
  }
  return `file:${resolve(remote)}`;
}

function gitCommandSucceeds(root, args) {
  try {
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: sanitizedSubprocessEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * rollout 的本地同名 tag 不构成信任锚。每次都从 canonical origin 抓取 main 与
 * 目标 tag 到一次性 refs，要求本地 tag 与远端精确同提交且该提交属于远端 main。
 */
export function verifyCanonicalReleaseTag({
  root = baseDir,
  sourceRef,
  expectedOriginUrl = `https://cnb.cool/${CANONICAL_BASE_REPOSITORY}.git`,
}) {
  const repositoryRoot = resolve(root);
  if (!/^refs\/tags\/ui-v\d+\.\d+\.\d+$/u.test(sourceRef ?? "")) {
    throw new Error(`canonical 校验只接受精确 ui-v 稳定标签：${sourceRef ?? "未提供"}`);
  }
  let originUrl;
  try {
    originUrl = run("git", ["remote", "get-url", "origin"], repositoryRoot);
  } catch {
    throw new Error("缺少 canonical origin；拒绝仅凭本地 tag rollout");
  }
  const actualIdentity = normalizedRemoteIdentity(originUrl);
  const expectedIdentity = normalizedRemoteIdentity(expectedOriginUrl);
  if (actualIdentity !== expectedIdentity) {
    throw new Error(`origin 不是 canonical 基座远端；期望 ${expectedIdentity}，实际 ${actualIdentity}`);
  }
  const expectedHost = expectedIdentity.split("/")[0];
  if (["github.com", "cnb.cool"].includes(expectedHost)
    && !new RegExp(`^https://${expectedHost.replaceAll(".", "\\.")}/`, "iu").test(originUrl)) {
    throw new Error(`canonical ${expectedHost} origin 必须使用无内嵌凭据的 HTTPS 公共只读地址`);
  }

  const namespace = `refs/workloom-release-verification/${process.pid}-${randomUUID()}`;
  const mainRef = `${namespace}/main`;
  const tagRef = `${namespace}/tag`;
  try {
    try {
      // canonical 基座是公开只读来源；普通 fetch 必须走净化环境，绝不借用 rollout token。
      run("git", [
        "-c", "credential.helper=",
        "-c", "http.extraHeader=",
        "fetch", "--force", "--no-tags", "origin",
        `+refs/heads/main:${mainRef}`,
        `+${sourceRef}:${tagRef}`,
      ], repositoryRoot, { GIT_TERMINAL_PROMPT: "0" });
    } catch {
      throw new Error(`无法从 canonical origin 同时获取 main 与 ${sourceRef}`);
    }
    const localTagCommit = run("git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], repositoryRoot);
    const canonicalTagCommit = run("git", ["rev-parse", "--verify", `${tagRef}^{commit}`], repositoryRoot);
    const canonicalMainCommit = run("git", ["rev-parse", "--verify", `${mainRef}^{commit}`], repositoryRoot);
    if (localTagCommit !== canonicalTagCommit) {
      throw new Error(`${sourceRef} 本地提交与 canonical origin 同名标签不一致；拒绝歧义标签 rollout`);
    }
    if (!gitCommandSucceeds(repositoryRoot, ["merge-base", "--is-ancestor", canonicalTagCommit, canonicalMainCommit])) {
      throw new Error(`${sourceRef} 不是 canonical origin/main 的祖先；拒绝旁路标签 rollout`);
    }
    return {
      origin: actualIdentity,
      tagCommit: canonicalTagCommit,
      mainCommit: canonicalMainCommit,
    };
  } finally {
    for (const ref of [tagRef, mainRef]) {
      try { run("git", ["update-ref", "-d", ref], repositoryRoot); } catch { /* best-effort cleanup */ }
    }
  }
}

function taggedBlob(root, sourceRef, path) {
  const tree = run("git", ["ls-tree", "-z", sourceRef, "--", path], root);
  const records = tree.split("\0").filter(Boolean);
  if (records.length !== 1) throw new Error(`${sourceRef} 的治理载荷缺少唯一文件：${path}`);
  const match = /^(100644|100755)\s+blob\s+[0-9a-f]+\t(.+)$/u.exec(records[0]);
  if (!match || match[2] !== path) throw new Error(`${sourceRef} 的治理载荷文件类型非法：${path}`);
  return {
    content: execFileSync("git", ["show", `${sourceRef}:${path}`], {
      cwd: root,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedSubprocessEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    }),
    mode: match[1] === "100755" ? 0o755 : 0o644,
  };
}

function digestPayloadEntries(entries) {
  return sha256(Buffer.from(`${JSON.stringify(entries)}\n`));
}

function releasePayload({ repositoryRoot, taggedManifest, version, sourceRef, sourceCommit, canonical }) {
  const snapshot = loadStableFoundationSnapshot(repositoryRoot, taggedManifest, version);
  if (snapshot.sourceCommit !== sourceCommit) throw new Error(`${sourceRef} 的客户端基座提交与 canonical tag 不一致`);
  const clientEntries = [...snapshot.files.entries()].map(([path, file]) => ({
    category: "client-foundation",
    path,
    mode: file.mode,
    sha256: sha256(file.content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const governanceEntries = RELEASE_GOVERNANCE_PAYLOAD_PATHS.map((path) => {
    const file = taggedBlob(repositoryRoot, sourceRef, path);
    return { category: "governance", path, mode: file.mode, sha256: sha256(file.content) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const files = [...clientEntries, ...governanceEntries];
  const unsigned = {
    schemaVersion: RELEASE_PAYLOAD_SCHEMA,
    version,
    sourceRef,
    sourceCommit,
    canonical: {
      origin: canonical.origin,
      tagCommit: canonical.tagCommit,
      mainCommit: canonical.mainCommit,
    },
    clientFoundation: { fileCount: clientEntries.length, digest: digestPayloadEntries(clientEntries) },
    governance: { fileCount: governanceEntries.length, digest: digestPayloadEntries(governanceEntries) },
    files,
  };
  return { ...unsigned, digest: sha256(Buffer.from(`${JSON.stringify(unsigned)}\n`)) };
}

export function assertReleasePayloadIntegrity(payload, { version, sourceRef, sourceCommit } = {}) {
  if (!payload || payload.schemaVersion !== RELEASE_PAYLOAD_SCHEMA || !Array.isArray(payload.files)) {
    throw new Error("稳定发布缺少 clientFoundation + governance 载荷清单");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(payload.version ?? "")
    || payload.sourceRef !== `refs/tags/ui-v${payload.version}`
    || !/^[0-9a-f]{40}$/u.test(payload.sourceCommit ?? "")) {
    throw new Error("稳定发布载荷来源元数据无效");
  }
  if ((version && payload.version !== version)
    || (sourceRef && payload.sourceRef !== sourceRef)
    || (sourceCommit && payload.sourceCommit !== sourceCommit)) {
    throw new Error("稳定发布载荷与本地标签元数据不一致");
  }
  if (payload.canonical?.tagCommit !== payload.sourceCommit
    || !/^[0-9a-f]{40}$/u.test(payload.canonical?.mainCommit ?? "")
    || typeof payload.canonical?.origin !== "string"
    || !payload.canonical.origin) {
    throw new Error("稳定发布载荷缺少 canonical origin 信任证明");
  }
  const seen = new Set();
  for (const file of payload.files) {
    normalizeRepositoryPath(file?.path, "发布载荷路径");
    if (!["client-foundation", "governance"].includes(file?.category)
      || ![0o644, 0o755].includes(file?.mode)
      || !/^[0-9a-f]{64}$/u.test(file?.sha256 ?? "")) {
      throw new Error(`稳定发布载荷文件契约无效：${file?.path ?? "未知"}`);
    }
    const identity = `${file.category}:${file.path}`;
    if (seen.has(identity)) throw new Error(`稳定发布载荷文件重复：${file.path}`);
    seen.add(identity);
  }
  const expectedOrder = [...payload.files].sort((left, right) => (
    left.category.localeCompare(right.category) || left.path.localeCompare(right.path)
  ));
  if (JSON.stringify(expectedOrder) !== JSON.stringify(payload.files)) {
    throw new Error("稳定发布载荷文件清单未按类别和路径确定性排序");
  }
  const clientEntries = payload.files.filter((file) => file.category === "client-foundation");
  const governanceEntries = payload.files.filter((file) => file.category === "governance");
  if (payload.clientFoundation?.fileCount !== clientEntries.length
    || payload.clientFoundation?.digest !== digestPayloadEntries(clientEntries)
    || payload.governance?.fileCount !== governanceEntries.length
    || payload.governance?.digest !== digestPayloadEntries(governanceEntries)) {
    throw new Error("稳定发布 clientFoundation 或 governance 载荷摘要不一致");
  }
  const { digest, ...unsigned } = payload;
  if (!/^[0-9a-f]{64}$/u.test(digest ?? "")
    || digest !== sha256(Buffer.from(`${JSON.stringify(unsigned)}\n`))) {
    throw new Error("稳定发布载荷总摘要不一致");
  }
  return true;
}

function assertWorkingGovernancePayloadMatchesTag(root, sourceRef) {
  for (const path of RELEASE_GOVERNANCE_PAYLOAD_PATHS) {
    const tagged = taggedBlob(root, sourceRef, path).content;
    const workingPath = join(root, path);
    if (!existsSync(workingPath) || !lstatSync(workingPath).isFile() || readFileSync(workingPath).equals(tagged) === false) {
      throw new Error(`${path} 工作树字节与 canonical ${sourceRef} 不一致；拒绝下发未封存治理载荷`);
    }
  }
}

/**
 * 从 ui-v* Git 标签而非可变工作树生成 npm pack。临时源只包含标签里的发布输入，
 * node_modules 只作为构建工具链接且不会进入制品；因此脏工作树和残留 dist 均不能
 * 冒充已发布的稳定制品。
 */
export function packTaggedUiArtifact({
  root = baseDir,
  manifest,
  version,
  expectedOriginUrl = `https://cnb.cool/${CANONICAL_BASE_REPOSITORY}.git`,
  readNpmVersion = () => run("npm", ["--version"], resolve(root)),
  readPnpmVersion = () => run("pnpm", ["--version"], resolve(root)),
  prepack = ({ cwd }) => run("pnpm", ["run", "prepack"], cwd),
  pack = ({ cwd, artifactRoot, sourceRef }) => parseJson(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactRoot], cwd),
    `${sourceRef} 的 npm pack 元数据`,
  ),
}) {
  const repositoryRoot = resolve(root);
  const npmVersion = readNpmVersion();
  const pnpmVersion = readPnpmVersion();
  if (npmVersion !== "11.6.2" || pnpmVersion !== "10.14.0") {
    throw new Error(`UI 稳定制品复算工具链必须固定为 npm 11.6.2 / pnpm 10.14.0，当前为 npm ${npmVersion} / pnpm ${pnpmVersion}`);
  }
  const stableVersion = resolveStableFoundationVersion(manifest, version);
  const sourceRef = manifest.clientFoundation.stableSourceRefPattern.replace("{version}", stableVersion);
  const canonical = verifyCanonicalReleaseTag({
    root: repositoryRoot,
    sourceRef,
    expectedOriginUrl,
  });
  const sourceCommit = canonical.tagCommit;
  const headCommit = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], repositoryRoot);
  if (headCommit !== sourceCommit) {
    throw new Error(`rollout 必须在已固定 ${sourceRef} 的提交 ${sourceCommit.slice(0, 12)} 上执行，当前 HEAD 为 ${headCommit.slice(0, 12)}`);
  }

  const taggedManifest = parseJson(
    run("git", ["show", `${sourceRef}:sync/base-capabilities.json`], repositoryRoot),
    `${sourceRef} 的 base-capabilities.json`,
  );
  const taggedPackage = parseJson(
    run("git", ["show", `${sourceRef}:packages/ui/package.json`], repositoryRoot),
    `${sourceRef} 的 packages/ui/package.json`,
  );
  validateRelease(taggedManifest, taggedPackage, stableVersion);
  if (taggedPackage.name !== manifest.ui.package) {
    throw new Error(`${sourceRef} 的包名 ${taggedPackage.name ?? "未登记"} 与 ${manifest.ui.package} 不一致`);
  }
  const releaseArtifact = resolveUiReleaseArtifact(taggedManifest, stableVersion);
  assertWorkingGovernancePayloadMatchesTag(repositoryRoot, sourceRef);
  const payload = releasePayload({
    repositoryRoot,
    taggedManifest,
    version: stableVersion,
    sourceRef,
    sourceCommit,
    canonical,
  });
  assertReleasePayloadIntegrity(payload, { version: stableVersion, sourceRef, sourceCommit });

  // packages/ui 的测试依赖同仓 packages/industry-contract（导航常量与契约类型），
  // 隔离源必须一并带入，否则 prepack 的 `pnpm test` 会因 CANNOT_FIND_MODULE 失败；
  // npm pack 仍只按 packages/ui 的 files 白名单产出制品，依赖不进入 tarball。
  const archivedPaths = ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json", "packages/ui", "packages/industry-contract"];
  const tree = run("git", ["ls-tree", "-rz", sourceRef, "--", ...archivedPaths], repositoryRoot);
  for (const record of tree.split("\0").filter(Boolean)) {
    const mode = record.match(/^(\d+)\s/u)?.[1];
    if (!mode || !["100644", "100755"].includes(mode)) {
      throw new Error(`${sourceRef} 的 UI pack 输入包含不支持的 Git tree 类型：${record.slice(0, 160)}`);
    }
  }

  const temp = mkdtempSync(join(tmpdir(), "workloom-ui-integrity-"));
  const sourceRoot = join(temp, "source");
  const artifactRoot = join(temp, "artifact");
  const archivePath = join(temp, "source.tar");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", sourceRef, "--", ...archivedPaths], {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedSubprocessEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    writeFileSync(archivePath, archive);
    run("tar", ["-xf", archivePath, "-C", sourceRoot], repositoryRoot);
    rmSync(archivePath, { force: true });

    // 先用已校验为 10.14.0 的 pnpm 显式运行 prepack；构建/vitest 的 stdout
    // 只属于这个子进程，不会污染后续 JSON。随后 npm pack 必须 --ignore-scripts，
    // 防止 prepack 二次执行并保证 stdout 只含 pack 元数据。依赖来自调用方刚以固定
    // lockfile 安装的工作区；链接仅存在于即将销毁的临时目录且不会进入 files 白名单。
    // packages/ui 的测试链会解析到 packages/industry-contract（其源码 import zod），
    // 因此隔离源需要把该包的依赖树一并链接进来，否则 prepack 的 `pnpm test` 解析失败。
    for (const relativeDependencyPath of [
      "node_modules",
      "packages/ui/node_modules",
      "packages/industry-contract/node_modules",
    ]) {
      const dependencyPath = join(repositoryRoot, relativeDependencyPath);
      if (!existsSync(dependencyPath)) continue;
      const linkPath = join(sourceRoot, relativeDependencyPath);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(dependencyPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    }

    const packageRoot = join(sourceRoot, "packages/ui");
    prepack({ cwd: packageRoot, artifactRoot, sourceRef });
    const metadata = pack({ cwd: packageRoot, artifactRoot, sourceRef });
    if (!Array.isArray(metadata) || metadata.length !== 1) {
      throw new Error(`${sourceRef} 的 npm pack 必须且只能生成一个制品`);
    }
    const artifact = metadata[0];
    if (artifact?.name !== manifest.ui.package || artifact?.version !== stableVersion || !validIntegrity(artifact?.integrity)) {
      throw new Error(`${sourceRef} 的 npm pack 元数据与 ${manifest.ui.package}@${stableVersion} 不一致`);
    }
    return {
      package: artifact.name,
      version: artifact.version,
      sourceRef,
      sourceCommit,
      integrity: artifact.integrity,
      releaseArtifact,
      releasePayload: payload,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function assertReleaseArtifactIntegrity(localArtifact, releaseArtifact, manifest, packageName, version) {
  if (
    localArtifact?.package !== packageName
    || localArtifact?.version !== version
    || !validIntegrity(localArtifact?.integrity)
  ) {
    throw new Error(`本地标签未生成有效的 ${packageName}@${version} npm pack`);
  }
  const registered = resolveUiReleaseArtifact(manifest, version);
  const taggedRegistration = localArtifact.releaseArtifact;
  if (!taggedRegistration
    || ["type", "url", "assetName", "sha512", "overrideSelector"]
      .some((key) => taggedRegistration[key] !== registered[key])) {
    throw new Error(`工作树与固定标签的 base-capabilities.json 制品登记不一致：${packageName}@${version}`);
  }
  if (registered.sha512 !== localArtifact.integrity) {
    throw new Error(`base-capabilities.json 登记的 ${packageName}@${version} integrity 与 ${localArtifact.sourceRef} 本地 pack 不一致`);
  }
  if (releaseArtifact?.url !== registered.url || releaseArtifact?.assetName !== registered.assetName) {
    throw new Error(`GitHub Release 制品来源不是 canonical ${registered.assetName}`);
  }
  if (!validIntegrity(releaseArtifact?.integrity) || !Number.isInteger(releaseArtifact?.size) || releaseArtifact.size <= 0) {
    throw new Error(`canonical GitHub Release 尚未返回 ${packageName}@${version} 的有效非空 tarball`);
  }
  if (releaseArtifact.integrity !== registered.sha512) {
    throw new Error(`GitHub Release ${registered.assetName} 的字节 integrity 与 base-capabilities.json 登记值不一致`);
  }
  if (releaseArtifact.integrity !== localArtifact.integrity) {
    throw new Error(`GitHub Release ${registered.assetName} 与 ${localArtifact.sourceRef} 本地 pack 不一致，拒绝同版本异内容 rollout`);
  }
  assertReleasePayloadIntegrity(localArtifact.releasePayload, {
    version,
    sourceRef: localArtifact.sourceRef,
    sourceCommit: localArtifact.sourceCommit,
  });
  return {
    ...localArtifact,
    declaredIntegrity: registered.sha512,
    githubReleaseIntegrity: releaseArtifact.integrity,
    releaseAssetUrl: releaseArtifact.url,
    releaseAssetName: releaseArtifact.assetName,
    releaseAssetSize: releaseArtifact.size,
  };
}

export function verifyPublishedArtifact(manifest, version, {
  root = baseDir,
  packArtifact = packTaggedUiArtifact,
  readReleaseArtifact = readCanonicalGithubReleaseArtifact,
} = {}) {
  const localArtifact = packArtifact({ root, manifest, version });
  const releaseArtifact = readReleaseArtifact({
    manifest,
    targetVersion: version,
  });
  return assertReleaseArtifactIntegrity(localArtifact, releaseArtifact, manifest, manifest.ui.package, version);
}

async function upgradeChild(child, manifest, version, token, dryRun, foundationSnapshot) {
  const temp = mkdtempSync(join(tmpdir(), "workloom-ui-upgrade-"));
  const branch = `chore/workloom-ui-v${version}`;
  assertIndependentUpgradeBranch(branch);
  try {
    const checkout = cloneChildReadOnly(child, temp, token);
    run("git", ["switch", "-c", branch], checkout);
    const workdir = child.pathPrefix ? join(checkout, child.pathPrefix.replace(/\/$/, "")) : checkout;
    const foundation = applyClientFoundation({
      repoRoot: checkout,
      targetRoot: workdir,
      manifest,
      snapshot: foundationSnapshot,
      mode: existsSync(join(workdir, manifest.clientFoundation.stateFile)) ? "upgrade" : "scaffold",
      // 即使 rollout 本身是 dry-run，也只在即将销毁的临时 clone 中应用，借此运行
      // 后续真实 lockfile/消费门禁；远端仓和分支始终零写入。
      dryRun: false,
    });
    const touched = setUiVersion({
      repo: checkout,
      prefix: child.pathPrefix?.replace(/\/$/, "") ?? "",
      version,
      manifest,
      requireAll: true,
    });
    mkdirSync(join(checkout, ".github/workflows"), { recursive: true });
    mkdirSync(join(workdir, "scripts"), { recursive: true });
    const workflow = renderConsumerWorkflow(child.pathPrefix);
    writeFileSync(join(checkout, ".github/workflows/workloom-ui-contract.yml"), workflow);
    // 门禁脚本属于消费契约，不是可分叉的 UI 源码；随升级 PR 一并落到行业仓。
    const governance = installUiGovernance({ repo: workdir, repositoryRoot: checkout, sourceRoot: baseDir });
    for (const path of ADOPTION_SCRIPTS) {
      // apps/web 的生产 build 会执行文案边界；升级 PR 必须自带与稳定
      // 客户端壳同源的验证器，不能假设独立 base-sync 已先落地。
      copyFileSync(join(baseDir, path), join(workdir, path));
    }
    run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], workdir);
    // pnpm 10 会锁定 canonical tarball URL，但不会为 URL tarball 自动写 SRI。
    // 在 frozen install 前把同一稳定 state 的 SHA-512 注入唯一 resolution，令包管理器
    // 真正执行完整性校验，避免 Release 资产在同 URL 下被替换后仍可冷安装。
    bindUiLockfileIntegrity(workdir);
    // verifier 静态依赖固定的 TypeScript/YAML governance 解析器。rollout 的临时 clone 必须按刚生成
    // 的锁文件建立真实依赖树，不能从基座工作树的 node_modules 偶然解析成功。
    run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], workdir);
    run("node", [join(workdir, "scripts/verify-ui-consumer.mjs"), "--repo", workdir], workdir);
    run("node", [join(workdir, "scripts/verify-client-foundation-consumer.mjs"), "--repo", workdir], workdir);
    const foundationTouched = foundation.filesTouched ?? [];
    const inWorkdir = (path) => prefixedPath(child, path);
    const allowedUpgradePaths = [
      ...foundationTouched.map(inWorkdir),
      ...touched.map(inWorkdir),
      inWorkdir(".workloom-ui.json"),
      inWorkdir("package.json"),
      inWorkdir("pnpm-lock.yaml"),
      ...governance.files.map(inWorkdir),
      inWorkdir(GOVERNANCE_STATE),
      ...ADOPTION_SCRIPTS.map(inWorkdir),
      ADOPTION_WORKFLOW,
    ];
    const stagedPaths = stageExactUpgradeChanges({ repoRoot: checkout, allowedPaths: allowedUpgradePaths });
    if (!stagedPaths.length) return { repo: child.repo, status: "already-current", touched, foundationTouched };
    if (dryRun) return { repo: child.repo, status: "planned", touched, foundationTouched };
    run("git", ["-c", "user.name=WorkLoom Base Release", "-c", "user.email=base-release@workloom.im", "commit", "-m", `chore(base): 升级三端客户端基座至 ${version}`], checkout);
    const remoteHead = run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], checkout, canonicalGitEnvironment(token)).split(/\s+/)[0] || "";
    const lease = remoteHead ? `--force-with-lease=refs/heads/${branch}:${remoteHead}` : "--force-with-lease";
    run("git", ["push", lease, "origin", `HEAD:refs/heads/${branch}`], checkout, canonicalGitEnvironment(token));
    const pull = await createPullRequest({ repo: child.repo, token, branch, version });
    return { repo: child.repo, status: "pr-opened", url: pull.html_url, touched, foundationTouched };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function emitReport(report, reportPath) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), output);
  process.stdout.write(output);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(syncDir, "base-capabilities.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(baseDir, "packages/ui/package.json"), "utf8"));

  const target = options.mode === "preflight"
    ? resolvePreflightTarget(manifest, packageJson, options.requestedVersion)
    : { version: resolveUiVersion(manifest, options.requestedVersion), channel: "stable" };
  const version = target.version;
  if (options.mode !== "preflight") validateRelease(manifest, packageJson, version);
  if (options.mode === "verify-artifact") {
    const artifact = verifyPublishedArtifact(manifest, version);
    emitReport({
      schemaVersion: "workloom.ui-artifact-integrity/v1",
      verified: true,
      ...artifact,
    }, options.reportPath);
    return;
  }

  // 所有 rollout（包括本地 dry-run）均在访问任何下游仓之前重新生成固定标签的
  // npm pack，下载 canonical GitHub Release tarball，再与标签内 base-capabilities 登记的
  // SHA-512 做三方逐字节核对；只验证 version 不构成授权条件。
  const verifiedArtifact = options.mode === "rollout"
    ? verifyPublishedArtifact(manifest, version)
    : null;
  // rollout 的写目标与波次同样属于授权 TCB：只从已验证 canonical tag 读取，
  // 绝不能让合法形状的脏工作树清单把跨仓 token 导向另一组仓库。
  const childManifest = options.mode === "rollout"
    ? parseJson(
      taggedBlob(baseDir, verifiedArtifact.sourceRef, "sync/child-repos.json").content.toString("utf8"),
      `${verifiedArtifact.sourceRef} 的 child-repos.json`,
    )
    : JSON.parse(readFileSync(join(syncDir, "child-repos.json"), "utf8"));
  const children = childManifest.children;
  const waveOrder = childManifest.uiRolloutWaveOrder;
  validateChildInventory(children, waveOrder);
  const token = process.env.SYNC_TOKEN || process.env.CNB_TOKEN || process.env.GH_TOKEN || "";

  const preflight = preflightChildren({ children, waveOrder, manifest, version, targetChannel: target.channel, token });
  if (options.mode === "preflight") {
    emitReport(preflight, options.reportPath);
    if (!preflight.baseReleaseReady) process.exitCode = 1;
    return;
  }

  if (!preflight.baseReleaseReady) {
    emitReport({ ...preflight, phase: "rollout-precheck" }, options.reportPath);
    process.exitCode = 1;
    return;
  }
  if (!options.dryRun && !token) throw new Error("缺少 SYNC_TOKEN/CNB_TOKEN 或 GH_TOKEN；拒绝创建无法审计的半成品分支");
  const foundationSnapshot = loadStableFoundationSnapshot(baseDir, manifest, version);

  const batch = selectRolloutBatch({
    children,
    waveOrder,
    repositories: preflight.repositories,
    wave: options.wave,
    repositoryWhitelist: options.repositories,
  });
  const results = [];
  if (batch.blockedByEarlierWave) {
    results.push({
      status: "blocked-by-earlier-wave",
      wave: batch.selectedWave,
      blockers: [blocker(
        "EARLIER_WAVE_INCOMPLETE",
        "sync/child-repos.json",
        `波次 ${batch.selectedWave} 不能越过尚未完成的 ${batch.earliestIncomplete}`,
        `先完成并合并 ${batch.earliestIncomplete} 的全部升级 PR，再启动 ${batch.selectedWave}。`,
        "wave-order",
      )],
    });
  }
  for (const child of batch.blockedByEarlierWave ? [] : batch.selected) {
    const state = preflight.repositories.find((item) => item.repo === child.repo);
    if (state?.targetVersionApplied) {
      results.push({ repo: child.repo, wave: child.uiRolloutWave, status: "already-current", touched: [] });
      continue;
    }
    if (!canCreateUpgradePr(state)) {
      results.push({
        repo: child.repo,
        wave: child.uiRolloutWave,
        status: "blocked-phase-1",
        blockers: state?.blockers.filter((item) => item.phase === "phase-1") ?? [],
      });
      continue;
    }
    try {
      results.push({
        ...(await upgradeChild(child, manifest, version, token, options.dryRun, foundationSnapshot)),
        wave: child.uiRolloutWave,
      });
    } catch (error) {
      results.push({
        repo: child.repo,
        wave: child.uiRolloutWave,
        status: "failed",
        blockers: [blocker(
          "UPGRADE_PR_FAILED",
          child.pathPrefix || ".",
          String(error?.message ?? error).split("\n")[0].slice(0, 500),
          "修复该仓第二阶段消费契约或远端 PR 权限后，在同一波次幂等重试。",
          "phase-2",
        )],
      });
    }
  }
  const selectedNames = new Set((batch.blockedByEarlierWave ? [] : batch.selected).map((child) => child.repo));
  for (const child of children.filter((item) => !selectedNames.has(item.repo))) {
    const state = preflight.repositories.find((item) => item.repo === child.repo);
    results.push({
      repo: child.repo,
      wave: child.uiRolloutWave,
      status: state?.targetVersionApplied ? "already-current" : "deferred-wave",
      blockers: state?.targetVersionApplied ? [] : [blocker(
        "DEFERRED_BY_WAVE",
        "sync/child-repos.json",
        `本次只处理 ${batch.selectedWave ?? "无待处理波次"}，${child.repo} 保留在 ${child.uiRolloutWave}`,
        "按 uiRolloutWaveOrder 完成前序波次后再运行；不得标记为已同步。",
        "wave-order",
      )],
    });
  }
  const report = {
    schemaVersion: "workloom.ui-rollout/v1",
    phase: options.dryRun ? "rollout-dry-run" : "post-publish-rollout",
    generatedAt: new Date().toISOString(),
    baseRepository: manifest.baseRepository,
    targetVersion: version,
    targetArtifacts: {
      sharedUi: `${manifest.ui.package}@${version}`,
      sharedUiIntegrity: verifiedArtifact.githubReleaseIntegrity,
      sharedUiReleaseAsset: verifiedArtifact.releaseAssetUrl,
      sharedUiReleaseAssetSize: verifiedArtifact.releaseAssetSize,
      clientFoundation: `ui-v${version}`,
      clientFoundationDigest: verifiedArtifact.releasePayload.clientFoundation.digest,
      governanceDigest: verifiedArtifact.releasePayload.governance.digest,
      payloadDigest: verifiedArtifact.releasePayload.digest,
      payloadFileCount: verifiedArtifact.releasePayload.files.length,
      canonicalSourceCommit: verifiedArtifact.sourceCommit,
    },
    directMainPush: false,
    selection: {
      mode: batch.mode,
      selectedWave: batch.selectedWave,
      earliestIncompleteWave: batch.earliestIncomplete,
      requestedRepositories: options.repositories,
      blockedByEarlierWave: batch.blockedByEarlierWave,
    },
    actionRequired: results.some((result) => ["blocked-phase-1", "failed", "blocked-by-earlier-wave", "deferred-wave"].includes(result.status)),
    results,
  };
  emitReport(report, options.reportPath);
  if (rolloutHasFailure(results)) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
