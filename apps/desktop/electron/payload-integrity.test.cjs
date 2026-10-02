"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { generatePayloadIntegrity, verifyPayloadIntegrity } = require("./payload-integrity.cjs");

function fixture(t, { win = false, python = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); };
  write("runtime/product.manifest.json", JSON.stringify({ productId: "fixture-industry" }));
  for (const file of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) write(file, "v-fixture-1\n");
  write("runtime/.env.defaults", "MODE=fixture\n");
  write("runtime/scripts/desktop-bootstrap-db.mjs", "export const fixture = true;\n");
  write(win ? "node/node.exe" : "node/bin/node", "fixture-node");
  for (const name of ["postgres", "pg_ctl", "initdb"]) write(`pg/bin/${name}${win ? ".exe" : ""}`, `fixture-${name}`);
  write(`nats/nats-server${win ? ".exe" : ""}`, "fixture-nats");
  if (python) {
    write("python/bin/python3.12", "fixture-python");
    write("runtime/industry-runtime.json", JSON.stringify({ schemaVersion: "workloom.industry-runtime/v1", requiredParts: ["python"] }));
  }
  const index = () => JSON.parse(fs.readFileSync(path.join(root, "payload-integrity.json"), "utf8"));
  const mutateIndex = (mutate) => { const value = index(); mutate(value); write("payload-integrity.json", JSON.stringify(value)); };
  return { root, write, index, mutateIndex };
}
test("actual generated immutable bytes produce stable product/version/index fingerprints", (t) => {
  const f = fixture(t);
  const generated = generatePayloadIntegrity(f.root);
  const verified = verifyPayloadIntegrity(f.root, { expectedProductId: "fixture-industry", expectedVersion: "v-fixture-1" });
  assert.deepEqual(verified, generated);
  assert.equal(verified.fileCount, 11);
  assert.equal(verified.linkCount, 0);
  assert.match(verified.payloadIntegritySha256, /^[a-f0-9]{64}$/u);
  assert.match(verified.productManifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.index().immutableRoots, ["nats", "node", "pg", "runtime"]);
});
test("Windows entry layout is indexed without host platform assumptions", (t) => {
  const f = fixture(t, { win: true });
  generatePayloadIntegrity(f.root);
  assert.equal(verifyPayloadIntegrity(f.root).fileCount, 11);
});
for (const [name, mutate] of [
  ["same-size replacement", (f) => f.write("node/bin/node", "ALTERED-node")],
  ["truncated runtime entry", (f) => f.write("runtime/scripts/desktop-bootstrap-db.mjs", "x")],
  ["new unindexed file", (f) => f.write("runtime/extra.mjs", "fixture-extra")],
  ["removed indexed file", (f) => fs.unlinkSync(path.join(f.root, "pg/bin/pg_ctl"))],
  ["runtime version drift", (f) => f.write("runtime/VERSION", "v-fixture-2")],
  ["top-level version drift", (f) => f.write("VERSION", "v-fixture-2")],
  ["manifest drift", (f) => f.write("runtime/product.manifest.json", JSON.stringify({ productId: "foreign-product" }))],
  ["duplicate index path", (f) => f.mutateIndex((index) => index.files.push(index.files[0]))],
  ["path traversal index", (f) => f.mutateIndex((index) => { index.files[0].path = "runtime/../external"; })],
  ["mutable exclusion expansion", (f) => f.mutateIndex((index) => index.mutablePaths.push("runtime/scripts/desktop-bootstrap-db.mjs"))],
  ["missing mandatory links field", (f) => f.mutateIndex((index) => { delete index.links; })],
  ["omitted indexed assets", (f) => f.mutateIndex((index) => { index.files.pop(); })],
  ["forged length", (f) => f.mutateIndex((index) => { index.files[0].bytes += 1; })],
  ["forged digest", (f) => f.mutateIndex((index) => { index.files[0].sha256 = "0".repeat(64); })],
]) test(`fails closed on ${name}`, (t) => {
  const f = fixture(t);
  generatePayloadIntegrity(f.root);
  mutate(f);
  assert.throws(() => verifyPayloadIntegrity(f.root));
});
test("product and payload expectations fail closed", (t) => {
  const f = fixture(t);
  generatePayloadIntegrity(f.root);
  assert.throws(() => verifyPayloadIntegrity(f.root, { expectedProductId: "foreign-product" }), /产品身份/u);
  assert.throws(() => verifyPayloadIntegrity(f.root, { expectedVersion: "v-stale" }), /版本/u);
});
test("absent, malformed and symlink index never authorize the payload", (t) => {
  const f = fixture(t);
  assert.throws(() => verifyPayloadIntegrity(f.root), /索引缺失/u);
  f.write("payload-integrity.json", "{broken");
  assert.throws(() => verifyPayloadIntegrity(f.root), /JSON/u);
  fs.unlinkSync(path.join(f.root, "payload-integrity.json"));
  fs.symlinkSync("VERSION", path.join(f.root, "payload-integrity.json"));
  assert.throws(() => verifyPayloadIntegrity(f.root), /普通文件/u);
});
test("mutable configuration is excluded only as an ordinary exact .env file", (t) => {
  const f = fixture(t);
  generatePayloadIntegrity(f.root);
  f.write("runtime/.env", "SERVICE_C_SECRET=synthetic-private-fixture\n");
  const actual = verifyPayloadIntegrity(f.root);
  f.write("runtime/.env", "SERVICE_C_SECRET=changed-synthetic-private-fixture\n");
  assert.deepEqual(verifyPayloadIntegrity(f.root), actual);
  assert.equal(JSON.stringify(f.index()).includes("synthetic-private-fixture"), false);
  fs.unlinkSync(path.join(f.root, "runtime/.env"));
  fs.symlinkSync(".env.defaults", path.join(f.root, "runtime/.env"));
  assert.throws(() => verifyPayloadIntegrity(f.root), /可变配置/u);
});
test("internal Python file and directory links survive generation and exact verification", (t) => {
  const f = fixture(t, { python: true });
  fs.symlinkSync("python3.12", path.join(f.root, "python/bin/python3"));
  fs.symlinkSync("bin", path.join(f.root, "python/internal-bin"));
  const actual = generatePayloadIntegrity(f.root);
  assert.equal(actual.linkCount, 2);
  assert.deepEqual(verifyPayloadIntegrity(f.root), actual);
  assert.deepEqual(f.index().links.map((entry) => entry.target).sort(), ["bin", "python3.12"]);
  f.write("python/bin/python3.12", "tampered-python");
  assert.throws(() => verifyPayloadIntegrity(f.root));
});
test("link raw target substitutions cannot keep the old index", (t) => {
  const f = fixture(t, { python: true });
  fs.symlinkSync("python3.12", path.join(f.root, "python/bin/python3"));
  generatePayloadIntegrity(f.root);
  fs.unlinkSync(path.join(f.root, "python/bin/python3"));
  fs.symlinkSync("./python3.12", path.join(f.root, "python/bin/python3"));
  assert.throws(() => verifyPayloadIntegrity(f.root), /链接目标不匹配/u);
});
for (const [name, target] of [["absolute", "/etc/passwd"], ["escaping", "../../../external"], ["dangling", "missing"], ["cycle", "python3"]]) {
  test(`generation rejects ${name} links`, (t) => {
    const f = fixture(t, { python: true });
    fs.symlinkSync(target, path.join(f.root, "python/bin/python3"));
    assert.throws(() => generatePayloadIntegrity(f.root));
    assert.equal(fs.existsSync(path.join(f.root, "payload-integrity.json")), false);
  });
}
test("ordinary component roots are required before reading product bytes", (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.root, "runtime"), path.join(f.root, "other-runtime"));
  fs.symlinkSync("other-runtime", path.join(f.root, "runtime"));
  assert.throws(() => generatePayloadIntegrity(f.root), /根必须是普通目录/u);
});
test("undeclared bundled Python files also receive exact indexing", (t) => {
  const f = fixture(t);
  f.write("python/bin/python3.12", "fixture-python");
  generatePayloadIntegrity(f.root);
  f.write("python/unexpected.py", "x");
  assert.throws(() => verifyPayloadIntegrity(f.root));
});
test("an undeclared dangling optional component root cannot escape verification", (t) => {
  const f = fixture(t);
  generatePayloadIntegrity(f.root);
  fs.symlinkSync("missing-python-root", path.join(f.root, "python"));
  assert.throws(() => verifyPayloadIntegrity(f.root), /组件根必须是普通目录/u);
});

test("index path replacement after the held descriptor check is rejected", (t) => {
  const f = fixture(t);
  generatePayloadIntegrity(f.root);
  const file = path.join(fs.realpathSync.native(f.root), "payload-integrity.json");
  const originalOpen = fs.openSync;
  const originalStat = fs.fstatSync;
  let indexFd;
  let checks = 0;
  let injected = false;
  fs.openSync = function (entry, ...args) {
    const fd = originalOpen.call(fs, entry, ...args);
    if (entry === file) indexFd = fd;
    return fd;
  };
  fs.fstatSync = function (entry, ...args) {
    const snapshot = originalStat.call(fs, entry, ...args);
    if (entry === indexFd && ++checks === 2 && !injected) {
      injected = true;
      fs.renameSync(file, `${file}.previous`);
      fs.symlinkSync("payload-integrity.json.previous", file);
    }
    return snapshot;
  };
  try {
    let failure;
    try { verifyPayloadIntegrity(f.root); } catch (error) { failure = error; }
    assert.equal(injected, true, "the exact canonical index path must actually be replaced");
    assert.ok(failure, "the replaced index path must fail closed");
    assert.match(failure.message, /索引在读取时发生变化/u);
  } finally { fs.fstatSync = originalStat; fs.openSync = originalOpen; }
});
