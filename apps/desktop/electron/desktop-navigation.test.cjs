"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const mainFile = path.join(__dirname, "main.cjs");
const source = fs.readFileSync(mainFile, "utf8");
const nativeRequire = createRequire(mainFile);

function capture(t, { rejectExternal = false } = {}) {
  const external = [];
  const warnings = [];
  const errors = [];
  const quits = [];
  const appEvents = new Map();
  const windows = [];
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-window-fixture-"));
  t.after(() => fs.rmSync(support, { recursive: true, force: true }));
  class WindowFixture {
    constructor() { windows.push(this); }
    webContents = {
      events: new Map(),
      setWindowOpenHandler(value) { this.openHandler = value; },
      on(name, value) { this.events.set(name, value); },
      setZoomFactor() {}, setVisualZoomLevelLimits() { return Promise.resolve(); },
    };
    on() {} once() {} setResizable() {} loadURL() { return Promise.resolve(); }
    isDestroyed() { return Boolean(this.destroyed); } destroy() { this.destroyed = true; }
  }
  const app = { requestSingleInstanceLock: () => false, quit() { quits.push("quit"); }, on(name, fn) { appEvents.set(name, fn); }, exit(code) { errors.push(`app-exit-${code}`); },
    getName: () => "Public navigation fixture", getAppPath: () => __dirname,
    getPath: () => support, getVersion: () => "fixture-version",
    whenReady: () => new Promise(() => {}) };
  const electron = { app, BrowserWindow: WindowFixture,
    shell: { openExternal(url) { external.push(url); return rejectExternal ? Promise.reject(new Error("password=synthetic-navigation-private")) : Promise.resolve(); } },
    nativeImage: { createFromPath: () => null }, Notification: { isSupported: () => false } };
  const context = vm.createContext({ require(name) {
    if (name === "electron") return electron;
    if (name === "./bootstrap.cjs") return { bootstrap: () => { throw new Error("Window test cannot bootstrap"); } };
    return nativeRequire(name);
  }, process: { env: { WORKLOOM_WEB_PORT: "59383" }, argv: [] },
  __dirname, __filename: mainFile, console: { log() {}, error(message) { errors.push(message); }, warn(message) { warnings.push(message); } },
  URL, Buffer, setTimeout, clearTimeout, module: { exports: {} }, exports: {} });
  vm.runInContext(`${source}\nmodule.exports.fixture={ createWindow, showSplash, diagnosticText, handleSplashAction, setHandle(value){handle=value;}, getHandle(){return handle;}, isBusy(){return bootstrapRunning;} };`, context, { filename: mainFile });
  context.module.exports.fixture.createWindow();
  return { external, warnings, errors, quits, appEvents, windows, support, api: context.module.exports.fixture,
    contents: windows[0].webContents };
}

for (const url of [
  "http://127.0.0.1.example.test:59383/", "http://localhost.example.test:59383/",
  "http://127.0.0.1@foreign.example.test:59383/", "http://fixture:secret@127.0.0.1:59383/",
  "http://127.0.0.1:59384/", "http://localhost:59383/", "https://127.1:59384/",
  "https://localhost:59384/", "https://[::1]:59384/", "https://[::ffff:127.0.0.1]:59384/",
  "https://fixture:secret@public.example.test/", "file:///tmp/fixture.app", "javascript:fixture()",
  "data:text/html,fixture", "ms-settings:fixture", "this is not a URL", "https://public.example.test/\nfixture",
]) test(`actual window handler rejects unsafe or non-workbench URL: ${url}`, (t) => {
  const item = capture(t);
  assert.equal(item.contents.openHandler({ url }).action, "deny");
  assert.deepEqual(item.external, []);
});

test("current configured origin preserves a constrained local window and public HTTPS reaches shell", (t) => {
  const item = capture(t);
  const allowed = item.contents.openHandler({ url: "http://127.0.0.1:59383/workbench?tab=fixture" });
  assert.equal(allowed.action, "allow");
  assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(item.contents.openHandler({ url: "https://public.example.test/help" }).action, "deny");
  assert.deepEqual(item.external, ["https://public.example.test/help"]);
});
test("actual navigation, redirect and child-window handlers retain the same exact origin boundary", (t) => {
  const item = capture(t);
  for (const eventName of ["will-navigate", "will-redirect"]) {
    let prevented = 0;
    const event = { preventDefault() { prevented += 1; } };
    item.contents.events.get(eventName)(event, "http://127.0.0.1:59383/inside");
    assert.equal(prevented, 0);
    item.contents.events.get(eventName)(event, "http://127.0.0.1:59384/foreign");
    assert.equal(prevented, 1);
  }
  const child = { webContents: { events: new Map(), setWindowOpenHandler(fn) { this.openHandler = fn; }, on(name, fn) { this.events.set(name, fn); } } };
  item.contents.events.get("did-create-window")(child);
  assert.equal(child.webContents.openHandler({ url: "file:///tmp/fixture" }).action, "deny");
  assert.equal(typeof child.webContents.events.get("will-navigate"), "function");
  assert.deepEqual(item.external, []);
});
test("rejected shell Promise is handled without reflecting its error or causing unhandled rejection", async (t) => {
  const item = capture(t, { rejectExternal: true });
  let unhandled = false;
  const listener = () => { unhandled = true; };
  process.on("unhandledRejection", listener);
  try {
    item.contents.openHandler({ url: "https://public.example.test/help" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, false);
    assert.deepEqual(item.warnings, ["系统浏览器未能打开外部链接"]);
    assert.equal(JSON.stringify(item.warnings).includes("synthetic-navigation-private"), false);
  } finally { process.off("unhandledRejection", listener); }
});
test("splash rejects unrelated navigation and all new windows", (t) => {
  const item = capture(t);
  item.api.showSplash("fixture-startup");
  const splash = item.windows[1].webContents;
  let prevented = false;
  splash.events.get("will-navigate")({ preventDefault() { prevented = true; } }, "file:///tmp/fixture");
  assert.equal(prevented, true);
  assert.equal(splash.openHandler({ url: "https://public.example.test/" }).action, "deny");
  assert.deepEqual(item.external, []);
});
test("diagnostic export reads only ordinary local logs and redacts full and truncated sensitive content", (t) => {
  const item = capture(t);
  const logDir = path.join(item.support, "logs");
  fs.mkdirSync(logDir);
  const dbCanary = "synthetic-db-private";
  const pem = (edge) => [`-----${edge} `, "PRIVATE", " KEY-----"].join("");
  fs.writeFileSync(path.join(logDir, "fixture.log"), ["postgres://fixture:", dbCanary, "@localhost/db\nSERVICE_C_SECRET=synthetic-service-private\n"].join(""));
  fs.writeFileSync(path.join(logDir, "long.log"), `${pem("BEGIN")}\n${"synthetic-pem-private\n".repeat(14000)}${pem("END")}\nfixture-safe-tail\n`);
  const outside = path.join(item.support, "outside.txt");
  fs.writeFileSync(outside, "unlabelled-outside-private");
  fs.symlinkSync(outside, path.join(logDir, "symlink.log"));
  const result = item.api.diagnosticText();
  for (const privateValue of ["synthetic-db-private", "synthetic-service-private", "synthetic-pem-private", "unlabelled-outside-private"]) assert.equal(result.includes(privateValue), false);
  assert.match(result, /fixture-safe-tail/u);
});
test("actual main-frame load failure waits for the current runtime to stop before allowing retry", async (t) => {
  const item = capture(t);
  let release;
  let stopCalls = 0;
  const stopping = new Promise((resolve) => { release = resolve; });
  item.api.setHandle({ stop: async () => { stopCalls += 1; await stopping; } });
  item.contents.events.get("did-fail-load")({}, -105, "fixture page unavailable", "http://127.0.0.1:59383", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1, "a failed page cannot leave the verified runtime running behind the splash");
  assert.equal(item.windows[0].destroyed, true);
  assert.equal(item.api.isBusy(), true, "retry must wait for service shutdown");
  assert.ok(item.api.getHandle(), "quitting during cleanup must still own the current stop handle");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.api.getHandle(), null);
  assert.equal(item.api.isBusy(), false);
});
test("runtime stop failure on app quit is handled and cannot report a successful exit", async (t) => {
  const item = capture(t);
  item.api.setHandle({ stop: async () => { throw new Error("opaque-quit-synthetic-private"); } });
  let prevented = false;
  item.appEvents.get("will-quit")({ preventDefault() { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(item.api.getHandle(), null);
  assert.equal(item.errors.at(-1), "app-exit-1");
  assert.equal(JSON.stringify(item.errors).includes("opaque-quit-synthetic-private"), false);
});
test("cancelled or non-main-frame loads retain the current runtime", (t) => {
  const item = capture(t);
  let calls = 0;
  const active = { stop: async () => { calls += 1; } };
  item.api.setHandle(active);
  const callback = item.contents.events.get("did-fail-load");
  callback({}, -3, "cancelled fixture load", "http://127.0.0.1:59383", true);
  callback({}, -105, "subframe fixture load", "http://127.0.0.1:59383", false);
  assert.equal(calls, 0);
  assert.equal(item.api.getHandle(), active);
  assert.equal(item.windows[0].destroyed, undefined);
});
test("page-load cleanup failure is handled without reflecting the stop error", async (t) => {
  const item = capture(t);
  item.api.setHandle({ stop: async () => { throw new Error("opaque-load-synthetic-private"); } });
  item.contents.events.get("did-fail-load")({}, -105, "fixture unavailable", "http://127.0.0.1:59383", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.api.getHandle(), null);
  assert.equal(item.api.isBusy(), false);
  assert.deepEqual(item.errors, ["页面失败后的后台服务停止检查未完成"]);
  assert.equal(JSON.stringify(item.errors).includes("opaque-load-synthetic-private"), false);
});
test("quitting during page-load cleanup waits for the current handle", async (t) => {
  const item = capture(t);
  let release;
  const stopping = new Promise((resolve) => { release = resolve; });
  item.api.setHandle({ stop: () => stopping });
  item.contents.events.get("did-fail-load")({}, -105, "fixture unavailable", "http://127.0.0.1:59383", true);
  let prevented = false;
  item.appEvents.get("will-quit")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(item.errors.some((value) => value.startsWith("app-exit-")), false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.errors.at(-1), "app-exit-0");
  assert.equal(item.api.getHandle(), null);
});
test("actual splash safe exit waits for its current stop handle before quitting", async (t) => {
  const item = capture(t);
  const quitCount = item.quits.length;
  let release;
  const stopping = new Promise((resolve) => { release = resolve; });
  const active = { stop: () => stopping };
  item.api.setHandle(active);
  const exit = item.api.handleSplashAction("exit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.quits.length, quitCount);
  assert.equal(item.api.getHandle(), active, "the current handle remains owned until stop completes");
  release();
  await exit;
  assert.equal(item.api.getHandle(), null);
  assert.equal(item.quits.length, quitCount + 1);
  assert.equal(item.errors.length, 0);
});
test("actual splash safe exit reports failed stop and cannot follow the successful quit path", async (t) => {
  const item = capture(t);
  const quitCount = item.quits.length;
  item.api.setHandle({ stop: async () => { throw new Error("opaque-splash-exit-synthetic-private"); } });
  await item.api.handleSplashAction("exit");
  assert.equal(item.quits.length, quitCount, "a rejected stop cannot be swallowed into normal quit");
  assert.equal(item.errors.at(-1), "app-exit-1");
  assert.equal(item.api.getHandle(), null);
  assert.equal(JSON.stringify(item.errors).includes("opaque-splash-exit-synthetic-private"), false);
});

function captureSmoke(t, { render = false, sourceMode = false, waitMs = "1000", identity = true, identityPatch = {}, release = "valid", renderFails = false, testHook = true, stopFails = false } = {}) {
  const input = new PassThrough();
  const timeline = [];
  const output = [];
  const runtimeIdentity = { schemaVersion: "workloom.client-runtime-identity/v1", instanceId: "dc603ee9-5985-4bdf-bf44-de898063f911", supportDir: os.tmpdir(),
    productId: "fixture-industry", productManifestSha256: "a".repeat(64), payloadVersion: "v-fixture", payloadIntegritySha256: "b".repeat(64), ports: { server: 18787, web: 15173 }, ...identityPatch };
  let exit;
  const done = new Promise((resolve) => { exit = resolve; });
  let releaseNow;
  const ready = new Promise((resolve) => { releaseNow = resolve; });
  const env = { WORKLOOM_APP_SMOKE: render ? "0" : "1", WORKLOOM_RENDER_SMOKE: render ? "1" : "0", WORKLOOM_APP_SMOKE_TEST: testHook ? "1" : "0", WORKLOOM_APP_SMOKE_WAIT_MS: waitMs };
  if (sourceMode) Object.assign(env, { WORKLOOM_SOURCE_MODE: "1", WORKLOOM_SOURCE_ROOT: path.resolve(__dirname, "../../.."), WORKLOOM_SOURCE_NODE: process.execPath });
  const window = { webContents: { setWindowOpenHandler() {}, on() {}, setVisualZoomLevelLimits: () => Promise.resolve() }, on() {}, once() {}, setResizable() {}, loadURL: () => Promise.resolve() };
  const app = { requestSingleInstanceLock: () => true, on() {}, quit() {}, getName: () => "Public smoke fixture", getAppPath: () => __dirname,
    getPath: () => os.tmpdir(), getVersion: () => "fixture", whenReady: () => Promise.resolve(), isPackaged: false,
    exit(code) { timeline.push(`exit-${code}`); exit(code); } };
  const electron = { app, BrowserWindow: function () { return window; }, nativeImage: { createFromPath: () => null }, Notification: { isSupported: () => false } };
  const context = vm.createContext({ require(name) {
    if (name === "electron") return electron;
    if (name === "./bootstrap.cjs") return { bootstrap: async () => { timeline.push("bootstrap-ready"); return { webUrl: "http://127.0.0.1:15173", ...(identity ? { runtimeIdentity } : {}), stop: async () => { timeline.push("stop"); if (stopFails) throw new Error("opaque-stop-synthetic-private"); } }; } };
    return nativeRequire(name);
  }, process: { env, argv: [], stdin: input }, __dirname, __filename: mainFile,
  console: { warn(message) { output.push(message); }, error(message) { output.push(message); }, log(message) {
    output.push(message);
    if (!String(message).startsWith("WORKLOOM_APP_SMOKE_READY ")) return;
    timeline.push("observer-ready");
    assert.ok(input.listenerCount("data") > 0, "release listener must be attached before publishing readiness");
    releaseNow(JSON.parse(message.slice("WORKLOOM_APP_SMOKE_READY ".length)));
    if (release === "valid") input.write(`${JSON.stringify({ schemaVersion: "workloom.app-smoke-release/v1", instanceId: runtimeIdentity.instanceId })}\n`);
    else if (release === "wrong") input.write(`${JSON.stringify({ schemaVersion: "workloom.app-smoke-release/v1", instanceId: "e18af465-276c-44d5-9592-20ca229f7e76" })}\n`);
    else if (release === "malformed") input.write("not-json-secret=synthetic-private\n");
    else if (release === "oversize") input.write(`${"x".repeat(5000)}\n`);
    else if (release === "extra") input.write(`${JSON.stringify({ schemaVersion: "workloom.app-smoke-release/v1", instanceId: runtimeIdentity.instanceId, privateField: "synthetic-private" })}\n`);
    else if (release === "multiple") input.write(`${JSON.stringify({ schemaVersion: "workloom.app-smoke-release/v1", instanceId: runtimeIdentity.instanceId })}\nnot-json-secret=synthetic-private\n`);
    else if (release === "fragment") { input.write('{"schemaVersion":"workloom.app-smoke-release/v1",'); input.write(`"instanceId":"${runtimeIdentity.instanceId}"}\r\n`); }
    else if (release === "eof") input.end();
  } }, URL, Buffer, setTimeout, clearTimeout, module: { exports: {} }, exports: {}, fixtureRender() {
    timeline.push("render-complete"); if (renderFails) throw new Error("fixture render failed");
  } });
  vm.runInContext(`${source}\nrunRenderSmoke=async()=>fixtureRender();`, context, { filename: mainFile });
  t.after(() => input.destroy());
  return { done, ready, output, timeline, runtimeIdentity };
}
test("explicit app smoke publishes actual known identity and waits for matching release before shutdown", async (t) => {
  const f = captureSmoke(t);
  assert.equal(await f.done, 0);
  const packet = f.output.find((line) => line.startsWith("WORKLOOM_APP_SMOKE_READY "));
  assert.ok(packet, "the active observer must receive readiness before the app exits");
  const data = JSON.parse(packet.slice("WORKLOOM_APP_SMOKE_READY ".length));
  assert.equal(data.schemaVersion, "workloom.app-smoke-ready/v1");
  assert.deepEqual(data.runtimeIdentity, f.runtimeIdentity);
  assert.deepEqual(f.timeline, ["bootstrap-ready", "observer-ready", "stop", "exit-0"]);
});
test("explicit renderer smoke completes render checks before publishing readiness", async (t) => {
  const f = captureSmoke(t, { render: true });
  assert.equal(await f.done, 0);
  assert.deepEqual(f.timeline, ["bootstrap-ready", "render-complete", "observer-ready", "stop", "exit-0"]);
});
for (const release of ["wrong", "malformed", "oversize", "extra", "multiple", "eof", "timeout"]) {
  test(`explicit smoke rejects ${release} release and still shuts down`, async (t) => {
    const f = captureSmoke(t, { release });
    assert.equal(await f.done, 1);
    assert.ok(f.timeline.indexOf("observer-ready") < f.timeline.indexOf("stop"));
    assert.equal(f.timeline.at(-1), "exit-1");
    assert.equal(JSON.stringify(f.output).includes("synthetic-private"), false);
  });
}
test("missing runtime identity, source mode, and invalid timeout cannot publish smoke readiness", async (t) => {
  for (const options of [{ identity: false }, { sourceMode: true }, { waitMs: "0" }, { waitMs: "60001" }, { waitMs: "1000.5" },
    { identityPatch: { instanceId: "not-an-instance" } }, { identityPatch: { productManifestSha256: "invalid" } }, { identityPatch: { ports: { server: 15173, web: 15173 } } }]) {
    const f = captureSmoke(t, options);
    assert.equal(await f.done, 1);
    assert.equal(f.output.some((line) => line.startsWith("WORKLOOM_APP_SMOKE_READY ")), false);
    assert.equal(f.timeline.at(-1), "exit-1");
  }
});
test("fragmented release is accepted and ordinary app smoke still exits without the observer hook", async (t) => {
  const fragmented = captureSmoke(t, { release: "fragment" });
  assert.equal(await fragmented.done, 0);
  assert.deepEqual(fragmented.timeline, ["bootstrap-ready", "observer-ready", "stop", "exit-0"]);
  const ordinary = captureSmoke(t, { testHook: false, release: "timeout" });
  assert.equal(await ordinary.done, 0);
  assert.deepEqual(ordinary.timeline, ["bootstrap-ready", "stop", "exit-0"]);
  assert.equal(ordinary.output.some((line) => line.startsWith("WORKLOOM_APP_SMOKE_READY ")), false);
});
test("app smoke stop rejection returns failure without reflecting the raw stop error", async (t) => {
  const f = captureSmoke(t, { stopFails: true });
  assert.equal(await f.done, 1);
  assert.equal(f.timeline.at(-1), "exit-1");
  assert.equal(JSON.stringify(f.output).includes("opaque-stop-synthetic-private"), false);
});
test("renderer failure never publishes readiness and cleans its current bootstrap handle", async (t) => {
  const f = captureSmoke(t, { render: true, renderFails: true });
  assert.equal(await f.done, 1);
  assert.deepEqual(f.timeline, ["bootstrap-ready", "render-complete", "stop", "exit-1"]);
});
