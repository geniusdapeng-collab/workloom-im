"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { redactDiagnostic, redactText } = require("./diagnostic-redaction.cjs");
const { httpOk, assertServicePortsFree, assertChildRunning, writeInstallCheckpoint, installPayloadAtomically } = require("./bootstrap.cjs");

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test("diagnostics redact URL, env, JSON, nested keys, auth and private keys without canaries", () => {
  const canaries = ["db-canary", "service-canary", "json-canary", "password-canary", "nested-canary", "auth-canary", "pem-canary", "query-canary"];
  // Build deliberately secret-shaped inputs at runtime; no usable credential or
  // private-key block belongs in the source checked by the release scanner.
  const pem = (edge) => [`-----${edge} `, "PRIVATE", " KEY-----"].join("");
  const raw = [["postgres://workloom:", canaries[0], "@localhost:5432/db"].join(""), `SERVICE_C_SECRET=${canaries[1]}`,
    JSON.stringify({ API_KEY: canaries[2], password: canaries[3] }), `Authorization: Bearer ${canaries[5]}`,
    `https://host.test/path?access_token=${canaries[7]}`, pem("BEGIN"), canaries[6], pem("END")].join("\n");
  const redacted = JSON.stringify(redactDiagnostic({ raw, nested: [{ refresh_token: canaries[4] }], error: new Error(raw) }));
  for (const canary of canaries) assert.equal(redacted.includes(canary), false, canary);
  assert.match(redacted, /localhost:5432\/db/);
  assert.equal(redactText("error: safe diagnostic"), "error: safe diagnostic");
});

test("checkpoint error persistence uses the same redaction boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-"));
  try {
    const neverPersist = "never-persist-canary";
    const nestedCanary = "nested-canary";
    writeInstallCheckpoint(dir, { status: "failed", error: `password=${neverPersist}`, credentials: { api_key: nestedCanary } });
    const written = fs.readFileSync(path.join(dir, "install-state.json"), "utf8");
    assert.equal(written.includes("never-persist-canary"), false);
    assert.equal(written.includes("nested-canary"), false);
    assert.equal(JSON.parse(written).status, "failed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("encoded diagnostics and unfinished private-key blocks redact secrets while preserving ordinary identity bytes", () => {
  const syntheticValue = "encoded-synthetic-private";
  for (const raw of [`SERVICE_C_SECRET=${syntheticValue}`, `https://public.example.test/?access_token=${syntheticValue}`, ["postgres://fixture:", syntheticValue, "@localhost/db"].join("")]) {
    for (const encoded of [encodeURIComponent(raw), encodeURIComponent(encodeURIComponent(raw))]) {
      assert.equal(redactText(encoded).includes("encoded-synthetic-private"), false);
      assert.equal(redactText(encoded).includes(encodeURIComponent("encoded-synthetic-private")), false);
    }
  }
  const safe = "supportDir=/fixture/%61/data; productId=fixture-industry; public=https://public.example.test/guide";
  assert.equal(redactText(safe), safe);
  const pemBegin = ["-----BEGIN ", "PRIVATE", " KEY-----"].join("");
  assert.equal(redactText(`${pemBegin}\nunlabelled-unfinished-synthetic-private`).includes("unlabelled-unfinished-synthetic-private"), false);
  assert.equal(redactText("bare literal-synthetic-private", ["literal-synthetic-private"]).includes("literal-synthetic-private"), false);
});
const knownLiteral = 'fixture-literal-é\\"';
for (const [name, encoded] of [
  ["lowercase percent", encodeURIComponent(knownLiteral).replace(/%[a-f0-9]{2}/giu, (value) => value.toLowerCase())],
  ["fully encoded percent", [...Buffer.from(knownLiteral)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")],
  ["JSON string escape", JSON.stringify(knownLiteral).slice(1, -1)],
  ["base64", Buffer.from(knownLiteral).toString("base64")],
  ["base64url", Buffer.from(knownLiteral).toString("base64url")],
]) test(`known managed literal cannot leak through ${name} diagnostics`, () => {
  assert.equal(redactText(`opaque ${encoded}`, [knownLiteral]), "opaque [已脱敏]");
});
test("short legacy values redact complete tokens without corrupting public product identity substrings", () => {
  assert.equal(redactText("opaque workloom", ["workloom"]), "opaque [已脱敏]");
  assert.equal(redactText("productId=workloom-im; supportDir=/fixture/workloom-im/data", ["workloom"]), "productId=workloom-im; supportDir=/fixture/workloom-im/data");
});

test("actual HTTP identity checks reject errors, redirects, malformed and oversized bodies, and inert or duplicate HTML markers", async (t) => {
  const instanceId = "698edb78-6cbf-413c-859a-0770d9ba41b9";
  const productId = "fixture-industry";
  const expectedBackend = { service: "workloom-im-server", instanceId };
  const expectedWeb = { productId, instanceId };
  const marker = `<meta name="workloom-product-id" content="${productId}">`;
  const backend = JSON.stringify({ ok: true, ...expectedBackend });
  const html = (head) => `<html><head>${head}</head><body>fixture</body></html>`;
  let mode = {};
  const f = await listen((_request, response) => {
    response.statusCode = mode.status ?? 200;
    if (mode.redirect) { response.setHeader("location", "/valid"); response.end(); return; }
    if (mode.wait) return;
    if (mode.web) {
      if (!mode.noHeaders) {
        response.setHeader("x-workloom-instance-id", mode.headerInstance ?? instanceId);
        response.setHeader("x-workloom-product-id", mode.headerProduct ?? productId);
      }
    }
    response.end(mode.body ?? backend);
  });
  t.after(f.close);
  const cases = [
    ["valid backend", { body: backend }, expectedBackend, true],
    ["503 correct body", { status: 503 }, expectedBackend, false],
    ["redirect", { status: 302, redirect: true }, expectedBackend, false],
    ["malformed JSON", { body: "{bad" }, expectedBackend, false],
    ["null JSON", { body: "null" }, expectedBackend, false],
    ["truthy ok", { body: JSON.stringify({ ...expectedBackend, ok: "true" }) }, expectedBackend, false],
    ["wrong service", { body: JSON.stringify({ ok: true, service: "other-service", instanceId }) }, expectedBackend, false],
    ["wrong instance", { body: JSON.stringify({ ok: true, ...expectedBackend, instanceId: "old-instance" }) }, expectedBackend, false],
    ["backend over 64 KB", { body: JSON.stringify({ ok: true, ...expectedBackend, padding: "x".repeat(65_000) }) }, expectedBackend, false],
    ["valid page", { web: true, body: html(marker) }, expectedWeb, true],
    ["missing headers", { web: true, noHeaders: true, body: html(marker) }, expectedWeb, false],
    ["wrong web instance", { web: true, headerInstance: "old-instance", body: html(marker) }, expectedWeb, false],
    ["wrong web product", { web: true, headerProduct: "other-product", body: html(marker) }, expectedWeb, false],
    ["comment only", { web: true, body: html(`<!--${marker}-->`) }, expectedWeb, false],
    ["script only", { web: true, body: html(`<script>${JSON.stringify(marker)}</script>`) }, expectedWeb, false],
    ["style only", { web: true, body: html(`<style>${marker}</style>`) }, expectedWeb, false],
    ["title only", { web: true, body: html(`<title>${marker}</title>`) }, expectedWeb, false],
    ["template only", { web: true, body: html(`<template>${marker}</template>`) }, expectedWeb, false],
    ["attribute only", { web: true, body: html(`<link data-example='${marker}'>`) }, expectedWeb, false],
    ...["textarea", "xmp", "iframe", "noembed", "noframes"].map((name) => [`${name} inside head before real marker`, { web: true, body: html(`<${name}>inert fixture</${name}>${marker}`) }, expectedWeb, false]),
    ...["textarea", "xmp", "iframe", "noembed", "noframes", "div"].map((name) => [`${name} before explicit head`, { web: true, body: `<html><${name}>fixture</${name}><head>${marker}</head><body>fixture</body></html>` }, expectedWeb, false]),
    ["duplicate meta", { web: true, body: html(marker + marker) }, expectedWeb, false],
    ["body meta", { web: true, body: `<html><head></head><body>${marker}</body></html>` }, expectedWeb, false],
    ["genuine marker and commented duplicate", { web: true, body: html(marker + `<!--${marker}-->`) }, expectedWeb, true],
    ["page over 2 MB", { web: true, body: html(marker) + "x".repeat(2_000_000) }, expectedWeb, false],
    ["HTTP timeout", { wait: true }, expectedBackend, false],
  ];
  for (const [name, value, expected, result] of cases) {
    await t.test(name, async () => { mode = value; assert.equal(await httpOk(`http://127.0.0.1:${f.port}`, expected), result); });
  }
});

test("foreign HTTP 200 and incorrect instance/product cannot satisfy readiness", async () => {
  let mode = "foreign";
  const fixture = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "web") {
      res.setHeader("x-workloom-product-id", "fixture-industry");
      res.setHeader("x-workloom-instance-id", "fresh-instance");
      res.end('<!doctype html><html><head><meta name="workloom-product-id" content="fixture-industry"></head><body>fixture</body></html>');
    } else res.end(JSON.stringify({ ok: true, service: mode === "foreign" ? "other-service" : "workloom-im-server", instanceId: mode === "wrong" ? "other-instance" : "fresh-instance" }));
  });
  try {
    const url = `http://127.0.0.1:${fixture.port}`;
    assert.equal(await httpOk(url), false);
    assert.equal(await httpOk(url, { service: "workloom-im-server", instanceId: "fresh-instance" }), false);
    mode = "wrong";
    assert.equal(await httpOk(url, { service: "workloom-im-server", instanceId: "fresh-instance" }), false);
    mode = "correct";
    assert.equal(await httpOk(url, { service: "workloom-im-server", instanceId: "fresh-instance" }), true);
    mode = "web";
    assert.equal(await httpOk(url, { productId: "fixture-industry", instanceId: "fresh-instance" }), true);
    assert.equal(await httpOk(url, { productId: "foreign-product", instanceId: "fresh-instance" }), false);
  } finally { await fixture.close(); }
});

test("whole bootstrap refuses occupied foreign port before payload/database mutations", async () => {
  const fixture = await listen((_req, res) => res.end("foreign-product"));
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-collision-"));
  try {
    await assert.rejects(assertServicePortsFree({ server: fixture.port }), /EADDRINUSE/);
    const child = spawn(process.execPath, [path.join(__dirname, "bootstrap.cjs"), "--smoke", "--resources", path.join(support, "absent"), "--support", support], { env: { ...process.env, PATH: "", WORKLOOM_SERVER_PORT: String(fixture.port) } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, 1);
    assert.match(output, /EADDRINUSE/);
    assert.equal(fs.existsSync(path.join(support, "VERSION")), false);
    assert.equal(fs.existsSync(path.join(support, "database-state.json")), false);
    assert.equal(fs.existsSync(path.join(support, ".bootstrap-lock")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(support, "install-state.json"))).status, "failed");
    assert.equal((await fetch(`http://127.0.0.1:${fixture.port}`)).status, 200);
  } finally { await fixture.close(); fs.rmSync(support, { recursive: true, force: true }); }
});

test("dead child cannot be reported ready even with an HTTP response", () => {
  assert.throws(() => assertChildRunning({ pid: process.pid, exitCode: 1, signalCode: null }, "test"), /已退出/);
});

test("industry payload requires Python before atomic install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-required-python-"));
  try {
    for (const part of ["runtime", "node", "pg"]) fs.mkdirSync(path.join(root, part));
    fs.writeFileSync(path.join(root, "runtime", "industry-runtime.json"), JSON.stringify({ schemaVersion: "workloom.industry-runtime/v1", requiredParts: ["python"] }));
    assert.throws(() => installPayloadAtomically({ sourceRoot: root, supportDir: path.join(root, "support"), payloadVer: "v1" }), /python/u);
    assert.equal(fs.existsSync(path.join(root, "support", "VERSION")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
