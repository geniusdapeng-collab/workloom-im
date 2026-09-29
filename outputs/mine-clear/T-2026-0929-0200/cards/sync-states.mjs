/**
 * 台账状态对齐：把已被修复卡覆盖的问题卡标为 fixed，并补上 regression（修完凭什么说修好了）。
 * 用法：node outputs/mine-clear/T-2026-0929-0200/cards/sync-states.mjs
 * 说明：verified 状态由独立验证会话产出后再写入（本脚本不写 verified）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const ledgerPath = new URL("../ledger.json", import.meta.url).pathname;
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));

const fixes = ledger.cards.filter((c) => c.kind === "fix");
const coveredByFix = new Map();
for (const fix of fixes) {
  for (const problemId of fix.covers ?? []) coveredByFix.set(problemId, fix);
}

let updated = 0;
for (const card of ledger.cards) {
  if (card.kind !== "problem") continue;
  const fix = coveredByFix.get(card.id);
  if (!fix) continue;
  const assertion = (fix.assertions ?? []).find((a) => a.last_result === "pass") ?? (fix.assertions ?? [])[0];
  if (!assertion?.command) continue;
  card.state = "fixed";
  card.regression = {
    command: assertion.command,
    evidence: assertion.evidence ?? fix.regression?.evidence ?? "",
  };
  card.notes = (card.notes ? card.notes + " | " : "") + `已由 ${fix.id}（${fix.fixed_by}）修复，修复提交见修复卡 evidence。`;
  updated += 1;
}

writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
console.log(`已对齐 ${updated} 张问题卡状态为 fixed（含 regression）`);
