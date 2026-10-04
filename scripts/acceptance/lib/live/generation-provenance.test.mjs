/** Source-classification counterexamples only; all CLI transports and credentials here are synthetic. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget, normalizeBudgets } from "./budget.mjs";
import { buildLiveChecks } from "./checks.mjs";
import { fixture as cliFixture } from "./cli-fixtures.mjs";

const options = { reportPath: "live/live-report.json", outputPaths: ["live/budget-ledger.jsonl", "live/budget-summary.json"], secretScan: { passed: true }, requestedTaskIds: ["LLM-R1"] };
function observed(t) {
  const dir = mkdtempSync(join(tmpdir(), "mc033-provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runId = `live-${randomUUID()}`;
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const budget = createBudget({ budgets: normalizeBudgets({}).budgets, outDir: dir, environmentKind: "deployed", runId });
  assert.equal(budget.reserve({ taskId: "LLM-R1", kind: "llm", tokens: 8 }).allowed, true);
  assert.equal(budget.commit({ taskId: "LLM-R1", kind: "llm", tokens: 8, measured: true }).committed, true);
  const stamp = new Date().toISOString();
  return {
    at: stamp, startedAt, runId, selftest: false,
    environment: { kind: "deployed", targetDeclaredExplicitly: true, declaredTarget: true, urls: { api: "https://production.example.invalid" } },
    fingerprint: { repo: { commit: "a".repeat(40), dirty: false, dataMode: "simulated" }, targetProbe: { ok: true } },
    models: [{ id: "reasoning", kind: "llm", model: "observed-model" }], budget: budget.summary(),
    summary: { failedIds: [], blockedIds: [] }, verdict: "pass",
    tasks: [{ id: "LLM-R1", kind: "llm", purpose: "reasoning", selftest: false, status: "ok", called: true,
      modelResolved: "observed-model", modelExpected: "observed-model", answer: "TASK_COMPLETE", tokens: 8,
      verification: { ok: true }, usage: { complete: true }, receipt: { id: "observed-request", model: "observed-model", tokens: 8, synced: true, usageComplete: true, verified_at: stamp },
      receiptPath: "live/receipts/LLM-R1.json", transcriptPath: "live/transcripts/LLM-R1.json" }],
  };
}

function allUnverified(checks, evidenceType) {
  assert.equal(checks.length, 18);
  for (const check of checks) {
    assert.equal(check.status, "unverified", check.id);
    assert.equal(check.pass, null, check.id);
    assert.equal(check.productionEvidence, false, check.id);
    if (evidenceType) assert.equal(check.evidenceType, evidenceType, check.id);
  }
}

for (const declaration of ["evidenceMode", "evidenceType", "productionEvidence"]) {
  test(`P provenance: ${declaration} negative declaration cannot be promoted by handwritten ok tasks and verdict pass`, (t) => {
    const report = observed(t);
    report[declaration] = declaration === "evidenceMode" ? "synthetic" : declaration === "evidenceType" ? "synthetic-transport" : false;
    allUnverified(buildLiveChecks(report, options), declaration === "productionEvidence" ? null : "synthetic-transport");
  });
}

for (const [label, mutate] of [
  ["no invocation", (report) => { report.tasks[0].called = false; }],
  ["no run identity", (report) => { delete report.runId; }],
  ["a different budget run", (report) => { report.budget.runId = `live-${randomUUID()}`; }],
  ["no start time", (report) => { delete report.startedAt; }],
  ["stale receipt", (report) => { report.tasks[0].receipt.verified_at = "2000-01-01T00:00:00.000Z"; }],
  ["no target proof", (report) => { report.fingerprint.targetProbe.ok = false; }],
  ["dirty code", (report) => { report.fingerprint.repo.dirty = true; }],
  ["incomplete metering", (report) => { report.tasks[0].usage.complete = false; }],
  ["unverified settlement", (report) => { report.budget.reservations[0].settlement.measured = false; }],
  ["missing verification", (report) => { report.tasks[0].verification.ok = false; }],
  ["missing actual model", (report) => { report.tasks[0].modelResolved = null; }],
  ["a mismatched receipt model", (report) => { report.tasks[0].receipt.model = "another-model"; }],
]) {
  test(`P provenance: an unmarked deployed report with ${label} has no production observations`, (t) => {
    const report = observed(t); mutate(report);
    allUnverified(buildLiveChecks(report, options), "unverified-production");
  });
}

test("P provenance: real metered reasoning observations survive business simulated data and do not fan out to missing capabilities", (t) => {
  const checks = buildLiveChecks(observed(t), options);
  for (const id of ["P0-01", "P0-02", "P2-01", "P3-01"]) {
    const check = checks.find((item) => item.id === id);
    assert.equal(check.status, "pass", id); assert.equal(check.productionEvidence, true, id); assert.equal(check.evidenceType, "production-observation", id);
  }
  for (const id of ["P1-01", "P1-02", "P2-02", "P2-03", "P2-04", "P2-05", "P2-06"]) {
    const check = checks.find((item) => item.id === id);
    assert.equal(check.status, "unverified", id); assert.equal(check.productionEvidence, false, id);
  }
});

test("P provenance: a completed measured task remains observed when a different task has unknown usage", (t) => {
  const report = observed(t);
  report.verdict = "blocked"; report.summary.blockedIds = ["IMG-01"];
  report.tasks.push({ id: "IMG-01", kind: "image", status: "blocked", called: true, selftest: false, measurementComplete: false });
  report.budget.measurementComplete = false; report.budget.frozenBy = [{ taskId: "IMG-01", reason: "unknown image quantity" }];
  const checks = buildLiveChecks(report, { ...options, requestedTaskIds: ["LLM-R1", "IMG-01"] });
  const reasoning = checks.find((check) => check.id === "P2-01");
  assert.equal(reasoning.status, "pass"); assert.equal(reasoning.productionEvidence, true);
  for (const id of ["P2-04", "P3-01"]) {
    const check = checks.find((item) => item.id === id);
    assert.equal(check.status, "unverified", id); assert.equal(check.productionEvidence, false, id);
  }
});

test("P provenance: a valid task cannot excuse a contradictory aggregate pass with a missing task receipt", (t) => {
  const report = observed(t);
  report.summary.blockedIds = ["IMG-01"];
  report.tasks.push({ id: "IMG-01", kind: "image", status: "blocked", called: false, selftest: false });
  const checks = buildLiveChecks(report, { ...options, requestedTaskIds: ["LLM-R1", "IMG-01"] });
  const truth = checks.find((check) => check.id === "P3-03");
  assert.equal(truth.status, "fail"); assert.equal(truth.productionEvidence, true);
  assert.equal(checks.find((check) => check.id === "P2-04").status, "unverified");
});

async function cli(t, label, { declaredSynthetic, allowWrites }) {
  const calls = { health: 0, chat: 0, image: 0, video: 0, auth: 0, dispatch: 0 };
  const server = createServer(async (req, res) => {
    for await (const _bytes of req) { /* Consume the finite synthetic request without logging its body. */ }
    const key = req.url === "/health" ? "health" : /chat\/completions/u.test(req.url) ? "chat" : /images\/generations/u.test(req.url) ? "image" : /contents\/generations/u.test(req.url) ? "video" : /auth\.loginAs/u.test(req.url) ? "auth" : /threads\.dispatch/u.test(req.url) ? "dispatch" : null;
    if (key) calls[key] += 1;
    res.writeHead(key === "health" ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(key === "health" ? { ok: true } : { error: "No paid or product request is authorized by this fixture" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const f = cliFixture(t, { dataMode: "simulated", environment: { kind: "deployed", target: { apiUrl: url }, timeouts: { healthMs: 500 } },
    live: { enabled: true, ...(declaredSynthetic ? { evidenceMode: "synthetic" } : {}), models: [], tasks: [{ id: "PROD-01", kind: "product", title: "FIXTURE read-only classification", input: "FIXTURE read-only classification", fixtureMarker: "FIXTURE", residualDisclosure: "synthetic temporary repository" }] } });
  const argv = [join(f.repo, "scripts/acceptance/live.mjs"), "--out", f.out, "--no-auto-keys", "--no-keys-from-client", "--require-live", ...(allowWrites ? ["--allow-prod-writes"] : [])];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: f.repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.repo, NODE_PATH: process.env.NODE_PATH ?? "" } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("synthetic provenance CLI timeout")); }, 30_000);
    child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, argv }); });
  });
  const report = JSON.parse(readFileSync(join(f.out, "live-report.json"), "utf8"));
  const root = process.env.RDAS_GENERATION_EVIDENCE_DIR;
  if (root) {
    const dir = join(root, `provenance-cli-${label}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli.json"), JSON.stringify({ result, calls, report, productionVerified: false }, null, 2), { flag: "wx" });
    cpSync(f.out, join(dir, "out"), { recursive: true });
  }
  return { result, calls, report, out: f.out };
}

for (const [label, declaredSynthetic, allowWrites] of [["marked-readonly", true, false], ["marked-write-permission", true, true], ["unmarked-no-invocation", false, true]]) {
  test(`P provenance CLI: ${label} preserves zero I/O and all eighteen unverified observations`, async (t) => {
    const f = await cli(t, label, { declaredSynthetic, allowWrites });
    assert.equal(f.result.status, 2, f.result.stderr); assert.match(f.report.verdict, /^blocked/u);
    assert.equal(f.report.productionEvidence, false);
    assert.equal(f.report.evidenceType, declaredSynthetic ? "synthetic-transport" : "unverified-production");
    assert.equal(f.report.tasks[0].status, "blocked"); assert.equal(f.report.tasks[0].called, false);
    assert.match(f.report.tasks[0].reason, allowWrites ? /预算|计量/u : /只读/u);
    assert.equal(f.calls.health, 1); assert.equal(f.calls.chat, 0); assert.equal(f.calls.image, 0); assert.equal(f.calls.video, 0); assert.equal(f.calls.auth, 0); assert.equal(f.calls.dispatch, 0);
    assert.equal(f.report.budget.reservations.length, 0); assert.equal(f.report.budget.used.llmCalls, 0); assert.equal(f.report.budget.used.llmTokens, 0);
    allUnverified(f.report.checks, f.report.evidenceType);
    for (const check of f.report.checks) {
      const item = JSON.parse(readFileSync(join(f.out, "..", "items", `${check.id}.json`), "utf8"));
      assert.equal(item.status, "unverified", check.id); assert.equal(item.productionEvidence, false, check.id); assert.equal(item.evidenceType, f.report.evidenceType, check.id);
    }
  });
}
