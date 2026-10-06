/**
 * 断言脚本自带的私有 PostgreSQL 集群：只监听 Unix socket、只建非超级角色、
 * 库与 socket 都在 /tmp/wl-* 下，退出时停止并删除。任何共享库都不会被碰到。
 *
 * 用法：`withPrivatePg(async (urls) => { ... })`
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PG_BIN = process.env.PG_BIN ?? (existsSync("/usr/lib/postgresql/17/bin") ? "/usr/lib/postgresql/17/bin" : "pg_config");

function pgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (existsSync("/usr/lib/postgresql/17/bin/initdb")) return "/usr/lib/postgresql/17/bin";
  const out = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error("需要 PostgreSQL 17 工具；请设置 PG_BIN");
  return out.stdout.trim();
}

export interface PrivatePgUrls { databaseUrl: string; appUrl: string; gatewayUrl: string; socket: string; port: number; database: string }

/** 以非 root 的 postgres OS 账号运行集群工具（root 不能直接跑 initdb/postgres）。 */
function runAsPostgres(file: string, args: string[], cwd?: string): void {
  const opts = { stdio: ["ignore", "ignore", "pipe"] as const, cwd };
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    execFileSync("setpriv", ["--reuid=postgres", "--regid=postgres", "--clear-groups", "env", "NODE_OPTIONS=", file, ...args], opts);
  } else {
    execFileSync(file, args, opts);
  }
}

export async function withPrivatePg<T>(fn: (urls: PrivatePgUrls) => Promise<T>): Promise<T> {
  const bin = pgBin();
  const dir = mkdtempSync(join(tmpdir(), "wl-repair-proof-"));
  const socket = join(dir, "socket"); const data = join(dir, "data");
  const port = 59000 + Math.floor(Math.random() * 5000);
  mkdirSync(socket, { recursive: true });
  chmodSync(dir, 0o700); chmodSync(socket, 0o700);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    execFileSync("chown", ["-R", "postgres:postgres", dir]);
  }
  const started = { value: false };
  const stop = () => {
    if (!started.value) return;
    try { runAsPostgres(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "stop"]); } catch { /* 集群已停 */ }
  };
  try {
    runAsPostgres(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--encoding=UTF8", "--no-locale", "--auth-local=trust", "--auth-host=reject", "--no-instructions"]);
    runAsPostgres(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "postgres.log"), "-w", "-t", "30",
      "-o", `-p ${port} -c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700`, "start"]);
    started.value = true;
    const psql = (database: string, sql: string) => execFileSync(join(bin, "psql"),
      ["-h", socket, "-p", String(port), "-U", "postgres", "-d", database, "-tAc", sql], { encoding: "utf8" }).trim();
    psql("postgres", "CREATE ROLE workloom_app LOGIN NOSUPERUSER NOBYPASSRLS");
    psql("postgres", "CREATE ROLE workloom_gateway LOGIN NOSUPERUSER NOBYPASSRLS");
    psql("postgres", "CREATE DATABASE repair_probe");
    const database = "repair_probe";
    const url = (user: string) => {
      const u = new URL(`postgresql://${user}@localhost/${database}`);
      u.searchParams.set("host", socket); u.searchParams.set("port", String(port));
      return u.href;
    };
    const urls = { databaseUrl: url("postgres"), appUrl: url("workloom_app"), gatewayUrl: url("workloom_gateway"), socket, port, database };
    // 真实迁移（同一个脚本、同一账本），两次以证明幂等；不复制 schema、不跳过。
    const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    for (let round = 0; round < 2; round += 1) {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
        cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, DATABASE_URL: urls.databaseUrl, NODE_ENV: "test" },
      });
    }
    return await fn(urls);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
