#!/usr/bin/env node
/**
 * 批 E 断言（MC-113）：P28 统一待办（accounts.inbox.unified）对出厂演示工作区必须非空，
 * 且计数与库内事实一致（审批 + 未办结工单）。
 *
 * 修复前断面：种子只建 members 不建 accounts → `accountIdOf` 恒 undefined → groups: []
 * （M3 真机实测：演示成员调用返回空列表；P28 页面显示"暂无工作区成员关系"）。
 * 现在：种子为演示成员建账号并回填 account_id；端点补未办结工单计数（与 P22 工单台同口径）。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8981 DATABASE_APP_URL=... node f1-inbox-unified.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence", "fix-e");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@127.0.0.1:5432/workloom";
const MARK = `F1IN${Date.now()}`;

const out = { probe: "f1-inbox-unified", started_at: new Date().toISOString(), base: BASE, mark: MARK, assertions: [] };
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

async function dbCounts(wsId) {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
    const approvals = (await client.query(`SELECT count(*)::int AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`, [wsId])).rows[0].c;
    const tickets = (await client.query(`SELECT count(*)::int AS c FROM c_tickets WHERE workspace_id=$1 AND status IN ('created','assigned','processing')`, [wsId])).rows[0].c;
    await client.query("COMMIT");
    return { approvals, tickets };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function inbox(slug, memberNo = "MEM-001") {
  const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: slug, memberNo } });
  const token = unwrap(login)?.token;
  const r = unwrap(await q("/trpc/accounts.inbox.unified", token));
  return { token, groups: r?.groups ?? [] };
}

/* ---------- 演示工作区 A：ai-pm-demo（老板 MEM-001） ---------- */
const aipm = await inbox("ai-pm-demo");
check("演示成员登录（ai-pm-demo）", Boolean(aipm.token));
check("统一待办非空（修复前恒 groups:[]）", aipm.groups.length > 0, aipm.groups);
const gA = aipm.groups.find((g) => g.workspaceId === "ws-aipm-demo");
check("返回 ai-pm-demo 分组且字段齐备", Boolean(gA) && Boolean(gA.slug) && Boolean(gA.workspaceName) && Boolean(gA.role), gA);
const cA = await dbCounts("ws-aipm-demo");
check("pendingApprovals 与库内 pending 审批数一致", gA?.pendingApprovals === cA.approvals, { api: gA?.pendingApprovals, db: cA.approvals });
check("pendingTickets 与库内未办结工单数一致", gA?.pendingTickets === cA.tickets, { api: gA?.pendingTickets, db: cA.tickets });

/* ---------- 真机制造变更：新开一张 C 端工单 → 统一待办计数 +1 ---------- */
const sess = await api("/c/session", { method: "POST", body: { channel: "h5", openid: `f1-inbox-${MARK}`, nickname: "F1 统一待办探针" } });
const created = await api("/c/tickets", {
  method: "POST", token: sess.data?.token,
  body: {
    kind: "complaint", title: `F1 统一待办探针 ${MARK}`,
    payload: { note: "P28 计数联动取证", severity: "low" },
    conversationId: `conv-${MARK}`, idempotencyKey: `f1-inbox-${MARK}`,
  },
});
check("C 端新建工单成功", Boolean(created.data?.ticket?.id), created.data?.ticket?.id);
const after = await inbox("ai-pm-demo");
const gA2 = after.groups.find((g) => g.workspaceId === "ws-aipm-demo");
check("新工单即刻进入统一待办（+1）", gA2?.pendingTickets === (gA?.pendingTickets ?? 0) + 1,
  { before: gA?.pendingTickets, after: gA2?.pendingTickets });

/* ---------- 演示工作区 B：yunqi-hotel（王店长 MEM-001）——跨店隔离与自身计数 ---------- */
const hotel = await inbox("yunqi-hotel");
const gB = hotel.groups.find((g) => g.workspaceId === "ws-yunqi");
const cB = await dbCounts("ws-yunqi");
check("酒店演示成员看到自家分组且计数一致",
  Boolean(gB) && gB.pendingApprovals === cB.approvals && gB.pendingTickets === cB.tickets,
  { group: gB, db: cB });
check("跨店隔离：两个演示账号各自只看到自己的工作区",
  aipm.groups.every((g) => g.workspaceId === "ws-aipm-demo") && hotel.groups.every((g) => g.workspaceId === "ws-yunqi"),
  { aipm: aipm.groups.map((g) => g.workspaceId), hotel: hotel.groups.map((g) => g.workspaceId) });

/* ---------- 账号绑定事实：种子必须回填 members.account_id ---------- */
const bound = await (async () => {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    const rows = [];
    for (const wsId of ["ws-aipm-demo", "ws-yunqi"]) {
      // members 受 RLS 保护：每工作区必须在事务内 set_config 后读取（越权返回空而非 403）
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
      const r = await client.query(
        `SELECT workspace_id, count(*)::int AS total, count(account_id)::int AS bound
           FROM members WHERE workspace_id=$1 GROUP BY 1`,
        [wsId],
      );
      await client.query("COMMIT");
      if (r.rows[0]) rows.push(r.rows[0]);
    }
    return rows;
  } finally {
    await client.end().catch(() => undefined);
  }
})();
out.members = bound;
check("出厂种子成员全部挂账号（account_id 回填）",
  bound.length === 2 && bound.every((r) => r.bound === r.total && r.total >= 3), bound);

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `f1-inbox-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\nf1 统一待办：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
