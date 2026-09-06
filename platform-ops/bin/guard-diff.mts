#!/usr/bin/env node
/**
 * guard-diff —— CI 第一道闸：保护清单校验 + 变更分级（对焦方案 §2.3/§2.4 G1 前置）
 *
 * 用法：pnpm exec tsx platform-ops/bin/guard-diff.mts [--base origin/main] [--head HEAD]
 * 退出码：0=放行（含需审批的级别提示）；1=保护清单违例（deny，CI 红）
 * 审批人数/冷静期经由输出 JSON 提示，由 PR 流程（CODEOWNERS/评审）执行。
 */
import { execFileSync } from "node:child_process";
import { guardDiff, aggregateVerdicts, loadProtectedPaths } from "../src/safety/protected-paths.js";
import { classifyChange } from "../src/safety/change-classifier.js";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const base = opt("--base", "origin/main");
const head = opt("--head", "HEAD");

const raw = execFileSync("git", ["diff", "--name-status", `${base}...${head}`], { encoding: "utf-8" }).trim();
const numstat = execFileSync("git", ["diff", "--numstat", `${base}...${head}`], { encoding: "utf-8" }).trim();
const statMap = new Map(numstat ? numstat.split("\n").map((l) => { const [a, d, p] = l.split("\t"); return [p, { added: Number(a) || 0, deleted: Number(d) || 0 }]; }) : []);
const kindMap = { A: "added", M: "modified", D: "deleted", R: "renamed" };
const files = raw ? raw.split("\n").map((l) => {
  const [k, p] = l.split("\t");
  const s = statMap.get(p) ?? { added: 0, deleted: 0 };
  return { path: p, kind: kindMap[k?.[0]] ?? "modified", addedLines: s.added, deletedLines: s.deleted };
}) : [];

const doc = loadProtectedPaths("safety/protected-paths.json");
const verdicts = guardDiff(doc, files);
const agg = aggregateVerdicts(verdicts);
const cls = classifyChange(files);

const report = { files: files.length, classification: cls, guard: agg, verdicts };
console.log(JSON.stringify(report, null, 2));
if (agg.action === "deny") {
  console.error(`🛡 保护清单违例：${agg.reason}`);
  process.exit(1);
}
if (agg.action === "require") {
  console.log(`🛡 命中保护清单「${agg.entry}」：最低 ${agg.minLevel} 级 / ${agg.approvers} 人审${agg.coolingHours ? ` / ${agg.coolingHours}h 冷静期` : ""}`);
}
console.log(`变更分级：${cls.level}（${cls.reasons.join("；") || "无特殊命中"}）`);
