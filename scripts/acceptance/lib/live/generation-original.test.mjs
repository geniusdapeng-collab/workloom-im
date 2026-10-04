/** MC033 original five identities and artifact bodies replayed at the current CLI contract.
 * The immutable r04 probe retains the old URL-only response shape and local pass rule.
 * This adapter adds required model/usage/task identity fields and uses pipeline success,
 * while transport remains explicitly synthetic and never creates production evidence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fixture as cliFixture } from "./cli-fixtures.mjs";
import { inspectLocalArtifact } from "./media.mjs";

// Exact standards-valid 69-byte RGB PNG from immutable original-artifact-verified-fixture-red-r04.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = [
  { label: "image-valid-png-control", kind: "image", mode: "valid", shouldPass: true },
  { label: "image-url-404", kind: "image", mode: "404", shouldPass: false },
  { label: "image-empty-200", kind: "image", mode: "empty", shouldPass: false },
  { label: "image-html-200", kind: "image", mode: "html", shouldPass: false },
  { label: "video-url-404", kind: "video", mode: "404", shouldPass: false },
];

for (const fixture of fixtures) {
  test(`MC033 original replay: ${fixture.label}`, async (t) => {
    const requests = []; let base;
    const server = createServer(async (req, res) => {
      let text = ""; for await (const bytes of req) text += bytes;
      let body; try { body = text ? JSON.parse(text) : null; } catch { res.writeHead(400); return res.end("synthetic malformed input"); }
      requests.push({ method: req.method, path: req.url, body, authorizationPresent: Boolean(req.headers.authorization) });
      const json = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/api/v3/images/generations") return json({ created: 1, model: "fixture-image", usage: { generated_images: 1 }, data: [{ url: `${base}/fixture.png` }] });
      if (req.url === "/api/v3/contents/generations/tasks" && req.method === "POST") return json({ id: "synthetic-video" });
      if (req.url === "/api/v3/contents/generations/tasks/synthetic-video") return json({ id: "synthetic-video", model: "fixture-video", status: "succeeded", duration: 12, content: { video_url: `${base}/fixture.mp4` } });
      if (req.url === "/fixture.png" || req.url === "/fixture.mp4") {
        if (fixture.mode === "404") { res.writeHead(404); return res.end("synthetic missing artifact"); }
        if (fixture.mode === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>synthetic gateway error</html>"); }
        res.writeHead(200, { "content-type": "image/png" }); return res.end(fixture.mode === "empty" ? Buffer.alloc(0) : png);
      }
      return json({ ok: true, syntheticFixture: true });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    base = `http://127.0.0.1:${server.address().port}`;
    const profile = { dataMode: "simulated", environment: { kind: "local-preview", target: { apiUrl: base, pcUrl: base, bMobileUrl: base, cMobileUrl: base }, timeouts: { healthMs: 500 } },
      live: { enabled: true, evidenceMode: "synthetic", models: [{ id: fixture.kind, kind: fixture.kind, adapter: "gen-http", model: `fixture-${fixture.kind}`, apiKeyEnv: "SYNTHETIC_API_KEY", baseUrlEnv: "SYNTHETIC_BASE_URL" }],
        tasks: [{ id: "ARTIFACT", kind: fixture.kind, model: fixture.kind, title: fixture.label, prompt: "Synthetic local fixture", images: 1, durationSeconds: 12,
          minArtifacts: 1, expect: [fixture.kind === "image" ? "png" : "mp4"], ...(fixture.kind === "video" ? { durationRange: [10, 15] } : {}) }] } };
    const f = cliFixture(t, profile);
    const argv = [join(f.repo, "scripts/acceptance/live.mjs"), "--no-auto-keys", "--no-keys-from-client", "--out", f.out, "--require-live", "--timeout-s", "10"];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, { cwd: f.repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.repo, NODE_PATH: process.env.NODE_PATH ?? "",
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        SYNTHETIC_API_KEY: "synthetic-local-original-artifact-key", SYNTHETIC_BASE_URL: `${base}/api/v3` } });
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("synthetic original replay CLI timeout")); }, 45_000);
      child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); }); child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, argv }); });
    });
    const report = JSON.parse(readFileSync(join(f.out, "live-report.json"), "utf8"));
    const task = report.tasks[0]; const dir = join(f.out, "artifacts");
    const retained = process.env.RDAS_GENERATION_EVIDENCE_DIR;
    if (retained) {
      const root = join(retained, `original-${fixture.label}`); mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "case.json"), JSON.stringify({ fixture, result, report, requests, artifactBodySha256: fixture.mode === "valid" ? hash(png) : fixture.mode === "empty" ? hash(Buffer.alloc(0)) : fixture.mode === "html" ? hash(Buffer.from("<html>synthetic gateway error</html>")) : hash(Buffer.from("synthetic missing artifact")),
        precondition: "Fresh committed closure, original exact media response, current mandatory provider metadata, no external targets", steps: ["Run actual live CLI", "Serve original media response", "Read native receipt, decoded artifact and budget", "Require every P item to remain unverified"],
        expected: fixture.shouldPass ? "Decoded valid task ok, synced receipt, synthetic CLI blocked/2" : "Invalid task failed, unsynced receipt, no landed artifact and nonzero/1", productionVerified: false }, null, 2), { flag: "wx" });
      cpSync(f.out, join(root, "out"), { recursive: true });
    }
    assert.ok(requests.some((req) => req.method === "POST" && ["/api/v3/images/generations", "/api/v3/contents/generations/tasks"].includes(req.path)));
    assert.ok(requests.some((req) => req.path.startsWith("/fixture.")));
    assert.equal(requests.some((req) => /chat\/completions|auth\.loginAs|threads\.dispatch/u.test(req.path)), false);
    assert.equal(report.productionEvidence, false); assert.equal(report.evidenceType, "synthetic-transport"); assert.match(report.verdict, /^blocked/u);
    assert.equal(report.checks.length, 18); assert.equal(report.checks.every((check) => check.status === "unverified" && check.productionEvidence === false), true);
    assert.equal(report.secretScan.passed, true); assert.equal(task.called, true);
    assert.equal(result.status, fixture.shouldPass ? 2 : 1, result.stderr);
    assert.equal(task.status, fixture.shouldPass ? "ok" : "failed"); assert.equal(task.receipt.synced, fixture.shouldPass);
    assert.equal(task.measurementComplete, fixture.kind === "image");
    assert.equal(report.budget.used[fixture.kind === "image" ? "images" : "videoSeconds"], fixture.kind === "image" ? 1 : 12);
    assert.equal(report.budget.actual[fixture.kind === "image" ? "images" : "videoSeconds"], fixture.kind === "image" ? 1 : 0);
    assert.equal(report.budget.frozenBy.length, fixture.kind === "image" ? 0 : 1);
    assert.equal(existsSync(`${f.out}.run-lock`), false);
    if (fixture.shouldPass) {
      assert.equal(task.artifacts.length, 1); assert.equal(task.receipt.artifacts.length, 1);
      const artifact = task.artifacts[0]; assert.equal(readFileSync(artifact.path).length, 69); assert.equal(hash(readFileSync(artifact.path)), hash(png));
      const decoded = await inspectLocalArtifact({ path: artifact.path, artifactsDir: dir, kind: "image" });
      assert.equal(decoded.decoded, true); assert.equal(decoded.width, 1); assert.equal(decoded.height, 1); assert.equal(decoded.sha256, artifact.sha256);
    } else { assert.deepEqual(task.artifacts, []); assert.deepEqual(readdirSync(dir), []); }
  });
}
