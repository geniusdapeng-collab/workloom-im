#!/usr/bin/env node
/**
 * 纯同步 PR 自动合并器（舰队级）。
 *
 * 只合并同时满足以下条件的 PR（判定逻辑在 sync/fanout-rules.mjs，可单测）：
 *   ① 源分支是 `sync/base-*`（fanout 产出，或人工按同规范手工同步）；
 *   ② 改动文件全部落在根级受控资产白名单（全景认知 / 开发协议 / AGENTS / 同步登记）；
 *   ③ 该 PR 的**全部**状态检查都是 success，且平台可合并状态为 mergeable。
 *
 * 运行时代码升级（packages/**、apps/** 等）仍然只能人来合并——协议 §1「合并在人」对
 * 代码变更不变；本工具只把"文档与根级登记文件的搬运"变成无人值守。
 *
 * 用法：
 *   node scripts/tools/merge-sync-prs.mjs [--only <slug[,slug]>] [--repo <slug>] [--dry-run]
 *                                          [--merge-style squash|merge|rebase] [--json]
 *                                          [--legacy-doc-sync]
 *   --legacy-doc-sync：额外接受 2026-09-19 之前 `docs/context-*` 的文档分发分支，
 *   仅用于存量波次收口；新流程一律用 `sync/base-*`。
 * 环境：CNB_TOKEN（需对目标仓有合并权限）
 * 退出码：0 无失败；1 存在合并失败（门禁红/冲突不算失败，只跳过）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { autoMergeEligibility, LEGACY_SYNC_BRANCH_PREFIXES, SYNC_BRANCH_PREFIX } from "../../sync/fanout-rules.mjs";
import { compareCommits, getPull, getPullCommitStatuses, listPulls, mergePull, requireToken } from "./cnb-api.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

export function normalizeStatuses(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.statuses)) return payload.statuses;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function inspect(slug, pull, acceptPrefixes) {
  // 变更文件以 /git/compare 的完整路径为准（PR files 接口会丢目录）。
  const compare = await compareCommits(slug, `main...${pull.head?.ref ?? ""}`);
  const files = compare.files.map((file) => file.path);
  const statuses = normalizeStatuses(await getPullCommitStatuses(slug, pull.number));
  const verdict = autoMergeEligibility({
    pull: { ...pull, mergeable_state: pull.mergeable_state },
    files,
    statuses,
  }, { acceptPrefixes });
  return {
    number: Number(pull.number),
    title: pull.title,
    head: pull.head?.ref,
    mergeable: pull.mergeable_state,
    commits: compare.totalCommits,
    files,
    statuses: statuses.map((status) => `${status.context ?? status.name}=${status.state ?? status.status}`),
    ...verdict,
  };
}

async function main() {
  requireToken();
  const fleet = JSON.parse(readFileSync(join(REPO_ROOT, "sync/child-repos.json"), "utf8"));
  const only = arg("--only", "").split(",").map((item) => item.trim()).filter(Boolean);
  const single = arg("--repo");
  const dryRun = has("--dry-run");
  const json = has("--json");
  const mergeStyle = arg("--merge-style", "squash");
  const legacyDocSync = has("--legacy-doc-sync");
  const acceptPrefixes = legacyDocSync ? [SYNC_BRANCH_PREFIX, ...LEGACY_SYNC_BRANCH_PREFIXES] : [SYNC_BRANCH_PREFIX];

  const targets = single
    ? [single]
    : fleet.children.map((child) => child.repo).filter((repo) => !only.length || only.includes(repo));
  if (!targets.length) throw new Error("没有匹配到任何目标仓");

  const report = { mergeStyle, dryRun, merged: [], skipped: [], failed: [] };

  for (const slug of targets) {
    let pulls = [];
    try {
      pulls = await listPulls(slug, { state: "open", baseRef: "main" });
    } catch (error) {
      report.failed.push({ repo: slug, stage: "list-pulls", error: String(error?.message ?? error).slice(0, 300) });
      continue;
    }

    for (const pull of pulls) {
      const number = Number(pull.number);
      let verdict;
      try {
        verdict = await inspect(slug, pull, acceptPrefixes);
      } catch (error) {
        report.failed.push({ repo: slug, number, stage: "inspect", error: String(error?.message ?? error).slice(0, 300) });
        continue;
      }
      if (!verdict.eligible) {
        report.skipped.push({ repo: slug, ...verdict });
        continue;
      }

      if (dryRun) {
        report.merged.push({ repo: slug, number, title: verdict.title, dryRun: true });
        continue;
      }

      try {
        const latest = await getPull(slug, number);
        if (latest?.state !== "open") {
          report.skipped.push({ repo: slug, number, title: verdict.title, reasons: [`PR 状态已变为 ${latest?.state}`] });
          continue;
        }
        const result = await mergePull(slug, number, {
          mergeStyle,
          // CNB 合并接口要求显式 commit_title；沿用舰队习惯的 `标题 (#编号)` 形式。
          commitTitle: `${String(verdict.title).trim()} (#${number})`,
        });
        const after = await getPull(slug, number);
        // CNB 的合并结果是 state=closed + is_merged=true（不是 state=merged），三选一判定。
        const merged = after?.is_merged === true || after?.state === "merged" || after?.mergeable_state === "merged";
        if (!merged) {
          report.failed.push({ repo: slug, number, stage: "verify-merge", error: `合并后状态仍为 state=${after?.state ?? "unknown"} is_merged=${after?.is_merged}` });
          continue;
        }
        report.merged.push({
          repo: slug,
          number,
          title: verdict.title,
          mergedBy: (after?.merged_by ?? result?.merged_by)?.username ?? null,
          state: after?.mergeable_state ?? after?.state,
        });
      } catch (error) {
        report.failed.push({ repo: slug, number, stage: "merge", error: String(error?.message ?? error).slice(0, 300) });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of report.merged) console.log(`✅ 合并 ${item.repo} #${item.number}${item.dryRun ? "（dry-run）" : ""}：${String(item.title).slice(0, 60)}`);
    for (const item of report.skipped) console.log(`⏭️ 跳过 ${item.repo} #${item.number}：${item.reasons.join("；")}`);
    for (const item of report.failed) console.log(`❌ 失败 ${item.repo}${item.number ? ` #${item.number}` : ""}（${item.stage}）：${item.error}`);
    console.log(`\n合计：合并 ${report.merged.length} · 跳过 ${report.skipped.length} · 失败 ${report.failed.length}`);
  }
  if (report.failed.length) process.exitCode = 1;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`❌ 自动合并失败：${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

export { main };
