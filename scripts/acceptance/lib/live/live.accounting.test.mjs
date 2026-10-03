import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sourceFiles = ["scripts/acceptance/live.mjs", "scripts/acceptance/lib/profile.mjs", "scripts/acceptance/lib/target.mjs", "scripts/acceptance/lib/live/budget.mjs", "scripts/acceptance/lib/live/providers.mjs", "scripts/acceptance/lib/live/stub-provider.mjs"];
const llm = (id, expectedTokens = 3, extra = {}) => ({ id, title: "Local synthetic accounting fixture", kind: "llm", chain: "model-gateway", model: "llm", prompt: "LOCAL_OK", expectAll: ["LOCAL_OK"], expectedTokens, ...extra });

async function fixture(t, label, { tasks, budgets = {}, completionUsage = { total_tokens: 3 }, imageCount = null, videoDuration = 12, extraArgs = [] }) {
  const evidenceRoot = process.env.RDAS_ACCOUNTING_EVIDENCE_DIR;
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const root = evidenceRoot ? join(evidenceRoot, label) : mkdtempSync(join(tmpdir(), "rdas-local-live-"));
  if (evidenceRoot) mkdirSync(root); // Fresh run only; never replace earlier evidence.
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of sourceFiles) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  writeFileSync(join(root, "product.manifest.json"), JSON.stringify({ productId: "rdas-synthetic-fixture", role: "base" }), { flag: "wx" });
  const calls = { chat: 0, image: 0, video: 0, auth: 0, dispatch: 0, bodies: [] };
  let base;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const respond = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/chat/completions") {
      calls.chat += 1;
      calls.bodies.push(json);
      return respond({ id: `local-${calls.chat}`, choices: [{ message: { content: "LOCAL_OK" } }], ...(completionUsage === null ? {} : { usage: completionUsage }) });
    }
    if (req.url === "/api/v3/images/generations") {
      calls.image += 1;
      return respond({ data: Array.from({ length: imageCount ?? json.sequential_image_generation_options?.max_images ?? 1 }, (_, i) => ({ url: `${base}/fixture-${i}.png` })) });
    }
    if (req.url === "/api/v3/contents/generations/tasks") {
      calls.video += 1;
      return respond({ id: "local-video" });
    }
    if (req.url === "/api/v3/contents/generations/tasks/local-video") {
      return respond({ status: "succeeded", content: { video_url: `${base}/fixture.mp4` }, ...(videoDuration === null ? {} : { duration: videoDuration }) });
    }
    if (req.url.endsWith(".png") || req.url.endsWith(".mp4")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end("SYNTHETIC ARTIFACT; NOT MODEL EVIDENCE");
    }
    if (req.url === "/trpc/auth.loginAs") { calls.auth += 1; return respond({ result: { data: { token: "mock-test-only" } } }); }
    if (req.url === "/trpc/threads.dispatch") { calls.dispatch += 1; return respond({ result: { data: { threadId: "local", kind: "agent" } } }); }
    if (req.url.startsWith("/trpc/threads.get")) return respond({ result: { data: { status: "completed" } } });
    return respond({ ok: true, localSyntheticFixture: true });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const profile = {
    schemaVersion: "workloom.acceptance-profile/v2", dataMode: "simulated", productName: "Local synthetic accounting fixture",
    environment: { kind: "local-preview", target: { apiUrl: base, pcUrl: base, bMobileUrl: base, cMobileUrl: base }, timeouts: { healthMs: 100 } },
    live: { enabled: true, budgets, tasks, models: [
      { id: "llm", kind: "llm", adapter: "model-gateway", model: "fixture", apiKeyEnv: "LLM_API_KEY" },
      { id: "image", kind: "image", adapter: "gen-http", model: "fixture-image", apiKeyEnv: "SEEDREAM_API_KEY" },
      { id: "video", kind: "video", adapter: "gen-http", model: "fixture-video", apiKeyEnv: "SEEDANCE_API_KEY" },
    ] },
  };
  const profilePath = join(root, "fixture-profile.json");
  writeFileSync(profilePath, JSON.stringify(profile), { flag: "wx" });
  const args = ["scripts/acceptance/live.mjs", "--no-auto-keys", "--no-keys-from-client", "--profile", profilePath, "--out", join(root, "out"), "--timeout-s", "1", "--require-live", ...extraArgs];
  // Exact allowlist: no inherited credential variables, WORKLOOM_LIVE_ENV,
  // Node preload configuration, or access to the real repo/client .env files.
  const childEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", LLM_API_KEY: "stub-key", LLM_BASE_URL: `${base}/v1`, SEEDREAM_API_KEY: "stub-key", SEEDREAM_ENDPOINT: `${base}/api/v3`, SEEDANCE_API_KEY: "stub-key", SEEDANCE_ENDPOINT: `${base}/api/v3` };
  let code;
  let log = "";
  try {
    code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("local fixture timed out")); }, 25_000);
      child.stdout.on("data", (data) => { log += data; });
      child.stderr.on("data", (data) => { log += data; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (status) => { clearTimeout(timer); done(status); });
    });
  } finally {
    await new Promise((done) => server.close(done));
  }
  writeFileSync(join(root, "process.log"), log, { flag: "wx" });
  const reportPath = join(root, "out/live-report.json");
  assert.ok(existsSync(reportPath), log);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const caseResult = { label, noExternalModelOrCredentials: true, environment: "isolated-local-synthetic-process", commandArgs: args, exitCode: code, calls, used: report.budget.used, statuses: report.tasks.map((r) => ({ id: r.id, status: r.status, accounting: r.accounting, reason: r.reason })), verdict: report.verdict };
  writeFileSync(join(root, "case-result.json"), JSON.stringify(caseResult, null, 2), { flag: "wx" });
  t.diagnostic(JSON.stringify({ label, exitCode: code, calls: { ...calls, bodies: undefined }, used: report.budget.used, statuses: caseResult.statuses.map(({ id, status }) => ({ id, status })), verdict: report.verdict }));
  return { report, calls, code, root };
}

describe("actual live runner with an explicit local synthetic provider", () => {
  it("reserves cumulatively and sends each completion ceiling", async (t) => {
    const { report, calls, code } = await fixture(t, "cumulative", { tasks: [llm("a"), llm("b")], budgets: { maxLlmTokens: 6 } });
    assert.equal(code, 0);
    assert.deepEqual(report.tasks.map((r) => r.status), ["ok", "ok"]);
    assert.equal(report.budget.used.llmTokens, 6);
    assert.equal(report.budget.used.llmCalls, 2);
    assert.equal(calls.chat, 2);
    assert.deepEqual(calls.bodies.map((r) => r.max_tokens), [3, 3]);
    assert.equal(new Set(report.budget.reservations.map((r) => r.reservationId)).size, 2);
  });

  it("blocks a prospective overshoot before the second HTTP call", async (t) => {
    const { report, calls, code } = await fixture(t, "prospective", { tasks: [llm("a"), llm("b")], budgets: { maxLlmTokens: 5 } });
    assert.equal(code, 1);
    assert.equal(calls.chat, 1);
    assert.deepEqual(report.tasks.map((r) => r.status), ["ok", "blocked"]);
    assert.equal(report.budget.used.llmTokens, 3);
  });

  it("keeps a reservation when fixture file I/O fails before the adapter", async (t) => {
    const { report, calls, code } = await fixture(t, "pre-adapter-fault", { tasks: [llm("fault", 4, { imageFixture: "absent.png" }), llm("next", 2)], budgets: { maxLlmTokens: 5 } });
    assert.equal(code, 1);
    assert.equal(calls.chat, 0);
    assert.deepEqual(report.tasks.map((r) => r.status), ["failed", "blocked"]);
    assert.equal(report.budget.used.llmTokens, 4);
    assert.deepEqual(report.budget.accounting.pending, ["fault"]);
  });

  for (const [label, completionUsage] of [["missing-usage", null], ["zero-usage", { total_tokens: 0 }]]) {
    it(`${label} cannot turn into a real production pass`, async (t) => {
      const { report, code } = await fixture(t, label, { tasks: [llm("a", 4)], completionUsage });
      assert.equal(code, 1);
      assert.equal(report.tasks[0].status, "blocked");
      assert.equal(report.tasks[0].accounting.usageVerified, false);
      assert.equal(report.budget.used.llmTokens, 4);
      assert.match(report.verdict, /blocked/);
      assert.equal(report.budget.accounting.mode, "estimated");
    });
  }

  it("accounts actual overshoot and locks later LLM and generation calls", async (t) => {
    const { report, calls, code } = await fixture(t, "actual-overshoot", { tasks: [llm("a", 2), llm("b", 1), { id: "image", kind: "image", model: "image", images: 1 }], budgets: { maxLlmTokens: 5 }, completionUsage: { total_tokens: 6 } });
    assert.equal(code, 1);
    assert.equal(calls.chat, 1);
    assert.equal(calls.image, 0);
    assert.equal(report.budget.used.llmTokens, 6);
    assert.deepEqual(report.tasks.map((r) => r.status), ["failed", "blocked", "blocked"]);
    assert.equal(report.verdict, "fail");
  });

  it("unbounded real chains cannot start even against an available authenticated target", async (t) => {
    const { report, calls, code } = await fixture(t, "unbounded-chains", { tasks: [llm("dsh", 3, { chain: "dsh-harness" }), { id: "product", kind: "product", input: "local fixture" }] });
    assert.equal(code, 1);
    assert.deepEqual(report.tasks.map((r) => r.status), ["blocked", "blocked"]);
    assert.equal(calls.chat, 0);
    assert.equal(calls.auth, 0);
    assert.equal(calls.dispatch, 0);
    assert.equal(report.budget.used.llmCalls, 0);
  });

  for (const [label, flags] of [["readonly-product", ["--env", "deployed"]], ["write-permission-without-meter", ["--env", "deployed", "--allow-prod-writes"]]]) {
    it(`${label} cannot authorize an unmetered product dispatch`, async (t) => {
      const { report, calls, code } = await fixture(t, label, { tasks: [{ id: "product", kind: "product", input: "local fixture" }], extraArgs: flags });
      assert.equal(code, 1);
      assert.equal(report.tasks[0].status, "blocked");
      assert.equal(calls.auth, 0);
      assert.equal(calls.dispatch, 0);
      assert.match(report.tasks[0].reason, label === "readonly-product" ? /只读/ : /计量/);
    });
  }

  it("actual image overproduction is charged and reported as a quota failure", async (t) => {
    const { report, calls, code } = await fixture(t, "image-overshoot", { tasks: [{ id: "image", kind: "image", model: "image", images: 1 }, llm("next", 1)], budgets: { maxImages: 2 }, imageCount: 3 });
    assert.equal(code, 1);
    assert.equal(calls.image, 1);
    assert.equal(calls.chat, 0);
    assert.equal(report.budget.used.images, 3);
    assert.deepEqual(report.tasks.map((r) => r.status), ["failed", "blocked"]);
  });

  it("an opaque duration override cannot submit a 32 second generation", async (t) => {
    const { report, calls, code } = await fixture(t, "duration-override", { tasks: [{ id: "video", kind: "video", model: "video", durationSeconds: 12, params: { duration: 32 } }] });
    assert.equal(code, 1);
    assert.equal(report.tasks[0].status, "blocked");
    assert.equal(calls.video, 0);
    assert.equal(report.budget.used.videoSeconds, 12);
    assert.equal(report.budget.accounting.verified, false);
  });

  it("missing video duration is explicitly unverified after the local async job", async (t) => {
    const { report, calls, code } = await fixture(t, "missing-video-usage", { tasks: [{ id: "video", kind: "video", model: "video", durationSeconds: 12 }], videoDuration: null, extraArgs: ["--timeout-s", "10"] });
    assert.equal(code, 1);
    assert.equal(calls.video, 1);
    assert.equal(report.tasks[0].status, "blocked");
    assert.equal(report.budget.used.videoSeconds, 12);
    assert.equal(report.tasks[0].accounting.usageVerified, false);
  });

  it("selftest reports synthetic evidence and skips product dispatch", async (t) => {
    const { report, code } = await fixture(t, "explicit-selftest", { tasks: [llm("a", 30), { id: "product", kind: "product" }], extraArgs: ["--selftest"] });
    assert.equal(code, 1); // --require-live rejects selftest as production evidence.
    assert.equal(report.selftest, true);
    assert.match(report.verdict, /非生产实测证据/);
    assert.deepEqual(report.tasks.map((r) => r.status), ["ok", "skipped"]);
    assert.equal(report.budget.used.llmTokens, 30);
  });

  it("invalid task identifiers cannot escape the receipt directory", async (t) => {
    const { report, calls, root } = await fixture(t, "invalid-id", { tasks: [llm("../escaped")] });
    assert.equal(report.tasks[0].id, "INVALID-1");
    assert.equal(report.tasks[0].status, "blocked");
    assert.equal(calls.chat, 0);
    assert.ok(existsSync(join(root, "out/receipts/INVALID-1.json")));
    assert.equal(existsSync(join(root, "out/escaped.json")), false);
  });

  it("a filtered empty matrix cannot be reported as production pass", async (t) => {
    const { report, calls, code } = await fixture(t, "empty-matrix", { tasks: [llm("a")], extraArgs: ["--tasks", "absent"] });
    assert.equal(code, 1);
    assert.equal(report.tasks.length, 0);
    assert.equal(calls.chat, 0);
    assert.match(report.verdict, /blocked/);
  });
});
