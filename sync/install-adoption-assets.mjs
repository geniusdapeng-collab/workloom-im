#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ADOPTION_SCRIPTS = Object.freeze([
  "scripts/verify-client-foundation-consumer.mjs",
  "scripts/verify-production-client-boundary.mjs",
]);
export const ADOPTION_WORKFLOW = ".github/workflows/workloom-ui-contract.yml";

function root(path, label) {
  const value = realpathSync(resolve(path));
  if (!lstatSync(value).isDirectory()) throw new Error(`${label} 不是目录`);
  return value;
}

function safeFile(base, relativePath, label) {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} 路径非法`);
  }
  const target = resolve(base, relativePath);
  if (!target.startsWith(`${base}${sep}`)) throw new Error(`${label} 路径逃逸`);
  let cursor = base;
  for (const part of relativePath.split("/")) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} 不允许 symlink：${relativePath}`);
  }
  return target;
}

function restore(path, backup) {
  if (!backup.exists) {
    const stat = existsSync(path) ? lstatSync(path) : null;
    if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`回滚拒绝移除非文件目标：${path}`);
    rmSync(path, { force: true });
    return;
  }
  const stat = existsSync(path) ? lstatSync(path) : null;
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`回滚目标不是文件：${path}`);
  if (stat) rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, backup.content);
  chmodSync(path, backup.mode);
}

export function installAdoptionAssets({ repoRoot, workdir, sourceRoot, templatePath, dryRun = false, onWrite }) {
  const repo = root(repoRoot, "目标 Git 根");
  const target = root(workdir, "目标行业目录");
  if (target !== repo && !target.startsWith(`${repo}${sep}`)) throw new Error("目标行业目录逃逸出 Git 根");
  const source = root(sourceRoot, "基座仓");
  const prefix = relative(repo, target).split(sep).join("/") || ".";
  const writes = [];
  for (const path of ADOPTION_SCRIPTS) {
    const from = safeFile(source, path, "基座接入脚本");
    const to = safeFile(target, path, "行业接入脚本");
    if (!existsSync(from) || !lstatSync(from).isFile()) throw new Error(`基座缺少 ${path}`);
    const content = readFileSync(from);
    if (existsSync(to) && !readFileSync(to).equals(content)) throw new Error(`${path} 已存在不同内容，拒绝覆盖`);
    writes.push([to, content]);
  }
  const templateRelative = relative(resolve(sourceRoot), resolve(templatePath)).split(sep).join("/");
  const template = safeFile(source, templateRelative, "消费工作流模板");
  if (!existsSync(template) || !lstatSync(template).isFile()) {
    throw new Error("消费工作流模板无效或为 symlink");
  }
  const workflow = safeFile(repo, ADOPTION_WORKFLOW, "行业消费工作流");
  const workflowContent = Buffer.from(readFileSync(template, "utf8").replaceAll("__REPO_DIR__", prefix));
  if (existsSync(workflow) && !readFileSync(workflow).equals(workflowContent)) {
    throw new Error(`${ADOPTION_WORKFLOW} 已存在不同内容，拒绝覆盖`);
  }
  writes.push([workflow, workflowContent]);
  if (dryRun) return { prefix, files: [...ADOPTION_SCRIPTS, ADOPTION_WORKFLOW], written: false };

  const backups = new Map(writes.map(([path]) => [path, existsSync(path)
    ? { exists: true, content: readFileSync(path), mode: lstatSync(path).mode & 0o777 }
    : { exists: false }]));
  try {
    for (const [path, content] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      const base = path === workflow ? repo : target;
      safeFile(base, relative(base, path).split(sep).join("/"), "接入资产写入目标");
      writeFileSync(path, content);
      onWrite?.(relative(repo, path).split(sep).join("/"));
    }
  } catch (error) {
    for (const [path, backup] of [...backups.entries()].reverse()) restore(path, backup);
    throw error;
  }
  return { prefix, files: [...ADOPTION_SCRIPTS, ADOPTION_WORKFLOW], written: true };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
  const repoRoot = value("--repo");
  const workdir = value("--workdir");
  const sourceRoot = value("--source-root");
  const templatePath = value("--template");
  if (!repoRoot || !workdir || !sourceRoot || !templatePath) {
    throw new Error("用法：node sync/install-adoption-assets.mjs --repo <Git根> --workdir <行业目录> --source-root <基座> --template <工作流模板> [--dry-run]");
  }
  installAdoptionAssets({ repoRoot, workdir, sourceRoot, templatePath, dryRun: args.includes("--dry-run") });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
