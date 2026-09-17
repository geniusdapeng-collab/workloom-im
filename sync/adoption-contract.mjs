#!/usr/bin/env node
/**
 * 新行业接入工程契约门禁（Node >= 20，零第三方依赖）。
 *
 * preflight 只检查 base-sync 不会创建/覆盖的行业自有根资产；post 还验证完整
 * 公共基座 state、三端稳定基座、共享 UI 状态和消费 CI 所需脚本均已落盘。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_PACKAGES = Object.freeze([
  "apps/web/package.json",
  "apps/webb/package.json",
  "apps/webc/package.json",
]);
const POST_FILES = Object.freeze([
  ".workloom-ui.json",
  ".workloom-client-foundation.json",
  ".workloom-ui-governance.json",
  "scripts/verify-ui-consumer.mjs",
  "scripts/ui-governance-rules.mjs",
  "scripts/verify-client-foundation-consumer.mjs",
  "scripts/verify-production-client-boundary.mjs",
  "scripts/verify-product-content.mjs",
  "scripts/bundle-governance.mts",
]);
const GOVERNANCE_TYPESCRIPT = "npm:typescript@5.9.3";
const GOVERNANCE_YAML = "npm:yaml@2.9.0";
const GOVERNANCE_FILES = Object.freeze([
  "scripts/verify-ui-consumer.mjs",
  "scripts/ui-governance-rules.mjs",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function readJson(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`缺少 ${label}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(`${label} 不是有效 JSON`);
    return null;
  }
}

function safeTarget(root, path, label) {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`${label} 逃逸出 Git 工作树`);
  let cursor = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} 不允许 symlink`);
  }
  return target;
}

function hasWorkspaceEntry(content, entry) {
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s*["']?${escaped}["']?\\s*$`, "mu").test(content);
}

function findNodeModules(workdir) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (entry.name === "node_modules") {
        found.push(relative(workdir, absolute).split(sep).join("/") || "node_modules");
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(absolute);
    }
  };
  walk(workdir);
  return found.sort();
}

export function verifyAdoptionContract({ repoRoot, workdir, mode = "preflight" }) {
  if (!["preflight", "post"].includes(mode)) throw new Error(`未知接入契约阶段：${mode}`);
  const root = realpathSync(resolve(repoRoot));
  const target = safeTarget(root, resolve(workdir), "行业基座目录");
  if (!existsSync(target) || !lstatSync(target).isDirectory()) throw new Error("行业基座目录不存在");
  const errors = [];

  if (mode === "preflight") {
    const dependencyTrees = findNodeModules(target);
    if (dependencyTrees.length) {
      errors.push(`新行业接入要求无既有依赖树；请先移除 ${dependencyTrees.join("、")}`);
    }
  }

  const product = readJson(join(root, "product.manifest.json"), "product.manifest.json", errors);
  const packageJson = readJson(join(target, "package.json"), `${relative(root, target) || "."}/package.json`, errors);
  if (packageJson) {
    if (packageJson.packageManager !== "pnpm@10.14.0") errors.push("packageManager 必须精确固定为 pnpm@10.14.0");
    if (!packageJson.scripts?.test) errors.push("package.json 缺少可执行 test 脚本");
    if (!String(packageJson.scripts?.["product:verify"] ?? "").includes("scripts/verify-product-content.mjs")) {
      errors.push("package.json 缺少 product:verify → scripts/verify-product-content.mjs");
    }
    if (!String(packageJson.scripts?.["bundle:governance"] ?? "").includes("scripts/bundle-governance.mts")) {
      errors.push("package.json 缺少 bundle:governance → scripts/bundle-governance.mts");
    }
    if (!(packageJson.dependencies?.tsx || packageJson.devDependencies?.tsx)) errors.push("package.json 缺少固定的 tsx 执行器依赖");
    const governanceTypescript = packageJson.devDependencies?.["typescript-governance"]
      ?? packageJson.dependencies?.["typescript-governance"];
    if (governanceTypescript && governanceTypescript !== GOVERNANCE_TYPESCRIPT) {
      errors.push(`typescript-governance 已固定为 ${governanceTypescript}，接入程序不得静默覆盖`);
    }
    if (mode === "post" && governanceTypescript !== GOVERNANCE_TYPESCRIPT) {
      errors.push(`package.json 必须精确依赖 typescript-governance=${GOVERNANCE_TYPESCRIPT}`);
    }
  }

  const workspacePath = join(target, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) errors.push("缺少 pnpm-workspace.yaml");
  else {
    const workspace = readFileSync(workspacePath, "utf8");
    if (!hasWorkspaceEntry(workspace, "apps/*") || !hasWorkspaceEntry(workspace, "packages/*")) {
      errors.push("pnpm-workspace.yaml 必须覆盖 apps/* 与 packages/*");
    }
    if (!/onlyBuiltDependencies\s*:/u.test(workspace) || !hasWorkspaceEntry(workspace, "node-pty")) {
      errors.push("pnpm-workspace.yaml 必须在 onlyBuiltDependencies 登记 node-pty");
    }
  }
  if (!existsSync(join(target, "pnpm-lock.yaml"))) errors.push("缺少 pnpm-lock.yaml，消费 CI 无法 frozen-lockfile 安装");

  const defaultBundle = typeof product?.defaultBundle === "string" ? product.defaultBundle.trim() : "";
  if (!defaultBundle || defaultBundle.includes("/") || defaultBundle.includes("\\") || defaultBundle === "." || defaultBundle === "..") {
    errors.push("product.manifest.json 缺少安全的 defaultBundle");
  } else if (!existsSync(join(target, "bundles", defaultBundle, "bundle.json"))) {
    errors.push(`缺少默认行业包 bundles/${defaultBundle}/bundle.json`);
  }

  if (mode === "post") {
    const state = readJson(join(root, ".workloom-base-sync.json"), ".workloom-base-sync.json", errors);
    const expectedPrefix = relative(root, target).split(sep).join("/") || ".";
    if (state && (state.lastSyncMode !== "full" || !/^[0-9a-f]{40}$/.test(state.lastSyncedBaseSha ?? "") || state.pathPrefix !== expectedPrefix)) {
      errors.push("base-sync state 未证明当前行业目录完成 full 同步");
    }
    for (const path of POST_FILES) if (!existsSync(join(target, path))) errors.push(`完整接入缺少 ${path}`);
    const governanceState = readJson(join(target, ".workloom-ui-governance.json"), ".workloom-ui-governance.json", errors);
    if (governanceState && (governanceState.schemaVersion !== "workloom.ui-governance-state/v1"
      || governanceState.dependency !== GOVERNANCE_TYPESCRIPT
      || governanceState.yamlDependency !== GOVERNANCE_YAML
      || governanceState.updatePolicy !== "stable-upgrade-pr-only"
      || !governanceState.files?.["scripts/verify-ui-consumer.mjs"]?.sha256
      || !governanceState.files?.["scripts/ui-governance-rules.mjs"]?.sha256)) {
      errors.push(".workloom-ui-governance.json 未证明 verifier、AST 规则与固定解析器原子安装");
    }
    if (governanceState) {
      for (const path of GOVERNANCE_FILES) {
        const absolute = join(target, path);
        const expected = governanceState.files?.[path]?.sha256 ?? "";
        if (existsSync(absolute) && (!/^[0-9a-f]{64}$/u.test(expected)
          || sha256(readFileSync(absolute)) !== expected)) {
          errors.push(`${path} 与 .workloom-ui-governance.json 指纹不一致`);
        }
      }
    }
    const lockSource = existsSync(workspacePath) && existsSync(join(target, "pnpm-lock.yaml"))
      ? readFileSync(join(target, "pnpm-lock.yaml"), "utf8") : "";
    if (!lockSource.includes("typescript-governance")) errors.push("pnpm-lock.yaml 未锁定 typescript-governance");
    if (!lockSource.includes("yaml-governance")) errors.push("pnpm-lock.yaml 未锁定 yaml-governance");
    if (!existsSync(join(root, ".github/workflows/workloom-ui-contract.yml"))) {
      errors.push("完整接入缺少 .github/workflows/workloom-ui-contract.yml");
    }
    const uiState = readJson(join(target, ".workloom-ui.json"), ".workloom-ui.json", errors);
    for (const packagePath of CLIENT_PACKAGES) {
      const clientPackage = readJson(join(target, packagePath), packagePath, errors);
      if (clientPackage && (!clientPackage.scripts?.typecheck || !clientPackage.scripts?.build)) {
        errors.push(`${packagePath} 必须提供 typecheck 与 build`);
      }
      if (packagePath === "apps/web/package.json" && clientPackage && !clientPackage.scripts?.["test:consumer"]) {
        errors.push("apps/web/package.json 缺少 test:consumer 浏览器验收入口");
      }
      if (uiState) {
        if (!(uiState.requiredClientPackages ?? []).includes(packagePath)
          || !(uiState.connectedClientPackages ?? []).includes(packagePath)) {
          errors.push(`.workloom-ui.json 未完整登记 ${packagePath}`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : "";
  };
  const requestedRepo = value("--repo");
  const requestedWorkdir = value("--workdir");
  if (!["preflight", "post"].includes(mode) || !requestedRepo || !requestedWorkdir) {
    throw new Error("用法：node sync/adoption-contract.mjs preflight|post --repo <Git根> --workdir <行业基座目录>");
  }
  const repo = realpathSync(resolve(requestedRepo));
  const gitRoot = realpathSync(resolve(execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()));
  if (repo !== gitRoot) throw new Error("--repo 必须指向 Git 根目录");
  const errors = verifyAdoptionContract({ repoRoot: repo, workdir: requestedWorkdir, mode });
  if (errors.length) {
    process.stderr.write(`❌ 新行业${mode === "preflight" ? "接入前置" : "完整性"}契约失败（${errors.length} 项）\n`);
    for (const error of errors) process.stderr.write(`  · ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✅ 新行业${mode === "preflight" ? "前置工程" : "完整接入"}契约已验真\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
