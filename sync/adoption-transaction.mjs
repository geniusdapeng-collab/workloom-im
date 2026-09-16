#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ADOPTION_SCRIPTS, ADOPTION_WORKFLOW } from "./install-adoption-assets.mjs";
import { GOVERNANCE_FILES, GOVERNANCE_STATE } from "./install-ui-governance.mjs";

const MANIFEST = "manifest.json";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
}

function safeRelative(path, label) {
  if (
    typeof path !== "string" || !path || path.includes("\\") || /[\0\r\n]/u.test(path) ||
    path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`${label} 不是安全的仓库相对路径`);
  return path;
}

function safePath(root, path, label, allowLeafSymlink = false) {
  const relativePath = safeRelative(path, label);
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`${label} 逃逸出 Git 工作树`);
  let cursor = root;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (!existsSync(cursor) && !lstatMaybe(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() && !(allowLeafSymlink && index === parts.length - 1)) {
      throw new Error(`${label} 的父路径不允许 symlink：${relativePath}`);
    }
  }
  return target;
}

function lstatMaybe(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function repositoryRoot(requested) {
  const lexical = resolve(requested);
  const stat = lstatMaybe(lexical);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("事务目标必须是非 symlink 的 Git 目录");
  const root = realpathSync(resolve(git(lexical, "rev-parse", "--show-toplevel").trim()));
  if (root !== realpathSync(lexical)) throw new Error("事务目标必须是 Git 工作树根目录");
  return root;
}

function visiblePaths(root) {
  return git(root, "ls-files", "-co", "--exclude-standard", "-z")
    .split("\0").filter(Boolean).map((path) => safeRelative(path, "Git 路径")).sort();
}

function protectedRelative(path, label) {
  const value = safeRelative(path, label);
  const parts = value.split("/");
  if (parts.includes(".git") || parts.includes("node_modules")) {
    throw new Error(`${label} 不得包含 .git 或 node_modules`);
  }
  return value;
}

function workdirRelative(root, workdir, path, label) {
  const prefix = relative(root, workdir).split(sep).join("/");
  return protectedRelative(prefix ? `${prefix}/${safeRelative(path, label)}` : path, label);
}

function jsonCommand(root, args, label) {
  let raw;
  try {
    raw = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    throw new Error(`${label} 失败：${detail}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} 未返回有效 JSON`);
  }
}

function reportRootPath(path, label) {
  if (typeof path !== "string" || !path.startsWith("root:")) {
    throw new Error(`${label} 缺少 root: 边界`);
  }
  return protectedRelative(path.slice("root:".length).split("#", 1)[0], label);
}

/**
 * 从已通过的两个 dry-run 计划推导跨阶段可写文件。只快照这些
 * 精确目标中被 Git ignore 的旧值，不会把 .env、dist 或其他与接入无关的
 * ignored 资产复制到临时目录。
 */
export function planAdoptionProtectedPaths({ repo, workdir = repo, baseDir, version = "" }) {
  const root = repositoryRoot(repo);
  const target = realpathSync(resolve(workdir));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("事务工作目录逃逸出 Git 工作树");
  const base = repositoryRoot(baseDir);
  const syncDir = join(base, "sync");
  const prefix = relative(root, target).split(sep).join("/");
  const baseReport = jsonCommand(root, [
    join(syncDir, "base-sync.mjs"), "pull",
    "--repo", target,
    "--base-dir", base,
    "--no-commit", "--adopt", "--dry-run", "--json",
  ], "接入事务基座计划");
  const foundationArgs = [
    join(syncDir, "client-foundation.mjs"), "scaffold",
    "--repo", root,
    "--base-dir", base,
    "--dry-run", "--json",
  ];
  if (prefix) foundationArgs.push("--path-prefix", prefix);
  if (version) foundationArgs.push("--version", version);
  const foundationReport = jsonCommand(root, foundationArgs, "接入事务三端计划");
  if (baseReport?.mode !== "pull" || baseReport.dryRun !== true || baseReport.child !== target) {
    throw new Error("接入事务基座 dry-run 计划边界无效");
  }
  if (foundationReport?.schemaVersion !== "workloom.client-foundation-plan/v1"
    || foundationReport.dryRun !== true
    || foundationReport.targetRoot !== (prefix || ".")
    || !Array.isArray(foundationReport.operations)) {
    throw new Error("接入事务三端 dry-run 计划边界无效");
  }

  const paths = new Set();
  const addRoot = (path, label) => paths.add(protectedRelative(path, label));
  const addWorkdir = (path, label) => paths.add(workdirRelative(root, target, path, label));
  for (const path of baseReport.copied ?? []) {
    if (path.startsWith("root:")) addRoot(path.slice("root:".length), "基座复制目标");
    else addWorkdir(path, "基座复制目标");
  }
  for (const path of baseReport.merged ?? []) addWorkdir(path, "基座合并目标");
  for (const path of baseReport.managed ?? []) addRoot(reportRootPath(path, "基座受控目标"), "基座受控目标");
  for (const path of baseReport.adopted ?? []) addRoot(reportRootPath(path, "基座迁移目标"), "基座迁移目标");
  for (const operation of foundationReport.operations) addWorkdir(operation?.path, "三端基座目标");

  let capabilities;
  let scope;
  try {
    capabilities = JSON.parse(readFileSync(join(syncDir, "base-capabilities.json"), "utf8"));
    scope = JSON.parse(readFileSync(join(syncDir, "base-scope.json"), "utf8"));
  } catch {
    throw new Error("接入事务无法读取基座能力/范围清单");
  }
  addRoot(".workloom-base-sync.json", "基座 state");
  addWorkdir(".workloom-base-sync.json", "legacy 基座 state");
  addRoot(ADOPTION_WORKFLOW, "消费工作流");
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    ".workloom-runtime-deps/package.json",
    ".workloom-runtime-deps/package-lock.json",
    ".workloom-runtime-deps/metadata.json",
    ".workloom-ui.json",
    capabilities?.clientFoundation?.stateFile,
    scope?.uiGovernanceCapability?.stateFile,
    GOVERNANCE_STATE,
    ...(capabilities?.ui?.requiredClientPackages ?? []),
    ...(scope?.uiGovernanceCapability?.managedFiles ?? []),
    ...GOVERNANCE_FILES,
    ...ADOPTION_SCRIPTS,
  ].filter(Boolean)) addWorkdir(path, "接入固定写目标");
  addRoot("pnpm-lock.yaml", "根级 lockfile");
  return [...paths].sort();
}

function status(root) {
  return git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
}

function indexPath(root) {
  const raw = git(root, "rev-parse", "--git-path", "index").trim();
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

function nodeModulesDirectories(workdir) {
  const directories = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (entry.name === "node_modules") {
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`新行业依赖目录类型异常：${relative(workdir, absolute).split(sep).join("/")}`);
        }
        directories.push(absolute);
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(absolute);
    }
  };
  walk(workdir);
  return directories.sort((left, right) => right.length - left.length);
}

export function beginAdoptionTransaction(repo, workdir = repo, protectedPaths = []) {
  const root = repositoryRoot(repo);
  const target = realpathSync(resolve(workdir));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("事务工作目录逃逸出 Git 工作树");
  if (!Array.isArray(protectedPaths)) throw new Error("事务保护路径必须是数组");
  const paths = [...new Set([
    ...visiblePaths(root),
    ...protectedPaths.map((path) => protectedRelative(path, "事务保护路径")),
  ])].sort();
  const existingModules = nodeModulesDirectories(target);
  if (existingModules.length) {
    throw new Error(`新行业接入要求无既有 node_modules；请先移除：${existingModules.map((path) => relative(target, path).split(sep).join("/")).join("、")}`);
  }
  const transaction = mkdtempSync(join(tmpdir(), "workloom-adopt-transaction-"));
  chmodSync(transaction, 0o700);
  mkdirSync(join(transaction, "files"), { mode: 0o700 });
  const entries = [];
  try {
    for (const [index, path] of paths.entries()) {
      const absolute = safePath(root, path, `事务快照 ${path}`, true);
      const stat = lstatMaybe(absolute);
      if (!stat) {
        entries.push({ path, type: "missing" });
      } else if (stat.isFile()) {
        const snapshot = join(transaction, "files", String(index));
        copyFileSync(absolute, snapshot);
        chmodSync(snapshot, 0o600);
        entries.push({ path, type: "file", snapshot: `files/${index}`, mode: stat.mode & 0o777 });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path, type: "symlink", target: readlinkSync(absolute) });
      } else {
        throw new Error(`事务拒绝不受支持的 Git 路径类型：${path}`);
      }
    }
    const index = indexPath(root);
    const indexExists = existsSync(index);
    if (indexExists) {
      copyFileSync(index, join(transaction, "index"));
      chmodSync(join(transaction, "index"), 0o600);
    }
    writeFileSync(join(transaction, MANIFEST), JSON.stringify({
      schemaVersion: "workloom.adoption-transaction/v1",
      root,
      status: status(root),
      index,
      indexExists,
      workdir: target,
      protectedPaths: protectedPaths.map((path) => protectedRelative(path, "事务保护路径")),
      entries,
    }), { mode: 0o600 });
    return transaction;
  } catch (error) {
    rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
}

function loadTransaction(transaction) {
  const directory = realpathSync(resolve(transaction));
  if (!lstatSync(directory).isDirectory() || !directory.startsWith(`${realpathSync(tmpdir())}${sep}`)) {
    throw new Error("非法接入事务目录");
  }
  const manifest = JSON.parse(readFileSync(join(directory, MANIFEST), "utf8"));
  if (manifest?.schemaVersion !== "workloom.adoption-transaction/v1" || !Array.isArray(manifest.entries)) {
    throw new Error("接入事务清单无效");
  }
  const root = repositoryRoot(manifest.root);
  return { directory, manifest, root };
}

function removeLeaf(root, path, label) {
  const absolute = safePath(root, path, label, true);
  const stat = lstatMaybe(absolute);
  if (!stat) return;
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${label} 拒绝递归移除目录：${path}`);
  rmSync(absolute, { force: true });
}

export function rollbackAdoptionTransaction(transaction) {
  const { directory, manifest, root } = loadTransaction(transaction);
  const before = new Map(manifest.entries.map((entry) => [safeRelative(entry.path, "事务清单路径"), entry]));
  for (const path of visiblePaths(root).reverse()) {
    if (!before.has(path)) removeLeaf(root, path, "事务回滚新增文件");
  }
  for (const entry of [...before.values()].reverse()) {
    const absolute = safePath(root, entry.path, `事务回滚 ${entry.path}`, true);
    if (entry.type === "missing") {
      removeLeaf(root, entry.path, "事务回滚原缺失文件");
      continue;
    }
    const current = lstatMaybe(absolute);
    if (current && !current.isFile() && !current.isSymbolicLink()) {
      throw new Error(`事务回滚目标变成目录，拒绝破坏性覆盖：${entry.path}`);
    }
    if (current) rmSync(absolute, { force: true });
    const parentRelative = relative(root, dirname(absolute)).split(sep).join("/");
    if (parentRelative) safePath(root, parentRelative, `事务回滚父目录 ${entry.path}`);
    mkdirSync(dirname(absolute), { recursive: true });
    if (entry.type === "file") {
      copyFileSync(join(directory, safeRelative(entry.snapshot, "事务快照文件")), absolute);
      chmodSync(absolute, entry.mode);
    } else if (entry.type === "symlink") {
      symlinkSync(entry.target, absolute);
    } else {
      throw new Error(`未知事务条目类型：${entry.type}`);
    }
  }
  const currentIndex = indexPath(root);
  if (manifest.index !== currentIndex) throw new Error("事务 index 路径与当前 Git 工作树不一致");
  if (manifest.indexExists) copyFileSync(join(directory, "index"), currentIndex);
  else rmSync(currentIndex, { force: true });
  if (manifest.workdir) {
    const expectedWorkdir = realpathSync(resolve(manifest.workdir));
    if (expectedWorkdir !== root && !expectedWorkdir.startsWith(`${root}${sep}`)) throw new Error("事务工作目录逃逸");
    for (const modulesPath of nodeModulesDirectories(expectedWorkdir)) {
      rmSync(modulesPath, { recursive: true, force: true });
    }
  }

  if (status(root) !== manifest.status) throw new Error("事务回滚后 Git 工作树/index 未恢复到接入前状态");
  rmSync(directory, { recursive: true, force: true });
}

export function commitAdoptionTransaction(transaction) {
  const { directory } = loadTransaction(transaction);
  rmSync(directory, { recursive: true, force: true });
}

function main() {
  const [mode, value, ...rest] = process.argv.slice(2);
  if (mode === "begin" && value) {
    const args = [...rest];
    const workdir = args[0] && !args[0].startsWith("--") ? args.shift() : value;
    const option = (name) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : "";
    };
    const baseDir = option("--base-dir");
    const protectedPaths = baseDir
      ? planAdoptionProtectedPaths({ repo: value, workdir, baseDir, version: option("--version") })
      : [];
    process.stdout.write(`${beginAdoptionTransaction(value, workdir, protectedPaths)}\n`);
  }
  else if (mode === "rollback" && value) rollbackAdoptionTransaction(value);
  else if (mode === "commit" && value) commitAdoptionTransaction(value);
  else throw new Error("用法：node sync/adoption-transaction.mjs begin <repo> [workdir] [--base-dir <base> --version <semver>] | rollback|commit <transaction-dir>");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
