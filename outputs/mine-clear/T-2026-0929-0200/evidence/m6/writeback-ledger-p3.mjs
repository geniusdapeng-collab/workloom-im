#!/usr/bin/env node
/**
 * M6 phase-3（fix 批 F / R2 复验）台账回写：
 *   · MC-461..468（fix）与其 covers 的 MC-501..508（problem）→ verified（独立复验证据）
 *   · MC-440 / MC-210（验链摘要门禁端到端）→ verified（F2 修复后我复跑真门禁通过）
 *   · 新增 MC-509（M6-F3：m2-01 断言与上游 kind 标记漂移，待修断言）→ open
 * 用法：node writeback-ledger-p3.mjs [--write]（默认 dry-run）
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";

const LEDGER = "/Users/mac/WorkLoom-fleet/.wt-mcd-im/outputs/mine-clear/T-2026-0929-0200/ledger.json";
const WRITE = process.argv.includes("--write");
const NOW = new Date().toISOString();
const EVID = "outputs/mine-clear/T-2026-0929-0200/evidence/m6/evidence-phase3";

const PAIRS = [
  ["MC-461", "MC-501", "m6-p3-01-suite-fresh.log", "套件 470/470（全新库）"],
  ["MC-462", "MC-502", "m6-p3-06b-root-test-db.log", "RUN_DB_TESTS=1 pnpm test 全绿（base 823 / runtime 49 / server 306）"],
  ["MC-463", "MC-503", "m6-p3-03b-wizard-fixed.log", "向导后价带 4 档保留且同目标 completed（R1 自动）"],
  ["MC-464", "MC-504", "m6-p3-04-gate-anomalous.log", "真门禁 T-03 报「验链失败：499700 处异常（13 段/102545 条事件）+类型直方图」"],
  ["MC-465", "MC-505", "m6-p3-07-axe.log", "/memory axe：critical/serious=0、select-name=0"],
  ["MC-466", "MC-506", "m6-p3-07b-brake.log", "制动链路 11/11（出征→可执行→确认→paused→事件留痕）"],
  ["MC-467", "MC-507", "m6-p3-02-suite-with-leftovers.log", "注入 25 条遗留 L2 后套件仍 470/470，遗留行保持 pending"],
  ["MC-468", "MC-508", "m6-p3-05-outcome-no-pollution.log", "污染库同任务 pass@1=1；无关 L4 行保持 pending/tier 不变"],
];

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const byId = new Map(ledger.cards.map((c) => [c.id, c]));
const changes = [];

const setVerified = (card, evidence, note) => {
  const before = card.state;
  card.state = "verified";
  card.verified_by = "mcd_verify";
  card.verified_at = NOW;
  card.verification_evidence = evidence;
  if (note) card.notes = `${card.notes ? card.notes + " | " : ""}${note}`;
  changes.push({ id: card.id, before, after: card.state });
};

for (const [fixId, probId, log, note] of PAIRS) {
  const evidence = `${EVID}/${log} + evidence/m6/m6-verdicts.json`;
  const fix = byId.get(fixId); const prob = byId.get(probId);
  if (fix) setVerified(fix, evidence, `M6 phase-3 独立复验：${note}`);
  if (prob) setVerified(prob, evidence, `M6 phase-3 独立复验：${note}`);
}

// 旧卡：验链摘要门禁端到端（MC-440 修卡 / MC-210 问题卡）
const chainEvidence = `${EVID}/m6-p3-04-gate-anomalous.log`;
for (const id of ["MC-440", "MC-210"]) {
  const c = byId.get(id);
  if (c) setVerified(c, chainEvidence, "M6 phase-3 复验：真门禁已报「N 处异常」而非工具故障（原 M6-F2 关闭）");
}

// 新发现：断言漂移（M6-F3）
if (!byId.has("MC-509")) {
  const template = byId.get("MC-501") ?? {};
  const card = {
    id: "MC-509",
    kind: "problem",
    level: "L2",
    severity: "P2",
    batch: 2,
    state: "open",
    title: "m2-01 断言与上游挂起标记漂移：basis 前缀被 decision.kind=review 取代（假红）",
    evidence: [
      { type: "code", ref: "packages/runtime/src/loop.ts:350@31282ce", note: "N-08：挂起/熔断/执行的区分只认显式 kind（block/review/execute），历史事件才回落 basis 前缀" },
      { type: "code", ref: "packages/runtime/src/loop.ts:946@31282ce", note: "W-01 缺参数分支文案为「围栏无法求值（缺参数，未按熔断处理）→ 一律人工裁决」，不再带「越围栏挂起：」前缀" },
      { type: "log", ref: `${EVID}/exp-m2-01-bands2.log`, note: "全新库、价带在位的条件下，挂起事件 kind=review 且 basis 无前缀 → m2-01「basis 标注越围栏挂起」判红（20/21）" },
      { type: "log", ref: "outputs/mine-clear/T-2026-0929-0200/evidence/m6/evidence-clean/m6-a08-m2-01-main-loop.log", note: "修复前（388c8c8）：同脚本同标题 21/21 —— 差异来自上游合并后的标记口径" },
    ],
    root_cause: { file: "scripts 断言（outputs 内探针）", line: 0, commit: "31282ce", symbol: "m2-01-main-loop.mjs#挂起事件落账" },
    trigger_path: "M2 探针复跑 → 挂起事件以 decision.kind=review 落账 → 断言仍按 basis.startsWith('越围栏挂起：') 判定 → 假红",
    assertions: [
      {
        kind: "sample",
        given: "全新库 + 出厂价带 + 目标「把周五主打款调价 5%」",
        expect: "挂起事件的 decision.kind === 'review'（或保留「越围栏挂起：」前缀），且线程 pending_review",
        command: "M2_REPO=<repo> M2_BASE=<base> M2_ENV_FILE=<env> node outputs/mine-clear/T-2026-0929-0200/assertions/m2-01-main-loop.mjs",
        last_result: "fail",
      },
      {
        kind: "property",
        given: "任意挂起事件（review/block）",
        expect: "replay 的 done 集合必须排除该步骤（不因 basis 文案变化而误判完成）",
        command: "同上 + m2-05 C3（无回执重跑仍 failed）",
        last_result: "pass",
        evidence: `${EVID}/m6-p3-08-m2-05-c3.log`,
      },
    ],
    notes: `M6 phase-3 发现（2026-09-30 07:0x）：产品语义未回退（loop.ts:350 已按 kind 判定，m2-05 C3 通过）；需更新冻结断言接受 kind=review，或恢复 W-01 分支前缀。${template.id ? "" : ""}`,
  };
  ledger.cards.push(card);
  changes.push({ id: "MC-509", before: null, after: "open" });
} else {
  // 幂等修补：补齐断言证据路径（门禁要求 last_result=pass 必须有 evidence）
  const existing = byId.get("MC-509");
  const prop = (existing.assertions ?? [])[1];
  if (prop && !prop.evidence) {
    prop.evidence = `${EVID}/m6-p3-08-m2-05-c3.log`;
    changes.push({ id: "MC-509", before: prop.last_result, after: "evidence-filled" });
  }
  // 交接单要求未闭环卡必须有可运行的回归路径
  if (!existing.regression?.command) {
    existing.regression = {
      command: "M2_REPO=<repo> M2_BASE=<base> M2_ENV_FILE=<env> node outputs/mine-clear/T-2026-0929-0200/assertions/m2-01-main-loop.mjs（更新断言接受 decision.kind=review 后应 21/21）",
      evidence: `${EVID}/exp-m2-01-bands2.log`,
    };
    changes.push({ id: "MC-509", before: null, after: "regression-filled" });
  }
}

ledger.updated_at = NOW;
console.log(JSON.stringify({ write: WRITE, cards: ledger.cards.length, changes }, null, 1));
if (!WRITE) { console.log("\n[dry-run] 未写入。加 --write 执行。"); process.exit(0); }
const backup = `${LEDGER}.bak-p3-${Date.now()}`;
copyFileSync(LEDGER, backup);
const tmp = `${LEDGER}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(ledger, null, 2));
renameSync(tmp, LEDGER);
console.log(`\n已写入（备份 ${backup}）`);
