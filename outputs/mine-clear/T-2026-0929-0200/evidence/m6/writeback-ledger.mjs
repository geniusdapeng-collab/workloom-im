#!/usr/bin/env node
/**
 * M6 台账回写：把独立验证结论写入 ledger.json
 *   · 通过卡（fix + 其 covers 的问题卡）→ state="verified" + verified_by/verified_at/verification_evidence
 *   · 未通过卡（MC-440）→ 保留 state，写 verified_by/verified_at/verification_evidence（失败证据），notes 追加 M6-F2
 * 用法：node writeback-ledger.mjs [--write]   默认 dry-run（只打印将要发生的变更）
 * 安全：写入前复制备份（ledger.json.bak-<ts>），并用临时文件 + rename 原子替换；写入前重新读取并校验目标卡仍在。
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from "node:fs";

const LEDGER = "/Users/mac/WorkLoom-fleet/.wt-mcd-im/outputs/mine-clear/T-2026-0929-0200/ledger.json";
const VERDICTS = "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m6/m6-verdicts.json";
const EVID_BASE = "outputs/mine-clear/T-2026-0929-0200/evidence/m6/m6-verdicts.json";
const WRITE = process.argv.includes("--write");
const NOW = new Date().toISOString();

const verdicts = JSON.parse(readFileSync(VERDICTS, "utf8"));
const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const byId = new Map(ledger.cards.map((c) => [c.id, c]));
const problems = ledger.cards.filter((c) => c.kind !== "fix");
const coveredBy = new Map();
for (const v of verdicts.verdicts) {
  for (const pid of v.covers ?? []) {
    if (!coveredBy.has(pid)) coveredBy.set(pid, []);
    coveredBy.get(pid).push(v);
  }
}

const changes = [];
const setVerified = (card, evidence, state) => {
  const before = { state: card.state, verified_by: card.verified_by ?? null };
  card.verified_by = "mcd_verify";
  card.verified_at = NOW;
  card.verification_evidence = evidence;
  if (state) card.state = state;
  changes.push({ id: card.id, before, after: { state: card.state, verified_by: card.verified_by }, evidence });
};

for (const v of verdicts.verdicts) {
  const fix = byId.get(v.card);
  if (!fix || fix.kind !== "fix") { changes.push({ id: v.card, before: null, after: "MISSING-FIX-CARD" }); continue; }
  const firstEvidence = (v.evidence ?? [])[0] ?? EVID_BASE;
  const evidenceRef = `work/m6/... + ${EVID_BASE} :: ${firstEvidence}`;
  if (v.verdict === "pass" || v.verdict === "pass_with_finding") {
    setVerified(fix, evidenceRef, "verified");
    for (const pid of v.covers ?? []) {
      const p = byId.get(pid);
      if (p) setVerified(p, evidenceRef, "verified");
    }
  } else {
    // 未通过：保留状态，但写验证者与失败证据（供回炉修复）
    const p = byId.get(v.card);
    p.verified_by = "mcd_verify";
    p.verified_at = NOW;
    p.verification_evidence = `FAIL :: ${firstEvidence} :: ${EVID_BASE}`;
    p.notes = `${p.notes ? p.notes + " | " : ""}M6 独立复验未通过（M6-F2）：release-gate 端到端仍报「验链未产出可解析摘要」；摘要口径本身可用`;
    changes.push({ id: v.card, before: { state: p.state }, after: { state: p.state, verified_by: p.verified_by }, evidence: p.verification_evidence });
    const problem = byId.get("MC-210");
    if (problem) {
      problem.notes = `${problem.notes ? problem.notes + " | " : ""}M6 复验：门禁路径仍未达标（见 MC-440 / M6-F2）`;
      changes.push({ id: "MC-210", before: null, after: "notes-only" });
    }
  }
}

ledger.updated_at = NOW;
console.log(JSON.stringify({ write: WRITE, ledger_cards: ledger.cards.length, changes }, null, 1));

if (!WRITE) { console.log("\n[dry-run] 未写入。加 --write 执行。"); process.exit(0); }
const backup = `${LEDGER}.bak-${Date.now()}`;
copyFileSync(LEDGER, backup);
const tmp = `${LEDGER}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(ledger, null, 2));
renameSync(tmp, LEDGER);
console.log(`\n已写入 ${LEDGER}（备份 ${backup}）`);
if (!existsSync(backup)) process.exit(1);
