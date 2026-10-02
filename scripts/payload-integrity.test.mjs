import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("CLI uses the same standalone verifier and fails without exposing a source path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workloom-integrity-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), content); };
  for (const file of ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"]) put(file, "v-cli-fixture\n");
  put("runtime/product.manifest.json", JSON.stringify({ productId: "fixture-industry" }));
  for (const file of ["runtime/.env.defaults", "runtime/scripts/desktop-bootstrap-db.mjs", "node/bin/node", "pg/bin/postgres", "pg/bin/pg_ctl", "pg/bin/initdb", "nats/nats-server"]) put(file, "fixture\n");
  const script = fileURLToPath(new URL("./payload-integrity.mjs", import.meta.url));
  const run = (command) => spawnSync(process.execPath, [script, command, "--payload-dir", root], { encoding: "utf8" });
  const generated = run("generate");
  assert.equal(generated.status, 0, generated.stderr);
  const verified = run("verify");
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), JSON.parse(generated.stdout));
  put("node/bin/node", "tampered");
  const rejected = run("verify");
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes(root), false);
  assert.equal(rejected.stdout, "");
});
