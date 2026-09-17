#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GOVERNANCE_TYPESCRIPT = "npm:typescript@5.9.3";
export const GOVERNANCE_YAML = "npm:yaml@2.9.0";
export const GOVERNANCE_STATE = ".workloom-ui-governance.json";
const BASE_SYNC_STATE = ".workloom-base-sync.json";
const CANONICAL_BASE_REPO = "workloom-ai/workloom-im";
const LEGACY_SCOPE_VERSION = 8;
export const GOVERNANCE_FILES = Object.freeze([
  "scripts/verify-ui-consumer.mjs",
  "scripts/ui-governance-rules.mjs",
]);

const hash = (value) => createHash("sha256").update(value).digest("hex");

function globToRegExp(glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "\u0000");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`, "u");
}

function matchesAny(path, patterns) {
  return Array.isArray(patterns) && patterns.some((pattern) => (
    typeof pattern === "string" && globToRegExp(pattern).test(path)
  ));
}

export function sanitizedLocalGitEnvironment(ambient = process.env) {
  // 这些命令只读取本地 object database，不需要网络凭证。使用显式 allowlist，
  // 避免 rollout 的跨仓 token、npm token 或 GIT_CONFIG extraHeader 意外进入子进程。
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT",
  ];
  const environment = {};
  for (const key of allowed) {
    if (typeof ambient[key] === "string") environment[key] = ambient[key];
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function gitOutput(root, args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding,
      env: sanitizedLocalGitEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function gitSucceeds(root, args) {
  return spawnSync("git", ["-C", root, ...args], {
    env: sanitizedLocalGitEnvironment(),
    stdio: "ignore",
  }).status === 0;
}

function safeRoot(path, label) {
  const root = realpathSync(resolve(path));
  if (!lstatSync(root).isDirectory()) throw new Error(`${label} 不是目录`);
  return root;
}

function safeFile(root, path, label) {
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`${label} 路径逃逸`);
  let cursor = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} 不允许 symlink：${path}`);
  }
  return target;
}

function lstatMaybe(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

/**
 * v8 曾把治理脚本当作普通 scripts/** 文件下发。这里只接受 canonical 基座
 * Git 历史中、当前稳定提交的祖先所提供的精确旧字节；目标仓 state 只负责指出
 * 候选提交和 pathPrefix，本身不构成信任锚。任一证据缺失都返回 null。
 */
function legacyBaseSyncProof({ targetRoot, repositoryRoot, source }) {
  const targetGitRoot = gitOutput(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (typeof targetGitRoot !== "string") return null;
  let canonicalTargetGitRoot;
  try { canonicalTargetGitRoot = realpathSync(resolve(targetGitRoot.trim())); } catch { return null; }
  if (canonicalTargetGitRoot !== repositoryRoot) return null;

  const statePath = safeFile(repositoryRoot, BASE_SYNC_STATE, "legacy base-sync state");
  if (!existsSync(statePath) || !lstatSync(statePath).isFile()) return null;

  let state;
  try { state = readJson(statePath, BASE_SYNC_STATE); } catch { return null; }
  const expectedPrefix = relative(repositoryRoot, targetRoot).split(sep).join("/") || ".";
  const sourceCommit = state?.lastSyncedBaseSha;
  if (state?.baseRepo !== CANONICAL_BASE_REPO
    || state?.pathPrefix !== expectedPrefix
    || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) return null;

  const sourceGitRoot = gitOutput(source, ["rev-parse", "--show-toplevel"]);
  if (typeof sourceGitRoot !== "string") return null;
  let canonicalSourceRoot;
  try { canonicalSourceRoot = realpathSync(resolve(sourceGitRoot.trim())); } catch { return null; }
  if (canonicalSourceRoot !== source) return null;

  const currentCommit = gitOutput(source, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (typeof currentCommit !== "string" || !/^[0-9a-f]{40}$/u.test(currentCommit.trim())) return null;
  if (!gitSucceeds(source, ["merge-base", "--is-ancestor", sourceCommit, currentCommit.trim()])) return null;

  // 接管来源也必须是当前稳定 checkout 的已提交字节，不能让脏工作树借旧 state
  // 获得覆盖行业文件的权限。
  for (const path of GOVERNANCE_FILES) {
    const sourcePath = safeFile(source, path, "基座 UI 治理文件");
    const currentBlob = gitOutput(source, ["show", `HEAD:${path}`], null);
    if (!Buffer.isBuffer(currentBlob) || !existsSync(sourcePath) || !readFileSync(sourcePath).equals(currentBlob)) return null;
  }

  const scopeBlob = gitOutput(source, ["show", `${sourceCommit}:sync/base-scope.json`], null);
  if (!Buffer.isBuffer(scopeBlob)) return null;
  let scope;
  try { scope = JSON.parse(scopeBlob.toString("utf8")); } catch { return null; }
  if (scope?.version !== LEGACY_SCOPE_VERSION) return null;

  const files = {};
  for (const path of GOVERNANCE_FILES) {
    if (!matchesAny(path, scope.include)
      || matchesAny(path, scope.exclude)
      || matchesAny(path, state.extraExclude)) return null;
    const oldBlob = gitOutput(source, ["show", `${sourceCommit}:${path}`], null);
    if (!Buffer.isBuffer(oldBlob)) return null;
    files[path] = { sha256: hash(oldBlob) };
  }
  return {
    sourceCommit,
    scopeSha256: hash(scopeBlob),
    files,
  };
}

/**
 * 把 verifier、其 AST 规则与固定解析器作为一个治理单元安装。已有 state 时先按
 * 旧指纹验真；首次接入只允许目标缺失或已与当前来源逐字节一致，绝不静默覆盖。
 */
function restore(path, backup) {
  if (!backup.exists) {
    const current = lstatMaybe(path);
    if (current && !current.isFile() && !current.isSymbolicLink()) throw new Error(`回滚拒绝移除非文件目标：${path}`);
    rmSync(path, { force: true });
    return;
  }
  const current = lstatMaybe(path);
  if (current && !current.isFile() && !current.isSymbolicLink()) throw new Error(`回滚目标不是普通文件：${path}`);
  if (current?.isSymbolicLink()) rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, backup.content);
  chmodSync(path, backup.mode);
}

export function installUiGovernance({ repo, sourceRoot, repositoryRoot = repo, dryRun = false, onWrite }) {
  const targetRoot = safeRoot(repo, "目标仓");
  const targetRepositoryRoot = safeRoot(repositoryRoot, "目标 Git 仓根");
  if (targetRoot !== targetRepositoryRoot && !targetRoot.startsWith(`${targetRepositoryRoot}${sep}`)) {
    throw new Error("目标仓必须位于目标 Git 仓根内");
  }
  const source = safeRoot(sourceRoot, "基座仓");
  const packagePath = safeFile(targetRoot, "package.json", "目标 package.json");
  if (!existsSync(packagePath)) throw new Error("目标仓缺少 package.json");
  const packageJson = readJson(packagePath, "目标 package.json");
  const dependency = packageJson.devDependencies?.["typescript-governance"]
    ?? packageJson.dependencies?.["typescript-governance"];
  if (dependency && dependency !== GOVERNANCE_TYPESCRIPT) {
    throw new Error(`typescript-governance 已由行业仓固定为 ${dependency}；拒绝静默覆盖为 ${GOVERNANCE_TYPESCRIPT}`);
  }
  const yamlDependency = packageJson.devDependencies?.["yaml-governance"]
    ?? packageJson.dependencies?.["yaml-governance"];
  if (yamlDependency && yamlDependency !== GOVERNANCE_YAML) {
    throw new Error(`yaml-governance 已由行业仓固定为 ${yamlDependency}；拒绝静默覆盖为 ${GOVERNANCE_YAML}`);
  }

  const statePath = safeFile(targetRoot, GOVERNANCE_STATE, "UI 治理 state");
  const previous = existsSync(statePath) ? readJson(statePath, GOVERNANCE_STATE) : null;
  if (previous && (previous.schemaVersion !== "workloom.ui-governance-state/v1"
    || previous.dependency !== GOVERNANCE_TYPESCRIPT
    || (previous.yamlDependency !== undefined && previous.yamlDependency !== GOVERNANCE_YAML)
    || previous.updatePolicy !== "stable-upgrade-pr-only"
    || GOVERNANCE_FILES.some((path) => !/^[0-9a-f]{64}$/u.test(previous.files?.[path]?.sha256 ?? "")))) {
    throw new Error(`${GOVERNANCE_STATE} 契约无效`);
  }

  let legacyProof = null;
  let legacyProofChecked = false;
  const files = {};
  const contents = new Map();
  for (const path of GOVERNANCE_FILES) {
    const sourcePath = safeFile(source, path, "基座 UI 治理文件");
    const targetPath = safeFile(targetRoot, path, "行业 UI 治理文件");
    if (!existsSync(sourcePath)) throw new Error(`基座缺少 ${path}`);
    const content = readFileSync(sourcePath);
    const sourceHash = hash(content);
    if (existsSync(targetPath)) {
      const targetHash = hash(readFileSync(targetPath));
      const expectedPrevious = previous?.files?.[path]?.sha256;
      if (!expectedPrevious && targetHash !== sourceHash && !legacyProofChecked) {
        legacyProof = legacyBaseSyncProof({
          targetRoot,
          repositoryRoot: targetRepositoryRoot,
          source,
        });
        legacyProofChecked = true;
      }
      const expectedLegacy = legacyProof?.files?.[path]?.sha256;
      if (expectedPrevious
        ? targetHash !== expectedPrevious
        : targetHash !== sourceHash && targetHash !== expectedLegacy) {
        throw new Error(`${path} 已被行业仓定制；拒绝静默覆盖`);
      }
    } else if (previous?.files?.[path]) {
      throw new Error(`${path} 在上次治理安装后被删除；拒绝静默补写`);
    }
    files[path] = { sha256: sourceHash };
    contents.set(targetPath, content);
  }

  packageJson.devDependencies ??= {};
  if (!dependency) packageJson.devDependencies["typescript-governance"] = GOVERNANCE_TYPESCRIPT;
  if (!yamlDependency) packageJson.devDependencies["yaml-governance"] = GOVERNANCE_YAML;
  const state = {
    schemaVersion: "workloom.ui-governance-state/v1",
    dependency: GOVERNANCE_TYPESCRIPT,
    yamlDependency: GOVERNANCE_YAML,
    updatePolicy: "stable-upgrade-pr-only",
    files,
    ...(legacyProof ? {
      legacyTakeover: {
        sourceCommit: legacyProof.sourceCommit,
        scopeVersion: LEGACY_SCOPE_VERSION,
        scopeSha256: legacyProof.scopeSha256,
        files: legacyProof.files,
      },
    } : {}),
  };
  if (!dryRun) {
    const writePlan = [
      [packagePath, Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`)],
      ...contents,
      [statePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`)],
    ];
    const backups = new Map(writePlan.map(([path]) => [path, existsSync(path)
      ? { exists: true, content: readFileSync(path), mode: lstatSync(path).mode & 0o777 }
      : { exists: false }]));
    try {
      for (const [path, content] of writePlan) {
        mkdirSync(dirname(path), { recursive: true });
        safeFile(targetRoot, relative(targetRoot, path).split(sep).join("/"), "UI 治理写入目标");
        writeFileSync(path, content);
        onWrite?.(relative(targetRoot, path).split(sep).join("/"));
      }
    } catch (error) {
      for (const [path, backup] of [...backups.entries()].reverse()) restore(path, backup);
      throw error;
    }
  }
  return {
    files: GOVERNANCE_FILES,
    dependency: GOVERNANCE_TYPESCRIPT,
    yamlDependency: GOVERNANCE_YAML,
    legacyTakeover: Boolean(legacyProof),
    changed: !dryRun,
  };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : "";
  };
  const repo = value("--repo");
  const sourceRoot = value("--source-root");
  const repositoryRoot = value("--repository-root") || repo;
  if (!repo || !sourceRoot) throw new Error("用法：node sync/install-ui-governance.mjs --repo <行业目录> --repository-root <Git 仓根> --source-root <基座目录> [--dry-run]");
  const result = installUiGovernance({ repo, repositoryRoot, sourceRoot, dryRun: args.includes("--dry-run") });
  process.stdout.write(`✅ UI 治理单元已${args.includes("--dry-run") ? "预检" : "安装"}：${result.files.join("、")}；${result.dependency}；${result.yamlDependency}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
