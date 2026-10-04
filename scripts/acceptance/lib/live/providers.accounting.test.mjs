/** MC024 preserved test names; actual loopback HTTP replaces mocked fetch.
 * Immutable original: prior/base/scripts/acceptance/lib/live/providers.accounting.test.mjs.
 * Incomplete token samples expose knownTokens only; authoritative tokens stay null.
 * Video actual quantity comes from a decoded file, while API duration remains reportedDurationSeconds.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runChatTask, runDshTask, runImageTask, runVideoTask, runProductDispatchTask } from "./providers.mjs";
import { MP4_BYTES } from "./test-fixtures.mjs";
import { inspectLocalArtifact } from "./media.mjs";
const env = { LLM_API_KEY: "synthetic-local-fixture-key", SEEDREAM_API_KEY: "synthetic-local-fixture-key", SEEDANCE_API_KEY: "synthetic-local-fixture-key" };
const completion = (usage) => ({ id: "fixture-1", model: "local-fixture", choices: [{ message: { content: "LOCAL_OK" } }], ...(usage === undefined ? {} : { usage }) });
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function transport(t, handle) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const bytes of req) text += bytes;
    let input; try { input = text ? JSON.parse(text) : null; } catch { return reply(res, 400, { error: "synthetic bad JSON" }); }
    calls.push({ method: req.method, path: req.url, input });
    handle(req, res, input, calls);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}`, ready: true, credentialEnv: "LLM_API_KEY", model: "local-fixture" };
}
function artifacts(t) { const dir = mkdtempSync(join(tmpdir(), "workloom-provider-accounting-")); mkdirSync(dir, { recursive: true }); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

describe("per-call adapter accounting", () => {
  for (const [name, usage, known, verified] of [
    ["total", { total_tokens: 6 }, 6, true],
    ["parts", { prompt_tokens: 2, completion_tokens: 3 }, 5, true],
    ["total-and-parts", { total_tokens: 5, prompt_tokens: 2, completion_tokens: 3 }, 5, true],
    ["missing", undefined, null, false],
    ["zero", { total_tokens: 0 }, null, false],
    ["negative", { total_tokens: -1 }, null, false],
    ["non-number", { total_tokens: "6" }, null, false],
    ["fraction", { total_tokens: 0.5 }, null, false],
    ["mismatch", { total_tokens: 4, prompt_tokens: 2, completion_tokens: 3 }, 5, false],
    ["invalid-total-known-parts", { total_tokens: -1, prompt_tokens: 2, completion_tokens: 3 }, 5, false],
    ["zero-total-known-parts", { total_tokens: 0, prompt_tokens: 2, completion_tokens: 3 }, 5, false],
    ["partial-lower-bound", { prompt_tokens: 5 }, 5, false],
    ["invalid-parts", { total_tokens: 5, prompt_tokens: -1, completion_tokens: 3 }, 5, false],
  ]) it(`${name} usage is reported without inventing actual tokens`, async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 200, completion(usage)));
    const out = await runChatTask({ resolved, prompt: "local fixture", env, maxTokens: 7 });
    assert.equal(out.tokens, verified ? known : null);
    assert.equal(out.knownTokens, known);
    assert.equal(out.usageVerified, verified); assert.equal(out.usage.complete, verified);
    assert.equal(out.receipt.usageVerified, verified); assert.equal(out.receipt.tokens, verified ? known : null);
    assert.equal(out.receipt.knownTokens, known); assert.equal(resolved.calls.length, 1);
  });
  it("sends the configured finite completion ceiling on each request", async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 200, completion({ total_tokens: 5 })));
    for (let n = 0; n < 2; n += 1) assert.equal((await runChatTask({ resolved, prompt: "fixture", env, maxTokens: 7 })).tokens, 5);
    assert.deepEqual(resolved.calls.map((v) => v.input.max_tokens), [7, 7]);
  });
  it("invalid completion ceiling is blocked before any network action", async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 200, completion({ total_tokens: 5 })));
    for (const maxTokens of [-1, 0, 0.5, NaN, Infinity, "7"]) assert.equal((await runChatTask({ resolved, prompt: "fixture", env, maxTokens })).status, "blocked");
    assert.equal(resolved.calls.length, 0);
  });
  it("network failure never fabricates zero actual usage", async (t) => {
    const resolved = await transport(t, (req) => req.socket.destroy());
    const out = await runChatTask({ resolved, prompt: "fixture", env });
    assert.equal(out.status, "failed"); assert.notEqual(out.tokens, 0); assert.equal(out.tokens, null);
    assert.equal(out.usageVerified, false); assert.equal(out.receipt.synced, false); assert.equal(resolved.calls.length, 1);
  });
  it("HTTP errors retain reported per-call usage if supplied", async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 500, { usage: { total_tokens: 9 }, error: "local failure" }));
    const out = await runChatTask({ resolved, prompt: "fixture", env });
    assert.equal(out.status, "failed"); assert.equal(out.tokens, 9); assert.equal(out.usageVerified, true);
    assert.equal(out.receipt.synced, false); assert.equal(resolved.calls.length, 1);
  });
  it("blocks real dsh and product dispatch before I/O while accounting is unbounded", async (t) => {
    const resolved = await transport(t, () => assert.fail("must not dispatch"));
    const dsh = await runDshTask({ repoRoot: "/missing-fixture", workDir: "/missing-fixture", model: "fixture", prompt: "fixture" });
    // Formal CLI blocks all product dispatch; low-level controlled transport additionally blocks requireModel:true.
    const product = await runProductDispatchTask({ apiUrl: resolved.baseUrl, token: "synthetic-test-only-token", task: { id: "product", input: "fixture", requireModel: true } });
    assert.equal(dsh.status, "blocked"); assert.equal(product.status, "blocked");
    assert.match(dsh.reason, /计量|配额|预算/); assert.match(product.reason, /计量|配额|预算/); assert.equal(resolved.calls.length, 0);
  });
  it("selftest cannot launch dsh against an external model endpoint", async () => {
    const out = await runDshTask({ repoRoot: "/missing-fixture", workDir: "/missing-fixture", selftest: true, env: { DEEPSEEK_BASE_URL: "https://example.invalid" } });
    assert.equal(out.status, "blocked"); assert.match(out.reason, /本地/);
  });
});

describe("generation meters cannot be overwritten by opaque params", () => {
  it("rejects invalid counts and metering overrides before dispatch", async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 400, { error: "synthetic quota refused" }));
    for (const images of [-1, 0, 1.5, 9, Infinity, "2"]) assert.equal((await runImageTask({ resolved, task: { id: "image", images }, env })).status, "blocked");
    for (const params of [{ sequential_image_generation_options: { max_images: 100 } }, { sequential_image_generation: "auto" }, { n: 100 }, { model: "different-model" }, null]) assert.equal((await runImageTask({ resolved, task: { id: "image", images: 1, params }, env })).status, "blocked");
    assert.equal(resolved.calls.length, 0);
  });
  it("returns the number of generated images instead of the requested count", async (t) => {
    let resolved; resolved = await transport(t, (_req, res) => reply(res, 200, { model: "local-fixture", usage: { generated_images: 2 }, data: [{ url: `${resolved.baseUrl}/one.png` }, { url: `${resolved.baseUrl}/two.png` }] }));
    const out = await runImageTask({ resolved, task: { id: "image", images: 1 }, env, artifactsDir: artifacts(t) });
    assert.equal(out.units, 2); assert.equal(out.produced, 2); assert.equal(out.usageVerified, true);
    assert.equal(out.status, "failed"); assert.equal(out.receipt.synced, false); assert.equal(resolved.calls.length, 1); // Stop before unreserved delivery.
  });
  it("rejects video duration overrides before submitting a task", async (t) => {
    const resolved = await transport(t, (_req, res) => reply(res, 400, { error: "synthetic quota refused" }));
    for (const durationSeconds of [-1, 0, 9, 16, 32, 10.5, "12"]) assert.equal((await runVideoTask({ resolved, task: { id: "video", durationSeconds }, env })).status, "blocked");
    for (const params of [{ duration: 32 }, { model: "different-model" }, null]) assert.equal((await runVideoTask({ resolved, task: { id: "video", durationSeconds: 12, params }, env })).status, "blocked");
    assert.equal(resolved.calls.length, 0);
  });
  for (const [label, duration, verified] of [["reported", 13, true], ["missing", undefined, false]]) {
    it(`${label} video duration is explicit and cannot masquerade as requested actual usage`, async (t) => {
      let resolved; resolved = await transport(t, (req, res) => {
        if (req.method === "POST") return reply(res, 200, { id: "video" });
        if (req.url === "/contents/generations/tasks/video") return reply(res, 200, { id: "video", model: "local-fixture", status: "succeeded", content: { video_url: `${resolved.baseUrl}/video.mp4` }, ...(duration === undefined ? {} : { duration }) });
        res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(verified ? MP4_BYTES : Buffer.from("synthetic unreadable video"));
      });
      const dir = artifacts(t);
      const out = await runVideoTask({ resolved, task: { id: "video", durationSeconds: 12 }, env, pollMs: 0, timeoutMs: 30_000, artifactsDir: dir });
      assert.equal(out.usageVerified, verified);
      assert.equal(out.receipt.reportedDurationSeconds, duration ?? null);
      assert.equal(out.measurementComplete, verified); assert.equal(resolved.calls.length, 3);
      if (verified) {
        const decoded = await inspectLocalArtifact({ path: out.artifacts[0].path, artifactsDir: dir, kind: "video" });
        assert.equal(out.units, decoded.durationSeconds); assert.notEqual(out.units, duration); assert.notEqual(out.units, 12);
        assert.equal(out.receipt.measurementSource, "decoded-local-file"); assert.ok(out.artifacts[0].decodedFrames > 0);
      }
      else { assert.equal(out.units, null); assert.notEqual(out.status, "ok"); assert.equal(out.receipt.synced, false); }
    });
  }
});
