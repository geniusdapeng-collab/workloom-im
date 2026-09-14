#!/usr/bin/env node
/**
 * 为现有行业仓创建 @workloom/ui 稳定版本升级 PR。
 *
 * 该脚本永不直接更新 main。它在临时克隆中锁定精确版本、刷新 lockfile、运行
 * 基础门禁并推送独立分支，然后通过 GitHub API 创建 PR。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUiVersion, setUiVersion } from "./set-ui-version.mjs";

const syncDir = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(syncDir, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const validateOnly = args.includes("--validate-only");
const requestedVersion = args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined;

function run(command, commandArgs, cwd, env = {}) {
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

function authenticatedUrl(repo, token) {
  return token
    ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

async function createPullRequest({ repo, token, branch, version }) {
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `chore(ui): 升级 WorkLoom 三端基座至 ${version}`,
      head: branch,
      base: "main",
      body: [
        "此 PR 由 WorkLoom IM 基座稳定版本发布流程创建。",
        "",
        `- 共享 UI：\`@workloom/ui@${version}\``,
        "- 更新范围：B端PC、B端移动、C端移动中实际存在的客户端",
        "- 行业差异：保留 Bundle、主题白名单、投影和本地业务依赖",
        "- 合并条件：本仓三端构建、共享契约、租户负向测试和视觉回归全部通过",
        "",
        "禁止把此 PR 改造成公共 UI 源码复制。",
      ].join("\n"),
    }),
  });
  if (response.ok) return response.json();
  const detail = await response.text();
  // 422 通常代表相同 head/base 的 PR 已存在；保持幂等并交给现有 PR 继续验证。
  if (response.status === 422 && detail.includes("already exists")) return { html_url: "已存在" };
  throw new Error(`创建 PR 失败 ${response.status}: ${detail.slice(0, 500)}`);
}

export function validateRelease(manifest, packageJson, version) {
  if (!manifest.ui.latestStableVersion) throw new Error("base-capabilities.json 尚未登记 latestStableVersion");
  if (manifest.ui.latestStableVersion !== version) throw new Error(`稳定清单版本 ${manifest.ui.latestStableVersion} 与目标版本 ${version} 不一致`);
  if (packageJson.version !== version) throw new Error(`@workloom/ui 包版本 ${packageJson.version} 与目标版本 ${version} 不一致`);
  return true;
}

async function upgradeChild(child, manifest, version, token) {
  const temp = mkdtempSync(join(tmpdir(), "workloom-ui-upgrade-"));
  const branch = `chore/workloom-ui-v${version}`;
  try {
    run("git", ["clone", "--depth", "1", authenticatedUrl(child.repo, token), temp]);
    run("git", ["switch", "-c", branch], temp);
    const touched = setUiVersion({
      repo: temp,
      prefix: child.pathPrefix?.replace(/\/$/, "") ?? "",
      version,
      manifest,
    });
    const workdir = child.pathPrefix ? join(temp, child.pathPrefix.replace(/\/$/, "")) : temp;
    mkdirSync(join(temp, ".github/workflows"), { recursive: true });
    mkdirSync(join(workdir, "scripts"), { recursive: true });
    const repoDir = child.pathPrefix ? child.pathPrefix.replace(/\/$/, "") : ".";
    const workflow = readFileSync(join(syncDir, "ui-consumer-template.yml"), "utf8").replaceAll("__REPO_DIR__", repoDir);
    writeFileSync(join(temp, ".github/workflows/workloom-ui-contract.yml"), workflow);
    // 门禁脚本属于消费契约，不是可分叉的 UI 源码；随升级 PR 一并落到行业仓，
    // 确保后续每次 PR/主分支构建都能独立执行，不依赖基座仓文件路径。
    copyFileSync(join(baseDir, "scripts/verify-ui-consumer.mjs"), join(workdir, "scripts/verify-ui-consumer.mjs"));
    run("pnpm", ["install", "--lockfile-only"], workdir);
    run("node", [join(baseDir, "scripts/verify-ui-consumer.mjs"), "--repo", workdir], baseDir);
    const status = run("git", ["status", "--porcelain"], temp);
    if (!status) return { repo: child.repo, status: "already-current", touched };
    if (dryRun) return { repo: child.repo, status: "planned", touched };
    run("git", ["add", "-A"], temp);
    run("git", ["-c", "user.name=WorkLoom UI Release", "-c", "user.email=ui-release@workloom.im", "commit", "-m", `chore(ui): 升级三端基座至 ${version}`], temp);
    run("git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`], temp);
    const pull = await createPullRequest({ repo: child.repo, token, branch, version });
    return { repo: child.repo, status: "pr-opened", url: pull.html_url, touched };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(syncDir, "base-capabilities.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(baseDir, "packages/ui/package.json"), "utf8"));
  const children = JSON.parse(readFileSync(join(syncDir, "child-repos.json"), "utf8")).children;
  if (validateOnly) {
    const version = requestedVersion ?? manifest.ui.candidateVersion;
    if (packageJson.version !== version) throw new Error(`候选清单 ${version} 与包版本 ${packageJson.version} 不一致`);
    console.log(JSON.stringify({ version, validateOnly: true, repositories: children.map((child) => child.repo) }, null, 2));
    return;
  }
  const version = resolveUiVersion(manifest, requestedVersion);
  validateRelease(manifest, packageJson, version);
  const token = process.env.SYNC_TOKEN || process.env.GH_TOKEN || "";
  if (!dryRun && !token) throw new Error("缺少 SYNC_TOKEN/GH_TOKEN；拒绝创建无法审计的半成品分支");
  const results = [];
  for (const child of children) {
    try {
      results.push(await upgradeChild(child, manifest, version, token));
    } catch (error) {
      results.push({ repo: child.repo, status: "failed", error: String(error?.message ?? error).slice(0, 500) });
    }
  }
  console.log(JSON.stringify({ version, dryRun, results }, null, 2));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
