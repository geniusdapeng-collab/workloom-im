/** MC024 original names retained at current canonical CLI boundaries.
 * Immutable original: prior/base/scripts/acceptance/lib/live/live.accounting.test.mjs.
 * Formal external LLM is now blocked before any reserve/HTTP. Original usage and
 * overshoot scenarios also run against actual loopback transport plus v2 budget.
 * All synthetic processes, files and wire counters are retained when evidence is enabled.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fixture as cliFixture } from "./cli-fixtures.mjs";
import { createBudget, normalizeBudgets } from "./budget.mjs";
import { runChatTask } from "./providers.mjs";
import { PNG_BYTES } from "./test-fixtures.mjs";
const llm = (id, expectedTokens = 3, extra = {}) => ({ id, title: "Local synthetic accounting fixture", kind: "llm", chain: "model-gateway", model: "llm", prompt: "LOCAL_OK", expectAll: ["LOCAL_OK"], expectedTokens, ...extra });

async function fixture(t, label, { tasks, budgets = {}, completionUsage = { total_tokens: 3 }, imageCount = null, videoDuration = 12, extraArgs = [], allowNoReport = false }) {
  const calls = { chat: 0, image: 0, video: 0, auth: 0, dispatch: 0, artifact: 0, all: 0, bodies: [] };
  let base;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const bytes of req) text += bytes;
    let input; try { input = text ? JSON.parse(text) : {}; } catch { res.writeHead(400); return res.end("synthetic bad JSON"); }
    calls.all += 1;
    const reply = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/chat/completions") { calls.chat += 1; calls.bodies.push(input); return reply({ id: `local-${calls.chat}`, model: "fixture", choices: [{ message: { content: "LOCAL_OK" } }], ...(completionUsage === null ? {} : { usage: completionUsage }) }); }
    if (req.url === "/api/v3/images/generations") {
      calls.image += 1; const count = imageCount ?? input.sequential_image_generation_options?.max_images ?? 1;
      return reply({ model: "fixture-image", usage: { generated_images: count }, data: Array.from({ length: count }, (_, i) => ({ url: `${base}/fixture-${i}.png` })) });
    }
    if (req.url === "/api/v3/contents/generations/tasks") { calls.video += 1; return reply({ id: "local-video" }); }
    if (req.url === "/api/v3/contents/generations/tasks/local-video") return reply({ id: "local-video", model: "fixture-video", status: "succeeded", content: { video_url: `${base}/fixture.mp4` }, ...(videoDuration === null ? {} : { duration: videoDuration }) });
    if (req.url.endsWith(".png") || req.url.endsWith(".mp4")) { calls.artifact += 1; res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(req.url.endsWith(".png") ? PNG_BYTES : Buffer.from("SYNTHETIC UNREADABLE ARTIFACT; NOT MODEL EVIDENCE")); }
    if (req.url === "/trpc/auth.loginAs") { calls.auth += 1; return reply({ result: { data: { token: "synthetic-test-only-token" } } }); }
    if (req.url === "/trpc/threads.dispatch") { calls.dispatch += 1; return reply({ result: { data: { threadId: "local", kind: "agent" } } }); }
    return reply({ ok: true, synthetic: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  base = `http://127.0.0.1:${server.address().port}`;
  const declaredEnvironment = extraArgs.includes("--env") ? extraArgs[extraArgs.indexOf("--env") + 1] : "local-preview";
  const f = cliFixture(t, { environment: { kind: declaredEnvironment, target: { apiUrl: base, pcUrl: base, bMobileUrl: base, cMobileUrl: base }, timeouts: { healthMs: 200 } }, live: { enabled: true, ...(declaredEnvironment === "deployed" ? { evidenceMode: "synthetic" } : {}), budgets, tasks, models: [
    { id: "llm", kind: "llm", adapter: "model-gateway", model: "fixture", apiKeyEnv: "LLM_API_KEY", baseUrlEnv: "LLM_BASE_URL" },
    { id: "image", kind: "image", adapter: "gen-http", model: "fixture-image", apiKeyEnv: "SEEDREAM_API_KEY", baseUrlEnv: "SEEDREAM_ENDPOINT" },
    { id: "video", kind: "video", adapter: "gen-http", model: "fixture-video", apiKeyEnv: "SEEDANCE_API_KEY", baseUrlEnv: "SEEDANCE_ENDPOINT" },
  ] } });
  const timeoutIndex = extraArgs.indexOf("--timeout-s"); const timeout = timeoutIndex >= 0 ? extraArgs[timeoutIndex + 1] : "1";
  const flags = timeoutIndex >= 0 ? extraArgs.filter((_v, i) => i !== timeoutIndex && i !== timeoutIndex + 1) : extraArgs;
  const argv = [join(f.repo, "scripts/acceptance/live.mjs"), "--no-auto-keys", "--no-keys-from-client", "--out", f.out, "--timeout-s", timeout, "--require-live", ...flags];
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.repo, LANG: "C.UTF-8", NODE_PATH: process.env.NODE_PATH ?? "", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), LLM_API_KEY: "synthetic-local-fixture-key", LLM_BASE_URL: `${base}/v1`, SEEDREAM_API_KEY: "synthetic-local-fixture-key", SEEDREAM_ENDPOINT: `${base}/api/v3`, SEEDANCE_API_KEY: "synthetic-local-fixture-key", SEEDANCE_ENDPOINT: `${base}/api/v3` };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: f.repo, env }); let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("local synthetic CLI timeout")); }, 120_000);
    child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); }); child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, argv }); });
  });
  const reportPath = join(f.out, "live-report.json"); if (!allowNoReport) assert.ok(existsSync(reportPath), result.stderr);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  const evidenceBase = process.env.RDAS_GENERATION_EVIDENCE_DIR;
  const output = evidenceBase ? join(evidenceBase, `old-cli-${label}`) : null;
  if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, "cli.json"), JSON.stringify({ result, calls, report, productionVerified: false }, null, 2), { flag: "wx" }); cpSync(f.out, join(output, "out"), { recursive: true }); }
  const record = (name, detail) => { if (output) writeFileSync(join(output, `${name}.json`), JSON.stringify({ calls, ...detail, productionVerified: false }, null, 2), { flag: "wx" }); };
  return { ...f, root: f.repo, report, calls, code: result.status, result, env, resolved: { ready: true, credentialEnv: "LLM_API_KEY", model: "fixture", baseUrl: `${base}/v1` }, record };
}
const formalBlocked = (f) => {
  assert.equal(f.code, 2, f.result.stderr); assert.notEqual(f.report.verdict, "pass");
  assert.equal(f.report.tasks.every((r) => r.status === "blocked" && r.called === false), true);
  assert.equal(f.calls.chat, 0); assert.equal(f.calls.auth, 0); assert.equal(f.calls.dispatch, 0);
  assert.equal(f.report.budget.used.llmTokens, 0); assert.equal(f.report.budget.used.llmCalls, 0); assert.equal(f.report.budget.reservations.length, 0);
  assert.equal(f.report.checks.some((check) => check.status === "pass"), false);
};
function mechanism(f, budgets = {}) { return createBudget({ budgets: normalizeBudgets(budgets).budgets, outDir: join(f.root, "controlled-mechanism"), runId: "synthetic-controlled" }); }
async function controlled(f, b, task) {
  const gate = b.reserve({ taskId: task.id, kind: "llm", tokens: task.expectedTokens });
  if (!gate.allowed || gate.duplicate) return { status: "blocked", called: false, gate };
  const out = await runChatTask({ resolved: f.resolved, prompt: task.prompt, env: f.env, maxTokens: task.expectedTokens });
  const settled = b.commit({ taskId: task.id, reservationId: gate.reservationId, kind: "llm", tokens: out.tokens ?? out.knownTokens ?? 0, calls: 1, measured: out.usage.complete, status: out.status });
  return { ...out, settlement: settled };
}

describe("actual live runner with an explicit local synthetic provider", () => {
  it("reserves cumulatively and sends each completion ceiling", async (t) => {
    const f = await fixture(t, "cumulative", { tasks: [llm("a"), llm("b")], budgets: { maxLlmTokens: 6 } }); formalBlocked(f);
    const b = mechanism(f, { maxLlmTokens: 6 }); const results = [];
    for (const id of ["a", "b"]) results.push(await controlled(f, b, llm(id)));
    assert.equal(results.every((r) => r.status === "ok"), true); assert.equal(b.summary().used.llmTokens, 6); assert.equal(b.summary().used.llmCalls, 2);
    assert.equal(f.calls.chat, 2); assert.deepEqual(f.calls.bodies.map((r) => r.max_tokens), [3, 3]); assert.equal(new Set(b.summary().reservations.map((r) => r.reservationId)).size, 2);
    f.record("mechanism", { results, budget: b.persist() });
  });
  it("blocks a prospective overshoot before the second HTTP call", async (t) => {
    const f = await fixture(t, "prospective", { tasks: [llm("a"), llm("b")], budgets: { maxLlmTokens: 5 } }); formalBlocked(f);
    const b = mechanism(f, { maxLlmTokens: 5 }); const results = [await controlled(f, b, llm("a")), await controlled(f, b, llm("b"))];
    assert.deepEqual(results.map((r) => r.status), ["ok", "blocked"]); assert.equal(f.calls.chat, 1); assert.equal(b.summary().used.llmTokens, 3); f.record("mechanism", { results, budget: b.persist() });
  });
  it("keeps a reservation when fixture file I/O fails before the adapter", async (t) => {
    const f = await fixture(t, "pre-adapter-fault", { tasks: [llm("fault", 4, { imageFixture: "absent.png" }), llm("next", 2)], budgets: { maxLlmTokens: 5 } }); formalBlocked(f);
    const b = mechanism(f, { maxLlmTokens: 5 }); const gate = b.reserve({ taskId: "fault", kind: "llm", tokens: 4 }); assert.equal(gate.allowed, true);
    assert.throws(() => readFileSync(join(f.root, "absent.png")), /ENOENT/);
    assert.equal(b.commit({ taskId: "fault", kind: "llm", measured: false, status: "blocked" }).committed, true);
    assert.equal(b.summary().used.llmTokens, 4); assert.equal(b.summary().unmeasured.llmTokens, 4); assert.equal(b.summary().actual.llmTokens, 0);
    assert.equal((await controlled(f, b, llm("next", 2))).called, false); assert.equal(f.calls.chat, 0); assert.equal(b.summary().measurementComplete, false); f.record("mechanism", { budget: b.persist() });
  });
  for (const [label, completionUsage] of [["missing-usage", null], ["zero-usage", { total_tokens: 0 }]]) {
    it(`${label} cannot turn into a real production pass`, async (t) => {
      const f = await fixture(t, label, { tasks: [llm("a", 4)], completionUsage }); formalBlocked(f);
      const b = mechanism(f); const result = await controlled(f, b, llm("a", 4));
      assert.equal(result.status, "blocked"); assert.equal(result.usageVerified, false); assert.equal(b.summary().used.llmTokens, 4);
      assert.equal(b.summary().accounting.mode, "estimated"); assert.equal(b.summary().measurementComplete, false); assert.equal(b.summary().frozenBy.length, 1);
      assert.equal((await controlled(f, b, llm("next", 1))).called, false); f.record("mechanism", { result, budget: b.persist() });
    });
  }
  it("accounts actual overshoot and locks later LLM and generation calls", async (t) => {
    const f = await fixture(t, "actual-overshoot", { tasks: [llm("a", 2), llm("b", 1)], budgets: { maxLlmTokens: 5 }, completionUsage: { total_tokens: 6 } }); formalBlocked(f);
    const b = mechanism(f, { maxLlmTokens: 5 }); const first = await controlled(f, b, llm("a", 2));
    assert.equal(first.settlement.allowed, false); assert.deepEqual(first.settlement.exceeded, ["llmTokens"]); assert.equal(b.summary().used.llmTokens, 6);
    assert.equal((await controlled(f, b, llm("b", 1))).called, false); assert.equal(b.reserve({ taskId: "image", kind: "image", units: 1 }).allowed, false);
    assert.equal(f.calls.chat, 1); assert.equal(f.calls.image, 0); f.record("mechanism", { first, budget: b.persist() });
  });
  it("unbounded real chains cannot start even against an available authenticated target", async (t) => {
    const f = await fixture(t, "unbounded-chains", { tasks: [llm("dsh", 3, { chain: "dsh-harness" }), { id: "product", kind: "product", input: "local fixture" }] }); formalBlocked(f);
    assert.equal(f.report.tasks.every((r) => /预算|token/.test(r.reason)), true); assert.equal(existsSync(join(f.out, "dsh-home")), false);
  });
  for (const [label, flags] of [["readonly-product", ["--env", "deployed"]], ["write-permission-without-meter", ["--env", "deployed", "--allow-prod-writes"]]]) {
    it(`${label} cannot authorize an unmetered product dispatch`, async (t) => {
      const f = await fixture(t, label, { tasks: [{ id: "product", kind: "product", input: "synthetic-fixture local fixture", fixtureMarker: "synthetic-fixture", residualDisclosure: "temporary synthetic repository" }], extraArgs: flags }); formalBlocked(f);
      assert.match(f.report.tasks[0].reason, label === "readonly-product" ? /只读/ : /预算|计量/);
    });
  }
  it("actual image overproduction is charged and reported as a quota failure", async (t) => {
    const f = await fixture(t, "image-overshoot", { tasks: [{ id: "image", kind: "image", model: "image", images: 1 }, llm("next", 1)], budgets: { maxImages: 2 }, imageCount: 3 });
    assert.equal(f.code, 1, f.result.stderr); assert.equal(f.calls.image, 1); assert.equal(f.calls.chat, 0);
    assert.equal(f.report.budget.used.images, 3); assert.deepEqual(f.report.tasks.map((r) => r.status), ["failed", "blocked"]); assert.equal(f.calls.artifact, 0);
  });
  it("an opaque duration override cannot submit a 32 second generation", async (t) => {
    const f = await fixture(t, "duration-override", { tasks: [{ id: "video", kind: "video", model: "video", durationSeconds: 12, params: { duration: 32 } }] });
    assert.equal(f.code, 2); assert.equal(f.report.tasks[0].status, "blocked"); assert.equal(f.calls.video, 0); assert.equal(f.report.budget.used.videoSeconds, 12);
    assert.equal(f.report.budget.accounting.verified, false); assert.equal(f.report.budget.measurementComplete, false);
  });
  it("missing video duration is explicitly unverified after the local async job", async (t) => {
    const f = await fixture(t, "missing-video-usage", { tasks: [{ id: "video", kind: "video", model: "video", durationSeconds: 12 }], videoDuration: null, extraArgs: ["--timeout-s", "10"] });
    assert.equal(f.code, 1); assert.equal(f.calls.video, 1); assert.equal(f.report.tasks[0].status, "failed"); assert.equal(f.report.budget.used.videoSeconds, 12);
    assert.equal(f.report.tasks[0].measurementComplete, false); assert.equal(f.report.budget.accounting.verified, false); assert.equal(f.report.budget.frozenBy.length, 1);
  });
  it("selftest reports synthetic evidence and skips product dispatch", async (t) => {
    const f = await fixture(t, "explicit-selftest", { tasks: [llm("a", 30), { id: "product", kind: "product" }], extraArgs: ["--selftest"] });
    assert.equal(f.code, 2); assert.equal(f.report.selftest, true); assert.match(f.report.verdict, /非生产实测证据/);
    assert.deepEqual(f.report.tasks.map((r) => r.status), ["ok", "skipped"]); assert.equal(f.report.budget.used.llmTokens, 30);
    assert.equal(f.calls.chat, 0); assert.equal(f.calls.dispatch, 0); assert.equal(f.report.checks.every((c) => c.status === "unverified"), true);
  });
  it("invalid task identifiers cannot escape the receipt directory", async (t) => {
    const f = await fixture(t, "invalid-id", { tasks: [llm("../escaped")], allowNoReport: true });
    assert.equal(f.code, 1); assert.equal(f.report, null); assert.equal(f.calls.all, 0); assert.equal(f.calls.chat, 0);
    assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false); assert.equal(existsSync(join(f.out, "receipts/INVALID-1.json")), false);
    assert.equal(existsSync(join(f.out, "escaped.json")), false); assert.equal(existsSync(join(f.root, "escaped.json")), false);
  });
  it("a filtered empty matrix cannot be reported as production pass", async (t) => {
    const f = await fixture(t, "empty-matrix", { tasks: [llm("a")], extraArgs: ["--tasks", "absent"] }); formalBlocked(f);
    assert.equal(f.report.tasks.length, 1); assert.equal(f.report.tasks[0].id, "absent"); assert.match(f.report.tasks[0].reason, /未配置/);
  });
});
