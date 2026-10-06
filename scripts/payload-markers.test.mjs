import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPayloadMarkers } from "./payload-markers.mjs";

function payload(t) {
  const root = mkdtempSync(join(tmpdir(), "workloom-payload-markers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  writeFileSync(join(root, "PAYLOAD_VERSION"), "1.2.3\n");
  writeFileSync(join(root, "runtime", "VERSION"), "1.2.3\n");
  return root;
}

test("payload markers: consistent VERSION/PAYLOAD_VERSION/runtime VERSION are accepted", (t) => {
  const root = payload(t);
  assert.equal(assertPayloadMarkers(root).version, "1.2.3");
  assert.equal(assertPayloadMarkers(root, { expectedVersion: "1.2.3" }).version, "1.2.3");
});

test("payload markers: drift and absence fail in the packaging step instead of the integrity step", (t) => {
  const drift = payload(t);
  writeFileSync(join(drift, "PAYLOAD_VERSION"), "1.2.4\n");
  assert.throws(() => assertPayloadMarkers(drift), /版本标记不一致/u);

  const mismatch = payload(t);
  assert.throws(() => assertPayloadMarkers(mismatch, { expectedVersion: "9.9.9" }), /与本次装配版本不一致/u);

  for (const file of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) {
    const root = payload(t);
    writeFileSync(join(root, file), file === "runtime/VERSION" ? join(root, "VERSION") && "" : "");
    assert.throws(() => assertPayloadMarkers(root), /标记无效|标记缺失/u, file);
  }

  const absent = payload(t);
  rmSync(join(absent, "runtime", "VERSION"));
  assert.throws(() => assertPayloadMarkers(absent), /标记缺失/u);
});

test("payload markers CLI: the assembly version must be cross-checked, never inferred from the markers themselves", (t) => {
  const root = payload(t);
  // 三个标记自洽但与本次装配版本不同：CLI 必须拒绝，而不是只做自我一致检查。
  const mismatch = spawnSync(process.execPath, ["scripts/payload-markers.mjs", root, "--expected-version", "9.9.9"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  assert.equal(mismatch.status, 1, mismatch.stdout);
  assert.match(mismatch.stderr, /与本次装配版本不一致/u);

  const ok = spawnSync(process.execPath, ["scripts/payload-markers.mjs", root, "--expected-version", "1.2.3"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).version, "1.2.3");

  const drift = payload(t);
  writeFileSync(join(drift, "runtime", "VERSION"), "1.2.4\n");
  const drifted = spawnSync(process.execPath, ["scripts/payload-markers.mjs", drift, "--expected-version", "1.2.3"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  assert.equal(drifted.status, 1, drifted.stdout);
  assert.match(drifted.stderr, /版本标记不一致/u);

  const badFlag = spawnSync(process.execPath, ["scripts/payload-markers.mjs", root, "--expected-version"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  assert.equal(badFlag.status, 1, badFlag.stdout);
  assert.match(badFlag.stderr, /缺少版本值/u);
});

test("payload markers: every packaging call site passes the assembly version", () => {
  for (const file of ["pack-macos.sh", "pack-windows.sh", "pack-electron-payload.sh"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const invocation = /node scripts\/payload-markers\.mjs [^\n]*/u.exec(source)?.[0] ?? "";
    assert.match(invocation, /--expected-version "\$VERSION"/u, `${file}: ${invocation}`);
  }
});
