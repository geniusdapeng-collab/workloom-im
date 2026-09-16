// desktop-bootstrap-db.mjs —— 桌面自包含包的数据库引导（Node 版，替代 psql/createdb）
// Windows 内嵌 PostgreSQL 不保证携带 psql/createdb/pg_isready，因此角色、建库和
// 扩展由载荷内 node + pg 驱动完成。连接目标必须由 Electron 引导器显式注入，且任何
// 写操作前必须证明端口上的实例确实使用当前产品的 PGDATA。
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} 未设置`);
  return value;
}

function parsePort(raw) {
  if (!/^\d{1,5}$/u.test(raw)) throw new Error("WORKLOOM_PG_PORT 必须是 1 到 65535 的十进制整数");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKLOOM_PG_PORT 必须是 1 到 65535 的十进制整数");
  }
  return port;
}

export function normalizeDataDirectory(directory, platform = process.platform) {
  let normalized;
  try { normalized = realpathSync.native(directory); } catch { normalized = resolve(directory); }
  normalized = normalized.normalize("NFC").replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

export function readDesktopDatabaseConfig(env = process.env) {
  return {
    host: "127.0.0.1",
    port: parsePort(requiredEnv(env, "WORKLOOM_PG_PORT")),
    user: "postgres",
    adminPassword: requiredEnv(env, "WORKLOOM_PG_ADMIN_PASSWORD"),
    expectedDataDirectory: requiredEnv(env, "WORKLOOM_EXPECTED_PGDATA"),
  };
}

export async function assertOwnedDatabase(client, config) {
  const result = await client.query(
    "SELECT current_setting('data_directory') AS data_directory, current_setting('port') AS port",
  );
  const row = result.rows?.[0];
  if (!row || normalizeDataDirectory(String(row.data_directory ?? ""))
      !== normalizeDataDirectory(config.expectedDataDirectory)) {
    throw new Error("数据库实例归属校验失败：data_directory 与当前产品 PGDATA 不一致");
  }
  if (Number(row.port) !== config.port) {
    throw new Error(`数据库实例归属校验失败：实际端口 ${String(row.port)} 与期望端口 ${config.port} 不一致`);
  }
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function bootstrapDatabase({ Client, env = process.env }) {
  if (typeof Client !== "function") throw new Error("pg Client 不可用");
  const config = readDesktopDatabaseConfig(env);
  const connection = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.adminPassword,
    connectionTimeoutMillis: 10_000,
  };

  const admin = new Client({ ...connection, database: "postgres" });
  try {
    await admin.connect();
    await assertOwnedDatabase(admin, config);
    await admin.query(`ALTER USER postgres PASSWORD ${sqlLiteral(config.adminPassword)}`);
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'workloom'");
    if (result.rowCount === 0) {
      await admin.query("CREATE DATABASE workloom");
      console.log("✓ database workloom created");
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const database = new Client({ ...connection, database: "workloom" });
  try {
    await database.connect();
    await assertOwnedDatabase(database, config);
    await database.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await database.end().catch(() => undefined);
  }
  console.log("✓ vector extension ready");
  console.log("bootstrap-db ok");
}

async function main() {
  const runtime = requiredEnv(process.env, "WORKLOOM_RUNTIME");
  const require = createRequire(`${runtime}/scripts/`);
  const { Client } = require("pg");
  await bootstrapDatabase({ Client });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bootstrap-db 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
