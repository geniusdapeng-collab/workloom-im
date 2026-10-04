/** MC024 guards preserved while integrating MC033 media proof with the v2 shared journal. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget, LIVE_BUDGET_CAPS, normalizeBudgets } from "./budget.mjs";

function budget(t, caps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-budget-guards-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createBudget({ budgets: normalizeBudgets(caps).budgets, outDir: dir });
}
test("MC024 strict configuration: invalid limits, unsafe durations, malformed prices and empty intervals cannot silently widen quota", () => {
  for (const declared of [null, [], "budget", { maxLlmTokens: NaN }, { maxLlmTokens: Infinity }, { maxImages: -1 }, { maxImages: 1.5 }, { maxVideoSeconds: 12.5 }, { maxCostCny: NaN }, { minVideoSeconds: 16 }, { pricing: [] }, { pricing: null }, { pricing: { imageCny: -1 } }, { pricing: { unknown: 0 } }]) {
    assert.throws(() => normalizeBudgets(declared), /live\.budgets/);
  }
});
test("MC024 strict quota values: malformed identity, cross-modality quantities and fractional requested durations never admit a call", (t) => {
  const b = budget(t);
  for (const input of [
    { taskId: "../x", kind: "llm", tokens: 1 }, { taskId: "a\n", kind: "llm", tokens: 1 },
    { taskId: "a", kind: "llm", tokens: 1, units: 2 }, { taskId: "a", kind: "image", units: 1, tokens: 2 },
    { taskId: "a", kind: "video", units: 12, tokens: 2 }, { taskId: "a", kind: "video", units: 10.5 },
    { taskId: "a", kind: "image", units: -0 }, { taskId: "a", kind: "llm", tokens: 1, units: -0 },
  ]) assert.equal(b.reserve(input).allowed, false, JSON.stringify(input));
  assert.equal(b.summary().used.llmCalls, 0); assert.equal(b.summary().used.images, 0); assert.equal(b.summary().reservations.length, 0);
});
test("MC024 frozen cap and price references plus exact decimal and tiny estimates cannot grant hidden quota", (t) => {
  const b = budget(t, { maxImages: 3, maxCostCny: 0.3, pricing: { imageCny: 0.1 } });
  assert.throws(() => { b.pricing.imageCny = 0; }, TypeError);
  assert.throws(() => { b.summary().budgets.maxImages = 100; }, TypeError);
  assert.throws(() => { LIVE_BUDGET_CAPS.maxImages = 100; }, TypeError);
  assert.equal(b.reserve({ taskId: "exact", kind: "image", units: 3 }).allowed, true); assert.equal(b.summary().used.costCny, 0.3);
  assert.equal(b.reserve({ taskId: "extra", kind: "image", units: 1 }).allowed, false);
  const tiny = budget(t); tiny.reserve({ taskId: "tiny", kind: "llm", tokens: 3 }); assert.equal(tiny.summary().used.costCny, 0.000006);
});
test("MC024 settled known lower bound cannot erase an unknown aggregate or admit another modality", (t) => {
  const b = budget(t); const gate = b.reserve({ taskId: "partial", kind: "llm", tokens: 3 });
  b.commit({ taskId: "partial", reservationId: gate.reservationId, kind: "llm", tokens: 6, measured: false, status: "blocked" });
  assert.equal(b.summary().used.llmTokens, 6); assert.equal(b.summary().unmeasured.llmTokens, 6); assert.equal(b.summary().actual.llmTokens, 0);
  assert.equal(b.summary().measurementComplete, false); assert.equal(b.reserve({ taskId: "image", kind: "image", units: 1 }).allowed, false);
});
test("MC024 explicit empty supplier image result is measured; attempted zero-token LLM cannot claim complete usage", (t) => {
  const image = budget(t); image.reserve({ taskId: "empty", kind: "image", units: 1 });
  assert.equal(image.commit({ taskId: "empty", kind: "image", units: 0, measured: true, status: "failed" }).committed, true);
  assert.equal(image.summary().actual.images, 0); assert.equal(image.summary().measurementComplete, true);
  const llm = budget(t); llm.reserve({ taskId: "empty", kind: "llm", tokens: 1 });
  assert.equal(llm.commit({ taskId: "empty", kind: "llm", tokens: 0, measured: true, calls: 1 }).committed, false);
  assert.equal(llm.summary().measurementComplete, false); assert.equal(llm.summary().pending.llmTokens, 1);
});
test("MC024 evidence remains append-only across restart, and a conflicting configuration cannot reuse the run", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workloom-budget-restart-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { outDir: dir, runId: "synthetic-shared", budgets: normalizeBudgets({ maxImages: 1 }).budgets };
  const b = createBudget(options); b.reserve({ taskId: "image", kind: "image", units: 1 });
  const before = readFileSync(b.ledgerPath); const resumed = createBudget(options); assert.ok(readFileSync(b.ledgerPath).equals(before));
  assert.equal(resumed.reserve({ taskId: "other", kind: "image", units: 1 }).allowed, false);
  assert.throws(() => createBudget({ ...options, budgets: normalizeBudgets({ maxImages: 2 }).budgets }), /不一致/);
  mkdirSync(join(dir, "budget-summary.json")); assert.throws(() => b.persist());
});
