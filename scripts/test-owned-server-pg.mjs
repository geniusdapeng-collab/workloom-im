#!/usr/bin/env node
/**
 * apps/server 的任务专属 PostgreSQL 契约：私有 Unix 集群 + 严格回执。
 *
 * 这五套契约各自 fail closed：缺少私有集群/哨兵时 beforeAll 会直接抛错。泛化
 * db-gate 的共享 Postgres 与它们不兼容（aipm.snapshot 拒绝任何非 /tmp/wl-aipm-proof-*
 * 的库），因此 .cnb.yml 在通用 server 阶段用 WORKLOOM_GENERIC_DB_CI=1 把它们交给
 * **本 runner**——排除必须由真实的强制执行路径补偿，否则等于摘掉必需检查。
 *
 * 与 scripts/test-owned-pg.mjs 同一口径：显式环境白名单、私有 Unix socket、
 * 事务内迁移两次、非超级且非 BYPASSRLS 角色、严格 vitest 回执、集群与目录清理。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, chmod, chown, rm, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { childEnvironment, databaseUrls, pgProcessIdentity, runCommand, validateVitestReport } from "./test-owned-pg.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireServer = createRequire(join(ROOT, "apps/server/package.json"));

/** 五套契约的精确文件、私有前缀、必测用例数与必需哨兵。 */
export const OWNED_SERVER_SUITES = Object.freeze([
  {
    key: "aipm-snapshot", file: "src/service/aipm.snapshot.pg.test.ts", tests: 34,
    database: "aipm_proof_owned", prefix: "wl-aipm-proof-", reportEnv: null,
  },
  {
    key: "devtools-cancel", file: "src/service/devtools.cancel.pg.test.ts", tests: 29,
    database: "raw_scope_devtools_cancel", prefix: "wl-raw-scope-", reportEnv: "DEVTOOLS_CANCEL_REPORT_DIR",
    sentinels: { DEVTOOLS_THREAD_TASK_OWNED: "1" },
  },
  {
    key: "devtools-thread", file: "src/service/devtools.thread.pg.test.ts", tests: 20,
    database: "raw_scope_devtools_thread", prefix: "wl-raw-scope-", reportEnv: "DEVTOOLS_THREAD_REPORT_DIR",
    sentinels: { DEVTOOLS_THREAD_TASK_OWNED: "1" },
  },
  {
    key: "secretary-approval", file: "src/service/secretary.approval.pg.test.ts", tests: 29,
    database: "raw_scope_secretary", prefix: "wl-raw-scope-", reportEnv: "SECRETARY_APPROVAL_REPORT_DIR",
    sentinels: { SECRETARY_APPROVAL_TASK_OWNED: "1", RAW_SCOPE_REPO: "base" },
  },
  {
    key: "kb-publish", file: "src/service/kb-publish.pg.test.ts", tests: 52,
    database: "kb_publish", prefix: "wl-kb-pg-", reportEnv: "KB_PUBLISH_RESULTS",
    sentinels: { RUN_KB_PUBLISH_DB_TESTS: "1" }, requiresFixtureOwner: true, reportFileName: "kb-publish-results.json",
  },
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => sha256(await readFile(path));
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const errorData = (error) => ({ name: error.name, message: error.message });

/** 私有集群的库名：除 secretary.approval（校验 raw_scope_base_<nonce>）外由 runner 决定。 */
export function suiteDatabase(suite) { return suite.database; }

/** 每套契约的哨兵环境：只在父进程内构造，绝不继承调用者的 DATABASE_* / 模型 / 泛化开关。 */
export function suiteEnvironment(suite, { socket, port, database, reportDirectory }) {
  const env = { ...databaseUrls(database, socket, port) };
  // 三套契约各自用不同写法校验私有所有权：两个 devtools 契约用「原样含 host=/tmp/wl-raw-scope-」，
  // 与 percent-encoding 的 URL 形态等价——runner 必须同时给出两种等价形态才算真实拥有该集群。
  if (suite.key === "devtools-cancel" || suite.key === "devtools-thread") {
    env.DATABASE_URL = env.DATABASE_URL.replace("host=%2Ftmp%2F", "host=/tmp/").replace(/socket(?=&|$)/, "socket");
  }
  Object.assign(env, suite.sentinels ?? {});
  // 报告夹具必须是文件路径：devtools/secretary 自己拼 <name>.json，kb-publish 要求单个文件。
  if (suite.reportEnv) env[suite.reportEnv] = suite.reportFileName ? join(reportDirectory, suite.reportFileName) : reportDirectory;
  if (suite.key === "secretary-approval") {
    env.RAW_SCOPE_SOCKET = socket;
    env.RAW_SCOPE_DATABASE = database;
    env.RAW_SCOPE_NONCE = "owned0000";
  }
  if (suite.key === "kb-publish") {
    env.KB_PUBLISH_SOCKET = socket;
    env.KB_PUBLISH_PORT = String(port);
    env.KB_PUBLISH_NONCE = env.RAW_SCOPE_NONCE ?? randomBytes(6).toString("hex");
  }
  // 泛化开关必须缺席：专属 runner 不能继承通用 CI 的排除面。
  assert.equal(env.WORKLOOM_GENERIC_DB_CI, undefined, "Owned server runner must not inherit the generic-CI exclusion");
  return env;
}

/** secretary.approval 用 RAW_SCOPE_DATABASE 正则校验库名；kb-publish 用 sentinel 表。 */
async function prepareCluster(suite, record, environment, pgTools, identity) {
  const directory = await mkdtemp(`/tmp/${suite.prefix}`);
  const socket = join(directory, "socket");
  const data = join(directory, "data");
  await chmod(directory, 0o700);
  await mkdir(socket, { mode: 0o700 });
  if (identity.uid !== undefined) { await chown(directory, identity.uid, identity.gid); await chown(socket, identity.uid, identity.gid); }
  const port = 59000 + randomBytes(2).readUInt16BE() % 5000;
  const nonce = randomBytes(5).toString("hex");
  const database = suite.key === "secretary-approval" ? `raw_scope_base_${nonce.slice(0, 10)}`
    : suite.key === "aipm-snapshot" ? `aipm_proof_${nonce}` : suiteDatabase(suite);
  record.socket = socket; record.cluster_directory = directory; record.database = database; record.port = port;
  await runCommand(record, "initdb", [join(pgTools.directory, "initdb"), "-D", data, "-U", "postgres", "--encoding=UTF8", "--no-locale", "--auth-local=trust", "--auth-host=reject", "--no-instructions"], ROOT, environment, { identity, timeout: 60_000 });
  await runCommand(record, "start", [join(pgTools.directory, "pg_ctl"), "-D", data, "-l", join(directory, "postgres.log"), "-w", "-t", "30", "-o", `-p ${port} -c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c max_connections=80`, "start"], ROOT, environment, { identity, timeout: 45_000 });
  return { directory, socket, data, port, database, nonce };
}

async function applyMigrations(pool, names, record) {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('workloom-migrate'))");
    await client.query("CREATE TABLE IF NOT EXISTS _migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text)");
    for (const name of names) {
      const sql = await readFile(join(ROOT, "packages/db/migrations", name), "utf8");
      const hash = sha256(sql);
      const applied = (await client.query("SELECT checksum FROM _migrations WHERE name=$1", [name])).rows[0];
      if (applied) { assert.equal(applied.checksum, hash, `Applied migration drift: ${name}`); continue; }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations(name,checksum) VALUES($1,$2)", [name, hash]);
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollback) { destroy = true; throw new AggregateError([error, rollback], `Migration ${name} and rollback failed`); }
        throw new Error(`Owned migration ${name} failed`, { cause: error });
      }
      record.migrations.push({ name, sha256: hash });
    }
  } finally {
    try { if (!destroy) await client.query("SELECT pg_advisory_unlock(hashtext('workloom-migrate'))"); }
    finally { client.release(destroy); }
  }
}

async function runSuite(suite, reportDirectory, environment, pgTools, identity, pg) {
  const record = { ...suite, report_directory: reportDirectory, commands: [], migrations: [], result: "failed", cleanup: null };
  await mkdir(reportDirectory);
  let directory; let attemptedStart = false; let owner; let admin;
  const errors = [];
  try {
    const cluster = await prepareCluster(suite, record, environment, pgTools, identity);
    directory = cluster.directory;
    attemptedStart = true;
    admin = new pg.Pool({ host: cluster.socket, port: cluster.port, database: "postgres", user: "postgres", max: 1, connectionTimeoutMillis: 5_000 });
    await admin.query("CREATE ROLE workloom_app LOGIN NOSUPERUSER NOBYPASSRLS");
    await admin.query("CREATE ROLE workloom_gateway LOGIN NOSUPERUSER NOBYPASSRLS");
    await admin.query(`CREATE DATABASE "${cluster.database}"`);
    const env = { ...environment, ...suiteEnvironment(suite, { socket: cluster.socket, port: cluster.port, database: cluster.database, reportDirectory }) };
    owner = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    if (suite.requiresFixtureOwner) {
      // kb-publish 的 sentinel 同时校验 nonce 与"未监听 TCP"：只有真正拉起私有集群的 runner
      // 才可能拥有这张表，夹具因此不会误接到共享库。表建立在迁移之后、契约执行之前。
      await owner.query("CREATE TABLE kb_publish_fixture_owner(nonce text NOT NULL, listener text NOT NULL)");
      await owner.query("INSERT INTO kb_publish_fixture_owner(nonce,listener) VALUES($1,(SELECT current_setting('listen_addresses')))", [env.KB_PUBLISH_NONCE]);
    }
    const migrations = (await readdir(join(ROOT, "packages/db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    await applyMigrations(owner, migrations, record);
    await applyMigrations(owner, migrations, record);
    record.migration_ledger = (await owner.query("SELECT name,checksum FROM _migrations ORDER BY name")).rows;
    assert.deepEqual(record.migration_ledger.map((row) => row.name), migrations, "Every migration must be applied exactly once");
    for (const row of record.migration_ledger) assert.equal(row.checksum, await digest(join(ROOT, "packages/db/migrations", row.name)));
    record.roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    assert.equal(record.roles.length, 2);
    assert(record.roles.every((role) => !role.rolsuper && !role.rolbypassrls));
    record.source_sha256 = await digest(join(ROOT, "apps/server", suite.file));
    const vitest = join(dirname(requireServer.resolve("vitest/package.json")), "vitest.mjs");
    const report = join(reportDirectory, "vitest.json");
    const exit = await runCommand(record, "vitest", [process.execPath, vitest, "run", suite.file, "--fileParallelism=false", "--maxWorkers=1", "--reporter=default", "--reporter=json", `--outputFile=${report}`], join(ROOT, "apps/server"), env);
    record.assertions = validateVitestReport(JSON.parse(await readFile(report, "utf8")), suite, await realpath(join(ROOT, "apps/server", suite.file)), exit);
    assert.equal(record.source_sha256, await digest(join(ROOT, "apps/server", suite.file)), "Original guard file changed during execution");
    const evidence = suite.reportEnv ? (suite.reportFileName ? join(reportDirectory, suite.reportFileName) : null) : null;
    if (evidence && existsSync(evidence)) record.suite_report_sha256 = await digest(evidence);
    record.result = "passed";
  } catch (error) { errors.push(error); }
  finally {
    const closed = await Promise.allSettled([owner?.end(), admin?.end()]);
    for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
    let stopped = true;
    if (directory && attemptedStart) {
      try {
        const data = join(directory, "data");
        const status = await runCommand(record, "status", [join(pgTools.directory, "pg_ctl"), "-D", data, "status"], ROOT, environment, { identity, allowed: [0, 3], timeout: 30_000 });
        if (status === 0) await runCommand(record, "stop", [join(pgTools.directory, "pg_ctl"), "-D", data, "-w", "-t", "30", "stop", "-m", "fast"], ROOT, environment, { identity, timeout: 45_000 });
        const after = await runCommand(record, "stopped-status", [join(pgTools.directory, "pg_ctl"), "-D", data, "status"], ROOT, environment, { identity, allowed: [3], timeout: 30_000 });
        assert.equal(after, 3); assert.equal(existsSync(join(data, "postmaster.pid")), false, "Owned PG PID remains after stop");
      } catch (error) { stopped = false; errors.push(error); }
      try { if (existsSync(join(directory, "postgres.log"))) await writeFile(join(reportDirectory, "postgres.log"), await readFile(join(directory, "postgres.log"))); }
      catch (error) { errors.push(error); }
    }
    if (directory && stopped) {
      try { await rm(directory, { recursive: true, force: false }); }
      catch (error) { errors.push(error); }
    }
    record.cleanup = { stopped, directory_removed: directory === undefined || !existsSync(directory) };
    if (errors.length || !record.cleanup.stopped || !record.cleanup.directory_removed) record.result = "failed";
    record.errors = errors.map(errorData);
    await save(join(reportDirectory, "result.json"), record);
  }
  return record;
}

async function pgBinaries(explicit) {
  const { spawnSync } = await import("node:child_process");
  const { access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  let directory = explicit;
  if (!directory) {
    const config = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
    if (config.status === 0) directory = config.stdout.trim();
    else if (existsSync("/usr/lib/postgresql/17/bin")) directory = "/usr/lib/postgresql/17/bin";
  }
  assert(directory, "PostgreSQL 17 tools required; pass --pg-bin or install pg_config in PATH");
  directory = await realpath(directory);
  for (const name of ["initdb", "pg_ctl", "postgres", "pg_config"]) await access(join(directory, name), constants.X_OK);
  const version = spawnSync(join(directory, "postgres"), ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, "PostgreSQL version probe failed");
  assert(/\(PostgreSQL\) 17\./.test(version.stdout), "Exactly PostgreSQL major 17 required");
  const shared = spawnSync(join(directory, "pg_config"), ["--sharedir"], { encoding: "utf8" });
  assert.equal(shared.status, 0, "PostgreSQL resource probe failed");
  await access(join(shared.stdout.trim(), "extension/vector.control"), constants.R_OK);
  return { directory, version: version.stdout.trim() };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { "pg-bin": { type: "string" }, "report-dir": { type: "string" }, suites: { type: "string" } }, strict: true, allowPositionals: false });
  const reportDirectory = values["report-dir"];
  assert(reportDirectory, "--report-dir is required; existing evidence is immutable");
  assert(!existsSync(reportDirectory), "Report directory must be new; existing evidence is immutable");
  await mkdir(dirname(reportDirectory), { recursive: true }); await mkdir(reportDirectory);
  const selected = values.suites ? new Set(values.suites.split(",")) : null;
  const suites = OWNED_SERVER_SUITES.filter((suite) => !selected || selected.has(suite.key));
  assert(suites.length && (!selected || selected.size === suites.length), "Unknown owned server suite filter");
  const requireBase = createRequire(join(ROOT, "packages/base/package.json"));
  const { default: pg } = await import(pathToFileURL(requireBase.resolve("pg")).href);
  const result = { schema: "workloom.owned-server-pg-ci/v1", started_at: new Date().toISOString(),
    runner_sha256: await digest(fileURLToPath(import.meta.url)), suites: [], result: "failed",
    paid_calls: false, customer_data_used: false, shared_database_used: false, report_directory: reportDirectory };
  let temporary;
  try {
    const pgTools = await pgBinaries(values["pg-bin"]);
    const identity = pgProcessIdentity();
    result.postgres = pgTools; result.pg_process_identity = identity;
    temporary = await mkdtemp("/tmp/wl-owned-server-tmp-");
    const environment = childEnvironment(process.env, temporary);
    const absoluteReport = resolve(reportDirectory);
    for (const suite of suites) result.suites.push(await runSuite(suite, join(absoluteReport, suite.key), environment, pgTools, identity, pg));
    assert.equal(result.suites.length, suites.length);
    assert(result.suites.every((suite) => suite.result === "passed"), "One or more owned server suites failed; inspect their result.json and logs");
    result.actual_tests = result.suites.reduce((sum, suite) => sum + suite.assertions.passed, 0);
    assert.equal(result.actual_tests, suites.reduce((sum, suite) => sum + suite.tests, 0), "Owned server suite count drifted");
    result.result = "passed";
  } catch (error) { result.error = errorData(error); }
  finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: false }); }
    catch (error) { result.result = "failed"; result.cleanup_error = errorData(error); }
    result.temporary_removed = temporary === undefined || !existsSync(temporary);
    if (!result.temporary_removed) result.result = "failed";
    await save(join(reportDirectory, "result.json"), result);
  }
  console.log(JSON.stringify({ result: result.result, actual_tests: result.actual_tests ?? 0, report_directory: reportDirectory }));
  return result.result === "passed" ? 0 : 1;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
