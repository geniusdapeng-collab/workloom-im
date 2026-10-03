import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChatTask, runDshTask, runImageTask, runVideoTask, runProductDispatchTask } from "./providers.mjs";
const resolved = { ready: true, missing: [], credentialEnv: "LLM_API_KEY", model: "local-fixture", baseUrl: "http://127.0.0.1:1/v1" };
const env = { LLM_API_KEY: "stub-key", SEEDREAM_API_KEY: "stub-key", SEEDANCE_API_KEY: "stub-key" };
const completion = (usage) => ({ id: "fixture-1", choices: [{ message: { content: "LOCAL_OK" } }], ...(usage === undefined ? {} : { usage }) });

describe("per-call adapter accounting", () => {
  for (const [name, usage, tokens, verified] of [
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
    t.mock.method(globalThis, "fetch", async () => Response.json(completion(usage)));
    const out = await runChatTask({ resolved, prompt: "local fixture", env, maxTokens: 7 });
    assert.equal(out.tokens, tokens);
    assert.equal(out.usageVerified, verified);
    assert.equal(out.receipt.usageVerified, verified);
  });

  it("sends the configured finite completion ceiling on each request", async (t) => {
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json(completion({ total_tokens: 5 }));
    });
    for (let n = 0; n < 2; n += 1) {
      const out = await runChatTask({ resolved, prompt: "fixture", env, maxTokens: 7 });
      assert.equal(out.tokens, 5);
    }
    assert.deepEqual(bodies.map((v) => v.max_tokens), [7, 7]);
  });

  it("invalid completion ceiling is blocked before any network action", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json(completion({ total_tokens: 5 })); });
    for (const maxTokens of [-1, 0, 0.5, NaN, Infinity, "7"]) {
      assert.equal((await runChatTask({ resolved, prompt: "fixture", env, maxTokens })).status, "blocked");
    }
    assert.equal(calls, 0);
  });

  it("network failure never fabricates zero actual usage", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("local network fault"); });
    const out = await runChatTask({ resolved, prompt: "fixture", env });
    assert.equal(out.status, "failed");
    assert.notEqual(out.tokens, 0);
    assert.equal(out.usageVerified, false);
  });

  it("HTTP errors retain reported per-call usage if supplied", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ usage: { total_tokens: 9 }, error: "local failure" }, { status: 500 }));
    const out = await runChatTask({ resolved, prompt: "fixture", env });
    assert.equal(out.status, "failed");
    assert.equal(out.tokens, 9);
    assert.equal(out.usageVerified, true);
  });

  it("blocks real dsh and product dispatch before I/O while accounting is unbounded", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("must not dispatch"); });
    const dsh = await runDshTask({ repoRoot: "/missing-fixture", workDir: "/missing-fixture", model: "fixture", prompt: "fixture" });
    const product = await runProductDispatchTask({ apiUrl: resolved.baseUrl, token: "mock-test-only", task: { id: "product", input: "fixture" } });
    assert.equal(dsh.status, "blocked");
    assert.equal(product.status, "blocked");
    assert.match(dsh.reason, /计量|配额/);
    assert.match(product.reason, /计量|配额/);
    assert.equal(calls, 0);
  });

  it("selftest cannot launch dsh against an external model endpoint", async () => {
    const out = await runDshTask({ repoRoot: "/missing-fixture", workDir: "/missing-fixture", selftest: true, env: { DEEPSEEK_BASE_URL: "https://example.invalid" } });
    assert.equal(out.status, "blocked");
    assert.match(out.reason, /本地/);
  });
});

describe("generation meters cannot be overwritten by opaque params", () => {
  it("rejects invalid counts and metering overrides before dispatch", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("invalid image reached local stub"); });
    for (const images of [-1, 0, 1.5, 9, Infinity, "2"]) {
      assert.equal((await runImageTask({ resolved, task: { id: "image", images }, env })).status, "blocked");
    }
    for (const params of [{ sequential_image_generation_options: { max_images: 100 } }, { sequential_image_generation: "auto" }, { n: 100 }, { model: "different-model" }, null]) {
      assert.equal((await runImageTask({ resolved, task: { id: "image", images: 1, params }, env })).status, "blocked");
    }
    assert.equal(calls, 0);
  });

  it("returns the number of generated images instead of the requested count", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ url: "http://127.0.0.1/one.png" }, { url: "http://127.0.0.1/two.png" }] }));
    const out = await runImageTask({ resolved, task: { id: "image", images: 1 }, env });
    assert.equal(out.units, 2);
    assert.equal(out.usageVerified, true);
  });

  it("rejects video duration overrides before submitting a task", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("invalid video reached local stub"); });
    for (const durationSeconds of [-1, 0, 9, 16, 32, 10.5, "12"]) {
      assert.equal((await runVideoTask({ resolved, task: { id: "video", durationSeconds }, env })).status, "blocked");
    }
    for (const params of [{ duration: 32 }, { model: "different-model" }, null]) {
      assert.equal((await runVideoTask({ resolved, task: { id: "video", durationSeconds: 12, params }, env })).status, "blocked");
    }
    assert.equal(calls, 0);
  });

  for (const [label, duration, expectedUnits, verified] of [["reported", 13, 13, true], ["missing", undefined, null, false]]) {
    it(`${label} video duration is explicit and cannot masquerade as requested actual usage`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls += 1;
        return Response.json(calls === 1 ? { id: "video" } : { status: "succeeded", content: { video_url: "http://127.0.0.1/video.mp4" }, ...(duration === undefined ? {} : { duration }) });
      });
      const out = await runVideoTask({ resolved, task: { id: "video", durationSeconds: 12 }, env, pollMs: 1, timeoutMs: 100 });
      assert.equal(out.units, expectedUnits);
      assert.equal(out.usageVerified, verified);
      assert.equal(calls, 2);
    });
  }
});
