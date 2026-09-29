#!/usr/bin/env node
/**
 * 舰队级合并执行器：门禁全绿即合，不等人工点击（协议 §1「合并在机器、串行执行、人保留叫停权」）。
 *
 * 两条车道，判定逻辑都在 sync/fanout-rules.mjs（纯函数、可单测）：
 *   ① 纯同步 PR（`autoMergeEligibility`）：源分支 `sync/base-*`（或存量 `docs/context-*`），
 *      改动文件全部落在非执行性资产白名单，非 WIP、无风险标签、全部门禁 success；
 *   ② 代码类 PR（`codeMergeEligibility`）：分支在任务/行业/实验/维护车道，全部门禁 success、
 *      平台可合并、非 WIP、无 `risk/review` / `risk/block` 标签、避开治理路径、且分支最近提交
 *      已过冷却期（默认 10 分钟，避免合并"会话仍在写"的 PR）。
 * 治理资产不进入两条无人值守车道；合并前重新核对源/目标 SHA 与资格。
 * 两条车道都遵守**串行**：同一仓库每轮最多合并一条代码类 PR，其余留待下一轮（先 rebase 再合）。
 *
 * 用法：
 *   node sync/merge-sync-prs.mjs [--only <slug[,slug]>] [--repo <slug>] [--dry-run]
 *                                [--merge-style squash|merge|rebase] [--json]
 *                                [--legacy-doc-sync] [--no-code]
 *                                [--min-head-age-minutes 10]
 *   --legacy-doc-sync：额外接受 2026-09-19 之前 `docs/context-*` 的文档分发分支，
 *   仅用于存量波次收口；新流程一律用 `sync/base-*`。
 *   --no-code：只跑同步车道（排障/回滚用）。
 * 环境：CNB_TOKEN（需对目标仓有合并权限）
 * 退出码：0 无失败；1 存在合并失败（门禁红/冲突/WIP/冷却期不算失败，只跳过）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTO_MERGE_ALLOWLIST,
  CODE_MERGE_BRANCH_PREFIXES,
  CODE_MERGE_MIN_HEAD_AGE_MS,
  autoMergeEligibility,
  codeMergeEligibility,
  LEGACY_SYNC_BRANCH_PREFIXES,
  SYNC_BRANCH_PREFIX,
  normalizeBranchRef,
} from "./fanout-rules.mjs";
import {
  api,
  compareCommits,
  getPull,
  getPullCommitStatuses,
  listPulls,
  mergePull,
  requireToken,
} from "../scripts/tools/cnb-api.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
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
  if (!compare.headSha || (pull.head?.sha && pull.head.sha !== compare.headSha)) {
    verdict.eligible = false;
    verdict.reasons.push("无法确认 PR 源分支与比较结果是同一提交");
  }
  return {
    number: Number(pull.number),
    title: pull.title,
    head: pull.head?.ref,
    headSha: compare.headSha,
    baseSha: pull.base?.sha ?? null,
    mergeable: pull.mergeable_state,
    commits: compare.totalCommits,
    files,
    statuses: statuses.map((status) => `${status.context ?? status.name}=${status.state ?? status.status}`),
    ...verdict,
  };
}

/** 取 PR 分支最近一次提交距今的毫秒数；取不到返回 null（冷却期判定会 fail-closed 拒绝）。 */
export function headAgeMsFromCommits(payload, now = Date.now()) {
  const list = Array.isArray(payload) ? payload : (payload?.data ?? []);
  let newest = 0;
  for (const item of list) {
    const iso = item?.commit?.committer?.date
      ?? item?.commit?.author?.date
      ?? item?.committer?.date
      ?? item?.created_at;
    const parsed = Date.parse(String(iso ?? ""));
    if (Number.isFinite(parsed)) newest = Math.max(newest, parsed);
  }
  return newest ? Math.max(0, now - newest) : null;
}

export async function inspectCode(slug, pull, options = {}) {
  const compare = await compareCommits(slug, `main...${pull.head?.ref ?? ""}`);
  const files = compare.files.map((file) => file.path);
  const statuses = normalizeStatuses(await getPullCommitStatuses(slug, pull.number));
  const headAgeMs = headAgeMsFromCommits(await api(slug, `/-/pulls/${Number(pull.number)}/commits`));
  const verdict = codeMergeEligibility({ pull, files, statuses, headAgeMs }, options);
  if (!compare.headSha || (pull.head?.sha && pull.head.sha !== compare.headSha)) {
    verdict.eligible = false;
    verdict.reasons.push("无法确认 PR 源分支与比较结果是同一提交");
  }
  return {
    number: Number(pull.number),
    title: pull.title,
    head: pull.head?.ref,
    headSha: compare.headSha,
    baseSha: pull.base?.sha ?? null,
    mergeable: pull.mergeable_state,
    lane: "code",
    commits: compare.totalCommits,
    files,
    statuses: statuses.map((status) => `${status.context ?? status.name}=${status.state ?? status.status}`),
    headAgeMinutes: Number.isFinite(headAgeMs) ? Math.round(headAgeMs / 60000) : null,
    ...verdict,
  };
}

/** 串行合并单条 PR：在合并前重新核对 HEAD、目标基线、标签、WIP、改动文件与门禁。 */
export async function mergeNow(report, slug, candidate, mergeStyle, lane, recheck = {}, services = {}) {
  const number = candidate.number;
  const title = candidate.title;
  const readPull = services.getPull ?? getPull;
  const readSync = services.inspectSync ?? inspect;
  const readCode = services.inspectCode ?? inspectCode;
  const executeMerge = services.mergePull ?? mergePull;
  try {
    const latest = await readPull(slug, number);
    if (latest?.state !== "open") {
      report.skipped.push({ repo: slug, number, title, lane, reasons: [`PR 状态已变为 ${latest?.state}`] });
      return;
    }
    const fresh = lane === "sync"
      ? await readSync(slug, latest, recheck.acceptPrefixes)
      : await readCode(slug, latest, recheck.codeOptions);
    const reasons = [...fresh.reasons];
    if (!candidate.headSha || fresh.headSha !== candidate.headSha) {
      reasons.push("源分支 HEAD 自入队后发生变化，需重跑门禁与候选判定");
    }
    if (normalizeBranchRef(fresh.head) !== normalizeBranchRef(candidate.head)) {
      reasons.push("源分支名称自入队后发生变化");
    }
    if (!candidate.baseSha || !fresh.baseSha || fresh.baseSha !== candidate.baseSha) {
      reasons.push("目标 main 的提交无法核对或自入队后发生变化");
    }
    if (!fresh.eligible || reasons.length) {
      report.skipped.push({ repo: slug, number, title, lane, reasons });
      return;
    }
    const result = await executeMerge(slug, number, {
      mergeStyle,
      // CNB 合并接口要求显式 commit_title；沿用舰队习惯的 `标题 (#编号)` 形式。
      commitTitle: `${String(title).trim()} (#${number})`,
    });
    const after = await readPull(slug, number);
    // CNB 的合并结果是 state=closed + is_merged=true（不是 state=merged），三选一判定。
    const merged = after?.is_merged === true || after?.state === "merged" || after?.mergeable_state === "merged";
    if (!merged) {
      report.failed.push({ repo: slug, number, lane, stage: "verify-merge", error: `合并后状态仍为 state=${after?.state ?? "unknown"} is_merged=${after?.is_merged}` });
      return;
    }
    report.merged.push({
      repo: slug,
      number,
      title,
      lane,
      mergedBy: (after?.merged_by ?? result?.merged_by)?.username ?? null,
      state: after?.mergeable_state ?? after?.state,
    });
  } catch (error) {
    report.failed.push({ repo: slug, number, lane, stage: "merge", error: String(error?.message ?? error).slice(0, 300) });
  }
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
  const skipCode = has("--no-code");
  const minHeadAgeArg = Number(arg("--min-head-age-minutes", String(CODE_MERGE_MIN_HEAD_AGE_MS / 60000)));
  const minHeadAgeMs = Number.isFinite(minHeadAgeArg) && minHeadAgeArg >= 0
    ? minHeadAgeArg * 60000
    : CODE_MERGE_MIN_HEAD_AGE_MS;
  const acceptPrefixes = legacyDocSync ? [SYNC_BRANCH_PREFIX, ...LEGACY_SYNC_BRANCH_PREFIXES] : [SYNC_BRANCH_PREFIX];

  const matchOnly = (repo) => !only.length || only.includes(repo);
  // 覆盖基座仓自身 + 全部子仓（同步车道历史上只扫子仓，代码车道两者都要）。
  const targets = single
    ? [single]
    : [fleet.baseRepo, ...fleet.children.map((child) => child.repo)].filter(matchOnly);
  if (!targets.length) throw new Error("没有匹配到任何目标仓");

  const report = {
    mergeStyle,
    dryRun,
    skipCode,
    minHeadAgeMinutes: minHeadAgeMs / 60000,
    merged: [],
    skipped: [],
    failed: [],
  };

  for (const slug of targets) {
    let pulls = [];
    try {
      pulls = await listPulls(slug, { state: "open", baseRef: "main" });
    } catch (error) {
      report.failed.push({ repo: slug, stage: "list-pulls", error: String(error?.message ?? error).slice(0, 300) });
      continue;
    }

    // ---- 车道 ① 纯同步 PR：立即合；非纯同步（如 -full 波次携带运行时代码）回落车道 ② ----
    const codeCandidates = [];
    for (const pull of pulls) {
      const headRef = normalizeBranchRef(pull?.head?.ref);
      const number = Number(pull.number);
      const isSyncLane = acceptPrefixes.some((prefix) => headRef.startsWith(prefix));

      if (isSyncLane) {
        let verdict;
        try {
          verdict = await inspect(slug, pull, acceptPrefixes);
        } catch (error) {
          report.failed.push({ repo: slug, number, stage: "inspect-sync", error: String(error?.message ?? error).slice(0, 300) });
          continue;
        }
        if (verdict.eligible) {
          if (dryRun) {
            report.merged.push({ repo: slug, number, title: verdict.title, dryRun: true, lane: "sync" });
          } else {
            await mergeNow(report, slug, verdict, mergeStyle, "sync", { acceptPrefixes });
          }
          continue;
        }
        if (skipCode) {
          report.skipped.push({ repo: slug, lane: "sync", ...verdict });
          continue;
        }
        // 非纯同步：按代码车道规则复核（门禁全绿 + 冷却期 + 风险标签 + 治理路径）
        try {
          const codeVerdict = await inspectCode(slug, pull, {
            minHeadAgeMs,
            branchPrefixes: [...CODE_MERGE_BRANCH_PREFIXES, SYNC_BRANCH_PREFIX, ...LEGACY_SYNC_BRANCH_PREFIXES],
            // 仅非执行性资产允许随波次无人值守合并；治理路径仍拦截。
            allowPaths: AUTO_MERGE_ALLOWLIST,
          });
          if (codeVerdict.eligible) {
            codeCandidates.push({ ...codeVerdict, lane: "code", fromSyncLane: true, recheckOptions: {
              minHeadAgeMs,
              branchPrefixes: [...CODE_MERGE_BRANCH_PREFIXES, SYNC_BRANCH_PREFIX, ...LEGACY_SYNC_BRANCH_PREFIXES],
              allowPaths: AUTO_MERGE_ALLOWLIST,
            } });
          } else {
            report.skipped.push({
              repo: slug,
              ...codeVerdict,
              reasons: [`非纯同步（${verdict.reasons[0] ?? "白名单外路径"}）`, ...codeVerdict.reasons],
            });
          }
        } catch (error) {
          report.failed.push({ repo: slug, number, stage: "inspect-code", error: String(error?.message ?? error).slice(0, 300) });
        }
        continue;
      }

      // ---- 车道 ② 代码类 PR：门禁全绿即合（同仓每轮最多一条，保持串行）----
      if (skipCode) continue;
      try {
        const codeVerdict = await inspectCode(slug, pull, { minHeadAgeMs });
        if (codeVerdict.eligible) codeCandidates.push(codeVerdict);
        else report.skipped.push({ repo: slug, ...codeVerdict });
      } catch (error) {
        report.failed.push({ repo: slug, number, stage: "inspect-code", error: String(error?.message ?? error).slice(0, 300) });
      }
    }
    const queue = codeCandidates.sort((a, b) => a.number - b.number);
    for (const item of queue.slice(1)) {
      report.skipped.push({ repo: slug, ...item, reasons: [`串行队列：本仓本轮轮到 #${queue[0].number}，其余等下一轮（先 rebase 再合）`] });
    }
    if (!queue.length) continue;
    const pick = queue[0];
    if (dryRun) {
      report.merged.push({ repo: slug, number: pick.number, title: pick.title, dryRun: true, lane: pick.lane ?? "code" });
      continue;
    }
    await mergeNow(report, slug, pick, mergeStyle, pick.lane ?? "code", {
      codeOptions: pick.recheckOptions ?? { minHeadAgeMs },
    });
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of report.merged) console.log(`✅ 合并 ${item.repo} #${item.number}${item.dryRun ? "（dry-run）" : ""}${item.lane ? `［${item.lane}］` : ""}：${String(item.title).slice(0, 60)}`);
    for (const item of report.skipped) console.log(`⏭️ 跳过 ${item.repo} #${item.number}${item.lane ? `［${item.lane}］` : ""}：${item.reasons.join("；")}`);
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
