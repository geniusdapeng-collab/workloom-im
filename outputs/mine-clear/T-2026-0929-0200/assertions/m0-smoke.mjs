/**
 * M0 冒烟：健康检查 + 核心链路一条（意图路由 → 派遣 → 事件账本回读）
 * 用法：node m0-smoke.mjs
 * 依赖：DATABASE_APP_URL / DATABASE_GATEWAY_URL（读 .env 由调用方注入）
 */
import pg from "pg";

const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const APP_URL = process.env.DATABASE_APP_URL;
const GW_URL = process.env.DATABASE_GATEWAY_URL;

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const out = { base: BASE, steps: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

const health = await api("/health");
step("health", health.status === 200 && health.data?.ok === true, health.data);

const sys = await api("/trpc/system.health");
step("system.health db up", sys.data?.result?.data?.db === "up", sys.data?.result?.data);

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.result?.data?.token;
step("loginAs MEM-001（owner）", Boolean(token), { status: login.status, role: login.data?.result?.data?.member?.role });

// 1) 派发一条 Quest（调价 = 高风险对象，应走围栏）
const dispatch = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: "把周五主打款调价 5%（M0 冒烟）" } });
const threadId = dispatch.data?.result?.data?.threadId;
step("threads.dispatch 建档", Boolean(threadId), { kind: dispatch.data?.result?.data?.kind, threadId, status: dispatch.status });

// 2) 等待执行推进
let thread = null;
for (let i = 0; i < 30 && threadId; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const got = await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token });
  thread = got.data?.result?.data?.thread ?? got.data?.result?.data ?? null;
  const status = thread?.status ?? thread?.thread?.status;
  if (status && status !== "running" && status !== "queued") break;
}
const finalStatus = thread?.status ?? thread?.thread?.status ?? "(未取到)";
step("线程离开 running/queued", Boolean(finalStatus) && finalStatus !== "running" && finalStatus !== "queued", { finalStatus });

// 3) 事件账本回读（gateway 池）
const gw = new pg.Client({ connectionString: GW_URL });
await gw.connect();
const scopeTenant = "tenant-demo";
const scopeWorkspace = process.env.MCD_WORKSPACE ?? "ws-yunqi";
await gw.query("BEGIN");
await gw.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)", [scopeTenant, scopeWorkspace]);
const ev = await gw.query(
  `SELECT count(*)::int AS n,
          count(*) FILTER (WHERE payload->'decision'->>'action' IS NOT NULL)::int AS with_action,
          count(*) FILTER (WHERE payload->>'receipt' IS NOT NULL)::int AS with_receipt
     FROM biz_events WHERE session_id = $1 AND workspace_id = $2`,
  [threadId, scopeWorkspace],
);
step("五元事件落账", (ev.rows[0]?.n ?? 0) > 0, ev.rows[0]);

const perms = await gw.query(
  `SELECT count(*)::int AS n FROM information_schema.role_table_grants
    WHERE grantee='workloom_app' AND table_name='biz_events' AND privilege_type='INSERT'`,
);
step("A3 旁路直写防控：workloom_app 无 biz_events INSERT", perms.rows[0]?.n === 0, perms.rows[0]);

const chain = await gw.query(`SELECT count(*)::int AS n FROM biz_events WHERE hash IS NULL OR prev_hash IS NULL`);
step("哈希链字段无空值（全表）", chain.rows[0]?.n === 0, chain.rows[0]);

await gw.end();

const failed = out.steps.filter((s) => !s.ok);
console.log(`\nM0 冒烟：${out.steps.length - failed.length}/${out.steps.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
