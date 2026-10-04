import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { childEnvironment, databaseUrls, OWNED_SUITES, pgProcessIdentity, runCommand,
  validateVitestReport, verifyFixture } from "./test-owned-pg.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cnb = await readFile(join(root, ".cnb.yml"), "utf8");
const repo = cnb.includes("node scripts/test-owned-pg.mjs --repo base") ? "base" : "hotel";
const suite = OWNED_SUITES[3];
const expectedFile = join(root, "packages/base", suite.file);
const completeReport = () => ({
  success: true, numTotalTests: 7, numPassedTests: 7, numFailedTests: 0, numPendingTests: 0,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: expectedFile, status: "passed", assertionResults: Array.from({ length: 7 }, (_, i) => ({
    status: "passed", fullName: `synthetic receipt-shape probe ${i}`, failureMessages: [],
  })) }],
});

test("four original regression files remain byte-identical", async () => {
  const original = {
    "im-channels/im-inbound.pg.test.ts": "5f18ec5b5e00cff78fafdefa87952a7d474ed84442148e4f0c9bf9de80134344",
    "inspection/inspection-idempotency.test.ts": "22ef3e49410b78aa8f386e4dc8239e9dbb0ed667d3feb684ff702c989e2682d4",
    "skills/skills-security.pg.test.ts": "476ba06eeb8e1b4532357a2255503759691c78496f583cd5c21a395929686267",
    "skills/skills-upgrade.pg.test.ts": "a22a17f23ec5ebdceba1eff2c92c1e0534c6b09e389bf1c973cea6e29f075ca3",
  };
  assert.deepEqual(OWNED_SUITES.map((item) => item.file), Object.keys(original));
  assert.equal(OWNED_SUITES.reduce((sum, item) => sum + item.tests, 0), 116);
  for (const [file, sha] of Object.entries(original)) assert.equal(hash(await readFile(join(root, "packages/base", file))), sha, file);
});

test("only explicit generic-CI value 1 excludes the exact four files; default and direct helpers remain included", async () => {
  const previous = process.env.WORKLOOM_GENERIC_DB_CI;
  try {
    for (const [i, value] of [undefined, "0", "true", "1"].entries()) {
      if (value === undefined) delete process.env.WORKLOOM_GENERIC_DB_CI;
      else process.env.WORKLOOM_GENERIC_DB_CI = value;
      const config = await import(`../packages/base/vitest.config.mjs?owned-contract-${i}`);
      for (const file of OWNED_SUITES.map((item) => item.file)) {
        assert.equal(config.default.test.exclude.includes(file), value === "1", `${value}:${file}`);
      }
      assert.deepEqual(config.ownedPgTestFiles, OWNED_SUITES.map((item) => item.file));
    }
  } finally {
    if (previous === undefined) delete process.env.WORKLOOM_GENERIC_DB_CI;
    else process.env.WORKLOOM_GENERIC_DB_CI = previous;
  }
});

test("dedicated stage is mandatory in the actual PG17/pgvector db-gate, after Node/pnpm preparation", () => {
  const { parse } = createRequire(join(root, "packages/base/package.json"))("yaml");
  const config = parse(cnb);
  const gate = config[".db-gate"];
  assert.equal(gate.name, "db-gate");
  assert.equal(gate.allowFailure, undefined);
  assert.equal(gate.docker.image, "pgvector/pgvector:pg17");
  const index = gate.stages.findIndex((stage) => stage.script?.includes("node scripts/test-owned-pg.mjs"));
  assert(index > 0, "Owned stage must follow preparation");
  assert(gate.stages.slice(0, index).some((stage) => stage.script?.includes("pnpm install --frozen-lockfile")));
  assert(gate.stages[index].script.includes(`node scripts/test-owned-pg.mjs --repo ${repo}`));
  assert(gate.stages[index].script.includes("pnpm -C packages/industry-contract build"));
  assert(gate.stages[index].script.includes("node --test scripts/test-owned-pg-contract.test.mjs"));
  assert(gate.stages[index].script.includes("set -eu"));
  assert(!gate.stages[index].script.includes("WORKLOOM_GENERIC_DB_CI"));
  assert(cnb.includes(repo === "base" ? "WORKLOOM_GENERIC_DB_CI=1 pnpm -C packages/base test" : "WORKLOOM_GENERIC_DB_CI=1 pnpm test"));
});

test("child environment cannot inherit database URLs, model credentials, generic switch or execution hooks", () => {
  const environment = childEnvironment({
    PATH: "/allowed-path", DATABASE_URL: "mock-forbidden-shared-db", DATABASE_APP_URL: "mock-forbidden-shared-app",
    DATABASE_GATEWAY_URL: "mock-forbidden-shared-gateway", PGHOST: "mock-forbidden-host", NODE_OPTIONS: "mock-forbidden-preload",
    WORKLOOM_GENERIC_DB_CI: "1", OPENAI_API_KEY: "mock-must-not-be-inherited", SKILL_REFLUX_ENDPOINT: "mock-forbidden-endpoint",
    RUN_DB_TESTS: "0", LLM_PROVIDER: "forbidden-provider", IM_INBOUND_TASK_OWNED: "forbidden-sentinel",
  }, "/tmp/owned-contract");
  for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL", "PGHOST", "NODE_OPTIONS", "WORKLOOM_GENERIC_DB_CI", "OPENAI_API_KEY", "SKILL_REFLUX_ENDPOINT", "IM_INBOUND_TASK_OWNED"]) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.PATH, "/allowed-path"); assert.equal(environment.RUN_DB_TESTS, "1");
  assert.equal(environment.LLM_PROVIDER, "mock"); assert.equal(environment.TMPDIR, "/tmp/owned-contract");
});

test("generated URLs bind three actual roles to one owned Unix socket without a TCP password URL", () => {
  const urls = databaseUrls("skills_namespace", "/tmp/wl-mc022-pg-ABC123/socket", 59001);
  for (const [key, role] of [["DATABASE_URL", "postgres"], ["DATABASE_APP_URL", "workloom_app"], ["DATABASE_GATEWAY_URL", "workloom_gateway"]]) {
    const url = new URL(urls[key]);
    assert.equal(url.username, role); assert.equal(url.password, ""); assert.equal(url.hostname, "localhost");
    assert.equal(url.pathname, "/skills_namespace"); assert.equal(url.searchParams.get("host"), "/tmp/wl-mc022-pg-ABC123/socket");
    assert.equal(url.searchParams.get("port"), "59001");
  }
  for (const socket of ["/tmp/shared/socket", "remote.example", "/tmp/wl-mc022-pg-ABC123/../shared/socket"]) {
    assert.throws(() => databaseUrls("skills_namespace", socket, 59001));
  }
  assert.throws(() => databaseUrls('db";DROP DATABASE other', "/tmp/wl-mc022-pg-ABC123/socket", 59001));
});

test("root PG child switches uid and gid to nonroot Linux postgres; unprivileged macOS retains its own identity", () => {
  const lookup = (_command, [flag, account]) => {
    assert.equal(account, "postgres"); return { status: 0, stdout: flag === "-u" ? "123\n" : "456\n" };
  };
  assert.deepEqual(pgProcessIdentity(0, "linux", lookup), { uid: 123, gid: 456 });
  assert.deepEqual(pgProcessIdentity(501, "darwin", () => { throw new Error("Must not query another OS identity"); }), {});
  assert.throws(() => pgProcessIdentity(0, "darwin", lookup));
  assert.throws(() => pgProcessIdentity(0, "linux", () => ({ status: 1, stdout: "" })));
  assert.throws(() => pgProcessIdentity(0, "linux", () => ({ status: 0, stdout: "0" })));
  assert.throws(() => pgProcessIdentity(0, "linux", () => ({ status: 0, stdout: "bad" })));
  assert.throws(() => pgProcessIdentity(501, "win32", lookup));
});

test("valid complete receipt shape is accepted", () => {
  assert.deepEqual(validateVitestReport(completeReport(), suite, expectedFile, 0), {
    file: suite.file, total: 7, passed: 7, failed: 0, skipped: 0,
  });
});

const rejectedReports = [
  ["zero tests", (r) => { r.numTotalTests = 0; r.numPassedTests = 0; r.testResults = []; }],
  ["one skipped assertion", (r) => { r.numPendingTests = 1; r.testResults[0].assertionResults[0].status = "pending"; }],
  ["hidden pending assertion with misleading totals", (r) => { r.testResults[0].assertionResults[0].status = "pending"; }],
  ["todo assertion", (r) => { r.testResults[0].assertionResults[0].status = "todo"; }],
  ["cancelled assertion", (r) => { r.testResults[0].assertionResults[0].status = "cancelled"; }],
  ["failed assertion", (r) => { r.numFailedTests = 1; r.testResults[0].assertionResults[0].status = "failed"; }],
  ["setup or teardown failure despite passed assertions", (r) => { r.testResults[0].status = "failed"; }],
  ["missing assertion receipt", (r) => { r.testResults[0].assertionResults.pop(); }],
  ["wrong test file", (r) => { r.testResults[0].name = join(root, "packages/base/skills/skills.test.ts"); }],
  ["second file smuggled into report", (r) => { r.testResults.push(structuredClone(r.testResults[0])); }],
  ["error message hidden under passed status", (r) => { r.testResults[0].assertionResults[0].failureMessages.push("real failure"); }],
  ["unsuccessful aggregate", (r) => { r.success = false; }],
  ["incomplete passed total", (r) => { r.numPassedTests = 6; }],
];
for (const [label, mutate] of rejectedReports) test(`receipt rejects ${label}`, () => {
  const report = completeReport(); mutate(report);
  assert.throws(() => validateVitestReport(report, suite, expectedFile, 0));
});
for (const code of [1, 3, 124, null]) test(`receipt rejects child exit ${code} even with complete passed report`, () => {
  assert.throws(() => validateVitestReport(completeReport(), suite, expectedFile, code));
});
test("missing report never becomes success", () => assert.throws(() => validateVitestReport(undefined, suite, expectedFile, 0)));

test("actual fixture matches the six frozen modules and this repository's exact 42 historical migrations", async () => {
  const fixture = await verifyFixture(root, repo);
  assert.equal(fixture.modules.length, 6); assert.equal(fixture.pre0055_migrations.base.length, 42);
  assert.equal(fixture.pre0055_migrations.hotel.length, 42);
  assert(fixture.pre0055_migrations.base.some((row) => row.name === "0054_approval_queue_covering_indexes.sql"));
  assert(!fixture.pre0055_migrations.hotel.some((row) => row.name === "0054_approval_queue_covering_indexes.sql"));
  assert(fixture.pre0055_migrations.hotel.some((row) => row.name === "0015_event_id_tail.sql"));
});

for (const fault of ["frozen source drift", "old migration drift", "old migration missing", "0055 missing", "helper drift"]) {
  test(`fixture rejects ${fault} before any database creation`, async () => {
    const temporary = await mkdtemp("/tmp/wl-owned-contract-");
    try {
      await mkdir(join(temporary, "scripts/fixtures"), { recursive: true });
      await cp(join(root, "scripts/fixtures/skills-pre0055"), join(temporary, "scripts/fixtures/skills-pre0055"), { recursive: true });
      await mkdir(join(temporary, "packages/db"), { recursive: true });
      await cp(join(root, "packages/db/migrations"), join(temporary, "packages/db/migrations"), { recursive: true });
      if (fault === "frozen source drift") await writeFile(join(temporary, "scripts/fixtures/skills-pre0055/packages/base/skills/forge.ts"), "changed source");
      if (fault === "old migration drift") await writeFile(join(temporary, "packages/db/migrations/0001_init.sql"), "changed migration");
      if (fault === "old migration missing") await rm(join(temporary, "packages/db/migrations/0001_init.sql"));
      if (fault === "0055 missing") await rm(join(temporary, "packages/db/migrations/0055_private_skill_ownership.sql"));
      if (fault === "helper drift") await writeFile(join(temporary, "scripts/fixtures/skills-pre0055/setup.mts"), "changed helper");
      await assert.rejects(verifyFixture(temporary, repo));
    } finally { await rm(temporary, { recursive: true }); }
  });
}

test("actual subprocess failure is retained in a new immutable command receipt", async () => {
  const temporary = await mkdtemp("/tmp/wl-owned-command-");
  try {
    const record = { key: "synthetic-command-contract", report_directory: temporary, commands: [] };
    await assert.rejects(runCommand(record, "actual-failure", [process.execPath, "-e", "process.exit(7)"], root, childEnvironment(process.env, temporary)));
    assert.equal(record.commands[0].exit_code, 7); assert.equal(record.commands[0].timed_out, false);
    assert.equal(record.commands[0].log_sha256, hash(await readFile(record.commands[0].log)));
  } finally { await rm(temporary, { recursive: true }); }
});

test("actual hung child is terminated and cannot be counted as passed", async () => {
  const temporary = await mkdtemp("/tmp/wl-owned-command-");
  try {
    const record = { key: "synthetic-timeout-contract", report_directory: temporary, commands: [] };
    await assert.rejects(runCommand(record, "actual-timeout", [process.execPath, "-e", "setInterval(() => {}, 1000)"], root, childEnvironment(process.env, temporary), { timeout: 100 }));
    assert.equal(record.commands[0].exit_code, 124); assert.equal(record.commands[0].timed_out, true);
    assert.throws(() => process.kill(record.commands[0].pid, 0), { code: "ESRCH" });
  } finally { await rm(temporary, { recursive: true }); }
});

test("timeout terminates a descendant that ignores SIGTERM after its parent exits", async () => {
  const temporary = await mkdtemp("/tmp/wl-owned-command-");
  let descendant;
  try {
    const record = { key: "synthetic-descendant-contract", report_directory: temporary, commands: [] };
    const childScript = "process.on('SIGTERM', () => {}); console.log('owned-descendant:' + process.pid); setInterval(() => {}, 1000)";
    const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
    await assert.rejects(runCommand(record, "actual-descendant-timeout", [process.execPath, "-e", parentScript], root,
      childEnvironment(process.env, temporary), { timeout: 500 }));
    const log = await readFile(record.commands[0].log, "utf8");
    assert.match(log, /owned-descendant:\d+/);
    descendant = Number(log.match(/owned-descendant:(\d+)/)[1]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { process.kill(descendant, 0); }
      catch (error) { assert.equal(error.code, "ESRCH"); descendant = undefined; break; }
      await pause(20);
    }
    assert.equal(descendant, undefined, "Timed-out command left its descendant alive");
    assert.equal(record.commands[0].exit_code, 124);
    assert.equal(record.commands[0].timed_out, true);
  } finally {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(temporary, { recursive: true });
  }
});

test("CLI refuses existing evidence and preserves its exact bytes", async () => {
  const temporary = await mkdtemp("/tmp/wl-owned-existing-");
  try {
    const marker = join(temporary, "result.json"); await writeFile(marker, "preserved original receipt\n");
    const result = spawnSync(process.execPath, [join(root, "scripts/test-owned-pg.mjs"), "--repo", repo, "--report-dir", temporary], { encoding: "utf8", env: childEnvironment(process.env, temporary) });
    assert.equal(result.status, 1); assert.match(result.stderr, /Report directory must be new/);
    assert.equal(await readFile(marker, "utf8"), "preserved original receipt\n");
  } finally { await rm(temporary, { recursive: true }); }
});

test("CLI missing PG resources exits failed with zero suites and an explicit failure receipt", async () => {
  const temporary = await mkdtemp("/tmp/wl-owned-missing-");
  try {
    const report = join(temporary, "new-report");
    const result = spawnSync(process.execPath, [join(root, "scripts/test-owned-pg.mjs"), "--repo", repo, "--pg-bin", join(temporary, "absent-pg-tools"), "--report-dir", report], { encoding: "utf8", env: childEnvironment(process.env, temporary) });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(await readFile(join(report, "result.json"), "utf8"));
    assert.equal(receipt.result, "failed"); assert.deepEqual(receipt.suites, []);
    assert.match(receipt.error.message, /ENOENT/); assert.equal(receipt.temporary_removed, true);
  } finally { await rm(temporary, { recursive: true }); }
});
