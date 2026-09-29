#!/usr/bin/env node
/**
 * 基座 fanout 与纯同步 PR 自动合并的**纯规则层**（无副作用，可单测）。
 *
 * 边界（与 docs/DEVELOPMENT-PROTOCOL.md §1/§9 一致）：
 *   · fanout 只负责“把基座根级资产的新版本变成子仓里的一条同步 PR”；
 *   · `autoMergeEligibility` 覆盖**纯同步 PR**：分支名 `sync/base-*`，且改动文件全部落在
 *     根级受控资产白名单内、全部门禁 success；
 *   · `codeMergeEligibility` 覆盖**代码类 PR**（协议 §1「合并在机器」）：全部门禁 success、
 *     平台可合并、非 WIP、无 `risk/review` / `risk/block` 标签、避开治理路径、且分支最近
 *     提交已过冷却期。两条判定都是纯函数，`sync/merge-sync-prs.mjs` 按同一口径串行执行。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractManagedSection } from "./base-sync.mjs";

export const SYNC_BRANCH_PREFIX = "sync/base-";
/** 历史遗留的同步分支前缀（2026-09-19 之前的文档分发波次）。新流程不再产生，仅用于一次性收口。 */
export const LEGACY_SYNC_BRANCH_PREFIXES = Object.freeze(["docs/context-"]);

/** CNB 在列表接口里给的是 `refs/heads/xxx`，判定前缀前统一剥掉 */
export function normalizeBranchRef(ref) {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

/**
 * 纯同步 PR 允许自动合并的路径白名单。
 * 这里是**根级受控资产 + 同步登记文件**，不含 packages/**、apps/** 等运行时代码：
 * 运行时代码的基座升级按协议 §1 由 AI 在门禁全绿后串行合并（见 codeMergeEligibility）。
 */
export const AUTO_MERGE_ALLOWLIST = Object.freeze([
  "WORKLOOM_PRODUCT_CONTEXT.md",
  "AI-AUTONOMOUS-OPERATIONS.md",
  "AGENTS.md",
  "docs/DEVELOPMENT-PROTOCOL.md",
  // 真机验收规范与执行契约（RDAS v1）：纯文档 + 检查单 + 模板 + 执行器，不含运行时代码
  "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md",
  "docs/acceptance/**",
  "scripts/acceptance/**",
  ".workloom-base-sync.json",
  ".github/workflows/base-sync-heartbeat.yml",
  "sync/**",
]);

/** glob：`**` 跨目录，`*` 不跨 `/`，`?` 单字符 */
export function matchesGlob(pattern, path) {
  const tokens = String(pattern).split("**");
  const body = tokens
    .map((part) => part
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp(`^${body}$`).test(path);
}

export function isAllowlistedPath(path, allowlist = AUTO_MERGE_ALLOWLIST) {
  return allowlist.some((pattern) => matchesGlob(pattern, path));
}

/**
 * 判定一条 PR 是否属于“纯同步 PR”并可自动合并。
 * @param {{pull: object, files: string[], statuses: Array<{state?: string, status?: string}>}} input
 * @returns {{eligible: boolean, reasons: string[]}}
 */
export function autoMergeEligibility(
  { pull, files = [], statuses = [] },
  { allowlist = AUTO_MERGE_ALLOWLIST, acceptPrefixes = [SYNC_BRANCH_PREFIX] } = {},
) {
  const reasons = [];
  const headRef = normalizeBranchRef(pull?.head?.ref);
  const state = pull?.state ?? "open";

  if (state !== "open") reasons.push(`PR 状态为 ${state}`);
  if (!acceptPrefixes.some((prefix) => headRef.startsWith(prefix))) {
    reasons.push(`分支 ${headRef || "(未知)"} 不是 ${acceptPrefixes.map((prefix) => `${prefix}*`).join(" / ")} 同步分支`);
  }
  if (!files.length) reasons.push("没有可核对的文件清单");
  for (const file of files) {
    if (!isAllowlistedPath(file, allowlist)) reasons.push(`改动文件不在自动合并白名单：${file}`);
  }
  if (!statuses.length) reasons.push("没有状态检查结果（无门禁结果不得自动合并）");
  for (const status of statuses) {
    const value = status?.state ?? status?.status ?? "";
    if (value !== "success") reasons.push(`门禁未通过：${status?.context ?? status?.name ?? "(未命名)"}=${value || "(空)"}`);
  }
  if (pull?.mergeable_state && pull.mergeable_state !== "mergeable") {
    reasons.push(`平台可合并状态=${pull.mergeable_state}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * 代码类 PR 参与机器合并的分支车道（协议 §1：一任务一分支；行业 / 实验 / 维护车道）。
 * 同步分支（sync/base-*、docs/context-*）不在此列表，由 autoMergeEligibility 处理。
 */
export const CODE_MERGE_BRANCH_PREFIXES = Object.freeze([
  "task/",
  "industry/",
  "experiment/",
  "chore/",
  "docs/",
  "fix/",
  "audit/",
  "rescue/",
]);

/**
 * 治理与高风险路径：即使门禁全绿，也不由**无人值守扫描**合并（协议 §3 review/block 边界）。
 * 仍可由 AI 会话在获得明确指令/放行后显式合并——这里限制的只是"没有任何会话在环"的那条通道。
 */
export const CODE_MERGE_SKIP_PATHS = Object.freeze([
  "platform-ops/**",
  "bundles/platform/**",
  "protocol/**",
  "sync/**",
  "docs/DEVELOPMENT-PROTOCOL.md",
  "AGENTS.md",
  "AGENTS.repo.md",
  ".cnb.yml",
  ".github/**",
  "**/migrations/**",
]);

/**
 * 冷却期：分支最近一次提交距今不足该时长的 PR 不参与扫描合并。
 * 作用：避免把"会话仍在写、只是当下门禁恰好全绿"的 PR 提前合掉；配合 PR 的 WIP 标记使用。
 */
export const CODE_MERGE_MIN_HEAD_AGE_MS = 10 * 60 * 1000;

/**
 * 判定一条代码类 PR 是否可参与机器合并（协议 §1「合并在机器、串行执行、人保留叫停权」）。
 * @param {{pull: object, files?: string[], statuses?: Array<{state?: string, status?: string}>, headAgeMs?: number|null}} input
 * @returns {{eligible: boolean, reasons: string[]}}
 */
export function codeMergeEligibility(
  { pull, files = [], statuses = [], headAgeMs = null },
  {
    branchPrefixes = CODE_MERGE_BRANCH_PREFIXES,
    skipPaths = CODE_MERGE_SKIP_PATHS,
    allowPaths = [],
    minHeadAgeMs = CODE_MERGE_MIN_HEAD_AGE_MS,
  } = {},
) {
  const reasons = [];
  const headRef = normalizeBranchRef(pull?.head?.ref);
  const state = pull?.state ?? "open";
  const labels = (pull?.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);

  if (state !== "open") reasons.push(`PR 状态为 ${state}`);
  if (labels.includes("risk/block")) reasons.push("带 risk/block 标签（红线，永不合并）");
  if (labels.includes("risk/review")) reasons.push("带 risk/review 标签（需人审放行后由会话显式合并）");
  if (pull?.is_wip) reasons.push("PR 处于 WIP / 草稿状态");
  if (!branchPrefixes.some((prefix) => headRef.startsWith(prefix))) {
    reasons.push(`分支 ${headRef || "(未知)"} 不在代码合并车道（${branchPrefixes.join(" / ")}）`);
  }
  if (!files.length) reasons.push("没有可核对的文件清单");
  for (const file of files) {
    const skipped = skipPaths.some((pattern) => matchesGlob(pattern, file));
    const allowed = allowPaths.some((pattern) => matchesGlob(pattern, file));
    if (skipped && !allowed) {
      reasons.push(`改动落在治理/高风险路径：${file}`);
    }
  }
  if (!statuses.length) reasons.push("没有状态检查结果（无门禁结果不得自动合并）");
  for (const status of statuses) {
    const value = status?.state ?? status?.status ?? "";
    if (value !== "success") reasons.push(`门禁未通过：${status?.context ?? status?.name ?? "(未命名)"}=${value || "(空)"}`);
  }
  if (pull?.mergeable_state && pull.mergeable_state !== "mergeable") {
    reasons.push(`平台可合并状态=${pull.mergeable_state}`);
  }
  if (minHeadAgeMs > 0) {
    if (!Number.isFinite(headAgeMs)) {
      reasons.push("无法确认分支最近提交时间");
    } else if (headAgeMs < minHeadAgeMs) {
      reasons.push(`分支最近提交距今 ${Math.round(headAgeMs / 60000)} 分钟（冷却期 ${Math.round(minHeadAgeMs / 60000)} 分钟）`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * 与 sync/base-sync.mjs#requiredAssetDigests 同算法的根级受控资产摘要。
 * 子仓 `.workloom-base-sync.json#requiredRootAssetsSha256` 记录的就是这份摘要。
 */
export function requiredAssetDigests(baseDir, scopeRaw) {
  const required = scopeRaw?.requiredRootAssets ?? {};
  const result = {};
  for (const path of required.files ?? []) {
    result[path] = sha256(readFileSync(join(baseDir, path)));
  }
  for (const [target, config] of Object.entries(required.copiedFiles ?? {})) {
    result[target] = sha256(readFileSync(join(baseDir, config.source)));
  }
  for (const [path, config] of Object.entries(required.managedSections ?? {})) {
    const section = extractManagedSection(readFileSync(join(baseDir, path), "utf8"), config, path);
    result[`${path}#managed-section`] = sha256(section);
  }
  return result;
}

/**
 * 子仓是否需要一次同步。
 * - required-only：只看根级资产摘要（基座 sha 变化但资产未变时**不**产生噪声 PR）；
 * - full：还要求 `lastSyncedBaseSha` 与基座 HEAD 一致（运行时代码跟随基座发布点）。
 */
export function syncDrift({ state, mode = "required-only", baseSha, digests = {} }) {
  const reasons = [];
  if (!state) return { drift: true, reasons: ["子仓缺少 .workloom-base-sync.json（从未同步）"] };

  const recorded = new Map(Object.entries(state.requiredRootAssetsSha256 ?? {}));
  for (const [path, digest] of Object.entries(digests)) {
    const have = recorded.get(path);
    if (have !== digest) reasons.push(`根级资产漂移：${path}`);
  }
  if (mode === "full" && state.lastSyncedBaseSha !== baseSha) {
    reasons.push(`未同步基座版本：${(state.lastSyncedBaseSha ?? "从未同步").slice(0, 8)} → ${baseSha.slice(0, 8)}`);
  }
  return { drift: reasons.length > 0, reasons };
}

/** 在途同步 PR 判定：同一子仓已有一条 sync/base-* 的 open PR 时不再重复开门 */
export function hasInFlightSyncPull(pulls = [], prefix = SYNC_BRANCH_PREFIX) {
  return pulls.find((pull) => normalizeBranchRef(pull?.head?.ref).startsWith(prefix)) ?? null;
}

/**
 * 订阅子仓过滤：隔离副本（`sync/child-repos.json#isolatedRepos`）不参与任何下发。
 * 即使隔离仓被误写进 `children`，也在 fanout 入口被拦下——宁可少同步一个仓，也不把基座内容推给隔离副本。
 * @param {Array<{repo?: string}>} children
 * @param {Set<string>|string[]} isolated
 * @returns {{synced: object[], skipped: string[]}}
 */
export function syncedChildren(children = [], isolated = new Set()) {
  const isolatedSet = isolated instanceof Set ? isolated : new Set(isolated);
  const synced = [];
  const skipped = [];
  for (const child of children) {
    if (!child) continue;
    if (child.repo && isolatedSet.has(child.repo)) skipped.push(child.repo);
    else synced.push(child);
  }
  return { synced, skipped };
}
