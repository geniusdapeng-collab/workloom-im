#!/usr/bin/env node
/**
 * WorkLoom IM · 基座能力双向同步引擎（base-sync）
 *
 * 三种模式：
 *   node base-sync.mjs detect --repo <子仓路径>            心跳检测：子仓基座落后则报告并退出码 2（CI 红=提醒）
 *   node base-sync.mjs pull   --repo <子仓路径> [--push]   子仓拉齐：按 scope 复制基座文件 → 提交 [→ 推送]
 *   node base-sync.mjs push   --base <基座路径>            父仓推送：对 child-repos.json 全部子仓执行拉齐并推送
 *
 * 通用参数：
 *   --base-dir <path>     基座本地路径（默认：临时 clone 基座 main）
 *   --base-url <prefix>   git 远端前缀覆盖（沙箱/镜像环境用，默认 https://github.com）
 *   --dry-run             只输出计划，不落盘不提交
 *   --json                机器可读报告输出
 *
 * 设计纪律：
 *   ① 同步范围唯一事实源 = sync/base-scope.json（include/exclude/anchorMerge/appendOnlyDirs/pollutionGuard）；
 *   ② 行业属性与演示能力永不同步（exclude + 推送前黑名单硬校验双保险）；
 *   ③ 迁移目录 append-only（子仓已有同名迁移内容不同→跳过并告警，绝不覆盖）；
 *   ④ 锚点合并文件（package.json/tsconfig.json）按策略合并，保留子仓独有条目；
 *   ⑤ 无外部依赖（Node ≥20 原生 ESM），CI 与本地均可直接执行。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
const DRY = has("--dry-run");
const AS_JSON = has("--json");
const DO_PUSH = has("--push");
const TOKEN = process.env.SYNC_TOKEN || process.env.GH_TOKEN || "";

if (!["detect", "pull", "push"].includes(MODE)) {
  console.error("用法: node base-sync.mjs detect|pull|push [--repo <path>] [--base <path>] [--base-dir <path>] [--base-url <prefix>] [--push] [--dry-run] [--json]");
  process.exit(64);
}

/* ---------------- 工具 ---------------- */
const sh = (cmd, cmdArgs, cwd) => execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...gitArgs) => sh("git", gitArgs, cwd);

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
  const authUrl = TOKEN ? `${BASE_URL.replace("https://", `https://oauth2:${TOKEN}@`)}/${baseRepo}.git` : `${BASE_URL}/${baseRepo}.git`;
  sh("git", ["clone", "--depth", "1", authUrl, dir]);
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
function mergeKeepChildExtra(baseObj, childObj, mergeKeys) {
  const out = JSON.parse(JSON.stringify(baseObj));
  for (const key of mergeKeys) {
    const b = baseObj[key], c = childObj[key];
    if (Array.isArray(b) || Array.isArray(c)) {
      const bb = Array.isArray(b) ? b : [], cc = Array.isArray(c) ? c : [];
      out[key] = [...cc.filter((x) => !bb.includes(x)), ...bb]; // 子仓独有元素前置保留
    } else {
      const bb = b ?? {}, cc = c ?? {};
      out[key] = { ...bb };
      for (const [k, v] of Object.entries(cc)) if (!(k in bb)) out[key][k] = v;
    }
  }
  return out;
}

/** 语义级判定：anchorMerge 文件按"基座条目在子仓缺失或值不同"判定（子仓独有条目/顺序/格式不触发） */
function anchorNeedsSync(baseObj, childObj, mergeKeys) {
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
      return anchorNeedsSync(JSON.parse(readFileSync(src, "utf8")), JSON.parse(readFileSync(dst, "utf8")), anchorCfg.mergeKeys);
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
      const mergedObj = mergeKeepChildExtra(JSON.parse(readFileSync(src, "utf8")), JSON.parse(readFileSync(dst, "utf8")), anchorCfg.mergeKeys);
      if (!DRY) writeFileSync(dst, JSON.stringify(mergedObj, null, 2) + "\n");
      merged.push(rel);
      continue;
    }

    // ⑤ 常规复制
    if (!DRY) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    copied.push(rel);
  }

  // ⑥ 提交 + 状态落盘
  const changed = copied.length + merged.length;
  // 防污染护栏：单次实际变更数超限即中止（scope 总量大是正常的，护栏管的是单次漂移幅度）
  if (changed > scope.pollutionGuard.maxFilesPerSync) throw new Error(`防污染护栏触发：单次变更 ${changed} 文件超过上限 ${scope.pollutionGuard.maxFilesPerSync}——请人工核对同步范围`);
  let committed = false;
  if (changed > 0 && !DRY) {
    // 锚点合并动了 package.json → 同步刷新 lockfile（否则子仓 CI 的 --frozen-lockfile 必挂；失败仅告警不阻断）
    if (merged.length > 0) {
      try {
        sh("pnpm", ["install", "--lockfile-only"], childDir);
        report.lockfileRefreshed = true;
      } catch (e) { warnings.push(`lockfile 刷新失败（请手动 pnpm install）: ${String(e.message ?? e).slice(0, 120)}`); }
    }
    git(childDir, "add", "-A");
    const files = [...copied, ...merged.map((m) => m + "(merge)")].slice(0, 30).join(", ");
    git(childDir, "-c", "user.name=WorkLoom Base Sync", "-c", "user.email=base-sync@workloom.im", "commit", "-m",
      `chore(base-sync): 基座能力对齐 → ${baseSha.slice(0, 8)}（base-sync 自动）\n\n复制 ${copied.length} 文件 · 锚点合并 ${merged.length} 文件${skippedAppendOnly.length ? ` · 迁移跳过 ${skippedAppendOnly.length}` : ""}\n${files}${changed > 30 ? " …" : ""}`);
    committed = true;
  }
  if (!DRY) writeState(childDir, { baseRepo: readState(childDir)?.baseRepo ?? "geniusdapeng-collab/workloom-im", lastSyncedBaseSha: baseSha, lastSyncAt: new Date().toISOString(), filesTouched: changed, ...(extraGlobs.length || readState(childDir)?.extraExclude ? { extraExclude: extraGlobs.length ? extraGlobs : readState(childDir).extraExclude } : {}) });

  report.copied = copied; report.merged = merged; report.skippedAppendOnly = skippedAppendOnly;
  report.warnings = warnings; report.changed = changed; report.committed = committed; report.baseSha = baseSha;
  return report;
}

/* ---------------- 模式：detect（心跳检测） ---------------- */
function modeDetect(childDir) {
  const state = readState(childDir);
  const baseRepo = state?.baseRepo ?? "geniusdapeng-collab/workloom-im";
  const authUrl = TOKEN ? `${BASE_URL.replace("https://", `https://oauth2:${TOKEN}@`)}/${baseRepo}.git` : `${BASE_URL}/${baseRepo}.git`;
  const remoteLine = sh("git", ["ls-remote", authUrl, "main"]);
  const remoteSha = remoteLine.split(/\s/)[0];

  const report = { mode: "detect", child: childDir, remoteSha, localSha: state?.lastSyncedBaseSha ?? null, behind: true, files: [] };
  if (state && state.lastSyncedBaseSha === remoteSha) {
    report.behind = false;
    output(report, `✅ 基座已对齐（${remoteSha.slice(0, 8)}）`);
    process.exit(0);
  }

  // 落后：拉基座算差异清单（合并仓级 extraExclude：state 文件自描述 + --extra-exclude 参数）
  const baseDir = BASE_DIR_OPT || ensureBaseClone(baseRepo);
  const extra = [...(state?.extraExclude ?? []), ...(opt("--extra-exclude") ? opt("--extra-exclude").split(",") : [])];
  const sc = withExtraExclude(loadScope(baseDir), extra);
  const scopeFiles = [...walk(baseDir)].filter((p) => inScope(sc, p));
  report.files = scopeFiles.filter((rel) => fileNeedsSync(sc.raw, rel, join(baseDir, rel), join(childDir, rel)));
  // 文件级零差异即视为对齐（自动建立/刷新基线，避免"从未同步"假报警）
  if (report.files.length === 0) {
    report.behind = false;
    if (!DRY) writeState(childDir, { baseRepo, lastSyncedBaseSha: remoteSha, lastSyncAt: new Date().toISOString(), filesTouched: 0, ...(state?.extraExclude ? { extraExclude: state.extraExclude } : {}) });
    output(report, `✅ 基座能力已对齐（${remoteSha.slice(0, 8)}，scope 内 0 个文件待对齐）`);
    process.exit(0);
  }
  report.behindBy = `${state?.lastSyncedBaseSha?.slice(0, 8) ?? "从未同步"} → ${remoteSha.slice(0, 8)}`;
  output(report, `⚠️ 基座能力落后（${report.behindBy}）：scope 内 ${report.files.length} 个文件待对齐\n${report.files.slice(0, 20).map((f) => "  · " + f).join("\n")}${report.files.length > 20 ? `\n  … 共 ${report.files.length} 个` : ""}\n\n修复：node sync/base-sync.mjs pull --repo . --push（或等待心跳 CI 自动对齐）`);
  if (!BASE_DIR_OPT) rmSync(baseDir, { recursive: true, force: true });
  process.exit(2);
}

/* ---------------- 模式：pull（子仓拉齐） ---------------- */
function modePull(childDir) {
  const state = readState(childDir);
  const baseDir = BASE_DIR_OPT || ensureBaseClone(state?.baseRepo ?? "geniusdapeng-collab/workloom-im");
  const extra = [...(state?.extraExclude ?? []), ...(opt("--extra-exclude") ? opt("--extra-exclude").split(",") : [])];
  const sc = withExtraExclude(loadScope(baseDir), extra);
  const report = { mode: "pull", child: childDir };
  syncToChild(baseDir, childDir, sc, report, extra);
  if (DO_PUSH && report.committed && !DRY) {
    const url = git(childDir, "remote", "get-url", "origin");
    const pushUrl = TOKEN ? url.replace("https://", `https://oauth2:${TOKEN}@`) : url;
    git(childDir, "push", pushUrl, "main:main");
    report.pushed = true;
  }
  output(report, report.changed === 0
    ? `✅ 已是最新（基座 ${report.baseSha.slice(0, 8)}），无文件需变更`
    : `${DRY ? "[dry-run] " : ""}📦 对齐完成：复制 ${report.copied.length} · 锚点合并 ${report.merged.length} · 迁移跳过 ${report.skippedAppendOnly.length}${report.pushed ? " · 已推送" : ""}${report.warnings.length ? "\n⚠️ " + report.warnings.join("\n⚠️ ") : ""}`);
  if (!BASE_DIR_OPT) rmSync(baseDir, { recursive: true, force: true });
}

/* ---------------- 模式：push（父仓推送到全部子仓） ---------------- */
function modePush(baseDir) {
  const sc0 = loadScope(baseDir);
  const children = JSON.parse(readFileSync(join(baseDir, "sync/child-repos.json"), "utf8"));
  const results = [];
  for (const child of children.children) {
    const r = { repo: child.repo, ok: false };
    const dir = mkdtempSync(join(tmpdir(), "workloom-child-"));
    try {
      const authUrl = TOKEN ? `${BASE_URL.replace("https://", `https://oauth2:${TOKEN}@`)}/${child.repo}.git` : `${BASE_URL}/${child.repo}.git`;
      sh("git", ["clone", "--depth", "1", authUrl, dir]);
      const childWorkdir = child.pathPrefix ? join(dir, child.pathPrefix.replace(/\/$/, "")) : dir;
      const extra = child.extraExclude ?? [];
      const sc = withExtraExclude(sc0, extra);  // 仓级追加排除（父仓权威）
      syncToChild(baseDir, childWorkdir, sc, r, extra);
      if (r.committed && !DRY) {
        git(dir, "push", authUrl, "main:main");
        r.pushed = true;
      }
      r.ok = true;
    } catch (e) { r.error = String(e.message ?? e).slice(0, 300); }
    results.push(r);
    console.log(`${r.ok ? "✅" : "❌"} ${child.repo}: changed=${r.changed ?? "-"}${r.pushed ? " 已推送" : ""}${r.error ? " 错误: " + r.error : ""}`);
    if (!DRY) rmSync(dir, { recursive: true, force: true });
  }
  const summary = { mode: "push", baseSha: git(baseDir, "rev-parse", "HEAD"), results };
  output(summary, `\n═══ 推送汇总：${results.filter((r) => r.ok).length}/${results.length} 仓成功 ═══`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

/* ---------------- 输出 ---------------- */
function output(obj, text) {
  if (AS_JSON) console.log(JSON.stringify(obj, null, 2));
  else console.log(text);
}

/* ---------------- 入口 ---------------- */
if (MODE === "detect") { if (!REPO) { console.error("detect 需要 --repo"); process.exit(64); } modeDetect(REPO); }
if (MODE === "pull") { if (!REPO) { console.error("pull 需要 --repo"); process.exit(64); } modePull(REPO); }
if (MODE === "push") { const b = opt("--base") || join(__dirname, ".."); modePush(b); }
