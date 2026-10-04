/** MC024 assertion-preserving v2 adaptation. Immutable original: prior/base/scripts/acceptance/lib/live/budget.test.mjs.
 * Explicit measured=true now required; v2 retries are ACKs, never new physical-call authority;
 * the journal recovers append-only instead of rejecting all restarts; corrupt journals make summary unreadable.
 * Every original test name and every quantity/cost/refusal boundary remains represented.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createBudget, normalizeBudgets, LIVE_BUDGET_CAPS } from "./budget.mjs";

function fixture(t, declared = {}) {
  const root = mkdtempSync(join(tmpdir(), "rdas-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = join(root, "run");
  return { root, outDir, budget: createBudget({ budgets: normalizeBudgets(declared).budgets, outDir }) };
}
const request = (taskId, tokens = 3) => ({ taskId, kind: "llm", tokens });
const settle = (budget, gate, taskId, actual) => budget.commit({ reservationId: gate.reservationId, taskId, kind: "llm", measured: actual.usageVerified !== false && Number.isSafeInteger(actual.tokens) && actual.tokens > 0, ...actual });

// Every accepted reservation is charged before a provider can start; each
// settlement belongs to one reservation, even if asynchronous jobs finish later.
describe("RDAS reservation and settlement", () => {
  it("sums per-call tokens and preserves failures without a settlement", (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 20 });
    for (const id of ["a", "b"]) {
      const gate = budget.reserve(request(id));
      assert.equal(gate.allowed, true);
      settle(budget, gate, id, { tokens: 3 });
    }
    budget.reserve(request("failed", 4));
    assert.equal(budget.summary().used.llmTokens, 10);
    assert.equal(budget.summary().used.llmCalls, 3);
    assert.deepEqual(budget.summary().accounting.pending, ["failed"]);
  });

  it("checks prospective totals and allows the exact cap", (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 5 });
    assert.equal(budget.reserve(request("oversized", 6)).allowed, false);
    const a = budget.reserve(request("a"));
    assert.equal(a.allowed, true);
    settle(budget, a, "a", { tokens: 3 });
    assert.equal(budget.reserve(request("b", 3)).allowed, false);
    assert.equal(budget.reserve(request("exact", 2)).allowed, true);
    assert.equal(budget.reserve(request("past", 1)).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 5);
  });

  it("reserves all concurrent calls before await and settles out of order", async (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 12, maxLlmCalls: 3 });
    const gates = await Promise.all(["a", "b", "c", "d"].map(async (id) => budget.reserve(request(id, 4))));
    assert.deepEqual(gates.map((g) => g.allowed), [true, true, true, false]);
    assert.equal(new Set(gates.slice(0, 3).map((g) => g.reservationId)).size, 3);
    assert.equal(budget.summary().used.llmTokens, 12);
    settle(budget, gates[2], "c", { tokens: 1 });
    settle(budget, gates[0], "a", { tokens: 4 });
    settle(budget, gates[1], "b", { tokens: 2 });
    assert.equal(budget.summary().used.llmTokens, 12);
    assert.equal(budget.summary().accounting.verified, true);
  });

  it("keeps the estimate after asynchronous provider failure", async (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 4 });
    const run = async () => {
      assert.equal(budget.reserve(request("failed", 4)).allowed, true);
      await Promise.resolve();
      throw new Error("local adapter fault");
    };
    await assert.rejects(run, /local adapter fault/);
    assert.equal(budget.summary().used.llmTokens, 4);
    assert.equal(budget.reserve(request("next", 1)).allowed, false);
    assert.equal(budget.summary().accounting.verified, false);
  });

  it("charges only a reservation's upward usage and cost delta, never refunds", (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 30, maxCostCny: 10, pricing: { llmCnyPer1kTokens: 1000 } });
    const a = budget.reserve(request("a", 2));
    const b = budget.reserve(request("b", 3));
    assert.equal(budget.summary().used.costCny, 5);
    assert.equal(settle(budget, b, "b", { tokens: 4, costCny: 6 }).allowed, true);
    settle(budget, a, "a", { tokens: 1, costCny: 0 });
    assert.equal(budget.summary().used.llmTokens, 6);
    assert.equal(budget.summary().used.costCny, 8);
  });

  it("deduplicates an exact settlement and rejects conflicting repeats", (t) => {
    const { budget } = fixture(t);
    const a = budget.reserve(request("a", 2));
    const before = settle(budget, a, "a", { tokens: 5, costCny: 1 });
    const repeated = settle(budget, a, "a", { tokens: 5, costCny: 1 });
    assert.equal(before.allowed, true);
    assert.equal(repeated.allowed, true);
    assert.equal(repeated.idempotent, true);
    assert.equal(budget.summary().used.llmTokens, 5);
    assert.equal(budget.summary().used.costCny, 1);
    assert.equal(settle(budget, a, "a", { tokens: 6, costCny: 2 }).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 5);
    const repeatedGate = budget.reserve(request("a", 2));
    assert.equal(repeatedGate.duplicate, true);
    assert.equal(repeatedGate.allowed && !repeatedGate.duplicate, false); // No second physical dispatch.
  });

  it("rejects free, forged, cross-task or cross-kind settlements", (t) => {
    const { budget } = fixture(t);
    assert.equal(budget.commit({ taskId: "free", kind: "llm", tokens: 3 }).allowed, false);
    const a = budget.reserve(request("a", 2));
    for (const input of [
      { reservationId: "missing", taskId: "a", kind: "llm", tokens: 4 },
      { reservationId: a.reservationId, taskId: "other", kind: "llm", tokens: 4 },
      { reservationId: a.reservationId, taskId: "a", kind: "image", units: 4 },
    ]) assert.equal(budget.commit(input).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 2);
    assert.equal(settle(budget, a, "a", { tokens: 3 }).allowed, true);
    assert.equal(budget.summary().used.llmTokens, 3);
  });

  it("charges actual overshoot, reports it, and blocks every future kind", (t) => {
    const { budget } = fixture(t, { maxLlmTokens: 5 });
    const a = budget.reserve(request("a", 3));
    assert.equal(settle(budget, a, "a", { tokens: 6 }).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 6);
    assert.equal(budget.summary().exceeded.length, 1);
    for (const input of [request("b", 1), { taskId: "image", kind: "image", units: 1 }, { taskId: "video", kind: "video", units: 10 }]) {
      assert.equal(budget.reserve(input).allowed, false);
    }
  });

  it("charges cost overshoot and denies later reservations", (t) => {
    const { budget } = fixture(t, { maxCostCny: 0.5 });
    const a = budget.reserve(request("a", 3));
    assert.equal(settle(budget, a, "a", { tokens: 3, costCny: 0.6 }).allowed, false);
    assert.equal(budget.summary().used.costCny, 0.6);
    assert.equal(budget.reserve(request("b", 1)).allowed, false);
  });

  it("missing or zero usage remains explicitly estimated and unverified", (t) => {
    const { budget } = fixture(t);
    const cases = [["missing", {}], ["zero", { tokens: 0 }], ["declared", { tokens: 3, usageVerified: false }]];
    const gates = cases.map(([id]) => budget.reserve(request(id)));
    for (const [index, [id, usage]] of cases.entries()) {
      assert.equal(settle(budget, gates[index], id, usage).usageVerified, false);
    }
    assert.equal(budget.reserve(request("after-unknown", 1)).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 9);
    assert.equal(budget.summary().accounting.mode, "estimated");
    assert.equal(budget.summary().accounting.verified, false);
    assert.deepEqual(budget.summary().accounting.unverified, ["missing", "zero", "declared"]);
  });

  it("validates malformed reservations without subtracting quota or cost", (t) => {
    const { budget } = fixture(t);
    for (const input of [
      {}, { taskId: "", kind: "llm", tokens: 1 }, { taskId: "../x", kind: "llm", tokens: 1 },
      { taskId: "a\n", kind: "llm", tokens: 1 }, { taskId: "a", kind: "unknown", units: 1 },
      ...[-1, 0, 0.5, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER + 1].map((tokens) => request("a", tokens)),
      ...[-1, 0, 1.5, NaN, Infinity, "1"].map((units) => ({ taskId: "a", kind: "image", units })),
      { taskId: "a", kind: "llm", tokens: 3, units: -1 },
      { taskId: "a", kind: "image", units: 1, tokens: 3 },
    ]) assert.equal(budget.reserve(input).allowed, false, JSON.stringify(input));
    assert.deepEqual(budget.summary().used, { llmCalls: 0, llmTokens: 0, images: 0, videoClips: 0, videoSeconds: 0, costCny: 0, wallClockMin: 0 });
    assert.equal(budget.reserve(request("中文-01", 1)).allowed, true);
  });

  it("rejects invalid settlement values but keeps the original reservation", (t) => {
    const { budget } = fixture(t);
    const a = budget.reserve(request("a", 3));
    for (const actual of [
      ...[-1, 0.5, NaN, Infinity, "3"].map((tokens) => ({ tokens })),
      ...[-1, NaN, Infinity, "1"].map((costCny) => ({ tokens: 3, costCny })),
    ]) assert.equal(settle(budget, a, "a", actual).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 3);
    assert.equal(settle(budget, a, "a", { tokens: 3 }).allowed, true);
  });
});

describe("all quota dimensions and immutable evidence", () => {
  it("every zero cap blocks the relevant action before usage is charged", (t) => {
    for (const [key, input] of [
      ["maxLlmCalls", request("a")], ["maxLlmTokens", request("a")],
      ["maxImages", { taskId: "a", kind: "image", units: 1 }],
      ["maxVideoClips", { taskId: "a", kind: "video", units: 10 }],
      ["maxVideoSecondsTotal", { taskId: "a", kind: "video", units: 10 }],
      ["maxCostCny", request("a")], ["maxWallClockMin", request("a")],
    ]) {
      const { budget } = fixture(t, { [key]: 0 });
      assert.equal(budget.reserve(input).allowed, false, key);
      assert.equal(budget.summary().used.costCny, 0);
      assert.equal(budget.summary().used.llmCalls, 0);
    }
  });

  it("allows an exact decimal cost boundary and keeps small costs visible", (t) => {
    const { budget } = fixture(t, { maxCostCny: 0.3, pricing: { imageCny: 0.1 } });
    assert.equal(budget.reserve({ taskId: "a", kind: "image", units: 3 }).allowed, true);
    assert.equal(budget.summary().used.costCny, 0.3);
    assert.equal(budget.reserve({ taskId: "b", kind: "image", units: 1 }).allowed, false);
    const tiny = fixture(t).budget;
    tiny.reserve(request("a", 3));
    assert.equal(tiny.summary().used.costCny, 0.000006);
  });

  it("checks image count, video clip/seconds and the 10-15 second range", (t) => {
    const { budget } = fixture(t, { maxImages: 3, maxVideoClips: 3, maxVideoSecondsTotal: 32 });
    const image = budget.reserve({ taskId: "image", kind: "image", units: 3 });
    assert.equal(image.allowed, true);
    budget.commit({ reservationId: image.reservationId, taskId: "image", kind: "image", units: 2, measured: true });
    assert.equal(budget.reserve({ taskId: "past-image", kind: "image", units: 1 }).allowed, false);
    for (const units of [-1, 0, 9, 16, 32, 10.5, Infinity]) {
      assert.equal(budget.reserve({ taskId: `bad-${String(units)}`, kind: "video", units }).allowed, false);
    }
    for (const [id, units] of [["a", 10], ["b", 12], ["c", 10]]) {
      assert.equal(budget.reserve({ taskId: id, kind: "video", units }).allowed, true);
    }
    assert.equal(budget.reserve({ taskId: "past-video", kind: "video", units: 10 }).allowed, false);
    assert.equal(budget.summary().used.videoSeconds, 32);
    assert.equal(budget.summary().used.videoClips, 3);
    assert.equal(budget.summary().used.images, 3);
  });

  it("records actual generated counts/duration over estimate and trips limits", (t) => {
    for (const kind of ["image", "video"]) {
      const root = mkdtempSync(join(tmpdir(), `rdas-${kind}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const budget = createBudget({ budgets: normalizeBudgets({ maxImages: 2 }).budgets, outDir: root });
      const units = kind === "image" ? 2 : 10;
      const gate = budget.reserve({ taskId: kind, kind, units });
      assert.equal(budget.commit({ reservationId: gate.reservationId, taskId: kind, kind, units: kind === "image" ? 3 : 16, measured: true }).allowed, false);
      assert.equal(budget.summary().used[kind === "image" ? "images" : "videoSeconds"], kind === "image" ? 3 : 16);
    }
  });

  it("uses a strict wall clock boundary, retains started tasks on late settlement", (t) => {
    const realNow = Date.now;
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const { budget } = fixture(t, { maxWallClockMin: 1 });
    const a = budget.reserve(request("a"));
    now += 60_000;
    assert.equal(budget.reserve(request("boundary")).allowed, false);
    assert.equal(settle(budget, a, "a", { tokens: 4 }).allowed, false);
    assert.equal(budget.summary().used.llmTokens, 4);
    assert.equal(typeof realNow(), "number");
  });

  it("never overwrites a previous run's append-only ledger", (t) => {
    const { budget, outDir } = fixture(t);
    const a = budget.reserve(request("a"));
    settle(budget, a, "a", { tokens: 3 });
    budget.persist();
    const before = readFileSync(budget.ledgerPath, "utf8");
    const resumed = createBudget({ budgets: normalizeBudgets().budgets, outDir });
    assert.equal(resumed.summary().used.llmTokens, 3);
    assert.equal(resumed.reserve(request("a")).duplicate, true);
    assert.equal(readFileSync(budget.ledgerPath, "utf8"), before);
    const allRows = before.trim().split("\n").map(JSON.parse);
    assert.equal(allRows[0].event, "budget-init");
    const rows = allRows.filter((row) => row.event !== "budget-init");
    assert.equal(rows[0].event, "reserve");
    assert.equal(rows[1].event, "commit");
    assert.equal(rows[0].reservationId, rows[1].reservationId);
    assert.equal(rows[0].tokens, 3);
    assert.equal(rows[1].tokens, 3);
    assert.equal(rows[1].measured, true);
    assert.equal(JSON.parse(readFileSync(join(outDir, "budget-summary.json"), "utf8")).used.llmTokens, 3);
  });

  it("fails closed if the audit journal cannot be written", (t) => {
    const { budget } = fixture(t);
    renameSync(budget.ledgerPath, `${budget.ledgerPath}.old`);
    mkdirSync(budget.ledgerPath);
    assert.throws(() => budget.reserve(request("a")), /普通文件|EISDIR/);
    assert.throws(() => budget.summary(), /普通文件|EISDIR/); // No fabricated zero summary.
    assert.throws(() => budget.reserve(request("b")), /普通文件|EISDIR/);
    assert.throws(() => budget.persist(), /普通文件|EISDIR/);
    assert.equal(readFileSync(`${budget.ledgerPath}.old`, "utf8").trim().split("\n").length, 1);
  });

  it("does not dispatch when filesystem permissions deny the journal", (t) => {
    const { budget } = fixture(t);
    chmodSync(budget.ledgerPath, 0);
    try {
      assert.throws(() => budget.reserve(request("a")), /权限|EACCES|EPERM/);
      assert.throws(() => budget.summary(), /权限|EACCES|EPERM/);
      assert.throws(() => budget.reserve(request("b")), /权限|EACCES|EPERM/);
    } finally {
      chmodSync(budget.ledgerPath, 0o600);
    }
  });

  it("fails visibly on summary persistence errors", (t) => {
    const { budget, outDir } = fixture(t);
    mkdirSync(join(outDir, "budget-summary.json"));
    assert.throws(() => budget.persist(), /EISDIR|ENOTDIR/);
  });

  it("does not let a caller mutate cap/pricing/summary objects to grant quota", (t) => {
    const declared = { maxLlmTokens: 3, pricing: { llmCnyPer1kTokens: 10 } };
    const { budget } = fixture(t, declared);
    declared.maxLlmTokens = 300_000;
    declared.pricing.llmCnyPer1kTokens = 0;
    const snapshot = budget.summary();
    assert.throws(() => { snapshot.budgets.maxLlmTokens = 300_000; }, TypeError);
    assert.throws(() => { budget.pricing.llmCnyPer1kTokens = 0; }, TypeError);
    snapshot.blocked.push({ taskId: "foreign", reason: "not a real denial" });
    assert.equal(budget.summary().blocked.length, 0);
    budget.reserve(request("a"));
    assert.equal(budget.reserve(request("b", 1)).allowed, false);
    assert.equal(budget.summary().used.costCny, 0.03);
  });
});

describe("configuration is finite, nonnegative, integral where metered, and only tighter", () => {
  it("clamps attempted relaxation and preserves valid stricter settings", () => {
    const { budgets, warnings } = normalizeBudgets({ maxLlmCalls: 100, maxLlmTokens: 6, minVideoSeconds: 1, pricing: { imageCny: 1 } });
    assert.equal(budgets.maxLlmCalls, LIVE_BUDGET_CAPS.maxLlmCalls);
    assert.equal(budgets.maxLlmTokens, 6);
    assert.equal(budgets.minVideoSeconds, LIVE_BUDGET_CAPS.minVideoSeconds);
    assert.equal(budgets.pricing.imageCny, 1);
    assert.equal(warnings.length, 2);
  });

  it("rejects invalid limits/prices and contradictory duration ranges", () => {
    for (const value of [-1, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizeBudgets({ maxLlmTokens: value }), /live\.budgets/);
    }
    assert.throws(() => normalizeBudgets({ maxImages: 1.5 }), /live\.budgets/);
    for (const value of [-1, NaN, Infinity, "1"]) {
      assert.throws(() => normalizeBudgets({ pricing: { imageCny: value } }), /pricing/);
    }
    assert.throws(() => normalizeBudgets({ minVideoSeconds: 16 }), /区间/);
    assert.throws(() => normalizeBudgets(null), /live\.budgets/);
  });

  it("revalidates direct createBudget inputs instead of trusting an alleged normalized cap", (t) => {
    const root = mkdtempSync(join(tmpdir(), "rdas-config-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.throws(() => createBudget({ budgets: { ...LIVE_BUDGET_CAPS, maxCostCny: NaN }, outDir: root }), /live\.budgets/);
  });
});
