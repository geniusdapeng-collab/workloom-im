import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
