#!/usr/bin/env node
/**
 * M3 联动排雷 · 探针 3：C 端工单「客户提交 → B 端处置 → 客户侧回看/通知」的跨端投影保真度
 * （MCD v1.0 模板④；任务卡 T-2026-0929-0200）
 *
 * 真机制造状态变更（/c/* 公开网关 + B 端 tRPC 同库不同面）：
 *   F1 C 端 /c/tickets（客户工单列表）
 *   F2 C 端 /c/notifications（推送箱）
 *   F3 B 端 service.tickets.list / timeline（P22 服务台）
 *   F4 B 端 service.stats.overview（服务台统计投影）
 *   F5 P28 accounts.inbox.unified（跨店统一待办的数据源覆盖）
 * 用法：node .../m3-linkage-ticket.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "ai-pm-demo";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const MARK = `M3TK${Date.now()}`;

const out = { probe: "m3-ticket-linkage", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, mark: MARK, assertions: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return Boolean(ok);
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

/* ---------- 登录与基线 ---------- */
const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const stats0 = unwrap(await q("/trpc/service.stats.overview", token));
const inbox0 = unwrap(await q("/trpc/accounts.inbox.unified", token));
out.before = { stats: stats0, inbox: inbox0 };

const sess = await api("/c/session", { method: "POST", body: { channel: "h5", openid: `m3-ticket-${MARK}`, nickname: "M3 工单探针" } });
const cToken = sess.data?.token;
check("C 端会话建立", Boolean(cToken), { status: sess.status, error: sess.data?.error });

/* ---------- 变更 1：C 端提交工单 ---------- */
const convId = `conv-tk-${MARK}`;
const created = await api("/c/tickets", {
  method: "POST", token: cToken,
  body: {
    kind: "complaint", title: `M3 探针工单 ${MARK}`,
    payload: { note: "排雷取证用，不是真实客诉", severity: "low" },
    conversationId: convId, idempotencyKey: `m3-ticket-${MARK}`,
  },
});
const ticket = created.data?.ticket;
out.created = { status: created.status, ticket: ticket ?? null, receipt: created.data?.receipt ?? null };
check("C 端提交工单成功", Boolean(ticket?.id), { status: created.status, ticketId: ticket?.id, error: created.data?.error });
const ticketId = ticket?.id;

const cList = await api("/c/tickets", { token: cToken });
check("客户侧工单列表可见（C 端投影）", (cList.data?.tickets ?? []).some((t) => t.id === ticketId), { count: cList.data?.tickets?.length });

const cNotif0 = await api("/c/notifications", { token: cToken });
const accepted = (cNotif0.data?.notifications ?? []).find((n) => n.payload?.ticketId === ticketId);
out.notifications_after_create = cNotif0.data?.notifications ?? [];
check("受理通知落入客户推送箱", Boolean(accepted), { count: cNotif0.data?.notifications?.length, kinds: (cNotif0.data?.notifications ?? []).map((n) => n.kind) });

/**
 * P28 统一待办（MC-113）：建单后必须立刻在建单工作区的分组里看到未办结工单计数。
 * 此前探针只在**办结之后**检查该计数（此时工单已 done，恒 0），既看不出断点也测不出联动；
 * 现在按"未办结时 +1、办结后回落"两段取证。
 */
const inboxOpen = unwrap(await q("/trpc/accounts.inbox.unified", token));
out.inbox_open = inboxOpen;
const groupOpen = (inboxOpen?.groups ?? []).find((g) => g.workspaceId === (WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi"))
  ?? (inboxOpen?.groups ?? [])[0];
check("[数据源覆盖] 统一待办在建单后纳入未办结工单（pendingTickets ≥ 1）",
  (groupOpen?.pendingTickets ?? 0) >= 1,
  { group: groupOpen, groups: inboxOpen?.groups ?? [] });

/* ---------- F3：B 端工单台面 ---------- */
const bList = unwrap(await q("/trpc/service.tickets.list", token))?.tickets ?? [];
const bTicket = bList.find((t) => t.id === ticketId) ?? null;
check("B 端工单台可见该工单（C→B 联动）", Boolean(bTicket), { status: bTicket?.status, dept: bTicket?.dept, count: bList.length });

const timeline0 = unwrap(await q("/trpc/service.tickets.timeline", token, { ticketId }))?.timeline ?? [];
check("B 端时间线包含客户提交事件", timeline0.some((e) => e.actorType === "c_user" || e.actor_type === "c_user"), { timeline: timeline0.map((e) => `${e.actorType ?? e.actor_type}:${e.action}`) });

/* ---------- 变更 2：B 端派单 → 开始 → 办结（回执与通知联动） ---------- */
const assign = await api("/trpc/service.tickets.assign", { method: "POST", token, body: { ticketId, dept: "客服组", assignee: "MEM-002" } });
out.assign = { status: assign.status, data: unwrap(assign) };
check("B 端派单成功", assign.status === 200, unwrap(assign)?.ticket?.assignee ?? unwrap(assign));

const advance = await api("/trpc/service.tickets.advance", { method: "POST", token, body: { ticketId, action: "start" } });
out.advance = { status: advance.status, data: unwrap(advance) };
check("B 端推进（start）成功", advance.status === 200, unwrap(advance)?.ticket?.status);

const complete = await api("/trpc/service.tickets.complete", { method: "POST", token, body: { ticketId, result: "已电话联系客户并完成处理（M3 探针）" } });
out.complete = { status: complete.status, data: unwrap(complete) };
check("B 端办结成功", unwrap(complete)?.ticket?.status === "done", unwrap(complete)?.ticket?.status);

const timeline1 = unwrap(await q("/trpc/service.tickets.timeline", token, { ticketId }))?.timeline ?? [];
out.timeline_after = timeline1;
check("时间线记录 B 端动作（staff 归属）", timeline1.some((e) => (e.actorType ?? e.actor_type) === "staff") && timeline1.length > timeline0.length,
  { actions: timeline1.map((e) => `${e.actorType ?? e.actor_type}:${e.action}`) });

/* ---------- F2：C 端回看（状态 + 通知） ---------- */
const cDetail = await api(`/c/tickets/${ticketId}`, { token: cToken });
out.c_detail = { status: cDetail.status, ticket: cDetail.data?.ticket ?? null, timeline: cDetail.data?.timeline ?? null };
check("客户侧工单详情状态已更新为 done", cDetail.data?.ticket?.status === "done",
  { status: cDetail.data?.ticket?.status, statusText: cDetail.data?.ticket?.statusText });
check("客户侧时间线可见 B 端处置轨迹", (cDetail.data?.timeline ?? []).some((e) => e.actorType === "staff"), { timeline: (cDetail.data?.timeline ?? []).map((e) => `${e.actorType}:${e.action}`) });

const cNotif1 = await api("/c/notifications", { token: cToken });
const completedNotif = (cNotif1.data?.notifications ?? []).find((n) => n.kind === "ticket.completed" && n.payload?.ticketId === ticketId);
out.notifications_after_complete = cNotif1.data?.notifications ?? [];
check("办结结果通知达到客户推送箱", Boolean(completedNotif), { kinds: (cNotif1.data?.notifications ?? []).map((n) => n.kind) });

/* ---------- F4/F5：统计面与统一待办面 ---------- */
const stats1 = unwrap(await q("/trpc/service.stats.overview", token));
out.after = { stats: stats1, inbox: unwrap(await q("/trpc/accounts.inbox.unified", token)) };
check("服务台统计今日工单数增加（统计投影）", (stats1?.ticketsToday ?? 0) > (stats0?.ticketsToday ?? 0),
  { before: stats0?.ticketsToday, after: stats1?.ticketsToday });
const groupClosed = (out.after.inbox?.groups ?? []).find((g) => g.workspaceId === groupOpen?.workspaceId);
check("[数据源覆盖] 办结后统一待办未办结计数回落（P28 与工单台同口径）",
  (groupClosed?.pendingTickets ?? 0) === (groupOpen?.pendingTickets ?? 0) - 1,
  { open: groupOpen?.pendingTickets, closed: groupClosed?.pendingTickets, groups: out.after.inbox?.groups ?? [] });

/* ---------- 负面对照：跨工作区读取（B 端不该看到其他工作区工单） ---------- */
const otherLogin = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const otherToken = unwrap(otherLogin)?.token;
const cross = unwrap(await q("/trpc/service.tickets.list", otherToken))?.tickets ?? [];
check("租户/工作区隔离：另一工作区看不到该工单（负面对照）", !cross.some((t) => t.id === ticketId), { count: cross.length });

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `m3-ticket-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\n联动探针 3：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
