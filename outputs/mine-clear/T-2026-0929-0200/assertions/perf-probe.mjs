/**
 * M4 性能探针：真实数据量下打最重的读接口（含数据放大前后对比 + EXPLAIN 证据）
 * 用法：node perf-probe.mjs http://127.0.0.1:8921 <repo>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { envOf, memberToken } from "./jwt.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8921";
const REPO = process.argv[3] ?? "/Users/mac/WorkLoom-fleet/.wt-mcd-c";
const OUT = "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m4/evidence";
mkdirSync(OUT, { recursive: true });

const WS = "ws-yunqi";
const env = envOf(REPO);
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const m = await db.query(
  `SELECT m.id, m.member_no, m.name, m.role, w.tenant_id
     FROM members m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id=$1 AND m.member_no='MEM-001'`, [WS],
);
const who = m.rows[0];
const token = memberToken(env.JWT_SECRET, {
  memberId: who.id, memberNo: who.member_no, name: who.name, role: who.role,
  tenantId: who.tenant_id, workspaceId: WS,
});

async function call(proc, input, method = "query") {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const started = performance.now();
  const res = method === "query"
    ? await fetch(`${BASE}/trpc/${proc}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers })
    : await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  const text = await res.text();
  return { ms: performance.now() - started, status: res.status, bytes: Buffer.byteLength(text) };
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    p50: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(s[s.length - 1].toFixed(1)),
    mean: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)),
  };
}

async function measure(label, targets, rounds = 40) {
  const out = {};
  for (const [name, fn] of Object.entries(targets)) {
    for (let i = 0; i < 5; i += 1) await fn(); // 预热
    const samples = [];
    let bytes = 0; let status = 0;
    for (let i = 0; i < rounds; i += 1) {
      const r = await fn();
      samples.push(r.ms); bytes = r.bytes; status = r.status;
    }
    out[name] = { ...stats(samples), bytes, status };
  }
  return out;
}

const targets = {
  "threads.list": () => call("threads.list"),
  "approvals.list(pending)": () => call("approvals.list", { status: "pending" }),
  "captain.theater": () => call("captain.theater"),
  "memory.list(query)": () => call("memory.list", { query: "调价 差评 偏好", limit: 50 }),
};

const before = await measure("放大前", targets);
console.log("── 放大前 ──"); for (const [k, v] of Object.entries(before)) console.log(`${k}: p50=${v.p50}ms p95=${v.p95}ms max=${v.max}ms bytes=${v.bytes} status=${v.status}`);

/* ---------- 数据放大：一座中型门店 1 年的审批与任务量 ---------- */
const N_APPROVALS = 20_000;
const N_THREADS = 3_000;
await db.query(
  `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier, created_at)
   SELECT 'apr-perf-'||g, $2, $1, 'E-PERF-'||g, 'inapp',
          CASE WHEN g % 5 = 0 THEN 'approved' ELSE 'pending' END,
          jsonb_build_object('expires_at', (now() + interval '3 day')::text, 'kind','perf'), 
          CASE WHEN g % 50 = 0 THEN 'l4_chairman' WHEN g % 7 = 0 THEN 'l3_fleet' ELSE 'l2_captain' END,
          now() - (g || ' minutes')::interval
     FROM generate_series(1, $3) AS g
   ON CONFLICT DO NOTHING`,
  [WS, who.tenant_id, N_APPROVALS],
);
await db.query(
  `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, created_at)
   SELECT 'T-PERF-'||g, $2, $1, '性能样本任务 '||g, 'quest',
          CASE WHEN g % 3 = 0 THEN 'completed' ELSE 'queued' END, 0, 3, 'MEM-001',
          now() - (g || ' minutes')::interval
     FROM generate_series(1, $3) AS g
   ON CONFLICT DO NOTHING`,
  [WS, who.tenant_id, N_THREADS],
);
const volume = await db.query(
  `SELECT (SELECT count(*) FROM approvals WHERE workspace_id=$1) AS approvals,
          (SELECT count(*) FROM threads WHERE workspace_id=$1) AS threads,
          (SELECT count(*) FROM biz_events WHERE workspace_id=$1) AS events`, [WS],
);
console.log(`\n放大后数据量：${JSON.stringify(volume.rows[0])}`);

const after = await measure("放大后", targets);
console.log("── 放大后 ──"); for (const [k, v] of Object.entries(after)) console.log(`${k}: p50=${v.p50}ms p95=${v.p95}ms max=${v.max}ms bytes=${v.bytes} status=${v.status}`);

/* ---------- 计划证据（谁在扫全表） ---------- */
const plans = {};
for (const [name, sql, params] of [
  ["threads.list SQL", `SELECT id,title,mode,status FROM threads WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50`, [WS]],
  ["approvals.list SQL", `SELECT a.*, e.payload FROM approvals a LEFT JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.event_id=a.event_id
                          WHERE a.workspace_id=$1 AND a.status=$2 ORDER BY a.created_at DESC LIMIT 50`, [WS, "pending"]],
]) {
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.workspace_id',$1,true)`, [WS]);
  const p = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  await db.query("ROLLBACK");
  plans[name] = p.rows.map((r) => r["QUERY PLAN"]);
}
console.log("\n── EXPLAIN ──"); for (const [k, v] of Object.entries(plans)) { console.log(`# ${k}`); v.forEach((l) => console.log(`  ${l}`)); }

const SLO_MS = 500;
const sloViolations = Object.entries(after).filter(([, v]) => v.p95 > SLO_MS).map(([k]) => k);
console.log(`\nSLO(${SLO_MS}ms p95) 违例：${sloViolations.length ? sloViolations.join(", ") : "无"}`);

writeFileSync(`${OUT}/perf-probe.json`, JSON.stringify({
  base: BASE, workspace: WS, before, after, volume: volume.rows[0], plans, sloMs: SLO_MS, sloViolations,
}, null, 2));
await db.end();
