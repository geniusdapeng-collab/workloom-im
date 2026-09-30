#!/usr/bin/env node
/**
 * 批 E 断言（MC-111）：B 端 ask 助手的数据源覆盖与取数口径。
 *
 * 修复前的断面（M3 真机实测 5 问 5 答）：知识库 FAQ 命中排在事实面之前吃满 120 字预算，
 * 「有多少待审批」答成维修报修 FAQ，落款仍写「以上数字均来自事件库实时取数」。
 * 现在断言：
 *  ① 系统类问题（审批/线程/工单/夜班）必须给出**当前真实数字**（与库内计数逐一对齐）；
 *  ② 知识库噪声不得挤占系统事实（approvals 问题的账本来源里不得出现 kb:）；
 *  ③ 落款与实际取数来源一致（KB-only 答案不得声称"数字来自事件库"）；
 *  ④ 账本 basis 记录完整取数来源（approvals/c_tickets/night_runs）。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8981 DATABASE_APP_URL=... node f1-ask-coverage.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence", "fix-e");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "yunqi-hotel";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app@127.0.0.1:5432/workloom";
const WS_ID = WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi";

const out = { probe: "f1-ask-coverage", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, assertions: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 320)}`}`);
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
const unwrap = (r) => r?.data?.result?.data;

async function withDb(fn) {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
    await client.query(
      "SELECT set_config('app.tenant_id', (SELECT tenant_id FROM workspaces WHERE id=$1), true)",
      [WS_ID],
    );
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const facts = await withDb(async (c) => ({
  approvals: (await c.query(`SELECT count(*)::int AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`, [WS_ID])).rows[0].c,
  threads: (await c.query(`SELECT count(*)::int AS c FROM threads WHERE workspace_id=$1 AND status IN ('queued','running','pending_review','paused')`, [WS_ID])).rows[0].c,
  tickets: (await c.query(`SELECT count(*)::int AS c FROM c_tickets WHERE workspace_id=$1 AND status IN ('created','assigned','processing')`, [WS_ID])).rows[0].c,
  night: (await c.query(`SELECT run_date, status FROM night_runs WHERE workspace_id=$1 ORDER BY run_date DESC LIMIT 1`, [WS_ID])).rows[0] ?? null,
}));
console.log("库内事实：", JSON.stringify(facts));

const QUESTIONS = [
  { key: "approvals", text: "当前有多少待审批事项？", expect: /当前待审批[:：]\s*\d+\s*项/ },
  { key: "threads", text: "现在有多少进行中的任务？", expect: /进行中线程[:：]\s*\d+\s*条/ },
  { key: "tickets", text: "今天服务台收到多少工单，处理进度怎么样？", expect: /服务台工单[:：]\s*\d+\s*条未办结/ },
  { key: "night", text: "昨晚夜班完成了哪些工作？", expect: /最近夜班[:：]\s*\d{4}-\d{2}-\d{2}/ },
  { key: "kb", text: "住客问：房间里的毛巾多久更换一次？", expect: /知识库·/ },
];

for (const qDef of QUESTIONS) {
  const d = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: qDef.text } });
  const data = unwrap(d);
  const answer = String(data?.answer ?? "");
  const threadId = data?.threadId;
  const basis = threadId
    ? (await withDb((c) => c.query(
        `SELECT payload->'decision'->'basis' AS basis, payload->'decision'->'after'->>'text' AS text
           FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->'decision'->>'action'='ask.answer'
           ORDER BY seq DESC LIMIT 1`,
        [WS_ID, threadId]))).rows[0]
    : null;
  out.answers = out.answers ?? [];
  out.answers.push({ key: qDef.key, question: qDef.text, threadId, mode: data?.mode, via: data?.via, answer, basis: basis?.basis ?? null });
  const sources = Array.isArray(basis?.basis) ? String(basis.basis[0] ?? "") : "";
  check(`${qDef.key}：答案给出被问域事实`, qDef.expect.test(answer), { answer });
  check(`${qDef.key}：账本 basis 记录取数来源`, basis?.basis?.length > 0, { basis: basis?.basis });
  if (qDef.key === "approvals") {
    check("approvals：答案数字与库内待审批计数一致",
      new RegExp(`当前待审批[:：]\\s*${facts.approvals}\\s*项`).test(answer), { expected: facts.approvals, answer });
    check("approvals：知识库噪声未进入取数来源（相关性下限生效）", !/kb:/.test(sources), { sources });
    check("approvals：不出现知识库事实", !answer.includes("知识库·"), { answer });
  }
  if (qDef.key === "threads") {
    /**
     * 期望值 = 快照计数 + 1：提问本身也是一个进行中的线程（本次 ask 线程尚未 completed），
     * 事实面把它计入是正确口径；只允许这两个取值，防止答案与库内计数脱节。
     */
    const allowed = [facts.threads, facts.threads + 1];
    const got = Number(/进行中线程[:：]\s*(\d+)\s*条/.exec(answer)?.[1] ?? NaN);
    check("threads：答案数字与库内进行中线程一致（含本次 ask 线程）",
      allowed.includes(got), { expected: allowed, got, answer });
  }
  if (qDef.key === "tickets") {
    check("tickets：答案数字与库内未办结工单一致",
      new RegExp(`服务台工单[:：]\\s*${facts.tickets}\\s*条未办结`).test(answer), { expected: facts.tickets, answer });
    check("tickets：账本来源含 c_tickets", /c_tickets/.test(sources), { sources });
  }
  if (qDef.key === "night") {
    check("night：答案引用最近班次日期", answer.includes(facts.night?.run_date ?? "____"), { expected: facts.night, answer });
    check("night：账本来源含 night_runs", /night_runs/.test(sources), { sources });
  }
  if (qDef.key === "kb") {
    check("kb：KB-only 答案不得声称『数字来自事件库实时取数』", !answer.includes("以上数字均来自事件库实时取数"), { answer });
  }
}

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `f1-ask-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\nf1 ask 覆盖：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
