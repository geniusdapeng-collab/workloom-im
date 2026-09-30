/**
 * M1 assertion: is the "high-risk agent" guard (L3.5 / INV-4) actually reachable in the Quest path?
 *
 * desktop-agent declares high_risk: true + write tool desktop.gui.
 * Expected: its step approval must NOT be batch-approvable, and its write must require a per-action approval ref.
 * Usage: MCD_BASE=http://127.0.0.1:8899 node m1-highrisk-batch.mjs
 */
import pg from "pg";
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const APP_URL = process.env.DATABASE_APP_URL;
const TENANT = "tenant-demo";
const WS = process.env.MCD_WORKSPACE ?? "ws-yunqi";

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const query = (path, input, token) => api(`${path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`, { token });

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.result?.data?.token;
if (!token) { console.log("FAILED to login"); process.exit(1); }

const dispatch = await api("/trpc/threads.dispatch", {
  method: "POST", token,
  body: { title: "桌面写动作：更新门店价签（高危逐次授权断言）", presetKey: "desktop-agent", runImmediately: true },
});
const threadId = dispatch.data?.result?.data?.threadId;
console.log(`- dispatch: ${dispatch.status} threadId=${threadId} kind=${dispatch.data?.result?.data?.kind}`);

const statusOf = async () => (await query("/trpc/threads.get", { threadId }, token)).data?.result?.data?.status;
let st = await statusOf();
for (let i = 0; i < 20 && st !== "pending_review"; i += 1) { await new Promise((r) => setTimeout(r, 1000)); st = await statusOf(); }
console.log(`- thread status after dispatch: ${st}`);

const app = new pg.Client({ connectionString: APP_URL });
await app.connect();
await app.query("BEGIN");
await app.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [TENANT, WS]);
const rows = await app.query(
  `SELECT a.approval_id, a.tier, a.snapshot->>'high_risk' AS snap_high_risk, a.snapshot->>'irreversible' AS snap_irreversible,
          a.snapshot->>'tool' AS tool, a.status
     FROM approvals a JOIN biz_events e ON e.event_id = a.event_id
    WHERE a.workspace_id=$1 AND e.session_id=$2 ORDER BY a.created_at`,
  [WS, threadId],
);
await app.query("COMMIT");
const target = rows.rows[0];
console.log(`- approval row: ${JSON.stringify(target ?? null)}`);
if (!target) { console.log("no approval row created for this thread"); await app.end(); process.exit(1); }

const isHighRiskByGuard = target.tier === "l4_chairman" || target.snap_high_risk === "true" || target.snap_irreversible === "true";
console.log(`- isHighRiskApproval(guard view) = ${isHighRiskByGuard}（preset 声明 high_risk=true 的岗位）`);

const batch = await api("/trpc/approvals.batchApprove", { method: "POST", token, body: { approvalIds: [target.approval_id] } });
const data = batch.data?.result?.data ?? {};
console.log(`- batchApprove: ${batch.status} approved=${JSON.stringify(data.approved ?? [])} skipped=${JSON.stringify(data.skipped ?? [])}`);

const batchHeld = (data.skipped ?? []).some((s) => String(s.reason).includes("高危"));
console.log(batchHeld
  ? "OK: 高危岗位的关卡被批量放行守卫拦下"
  : "BUG: 高危岗位（desktop-agent, high_risk=true, write 工具）的关卡被批量放行 —— 守卫未生效");
await app.end();
process.exit(batchHeld ? 0 : 1);
