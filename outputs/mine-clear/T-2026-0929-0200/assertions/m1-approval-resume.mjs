/**
 * M1/M2 断言：审批通过后线程是否自动续跑（base 闭环）
 *
 * 期望（产品口径 / RDAS outcome.mjs 注释口径）：审批通过后线程回到执行流，最终 completed 或进入下一关卡。
 * 观察点：decide 之后 60s 内 threads.status 与 biz_events 是否推进。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8899 node m1-approval-resume.mjs
 */
import pg from "pg";

const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const APP_URL = process.env.DATABASE_APP_URL;
const GW_URL = process.env.DATABASE_GATEWAY_URL;
const WORKSPACE = process.env.MCD_WORKSPACE ?? "ws-yunqi";
const TENANT = process.env.MCD_TENANT ?? "tenant-demo";
const WAIT_MS = Number(process.env.MCD_WAIT_MS ?? 60000);

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
if (!token) { console.log("✗ 登录失败"); process.exit(1); }

// 1) 派发（立即执行），走围栏 → 应挂起审批
const dispatch = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: "把周五主打款调价 5%（闭环断言）", runImmediately: true } });
const threadId = dispatch.data?.result?.data?.threadId;
console.log(`· threadId=${threadId} kind=${dispatch.data?.result?.data?.kind}`);

const gw = new pg.Client({ connectionString: GW_URL });
await gw.connect();
const countEvents = async () => {
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [TENANT, WORKSPACE]);
  const r = await gw.query("SELECT count(*)::int AS n FROM biz_events WHERE session_id=$1", [threadId]);
  await gw.query("COMMIT");
  return r.rows[0].n;
};
const threadStatus = async () => {
  const r = await query("/trpc/threads.get", { threadId }, token);
  return r.data?.result?.data?.status ?? r.data?.result?.data?.thread?.status ?? "?";
};

// 等挂起
let status = await threadStatus();
for (let i = 0; i < 20 && status !== "pending_review"; i += 1) { await new Promise((r) => setTimeout(r, 1000)); status = await threadStatus(); }
const eventsBefore = await countEvents();
console.log(`· 派发后状态=${status}（期望 pending_review）事件=${eventsBefore}`);

// 2) 找到本线程的待审批关卡
const queue = await query("/trpc/approvals.list", { status: "pending" }, token);
const rows = queue.data?.result?.data ?? [];
const ev = await query("/trpc/threads.events", { threadId }, token);
const own = new Set((ev.data?.result?.data ?? []).map((e) => e.event_id));
const timelineActions = (ev.data?.result?.data ?? []).map((e) => e.decision?.action);
console.log(`· 批准前线程时间线动作：${JSON.stringify(timelineActions)}`);
const target = rows.find((r) => own.has(r.event_id)) ?? null;

let verdict = "no-approval";
if (target) {
  const decided = await api("/trpc/approvals.decide", { method: "POST", token, body: { approvalId: target.approval_id, gesture: "approve" } });
  console.log(`· decide -> ${decided.status} ${JSON.stringify(decided.data?.result?.data ?? decided.data?.error?.message ?? "")}`);
  const deadline = Date.now() + WAIT_MS;
  let last = status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await threadStatus();
    if (s !== last) console.log(`· ${Math.round((WAIT_MS - (deadline - Date.now())) / 1000)}s 状态 ${last} → ${s}`);
    last = s;
    if (["completed", "failed", "paused", "cancelled"].includes(s)) break;
  }
  const eventsAfter = await countEvents();
  verdict = `status=${last} events=${eventsBefore}→${eventsAfter}`;
  console.log(`\n结论：审批通过后 ${WAIT_MS / 1000}s 内 → ${verdict}`);
  console.log(last === "pending_review"
    ? "✗ 线程停在 pending_review：审批通过未触发自动续跑（需人工再点推进）"
    : (last === "completed" ? "✓ 审批后自动续跑至 completed" : `△ 状态=${last}（继续观察）`));

  // MC-104：批准之后，人工决策必须出现在线程时间线里（approval.gesture 带 session_id）
  const evAfter = await query("/trpc/threads.events", { threadId }, token);
  const actionsAfter = (evAfter.data?.result?.data ?? []).map((e) => e.decision?.action);
  const gestureInTimeline = actionsAfter.includes("approval.gesture");
  console.log(`· 批准后线程时间线动作：${JSON.stringify(actionsAfter)}`);
  console.log(gestureInTimeline
    ? "✓ 人工决策已进入线程时间线（MC-104）"
    : "✗ 人工决策未进入线程时间线（MC-104：approval.gesture 缺 session_id）");
  if (!gestureInTimeline) verdict += "|mc104-failed";
}

await gw.end();
process.exit(verdict.startsWith("status=completed") ? 0 : 1);
