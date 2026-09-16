import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bootstrapDatabase, readDesktopDatabaseConfig } from "./desktop-bootstrap-db.mjs";

function fixtureEnvironment(expectedDataDirectory, port = "55432") {
  return {
    WORKLOOM_PG_PORT: port,
    WORKLOOM_EXPECTED_PGDATA: expectedDataDirectory,
    WORKLOOM_PG_ADMIN_PASSWORD: "test-only",
  };
}

function fakeClientFactory({ dataDirectory, port = "55432", databaseExists = true }) {
  const clients = [];
  class FakeClient {
    constructor(config) {
      this.config = config;
      this.queries = [];
      this.connected = false;
      this.ended = false;
      clients.push(this);
    }

    async connect() { this.connected = true; }

    async query(sql) {
      this.queries.push(sql);
      if (sql.includes("current_setting('data_directory')")) {
        return { rows: [{ data_directory: dataDirectory, port }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_database")) return { rows: databaseExists ? [{ exists: 1 }] : [], rowCount: databaseExists ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    }

    async end() { this.ended = true; }
  }
  return { Client: FakeClient, clients };
}

function writeQueries(clients) {
  return clients.flatMap((client) => client.queries).filter((sql) => /^\s*(?:ALTER|CREATE)\b/iu.test(sql));
}

describe("桌面数据库引导实例归属", () => {
  it("要求端口、PGDATA 与管理员凭据全部由启动器显式注入", () => {
    const complete = fixtureEnvironment("/tmp/test-only-pgdata");
    assert.equal(readDesktopDatabaseConfig(complete).port, 55432);
    for (const missing of Object.keys(complete)) {
      const env = { ...complete };
      delete env[missing];
      assert.throws(() => readDesktopDatabaseConfig(env), new RegExp(`${missing} 未设置`, "u"));
    }
    assert.throws(
      () => readDesktopDatabaseConfig({ ...complete, WORKLOOM_PG_PORT: "5432.5" }),
      /1 到 65535/u,
    );
  });

  it("非默认端口下每个数据库连接都先验证归属再执行写操作", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-owned-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData });
    try {
      await bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData) });
      assert.equal(fake.clients.length, 2);
      for (const client of fake.clients) {
        assert.equal(client.config.host, "127.0.0.1");
        assert.equal(client.config.port, 55432);
        assert.equal(client.connected, true);
        assert.equal(client.ended, true);
        assert.match(client.queries[0], /current_setting\('data_directory'\)/u);
      }
      assert.match(fake.clients[0].queries[1], /^ALTER USER/u);
      assert.match(fake.clients[1].queries[1], /^CREATE EXTENSION/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知 data_directory 时在第一条只读查询后失败且零写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-foreign-"));
    const expected = join(root, "expected");
    const foreign = join(root, "foreign");
    mkdirSync(expected);
    mkdirSync(foreign);
    const fake = fakeClientFactory({ dataDirectory: foreign });
    try {
      await assert.rejects(
        bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(expected) }),
        /data_directory 与当前产品 PGDATA 不一致/u,
      );
      assert.equal(fake.clients.length, 1);
      assert.equal(fake.clients[0].queries.length, 1);
      assert.deepEqual(writeQueries(fake.clients), []);
      assert.equal(fake.clients[0].ended, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("实例报告端口不符时失败且零写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-port-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData, port: "55433" });
    try {
      await assert.rejects(
        bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData) }),
        /实际端口 55433 与期望端口 55432 不一致/u,
      );
      assert.deepEqual(writeQueries(fake.clients), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
