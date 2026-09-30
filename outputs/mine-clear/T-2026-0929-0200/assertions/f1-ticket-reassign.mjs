#!/usr/bin/env node
/**
 * 批 E 断言（MC-112）：B 端重复派单/改派语义（不得 5xx；同值幂等；跨部门改派留痕）。
 *
 * 修复前断面：C 端建单即自动 assigned（gateway 建单链路），B 端点「派单」触发
 * assertTransition('assigned','assigned') → ServiceHttpError(409) → tRPC 兜成 500
 * （实测日志：`service.tickets.assign → INTERNAL_SERVER_ERROR: 工单状态机非法迁移：assigned → assigned`）。
 * 现在：
 *  ① assigned → assigned 视为原地改派；同值幂等 no-op（不写 c_ticket_events / biz_events）；
 *  ② 变更 dept/assignee → 只更新这两列 + 一条 'assign' 事件（reassigned:true），状态保持不变;
 *  ③ done/closed 等非法迁移 → 409 CONFLICT 语义码（不再 500），不存在 → 404 NOT_FOUND。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8981 DATABASE_APP_URL=... node f1-ticket-reassign.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence", "fix-e");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "ai-pm-demo";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app@127.0.0.1:5432/workloom";
const WS_ID = WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi";
const MARK = `F1TK${Date.now()}`;

const out = { probe: "f1-ticket-reassign", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, mark: MARK, assertions: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 360)}`}`);
};
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
const q = (path, token, input) => api(`${path}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { token });
const unwrap = (r) => r?.data?.result?.data;
/** tRPC v11 HTTP 错误体：{error:{message,data:{code,httpStatus,path}}}（客户端形态为 error.json.*） */
const errInfo = (r) => {
  const err = r?.data?.error?.json ?? r?.data?.error ?? {};
  return {
    httpStatus: err?.data?.httpStatus ?? r.status,
    code: err?.data?.code ?? null,
    message: err?.message ?? null,
  };
};

async function eventCount(ticketId, action = "assign") {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
    const r = await client.query(
      `SELECT count(*)::int AS c FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 AND action=$3`,
      [WS_ID, ticketId, action],
    );
    await client.query("COMMIT");
    return r.rows[0].c;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const sess = await api("/c/session", { method: "POST", body: { channel: "h5", openid: `f1-ticket-${MARK}`, nickname: "F1 工单探针" } });
const cToken = sess.data?.token;
check("C 端会话建立", Boolean(cToken), { status: sess.status });

const created = await api("/c/tickets", {
  method: "POST", token: cToken,
  body: {
    kind: "repair", title: `F1 改派探针 ${MARK}`,
    payload: { note: "改派语义取证", severity: "low" },
    conversationId: `conv-${MARK}`, idempotencyKey: `f1-ticket-${MARK}`,
  },
});
const ticketId = created.data?.ticket?.id;
check("C 端建单成功（自动 assigned）", created.status === 200 && created.data?.ticket?.status === "assigned", { status: created.status, ticket: created.data?.ticket?.status });

const listed = unwrap(await q("/trpc/service.tickets.list", token, { }))?.tickets ?? [];
const mine = listed.find((t) => t.id === ticketId);
check("B 端工单台可见该单", Boolean(mine), { dept: mine?.dept, assignee: mine?.assignee, status: mine?.status });

const before = await eventCount(ticketId);
const same = await api("/trpc/service.tickets.assign", {
  method: "POST", token, body: { ticketId, dept: mine?.dept ?? undefined, assignee: mine?.assignee ?? undefined },
});
const afterSame = await eventCount(ticketId);
check("同值重复派单：200 + 幂等（无新 assign 事件）", same.status === 200 && afterSame === before,
  { status: same.status, before, after: afterSame, ticket: unwrap(same)?.ticket });

const changed = await api("/trpc/service.tickets.assign", {
  method: "POST", token, body: { ticketId, dept: "工程维修组", assignee: "MEM-002" },
});
const afterChanged = await eventCount(ticketId);
const t2 = unwrap(changed)?.ticket;
check("跨部门改派：200 + 现场改派留痕 + 状态不变",
  changed.status === 200 && afterChanged === before + 1 && t2?.dept === "工程维修组" && t2?.assignee === "MEM-002" && t2?.status === "assigned",
  { status: changed.status, events: afterChanged, ticket: t2 });

const timeline = unwrap(await q("/trpc/service.tickets.timeline", token, { ticketId }))?.timeline ?? [];
out.timeline = timeline;
check("时间线可见改派轨迹（reassigned 标记）", timeline.some((e) => e.action === "assign"), { actions: timeline.map((e) => `${e.actorType ?? e.actor_type}:${e.action}`) });

await api("/trpc/service.tickets.advance", { method: "POST", token, body: { ticketId, action: "start" } });
const done = await api("/trpc/service.tickets.complete", { method: "POST", token, body: { ticketId, result: "F1 改派探针完成" } });
check("工单推进 → 办结", unwrap(done)?.ticket?.status === "done", unwrap(done)?.ticket?.status);

const conflict = await api("/trpc/service.tickets.assign", { method: "POST", token, body: { ticketId, dept: "客服组" } });
const conflictInfo = errInfo(conflict);
check("已办结工单再派单：409 语义错误（不是 5xx）",
  conflictInfo.httpStatus === 409 && conflictInfo.code === "CONFLICT",
  conflictInfo);
check("已办结工单再派单：契约文案可判定（含『非法迁移』）",
  conflictInfo.httpStatus === 409 && /非法迁移/.test(conflictInfo.message ?? ""),
  conflictInfo);

const notFound = await api("/trpc/service.tickets.assign", { method: "POST", token, body: { ticketId: `tck-none-${MARK}`, dept: "客服组" } });
check("不存在工单派单：404 NOT_FOUND",
  errInfo(notFound).httpStatus === 404 && errInfo(notFound).code === "NOT_FOUND",
  errInfo(notFound));

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `f1-ticket-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\nf1 工单改派：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
