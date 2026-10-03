"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const {
  installPayloadAtomically,
  runDesktopDatabaseBootstrap,
} = require("../apps/desktop/electron/bootstrap.cjs");

// These tests execute real Node child processes in disposable directories. The scripts
// mutate synthetic files to expose seed replay; they do not emulate a database or claim
// that the product's SQL seed/migrations have passed. The packaged PostgreSQL regression
// separately verifies the real customer archive, fences, event rows and credentials.
function fixture({ legacyCompleted = false, seedScripts = "scripts/seed-first.cjs,scripts/seed-second.cjs" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-seed-policy-中文 空格-"));
  const sourceRoot = path.join(root, "payload");
  const supportDir = path.join(root, "support");
  const runtimeDir = path.join(supportDir, "runtime");
  const historyFile = path.join(root, "history.jsonl");
  const customerFile = path.join(root, "synthetic-customer.txt");
  const failFile = path.join(root, "fail.txt");
  fs.mkdirSync(supportDir);
  for (const part of ["runtime", "node", "pg"]) {
    fs.mkdirSync(path.join(sourceRoot, part), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, part, "payload.txt"), `${part}-2.0.0\n`);
  }
  const scriptsDir = path.join(sourceRoot, "runtime", "scripts");
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(path.join(sourceRoot, "runtime", "VERSION"), "2.0.0\n");
  fs.writeFileSync(path.join(sourceRoot, "runtime", ".env.defaults"), `DESKTOP_SEED_SCRIPT=${seedScripts}\n`);
  // The production caller has generated .env before entering this database phase.
  fs.writeFileSync(path.join(sourceRoot, "runtime", ".env"), "# synthetic fixture environment\n");
  // A process runner is the only tsx seam in the fixture. It receives the same argv/cwd
  // as the packaged CLI and executes the selected fixture script; exit codes are real.
  fs.writeFileSync(path.join(sourceRoot, "runtime", "fixture-cli.cjs"), [
    '"use strict";',
    'const path = require("node:path");',
    'require(path.resolve(process.cwd(), process.argv.at(-1)));',
    "",
  ].join("\n"));
  for (const [filename, label, isSeed] of [
    ["migrate.ts", "migrate", false],
    ["seed-first.cjs", "seed-first", true],
    ["seed-second.cjs", "seed-second", true],
    ["seed-aipm.ts", "seed-default", true],
  ]) {
    fs.writeFileSync(path.join(scriptsDir, filename), [
      '"use strict";',
      'const fs = require("node:fs");',
      `const label = ${JSON.stringify(label)};`,
      'fs.appendFileSync(process.env.WORKLOOM_SEED_POLICY_HISTORY, JSON.stringify(label) + "\\n");',
      'if (fs.existsSync(process.env.WORKLOOM_SEED_POLICY_FAIL_FILE)',
      '    && fs.readFileSync(process.env.WORKLOOM_SEED_POLICY_FAIL_FILE, "utf8").trim() === label) {',
      '  console.error("fixture failure: " + label);',
      '  process.exit(26);',
      "}",
      ...(isSeed ? ['fs.writeFileSync(process.env.WORKLOOM_SEED_POLICY_CUSTOMER, "seeded by " + label);'] : []),
      "",
    ].join("\n"));
  }
  if (legacyCompleted) {
    for (const part of ["runtime", "node", "pg"]) {
      fs.mkdirSync(path.join(supportDir, part));
      fs.writeFileSync(path.join(supportDir, part, "old.txt"), `${part}-old\n`);
    }
    fs.writeFileSync(path.join(supportDir, "VERSION"), "1.0.0\n");
    fs.writeFileSync(path.join(supportDir, ".bootstrapped"), "done");
    fs.writeFileSync(path.join(runtimeDir, ".env"), "CUSTOMER_MODEL=preserved-choice\n");
    fs.writeFileSync(customerFile, "customer-owned archive and stricter forbidden rules");
  }
  const env = {
    ...process.env,
    WORKLOOM_SEED_POLICY_HISTORY: historyFile,
    WORKLOOM_SEED_POLICY_CUSTOMER: customerFile,
    WORKLOOM_SEED_POLICY_FAIL_FILE: failFile,
  };
  return {
    root, sourceRoot, supportDir, runtimeDir, customerFile, failFile,
    install(options = {}) {
      const previousEnvFile = path.join(runtimeDir, ".env");
      return installPayloadAtomically({
        sourceRoot, supportDir, payloadVer: "2.0.0",
        previousEnv: fs.existsSync(previousEnvFile) ? fs.readFileSync(previousEnvFile) : null,
        ...options,
      });
    },
    bootstrap(options = {}) {
      return runDesktopDatabaseBootstrap({
        supportDir, runtimeDir, nodeBin: process.execPath,
        tsxCli: path.join(runtimeDir, "fixture-cli.cjs"),
        env, ...options,
      });
    },
    history() {
      return fs.existsSync(historyFile)
        ? fs.readFileSync(historyFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    marker(name) { return path.join(supportDir, name); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function assertSuccessfulMarkers(f) {
  assert.equal(fs.readFileSync(f.marker(".bootstrapped"), "utf8").trim(), "done");
  assert.equal(fs.readFileSync(f.marker(".example-seeded"), "utf8").trim(), "done");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.marker(".example-seeded")).mode & 0o777, 0o600);
  }
}

function assertNoSuccessfulMarkers(f) {
  assert.equal(fs.existsSync(f.marker(".bootstrapped")), false);
  assert.equal(fs.existsSync(f.marker(".example-seeded")), false);
}

describe("桌面升级只迁移，示例种子完成一次", () => {
  it("旧客户 .bootstrapped 在载荷换入前转为独立成功哨兵，迁移后不重放种子", () => {
    const f = fixture({ legacyCompleted: true });
    try {
      const tx = f.install();
      assert.equal(fs.existsSync(f.marker(".bootstrapped")), false);
      assert.equal(fs.readFileSync(f.marker(".example-seeded"), "utf8").trim(), "done");
      tx.commit();
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer-owned archive and stricter forbidden rules");
      assert.equal(fs.readFileSync(path.join(f.runtimeDir, ".env"), "utf8"), "CUSTOMER_MODEL=preserved-choice\n");
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("旧客户升级迁移失败后，已经被删除的 .bootstrapped 不会使重试再次种子", () => {
    const f = fixture({ legacyCompleted: true });
    try {
      f.install().commit();
      fs.writeFileSync(f.failFile, "migrate");
      assert.throws(() => f.bootstrap(), /数据库迁移失败.*fixture failure: migrate/u);
      assert.equal(fs.existsSync(f.marker(".bootstrapped")), false);
      assert.equal(fs.existsSync(f.marker(".example-seeded")), true);
      fs.rmSync(f.failFile);
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "migrate"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer-owned archive and stricter forbidden rules");
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("载荷换入失败与回滚保留旧成功事实，再次升级只执行迁移", () => {
    const f = fixture({ legacyCompleted: true });
    try {
      assert.throws(() => f.install({ failAt: "after-first-swap" }), /安装故障注入/u);
      assert.equal(fs.readFileSync(f.marker(".bootstrapped"), "utf8"), "done");
      assert.equal(fs.existsSync(f.marker(".example-seeded")), true);
      assert.equal(fs.readFileSync(f.marker("VERSION"), "utf8").trim(), "1.0.0");
      f.install().commit();
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate"]);
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("同版本旧客户即使数据库认证引导清除迁移哨兵，历史种子成功仍然保留", () => {
    const f = fixture({ legacyCompleted: true });
    try {
      // Run an unchanged legacy runtime before the authentication layer invalidates its
      // migration flag. This exercises the restart path without a payload replacement.
      fs.cpSync(path.join(f.sourceRoot, "runtime"), f.runtimeDir, { recursive: true });
      f.bootstrap();
      assert.deepEqual(f.history(), []);
      assert.equal(fs.existsSync(f.marker(".example-seeded")), true);
      fs.rmSync(f.marker(".bootstrapped"), { force: true });
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer-owned archive and stricter forbidden rules");
    } finally { f.cleanup(); }
  });

  it("新客户多种子全部成功后才写成功哨兵，重启不执行迁移或种子", () => {
    const f = fixture();
    try {
      f.install().commit();
      assertNoSuccessfulMarkers(f);
      const phases = [];
      f.bootstrap({ status(message, progress) {
        phases.push(progress.phase);
        if (progress.phase === "example-seed") assert.equal(fs.existsSync(f.marker(".example-seeded")), false);
      } });
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second"]);
      assert.equal(phases.filter((phase) => phase === "example-seed").length, 2);
      assertSuccessfulMarkers(f);
      fs.writeFileSync(f.customerFile, "customer update after first launch");
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer update after first launch");
    } finally { f.cleanup(); }
  });

  it("第二个种子真实进程失败时不置成功哨兵，重试重新运行未完成的首启", () => {
    const f = fixture();
    try {
      f.install().commit();
      fs.writeFileSync(f.failFile, "seed-second");
      assert.throws(() => f.bootstrap(), /演示数据种子失败.*seed-second.*fixture failure: seed-second/u);
      assertNoSuccessfulMarkers(f);
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second"]);
      fs.rmSync(f.failFile);
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second", "migrate", "seed-first", "seed-second"]);
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("首装迁移失败不执行种子也不写成功哨兵，恢复后完整执行", () => {
    const f = fixture();
    try {
      f.install().commit();
      fs.writeFileSync(f.failFile, "migrate");
      assert.throws(() => f.bootstrap(), /数据库迁移失败/u);
      assert.deepEqual(f.history(), ["migrate"]);
      assertNoSuccessfulMarkers(f);
      fs.rmSync(f.failFile);
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "migrate", "seed-first", "seed-second"]);
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("新客户空配置和缺失种子均失败关闭；已完成客户升级不再依赖 seed 文件", () => {
    for (const seedScripts of ["", "   ", "scripts/missing.cjs"]) {
      const f = fixture({ seedScripts });
      try {
        f.install().commit();
        assert.throws(() => f.bootstrap(), /演示数据种子(?:配置为空|缺失)/u);
        assertNoSuccessfulMarkers(f);
      } finally { f.cleanup(); }
    }
    const old = fixture({ legacyCompleted: true, seedScripts: "scripts/missing.cjs" });
    try {
      old.install().commit();
      old.bootstrap();
      assert.deepEqual(old.history(), ["migrate"]);
      assertSuccessfulMarkers(old);
    } finally { old.cleanup(); }
  });

  it("没有 DESKTOP_SEED_SCRIPT 的新客户仍执行默认种子", () => {
    const f = fixture();
    try {
      f.install().commit();
      fs.writeFileSync(path.join(f.runtimeDir, ".env.defaults"), "# no product override\n");
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-default"]);
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("所有种子完成后启动回调失败，重试迁移仍不再重放已经成功的种子", () => {
    const f = fixture();
    try {
      f.install().commit();
      assert.throws(() => f.bootstrap({ status(message, progress) {
        if (progress.phase === "example-ready") throw new Error("fixture status callback failed");
      } }), /fixture status callback failed/u);
      assert.equal(fs.existsSync(f.marker(".example-seeded")), true);
      assert.equal(fs.existsSync(f.marker(".bootstrapped")), false);
      fs.writeFileSync(f.customerFile, "customer update after seed completed");
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second", "migrate"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer update after seed completed");
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("取消发生在第一个种子完成后时不写全部成功，重试正常完成", () => {
    const f = fixture();
    try {
      f.install().commit();
      assert.throws(() => f.bootstrap({ throwIfAborted() {
        if (f.history().includes("seed-first")) throw new Error("fixture startup cancelled");
      } }), /fixture startup cancelled/u);
      assert.deepEqual(f.history(), ["migrate", "seed-first"]);
      assertNoSuccessfulMarkers(f);
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-first", "migrate", "seed-first", "seed-second"]);
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("成功哨兵仅属于该产品 support 目录，另一个新产品照常首启", () => {
    const a = fixture({ legacyCompleted: true });
    const b = fixture();
    try {
      a.install().commit();
      b.install().commit();
      a.bootstrap();
      b.bootstrap();
      assert.deepEqual(a.history(), ["migrate"]);
      assert.deepEqual(b.history(), ["migrate", "seed-first", "seed-second"]);
      assertSuccessfulMarkers(a);
      assertSuccessfulMarkers(b);
    } finally { a.cleanup(); b.cleanup(); }
  });

  it("已成功首启客户再次升级仍执行新版迁移且保留客户修改", () => {
    const f = fixture();
    try {
      f.install().commit();
      f.bootstrap();
      fs.writeFileSync(f.customerFile, "customer update between versions");
      fs.writeFileSync(path.join(f.sourceRoot, "runtime", "VERSION"), "3.0.0\n");
      f.install({ payloadVer: "3.0.0" }).commit();
      f.bootstrap();
      assert.deepEqual(f.history(), ["migrate", "seed-first", "seed-second", "migrate"]);
      assert.equal(fs.readFileSync(f.customerFile, "utf8"), "customer update between versions");
      assertSuccessfulMarkers(f);
    } finally { f.cleanup(); }
  });

  it("成功哨兵损坏时失败关闭，不能把异常状态当成未初始化再次覆盖数据", () => {
    const f = fixture();
    try {
      f.install().commit();
      fs.writeFileSync(f.marker(".example-seeded"), "incomplete-state");
      assert.throws(() => f.bootstrap(), /示例种子成功状态损坏/u);
      assert.deepEqual(f.history(), []);
      assert.equal(fs.readFileSync(f.marker(".example-seeded"), "utf8"), "incomplete-state");
    } finally { f.cleanup(); }
  });

  it("生产主流程在数据库认证可能清除迁移哨兵前保存旧 seed 成功，并调用同一执行函数", () => {
    const source = fs.readFileSync(path.join(__dirname, "../apps/desktop/electron/bootstrap.cjs"), "utf8");
    const preserve = source.indexOf("preserveExampleSeedCompletion(supportDir);", source.indexOf("async function bootstrap(opts)"));
    const invalidate = source.indexOf("if (databaseStateRecord.created || !clusterExisted) fs.rmSync(bootFlag");
    const execution = source.indexOf("runDesktopDatabaseBootstrap({", source.indexOf("async function bootstrap(opts)"));
    assert.ok(preserve > 0 && preserve < invalidate && invalidate < execution);
    // The function tested with real fixture child processes must be the production path.
    assert.equal((source.match(/scripts\/migrate\.ts/gu) || []).length, 1);
  });
});
