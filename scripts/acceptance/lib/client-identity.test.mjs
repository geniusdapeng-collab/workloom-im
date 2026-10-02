/** Ordinary installation contract fixtures; none is a real customer's installed client. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectClientIdentity } from "./client-identity.mjs";
import { probeEnvironment } from "./target.mjs";
const { generatePayloadIntegrity } = createRequire(import.meta.url)("../../../apps/desktop/electron/payload-integrity.cjs");

const instanceId = "11111111-1111-4111-8111-111111111111";
const urls = { api: "http://127.0.0.1:8787", pc: "http://localhost:5173" };
function fixture(t) {
  const supportDir = mkdtempSync(join(tmpdir(), "workloom-client-identity-"));
  t.after(() => rmSync(supportDir, { recursive: true, force: true }));
  const state = { schemaVersion: "workloom.install-state/v1", status: "complete", phase: "ready", targetVersion: "1.0.0", updatedAt: new Date().toISOString(),
    runtimeIdentity: { schemaVersion: "workloom.client-runtime-identity/v1", instanceId, supportDir: realpathSync(supportDir), productId: "synthetic-product", payloadVersion: "1.0.0",
      productManifestSha256: "1".repeat(64), payloadIntegritySha256: "2".repeat(64), ports: { server: 8787, web: 5173 } } };
  return { supportDir, state, file: join(supportDir, "install-state.json"), options: { supportDir, urls, expectedProductId: "synthetic-product" } };
}

function installed(t) {
  const f = fixture(t);
  const put = (path, bytes) => { const file = join(f.supportDir, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, bytes); };
  for (const path of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) put(path, "1.0.0\n");
  put("runtime/product.manifest.json", JSON.stringify({ productId: f.state.runtimeIdentity.productId }));
  for (const path of ["runtime/.env.defaults", "runtime/scripts/desktop-bootstrap-db.mjs", "node/bin/node", "pg/bin/postgres", "pg/bin/pg_ctl", "pg/bin/initdb", "nats/nats-server", "python/bin/python3.12"]) put(path, "synthetic immutable bytes\n");
  symlinkSync("python3.12", join(f.supportDir, "python/bin/python3"));
  const proof = generatePayloadIntegrity(f.supportDir, { expectedProductId: f.state.runtimeIdentity.productId, expectedVersion: "1.0.0" });
  f.state.runtimeIdentity.productManifestSha256 = proof.productManifestSha256; f.state.runtimeIdentity.payloadIntegritySha256 = proof.payloadIntegritySha256;
  writeFileSync(f.file, JSON.stringify(f.state));
  return { ...f, put, proof };
}

test("client identity contract: generated ordinary bytes and internal Python link match every current ready fingerprint", (t) => {
  const f = installed(t); const result = inspectClientIdentity(f.options);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.identity.instanceId, instanceId);
  assert.equal(result.identity.payloadIntegritySha256, f.proof.payloadIntegritySha256); assert.equal(result.identity.productManifestSha256, f.proof.productManifestSha256);
  assert.equal(result.identity.supportDir, realpathSync(f.supportDir)); assert.equal(f.proof.linkCount, 1);
});

test("client identity contract: changed immutable bytes, new assets, changed link or swapped index cannot borrow ready state", (t) => {
  for (const mutate of [
    (f) => f.put("node/bin/node", "tampered immutable bytes\n"), (f) => f.put("runtime/unindexed.mjs", "unexpected"),
    (f) => { rmSync(join(f.supportDir, "python/bin/python3")); symlinkSync("./python3.12", join(f.supportDir, "python/bin/python3")); },
    (f) => { const index = JSON.parse(readFileSync(join(f.supportDir, "payload-integrity.json"))); index.mutablePaths.push("node/bin/node"); f.put("payload-integrity.json", JSON.stringify(index)); },
    (f) => { f.state.runtimeIdentity.payloadIntegritySha256 = "0".repeat(64); writeFileSync(f.file, JSON.stringify(f.state)); },
  ]) { const f = installed(t); mutate(f); assert.equal(inspectClientIdentity(f.options).ok, false); }
});

test("client identity contract: mutable .env is never read and unknown installed fields never appear in public evidence", (t) => {
  const f = installed(t); f.put("runtime/.env", "SYNTHETIC_PASSWORD=unread-private-fixture\n"); chmodSync(join(f.supportDir, "runtime/.env"), 0o000);
  f.state.databasePassword = "SYNTHETIC_UNKNOWN_STATE_DETAIL"; writeFileSync(f.file, JSON.stringify(f.state));
  const result = inspectClientIdentity(f.options); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_UNKNOWN_STATE_DETAIL"), false); assert.equal(JSON.stringify(result).includes("unread-private-fixture"), false);
  chmodSync(join(f.supportDir, "runtime/.env"), 0o600);
});

test("client identity contract: only matching HTTP service/current UUID and web product metadata complete the probe", async (t) => {
  const f = installed(t); const previous = globalThis.fetch;
  const env = { kind: "client-runtime", supportDir: f.supportDir, expectedProductId: f.state.runtimeIdentity.productId, urls };
  const health = { ok: true, service: "workloom-im-server", instanceId };
  const page = `<html><head><meta name="workloom-product-id" content="${env.expectedProductId}"></head><body>Synthetic</body></html>`;
  let body = page;
  let headerInstance = instanceId; let headerProduct = env.expectedProductId; let httpStatus = 200;
  globalThis.fetch = async (url) => String(url).endsWith("/health") ? new Response(JSON.stringify(health), { status: httpStatus })
    : new Response(body, { headers: { "x-workloom-instance-id": headerInstance, "x-workloom-product-id": headerProduct } });
  try {
    assert.equal((await probeEnvironment({ env })).ok, true);
    for (const [mutate, restore] of [
      [() => { health.instanceId = "22222222-2222-4222-8222-222222222222"; }, () => { health.instanceId = instanceId; }],
      [() => { health.service = "foreign-service"; }, () => { health.service = "workloom-im-server"; }],
      [() => { httpStatus = 500; }, () => { httpStatus = 200; }],
      [() => { headerInstance = "22222222-2222-4222-8222-222222222222"; }, () => { headerInstance = instanceId; }],
      [() => { headerProduct = "foreign-product"; }, () => { headerProduct = env.expectedProductId; }],
      [() => { body = "<html>foreign product</html>"; }, () => { body = page; }],
      [() => { body = `<meta name="workloom-product-id" content="${env.expectedProductId}">`; }, () => { body = page; }],
    ]) { mutate(); assert.equal((await probeEnvironment({ env })).ok, false); restore(); }
  } finally { globalThis.fetch = previous; }
});

test("client identity: missing support directory, runtime VERSION alone and malformed state cannot pass", (t) => {
  const f = fixture(t);
  for (const options of [{}, { supportDir: join(f.supportDir, "missing"), urls }]) assert.equal(inspectClientIdentity(options).ok, false);
  mkdirSync(join(f.supportDir, "runtime")); writeFileSync(join(f.supportDir, "runtime/VERSION"), "1.0.0\n");
  assert.equal(inspectClientIdentity(f.options).ok, false);
  writeFileSync(f.file, "{SYNTHETIC_UNTRUSTED_PARSE_DETAIL\n");
  const result = inspectClientIdentity(f.options); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("SYNTHETIC_UNTRUSTED_PARSE_DETAIL"), false);
});

test("client identity: stopped/incomplete/stale product/version/hash/port evidence fails closed", (t) => {
  const f = installed(t); assert.equal(inspectClientIdentity(f.options).ok, true);
  for (const mutate of [
    (state) => { state.status = "stopped"; }, (state) => { state.phase = "starting"; }, (state) => { delete state.runtimeIdentity; },
    (state) => { state.runtimeIdentity.instanceId = "not-a-current-uuid"; }, (state) => { state.runtimeIdentity.supportDir = "/foreign/support"; },
    (state) => { state.runtimeIdentity.payloadVersion = "0.9.0"; }, (state) => { state.runtimeIdentity.productId = "foreign-product"; },
    (state) => { state.runtimeIdentity.payloadIntegritySha256 = "not-a-hash"; }, (state) => { state.runtimeIdentity.productManifestSha256 = "not-a-hash"; },
    (state) => { state.runtimeIdentity.ports.server = 8788; }, (state) => { state.runtimeIdentity.ports.web = 8787; },
    (state) => { state.updatedAt = new Date(Date.now() + 3600_000).toISOString(); },
    (state) => { state.updatedAt = "2026"; }, (state) => { state.updatedAt = "2026-02-30T00:00:00.000Z"; },
  ]) {
    const state = structuredClone(f.state); mutate(state); writeFileSync(f.file, JSON.stringify(state));
    assert.equal(inspectClientIdentity(f.options).ok, false);
  }
});

test("client identity: linked or unreadable install-state never authorizes an installed client", (t) => {
  const f = installed(t); assert.equal(inspectClientIdentity(f.options).ok, true);
  rmSync(f.file); const outside = join(f.supportDir, "external-state.json"); writeFileSync(outside, JSON.stringify(f.state));
  symlinkSync(outside, f.file); assert.equal(inspectClientIdentity(f.options).ok, false); rmSync(f.file);
  writeFileSync(f.file, JSON.stringify(f.state)); chmodSync(f.file, 0o000);
  assert.equal(inspectClientIdentity(f.options).ok, false); chmodSync(f.file, 0o600);
});

test("client identity: credentialed, foreign host and wrong PC port cannot reuse a matching UUID", (t) => {
  const f = installed(t); assert.equal(inspectClientIdentity(f.options).ok, true);
  for (const target of [{ ...urls, api: "https://foreign.invalid:8787" }, { ...urls, api: "http://user:private@127.0.0.1:8787" },
    { ...urls, api: `${urls.api}?token=private` }, { ...urls, pc: "http://localhost:3000" }]) assert.equal(inspectClientIdentity({ ...f.options, urls: target }).ok, false);
});

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function actualHttpInstallation(t, override = {}) {
  const f = installed(t);
  const productId = f.state.runtimeIdentity.productId;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="workloom-product-id" content="${productId}"><title>Synthetic</title></head><body>Synthetic local fixture</body></html>`;
  const health = JSON.stringify({ ok: true, service: "workloom-im-server", instanceId });
  const calls = { api: 0, web: 0, lookalike: 0 };
  const send = (res, body, json = false) => {
    res.setHeader("content-type", json ? "application/json" : "text/html");
    res.setHeader("x-workloom-instance-id", instanceId);
    res.setHeader("x-workloom-product-id", productId);
    if (override.chunked) { res.write(body); res.end(); }
    else res.end(body);
  };
  const lookalike = await localServer(t, (req, res) => {
    calls.lookalike += 1;
    send(res, req.url === "/health" ? health : html, req.url === "/health");
  });
  const api = await localServer(t, (req, res) => {
    calls.api += 1;
    if (override.redirect === "api") { res.writeHead(302, { location: `${lookalike}/health` }); res.end(); }
    else send(res, override.healthBody ?? health, true);
  });
  const pc = await localServer(t, (req, res) => {
    calls.web += 1;
    if (override.redirect === "web") { res.writeHead(302, { location: lookalike }); res.end(); }
    else send(res, typeof override.html === "function" ? override.html({ html, productId }) : override.html ?? html);
  });
  f.state.runtimeIdentity.ports = { server: Number(new URL(api).port), web: Number(new URL(pc).port) };
  writeFileSync(f.file, JSON.stringify(f.state));
  const env = { kind: "client-runtime", supportDir: f.supportDir, expectedProductId: productId, urls: { api, pc } };
  assert.equal(inspectClientIdentity({ ...f.options, urls: env.urls }).ok, true, "The actual HTTP test must start with valid ordinary installed bytes");
  return { env, calls };
}

test("actual HTTP installed identity: matching current services and one controlled head marker pass", async (t) => {
  const f = await actualHttpInstallation(t);
  const result = await probeEnvironment({ env: f.env });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
});

for (const redirect of ["api", "web"]) {
  test(`actual HTTP installed identity: ${redirect} redirect cannot borrow same-UUID lookalike at another port`, async (t) => {
    const f = await actualHttpInstallation(t, { redirect });
    const result = await probeEnvironment({ env: f.env });
    assert.equal(result.ok, false, JSON.stringify({ checks: result.checks, calls: f.calls }));
    assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 }, "A redirect target must never receive a probe request");
  });
}

const misleadingHtml = {
  "script text": ({ productId }) => `<html><head><script>const marker = '<meta name="workloom-product-id" content="${productId}">';</script></head><body>Synthetic</body></html>`,
  "HTML comment": ({ productId }) => `<html><head><!-- <meta name="workloom-product-id" content="${productId}"> --></head><body>Synthetic</body></html>`,
  "duplicate identity tags": ({ productId }) => `<html><head><meta name="workloom-product-id" content="${productId}"><meta name="workloom-product-id" content="foreign-product"></head><body>Synthetic</body></html>`,
  "template content": ({ productId }) => `<html><head><template><meta name="workloom-product-id" content="${productId}"></template></head><body>Synthetic</body></html>`,
  "attribute text": ({ productId }) => `<html><head><meta data-fixture='<meta name="workloom-product-id" content="${productId}">'></head><body>Synthetic</body></html>`,
  "body metadata": ({ productId }) => `<html><head><title>Synthetic</title></head><body><meta name="workloom-product-id" content="${productId}"></body></html>`,
  "omitted head": ({ productId }) => `<meta name="workloom-product-id" content="${productId}">`,
  "head ended by content": ({ productId }) => `<html><head><div>Synthetic</div><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>`,
  "identical duplicate identity tags": ({ productId }) => `<html><head><meta name="workloom-product-id" content="${productId}"><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>`,
  "head ended by textarea": ({ productId }) => `<html><head><textarea>Synthetic</textarea><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>`,
  "head ended by xmp": ({ productId }) => `<html><head><xmp>Synthetic</xmp><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>`,
  "head ended by iframe": ({ productId }) => `<html><head><iframe>Synthetic</iframe><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>`,
  "noscript text": ({ productId }) => `<html><head><noscript><meta name="workloom-product-id" content="${productId}"></noscript></head><body>Synthetic</body></html>`,
};
for (const [description, html] of Object.entries(misleadingHtml)) {
  test(`actual HTTP installed identity: ${description} cannot impersonate the controlled head marker`, async (t) => {
    const f = await actualHttpInstallation(t, { html });
    const result = await probeEnvironment({ env: f.env });
    assert.equal(result.ok, false, JSON.stringify({ checks: result.checks, calls: f.calls }));
    assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
  });
}

for (const surface of ["health", "web"]) {
  test(`actual HTTP installed identity: oversized ${surface} body fails bounded probing`, async (t) => {
    const override = surface === "health"
      ? { healthBody: `${JSON.stringify({ ok: true, service: "workloom-im-server", instanceId })}${" ".repeat(64_001)}` }
      : { html: ({ html }) => `${html}${" ".repeat(2_000_001)}` };
    const f = await actualHttpInstallation(t, override);
    const result = await probeEnvironment({ env: f.env });
    assert.equal(result.ok, false, JSON.stringify({ checks: result.checks, calls: f.calls }));
    assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
  });

  test(`actual HTTP installed identity: chunked oversized ${surface} body is rejected without content-length`, async (t) => {
    const override = surface === "health"
      ? { chunked: true, healthBody: `${JSON.stringify({ ok: true, service: "workloom-im-server", instanceId })}${" ".repeat(64_001)}` }
      : { chunked: true, html: ({ html }) => `${html}${" ".repeat(2_000_001)}` };
    const f = await actualHttpInstallation(t, override);
    const result = await probeEnvironment({ env: f.env });
    assert.equal(result.ok, false, JSON.stringify({ checks: result.checks, calls: f.calls }));
    assert.ok(result.checks.some((row) => row.diagnostic?.category === "target_body_invalid"));
    assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
  });

  test(`actual HTTP installed identity: valid ${surface} body at its exact byte limit is accepted`, async (t) => {
    const health = JSON.stringify({ ok: true, service: "workloom-im-server", instanceId });
    const override = surface === "health"
      ? { chunked: true, healthBody: `${health}${" ".repeat(64_000 - Buffer.byteLength(health))}` }
      : { chunked: true, html: ({ html }) => `${html}${" ".repeat(2_000_000 - Buffer.byteLength(html))}` };
    const f = await actualHttpInstallation(t, override);
    const result = await probeEnvironment({ env: f.env });
    assert.equal(result.ok, true, JSON.stringify({ checks: result.checks, calls: f.calls }));
    assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
  });
}

test("actual HTTP installed identity: inert comments/scripts/templates do not obscure one real head marker", async (t) => {
  const f = await actualHttpInstallation(t, { html: ({ productId }) => `<html><head><!-- <meta name="workloom-product-id" content="foreign-product"> --><script>const inert = '<meta name="workloom-product-id" content="foreign-product">';</script><template><meta name="workloom-product-id" content="foreign-product"></template><meta name="workloom-product-id" content="${productId}"></head><body>Synthetic</body></html>` });
  const result = await probeEnvironment({ env: f.env });
  assert.equal(result.ok, true, JSON.stringify({ checks: result.checks, calls: f.calls }));
  assert.deepEqual(f.calls, { api: 1, web: 1, lookalike: 0 });
});
