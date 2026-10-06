#!/usr/bin/env node
/**
 * 基座 captain/night-shift 的任务专属 PostgreSQL 契约 runner。
 *
 * 三套契约各自 fail closed：缺少私有 Unix 集群 / 哨兵时整块 describe 恒为 skip，
 * 断言永远不会变红。泛化 db-gate 的共享 Postgres 与它们不兼容，因此 .cnb.yml 在
 * 通用 base 阶段用 WORKLOOM_GENERIC_DB_CI=1 把它们交给 **本 runner**——排除必须由
 * 真实的强制执行路径补偿，否则等于把必需检查静默摘掉。
 *
 * 与 scripts/test-owned-pg.mjs / test-owned-server-pg.mjs 同一口径：显式环境白名单、
 * 私有 Unix socket、事务内迁移两次、非超级且非 BYPASSRLS 角色、严格 vitest 回执
 * （用例数 / 0 跳过 / 0 失败 / 断言级 passed）、集群与目录清理。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, chmod, chown, rm, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { childEnvironment, pgProcessIdentity, runCommand, validateVitestReport } from "./test-owned-pg.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireBase = createRequire(join(ROOT, "packages/base/package.json"));

/** 三套契约的精确文件、私有前缀、必测用例数与必需哨兵。 */
export const OWNED_CEO_NIGHT_SUITES = Object.freeze([
  {
    key: "ceo-escalation", file: "captain/ceo-escalation.pg.test.ts", tests: 52,
    prefix: "wl-ceo-escalation-", databasePrefix: "ceo_escalation_base",
    sentinels: { CEO_ESCALATION_TASK_OWNED: "1" },
  },
  {
    key: "ceo-withdrawal", file: "captain/ceo-withdrawal.pg.test.ts", tests: 206,
    prefix: "wl-ceo-escalation-withdrawal-", databasePrefix: "ceo_escalation_base",
    sentinels: { CEO_WITHDRAWAL_TASK_OWNED: "1" },
  },
  {
    key: "night-package", file: "night-shift/night-package.pg.test.ts", tests: 58,
    prefix: "wl-night-package-", databasePrefix: "night_package_base",
    sentinels: { NIGHT_PACKAGE_TASK_OWNED: "1" },
  },
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => sha256(await readFile(path));
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const errorData = (error) => ({ name: error.name, message: error.message });

/**
 * 每套契约的哨兵环境：只在父进程内构造，绝不继承调用者的 DATABASE_* / 模型 / 泛化开关。
 * ceo-escalation / ceo-withdrawal 各自校验 socket 与库名正则；两者共用同一组
 * CEO_ESCALATION_* 变量名，因此 runner 必须按套分别给出，不能混用。
 */
export function suiteEnvironment(suite, { socket, port, database, nonce }) {
  // 三套契约的私有 socket 直接是 /tmp/wl-<suite>-<id> 目录（PG 在其中放 .s.PGSQL.<port>），
  // 与 test-owned-pg 的 <dir>/socket 形态不同，因此这里按同一所有权口径单独校验并构造 URL。
  assert(socket.startsWith(`/tmp/${suite.prefix}`), "Owned Unix socket directory required");
  assert(new RegExp(`^${suite.databasePrefix}_[a-z0-9_]+$`).test(database), "Owned synthetic database required");
  assert(Number.isInteger(port) && port >= 59000 && port <= 63999, "Owned socket port required");
  const env = Object.assign({}, Object.fromEntries([["DATABASE_URL", "postgres"], ["DATABASE_APP_URL", "workloom_app"],
    ["DATABASE_GATEWAY_URL", "workloom_gateway"]].map(([key, user]) => {
    const url = new URL(`postgresql://${user}@localhost/${database}`);
    url.searchParams.set("host", socket); url.searchParams.set("port", String(port));
    return [key, url.href];
  })), suite.sentinels, { RUN_DB_TESTS: "1" });
  if (suite.key === "night-package") {
    Object.assign(env, { NIGHT_PACKAGE_SOCKET: socket, NIGHT_PACKAGE_PORT: String(port),
      NIGHT_PACKAGE_DATABASE: database, NIGHT_PACKAGE_NONCE: nonce });
  } else {
    Object.assign(env, { CEO_ESCALATION_SOCKET: socket, CEO_ESCALATION_PORT: String(port),
      CEO_ESCALATION_DATABASE: database });
  }
  assert.equal(env.WORKLOOM_GENERIC_DB_CI, undefined, "Owned CEO/night runner must not inherit the generic-CI exclusion");
  return env;
}

async function prepareCluster(suite, record, environment, pgTools, identity) {
  // 三套契约把「私有 socket」定义为 /tmp/<prefix><id> 目录本身（不是 <dir>/socket），
  // 因此集群数据目录另放，socket 目录直接就是所有权哨兵里的那个路径。
  const directory = await mkdtemp(`/tmp/${suite.prefix}`);
  const socket = directory;
  const data = join(directory, "data");
  await chmod(directory, 0o700);
  if (identity.uid !== undefined) { await chown(directory, identity.uid, identity.gid); }
  const port = 59000 + randomBytes(2).readUInt16BE() % 5000;
  const nonce = randomBytes(5).toString("hex");
  const database = `${suite.databasePrefix}_${nonce}`;
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
    const env = { ...environment, ...suiteEnvironment(suite, cluster) };
    owner = new pg.Pool({ host: cluster.socket, port: cluster.port, database: cluster.database, user: "postgres", max: 1, connectionTimeoutMillis: 5_000 });
    assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    const migrations = (await readdir(join(ROOT, "packages/db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    await applyMigrations(owner, migrations, record);
    await applyMigrations(owner, migrations, record);
    record.migration_ledger = (await owner.query("SELECT name,checksum FROM _migrations ORDER BY name")).rows;
    assert.deepEqual(record.migration_ledger.map((row) => row.name), migrations, "Every migration must be applied exactly once");
    for (const row of record.migration_ledger) assert.equal(row.checksum, await digest(join(ROOT, "packages/db/migrations", row.name)));
    record.roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    assert.equal(record.roles.length, 2);
    assert(record.roles.every((role) => !role.rolsuper && !role.rolbypassrls));
    record.source_sha256 = await digest(join(ROOT, "packages/base", suite.file));
    const vitest = join(dirname(requireBase.resolve("vitest/package.json")), "vitest.mjs");
    const report = join(reportDirectory, "vitest.json");
    const exit = await runCommand(record, "vitest", [process.execPath, vitest, "run", suite.file, "--fileParallelism=false", "--maxWorkers=1", "--reporter=default", "--reporter=json", `--outputFile=${report}`], join(ROOT, "packages/base"), env, { timeout: 600_000 });
    record.assertions = validateVitestReport(JSON.parse(await readFile(report, "utf8")), suite, await realpath(join(ROOT, "packages/base", suite.file)), exit);
    assert.equal(record.source_sha256, await digest(join(ROOT, "packages/base", suite.file)), "Original guard file changed during execution");
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
  const suites = OWNED_CEO_NIGHT_SUITES.filter((suite) => !selected || selected.has(suite.key));
  assert(suites.length && (!selected || selected.size === suites.length), "Unknown owned CEO/night suite filter");
  const { default: pg } = await import(pathToFileURL(requireBase.resolve("pg")).href);
  const result = { schema: "workloom.owned-ceo-night-pg-ci/v1", started_at: new Date().toISOString(),
    runner_sha256: await digest(fileURLToPath(import.meta.url)), suites: [], result: "failed",
    paid_calls: false, customer_data_used: false, shared_database_used: false, report_directory: reportDirectory };
  let temporary;
  try {
    const pgTools = await pgBinaries(values["pg-bin"]);
    const identity = pgProcessIdentity();
    result.postgres = pgTools; result.pg_process_identity = identity;
    temporary = await mkdtemp("/tmp/wl-owned-ceo-tmp-");
    const environment = childEnvironment(process.env, temporary);
    const absoluteReport = resolve(reportDirectory);
    for (const suite of suites) result.suites.push(await runSuite(suite, join(absoluteReport, suite.key), environment, pgTools, identity, pg));
    assert.equal(result.suites.length, suites.length);
    assert(result.suites.every((suite) => suite.result === "passed"), "One or more owned CEO/night suites failed; inspect their result.json and logs");
    result.actual_tests = result.suites.reduce((sum, suite) => sum + suite.assertions.passed, 0);
    assert.equal(result.actual_tests, suites.reduce((sum, suite) => sum + suite.tests, 0), "Owned CEO/night suite count drifted");
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
