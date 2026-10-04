/** MC-033: genuine loopback transport and actual local media decoding; no paid I/O. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget, normalizeBudgets } from "./budget.mjs";
import { fixture, report } from "./cli-fixtures.mjs";
import { runImageTask, runVideoTask } from "./providers.mjs";
import { inspectLocalArtifact, verifyArtifactReceipts } from "./media.mjs";
import { PNG_BYTES, MP4_BYTES } from "./test-fixtures.mjs";
import { MP4_8S_BYTES, MP4_16S_BYTES } from "./generation-test-fixtures.mjs";

const env = { SYNTHETIC_API_KEY: "synthetic-local-fixture-key" };
const imageModel = { id: "image", kind: "image", adapter: "gen-http", model: "synthetic-model", apiKeyEnv: "SYNTHETIC_API_KEY", baseUrlEnv: "SYNTHETIC_BASE_URL" };
const videoModel = { ...imageModel, id: "video", kind: "video" };
const imageTask = { id: "IMG-01", kind: "image", model: "image", images: 1, prompt: "synthetic", title: "synthetic image" };
const videoTask = { id: "VID-01", kind: "video", model: "video", durationSeconds: 12, prompt: "synthetic", title: "synthetic video" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function directory(t) { const dir = mkdtempSync(join(tmpdir(), "workloom-generation-artifact-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function evidence(label, actual, dir = null) {
  const root = process.env.RDAS_GENERATION_EVIDENCE_DIR;
  if (!root) return;
  const path = join(root, label); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "actual.json"), JSON.stringify(actual, null, 2), { flag: "wx" });
  if (dir) {
    const media = join(path, "landed"); mkdirSync(media);
    for (const name of readdirSync(dir)) if (!name.startsWith(".")) copyFileSync(join(dir, name), join(media, name));
  }
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function wire(t, { image = null, video = null, artifact = "valid", reportedDuration = 12 } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const bytes of req) body += bytes;
    let input = null;
    try { input = body ? JSON.parse(body) : null; } catch { return json(res, 400, { error: "synthetic malformed request" }); }
    calls.push({ method: req.method, url: req.url, input });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/images/generations") {
      const round = calls.filter((call) => call.url === req.url).length;
      const normal = { model: input.model, usage: { generated_images: 1 }, data: [{ url: `${base}/artifacts/image-${round}.png` }] };
      if (image) return image({ req, res, input, round, base, normal });
      return json(res, 200, normal);
    }
    if (req.url === "/contents/generations/tasks") return json(res, 200, { id: "synthetic-video-1" });
    if (req.url === "/contents/generations/tasks/synthetic-video-1") {
      const normal = { id: "synthetic-video-1", model: "synthetic-model", status: "succeeded", duration: reportedDuration, content: { video_url: `${base}/artifacts/video.mp4` } };
      return video ? video({ req, res, normal, base }) : json(res, 200, normal);
    }
    if (req.url.startsWith("/artifacts/")) {
      if (artifact === "404") return json(res, 404, { error: "synthetic missing media" });
      const isVideo = req.url.endsWith(".mp4");
      let bytes = isVideo ? MP4_BYTES : PNG_BYTES;
      if (artifact === "empty") bytes = Buffer.alloc(0);
      if (artifact === "html") bytes = Buffer.from("<html>synthetic access denied</html>");
      if (artifact === "truncated") bytes = bytes.subarray(0, 32);
      if (artifact === "wrong-kind") bytes = isVideo ? PNG_BYTES : MP4_BYTES;
      if (artifact === "bad-crc") bytes = Buffer.from(PNG_BYTES).fill(255, 20, 21);
      if (artifact === "short") bytes = MP4_8S_BYTES;
      if (artifact === "long") bytes = MP4_16S_BYTES;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }); return res.end(bytes);
    }
    return json(res, 200, { ok: true, synthetic: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}
const provider = (kind, s, dir, extra = {}) => ({ resolved: { ready: true, credentialEnv: "SYNTHETIC_API_KEY", model: "synthetic-model", baseUrl: s.url }, env,
  task: kind === "image" ? imageTask : videoTask, artifactsDir: dir, pollMs: 0, timeoutMs: 30_000, ...extra });

for (const kind of ["image", "video"]) for (const mode of ["404", "empty", "html", "truncated", "wrong-kind"]) {
  test(`MC033 artifact ${kind}/${mode}: real invalid bytes fail, no landed media or synced receipt`, async (t) => {
    const s = await wire(t, { artifact: mode }); const dir = directory(t);
    const actual = await (kind === "image" ? runImageTask : runVideoTask)(provider(kind, s, dir));
    evidence(`${kind}-${mode}`, { actual, calls: s.calls }, dir);
    assert.equal(actual.status, "failed"); assert.equal(actual.called, true); assert.equal(actual.receipt.synced, false);
    assert.equal(actual.artifacts.length, 0); assert.deepEqual(readdirSync(dir), []);
    assert.equal(actual.measurementComplete, kind === "image");
    assert.equal(kind === "image" ? actual.produced : actual.durationSeconds, kind === "image" ? 1 : null);
    assert.ok(s.calls.some((call) => call.url.startsWith("/artifacts/")));
  });
}

test("MC033 image: a corrupt PNG CRC cannot be accepted by a permissive display decoder", async (t) => {
  const s = await wire(t, { artifact: "bad-crc" }); const dir = directory(t);
  const actual = await runImageTask(provider("image", s, dir)); evidence("image-crc", { actual, calls: s.calls }, dir);
  assert.equal(actual.status, "failed"); assert.match(actual.reason, /校验和/); assert.deepEqual(readdirSync(dir), []);
});

for (const [mode, delivered, produced, measured] of [["http", 1, 1, false], ["missing-usage", 2, 2, false], ["zero", 1, 1, true]]) {
  test(`MC033 partial image/${mode}: later failure retains earlier decoded media, exact known lower bound and stops the third call`, async (t) => {
    const s = await wire(t, { image: ({ res, round, normal }) => round === 1 ? json(res, 200, normal)
      : mode === "http" ? json(res, 500, { error: "synthetic second call failed" })
      : mode === "zero" ? json(res, 200, { model: "synthetic-model", usage: { generated_images: 0 }, data: [{ error: { message: "synthetic second image rejected" } }] })
      : json(res, 200, { ...normal, usage: undefined }) });
    const dir = directory(t); const actual = await runImageTask(provider("image", s, dir, { task: { ...imageTask, images: 3 } }));
    evidence(`image-partial-${mode}`, { actual, calls: s.calls }, dir);
    assert.notEqual(actual.status, "ok"); assert.equal(actual.receipt.synced, false); assert.equal(actual.calls, 2);
    assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, 2);
    assert.equal(actual.measurementComplete, measured); assert.equal(actual.produced, measured ? produced : null); assert.equal(actual.knownProduced, produced);
    assert.equal(actual.artifacts.length, delivered); assert.equal(actual.receipt.artifacts.length, delivered); assert.equal(actual.receipt.delivered, delivered);
    assert.equal(actual.receipt.generationUsage.length, 2); assert.equal(actual.receipt.generationUsage[0].generatedImages, 1);
    assert.equal((await verifyArtifactReceipts({ artifacts: actual.artifacts, receipt: actual.receipt, artifactsDir: dir, kind: "image" })).ok, true);
    for (const artifact of actual.artifacts) assert.equal(hash(readFileSync(artifact.path)), artifact.sha256);
  });
}

test("MC033 image: complete multi-round generation preserves unique decoded files and real quantity", async (t) => {
  const s = await wire(t); const dir = directory(t); const actual = await runImageTask(provider("image", s, dir, { task: { ...imageTask, images: 3 } }));
  evidence("image-multi-valid", { actual, calls: s.calls }, dir);
  assert.equal(actual.status, "ok"); assert.equal(actual.calls, 3); assert.equal(actual.produced, 3); assert.equal(actual.measurementComplete, true);
  assert.equal(actual.artifacts.length, 3); assert.equal(new Set(actual.artifacts.map((a) => a.path)).size, 3); assert.equal(actual.receipt.synced, true);
});

for (const [mode, seconds] of [["short", 8], ["long", 16]]) {
  test(`MC033 video/${mode}: decoded ${seconds}s cannot borrow requested or remotely reported 12s`, async (t) => {
    const s = await wire(t, { artifact: mode }); const dir = directory(t); const actual = await runVideoTask(provider("video", s, dir));
    evidence(`video-duration-${mode}`, { actual, calls: s.calls }, dir);
    assert.equal(actual.status, "failed"); assert.equal(actual.measurementComplete, true); assert.equal(actual.receipt.synced, false);
    assert.equal(actual.artifacts.length, 1); assert.ok(Math.abs(actual.durationSeconds - seconds) < 0.05);
    assert.equal(actual.receipt.reportedDurationSeconds, 12); assert.equal(actual.receipt.measurementSource, "decoded-local-file");
    assert.ok(actual.artifacts[0].decodedFrames > 0);
  });
}

test("MC033 video: actual readable media remains measurable when the API duration field is missing", async (t) => {
  const s = await wire(t, { video: ({ res, normal }) => { delete normal.duration; return json(res, 200, normal); } }); const dir = directory(t); const actual = await runVideoTask(provider("video", s, dir));
  evidence("video-valid-no-remote-duration", { actual, calls: s.calls }, dir);
  assert.equal(actual.status, "ok"); assert.equal(actual.measurementComplete, true); assert.equal(actual.receipt.synced, true);
  assert.equal(actual.receipt.reportedDurationSeconds, null);
  const read = await inspectLocalArtifact({ path: actual.artifacts[0].path, artifactsDir: dir, kind: "video" });
  assert.equal(actual.durationSeconds, read.durationSeconds); assert.equal(actual.receipt.durationSeconds, read.durationSeconds);
});

test("MC033 provider quantities and opaque metering overrides are rejected before real HTTP admission", async (t) => {
  const s = await wire(t); const dir = directory(t);
  for (const images of [-1, 0, 1.5, 9, Infinity, "2"]) assert.equal((await runImageTask(provider("image", s, dir, { task: { ...imageTask, images } }))).called, false);
  for (const durationSeconds of [-1, 0, 9, 16, 10.5, "12"]) assert.equal((await runVideoTask(provider("video", s, dir, { task: { ...videoTask, durationSeconds } }))).called, false);
  for (const params of [null, [], "bad", { n: 100 }, { model: "other" }, { sequential_image_generation: "auto" }, { sequential_image_generation_options: { max_images: 100 } }]) {
    assert.equal((await runImageTask(provider("image", s, dir, { task: { ...imageTask, params } }))).called, false);
  }
  for (const params of [null, [], "bad", { duration: 32 }, { model: "other" }]) assert.equal((await runVideoTask(provider("video", s, dir, { task: { ...videoTask, params } }))).called, false);
  assert.equal(s.calls.length, 0); assert.deepEqual(readdirSync(dir), []);
});

function child(f, extraEnv = {}, flags = []) {
  return new Promise((resolve, reject) => {
    const argv = [join(f.repo, "scripts/acceptance/live.mjs"), "--out", f.out, "--no-auto-keys", "--no-keys-from-client", "--require-live", ...flags];
    const proc = spawn(process.execPath, argv, { cwd: f.repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), NODE_PATH: process.env.NODE_PATH ?? "", ...extraEnv } });
    let stdout = ""; let stderr = ""; const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("synthetic generation CLI timeout")); }, 120_000);
    proc.stdout.on("data", (data) => { stdout += data; }); proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => { clearTimeout(timer); reject(error); }); proc.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, argv }); });
  });
}
const profile = (url, tasks) => ({ environment: { kind: "local-preview", target: { apiUrl: url, pcUrl: url, bMobileUrl: url, cMobileUrl: url }, timeouts: { healthMs: 500 } }, live: { enabled: true, models: [imageModel, videoModel], tasks } });
for (const kind of ["image", "video"]) for (const mode of ["404", "empty", "html"]) {
  test(`MC033 actual CLI/${kind}-${mode}: require-live is nonzero, failure stays visible and exact measurement is not fabricated`, async (t) => {
    const s = await wire(t, { artifact: mode }); const f = fixture(t, profile(s.url, [kind === "image" ? imageTask : videoTask]));
    const run = await child(f, { ...env, SYNTHETIC_BASE_URL: s.url }); const actual = report(f);
    evidence(`cli-${kind}-${mode}`, { run, actual, calls: s.calls }, join(f.out, "artifacts"));
    assert.equal(run.status, 1, run.stderr); assert.equal(actual.tasks[0].status, "failed"); assert.notEqual(actual.verdict, "pass");
    assert.equal(actual.tasks[0].receipt.synced, false); assert.deepEqual(actual.tasks[0].artifacts, []); assert.equal(actual.secretScan.passed, true);
    assert.equal(actual.budget.used[kind === "image" ? "images" : "videoSeconds"], kind === "image" ? 1 : 12);
    assert.equal(actual.budget.measurementComplete, kind === "image"); assert.equal(actual.budget.frozenBy.length, kind === "image" ? 0 : 1);
    assert.equal(actual.checks.filter((check) => check.status === "pass").length, 0);
    const index = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance/evidence-index.json"))); assert.equal(index.runs.length, 1);
    assert.equal(existsSync(`${f.out}.run-lock`), false);
  });
}

test("MC033 actual CLI partial image: preserve valid first artifact and known usage, freeze every later paid modality", async (t) => {
  const s = await wire(t, { image: ({ res, round, normal }) => round === 1 ? json(res, 200, normal) : json(res, 500, { error: "synthetic second round fault" }) });
  const f = fixture(t, profile(s.url, [{ ...imageTask, images: 3 }, { ...imageTask, id: "IMG-NEXT" }, { ...videoTask, id: "VID-NEXT" }]));
  const run = await child(f, { ...env, SYNTHETIC_BASE_URL: s.url }); const actual = report(f);
  evidence("cli-partial-image", { run, actual, calls: s.calls }, join(f.out, "artifacts"));
  assert.equal(run.status, 2, run.stderr); assert.equal(actual.tasks[0].status, "blocked"); assert.equal(actual.tasks[0].knownProduced, 1);
  assert.equal(actual.tasks[0].artifacts.length, 1); assert.equal(actual.tasks[0].receipt.artifacts.length, 1);
  assert.equal(actual.budget.used.images, 3); assert.equal(actual.budget.unmeasured.images, 3); assert.equal(actual.budget.actual.images, 0);
  assert.equal(actual.budget.frozenBy.length, 1); assert.equal(actual.budget.measurementComplete, false);
  assert.equal(actual.tasks.slice(1).every((task) => task.status === "blocked" && task.called === false), true);
  assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, 2);
  assert.equal(s.calls.filter((call) => call.method === "POST" && call.url === "/contents/generations/tasks").length, 0);
  const artifact = actual.tasks[0].artifacts[0]; assert.equal(hash(readFileSync(artifact.path)), artifact.sha256);
});

test("MC033 duplicate reservation acknowledgement cannot dispatch or settle a second physical provider call", async (t) => {
  const s = await wire(t); const dir = directory(t); const b = createBudget({ outDir: join(directory(t), "budget"), budgets: normalizeBudgets({ maxImages: 1 }).budgets });
  const input = { taskId: imageTask.id, kind: "image", units: 1 };
  const admitted = b.reserve(input); assert.equal(admitted.allowed, true); assert.equal(admitted.duplicate, false);
  const actual = await runImageTask(provider("image", s, dir)); b.commit({ ...input, measured: actual.measurementComplete, status: actual.status });
  const retried = b.reserve(input); assert.equal(retried.allowed, true); assert.equal(retried.duplicate, true);
  if (retried.allowed && !retried.duplicate) await runImageTask(provider("image", s, dir));
  assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, 1);
  assert.equal(b.summary().reservations.length, 1); assert.equal(b.summary().used.images, 1);
  assert.equal(b.commit({ ...input, measured: true, status: "ok" }).duplicate, true);
});
