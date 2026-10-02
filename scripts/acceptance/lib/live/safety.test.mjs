/** Public evidence boundaries. All credentials, services and provider replies here are synthetic. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maskSecret } from "../target.mjs";
import { resolveLiveModels, runChatTask, runImageTask, runVideoTask, runProductDispatchTask, loginAsMember } from "./providers.mjs";
import { apply, readDshAudit } from "./audit.plugin.mjs";
import { normalizeBudgets, createBudget } from "./budget.mjs";
import { foldDshUsage } from "./usage.mjs";
import { downloadArtifact } from "./media.mjs";
import { credentialValues, diagnosticReason, publicDiagnostic, PublicBoundaryError, publicResult, publicUrl, safeHttpEndpoint, sanitizePublic, secretVariants } from "./safety.mjs";

const secret = ["SYNTHETIC", "MC150", "secret:/+="].join("_");
const external = ["SYNTHETIC", "unknown-driver-detail"].join("_");
const privateEndpoint = (suffix) => ["https://", "user:", secret, "@synthetic.invalid", suffix].join("");
const resolved = { ready: true, credentialEnv: "CUSTOM_MODEL_ACCESS", model: "synthetic-model", baseUrl: "https://synthetic.invalid" };
const env = { CUSTOM_MODEL_ACCESS: secret };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const wire = (extra = {}) => ({ id: "synthetic-id", model: resolved.model, choices: [{ message: { content: "synthetic answer" } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, ...extra });
const safe = (value, forbidden = [secret, external, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) => {
  const text = JSON.stringify(value);
  for (const value of forbidden) assert.equal(text.includes(value), false, "Synthetic private value must never be in public evidence");
};
async function mock(fetcher, action) {
  const previous = globalThis.fetch; globalThis.fetch = fetcher;
  try { return await action(); } finally { globalThis.fetch = previous; }
}
function directory(t) { const dir = mkdtempSync(join(tmpdir(), "workloom-public-safety-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test("public safety: masked credentials reveal neither prefix nor short values", () => {
  for (const value of ["x", "abc", secret]) {
    const masked = maskSecret(value); assert.equal(masked.includes(value), false); assert.equal(masked.startsWith(value.slice(0, 4)), false);
  }
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(undefined), ""); assert.equal(maskSecret(null), "");
  assert.equal(maskSecret({ toString() { throw new Error(external); } }), "****");
});

test("public safety: malformed or credentialed model endpoints are safely disclosed and not ready for transport", () => {
  for (const endpoint of [privateEndpoint(`/v1?token=${encodeURIComponent(secret)}#${secret}`), "file:///private/config", `${external}://bad`]) {
    const models = resolveLiveModels([{ id: "synthetic", kind: "llm", adapter: "model-gateway", model: resolved.model, apiKeyEnv: resolved.credentialEnv }], { ...env, LLM_BASE_URL: endpoint });
    safe(models); assert.equal(models[0].ready, false); assert.ok(models[0].missing.length > 0);
  }
});

test("public safety: chat HTTP and unknown transport errors keep status and category, never external body or exception", async () => {
  for (const fetcher of [async () => new Response(`${secret} ${external}`, { status: 401 }), async () => { throw new Error(`${secret} ${external}`); }]) {
    const out = await mock(fetcher, () => runChatTask({ resolved, env, prompt: "synthetic" }));
    safe(out); assert.equal(out.status, "blocked"); assert.equal(out.called, true); assert.equal(out.tokens, null); assert.equal(out.receipt.synced, false);
    assert.ok(out.diagnostic?.category);
  }
});

test("public safety: secret-bearing answer, returned model or call id cannot remain a successful measured receipt", async () => {
  for (const mutate of [
    (reply) => { reply.choices[0].message.content = secret; },
    (reply) => { reply.choices[0].message.content = encodeURIComponent(secret); },
    (reply) => { reply.choices[0].message.content = Buffer.from(secret).toString("base64"); },
    (reply) => { reply.id = secret; }, (reply) => { reply.model = secret; },
    (reply) => { reply.choices[0].message.content = `Authorization: Bearer ${external}`; },
  ]) {
    const reply = wire(); mutate(reply);
    const out = await mock(async () => json(reply), () => runChatTask({ resolved, env, prompt: "synthetic" }));
    safe(out); assert.notEqual(out.status, "ok"); assert.equal(out.receipt.synced, false);
    // Disclosure failure does not erase authoritative usage already returned.
    assert.equal(out.tokens, 10); assert.equal(out.usage.complete, true); assert.equal(out.receipt.tokens, 10);
    assert.equal(out.publicSafety.redacted, true);
  }
});

test("public safety: image errors and media download exceptions do not reveal unknown private diagnostics", async (t) => {
  const out = await mock(async () => new Response(`${external} ${secret}`, { status: 403 }), () => runImageTask({ resolved, env, task: { id: "IMG-SAFE", prompt: "synthetic", images: 1 } }));
  safe(out); assert.equal(out.measurementComplete, false); assert.equal(out.receipt.synced, false); assert.match(out.reason, /403/);
  const download = await mock(async () => { throw new Error(external); }, () => downloadArtifact({ url: "https://synthetic.invalid/image.png", kind: "image", taskId: "IMG-SAFE", artifactsDir: directory(t) }));
  safe(download); assert.equal(download.ok, false); assert.ok(download.diagnostic?.category);
});

test("public safety: media endpoints with credentials reject before any request", async () => {
  for (const kind of ["image", "video"]) {
    let calls = 0;
    const out = await mock(async () => { calls += 1; throw new Error("Must not reach provider"); }, () => (kind === "image" ? runImageTask : runVideoTask)({
      resolved: { ...resolved, baseUrl: privateEndpoint(`?token=${secret}`) }, env,
      task: { id: "MEDIA-SAFE", prompt: "synthetic", images: 1, durationSeconds: 12 }, timeoutMs: 100,
    }));
    safe(out); assert.equal(out.status, "blocked"); assert.equal(out.called, false); assert.equal(calls, 0);
  }
});

test("public safety: credential-bearing artifact identity or declared model rejects before adapter I/O", async () => {
  for (const field of ["task-id", "declared-model"]) {
    let calls = 0;
    const out = await mock(async () => { calls += 1; return json({}, 403); }, () => runImageTask({
      resolved: { ...resolved, model: field === "declared-model" ? secret : resolved.model }, env,
      task: { id: field === "task-id" ? Buffer.from(secret).toString("base64url") : "IMG-SAFE", prompt: "synthetic", images: 1 },
    }));
    safe(out); assert.equal(out.status, "blocked"); assert.equal(out.called, false); assert.equal(calls, 0);
  }
});

test("public safety: a secret-bearing video task id is not used in polling URLs or public receipts", async () => {
  let calls = 0;
  const out = await mock(async () => { calls += 1; return json({ id: secret }); }, () => runVideoTask({ resolved, env, task: { id: "VID-SAFE", prompt: "synthetic", durationSeconds: 12 }, timeoutMs: 100, pollMs: 0 }));
  safe(out); assert.equal(out.status, "blocked"); assert.equal(out.measurementComplete, false); assert.equal(calls, 1);
});

test("public safety: video failed reply preserves task identity and unknown usage without raw response reflection", async () => {
  let calls = 0;
  const out = await mock(async () => json(++calls === 1 ? { id: "synthetic-video" } : { id: "synthetic-video", status: "failed", error: external }),
    () => runVideoTask({ resolved, env, task: { id: "VID-SAFE", prompt: "synthetic", durationSeconds: 12 }, timeoutMs: 100, pollMs: 0 }));
  safe(out); assert.equal(out.taskId, "synthetic-video"); assert.equal(out.receipt.synced, false); assert.equal(out.durationSeconds, null);
});

test("public safety: audit strips encoded and custom named credentials before durable hashing and freezes later I/O", async (t) => {
  const dir = directory(t); const file = join(dir, "audit.jsonl"); const config = join(dir, "config.json");
  const options = { outDir: dir, runId: "synthetic", budgets: normalizeBudgets({}).budgets, taskId: "LLM-SAFE", expectedTokens: 100, credentialEnvs: ["CUSTOM_MODEL_ACCESS"] };
  writeFileSync(config, JSON.stringify(options)); const listeners = new Map();
  const previous = process.env.CUSTOM_MODEL_ACCESS; process.env.CUSTOM_MODEL_ACCESS = secret;
  t.after(() => { if (previous === undefined) delete process.env.CUSTOM_MODEL_ACCESS; else process.env.CUSTOM_MODEL_ACCESS = previous; });
  apply({ on: (key, listener) => listeners.set(key, listener) }, { file, budgetConfigFile: config });
  listeners.get("session/event")({ id: "synthetic-session" }, { type: "user/message", seq: 0, time: 1, data: { text: encodeURIComponent(secret), token: external } });
  safe(readFileSync(file, "utf8")); const audit = readDshAudit(file); assert.equal(audit.ok, true); assert.equal(audit.redacted, true);
  let calls = 0;
  const request = listeners.get("llm/stream")({ model: resolved.model }, async function* () { calls += 1; yield { type: "finish" }; });
  await assert.rejects(async () => { for await (const chunk of request) void chunk; }); assert.equal(calls, 0);
  assert.equal(createBudget(options).summary().actual.llmCalls, 0);
});

test("public safety: malformed audit and unknown durable event errors never repeat untrusted values", (t) => {
  const file = join(directory(t), "audit.jsonl"); writeFileSync(file, `{${external}\n`);
  safe(readDshAudit(file));
  const usage = foldDshUsage([{ type: external, sessionId: "synthetic-session", seq: 0, time: 1, data: {} }]);
  safe(usage); assert.equal(usage.complete, false);
});

test("public safety: login failures do not expose upstream denial bodies", async () => {
  await mock(async () => json({ error: external }, 403), () => assert.rejects(() => loginAsMember({ apiUrl: "https://synthetic.invalid", workspaceSlug: "synthetic" }), (error) => {
    safe({ message: error.message, diagnostic: error.diagnostic }); return true;
  }));
});

test("public safety: product event evidence requiring credential redaction is blocked even if assertions pass", async () => {
  const token = secret; let dispatchAt;
  const out = await mock(async (url) => {
    if (String(url).includes("threads.dispatch")) { dispatchAt = new Date().toISOString(); return json({ result: { data: { threadId: "synthetic-thread", kind: "ask" } } }); }
    if (String(url).includes("threads.get")) return json({ result: { data: { id: "synthetic-thread", status: "completed" } } });
    if (String(url).includes("threads.events")) return json({ result: { data: [{ event_id: "E-1", object: { id: "synthetic-thread" }, context: { time: dispatchAt }, decision: { action: "ask.answer", after: { text: `synthetic result ${secret}` } } }] } });
    throw new Error("Unexpected local fixture route");
  }, () => runProductDispatchTask({ apiUrl: "https://synthetic.invalid", token, pollMs: 0, timeoutMs: 100, task: { title: "synthetic", state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", contains: "synthetic result" } }] } }));
  safe(out); assert.notEqual(out.status, "ok"); assert.equal(out.receipt.synced, false); assert.equal(out.publicSafety.redacted, true);
});

test("public safety: root assets include the safety module and its proof tests", async () => {
  const scope = JSON.parse(readFileSync(new URL("../../../../sync/base-scope.json", import.meta.url)));
  for (const path of ["scripts/acceptance/lib/live/safety.mjs", "scripts/acceptance/lib/live/safety.test.mjs", "scripts/acceptance/lib/client-identity.mjs", "scripts/acceptance/lib/client-identity.test.mjs"]) assert.ok(scope.requiredRootAssets.files.includes(path), `Missing controlled root asset ${path}`);
});

test("public safety helper: short, custom, escaped and encoded secrets are removed without censoring clean hostnames", () => {
  const options = { env: { CUSTOM_ACCESS: "k", SYNTHETIC_TOKEN: secret }, credentialEnvs: ["CUSTOM_ACCESS"] };
  assert.deepEqual(new Set(credentialValues(options)), new Set(["k", secret]));
  const variants = secretVariants({ env, credentialEnvs: [resolved.credentialEnv] });
  assert.ok(variants.length >= 3);
  for (const encoded of variants) safe(sanitizePublic({ text: encoded }, { env, credentialEnvs: [resolved.credentialEnv] }).value);
  for (const text of ["k", "Credential k", "Authorization: Bearer k"]) {
    const clean = sanitizePublic({ text }, options); assert.equal(clean.changed, true); assert.notEqual(clean.value.text, text);
  }
  assert.equal(sanitizePublic("https://api.deepseek.com", options).value, "https://api.deepseek.com");
  assert.equal(publicUrl("https://api.deepseek.com"), "https://api.deepseek.com");
  assert.equal(safeHttpEndpoint("https://user:private@example.invalid"), null);
});

test("public safety helper: secret fields, malicious getters/toJSON, cycles and prototype keys cannot expose private data", () => {
  let calls = 0;
  const input = { password: 1234, api_key: external, totalTokens: 10, token: false };
  Object.defineProperty(input, "unknown", { enumerable: true, get() { calls += 1; throw new Error(external); } });
  Object.defineProperty(input, "toJSON", { enumerable: true, value() { calls += 1; return { secret: external }; } });
  const clean = sanitizePublic(input, { env });
  safe(clean.value); assert.equal(clean.changed, true); assert.equal(calls, 0); assert.equal(clean.value.totalTokens, 10);
  assert.equal(clean.value.password, "[REDACTED]"); assert.equal(clean.value.token, "[REDACTED]");
  const cycle = {}; cycle.self = cycle; assert.equal(sanitizePublic(cycle).changed, true);
  const prototype = JSON.parse('{"__proto__":{"polluted":true}}'); const out = sanitizePublic(prototype).value;
  assert.equal({}.polluted, undefined); assert.equal(Object.hasOwn(out, "__proto__"), true);
});

test("public safety helper: errors keep only known local text, numeric HTTP states and fixed categories", () => {
  const hostile = Object.defineProperty({}, "status", { get() { throw new Error(external); } });
  for (const error of [new Error(external), external, { status: `401 ${external}` }, hostile, { statusCode: Infinity }, { name: { toString() { throw new Error(external); } } }]) {
    safe(publicDiagnostic(error)); safe(diagnosticReason(error, "Controlled failure"));
    assert.equal(publicDiagnostic(error).category, "upstream_unknown");
  }
  assert.deepEqual(publicDiagnostic({ status: 403 }), { category: "upstream_authentication", httpStatus: 403 });
  assert.deepEqual(publicDiagnostic({ code: "ETIMEDOUT" }), { category: "timeout" });
  const local = new PublicBoundaryError("Controlled local validation failed", "invalid_evidence");
  assert.equal(diagnosticReason(local, "fallback"), local.message);
  assert.equal(local.cause, undefined);
});

test("public safety helper: redacted success becomes blocked while an existing proven failure stays failed and measured", () => {
  for (const status of ["ok", "failed"]) {
    const result = publicResult({ status, answer: secret, tokens: 10, usage: { complete: true, totalTokens: 10 }, receipt: { synced: status === "ok", tokens: 10 } }, { env, credentialEnvs: [resolved.credentialEnv] });
    safe(result); assert.equal(result.status, status === "ok" ? "blocked" : "failed"); assert.equal(result.tokens, 10);
    assert.equal(result.receipt.synced, false); assert.equal(result.publicSafety.redacted, true);
  }
});
