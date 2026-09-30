/**
 * M2 动态排雷公共库（T-2026-0929-0200）
 *
 * 用途：给 m2-*.mjs 系列脚本提供 API 客户端 / 登录 / 证据落盘 / 数据库直查能力。
 * 设计纪律：脚本必须可在修复后原样复跑（红→绿信号），因此所有断言都落在
 * 「可观察的外部行为 + 数据库事实」上，不依赖脚本内部缓存。
 */
import fs from "node:fs";
import path from "node:path";

export const REPO = process.env.M2_REPO ?? "/Users/mac/WorkLoom-fleet/.wt-mcd-a";
export const BASE = process.env.M2_BASE ?? "http://127.0.0.1:8901";
export const ENV_FILE =
  process.env.M2_ENV_FILE ??
  "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/env-a";
export const OUT =
  process.env.M2_OUT ??
  "/Users/mac/WorkLoom-fleet/.wt-mcd-im/outputs/mine-clear/T-2026-0929-0200";
export const EVID = path.join(OUT, "evidence", "m2");
export const SFX = process.env.M2_SFX ?? `m2${Date.now().toString(36)}`;
export const WORKSPACE = "ws-yunqi";
export const TENANT = "tenant-demo";

fs.mkdirSync(EVID, { recursive: true });

function parseEnvFile(text) {
  const map = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return map;
}

export const ENV = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
export const APP_URL = ENV.DATABASE_APP_URL;
export const GW_URL = ENV.DATABASE_GATEWAY_URL;
export const SUPER_URL = ENV.DATABASE_URL;

export const pg = (await import(`${REPO}/node_modules/pg/lib/index.js`)).default;

/* ---------------- HTTP / tRPC ---------------- */

/** 调一条 tRPC：query 用 GET+input，mutation 用 POST+body。返回 {status, data, error, raw} */
export async function api(route, { method, input, body, token } = {}) {
  const m = method ?? (body !== undefined ? "POST" : "GET");
  let url = `${BASE}/trpc/${route}`;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (m === "GET" && input !== undefined) {
    url += `?input=${encodeURIComponent(JSON.stringify(input))}`;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method: m, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: res.status, data, error: data?.error ?? null, raw: text };
}

/** tRPC 成功结果直取 */
export function ok(res) {
  return res?.data?.result?.data;
}

/** tRPC 错误码（形如 METHOD_NOT_SUPPORTED / FORBIDDEN / BAD_REQUEST） */
export function errCode(res) {
  return res?.data?.error?.data?.code ?? res?.data?.error?.code ?? null;
}

export async function login(memberNo, workspaceSlug = "yunqi-hotel") {
  const res = await api("auth.loginAs", { body: { workspaceSlug, memberNo } });
  const d = ok(res);
  if (!d?.token) throw new Error(`loginAs ${memberNo} 失败：${res.status} ${res.raw.slice(0, 200)}`);
  return { token: d.token, identity: d.identity };
}

export async function loginAll() {
  const [owner, manager, readonly] = await Promise.all([
    login("MEM-001"),
    login("MEM-002"),
    login("MEM-003"),
  ]);
  return { owner, manager, readonly };
}

/* ---------------- 数据库直查 ---------------- */

export function superClient() {
  return new pg.Client({ connectionString: SUPER_URL });
}

export function gatewayClient() {
  return new pg.Client({ connectionString: GW_URL });
}

/** 超级用户直查（绕过 RLS，仅用于取证；越权类断言必须用 app/gateway 角色另测） */
export async function superQuery(sql, params = []) {
  const c = superClient();
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows;
  } finally {
    await c.end();
  }
}

/* ---------------- 取证 / 断言 ---------------- */

export function writeEvidence(name, data) {
  const file = path.join(EVID, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return file;
}

export function appendLog(name, line) {
  fs.appendFileSync(path.join(EVID, name), line + "\n");
}

/** 极简断言记录器：每条 check 都会写进报告与 JSON 证据 */
export function createReport(title) {
  const checks = [];
  const startedAt = new Date().toISOString();
  return {
    title,
    checks,
    note(name, detail) {
      checks.push({ name, ok: null, detail });
      console.log(`• ${name}${detail === undefined ? "" : ` :: ${short(detail)}`}`);
    },
    check(name, pass, detail) {
      checks.push({ name, ok: Boolean(pass), detail });
      console.log(`${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${short(detail)}`}`);
      return Boolean(pass);
    },
    finish(file) {
      const failed = checks.filter((c) => c.ok === false);
      const summary = {
        title,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        base: BASE,
        suffix: SFX,
        total: checks.length,
        passed: checks.filter((c) => c.ok === true).length,
        failed: failed.length,
        checks,
      };
      writeEvidence(file, summary);
      console.log(`\n${title}：${summary.total - summary.failed}/${summary.total} 通过（证据 ${path.join(EVID, file)}）`);
      return failed.length;
    },
  };
}

function short(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询某个断言直到成立或超时；返回 {ok, waitedMs, last} */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 1000 } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last?.ok) return { ok: true, waitedMs: Date.now() - t0, last };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, waitedMs: Date.now() - t0, last };
    await sleep(intervalMs);
  }
}

/** 线程详情（RLS 内可见） */
export async function threadGet(token, threadId) {
  return ok(await api("threads.get", { input: { threadId }, token }));
}

/** 线程事件流（投影） */
export async function threadEvents(token, threadId, limit = 200) {
  return ok(await api("threads.events", { input: { threadId, limit }, token }));
}

export async function approvalsList(token, status) {
  return ok(await api("approvals.list", { input: status ? { status } : {}, token }));
}
