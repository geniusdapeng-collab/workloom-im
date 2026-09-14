#!/usr/bin/env node
/**
 * WorkLoom IM · 基座能力可审计升级引擎（base-sync）
 *
 * 三种模式：
 *   node base-sync.mjs detect --repo <子仓路径>            心跳检测：子仓基座落后则报告并退出码 2（CI 红=提醒）
 *   node base-sync.mjs pull   --repo <子仓路径> [--push]   子仓拉齐：按 scope 复制基座文件；--push 仅创建升级 PR
 *   node base-sync.mjs push   --base <基座路径>            父仓下发：对 child-repos.json 全部子仓创建升级 PR
 *
 * 通用参数：
 *   --base-dir <path>     基座本地路径（默认：临时 clone 基座 main）
 *   --base-url <prefix>   git 远端前缀覆盖（沙箱/镜像环境用，默认 https://github.com）
 *   --dry-run             只输出计划，不落盘、不提交、不推分支、不创建 PR
 *   --json                机器可读报告输出
 *
 * 设计纪律：
 *   ① 同步范围唯一事实源 = sync/base-scope.json（include/exclude/anchorMerge/appendOnlyDirs/pollutionGuard）；
 *   ② 行业属性与演示能力永不同步（exclude + 推送前黑名单硬校验双保险）；
 *   ③ 迁移目录 append-only（子仓已有同名迁移内容不同→跳过并告警，绝不覆盖）；
 *   ④ 锚点合并文件（package.json/tsconfig.json）按策略合并，保留子仓独有条目；
 *   ⑤ 远程写入只允许发生在基座 ci-gate 成功且 SHA 精确匹配之后，并且永不直推 main；
 *   ⑥ 无外部依赖（Node ≥20 原生 ESM），CI 与本地均可直接执行。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------------- 参数解析 ---------------- */
const args = process.argv.slice(2);
const MODE = args[0];
const opt = (name, dft = "") => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dft; };
const has = (name) => args.includes(name);
const REPO = opt("--repo");
const BASE_DIR_OPT = opt("--base-dir");
const BASE_URL = opt("--base-url", "https://github.com");
const REQUESTED_DRY = has("--dry-run");
const AS_JSON = has("--json");
const DO_PUSH = has("--push");
const NO_COMMIT = has("--no-commit");
const TOKEN = process.env.SYNC_TOKEN || process.env.GH_TOKEN || "";
const GATE_STATUS = process.env.BASE_SYNC_GATE_STATUS || "";
const GATE_SHA = process.env.BASE_SYNC_GATE_SHA || "";
const GATE_URL = process.env.BASE_SYNC_GATE_URL || "";
const GITHUB_API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
let DRY = REQUESTED_DRY;
let DRY_REASON = REQUESTED_DRY ? "已显式请求 dry-run" : "";

export function resolveRemoteWritePolicy({ requestedDry, remoteWriteRequested, token, gateStatus, gateSha, gateUrl, baseSha, baseClean = true }) {
  if (requestedDry) return { dryRun: true, reason: "已显式请求 dry-run" };
  if (!remoteWriteRequested) return { dryRun: false, reason: "" };
  if (!token) return { dryRun: true, reason: "未提供同步凭据，已强制降级为 dry-run" };
  if (gateStatus !== "success") return { dryRun: true, reason: "缺少 ci-gate 成功证明，已强制降级为 dry-run" };
  if (!gateSha || gateSha !== baseSha) return { dryRun: true, reason: "ci-gate 校验 SHA 与待下发基座 SHA 不一致，已强制降级为 dry-run" };
  if (!gateUrl) return { dryRun: true, reason: "缺少可审计的 ci-gate 运行链接，已强制降级为 dry-run" };
  if (!baseClean) return { dryRun: true, reason: "基座工作树包含未提交变化，无法由门禁 SHA 证明，已强制降级为 dry-run" };
  return { dryRun: false, reason: "" };
}

function applyRemoteWritePolicy(baseSha, remoteWriteRequested, baseDir) {
  const policy = resolveRemoteWritePolicy({
    requestedDry: REQUESTED_DRY,
    remoteWriteRequested,
    token: TOKEN,
    gateStatus: GATE_STATUS,
    gateSha: GATE_SHA,
    gateUrl: GATE_URL,
    baseSha,
    baseClean: !remoteWriteRequested || git(baseDir, "status", "--porcelain").length === 0,
  });
  DRY = policy.dryRun;
  DRY_REASON = policy.reason;
  return policy;
}

function forceDryRun(reason) {
  DRY = true;
  DRY_REASON = reason;
}

/* ---------------- 工具 ---------------- */
const sh = (cmd, cmdArgs, cwd) => execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...gitArgs) => sh("git", gitArgs, cwd);

function repositoryUrl(repo) {
  const url = `${BASE_URL.replace(/\/$/, "")}/${repo}.git`;
  return TOKEN && url.startsWith("https://")
    ? url.replace("https://", `https://x-access-token:${encodeURIComponent(TOKEN)}@`)
    : url;
}

function safeError(error) {
  let message = String(error?.message ?? error);
  if (TOKEN) message = message.replaceAll(TOKEN, "***").replaceAll(encodeURIComponent(TOKEN), "***");
  return message.replace(/https:\/\/[^/@\s]+@/g, "https://***@").slice(0, 500);
}

export function syncBranchName(baseSha) {
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) throw new Error("基座 SHA 格式无效");
  return `chore/workloom-base-${baseSha.slice(0, 12).toLowerCase()}`;
}

export function validateChildrenConfig(children) {
  if (!Array.isArray(children) || children.length === 0) throw new Error("子仓订阅清单不能为空");
  const seen = new Set();
  for (const child of children) {
    if (!child || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(child.repo ?? "")) throw new Error(`非法子仓标识：${child?.repo ?? "（缺失）"}`);
    if (seen.has(child.repo)) throw new Error(`子仓订阅重复：${child.repo}`);
    seen.add(child.repo);
    const prefix = child.pathPrefix ?? "";
    if (prefix.startsWith("/") || prefix.split(/[\\/]/).includes("..")) throw new Error(`非法 pathPrefix：${prefix}`);
  }
  return children;
}

export function pullRequestPayload({ branch, baseSha, copied, merged, skippedAppendOnly, gateUrl, scopeVersion, extraExclude = [] }) {
  const changedFiles = [...copied, ...merged].slice(0, 50);
  return {
    title: `chore(base-sync): 对齐 WorkLoom 基座 ${baseSha.slice(0, 8)}`,
    head: branch,
    base: "main",
    body: [
      "此 PR 由 WorkLoom IM 基座同步治理流程创建，不会自动合并或直推主分支。",
      "",
      `- 基座提交：\`${baseSha}\``,
      `- 基座门禁：ci-gate 已通过${gateUrl ? `（[查看运行](${gateUrl})）` : ""}`,
      `- 同步结果：复制 ${copied.length} 个文件，锚点合并 ${merged.length} 个文件，迁移跳过 ${skippedAppendOnly.length} 个文件`,
      `- 同步边界：\`sync/base-scope.json\` 第 ${scopeVersion ?? "未知"} 版；行业 Bundle、主题、投影、种子数据与行业页面不在同步范围`,
      `- 仓级额外排除：${extraExclude.length ? `${extraExclude.length} 项（见下方）` : "无"}`,
      "- 合并条件：行业仓 CI、三端构建、租户隔离及人工评审全部通过",
      "",
      "变更文件（最多展示 50 个）：",
      ...(changedFiles.length ? changedFiles.map((file) => `- \`${file}\``) : ["- 无公共文件变化"]),
      ...(extraExclude.length ? ["", "仓级额外排除：", ...extraExclude.slice(0, 30).map((path) => `- \`${path}\``)] : []),
    ].join("\n"),
  };
}

async function createPullRequest({ repo, token, payload }) {
  const endpoint = `${GITHUB_API_URL}/repos/${repo}/pulls`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
  if (response.ok) return response.json();

  const detail = await response.text();
  if (response.status === 422) {
    const owner = repo.split("/")[0];
    const query = new URLSearchParams({ state: "open", head: `${owner}:${payload.head}`, base: payload.base });
    const existing = await fetch(`${endpoint}?${query}`, { headers });
    if (existing.ok) {
      const pulls = await existing.json();
      if (Array.isArray(pulls) && pulls[0]) return pulls[0];
    }
  }
  throw new Error(`创建升级 PR 失败（HTTP ${response.status}）：${detail.slice(0, 300)}`);
}

function pushAuditBranch(childDir, branch, remote = "origin") {
  const ref = `refs/heads/${branch}`;
  const remoteLine = git(childDir, "ls-remote", remote, ref);
  const remoteSha = remoteLine.split(/\s/)[0] || "";
  const lease = remoteSha ? `--force-with-lease=${ref}:${remoteSha}` : "--force-with-lease";
  git(childDir, "push", lease, remote, `HEAD:${ref}`);
}

function repoSlugFromRemote(url) {
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("无法从 origin 推导 GitHub 仓库名；请通过基座 push 模式创建升级 PR");
  return match[1].replace(/\.git$/i, "");
}

function globToRegExp(glob) {
  let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, "\u0000");          // 占位：双星
  re = re.replace(/\*/g, "[^/]*");         // 单星：单层
  re = re.replace(/\u0000/g, ".*");            // 双星：任意层级
  return new RegExp("^" + re + "$");
}

function loadScope(baseDir) {
  const scope = JSON.parse(readFileSync(join(baseDir, "sync/base-scope.json"), "utf8"));
  return {
    raw: scope,
    includes: scope.include.map(globToRegExp),
    excludes: scope.exclude.map(globToRegExp),
  };
}
/** 仓级追加排除：合并到 scope（全局边界管不了的"同一文件在不同仓性质不同"，如 panda 电商化改写的 service 层） */
function withExtraExclude(sc, extraExclude = []) {
  if (!extraExclude.length) return sc;
  return { raw: sc.raw, includes: sc.includes, excludes: [...sc.excludes, ...extraExclude.map(globToRegExp)] };
}
const hitAny = (res, p) => res.some((r) => r.test(p));
const inScope = (sc, p) => !hitAny(sc.excludes, p) && hitAny(sc.includes, p);

function* walk(dir, base = dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".dsh-home"].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full, base);
    else yield relative(base, full);
  }
}

function ensureBaseClone(baseRepo) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-base-"));
  sh("git", ["clone", "--depth", "1", repositoryUrl(baseRepo), dir]);
  return dir;
}

function readState(childDir) {
  const p = join(childDir, ".workloom-base-sync.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function writeState(childDir, state) {
  if (DRY) return;
  writeFileSync(join(childDir, ".workloom-base-sync.json"), JSON.stringify(state, null, 2) + "\n");
}

/* ---------------- 锚点合并：基座版为底，子仓独有条目补回 ---------------- */
function mergeKeepChildExtra(baseObj, childObj, mergeKeys, ignoreDependencyKeys = []) {
  const out = JSON.parse(JSON.stringify(baseObj));
  for (const key of mergeKeys) {
    const b = baseObj[key], c = childObj[key];
    if (Array.isArray(b) || Array.isArray(c)) {
      const bb = Array.isArray(b) ? b : [], cc = Array.isArray(c) ? c : [];
      out[key] = [...cc.filter((x) => !bb.includes(x)), ...bb]; // 子仓独有元素前置保留
    } else {
      const bb = b ?? {}, cc = c ?? {};
      out[key] = { ...bb };
      if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key)) {
        for (const ignored of ignoreDependencyKeys) {
          if (ignored in cc) out[key][ignored] = cc[ignored];
          else delete out[key][ignored];
        }
      }
      for (const [k, v] of Object.entries(cc)) if (!(k in bb)) out[key][k] = v;
    }
  }
  return out;
}

/** 语义级判定：anchorMerge 文件按"基座条目在子仓缺失或值不同"判定（子仓独有条目/顺序/格式不触发） */
function anchorNeedsSync(baseObj, childObj, mergeKeys, ignoreDependencyKeys = []) {
  const topKeys = new Set([...Object.keys(baseObj), ...mergeKeys]);
  for (const key of topKeys) {
    const b = baseObj[key], c = childObj[key];
    if (mergeKeys.includes(key)) {
      if (Array.isArray(b) || Array.isArray(c)) {
        const bb = Array.isArray(b) ? b : [], cc = Array.isArray(c) ? c : [];
        for (const item of bb) if (!cc.includes(item)) return true; // 基座元素在子仓缺失
      } else {
        const bb = b ?? {}, cc = c ?? {};
        for (const [k, v] of Object.entries(bb)) {
          if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key) && ignoreDependencyKeys.includes(k)) continue;
          if (!(k in cc) || JSON.stringify(cc[k]) !== JSON.stringify(v)) return true;
        }
      }
    } else if (JSON.stringify(b) !== JSON.stringify(c)) return true; // 非合并顶层 key 需一致
  }
  return false;
}

/** 文件级同步判定（detect 与 pull 共用的唯一事实逻辑） */
function fileNeedsSync(scope, rel, src, dst) {
  if (!existsSync(dst)) return true;
  if (scope.appendOnlyDirs.some((d) => rel.startsWith(d + "/"))) return false; // 已存在迁移永不同步（append-only 纪律）
  const anchorCfg = scope.anchorMerge[rel];
  if (anchorCfg) {
    try {
      return anchorNeedsSync(
        JSON.parse(readFileSync(src, "utf8")),
        JSON.parse(readFileSync(dst, "utf8")),
        anchorCfg.mergeKeys,
        anchorCfg.ignoreDependencyKeys ?? [],
      );
    } catch { return true; } // 解析失败按需要同步处理
  }
  return readFileSync(dst, "utf8") !== readFileSync(src, "utf8");
}

/* ---------------- 单仓同步核心（pull 与 push 共用） ---------------- */
function syncToChild(baseDir, childDir, sc, report, extraGlobs = []) {
  const baseSha = git(baseDir, "rev-parse", "HEAD");
  const scope = sc.raw;
  const copied = [], merged = [], skippedAppendOnly = [], warnings = [];

  // ① 收集 scope 内基座文件
  const scopeFiles = [...walk(baseDir)].filter((p) => inScope(sc, p));

  // ② 防污染硬校验（双保险：scope 已过滤，这里再扫黑名单；^ 前缀=路径锚定，其余=子串）
  const blackHit = (p) => scope.pollutionGuard.pathBlacklist.some((b) => b.startsWith("^") ? p.startsWith(b.slice(1)) : p.includes(b));
  const blackHits = scopeFiles.filter(blackHit);
  if (blackHits.length) throw new Error(`防污染护栏触发：scope 文件命中黑名单 → ${blackHits.slice(0, 5).join(", ")}`);

  // 在落盘前完成变更数量校验，避免 adopt 或本地 pull 因超限中止时留下半套基座文件。
  const pendingFiles = scopeFiles.filter((rel) => fileNeedsSync(scope, rel, join(baseDir, rel), join(childDir, rel)));
  if (pendingFiles.length > scope.pollutionGuard.maxFilesPerSync) {
    throw new Error(`防污染护栏触发：单次变更 ${pendingFiles.length} 文件超过上限 ${scope.pollutionGuard.maxFilesPerSync}——请人工核对同步范围`);
  }

  for (const rel of scopeFiles) {
    const src = join(baseDir, rel);
    const dst = join(childDir, rel);
    const dstExists = existsSync(dst);

    // 统一判定：不需要同步的文件直接跳过（迁移 append-only / 锚点语义级 / 逐字节三态内含）
    if (!fileNeedsSync(scope, rel, src, dst)) {
      if (dstExists && scope.appendOnlyDirs.some((d) => rel.startsWith(d + "/")) && readFileSync(src, "utf8") !== readFileSync(dst, "utf8")) {
        skippedAppendOnly.push(rel); warnings.push(`迁移漂移跳过（各仓迁移链须自洽）: ${rel}`);
      }
      continue;
    }

    // ③ 迁移目录 append-only：子仓没有该迁移才复制（新增迁移可同步；已存在漂移上面已跳过）
    if (scope.appendOnlyDirs.some((d) => rel.startsWith(d + "/"))) {
      if (!DRY) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
      copied.push(rel);
      continue;
    }

    // ④ 锚点合并文件：按策略合并而非覆盖
    const anchorCfg = scope.anchorMerge[rel];
    if (anchorCfg && dstExists) {
      const mergedObj = mergeKeepChildExtra(
        JSON.parse(readFileSync(src, "utf8")),
        JSON.parse(readFileSync(dst, "utf8")),
        anchorCfg.mergeKeys,
        anchorCfg.ignoreDependencyKeys ?? [],
      );
      if (!DRY) writeFileSync(dst, JSON.stringify(mergedObj, null, 2) + "\n");
      merged.push(rel);
      continue;
    }

    // ⑤ 常规复制
    if (!DRY) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    copied.push(rel);
  }

  // ⑥ 先写状态账本，再与公共文件进入同一提交；升级 PR 因而能自证来源 SHA。
  const changed = copied.length + merged.length;
  let committed = false;
  if (!DRY) {
    writeState(childDir, {
      baseRepo: readState(childDir)?.baseRepo ?? "geniusdapeng-collab/workloom-im",
      lastSyncedBaseSha: baseSha,
      lastSyncAt: new Date().toISOString(),
      filesTouched: changed,
      ...(extraGlobs.length || readState(childDir)?.extraExclude
        ? { extraExclude: extraGlobs.length ? extraGlobs : readState(childDir).extraExclude }
        : {}),
    });
  }
  if (changed > 0 && !DRY) {
    // 锚点合并动了 package.json → 同步刷新 lockfile（否则子仓 CI 的 --frozen-lockfile 必挂；失败仅告警不阻断）
    if (merged.length > 0) {
      try {
        sh("pnpm", ["install", "--lockfile-only"], childDir);
        report.lockfileRefreshed = true;
      } catch (e) { warnings.push(`lockfile 刷新失败（请手动 pnpm install）: ${safeError(e).slice(0, 120)}`); }
    }
    if (NO_COMMIT) {
      warnings.push("已完成基座文件对齐但未自动提交；请与行业配置一并评审后提交");
    } else {
      git(childDir, "add", "-A");
      const files = [...copied, ...merged.map((m) => m + "(merge)")].slice(0, 30).join(", ");
      git(childDir, "-c", "user.name=WorkLoom Base Sync", "-c", "user.email=base-sync@workloom.im", "commit", "-m",
        `chore(base-sync): 基座能力对齐 → ${baseSha.slice(0, 8)}（base-sync 自动）\n\n复制 ${copied.length} 文件 · 锚点合并 ${merged.length} 文件${skippedAppendOnly.length ? ` · 迁移跳过 ${skippedAppendOnly.length}` : ""}\n${files}${changed > 30 ? " …" : ""}`);
      committed = true;
    }
  }

  report.copied = copied; report.merged = merged; report.skippedAppendOnly = skippedAppendOnly;
  report.scopeVersion = scope.version ?? null; report.extraExclude = extraGlobs;
  report.warnings = warnings; report.changed = changed; report.committed = committed; report.baseSha = baseSha;
  return report;
}

/* ---------------- 模式：detect（心跳检测） ---------------- */
function modeDetect(childDir) {
  const state = readState(childDir);
  const baseRepo = state?.baseRepo ?? "geniusdapeng-collab/workloom-im";
  const baseDir = BASE_DIR_OPT || ensureBaseClone(baseRepo);
  try {
    // clone 的 HEAD（或显式 --base-dir 的 HEAD）就是本轮逐文件比对的唯一基座快照，避免二次远端查询产生 SHA 竞态。
    const remoteSha = git(baseDir, "rev-parse", "HEAD");
    const report = { mode: "detect", child: childDir, remoteSha, localSha: state?.lastSyncedBaseSha ?? null, behind: true, files: [] };
    // 即使 SHA 相同也必须逐文件核对；否则行业仓手工改写基座源码后会被“已对齐”假象掩盖。
    const extra = [...(state?.extraExclude ?? []), ...(opt("--extra-exclude") ? opt("--extra-exclude").split(",") : [])];
    const sc = withExtraExclude(loadScope(baseDir), extra);
    const scopeFiles = [...walk(baseDir)].filter((p) => inScope(sc, p));
    report.files = scopeFiles.filter((rel) => fileNeedsSync(sc.raw, rel, join(baseDir, rel), join(childDir, rel)));
    // 文件级零差异即视为对齐；detect 永远只读，状态账本只允许由实际 pull/升级 PR 写入。
    if (report.files.length === 0) {
      report.behind = false;
      output(report, `✅ 基座能力已对齐（${remoteSha.slice(0, 8)}，scope 内 0 个文件待对齐）`);
      return 0;
    }
    report.behindBy = `${state?.lastSyncedBaseSha?.slice(0, 8) ?? "从未同步"} → ${remoteSha.slice(0, 8)}`;
    output(report, `⚠️ 基座能力落后（${report.behindBy}）：scope 内 ${report.files.length} 个文件待对齐\n${report.files.slice(0, 20).map((f) => "  · " + f).join("\n")}${report.files.length > 20 ? `\n  … 共 ${report.files.length} 个` : ""}\n\n处理：等待基座 ci-gate 通过后生成升级 PR；本地预检可执行 node sync/base-sync.mjs pull --repo . --no-commit`);
    return 2;
  } finally {
    if (!BASE_DIR_OPT) rmSync(baseDir, { recursive: true, force: true });
  }
}

/* ---------------- 模式：pull（子仓拉齐） ---------------- */
async function modePull(childDir) {
  const state = readState(childDir);
  const baseDir = BASE_DIR_OPT || ensureBaseClone(state?.baseRepo ?? "geniusdapeng-collab/workloom-im");
  try {
    const baseSha = git(baseDir, "rev-parse", "HEAD");
    applyRemoteWritePolicy(baseSha, DO_PUSH, baseDir);
    if (DO_PUSH && !DRY && git(childDir, "status", "--porcelain").length > 0) {
      forceDryRun("目标仓工作树包含未提交变化，已强制降级为 dry-run");
    }
    if (DO_PUSH && !DRY && git(childDir, "branch", "--show-current") !== "main") {
      forceDryRun("目标仓当前分支不是 main，已强制降级为 dry-run");
    }
    const extra = [...(state?.extraExclude ?? []), ...(opt("--extra-exclude") ? opt("--extra-exclude").split(",") : [])];
    const sc = withExtraExclude(loadScope(baseDir), extra);
    const report = { mode: "pull", child: childDir, dryRun: DRY, dryRunReason: DRY_REASON || undefined };
    const branch = DO_PUSH ? syncBranchName(baseSha) : null;
    if (DO_PUSH && !DRY) git(childDir, "switch", "-C", branch);
    syncToChild(baseDir, childDir, sc, report, extra);

    if (DO_PUSH && report.committed && !DRY) {
      const origin = git(childDir, "remote", "get-url", "origin");
      const repo = repoSlugFromRemote(origin);
      const remote = repositoryUrl(repo);
      pushAuditBranch(childDir, branch, remote);
      const pull = await createPullRequest({
        repo,
        token: TOKEN,
        payload: pullRequestPayload({ branch, baseSha, ...report, gateUrl: GATE_URL }),
      });
      report.status = "pr-opened";
      report.pullRequestUrl = pull.html_url ?? null;
      report.branch = branch;
    } else if (report.changed > 0 && DRY) {
      report.status = "planned";
      report.branch = branch;
    } else {
      report.status = report.changed === 0 ? "already-current" : "local-only";
    }

    output(report, report.changed === 0
      ? `✅ 已是最新（基座 ${report.baseSha.slice(0, 8)}），无文件需变更`
      : `${DRY ? `[dry-run${DRY_REASON ? `：${DRY_REASON}` : ""}] ` : ""}📦 对齐完成：复制 ${report.copied.length} · 锚点合并 ${report.merged.length} · 迁移跳过 ${report.skippedAppendOnly.length}${report.pullRequestUrl ? ` · 升级 PR ${report.pullRequestUrl}` : ""}${report.warnings.length ? "\n⚠️ " + report.warnings.join("\n⚠️ ") : ""}`);
  } finally {
    if (!BASE_DIR_OPT) rmSync(baseDir, { recursive: true, force: true });
  }
}

/* ---------------- 模式：push（父仓向全部子仓创建可审计升级 PR） ---------------- */
async function modePush(baseDir) {
  const baseSha = git(baseDir, "rev-parse", "HEAD");
  const policy = applyRemoteWritePolicy(baseSha, true, baseDir);
  const sc0 = loadScope(baseDir);
  const config = JSON.parse(readFileSync(join(baseDir, "sync/child-repos.json"), "utf8"));
  const children = validateChildrenConfig(config.children);
  const results = [];
  for (const child of children) {
    const branch = syncBranchName(baseSha);
    const r = { repo: child.repo, ok: false, branch, dryRun: DRY };
    const dir = mkdtempSync(join(tmpdir(), "workloom-child-"));
    try {
      sh("git", ["clone", "--depth", "1", repositoryUrl(child.repo), dir]);
      if (!DRY) git(dir, "switch", "-c", branch);
      const childWorkdir = child.pathPrefix ? join(dir, child.pathPrefix.replace(/\/$/, "")) : dir;
      if (!existsSync(childWorkdir)) throw new Error(`订阅工作目录不存在：${child.pathPrefix}`);
      const extra = child.extraExclude ?? [];
      const sc = withExtraExclude(sc0, extra);  // 仓级追加排除（父仓权威）
      syncToChild(baseDir, childWorkdir, sc, r, extra);
      if (r.committed && !DRY) {
        pushAuditBranch(dir, branch);
        const pull = await createPullRequest({
          repo: child.repo,
          token: TOKEN,
          payload: pullRequestPayload({ branch, baseSha, ...r, gateUrl: GATE_URL }),
        });
        r.status = "pr-opened";
        r.pullRequestUrl = pull.html_url ?? null;
      } else if (r.changed > 0 && DRY) {
        r.status = "planned";
      } else {
        r.status = "already-current";
      }
      r.ok = true;
    } catch (e) {
      r.status = "failed";
      r.error = safeError(e);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    results.push(r);
    if (!AS_JSON) console.log(`${r.ok ? "✅" : "❌"} ${child.repo}: ${r.status}${r.pullRequestUrl ? ` ${r.pullRequestUrl}` : ""}${r.error ? " 错误: " + r.error : ""}`);
  }
  const summary = {
    mode: "push",
    baseSha,
    gate: { status: GATE_STATUS || null, sha: GATE_SHA || null, url: GATE_URL || null },
    dryRun: policy.dryRun,
    dryRunReason: policy.reason || null,
    results,
  };
  output(summary, `\n═══ 升级 PR 汇总：${results.filter((r) => r.ok).length}/${results.length} 仓完成${DRY ? `（dry-run：${DRY_REASON}）` : ""} ═══`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/* ---------------- 输出 ---------------- */
function output(obj, text) {
  if (AS_JSON) console.log(JSON.stringify(obj, null, 2));
  else console.log(text);
}

/* ---------------- 入口 ---------------- */
async function main() {
  if (!["detect", "pull", "push"].includes(MODE)) {
    console.error("用法: node base-sync.mjs detect|pull|push [--repo <path>] [--base <path>] [--base-dir <path>] [--base-url <prefix>] [--push] [--no-commit] [--dry-run] [--json]");
    process.exitCode = 64;
    return;
  }
  if (NO_COMMIT && DO_PUSH) {
    console.error("--no-commit 与 --push 不能同时使用；远程下发必须生成完整、可审计的提交与 PR");
    process.exitCode = 64;
    return;
  }
  if (MODE === "detect") {
    if (!REPO) { console.error("detect 需要 --repo"); process.exitCode = 64; return; }
    process.exitCode = modeDetect(REPO);
  }
  if (MODE === "pull") {
    if (!REPO) { console.error("pull 需要 --repo"); process.exitCode = 64; return; }
    await modePull(REPO);
  }
  if (MODE === "push") await modePush(opt("--base") || join(__dirname, ".."));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
