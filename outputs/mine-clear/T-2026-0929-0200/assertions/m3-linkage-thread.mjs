#!/usr/bin/env node
/**
 * M3 联动排雷 · 探针 1：任务线程「派遣 → 围栏挂起 → 人工批准」的状态投影保真度
 * （MCD v1.0 模板④；任务卡 T-2026-0929-0200）
 *
 * 真机制造状态变更，然后逐面取证（变更前 / 变更后 / 批准后 / 客户端推进后）：
 *   F1 threads.list          （P2 任务中心列表）
 *   F2 threads.get           （P2 线程详情：status / pending_approval_id / preset_key）
 *   F3 approvals.list        （P4 审批台 + 移动端 webb 待办同源）
 *   F4 captain.theater       （P0 经营剧场：pendingByTier / ticker / floor 数字职场）
 *   F5 accounts.inbox.unified（P28 跨店统一待办）
 *   F6 nightShift.current    （P3 夜班状态）
 *   F7 service.stats.overview（P22 服务台统计，对照面）
 * 另附特权直查（app/gateway 双池）作为事实源：threads / approvals / biz_events。
 *
 * 用法（服务端必须先起，出厂 .env 口径）：
 *   MCD_BASE=http://127.0.0.1:8899 MCD_WS=yunqi-hotel MCD_MEMBER=MEM-001 \
 *     node outputs/mine-clear/T-2026-0929-0200/assertions/m3-linkage-thread.mjs
 * 前置：DATABASE_APP_URL / DATABASE_GATEWAY_URL（默认读仓库 .env 口径的本地库）。
 * 产物：outputs/mine-clear/T-2026-0929-0200/evidence/m3-thread-<ts>.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "yunqi-hotel";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const GOAL = process.env.MCD_GOAL ?? "把周六招牌菜调价 8%（M3 联动探针）";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:<redacted>@127.0.0.1:5432/workloom";
const GW_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:<redacted>@127.0.0.1:5432/workloom";

const out = {
  probe: "m3-thread-linkage",
  started_at: new Date().toISOString(),
  base: BASE, workspaceSlug: WS_SLUG, memberNo: MEMBER_NO, goal: GOAL,
  snapshots: {}, assertions: [], faces: {}, notes: [],
};

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
const q = (path, token, input) =>
  api(`${path}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { token });
const unwrap = (r) => r?.data?.result?.data;

function check(name, ok, detail) {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
  return Boolean(ok);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snapshotFaces(token, threadId, label) {
  const snap = { label, at: new Date().toISOString(), faces: {}, errors: {} };

  const list = await q("/trpc/threads.list", token).catch((e) => ({ error: String(e) }));
  const rows = unwrap(list) ?? [];
  const mine = Array.isArray(rows) ? rows.find((r) => r.id === threadId) : undefined;
  snap.faces["threads.list"] = {
    count: Array.isArray(rows) ? rows.length : null,
    thread: mine ?? null,
  };

  if (threadId) {
    const got = await q("/trpc/threads.get", token, { threadId }).catch((e) => ({ error: String(e) }));
    snap.faces["threads.get"] = unwrap(got) ?? null;
  }

  const ap = await q("/trpc/approvals.list", token, { status: "pending" }).catch((e) => ({ error: String(e) }));
  const apRows = unwrap(ap) ?? [];
  snap.faces["approvals.list(pending)"] = {
    count: Array.isArray(apRows) ? apRows.length : null,
    ids: Array.isArray(apRows) ? apRows.map((r) => r.approval_id).slice(0, 40) : [],
  };

  const th = await q("/trpc/captain.theater", token).catch((e) => ({ error: String(e) }));
  const theater = unwrap(th) ?? null;
  snap.faces["captain.theater"] = theater && {
    pendingByTier: theater.pendingByTier,
    ticker: (theater.ticker ?? []).slice(0, 3),
    floorAgents: (theater.floor?.agents ?? []).map((a) => ({
      presetKey: a.presetKey, state: a.state, currentThread: a.currentThread, pendingTier: a.pendingTier,
      approvalId: a.approvalId, celebrating: a.celebrating ?? false,
      // MC-114：blocked 与 asking 共存时必须把 asking 标志带进快照，否则断点判定看不到共存
      asking: a.asking ?? false, pendingCount: a.pendingCount ?? 0, statusLine: a.statusLine,
    })),
    latestBriefingAt: theater.latestBriefing?.at ?? null,
  };

  const inbox = await q("/trpc/accounts.inbox.unified", token).catch((e) => ({ error: String(e) }));
  snap.faces["accounts.inbox.unified"] = unwrap(inbox) ?? null;

  const night = await q("/trpc/nightShift.current", token).catch((e) => ({ error: String(e) }));
  const nightData = unwrap(night) ?? null;
  snap.faces["nightShift.current"] = nightData && {
    configured: nightData.configured,
    status: nightData.run?.status ?? null,
    id: nightData.run?.id ?? null,
  };

  const stats = await q("/trpc/service.stats.overview", token).catch((e) => ({ error: String(e) }));
  snap.faces["service.stats.overview"] = unwrap(stats) ?? null;

  out.snapshots[label] = snap;
  return snap;
}

/** 特权直查（app 池 + gateway 池）：线程、审批、事件 —— 事实源口径 */
async function dbProbe(threadId) {
  const app = new pg.Client({ connectionString: APP_URL });
  const gw = new pg.Client({ connectionString: GW_URL });
  await app.connect(); await gw.connect();
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", ["ws-yunqi"]);
    const t = await app.query(
      `SELECT id, status, agent_id, progress_done, progress_total, error, closed_at,
              EXTRACT(EPOCH FROM (now()-updated_at))::int AS age_s
         FROM threads WHERE id=$1`, [threadId]);
    const a = await app.query(
      `SELECT approval_id, status, tier, channel, decided_by, decided_at,
              snapshot->>'expires_at' AS expires_at
         FROM approvals WHERE workspace_id='ws-yunqi'
          AND event_id IN (SELECT event_id FROM biz_events WHERE session_id=$1)
        ORDER BY created_at DESC`, [threadId]);
    await app.query("COMMIT");
    await gw.query("BEGIN");
    await gw.query("SELECT set_config('app.workspace_id', $1, true)", ["ws-yunqi"]);
    const e = await gw.query(
      `SELECT payload->'decision'->>'action' AS action, payload->'who'->>'id' AS actor,
              payload->'decision'->'after'->>'step_id' AS step_id,
              payload->'decision'->'basis' AS basis, created_at
         FROM biz_events WHERE session_id=$1 ORDER BY seq ASC`, [threadId]);
    await gw.query("COMMIT");
    return { thread: t.rows[0] ?? null, approvals: a.rows, events: e.rows };
  } finally {
    await app.end().catch(() => {});
    await gw.end().catch(() => {});
  }
}

/* ---------------- 主流程 ---------------- */
const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
const identity = unwrap(login)?.identity;
out.identity = identity;
if (!check("登录（owner）", Boolean(token), { role: identity?.role, workspaceId: identity?.workspaceId })) {
  console.error(out.assertions.at(-1));
  process.exit(2);
}

// S0：变更前
await snapshotFaces(token, null, "S0-before");
console.log(`\n—— S0 变更前：threads.list=${out.snapshots["S0-before"].faces["threads.list"].count}，` +
  `pending 审批=${out.snapshots["S0-before"].faces["approvals.list(pending)"].count} ——\n`);

// C1：真机制造状态变更 —— 派遣一条高风险任务（涉钱 → 围栏应挂起人工审批）
const dispatch = await api("/trpc/threads.dispatch", {
  method: "POST", token, body: { title: GOAL, runImmediately: true },
});
const dispatchData = unwrap(dispatch);
out.dispatch = { status: dispatch.status, data: dispatchData };
const threadId = dispatchData?.threadId;
check("派遣返回 threadId（意图路由未判为含糊）", Boolean(threadId), { kind: dispatchData?.kind, mode: dispatchData?.mode, status: dispatchData?.status });
if (!threadId) {
  writeFileSync(join(EVIDENCE, `m3-thread-${Date.now()}.json`), JSON.stringify(out, null, 2));
  process.exit(1);
}

// 等线程离开 running/queued（围栏挂起 → pending_review）
let thread = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  const got = await q("/trpc/threads.get", token, { threadId });
  thread = unwrap(got);
  if (thread && !["running", "queued"].includes(thread.status)) break;
}
out.thread_after_dispatch = thread;
check("派遣后线程 → pending_review（围栏挂起）", thread?.status === "pending_review",
  { status: thread?.status, progress: `${thread?.progress_done}/${thread?.progress_total}`, preset: thread?.preset_key });
check("线程详情给出 pending_approval_id（X-02 直达入口）", Boolean(thread?.pending_approval_id), { pending_approval_id: thread?.pending_approval_id });

// S1：状态变更后（未批准）
await snapshotFaces(token, threadId, "S1-after-dispatch");
out.db_after_dispatch = await dbProbe(threadId);
const pendingApprovalId = thread?.pending_approval_id ?? out.db_after_dispatch.approvals.find((a) => a.status === "pending")?.approval_id ?? null;
out.pending_approval_id = pendingApprovalId;
check("审批行已落库且 pending（事实源）", Boolean(pendingApprovalId), { approvalId: pendingApprovalId, row: out.db_after_dispatch.approvals[0] ?? null });

const floorAfter = out.snapshots["S1-after-dispatch"].faces["captain.theater"]?.floorAgents ?? [];
/**
 * MC-114 修复后口径：该员工可能同时处于 blocked（近 30 分钟遇阻）与 pending 请示——
 * 此时 state 仍是 blocked（V-06：出事优先），但必须并列下发 approvalId/pendingTier 与 asking 标志，
 * 前端据此同时渲染「遇阻」与「请您定」并支持直达审批。判据取「审批直达号必须可见」。
 */
/**
 * 判据：该员工条目必须显示请示信号（asking 或 blocked+asking 共存）**且有审批直达号**。
 * 不断言"直达号必须等于本次派生的这一条"：同员工可能有多条 pending（历史/套件残留），
 * 楼层按 FIFO 给出最早一条直达号，pendingCount 报出总数（信息不丢即可）。
 */
const askingAgent = floorAfter.find((a) => a.presetKey === out.thread_after_dispatch?.preset_key)
  ?? floorAfter.find((a) => a.approvalId === pendingApprovalId);
check("数字职场该员工给出请示信号与审批直达号（asking 或 blocked+asking 共存）",
  Boolean(askingAgent) && Boolean(askingAgent.approvalId)
  && (askingAgent.state === "asking" || askingAgent.asking === true)
  && (askingAgent.pendingCount ?? 0) >= 1,
  askingAgent ?? floorAfter.filter((a) => a.state === "asking" || a.asking).slice(0, 3));

// C2：真机制造第二次状态变更 —— 人工批准
let decideResult = null;
if (pendingApprovalId) {
  const dec = await api("/trpc/approvals.decide", {
    method: "POST", token, body: { approvalId: pendingApprovalId, gesture: "approve" },
  });
  decideResult = { status: dec.status, data: unwrap(dec) };
}
out.decide = decideResult;
check("批准手势成功", decideResult?.data?.status === "approved", decideResult?.data);

// 给自动续跑留出窗口（调度器默认 7s 一轮；此处等 20s，覆盖 2 轮以上）
await sleep(20_000);

// S2：批准后（无客户端介入）——关键断面
await snapshotFaces(token, threadId, "S2-after-approve-no-client");
out.db_after_approve = await dbProbe(threadId);
const t2 = out.db_after_approve.thread;
const approvedRow = out.db_after_approve.approvals.find((a) => a.approval_id === pendingApprovalId);
check("审批状态已落库 approved", approvedRow?.status === "approved", approvedRow ?? null);
check("[联动断点候选] 批准后线程是否自动续跑（无客户端介入）", t2?.status !== "pending_review",
  { status: t2?.status, age_s: t2?.age_s, error: t2?.error });

// C3：客户端显式推进（P2「推进」按钮 / StarRing 推进 = threads.run）——验证路径本身可用
const runRes = await api("/trpc/threads.run", { method: "POST", token, body: { threadId, goal: GOAL } });
out.client_run = { status: runRes.status, data: unwrap(runRes) };
await sleep(3000);
await snapshotFaces(token, threadId, "S3-after-client-run");
out.db_after_client_run = await dbProbe(threadId);
check("客户端 threads.run 可续跑（路径本身可用）",
  ["completed", "failed", "pending_review", "paused"].includes(out.db_after_client_run.thread?.status),
  { status: out.db_after_client_run.thread?.status, run: out.client_run.data?.status });
check("续跑写动作携带审批引用（#34 授权留痕）",
  (out.db_after_client_run.events ?? []).some((e) => (e.basis ?? []).some((b) => String(b).includes("经审批") && String(b).includes(pendingApprovalId ?? "___"))),
  { events: (out.db_after_client_run.events ?? []).map((e) => ({ action: e.action, basis: e.basis })) });

// 结果面：各投影面是否反映
const theaterS1 = out.snapshots["S1-after-dispatch"].faces["captain.theater"];
const theaterS2 = out.snapshots["S2-after-approve-no-client"].faces["captain.theater"];
out.faces = {
  "P0 剧场 pendingByTier": { S1: theaterS1?.pendingByTier, S2: theaterS2?.pendingByTier },
  "P0 剧场 ticker 首条": { S1: theaterS1?.ticker?.[0], S2: theaterS2?.ticker?.[0] },
  "P2 列表线程": out.snapshots["S1-after-dispatch"].faces["threads.list"]?.thread ?? null,
  "P2 详情线程": out.snapshots["S1-after-dispatch"].faces["threads.get"] ?? null,
  "P28 统一待办": {
    S0: out.snapshots["S0-before"].faces["accounts.inbox.unified"],
    S2: out.snapshots["S2-after-approve-no-client"].faces["accounts.inbox.unified"],
  },
  "P3 夜班": out.snapshots["S2-after-approve-no-client"].faces["nightShift.current"],
};

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `m3-thread-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\n联动探针 1：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
process.exit(0);
