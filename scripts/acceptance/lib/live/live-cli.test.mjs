/** Real CLI failures stay fail/unverified; these tests need no browser or model credentials. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, llm, model, report, run } from "./cli-fixtures.mjs";

test("live CLI: missing credentials exits unverified, captures real run evidence and does not consume quota", (t) => {
  const f = fixture(t); const result = run(f); assert.equal(result.status, 2, result.stderr);
  const observed = report(f); assert.equal(observed.tasks[0].status, "blocked"); assert.equal(observed.budget.used.llmTokens, 0); assert.notEqual(observed.verdict, "pass");
  assert.equal(observed.checks.length, 18); assert.equal(observed.checks.filter((check) => check.status === "pass").length, 0);
  const index = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance/evidence-index.json"), "utf8"));
  assert.equal(index.runs.length, 1); const runRecord = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance", index.runs[0].path), "utf8"));
  assert.equal(runRecord.exit_code, result.status); assert.equal(runRecord.working_tree_dirty, false); assert.equal(runRecord.outputs.some((file) => file.path.endsWith("budget-ledger.jsonl")), true);
  assert.equal(existsSync(`${f.out}.run-lock`), false);
});

test("live CLI: disabled live configuration and empty task selection cannot become a zero-task pass", (t) => {
  for (const config of [{ live: { enabled: false, models: [model], tasks: [llm] } }, {}]) {
    const f = fixture(t, config); const result = run(f, config.live ? [] : ["--tasks", "unknown-task"]);
    assert.equal(result.status, 2, result.stderr); assert.equal(report(f).summary.total, config.live ? 0 : 1); assert.notEqual(report(f).verdict, "pass");
  }
});

test("live CLI: production dispatch requires explicit writes, fixture and residual disclosure before login", (t) => {
  for (const flags of [[], ["--allow-prod-writes"]]) {
    const f = fixture(t, { environment: { kind: "deployed", target: { apiUrl: "http://127.0.0.1:1" }, timeouts: { healthMs: 50 } }, live: { enabled: true, models: [], tasks: [{ id: "PROD-01", kind: "product", title: "synthetic", state_asserts: [{ http: { url: "http://127.0.0.1:1/health", status: 200 } }] }] } });
    const result = run(f, flags); assert.equal(result.status, 2, result.stderr); const observed = report(f).tasks[0]; assert.equal(observed.status, "blocked");
    assert.match(observed.reason, flags.length ? /fixtureMarker/ : /allow-prod-writes/); assert.equal(observed.threadId, undefined);
  }
});

test("live CLI: duplicate IDs, traversal and missing values fail before model admission", (t) => {
  for (const tasks of [[llm, llm], [{ ...llm, id: "../escape" }]]) {
    const f = fixture(t, { live: { enabled: true, models: [model], tasks } }); const result = run(f); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
  }
  const f = fixture(t); const result = run(f, ["--keys-file", "--no-auto-keys"]); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
});

test("live CLI: an existing run lock prevents parallel evidence replacement and paid admission", (t) => {
  const f = fixture(t); mkdirSync(`${f.out}.run-lock`, { recursive: true }); const result = run(f);
  assert.equal(result.status, 1); assert.match(result.stderr, /运行锁/); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false); assert.equal(existsSync(`${f.out}.run-lock`), true);
});
