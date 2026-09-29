/**
 * M4 可观测性探针：人为制造 5xx，检查①服务端日志②事件账本留痕③恢复后自愈
 * 手法：临时收回 workloom_app 对 approvals 的 SELECT（不改业务代码），随后原样恢复。
 * 用法：node observability-probe.mjs http://127.0.0.1:8921 <repo>
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { envOf, memberToken } from "./jwt.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8921";
const REPO = process.argv[3] ?? "/Users/mac/WorkLoom-fleet/.wt-mcd-c";
const LOG = process.argv[4] ?? "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m4/server-8921.log";
const OUT = "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m4/evidence";
mkdirSync(OUT, { recursive: true });

const env = envOf(REPO);
const results = [];
const raw = {};
const rec = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();

const m = await db.query(
  `SELECT m.id, m.member_no, m.name, m.role, w.tenant_id
     FROM members m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id='ws-aipm-demo' AND m.member_no='MEM-001'`,
);
const who = m.rows[0];
const token = memberToken(env.JWT_SECRET, {
  memberId: who.id, memberNo: who.member_no, name: who.name, role: who.role,
  tenantId: who.tenant_id, workspaceId: "ws-aipm-demo",
});

async function trpc(proc, { input, method = "query" } = {}) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const res = method === "query"
    ? await fetch(`${BASE}/trpc/${proc}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers })
    : await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

const logBefore = (() => { try { return readFileSync(LOG, "utf8").length; } catch { return 0; } })();
const eventsBefore = await db.query(`SELECT count(*)::int AS n FROM biz_events WHERE payload->'decision'->>'action'='system.error'`);

/* 1) 恢复能力前置：记录 approvals 现有授权（照原样恢复） */
const grants = await db.query(
  `SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_name='approvals' AND grantee='workloom_app' ORDER BY privilege_type`,
);
raw.grantsBefore = grants.rows.map((r) => r.privilege_type);

/* 2) 制造 5xx */
let induced = null;
try {
  await db.query(`REVOKE SELECT ON approvals FROM workloom_app`);
  induced = await trpc("approvals.list", { input: { status: "pending" } });
  raw.induced5xx = { status: induced.status, body: String(induced.text).slice(0, 300) };
  rec("OBS-500-01 依赖故障被转成 5xx（不吞错、不假成功）", induced.status === 500, {
    status: induced.status, body: String(induced.text).slice(0, 160),
  });
} finally {
  await db.query(`GRANT ${raw.grantsBefore.join(", ")} ON approvals TO workloom_app`);
}

/* 3) 服务端日志可见性 */
{
  const logAfter = readFileSync(LOG, "utf8").slice(logBefore);
  raw.logDelta = logAfter.slice(-1200);
  const hasLine = /\[trpc\][^\n]*approvals\.list[^\n]*INTERNAL_SERVER_ERROR/.test(logAfter);
  rec("OBS-500-02 5xx 在服务端日志有记录（含 path/code/ref）", hasLine, {
    sample: (logAfter.match(/\[trpc\][^\n]*/) ?? ["<none>"])[0].slice(0, 200),
  });
}

/* 4) 事件账本留痕（system.error，append-only 可审计） */
{
  await new Promise((r) => setTimeout(r, 400));
  const after = await db.query(
    `SELECT count(*)::int AS n FROM biz_events WHERE payload->'decision'->>'action'='system.error'`,
  );
  raw.systemErrorBefore = eventsBefore.rows[0]?.n;
  raw.systemErrorAfter = after.rows[0]?.n;
  rec("OBS-500-03 5xx 写入事件账本（system.error 计数增加）",
    after.rows[0]?.n > eventsBefore.rows[0]?.n,
    { before: eventsBefore.rows[0]?.n, after: after.rows[0]?.n });
  const sample = await db.query(
    `SELECT payload->'decision'->>'action' AS action, payload->'decision'->'after'->>'path' AS path,
            payload->'decision'->'after'->>'ref' AS ref, seq
       FROM biz_events WHERE payload->'decision'->>'action'='system.error'
      ORDER BY seq DESC LIMIT 1`,
  );
  raw.systemErrorSample = sample.rows[0];
}

/* 5) 恢复后自愈 */
{
  const ok = await trpc("approvals.list", { input: { status: "pending" } });
  rec("OBS-500-04 依赖恢复后接口自愈（无需重启）", ok.status === 200, { status: ok.status });
}

/* 6) 4xx 不写 system.error（对照组） */
{
  const before = await db.query(`SELECT count(*)::int AS n FROM biz_events WHERE payload->'decision'->>'action'='system.error'`);
  const bad = await trpc("threads.get", { input: { threadId: 123 } });
  await new Promise((r) => setTimeout(r, 300));
  const after = await db.query(`SELECT count(*)::int AS n FROM biz_events WHERE payload->'decision'->>'action'='system.error'`);
  raw.negativeControl = { status: bad.status, before: before.rows[0]?.n, after: after.rows[0]?.n };
  rec("OBS-NEG-01 负对照：参数错误(4xx)不写系统错误事件", bad.status === 400 && before.rows[0]?.n === after.rows[0]?.n, raw.negativeControl);
}

await db.end();
writeFileSync(`${OUT}/observability-probe.json`, JSON.stringify({ base: BASE, results, raw }, null, 2));
console.log(`\n可观测性探针：${results.filter((r) => r.ok).length}/${results.length} 通过`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
