/**
 * M6 phase-3 独立断言（MC-503 / 原 M6-F1）：落地向导写 business 必须保留出厂 price_bands，
 * 且向导后价带内调价仍走 R1 自动（completed、无 params_incomplete）。
 * 用法：M6_DB=... M6_BASE=http://127.0.0.1:8985 node assert-wizard-fixed.mjs
 */
import pg from "pg";

const BASE = process.env.M6_BASE ?? "http://127.0.0.1:8985";
const DB = process.env.M6_DB;
if (!DB) throw new Error("缺少 M6_DB");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed += 1;
};
const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: DB });
await db.connect();
const bandsOf = async () => (await db.query(`SELECT archive->'business'->'price_bands' AS b FROM profiles WHERE workspace_id='ws-yunqi'`)).rows[0]?.b ?? null;

const before = await bandsOf();
check("向导前出厂价带在位（4 档）", before && Object.keys(before).length === 4, JSON.stringify(before));

const login = await api("/trpc/auth.loginAs", { body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.result?.data?.token;
check("owner 登录", Boolean(token));

const cfg = await api("/trpc/onboarding.setupWorkspace", { token, body: { displayName: "云栖酒店（M6 phase3）", industry: "hotel", note: "M6 独立复验：向导合并语义" } });
check("workspace.configure 返回 200", cfg.status === 200, `status=${cfg.status}`);

const after = await bandsOf();
check("向导后 price_bands 仍为同样 4 档（合并语义）", after && JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));

const biz = await db.query(`SELECT archive->'business' AS b FROM profiles WHERE workspace_id='ws-yunqi'`);
const b = biz.rows[0]?.b ?? {};
check("向导字段已写入且与价带共存", b.name?.includes("M6 phase3") && b.price_bands !== undefined, JSON.stringify(Object.keys(b)));

// 行为面：向导后价带内调价仍应 R1 自动完成
const d = await api("/trpc/threads.dispatch", { token, body: { title: `把雅致大床房调价上调 3%（M6 phase3）`, runImmediately: true } });
const threadId = d.data?.result?.data?.threadId;
check("dispatch 建线程", Boolean(threadId), `threadId=${threadId}`);
let status = null;
for (let i = 0; i < 20; i += 1) {
  await sleep(2000);
  const t = await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token });
  status = t.data?.result?.data?.status ?? status;
  if (status && ["completed", "pending_review", "failed", "paused"].includes(status)) break;
}
check("向导后同目标线程 completed（R1 自动）", status === "completed", `status=${status}`);
const apr = await db.query(
  `SELECT a.approval_id, a.snapshot->>'params_incomplete' AS pi FROM approvals a
    JOIN biz_events e ON e.event_id = a.event_id
   WHERE a.workspace_id='ws-yunqi' AND e.session_id=$1`,
  [threadId],
);
check("本线程无 params_incomplete / 无待审关卡", apr.rows.length === 0 || apr.rows.every((r) => r.pi !== "true"), JSON.stringify(apr.rows));

await db.end();
console.log(failed === 0 ? "\nverdict: PASS" : `\nverdict: FAIL (${failed})`);
process.exit(failed ? 1 : 0);
