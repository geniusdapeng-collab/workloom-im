import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./native-smoke.mjs";

const script = fileURLToPath(new URL("./native-smoke.mjs", import.meta.url));
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("原生首启冒烟入口：参数齐全后把首启判定交给 bootstrap（保留真实退出码）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workloom-native-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, "resources"); mkdirSync(resources);
  const result = run(["--resources", resources, "--support", join(root, "support")]);
  // 真实 bootstrap 在没有载荷索引时会拒绝；入口层不得把它改判为成功。
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.error, undefined);
});

test("原生首启冒烟入口：缺参数、未知参数与不存在的载荷目录都 fail-closed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workloom-native-smoke-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => main([]), /--resources/u);
  assert.throws(() => main(["--resources", join(root, "missing"), "--support", join(root, "s")]), /载荷资源目录不存在/u);
  assert.throws(() => main(["--resources", root, "--support", root]), /支持目录/u);
  assert.throws(() => main(["--resources", root, "--support"]), /缺少路径/u);
  assert.throws(() => main(["--nonsense", root]), /未知参数/u);
  const bad = run(["--resources"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /用法|缺少/u);
});
