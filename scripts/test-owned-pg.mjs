#!/usr/bin/env node
/** Four existing owned-PG regressions, with real private clusters and strict receipts. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, chown, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/fixtures/skills-pre0055");
const requireBase = createRequire(join(ROOT, "packages/base/package.json"));
const { default: pg } = await import(pathToFileURL(requireBase.resolve("pg")).href);

export const OWNED_SUITES = Object.freeze([
  { key: "im-inbound", file: "im-channels/im-inbound.pg.test.ts", tests: 50, prefix: "wl-im-inbound-" },
  { key: "inspection-idempotency", file: "inspection/inspection-idempotency.test.ts", tests: 5, prefix: "wl-inspection-proof-" },
  { key: "skills-security", file: "skills/skills-security.pg.test.ts", tests: 54, prefix: "wl-mc022-pg-" },
  { key: "skills-upgrade", file: "skills/skills-upgrade.pg.test.ts", tests: 7, prefix: "wl-mc022-pg-" },
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => sha256(await readFile(path));
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const exists = async (path) => {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
const errorData = (error) => ({ name: error.name, message: error.message });

/** Explicit allowlist: never inherit shared DB, model, secret, or generic-CI flags. */
export function childEnvironment(ambient, temporaryDirectory) {
  const result = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (ambient[key] !== undefined) result[key] = ambient[key];
  }
  return Object.assign(result, {
    TMPDIR: temporaryDirectory, NODE_ENV: "test", RUN_DB_TESTS: "1",
    LLM_PROVIDER: "mock", IM_DRIVER: "mock", TOOL_UNVERIFIED_RATE: "0",
    PII_SALT: "synthetic-owned-pg-ci-pii-salt",
  });
}

export function databaseUrls(database, socket, port) {
  assert(/^[a-z][a-z0-9_]+$/.test(database), "Synthetic database name required");
  assert(/^\/tmp\/wl-(im-inbound|inspection-proof|mc022-pg)-[a-zA-Z0-9]+\/socket$/.test(socket), "Owned Unix socket required");
  assert(Number.isInteger(port) && port >= 59000 && port <= 63999, "Owned socket port required");
  return Object.fromEntries([["DATABASE_URL", "postgres"], ["DATABASE_APP_URL", "workloom_app"],
    ["DATABASE_GATEWAY_URL", "workloom_gateway"]].map(([key, user]) => {
    const url = new URL(`postgresql://${user}@localhost/${database}`);
    url.searchParams.set("host", socket); url.searchParams.set("port", String(port));
    return [key, url.href];
  }));
}

/** Exit zero alone is insufficient: require this file and every actual assertion. */
export function validateVitestReport(report, suite, expectedFile, exitCode) {
  assert.equal(exitCode, 0, `${suite.key}: Vitest exited unsuccessfully`);
  assert.equal(report.success, true, `${suite.key}: report is not successful`);
  assert.equal(report.numTotalTests, suite.tests, `${suite.key}: unexpected total, including zero tests`);
  assert.equal(report.numPassedTests, suite.tests, `${suite.key}: not every assertion passed`);
  for (const key of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"]) {
    assert.equal(report[key] ?? 0, 0, `${suite.key}: failed, skipped or unfinished ${key}`);
  }
  assert.equal(report.testResults?.length, 1, `${suite.key}: exact one-file report required`);
  const result = report.testResults[0];
  assert.equal(resolve(result.name), expectedFile, `${suite.key}: report refers to another source file`);
  assert.equal(result.status, "passed", `${suite.key}: suite setup/teardown failed`);
  assert.equal(result.assertionResults?.length, suite.tests, `${suite.key}: missing assertion receipts`);
  for (const assertion of result.assertionResults) {
    assert.equal(assertion.status, "passed", `${suite.key}: assertion did not actually pass: ${assertion.fullName}`);
    assert.equal(assertion.failureMessages?.length ?? 0, 0, `${suite.key}: assertion retained errors`);
  }
  return { file: suite.file, total: suite.tests, passed: suite.tests, failed: 0, skipped: 0 };
}

export function pgProcessIdentity(uid = process.getuid?.(), platform = process.platform, lookup = spawnSync) {
  assert(platform === "linux" || platform === "darwin", "Owned Unix PG runner supports Linux and macOS");
  if (uid !== 0) return {};
  assert.equal(platform, "linux", "Root execution requires the Linux postgres OS account");
  const readId = (flag) => {
    const result = lookup("id", [flag, "postgres"], { encoding: "utf8" });
    assert.equal(result.status, 0, "postgres OS identity lookup failed");
    assert(/^\d+$/.test(result.stdout.trim()), "Invalid postgres OS identity");
    const value = Number(result.stdout.trim());
    assert(Number.isSafeInteger(value) && value > 0, "PostgreSQL must not run as root");
    return value;
  };
  return { uid: readId("-u"), gid: readId("-g") };
}

async function binaries(explicit) {
  let directory = explicit;
  if (!directory) {
    const config = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
    if (config.status === 0) directory = config.stdout.trim();
    else if (await exists("/usr/lib/postgresql/17/bin")) directory = "/usr/lib/postgresql/17/bin";
  }
  assert(directory && isAbsolute(directory), "PostgreSQL 17 tools required; pass --pg-bin or install pg_config in PATH");
  directory = await realpath(directory);
  for (const name of ["initdb", "pg_ctl", "postgres", "pg_config"]) await access(join(directory, name), constants.X_OK);
  const version = spawnSync(join(directory, "postgres"), ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, "PostgreSQL version probe failed");
  assert(/\(PostgreSQL\) 17\./.test(version.stdout), "Exactly PostgreSQL major 17 required");
  const shared = spawnSync(join(directory, "pg_config"), ["--sharedir"], { encoding: "utf8" });
  assert.equal(shared.status, 0, "PostgreSQL resource probe failed");
  const vectorControl = join(shared.stdout.trim(), "extension/vector.control");
  await access(vectorControl, constants.R_OK);
  return { directory, version: version.stdout.trim(), vector_control: vectorControl, vector_control_sha256: await digest(vectorControl) };
}

export async function runCommand(record, name, argv, cwd, env, options = {}) {
  const log = join(record.report_directory, `${name}.log`);
  const output = await open(log, "wx");
  const started = Date.now();
  const command = { name, argv, cwd, log, exit_code: null, timed_out: false, signal: null };
  record.commands.push(command);
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env, stdio: ["ignore", output.fd, output.fd], detached: true,
      ...options.identity,
    });
    command.pid = child.pid;
    let escalation;
    const terminate = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") command.signal_error = errorData(error); }
    };
    const timer = setTimeout(() => {
      command.timed_out = true; terminate("SIGTERM");
      escalation = setTimeout(() => terminate("SIGKILL"), 2000);
    }, options.timeout ?? 180_000);
    try {
      const result = await new Promise((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
      command.exit_code = command.timed_out ? 124 : result.code;
      command.signal = result.signal;
    } finally {
      clearTimeout(timer); clearTimeout(escalation);
      // The direct child may exit before a descendant that ignored SIGTERM.
      // Finish terminating our own group before recording a timeout result.
      if (command.timed_out) terminate("SIGKILL");
    }
    assert((options.allowed ?? [0]).includes(command.exit_code) && !command.timed_out && !command.signal_error,
      `${name} failed (exit ${command.exit_code}); see ${log}`);
    return command.exit_code;
  } catch (error) { command.error = errorData(error); throw error; }
  finally {
    await output.close(); command.seconds = (Date.now() - started) / 1000;
    command.log_sha256 = await digest(log);
    console.log(JSON.stringify({ suite: record.key, command: name, exit_code: command.exit_code, timed_out: command.timed_out }));
  }
}

export async function verifyFixture(root, repo) {
  const path = join(root, "scripts/fixtures/skills-pre0055/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.schema, "workloom.skills-pre0055-fixture/v1");
  assert.equal(await digest(join(root, "scripts/fixtures/skills-pre0055/setup.mts")), manifest.setup_helper?.sha256, "Legacy setup helper drifted");
  assert.equal(manifest.modules.length, 6, "Exactly six frozen historical modules required");
  const seen = new Set();
  for (const module of manifest.modules) {
    assert(/^packages\/base\/(skills|skill-ops)\/[a-z]+\.ts$/.test(module.path) && !seen.has(module.path), "Invalid frozen source path");
    seen.add(module.path);
    assert.equal(await digest(join(root, "scripts/fixtures/skills-pre0055", module.path)), module.sha256, `Frozen source drift: ${module.path}`);
  }
  const migrationDirectory = join(root, "packages/db/migrations");
  const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  assert(names.includes("0055_private_skill_ownership.sql"), "Current ownership migration is required");
  const expected = manifest.pre0055_migrations[repo];
  assert.equal(expected?.length, 42, "Repository-specific pre0055 migration manifest is required");
  assert.deepEqual(names.filter((name) => name < "0055"), expected.map((row) => row.name), "Historical migration names drifted");
  for (const row of expected) assert.equal(await digest(join(migrationDirectory, row.name)), row.sha256, `Historical migration drift: ${row.name}`);
  return manifest;
}

async function applyMigrations(pool, names, record) {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('workloom-migrate'))");
    await client.query("CREATE TABLE IF NOT EXISTS _migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text)");
    const applied = new Map((await client.query("SELECT name,checksum FROM _migrations")).rows.map((row) => [row.name, row.checksum]));
    for (const name of names) {
      const sql = await readFile(join(ROOT, "packages/db/migrations", name), "utf8");
      const hash = sha256(sql);
      if (applied.has(name)) { assert.equal(applied.get(name), hash, `Applied migration drift: ${name}`); continue; }
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

async function seedSyntheticBaseline(owner, legacy) {
  await owner.query("INSERT INTO tenants(id,name) VALUES('tenant-demo','owned synthetic regression tenant')");
  await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES('ws-yunqi','tenant-demo','owned synthetic regression workspace','synthetic-owned-regression','general','ready')");
  await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES('ws-yunqi','tenant-demo','general','{\"purpose\":\"synthetic owned CI fixture\"}')");
  await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES('synthetic-owned-member-1','ws-yunqi','MEM-001','synthetic owner','owner'),('synthetic-owned-member-2','ws-yunqi','MEM-002','synthetic manager','manager'),('synthetic-owned-member-3','ws-yunqi','MEM-003','synthetic readonly','readonly')");
  if (legacy) await owner.query("INSERT INTO skills(id,level,name,version,description,body,fence_bindings) VALUES('skill-t-ws-yunqi-weekly-ops-review','team','synthetic unproved legacy row','1.0.0','synthetic legacy fixture','synthetic legacy body','[]')");
}

async function copySourceTree(source, target, files, base = source) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (["node_modules", "dist", ".vite", "coverage", "outputs"].includes(entry.name) || entry.name.startsWith(".env")) continue;
    const from = join(source, entry.name); const to = join(target, entry.name);
    assert(!entry.isSymbolicLink(), `Legacy support source cannot be a symlink: ${from}`);
    if (entry.isDirectory()) await copySourceTree(from, to, files, base);
    else if (entry.isFile()) {
      const bytes = await readFile(from); await writeFile(to, bytes, { flag: "wx" });
      assert.equal(await digest(from), sha256(bytes), `Support source changed while copying: ${from}`);
      files.push({ path: relative(base, from), sha256: sha256(bytes) });
    }
  }
}

async function prepareLegacySource(directory, manifest, record) {
  await mkdir(directory);
  await copyFile(join(ROOT, "package.json"), join(directory, "package.json"));
  await copyFile(join(ROOT, "tsconfig.base.json"), join(directory, "tsconfig.base.json"));
  const support = [];
  for (const name of ["base", "db", "shared"]) {
    await copySourceTree(join(ROOT, "packages", name), join(directory, "packages", name), support, ROOT);
  }
  const frozen = [];
  for (const module of manifest.modules) {
    const target = join(directory, module.path);
    const currentHash = await digest(target);
    await copyFile(join(FIXTURE, module.path), target);
    assert.equal(await digest(target), module.sha256, `Legacy overlay drift: ${module.path}`);
    frozen.push({ ...module, current_support_sha256: currentHash });
  }
  // Borrow external packages only. Internal base/db/shared imports bind to this private copy.
  for (const suffix of ["", "packages/base", "packages/db", "packages/shared"]) {
    const sourceModules = join(ROOT, suffix, "node_modules");
    const modules = join(directory, suffix, "node_modules");
    await mkdir(modules);
    if (await exists(sourceModules)) {
      for (const entry of await readdir(sourceModules)) {
        if (entry !== "@workloom") await symlink(join(sourceModules, entry), join(modules, entry));
      }
    }
    await mkdir(join(modules, "@workloom"));
    for (const name of ["base", "db", "shared"]) {
      await symlink(join(directory, "packages", name), join(modules, "@workloom", name));
    }
  }
  await mkdir(join(directory, "scripts"));
  await copyFile(join(FIXTURE, "setup.mts"), join(directory, "scripts/owned-pg-legacy.mts"));
  await save(join(record.report_directory, "legacy-source.json"), {
    description: manifest.description, source_commit: manifest.source_commits[record.repo],
    frozen_modules: frozen, current_support_files: support,
    current_external_dependencies_borrowed: true, complete_historical_product_replay: false,
    pre0055_migrations: manifest.pre0055_migrations[record.repo],
  });
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function verifyChain(owner) {
  const rows = (await owner.query("SELECT event_id,tenant_id,workspace_id,payload,prev_hash,hash FROM biz_events ORDER BY seq")).rows;
  const tails = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.tenant_id, row.workspace_id]);
    const tail = tails.get(key) ?? "GENESIS";
    assert.equal(row.prev_hash, tail, `Owned chain predecessor mismatch: ${row.event_id}`);
    assert.equal(row.hash, sha256(tail + canonical(row.payload)), `Owned chain hash mismatch: ${row.event_id}`);
    tails.set(key, row.hash);
  }
  return { rows: rows.length, scopes: tails.size, valid: true };
}

async function runSuite(suite, repo, reportDirectory, environment, pgTools, identity, fixture) {
  const record = { ...suite, repo, report_directory: reportDirectory, commands: [], migrations: [], result: "failed", cleanup: null };
  await mkdir(reportDirectory);
  let directory; let attemptedStart = false; let owner; let admin;
  const errors = [];
  try {
    directory = await mkdtemp(`/tmp/${suite.prefix}`);
    const socket = join(directory, "socket"); const data = join(directory, "data");
    await chmod(directory, 0o700); await mkdir(socket, { mode: 0o700 });
    if (identity.uid !== undefined) { await chown(directory, identity.uid, identity.gid); await chown(socket, identity.uid, identity.gid); }
    const nonce = randomBytes(5).toString("hex"); const port = 59000 + randomBytes(2).readUInt16BE() % 5000;
    const database = suite.key === "im-inbound" ? `im_inbound_${repo}_${nonce}`
      : suite.key === "inspection-idempotency" ? `inspection_proof_${repo}`
      : suite.key === "skills-upgrade" ? "skills_namespace" : "skills_security";
    const env = { ...environment, ...databaseUrls(database, socket, port) };
    record.socket = socket; record.cluster_directory = directory; record.database = database;
    record.os_identity = identity; record.source_sha256 = await digest(join(ROOT, "packages/base", suite.file));
    await runCommand(record, "initdb", [join(pgTools.directory, "initdb"), "-D", data, "-U", "postgres", "--encoding=UTF8", "--no-locale", "--auth-local=trust", "--auth-host=reject", "--no-instructions"], ROOT, environment, { identity, timeout: 60_000 });
    attemptedStart = true;
    await runCommand(record, "start", [join(pgTools.directory, "pg_ctl"), "-D", data, "-l", join(directory, "postgres.log"), "-w", "-t", "30", "-o", `-p ${port} -c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c max_connections=80`, "start"], ROOT, environment, { identity, timeout: 45_000 });
    admin = new pg.Pool({ host: socket, port, database: "postgres", user: "postgres", max: 1, connectionTimeoutMillis: 5000 });
    await admin.query("CREATE ROLE workloom_app LOGIN NOSUPERUSER NOBYPASSRLS");
    await admin.query("CREATE ROLE workloom_gateway LOGIN NOSUPERUSER NOBYPASSRLS");
    await admin.query(`CREATE DATABASE "${database}"`);
    owner = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    record.roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    assert.equal(record.roles.length, 2); assert(record.roles.every((role) => !role.rolsuper && !role.rolbypassrls));
    const names = (await readdir(join(ROOT, "packages/db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    if (suite.key === "skills-upgrade") {
      const legacyNames = fixture.pre0055_migrations[repo].map((row) => row.name);
      await applyMigrations(owner, legacyNames, record); await applyMigrations(owner, legacyNames, record);
      await seedSyntheticBaseline(owner, true);
      const legacy = join(directory, "source");
      await prepareLegacySource(legacy, fixture, record);
      env.SKILLS_NAMESPACE_LEGACY_MANIFEST = join(reportDirectory, "legacy-fixture.json");
      env.SKILLS_NAMESPACE_UPGRADE_REPORT = join(reportDirectory, "upgrade-preservation.json");
      await runCommand(record, "legacy-prepare", [process.execPath, "--import", "tsx", "scripts/owned-pg-legacy.mts", "prepare"], legacy, env);
      record.legacy_chain = await verifyChain(owner);
      await applyMigrations(owner, names, record); await applyMigrations(owner, names, record);
      await runCommand(record, "legacy-preservation", [process.execPath, "--import", "tsx", "scripts/owned-pg-legacy.mts", "verify"], legacy, env);
      env.SKILLS_NAMESPACE_UPGRADE_FACTS_PATH = join(reportDirectory, "upgrade-test-facts.json");
    } else {
      await applyMigrations(owner, names, record); await applyMigrations(owner, names, record);
      await seedSyntheticBaseline(owner, false);
    }
    record.migration_ledger = (await owner.query("SELECT name,checksum FROM _migrations ORDER BY name")).rows;
    assert.deepEqual(record.migration_ledger.map((row) => row.name), names);
    for (const row of record.migration_ledger) assert.equal(row.checksum, await digest(join(ROOT, "packages/db/migrations", row.name)));
    if (suite.key === "im-inbound") Object.assign(env, {
      PII_SALT: "synthetic-im-inbound-test-salt",
      IM_INBOUND_TASK_OWNED: "1", IM_INBOUND_SOCKET: socket, IM_INBOUND_PORT: String(port),
      IM_INBOUND_DATABASE: database, IM_INBOUND_REPO: repo, IM_INBOUND_NONCE: nonce, IM_INBOUND_REPORT_DIR: reportDirectory,
    });
    if (suite.key === "skills-security") env.SKILLS_NAMESPACE_SECURITY_FACTS_PATH = join(reportDirectory, "security-test-facts.json");
    assert.equal(env.WORKLOOM_GENERIC_DB_CI, undefined, "Dedicated runner must not inherit the generic-CI exclusion");
    const vitest = join(dirname(requireBase.resolve("vitest/package.json")), "vitest.mjs");
    const report = join(reportDirectory, "vitest.json");
    const exit = await runCommand(record, "vitest", [process.execPath, vitest, "run", suite.file, "--fileParallelism=false", "--maxWorkers=1", "--reporter=default", "--reporter=json", `--outputFile=${report}`], join(ROOT, "packages/base"), env);
    record.assertions = validateVitestReport(JSON.parse(await readFile(report, "utf8")), suite, await realpath(join(ROOT, "packages/base", suite.file)), exit);
    record.chain = await verifyChain(owner);
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
        assert.equal(after, 3); assert.equal(await exists(join(data, "postmaster.pid")), false, "Owned PG PID remains after stop");
      } catch (error) { stopped = false; errors.push(error); }
      try { if (await exists(join(directory, "postgres.log"))) await copyFile(join(directory, "postgres.log"), join(reportDirectory, "postgres.log")); }
      catch (error) { errors.push(error); }
    }
    if (directory && stopped) {
      try { await rm(directory, { recursive: true, force: false }); }
      catch (error) { errors.push(error); }
    }
    record.cleanup = { stopped, directory_removed: directory === undefined || !(await exists(directory)) };
    if (errors.length || !record.cleanup.stopped || !record.cleanup.directory_removed) record.result = "failed";
    record.errors = errors.map(errorData);
    await save(join(reportDirectory, "result.json"), record);
  }
  return record;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, "pg-bin": { type: "string" }, "report-dir": { type: "string" },
  }, strict: true, allowPositionals: false });
  assert(["base", "hotel"].includes(values.repo), "--repo base|hotel is required");
  const reportDirectory = resolve(values["report-dir"] ?? join(ROOT, "outputs/owned-pg", `${Date.now()}-${randomBytes(5).toString("hex")}`));
  assert(!(await exists(reportDirectory)), "Report directory must be new; existing evidence is immutable");
  await mkdir(dirname(reportDirectory), { recursive: true }); await mkdir(reportDirectory);
  const result = { schema: "workloom.owned-pg-ci/v1", repo: values.repo, started_at: new Date().toISOString(),
    runner_sha256: await digest(fileURLToPath(import.meta.url)), suites: [], result: "failed", paid_calls: false,
    customer_data_used: false, shared_database_used: false, report_directory: reportDirectory };
  let temporary;
  try {
    const fixture = await verifyFixture(ROOT, values.repo);
    const pgTools = await binaries(values["pg-bin"]); const identity = pgProcessIdentity();
    result.postgres = pgTools; result.pg_process_identity = identity;
    temporary = await mkdtemp("/tmp/wl-owned-tmp-");
    const env = childEnvironment(process.env, temporary);
    for (const suite of OWNED_SUITES) {
      result.suites.push(await runSuite(suite, values.repo, join(reportDirectory, suite.key), env, pgTools, identity, fixture));
    }
    assert.equal(result.suites.length, 4); assert(result.suites.every((suite) => suite.result === "passed"), "One or more owned suites failed; inspect their result.json and logs");
    result.actual_tests = result.suites.reduce((sum, suite) => sum + suite.assertions.passed, 0);
    assert.equal(result.actual_tests, 116); result.result = "passed";
  } catch (error) { result.error = errorData(error); }
  finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: false }); }
    catch (error) { result.result = "failed"; result.cleanup_error = errorData(error); }
    result.temporary_removed = temporary === undefined || !(await exists(temporary));
    if (!result.temporary_removed) result.result = "failed";
    await save(join(reportDirectory, "result.json"), result);
  }
  console.log(JSON.stringify({ result: result.result, actual_tests: result.actual_tests ?? 0, report_directory: reportDirectory }));
  return result.result === "passed" ? 0 : 1;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
