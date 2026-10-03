"use strict";

// These tests run the complete production main.cjs, including its real relative
// CJS requires. Only Electron's native boundary and explicitly injected IO faults
// are controlled. Logs, directory metadata and successful exports are real files
// owned by this test; a native save dialog still needs independent device M6.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const MAX_SOURCE_BYTES = 4_000_000;
const MAX_TAIL_BYTES = 200_000;

const SOURCE = path.join(__dirname, "main.cjs");
const requireFromMain = createRequire(SOURCE);
const marker = (id) => `WL_SYNTHETIC_CREDENTIAL_${id}_ONLY`;
const useful = "Useful startup detail EADDRINUSE port 8787 / 客户 目录/launch.log";
// Match the scanner's own fixture convention: construct synthetic credentials
// at runtime, so source scanning never needs exemptions for these public tests.
const specialCredentialPrefix = "空 格;";
const postgresFixtureScheme = "postgres://";
const privateKeyStart = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

function fixture(t, { overrides = {}, platform = process.platform } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-中文 空格-"));
  const support = path.join(root, "support");
  const logs = path.join(support, "logs");
  fs.mkdirSync(logs, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { saves: [], errors: [], quits: 0, bootstraps: 0 };
  let saveResult = { canceled: true };
  let saveError = null;
  const fileSystem = new Proxy(fs, { get(target, key) { return overrides[key] ?? target[key]; } });
  const electron = {
    app: {
      getPath: (name) => name === "userData" ? support : root,
      getAppPath: () => path.resolve(__dirname, "../../.."),
      getName: () => "Synthetic WorkLoom", getVersion: () => "synthetic-diagnostic-version",
      setPath() {}, requestSingleInstanceLock: () => true, on() {},
      whenReady: () => ({ then: () => Promise.resolve() }),
      quit: () => { calls.quits += 1; }, commandLine: { appendSwitch() {} },
    },
    BrowserWindow: class { static getAllWindows() { return []; } },
    Tray: class {}, Menu: {}, Notification: {}, nativeImage: {}, shell: {},
    dialog: {
      async showSaveDialog(...args) {
        calls.saves.push(args);
        if (saveError) throw saveError;
        return typeof saveResult === "function" ? saveResult(calls.saves.length) : saveResult;
      },
      showErrorBox: (title, content) => { calls.errors.push({ title, content }); },
    },
  };
  const source = fs.readFileSync(SOURCE, "utf8");
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:fs") return fileSystem;
      return requireFromMain(name);
    },
    module: { exports: {} }, __dirname, __filename: SOURCE, Buffer,
    console: { log() {}, warn() {}, error() {} }, setTimeout, setInterval,
    process: { env: { WORKLOOM_PORT_OFFSET: "0" }, platform, arch: "arm64", argv: [], resourcesPath: root },
  });
  vm.runInContext(`${source}\n;globalThis.testBoundary = {
    diagnosticText, handleSplashAction,
    setError(error) { lastBootstrapError = error; },
    setReference(reference) { lastBootstrapReference = reference; },
    setSplash(window) { splash = window; },
  };`, context, { filename: SOURCE, timeout: 10_000 });
  context.testBoundary.setReference("启动-SYNTHETIC-SUPPORT-REFERENCE");
  return {
    root, support, logs, calls, api: context.testBoundary,
    log(name, content) { fs.writeFileSync(path.join(logs, name), content); },
    choose(result, error = null) { saveResult = result; saveError = error; },
  };
}

const cases = [
  ["json-quoted-llm-key", (s) => JSON.stringify({ LLM_API_KEY: s, ordinary: useful })],
  ["plain-env-key", (s) => `LLM_API_KEY=${s}\n${useful}`],
  ["app-db-password", (s) => `APP_DB_PASSWORD=${s}\n${useful}`],
  ["gateway-db-password", (s) => `GATEWAY_DB_PASSWORD=${s}\n${useful}`],
  ["prefixed-pg-password", (s) => `WORKLOOM_PG_ADMIN_PASSWORD=${s}\n${useful}`],
  ["jwt-and-pii-salt", (s) => `JWT_SECRET=${s}\nPII_SALT=${s}\n${useful}`],
  ["service-signing-secret", (s) => JSON.stringify({ SERVICE_C_SECRET: s, ordinary: useful })],
  ["camel-case-key", (s) => JSON.stringify({ config: { llmApiKey: s, refreshToken: s }, ordinary: useful })],
  ["escaped-json-key", (s) => `{"LLM_\\u0041PI_KEY":"${s}","ordinary":${JSON.stringify(useful)}}`],
  ["single-quoted-key-value", (s) => `{'api-key': '${s}', 'ordinary': '${useful}'}`],
  ["backtick-env-value", (s) => `APP_DB_PASSWORD=\`${s}\`\n${useful}`],
  ["quoted-space-special-newline", (s) => JSON.stringify({ apiKey: `${specialCredentialPrefix}\\\"\n${s}\n结束`, ordinary: useful })],
  ["env-value-with-spaces-semicolon", (s) => `APP_DB_PASSWORD=空 格;${s};结尾\n${useful}`],
  ["env-line-continuation", (s) => `LLM_API_KEY=first\\\n${s}\n${useful}`],
  ["incomplete-json-value", (s) => `${useful}\n{"LLM_API_KEY":"incomplete\n${s}`],
  ["credentials-container", (s) => JSON.stringify({ credentials: { owner: s, app: s, gateway: s }, ordinary: useful })],
  ["passwords-array", (s) => JSON.stringify({ legacyOwnerPasswords: [s, s], ordinary: useful })],
  ["nested-exception-json-string", (s) => JSON.stringify({ error: { message: JSON.stringify({ apiKey: s, ordinary: useful }) } })],
  ["bare-bearer", (s) => `HTTP 401 Bearer ${s}\n${useful}`],
  ["authorization-bearer", (s) => `Authorization: Bearer ${s}\n${useful}`],
  ["authorization-basic", (s) => JSON.stringify({ Authorization: `Basic ${s}`, ordinary: useful })],
  ["proxy-authorization", (s) => `Proxy-Authorization: Basic ${s}\n${useful}`],
  ["cookie-header", (s) => `Cookie: session=${s}; preferred=zh\n${useful}`],
  ["postgresql-credential-url", (s) => `DATABASE_URL=postgresql://fixture:${s}@localhost:9999/fixture\n${useful}`],
  ["http-credential-url", (s) => `request failed https://fixture:${s}@example.invalid/path?attempt=2\n${useful}`],
  ["url-encoded-userinfo", (s) => JSON.stringify({ message: `${postgresFixtureScheme}fixture:${encodeURIComponent(`${s}@ 空/格`)}@localhost:9999/fixture`, ordinary: useful })],
  ["json-escaped-url-slashes", (s) => `{"message":"postgresql:\\/\\/fixture:${s}@localhost:9999/fixture","ordinary":${JSON.stringify(useful)}}`],
  ["fully-uri-encoded-url", (s) => `${encodeURIComponent(`postgresql://fixture:${s}@localhost:9999/fixture`)}\n${useful}`],
  ["double-uri-encoded-url", (s) => `${encodeURIComponent(encodeURIComponent(`postgresql://fixture:${s}@localhost:9999/fixture`))}\n${useful}`],
  ["malformed-url-percent", (s) => `postgresql%3A%2F%2Ffixture%3A${s}%ZZ%40localhost%3A9999%2Ffixture\n${useful}`],
  ["url-query-token", (s) => `request https://example.invalid/health?access_token=${s}&attempt=2\n${useful}`],
  ["encoded-key-query-token", (s) => `request https://example.invalid/health?api%5Fkey=${s}&attempt=2\n${useful}`],
  ["private-key-block", (s) => `${useful}\n${privateKeyStart}\n${s}\n-----END PRIVATE KEY-----`],
];

for (const [id, makeText] of cases) {
  test(`diagnostic ${id}: credential absent and ordinary error retained`, (t) => {
    const f = fixture(t);
    const secret = marker(id);
    f.log("synthetic.log", makeText(secret));
    const exported = f.api.diagnosticText();
    assert.equal(exported.includes(secret), false, "Synthetic credential must be absent from the real export result");
    assert.equal(exported.includes(useful), true, "Non-secret startup details must survive");
    assert.equal(exported.includes("synthetic.log"), true, "Support must retain the source filename");
    assert.equal(exported.includes("日志读取失败"), false, "Fixture must be read through real filesystem IO");
  });
}

test("diagnostic last-error, reference and filename fields also redact credentials", (t) => {
  const f = fixture(t);
  const secret = marker("fields");
  f.api.setError(`APP_DB_PASSWORD=${secret}\n${useful}`);
  f.api.setReference(`Authorization: Bearer ${secret}`);
  f.log(`API_KEY=${secret}.log`, useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes(useful), true);
  assert.equal(exported.includes("最近错误"), true);
});

test("diagnostic credentials whose field prefix precedes the old tail boundary remain absent", (t) => {
  const f = fixture(t);
  const secret = marker("tail");
  f.log("long.log", `{"APP_DB_PASSWORD":"${"X".repeat(220_000)}${secret}","ordinary":${JSON.stringify(useful)}}`);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes(useful), true);
});

const largeCases = [
  ["maximum-size-no-newline", (s) => `${"X".repeat(MAX_SOURCE_BYTES - Buffer.byteLength(s))}${s}`, false],
  ["maximum-size-plain-secret-no-newline", (s) => `APP_DB_PASSWORD=${"X".repeat(MAX_SOURCE_BYTES - 16 - Buffer.byteLength(s))}${s}`, true],
  ["unterminated-escaped-quote-run", (s) => `{"message":"${'\\"'.repeat(1_900_000)} APP_DB_PASSWORD=${s}`, true],
  ["unterminated-escaped-backslash-run", (s) => `{"APP_DB_PASSWORD":"${"\\\\".repeat(1_900_000)}${s}`, true],
  ["long-valid-percent-run", (s) => `LLM_API_KEY%3D${"%41".repeat(1_300_000)}${s}`, true],
  ["long-malformed-percent-run", (s) => `APP_DB_PASSWORD=${"%ZZ".repeat(1_300_000)}${s}`, true],
];

for (const [id, makeText, credential] of largeCases) {
  test(`diagnostic ${id}: bounded real source and useful tail or adjacent detail`, { timeout: 10_000 }, (t) => {
    const f = fixture(t);
    const secret = marker(id);
    const suffix = credential ? secret : useful;
    const content = makeText(suffix);
    assert.ok(Buffer.byteLength(content) <= MAX_SOURCE_BYTES, "Boundary fixture must be read rather than skipped as oversized");
    if (id.startsWith("maximum-size")) assert.equal(Buffer.byteLength(content), MAX_SOURCE_BYTES);
    f.log("boundary.log", content);
    f.log("healthy.log", useful);
    const exported = f.api.diagnosticText();
    if (credential) assert.equal(exported.includes(secret), false);
    assert.equal(exported.includes(useful), true);
    assert.equal(exported.includes("日志读取失败"), false);
    assert.ok(Buffer.byteLength(exported) < MAX_TAIL_BYTES + 4_096, "Export size stays bounded after redaction");
    assert.equal(exported.includes("\u0000"), false);
  });
}

test("diagnostic UTF-8 tail starts at a complete character and retains recent useful error", (t) => {
  const f = fixture(t);
  f.log("unicode.log", `${"中".repeat(100_000)}\n${useful}`);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(useful), true);
  assert.equal(exported.includes("\ufffd"), false);
  assert.match(exported, /已省略较早诊断内容/u);
  assert.ok(Buffer.byteLength(exported) < MAX_TAIL_BYTES + 4_096);
});

test("diagnostic oversized logs fail safely with a per-file reason while other useful logs survive", (t) => {
  const f = fixture(t);
  const file = path.join(f.logs, "large.log");
  const secret = marker("oversized");
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, "APP_DB_PASSWORD=", 0);
    fs.writeSync(fd, secret, 4_000_001);
  } finally { fs.closeSync(fd); }
  f.log("normal.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /large\.log[\s\S]*超出安全读取上限/u);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic plain error, Windows paths, filenames and support reference remain useful", (t) => {
  const f = fixture(t, { platform: "win32" });
  const ordinary = 'EACCES C:\\Program Files\\WorkLoom\\logs\\launch-123456789.log version=1.2.3 tokenCount=42';
  f.api.setError(ordinary);
  f.log("normal.json", JSON.stringify({ ordinary, passwordRequired: true, apiKeyConfigured: false }));
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(ordinary), true);
  assert.equal(exported.includes("启动-SYNTHETIC-SUPPORT-REFERENCE"), true);
  assert.equal(exported.includes("synthetic-diagnostic-version"), true);
  assert.equal(exported.includes("win32 arm64"), true);
  assert.equal(exported.includes('"passwordRequired":true'), true);
  assert.equal(exported.includes('"apiKeyConfigured":false'), true);
});

test("diagnostic empty and missing log directory provide a bounded usable report", (t) => {
  const f = fixture(t);
  f.log("empty.log", "");
  assert.match(f.api.diagnosticText(), /empty\.log/u);
  fs.rmSync(f.logs, { recursive: true });
  const exported = f.api.diagnosticText();
  assert.match(exported, /日志读取失败/u);
  assert.match(exported, /支持参考：启动-SYNTHETIC-SUPPORT-REFERENCE/u);
});

test("diagnostic damaged UTF-8 and malformed JSON do not expose labeled credentials", (t) => {
  const f = fixture(t);
  const secret = marker("damaged");
  f.log("damaged.log", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`\nAPI_KEY=${secret}\n${useful}`)]));
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic partial read loops preserve complete useful content", (t) => {
  const f = fixture(t, { overrides: {
    readSync(fd, buffer, offset, length, position) {
      return fs.readSync(fd, buffer, offset, Math.min(length, 7), position);
    },
  } });
  f.log("partial.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(useful), true);
  assert.equal(exported.includes("\u0000"), false);
});

test("diagnostic read failure closes its descriptor, masks error fields and continues to the next log", (t) => {
  const opened = new Set();
  const secret = marker("read-error");
  let closed = 0;
  const f = fixture(t, { overrides: {
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); opened.add(fd); return fd; },
    readSync(fd, buffer, offset, length, position) {
      if (fs.fstatSync(fd).size === 8) throw new Error(`EIO APP_DB_PASSWORD=${secret}`);
      return fs.readSync(fd, buffer, offset, length, position);
    },
    closeSync(fd) { fs.closeSync(fd); opened.delete(fd); closed += 1; },
  } });
  t.after(() => { for (const fd of opened) fs.closeSync(fd); });
  f.log("a-broken.log", "bad-read");
  f.log("z-healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes(useful), true);
  assert.match(exported, /EIO/u);
  assert.equal(opened.size, 0);
  assert.equal(closed, 2);
});

test("diagnostic a log modified during a read is withheld with a retry reason", (t) => {
  let changed = false;
  const f = fixture(t, { overrides: {
    readSync(fd, buffer, offset, length, position) {
      if (!changed) {
        changed = true;
        fs.appendFileSync(path.join(f.logs, "a-changing.log"), "append during read");
      }
      return fs.readSync(fd, buffer, offset, length, position);
    },
  } });
  const secret = marker("changing");
  f.log("a-changing.log", `APP_DB_PASSWORD=${secret}`);
  f.log("z-healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /a-changing\.log[\s\S]*读取过程中发生变化[\s\S]*重新导出/u);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic unexpected EOF closes its descriptor and preserves other logs", (t) => {
  let closed = 0;
  const f = fixture(t, { overrides: {
    readSync(fd, buffer, offset, length, position) {
      if (fs.fstatSync(fd).size === 7) return 0;
      return fs.readSync(fd, buffer, offset, length, position);
    },
    closeSync(fd) { closed += 1; return fs.closeSync(fd); },
  } });
  f.log("a-eof.log", "eof-log");
  f.log("z-healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.match(exported, /a-eof\.log[\s\S]*提前结束/u);
  assert.equal(exported.includes(useful), true);
  assert.equal(closed, 2);
});

test("diagnostic log symlinks are skipped without reading their external target", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "private-source.txt");
  const secret = marker("symlink");
  fs.writeFileSync(outside, secret);
  fs.symlinkSync(outside, path.join(f.logs, "outside.json"));
  f.log("healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /outside\.json[\s\S]*符号链接/u);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic hard-linked logs are skipped without reading their private target", (t) => {
  const f = fixture(t);
  const secret = marker("hardlink");
  const outside = path.join(f.root, "private-source.txt");
  fs.writeFileSync(outside, secret);
  fs.linkSync(outside, path.join(f.logs, "hardlinked.json"));
  f.log("healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /hardlinked\.json[\s\S]*硬链接/u);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic symlinked log directory is rejected before any target contents are read", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "external-logs");
  const secret = marker("symlink-dir");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "outside.log"), secret);
  fs.rmSync(f.logs, { recursive: true });
  fs.symlinkSync(outside, f.logs, process.platform === "win32" ? "junction" : "dir");
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /日志读取失败/u);
});

test("diagnostic unknown extensions, directories and sensitive state filenames are not exported", (t) => {
  const f = fixture(t);
  const secret = marker("non-log");
  f.log("private-source.txt", secret);
  f.log("database-state.json", secret);
  f.log(".env.json", secret);
  fs.mkdirSync(path.join(f.logs, "directory.log"));
  f.log("healthy.log", useful);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes(useful), true);
});

test("diagnostic file selection remains sorted and limited to twelve log files", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 14; n += 1) f.log(`${String(n).padStart(2, "0")}.log`, `ordinary line ${n}`);
  const exported = f.api.diagnosticText();
  assert.equal(exported.includes("===== 00.log"), false);
  assert.equal(exported.includes("===== 01.log"), false);
  assert.equal((exported.match(/===== \d\d\.log/gu) ?? []).length, 12);
});

test("diagnostic export cancellation does not read logs or create an output file", async (t) => {
  let reads = 0;
  const f = fixture(t, { overrides: { readdirSync(...args) { reads += 1; return fs.readdirSync(...args); } } });
  const output = path.join(f.root, "canceled.txt");
  f.choose({ canceled: true, filePath: output });
  await f.api.handleSplashAction("export");
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(output), false);
  assert.equal(f.calls.saves.length, 1);
});

test("diagnostic successful export writes real private file with only sanitized useful content", async (t) => {
  const f = fixture(t);
  const secret = marker("saved");
  f.log("saved.json", JSON.stringify({ LLM_API_KEY: secret, APP_DB_PASSWORD: secret, ordinary: useful }));
  const output = path.join(f.root, "export.txt");
  f.choose({ canceled: false, filePath: output });
  await f.api.handleSplashAction("export");
  const saved = fs.readFileSync(output, "utf8");
  assert.equal(saved.includes(secret), false);
  assert.equal(saved.includes(useful), true);
  assert.equal(f.calls.errors.length, 0);
  if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("diagnostic save rejection reports a sanitized actionable error without rejecting the splash action", async (t) => {
  const f = fixture(t);
  const secret = marker("dialog-error");
  f.choose(null, new Error(`EACCES APP_DB_PASSWORD=${secret}`));
  let rejected = false;
  try { await f.api.handleSplashAction("export"); } catch { rejected = true; }
  assert.equal(rejected, false);
  assert.equal(f.calls.errors.length, 1);
  assert.equal(f.calls.errors[0].content.includes(secret), false);
  assert.match(f.calls.errors[0].content, /EACCES/u);
  assert.match(f.calls.errors[0].content, /重试/u);
});

test("diagnostic write failure is visible and does not mark the startup error as recovered", async (t) => {
  const f = fixture(t);
  f.api.setError(useful);
  const output = path.join(f.root, "not-a-file");
  fs.mkdirSync(output);
  f.choose({ canceled: false, filePath: output });
  let rejected = false;
  try { await f.api.handleSplashAction("export"); } catch { rejected = true; }
  assert.equal(rejected, false);
  assert.equal(f.calls.errors.length, 1);
  assert.equal(fs.statSync(output).isDirectory(), true);
  assert.equal(f.api.diagnosticText().includes(useful), true);
  assert.equal(f.calls.quits, 0);
});

test("diagnostic concurrent exports remain sanitized and use the selected distinct files", async (t) => {
  const f = fixture(t);
  const secret = marker("concurrent");
  f.log("concurrent.json", JSON.stringify({ LLM_API_KEY: secret, ordinary: useful }));
  f.choose((n) => ({ canceled: false, filePath: path.join(f.root, `export-${n}.txt`) }));
  await Promise.all([f.api.handleSplashAction("export"), f.api.handleSplashAction("export")]);
  for (const n of [1, 2]) {
    const saved = fs.readFileSync(path.join(f.root, `export-${n}.txt`), "utf8");
    assert.equal(saved.includes(secret), false);
    assert.equal(saved.includes(useful), true);
  }
});

test("diagnostic helper remains inside the configured production ASAR file scope", (t) => {
  fixture(t);
  const builder = fs.readFileSync(path.resolve(__dirname, "../../../electron-builder.yml"), "utf8");
  assert.match(builder, /^\s*- apps\/desktop\/electron\/\*\*\/\*$/mu);
  assert.match(builder, /^\s*main: apps\/desktop\/electron\/main\.cjs$/mu);
  assert.match(builder, /^asar: true$/mu);
});
