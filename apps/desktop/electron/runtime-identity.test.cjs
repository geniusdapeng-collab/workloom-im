"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { generatePayloadIntegrity, verifyPayloadIntegrity } = require("./payload-integrity.cjs");
const { httpOk, installPayloadAtomically, spawnLogged, readArchiveIdentity } = require("./bootstrap.cjs");

async function ports() {
  const handles = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      handles.push(server);
    }
    return Object.fromEntries(["server", "web", "pg", "nats"].map((name, index) => [name, handles[index].address().port]));
  } finally { await Promise.all(handles.map((server) => new Promise((resolve) => server.close(resolve)))); }
}
function put(root, file, content, mode = 0o644) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
}
function readState(support) {
  try { return JSON.parse(fs.readFileSync(path.join(support, "install-state.json"), "utf8")); } catch { return null; }
}
async function until(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture timed out: ${label}`);
}
function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = closed(child);
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { await done; } finally { clearTimeout(timer); }
}

function payloadFixture(t, { failMigration = false, webIgnoresTerm = false, backendGrandchild = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wl-id-")));
  const payload = path.join(root, "payload");
  const support = path.join(root, "support");
  const activeChildren = new Set();
  const grandchildState = path.join(root, "grandchild-state.json");
  const node = path.join(support, "node", "bin", "node");
  fs.mkdirSync(path.join(payload, "node", "bin"), { recursive: true });
  try { fs.linkSync(process.execPath, path.join(payload, "node", "bin", "node")); }
  catch { fs.copyFileSync(process.execPath, path.join(payload, "node", "bin", "node")); }
  fs.mkdirSync(support);
  t.after(async () => {
    await Promise.all([...activeChildren].map(stop));
    if (fs.existsSync(grandchildState)) {
      const { pid } = JSON.parse(fs.readFileSync(grandchildState, "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) put(payload, file, "v-identity-fixture\n");
  put(payload, "runtime/product.manifest.json", JSON.stringify({ productId: "fixture-industry" }));
  put(payload, "runtime/.env.defaults", "DESKTOP_SEED_SCRIPT=scripts/seed-fixture.ts\n");
  put(payload, "runtime/scripts/migrate.ts", "// Dedicated fixture migration entry; no database is contacted.\n");
  put(payload, "runtime/scripts/seed-fixture.ts", "// Dedicated fixture seed entry; no customer records are created.\n");
  put(payload, "runtime/apps/server/src/index.ts", "// Dedicated real HTTP fixture entry.\n");
  put(payload, "runtime/apps/web/dist/index.html", '<html><head><meta name="workloom-product-id" content="fixture-industry"></head><body>fixture</body></html>');
  put(payload, "runtime/scripts/desktop-bootstrap-db.mjs", `
import { join } from 'node:path';
if (process.env.WORKLOOM_PG_BOOTSTRAP_MODE === 'inspect') console.log('workloom-db-identity '+JSON.stringify({
  systemIdentifier:'7654321098765432109',dataDirectory:process.env.WORKLOOM_EXPECTED_PGDATA,
  hbaFile:process.env.WORKLOOM_EXPECTED_HBA_FILE,port:Number(process.env.WORKLOOM_PG_PORT)}));
else console.log('fixture database helper '+process.env.WORKLOOM_PG_BOOTSTRAP_MODE);
`);
  const pg = `#!${node}\nconst fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), data=args[args.indexOf('-D')+1];
if (path.basename(process.argv[1])==='initdb') {fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'PG_VERSION'),'17');fs.writeFileSync(path.join(data,'pg_hba.conf'),'fixture original auth\\n');}
else if(args.includes('status')) process.exit(fs.existsSync(path.join(data,'postmaster.pid'))?0:3);
else if(args.includes('start')) fs.writeFileSync(path.join(data,'postmaster.pid'),process.pid+'\\n'+data+'\\n1\\n'+process.env.WORKLOOM_PG_PORT+'\\n');
else if(args.includes('stop')) fs.rmSync(path.join(data,'postmaster.pid'),{force:true});
`;
  for (const name of ["initdb", "pg_ctl", "postgres"]) put(payload, `pg/bin/${name}`, pg, 0o755);
  put(payload, "nats/nats-server", `#!${node}\nconst net=require('node:net');const args=process.argv.slice(2);net.createServer((s)=>s.end()).listen(Number(args[args.indexOf('-p')+1]),'127.0.0.1');\n`, 0o755);
  put(payload, "runtime/node_modules/tsx/dist/cli.mjs", `
import { createServer } from 'node:http';
if (${JSON.stringify(failMigration)} && process.argv.includes('scripts/migrate.ts')) {
 console.error('opaque-fixture-record '+process.env.APP_DB_PASSWORD); process.exit(2);
}
if(process.argv.includes('src/index.ts')) {
 if (${JSON.stringify(backendGrandchild)}) {
  const {spawn}=await import('node:child_process');
  const program="const fs=require('node:fs'),net=require('node:net');process.on('SIGTERM',()=>{});const s=net.createServer(c=>c.end());s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_GRANDCHILD_STATE,JSON.stringify({pid:process.pid,port:s.address().port})));";
  spawn(process.execPath,['-e',program],{stdio:'ignore'});
 }
 console.log('fixture backend running');console.error('bare-fixture-value '+process.env.APP_DB_PASSWORD);
 createServer((request,response)=>{
  if(request.url==='/fixture-exit'){response.end('fixture stopping');setTimeout(()=>process.exit(3),20);return;}
  response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,service:'workloom-im-server',instanceId:process.env.SERVER_INSTANCE_ID}));
 }).listen(Number(process.env.WORKLOOM_SERVER_PORT),'127.0.0.1');
} else console.log('fixture migration/seed complete');
`);
  put(payload, "runtime/node_modules/vite/bin/vite.js", `
const http=require('node:http');
if (${JSON.stringify(webIgnoresTerm)}) process.on('SIGTERM',()=>{});
http.createServer((request,response)=>{response.setHeader('x-workloom-product-id','fixture-industry');response.setHeader('x-workloom-instance-id',process.env.WORKLOOM_INSTANCE_ID);response.end('<html><head><meta name="workloom-product-id" content="fixture-industry"></head><body>fixture</body></html>');}).listen(Number(process.env.WORKLOOM_WEB_PORT),'127.0.0.1');
`);
  put(payload, "python/bin/python3.12", `#!${node}\nconsole.log('offline-fixture-ok');\n`, 0o755);
  fs.symlinkSync("python3.12", path.join(payload, "python/bin/python3"));
  const target = process.platform === "darwin" ? `mac-${process.arch}` : `${process.platform}-${process.arch}`;
  put(payload, "runtime/industry-runtime.json", JSON.stringify({ schemaVersion: "workloom.industry-runtime/v1", productId: "fixture-industry", target,
    requiredParts: ["python"], requiredFiles: [{ root: "support", path: "python/bin/python3" }],
    environment: { INDUSTRY_MODE: "fixture" }, selftests: [{ name: "offline_fixture", executable: { root: "support", path: "python/bin/python3" }, args: [], expectedStdout: "offline-fixture-ok" }] }));
  const identity = generatePayloadIntegrity(payload);
  const start = (actualPorts, { resourcesDir = payload } = {}) => {
    const env = { PATH: "", FIXTURE_GRANDCHILD_STATE: grandchildState, ...Object.fromEntries(Object.entries(actualPorts).map(([name, value]) => [`WORKLOOM_${name.toUpperCase()}_PORT`, String(value)])) };
    const child = spawn(process.execPath, [path.join(__dirname, "bootstrap.cjs"), "--resources", resourcesDir, "--support", support], { env, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    return { child, output: () => output };
  };
  return { root, payload, support, identity, start, grandchildState };
}

const unixFixture = { skip: process.platform === "win32" ? "POSIX executable fixtures do not validate native Windows; actual Windows app smoke is a separate mandatory gate" : false };
test("actual bootstrap with real bundled Node/HTTP fixtures writes current identity, preserves internal links, and revokes it on stop/relaunch", unixFixture, async (t) => {
  const f = payloadFixture(t);
  const actualPorts = await ports();
  const active = f.start(actualPorts);
  const state = await until(() => {
    if (active.child.exitCode !== null) throw new Error(`Fixture failed before ready: ${active.output()}`);
    const value = readState(f.support); return value?.phase === "ready" ? value : false;
  }, "first ready");
  assert.equal(state.status, "complete");
  const identity = state.runtimeIdentity;
  assert.equal(identity.schemaVersion, "workloom.client-runtime-identity/v1");
  assert.match(identity.instanceId, /^[a-f0-9-]{36}$/u);
  assert.equal(identity.productId, "fixture-industry");
  assert.equal(identity.supportDir, fs.realpathSync.native(f.support));
  assert.equal(identity.payloadVersion, "v-identity-fixture");
  assert.equal(identity.productManifestSha256, f.identity.productManifestSha256);
  assert.equal(identity.payloadIntegritySha256, f.identity.payloadIntegritySha256);
  assert.deepEqual(identity.ports, { server: actualPorts.server, web: actualPorts.web });
  assert.equal(fs.readlinkSync(path.join(f.support, "python/bin/python3")), "python3.12");
  assert.deepEqual(verifyPayloadIntegrity(f.support), f.identity);
  assert.equal(await httpOk(`http://127.0.0.1:${actualPorts.server}/health`, { service: "workloom-im-server", instanceId: identity.instanceId }), true);
  assert.equal(await httpOk(`http://127.0.0.1:${actualPorts.web}`, { productId: identity.productId, instanceId: identity.instanceId }), true);
  assert.match(fs.readFileSync(path.join(f.support, "logs/server.log"), "utf8"), /bare-fixture-value \[已脱敏\]/u);
  await stop(active.child);
  assert.equal(readState(f.support).phase, "stopped");
  assert.equal(readState(f.support).status, "stopped");
  assert.equal(await httpOk(`http://127.0.0.1:${actualPorts.server}/health`, { service: "workloom-im-server", instanceId: identity.instanceId }), false);
  assert.equal(fs.existsSync(path.join(f.support, ".bootstrap-lock")), false);
  const restarted = f.start(actualPorts);
  const second = await until(() => {
    if (restarted.child.exitCode !== null) throw new Error(`Relaunch failed: ${restarted.output()}`);
    const value = readState(f.support); return value?.phase === "ready" ? value : false;
  }, "relaunch ready");
  assert.notEqual(second.runtimeIdentity.instanceId, identity.instanceId);
  assert.equal(second.runtimeIdentity.payloadIntegritySha256, identity.payloadIntegritySha256);
  assert.equal(await httpOk(`http://127.0.0.1:${actualPorts.server}/health`, { service: "workloom-im-server", instanceId: identity.instanceId }), false);
  await stop(restarted.child);
  put(f.support, "runtime/scripts/migrate.ts", "tampered fixture entry\n");
  const tampered = f.start(actualPorts);
  assert.equal(await closed(tampered.child), 1);
  assert.equal(readState(f.support).status, "failed");
  assert.notEqual(readState(f.support).phase, "ready");
});
for (const webIgnoresTerm of [false, true]) test(`actual ready child exit revokes state and kills current services (web ignores SIGTERM=${webIgnoresTerm})`, unixFixture, async (t) => {
  const f = payloadFixture(t, { webIgnoresTerm });
  const actualPorts = await ports();
  const active = f.start(actualPorts);
  const ready = await until(() => {
    if (active.child.exitCode !== null) throw new Error(`Fixture failed: ${active.output()}`);
    const state = readState(f.support); return state?.phase === "ready" ? state : false;
  }, "child-exit ready");
  const result = await fetch(`http://127.0.0.1:${actualPorts.server}/fixture-exit`);
  await result.text();
  const stopped = await until(() => { const state = readState(f.support); return state?.phase === "child-exited" ? state : false; }, "child-exit checkpoint");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.runtimeIdentity.instanceId, ready.runtimeIdentity.instanceId);
  await until(async () => !fs.existsSync(path.join(f.support, ".bootstrap-lock"))
    && !(await httpOk(`http://127.0.0.1:${actualPorts.web}`, { productId: "fixture-industry", instanceId: ready.runtimeIdentity.instanceId })), "child-exit cleanup", 8_000);
  assert.equal(fs.existsSync(path.join(f.support, ".bootstrap-lock")), false);
  assert.equal(await httpOk(`http://127.0.0.1:${actualPorts.web}`, { productId: "fixture-industry", instanceId: ready.runtimeIdentity.instanceId }), false);
  await stop(active.child);
});
test("an exited owned group leader cannot leave its SIGTERM-ignoring descendant alive after cleanup", unixFixture, async (t) => {
  const f = payloadFixture(t, { backendGrandchild: true });
  const actualPorts = await ports();
  const active = f.start(actualPorts);
  await until(() => {
    if (active.child.exitCode !== null) throw new Error(`Fixture failed: ${active.output()}`);
    return readState(f.support)?.phase === "ready";
  }, "descendant fixture ready");
  const grandchild = await until(() => {
    try { return JSON.parse(fs.readFileSync(f.grandchildState, "utf8")); } catch { return false; }
  }, "owned descendant state");
  const connects = () => new Promise((resolve) => {
    const socket = net.connect({ port: grandchild.port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
  assert.equal(await connects(), true, "the actual descendant must be alive before triggering its leader exit");
  const response = await fetch(`http://127.0.0.1:${actualPorts.server}/fixture-exit`);
  await response.text();
  await until(() => readState(f.support)?.phase === "child-exited", "descendant leader exit checkpoint");
  await until(async () => !fs.existsSync(path.join(f.support, ".bootstrap-lock")) && !(await connects()), "descendant group cleanup", 8_000);
  assert.equal(await connects(), false);
  assert.equal(readState(f.support).status, "stopped");
  await stop(active.child);
});
test("actual bootstrap failure cannot reflect a bare managed credential through CLI or checkpoint diagnostics", unixFixture, async (t) => {
  const f = payloadFixture(t, { failMigration: true });
  const active = f.start(await ports());
  assert.equal(await closed(active.child), 1);
  const state = readState(f.support);
  assert.equal(state.status, "failed");
  assert.notEqual(state.phase, "ready");
  const credentials = JSON.parse(fs.readFileSync(path.join(f.support, "database-state.json"), "utf8")).credentials;
  const persisted = fs.readdirSync(path.join(f.support, "logs")).filter((name) => name.endsWith(".log"))
    .map((name) => fs.readFileSync(path.join(f.support, "logs", name), "utf8")).join("\n") + JSON.stringify(state);
  for (const value of Object.values(credentials)) {
    assert.equal(persisted.includes(value), false);
    assert.equal(active.output().includes(value), false, "the outer CLI must receive the same redacted failure as the persisted checkpoint");
  }
  assert.match(active.output(), /数据库迁移失败/u);
  assert.equal(fs.existsSync(path.join(f.support, ".bootstrap-lock")), false);
});
for (const validArchive of [false, true]) test(`archive source is verified even with a complete same-version cache (valid archive=${validArchive})`, unixFixture, async (t) => {
  const f = payloadFixture(t);
  const resources = path.join(f.root, "resources");
  fs.mkdirSync(resources);
  fs.copyFileSync(path.join(f.payload, "PAYLOAD_VERSION"), path.join(resources, "PAYLOAD_VERSION"));
  fs.cpSync(f.payload, path.join(f.support, ".payload-cache"), { recursive: true, verbatimSymlinks: true });
  if (validArchive) {
    const archive = spawnSync("/usr/bin/tar", ["-czf", path.join(resources, "payload.tar.gz"), "-C", f.payload, "."], { encoding: "utf8" });
    assert.equal(archive.status, 0, "the fixture archive must be built by the actual system tar");
  } else put(resources, "payload.tar.gz", "invalid-archive-synthetic-fixture");
  const actualPorts = await ports();
  const active = f.start(actualPorts, { resourcesDir: resources });
  const outcome = await until(() => {
    const state = readState(f.support);
    if (state?.phase === "ready") return "ready";
    if (active.child.exitCode !== null) return "rejected";
    return false;
  }, "archive source validation");
  assert.equal(outcome, validArchive ? "ready" : "rejected");
  if (validArchive) {
    assert.equal(readState(f.support).runtimeIdentity.payloadIntegritySha256, f.identity.payloadIntegritySha256);
    await stop(active.child);
    const stampFile = path.join(f.support, ".payload-cache/.source-archive.json");
    const stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
    const beforeReuse = fs.statSync(stampFile).ino;
    assert.equal(stamp.schemaVersion, "workloom.payload-archive-cache/v1");
    assert.equal(stamp.payloadIntegritySha256, f.identity.payloadIntegritySha256);
    const restarted = f.start(actualPorts, { resourcesDir: resources });
    await until(() => {
      if (restarted.child.exitCode !== null) throw new Error(`Cache reuse failed: ${restarted.output()}`);
      return readState(f.support)?.phase === "ready";
    }, "verified archive cache reuse");
    assert.equal(fs.statSync(stampFile).ino, beforeReuse, "a verified identical archive reuses the stamp instead of re-extracting");
    await stop(restarted.child);
    put(resources, "payload.tar.gz", "invalid-changed-archive-synthetic-fixture");
    const changed = f.start(actualPorts, { resourcesDir: resources });
    assert.equal(await closed(changed.child), 1, "a same-version archive change cannot use the stamped cache");
    assert.equal(readState(f.support).status, "failed");
    assert.notEqual(readState(f.support).phase, "ready");
  } else {
    assert.equal(await closed(active.child), 1);
    assert.equal(readState(f.support).status, "failed");
    assert.equal(fs.existsSync(path.join(f.support, "database-state.json")), false);
    assert.equal(fs.existsSync(path.join(f.support, ".bootstrap-lock")), false);
  }
});
for (const prefix of ["", "./"]) test(`actual system tar index observation accepts one current ordinary index (${prefix || "no prefix"})`, unixFixture, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-archive-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = JSON.stringify({ schemaVersion: "workloom.payload-integrity/v1", payloadVersion: "v-fixture" }) + "\n";
  put(root, "source/payload-integrity.json", content);
  const archive = path.join(root, "payload.tar.gz");
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", archive, "-C", path.join(root, "source"), `${prefix}payload-integrity.json`]).status, 0);
  const observed = readArchiveIdentity(archive, "v-fixture");
  assert.match(observed.archiveSha256, /^[a-f0-9]{64}$/u);
  assert.equal(observed.payloadIntegritySha256, require("node:crypto").createHash("sha256").update(content).digest("hex"));
  assert.throws(() => readArchiveIdentity(archive, "v-other"), /版本不匹配/u);
});
for (const kind of ["missing", "duplicate", "malformed", "symlink"]) test(`actual system tar rejects a ${kind} source index before cache reuse`, unixFixture, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-archive-bad-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  put(source, "VERSION", "v-fixture");
  if (kind === "symlink") fs.symlinkSync("VERSION", path.join(source, "payload-integrity.json"));
  else if (kind !== "missing") put(source, "payload-integrity.json", kind === "malformed" ? "{broken" : JSON.stringify({ schemaVersion: "workloom.payload-integrity/v1", payloadVersion: "v-fixture" }));
  const archive = path.join(root, "payload.tar.gz");
  const members = kind === "missing" ? ["VERSION"] : kind === "duplicate" ? ["payload-integrity.json", "./payload-integrity.json"] : ["payload-integrity.json"];
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", archive, "-C", source, ...members]).status, 0);
  assert.throws(() => readArchiveIdentity(archive, "v-fixture"), /载荷归档/u);
});
test("archive source symlinks and a descriptor-to-path replacement fail before tar invocation", unixFixture, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wl-archive-replaced-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "payload.tar.gz");
  put(root, "actual.tar.gz", "synthetic-invalid-archive");
  fs.symlinkSync("actual.tar.gz", archive);
  assert.throws(() => readArchiveIdentity(archive, "v-fixture"), /普通文件/u);
  fs.unlinkSync(archive);
  put(root, "payload.tar.gz", "synthetic-invalid-archive");
  const originalOpen = fs.openSync;
  const originalStat = fs.fstatSync;
  let targetFd;
  let checks = 0;
  let injected = false;
  fs.openSync = function (file, ...args) { const fd = originalOpen.call(fs, file, ...args); if (file === archive) targetFd = fd; return fd; };
  fs.fstatSync = function (fd, ...args) {
    const snapshot = originalStat.call(fs, fd, ...args);
    if (fd === targetFd && ++checks === 2 && !injected) {
      injected = true;
      fs.renameSync(archive, `${archive}.previous`);
      fs.symlinkSync("payload.tar.gz.previous", archive);
    }
    return snapshot;
  };
  try {
    assert.throws(() => readArchiveIdentity(archive, "v-fixture"), /校验时发生变化/u);
    assert.equal(injected, true, "the actual source path must be substituted after descriptor hashing");
  } finally { fs.openSync = originalOpen; fs.fstatSync = originalStat; }
});
test("atomic installation rolls back index/markers and preserves exact internal symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-atomic-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const create = (name, version) => {
    const dir = path.join(root, name);
    for (const file of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) put(dir, file, version);
    put(dir, "runtime/product.manifest.json", JSON.stringify({ productId: "fixture-industry" }));
    for (const file of ["runtime/.env.defaults", "runtime/scripts/desktop-bootstrap-db.mjs", "node/bin/node", "pg/bin/postgres", "pg/bin/pg_ctl", "pg/bin/initdb", "nats/nats-server", "python/bin/python3.12"]) put(dir, file, `fixture-${version}`);
    fs.symlinkSync("python3.12", path.join(dir, "python/bin/python3"));
    return { dir, identity: generatePayloadIntegrity(dir) };
  };
  const old = create("support", "v-old");
  const next = create("payload", "v-next");
  put(old.dir, ".bootstrapped", "done");
  for (const failAt of ["after-stage", "after-first-swap", "after-version-swap"]) {
    assert.throws(() => installPayloadAtomically({ sourceRoot: next.dir, supportDir: old.dir, payloadVer: "v-next", failAt }), /故障注入/u);
    assert.deepEqual(verifyPayloadIntegrity(old.dir), old.identity);
    assert.equal(fs.readFileSync(path.join(old.dir, ".bootstrapped"), "utf8"), "done");
  }
  const transaction = installPayloadAtomically({ sourceRoot: next.dir, supportDir: old.dir, payloadVer: "v-next" });
  assert.deepEqual(verifyPayloadIntegrity(old.dir), next.identity);
  assert.equal(fs.readlinkSync(path.join(old.dir, "python/bin/python3")), "python3.12");
  transaction.rollback();
  assert.deepEqual(verifyPayloadIntegrity(old.dir), old.identity);
});
test("child stdout/stderr fragments are redacted before the log is written", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-child-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "child.log");
  const child = spawnLogged(process.execPath, ["-e", "process.stdout.write('SERVICE_C_SECRET=split-');setTimeout(()=>{process.stdout.write('synthetic-private\\n');process.stderr.write('unlabelled literal-synthetic-private\\n');},10)"], { secretValues: ["literal-synthetic-private"] }, file);
  assert.equal(await closed(child), 0);
  const result = fs.readFileSync(file, "utf8");
  assert.equal(result.includes("split-synthetic-private"), false);
  assert.equal(result.includes("literal-synthetic-private"), false);
  assert.match(result, /SERVICE_C_SECRET=\[已脱敏\]/u);
});
test("child multi-line private keys and overlong line tails cannot reach persisted diagnostics", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-child-pem-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "child.log");
  const pemBegin = ["-----BEGIN ", "PRIVATE", " KEY-----"].join("");
  const program = `process.stdout.write(${JSON.stringify(`${pemBegin}\n`)});
setTimeout(()=>process.stdout.write('unlabelled-pem-synthetic-private\\n-----END PRIVATE KEY-----\\nfixture-safe-pem-tail\\n'),10);
process.stderr.write('SERVICE_C_SECRET='+ 'x'.repeat(65000));
setTimeout(()=>process.stderr.write('unlabelled-overlong-synthetic-private\\nfixture-safe-overlong-tail\\n'),20);`;
  const child = spawnLogged(process.execPath, ["-e", program], { secretValues: [] }, file);
  assert.equal(await closed(child), 0);
  const result = fs.readFileSync(file, "utf8");
  assert.equal(result.includes("unlabelled-pem-synthetic-private"), false);
  assert.equal(result.includes("unlabelled-overlong-synthetic-private"), false);
  assert.match(result, /fixture-safe-pem-tail/u);
  assert.match(result, /fixture-safe-overlong-tail/u);
});
test("a private-key header split at an overlong discarded line boundary still suppresses following key lines", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-child-pem-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "child.log");
  const program = `process.stdout.write('x'.repeat(65000)+'-----BE');
setTimeout(()=>process.stdout.write('GIN PRIVATE KEY-----\\nunlabelled-boundary-pem-private\\n-----END PRIVATE KEY-----\\nfixture-safe-boundary-tail\\n'),40);`;
  const child = spawnLogged(process.execPath, ["-e", program], { secretValues: [] }, file);
  assert.equal(await closed(child), 0);
  const result = fs.readFileSync(file, "utf8");
  assert.equal(result.includes("unlabelled-boundary-pem-private"), false);
  assert.match(result, /fixture-safe-boundary-tail/u);
});
