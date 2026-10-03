import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceScript = new URL("./reset.sh", import.meta.url);

function databaseLocation(host = "127.0.0.1", database = "workloom") {
  return `postgres://demo@${host}:5432/${database}`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-reset-safety-"));
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  copyFileSync(sourceScript, join(scripts, "reset.sh"));
  // A real local config must not mask missing safety gates by failing early.
  writeFileSync(join(root, ".env"), `DATABASE_URL=${databaseLocation()}\n`);
  const log = join(root, "calls.log");

  writeExecutable(join(bin, "psql"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${STUB_DB_FAILURE:-0}" = "1" ]; then
  printf 'synthetic database check failure\\n' >&2
  exit 31
fi
args="$*"
case "$args" in
  *"to_regclass('public.workspaces')"*) printf '%s\\n' "\${STUB_TABLE_STATE:-present}" ;;
  *"information_schema.columns"*) printf '%s\\n' "\${STUB_EXAMPLE_COLUMN:-1}" ;;
  *"is_example IS NOT TRUE"*) printf '%s\\n' "\${STUB_NON_EXAMPLE:-0}" ;;
  *"DROP SCHEMA public CASCADE"*) printf '%s\\n' drop >>"$STUB_LOG" ;;
  *) printf '%s\\n' unexpected-psql >>"$STUB_LOG" ;;
esac
`);
  writeExecutable(join(bin, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' backup >>"$STUB_LOG"
case "\${STUB_BACKUP_MODE:-valid}" in
  failed) printf 'synthetic backup failure\\n' >&2; exit 32 ;;
  empty) exit 0 ;;
esac
printf 'synthetic-backup-for-test\\n'
`);
  writeExecutable(join(bin, "pnpm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >>"$STUB_LOG"
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    DATABASE_URL: databaseLocation(),
    NODE_ENV: "test",
  };
  const run = (args = [], overrides = {}) => spawnSync("bash", [join(scripts, "reset.sh"), ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    input: "",
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return { root, run, calls };
}

test("非交互调用没有 --yes 时 fail closed，且不访问数据库", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 64);
  assert.match(result.stderr, /非交互环境必须显式传入 --yes/);
  assert.equal(f.calls(), "");
});

test("远端、生产和数据库名不匹配目标始终拒绝", () => {
  for (const overrides of [
    { DATABASE_URL: databaseLocation("db.example.invalid") },
    { NODE_ENV: "production" },
    { DATABASE_URL: databaseLocation("127.0.0.1", "customer_prod") },
  ]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  }
});

test("检测到非演示工作区时拒绝删除", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_NON_EXAMPLE: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /非演示工作区/);
  assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
});

test("本机 workloom 纯演示库先备份，再事务重建并执行迁移种子", () => {
  const f = fixture();
  const result = f.run(["--yes"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /drop/);
  assert.match(f.calls(), /pnpm db:migrate/);
  assert.match(f.calls(), /pnpm db:seed/);
  assert.match(result.stdout, /已生成重置前备份/);
});

test("未知参数 fail closed", () => {
  const f = fixture();
  const result = f.run(["--force"]);
  assert.equal(result.status, 64);
  assert.equal(f.calls(), "");
});

test("工作区标记缺失或数据库结构未知时拒绝删除", () => {
  for (const overrides of [{ STUB_EXAMPLE_COLUMN: "0" }, { STUB_TABLE_STATE: "unknown" }]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
  }
});

test("数据库检查失败时不备份、不删除、不执行迁移", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_DB_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法核验目标数据库/);
  assert.equal(f.calls(), "");
});

test("备份失败或空备份时禁止删除与迁移", () => {
  for (const mode of ["failed", "empty"]) {
    const f = fixture();
    const result = f.run(["--yes"], { STUB_BACKUP_MODE: mode });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /备份失败|备份为空/);
    assert.doesNotMatch(f.calls(), /drop|pnpm/);
  }
});
