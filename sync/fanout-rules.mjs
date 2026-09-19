#!/usr/bin/env node
/**
 * 基座 fanout 与纯同步 PR 自动合并的**纯规则层**（无副作用，可单测）。
 *
 * 边界（与 docs/DEVELOPMENT-PROTOCOL.md §1/§9 一致）：
 *   · fanout 只负责“把基座根级资产的新版本变成子仓里的一条同步 PR”；
 *   · 自动合并只覆盖 **纯同步 PR**：分支名 `sync/base-*`，且改动文件全部落在根级受控
 *     资产白名单内、全部门禁 success。任何动到行业代码/行业语义/平台工程的 PR 都不自动合并。
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
 * 运行时代码的基座升级仍走“提 PR + 人合并”（协议 §1 硬规则）。
 */
export const AUTO_MERGE_ALLOWLIST = Object.freeze([
  "WORKLOOM_PRODUCT_CONTEXT.md",
  "AGENTS.md",
  "docs/DEVELOPMENT-PROTOCOL.md",
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
