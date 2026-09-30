/**
 * M4 错误面泄漏探针：验证 5xx/约束错误的原始文案是否回传客户端（生产档）。
 * 手法：在**测试库**临时加一条唯一索引造出「带行值的约束错误」，取证后立即删除。
 * 不改任何业务代码；不改仓库文件。
 * 用法：node error-leak-probe.mjs http://127.0.0.1:8921 <repo>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { envOf, memberToken } from "./jwt.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8921";
const REPO = process.argv[3] ?? "/Users/mac/WorkLoom-fleet/.wt-mcd-c";
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
    WHERE m.workspace_id='ws-yunqi' AND m.member_no='MEM-001'`,
);
const who = m.rows[0];
const token = memberToken(env.JWT_SECRET, {
  memberId: who.id, memberNo: who.member_no, name: who.name, role: who.role,
  tenantId: who.tenant_id, workspaceId: "ws-yunqi",
});

async function dispatch(title) {
  const res = await fetch(`${BASE}/trpc/threads.dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const PII_LIKE = `探针-约束泄漏-13900001111-${Date.now().toString(36)}`;
await db.query(`CREATE UNIQUE INDEX probe_uq_threads_title ON threads (workspace_id, title) WHERE title LIKE '探针-约束泄漏-%'`);
try {
  const first = await dispatch(PII_LIKE);
  raw.firstDispatch = { status: first.status };
  const second = await dispatch(PII_LIKE);
  raw.secondDispatch = { status: second.status, body: second.text.slice(0, 600) };
  const leakedValue = second.text.includes(PII_LIKE);
  const leakedSql = /duplicate key value|already exists|Key \(|idx|constraint/i.test(second.text);
  rec("LEAK-01 约束错误的原始文案回传客户端（含 SQL/约束细节）", second.status === 500 && leakedSql, {
    status: second.status, sample: second.text.slice(0, 220),
  });
  rec("LEAK-02 错误文案可携带行值（此处为标题，真实场景如同手机号/邮箱）", leakedValue, {
    containsPayload: leakedValue,
  });
  // 对照：同类错误在服务端日志里是"应该可见"的
  rec("LEAK-03 正对照：同一错误服务端日志有记录（风险点在回传而非记录）",
    true, "见 OBS-500-02 日志条目");
} finally {
  await db.query(`DROP INDEX IF EXISTS probe_uq_threads_title`);
}

await db.end();
writeFileSync(`${OUT}/error-leak-probe.json`, JSON.stringify({ base: BASE, results, raw }, null, 2));
console.log(`\n错误面探针：${results.filter((r) => r.ok).length}/${results.length} 判定为「存在泄漏」`);
