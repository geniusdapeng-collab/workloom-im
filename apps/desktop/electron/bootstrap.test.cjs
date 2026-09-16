"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const {
  bootstrap,
  installPayloadAtomically,
  writeInstallCheckpoint,
  parseDesktopPort,
  assertPostmasterIdentity,
  ownedPostgresRunning,
  buildDesktopEnvironment,
} = require("./bootstrap.cjs");

function fixture(version, withCurrent = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-"));
  const sourceRoot = path.join(root, "payload");
  const supportDir = path.join(root, "support");
  for (const part of ["runtime", "node", "pg", "nats"]) {
    fs.mkdirSync(path.join(sourceRoot, part), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, part, "payload.txt"), `${part}-${version}`);
  }
  fs.writeFileSync(path.join(sourceRoot, "runtime", "VERSION"), version);
  fs.mkdirSync(supportDir, { recursive: true });
  if (withCurrent) {
    for (const part of ["runtime", "node", "pg", "nats"]) {
      fs.mkdirSync(path.join(supportDir, part), { recursive: true });
      fs.writeFileSync(path.join(supportDir, part, "current.txt"), `${part}-old`);
    }
    fs.writeFileSync(path.join(supportDir, "runtime", ".env"), "JWT_SECRET=keep-me\n");
    fs.writeFileSync(path.join(supportDir, "VERSION"), "1.0.0\n");
    fs.writeFileSync(path.join(supportDir, ".bootstrapped"), "done");
  }
  return { root, sourceRoot, supportDir };
}

function transientDirectories(supportDir) {
  return fs.readdirSync(supportDir).filter((name) => /^\.install-(?:staging|backup)-/.test(name));
}

describe("桌面载荷原子装配", () => {
  it("正式打包入口缺少载荷时在启动任何服务前失败关闭", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-payload-missing-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(resourcesDir, { recursive: true });
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "node")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "pg")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("正式打包入口不会把源码 dist-payload 双重嵌套误认作 Resources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-no-double-payload-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(path.join(resourcesDir, "dist-payload", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "PAYLOAD_VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "runtime", "VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload.tar.gz"), "not-a-release-resource\n");
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("完整暂存后换入；提交前可回滚，提交后清理临时目录", () => {
    const f = fixture("2.0.0");
    const tx = installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      previousEnv: Buffer.from("JWT_SECRET=keep-me\n"),
    });
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", ".env"), "utf8"), "JWT_SECRET=keep-me\n");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "2.0.0");
    assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrapped")), false);
    tx.commit();
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("换入第一项后故障会恢复旧版目录、版本和首航状态", () => {
    const f = fixture("2.0.0");
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-first-swap",
    }), /故障注入/);
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "current.txt"), "utf8"), "runtime-old");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "1.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, ".bootstrapped"), "utf8"), "done");
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("首装暂存失败不会留下半套运行时", () => {
    const f = fixture("2.0.0", false);
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-stage",
    }), /故障注入/);
    for (const part of ["runtime", "node", "pg", "nats"]) assert.equal(fs.existsSync(path.join(f.supportDir, part)), false);
    assert.equal(fs.existsSync(path.join(f.supportDir, "VERSION")), false);
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("安装阶段检查点以机器可读中文状态落盘", () => {
    const f = fixture("2.0.0", false);
    writeInstallCheckpoint(f.supportDir, {
      status: "running", phase: "database", detail: "正在准备数据库",
      recoverable: true, percent: 70, etaSeconds: 38,
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.supportDir, "install-state.json"), "utf8"));
    assert.equal(state.schemaVersion, "workloom.install-state/v1");
    assert.equal(state.phase, "database");
    assert.equal(state.recoverable, true);
    assert.equal(state.percent, 70);
    assert.equal(state.etaSeconds, 38);
  });

  it("启动页使用确定进度语义，不再显示循环假进度", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /aria-valuenow=/);
    assert.match(source, /进度按已完成的启动检查点更新/);
    assert.doesNotMatch(source, /animation:slide/);
  });

  it("源码主进程只复用已验活服务，正式安装包与渲染冒烟不能绕过载荷", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(app\.isPackaged\)[\s\S]*正式安装包禁止源码模式/u);
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(RENDER_SMOKE\)[\s\S]*源码模式禁止执行发布渲染冒烟/u);
    assert.match(source, /else \{[\s\S]*handle = await bootstrap\(\{[\s\S]*resourcesDir/u);
  });
});

describe("桌面 PostgreSQL 实例归属与端口契约", () => {
  it("严格拒绝空白、小数、非数字和越界端口", () => {
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, {}), 5432);
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: "55432" }), 55432);
    for (const value of ["", " 5432", "5432 ", "5432.5", "port", "0", "65536"]) {
      assert.throws(
        () => parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: value }),
        /1 到 65535/u,
      );
    }
  });

  it("只有 pg_ctl 确认运行且 postmaster 数据目录与端口同时匹配才允许复用", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-owner-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${pgData}\n1\n55432\n/tmp\n127.0.0.1\n`);
    const calls = [];
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData,
        expectedPort: 55432,
        runCommand(command, args) { calls.push({ command, args }); return { code: 0 }; },
      }), true);
      assert.deepEqual(calls, [{ command: "/runtime/pg_ctl", args: ["status", "-D", pgData] }]);
      assert.throws(() => assertPostmasterIdentity(pgData, 55433), /运行端口 55432/u);

      const foreign = path.join(root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${foreign}\n1\n55432\n/tmp\n127.0.0.1\n`);
      assert.throws(() => assertPostmasterIdentity(pgData, 55432), /数据目录不属于当前产品/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pg_ctl 未确认运行时不读取残留 PID，也不把端口监听者当作自有实例", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-stopped-"));
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData: path.join(root, "missing-pgdata"),
        expectedPort: 55432,
        runCommand() { return { code: 3 }; },
      }), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("托管环境只重写数据库与服务端口，保留其他用户配置", () => {
    const scheme = "postgres://";
    const original = [
      `DATABASE_URL=${scheme}postgres:test-only@localhost:5432/workloom`,
      "APP_DB_PASSWORD=test-only",
      "GATEWAY_DB_PASSWORD=test-only",
      `DATABASE_APP_URL=${scheme}workloom_app:test-only@localhost:5432/workloom`,
      `DATABASE_GATEWAY_URL=${scheme}workloom_gateway:test-only@localhost:5432/workloom`,
      "SERVER_PORT=8787",
      "WEB_PORT=5173",
      "LLM_MODEL=keep-user-choice",
      "",
    ].join("\n");
    const result = buildDesktopEnvironment(original, {
      pgPort: 55432,
      serverPort: 18787,
      webPort: 15173,
      adminPassword: "test-only",
      appPassword: "test-only",
      gatewayPassword: "test-only",
    });
    assert.match(result.text, /^LLM_MODEL=keep-user-choice$/mu);
    assert.match(result.text, /^SERVER_PORT=18787$/mu);
    assert.match(result.text, /^WEB_PORT=15173$/mu);
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const value = result.text.match(new RegExp(`^${key}=(.*)$`, "mu"))?.[1];
      assert.equal(new URL(value).hostname, "127.0.0.1");
      assert.equal(new URL(value).port, "55432");
    }
  });
});
