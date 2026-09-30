#!/usr/bin/env node
/**
 * M3 联动排雷 · 探针 4：问答入口（B 端 ask 助手）的数据源覆盖
 * （MCD v1.0 模板④「所有问答入口验证回答的数据源覆盖应覆盖应覆盖的域」；任务卡 T-2026-0929-0200）
 *
 * 真机取证：threads.dispatch(mode=ask) 四个问题 → 答案原文 + 事件账本里记录的 facts/sources。
 * 覆盖面对照：审批（应有）/ 线程（应有）/ 知识库（应有）/ 服务台工单（应覆盖域，观察）/ 夜班（应覆盖域，观察）
 * 用法：node .../m3-linkage-ask.mjs [workspaceSlug]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.argv[2] ?? process.env.MCD_WS ?? "yunqi-hotel";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const GW_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway@127.0.0.1:5432/workloom";

const out = { probe: "m3-ask-coverage", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, assertions: [], answers: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const QUESTIONS = [
  { key: "approvals", text: "当前有多少待审批事项？" },
  { key: "threads", text: "现在有多少进行中的任务？" },
  { key: "kb", text: "住客问：房间里的毛巾多久更换一次？" },
  { key: "tickets", text: "今天服务台收到多少工单，处理进度怎么样？" },
  { key: "night", text: "昨晚夜班完成了哪些工作？" },
];

const gw = new pg.Client({ connectionString: GW_URL });
await gw.connect();
const workspaceId = WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi";

for (const qDef of QUESTIONS) {
  const d = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: qDef.text } });
  const data = unwrap(d);
  let answer = data?.answer ?? null;
  const threadId = data?.threadId;
  // ask 模式同步返回；若未返回答案则轮询一次线程事件
  if (!answer && threadId) {
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      const got = await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token });
      const th = unwrap(got);
      if (th && th.status && th.status !== "running" && th.status !== "queued") {
        const ev = await api(`/trpc/threads.events?input=${encodeURIComponent(JSON.stringify({ threadId, limit: 20 }))}`, { token });
        const events = unwrap(ev) ?? [];
        const ansEvent = events.find((e) => e?.decision?.action === "ask.answer");
        answer = ansEvent?.decision?.after?.answer ?? answer;
        break;
      }
    }
  }
  let ledger = null;
  if (threadId) {
    /**
     * 修复（2026-09-30，批 E）：biz_events 受 RLS 保护，此前探针未 set_config 就查询，
     * rows 恒空 → ledger_facts/ledger_sources 恒 null，卡片断言的「账本取数来源」永远看不到。
     * 现在在同一事务里先设置 app.workspace_id / app.tenant_id 再查。
     */
    await gw.query("BEGIN");
    await gw.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const r = await gw.query(
      `SELECT payload FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->'decision'->>'action'='ask.answer' ORDER BY seq DESC LIMIT 1`,
      [workspaceId, threadId]);
    await gw.query("COMMIT");
    ledger = r.rows[0]?.payload?.decision ?? null;
  }
  /**
   * 账本口径修正（2026-09-30，批 E）：ask.answer 事件把取数来源写在 `decision.basis[0]`
   * （形如「取数来源：biz_events、approvals、threads…」），此前探针读 `after.sources` 字段
   * 根本不存在 → ledger_sources 恒 null，卡片断言的"账本口径"无法被检验。
   */
  const basis = Array.isArray(ledger?.basis) ? ledger.basis.map(String) : [];
  const srcLine = basis.find((b) => b.startsWith("取数来源：")) ?? null;
  const sources = srcLine ? srcLine.replace(/^取数来源：/, "").split("、").map((s) => s.trim()).filter(Boolean) : [];
  const entry = {
    key: qDef.key, question: qDef.text, threadId, mode: data?.mode, via: data?.via, answer,
    ledger_basis: basis, ledger_facts: ledger?.after?.text ?? null, ledger_sources: sources, raw: data,
  };
  out.answers.push(entry);
  console.log(`\n[${qDef.key}] ${qDef.text}\n  A: ${String(answer ?? "(未取到答案)").slice(0, 260)}\n  sources: ${JSON.stringify(entry.ledger_sources ?? [])}`);
}
await gw.end().catch(() => {});

const byKey = Object.fromEntries(out.answers.map((a) => [a.key, a]));
const txt = (k) => String(byKey[k]?.answer ?? "");
check("审批类问题有事实依据（approvals 域覆盖）",
  /当前待审批[:：]\s*\d+\s*项/.test(txt("approvals")) && (byKey.approvals?.ledger_sources ?? []).some((s) => String(s).includes("approvals")),
  { answer: txt("approvals").slice(0, 160), sources: byKey.approvals?.ledger_sources });
check("线程类问题有事实依据（threads 域覆盖）",
  /进行中线程[:：]\s*\d+\s*条/.test(txt("threads")) && (byKey.threads?.ledger_sources ?? []).some((s) => String(s).includes("threads")),
  { answer: txt("threads").slice(0, 160), sources: byKey.threads?.ledger_sources });
check("知识库问题能引用库内知识（kb 域覆盖）", /毛巾|布草|更换|客房/.test(txt("kb")) || (byKey.kb?.ledger_sources ?? []).some((s) => String(s).includes("kb")),
  { sources: byKey.kb?.ledger_sources, answer: txt("kb").slice(0, 160) });
check("[数据源覆盖] 工单域进入事实面（c_tickets：真实未办结计数）",
  /服务台工单[:：]\s*\d+\s*条未办结/.test(txt("tickets")) && (byKey.tickets?.ledger_sources ?? []).some((s) => String(s).includes("c_tickets")),
  { sources: byKey.tickets?.ledger_sources, answer: txt("tickets").slice(0, 200) });
check("[数据源覆盖] 夜班域进入事实面（night_runs：班次/状态/候选数）",
  /最近夜班[:：]\s*\d{4}-\d{2}-\d{2}/.test(txt("night")) && (byKey.night?.ledger_sources ?? []).some((s) => String(s).includes("night_runs")),
  { sources: byKey.night?.ledger_sources, answer: txt("night").slice(0, 200) });
check("系统类问答不得被知识库 FAQ 挤占（approvals 取数来源无 kb:）",
  !/kb:/.test(String((byKey.approvals?.ledger_sources ?? []).join("|"))),
  { sources: byKey.approvals?.ledger_sources });
check("落款与实际取数来源一致（KB-only 答案不声称事件库数字）",
  !/知识库·/.test(txt("approvals")) || txt("approvals").includes("事件库"),
  { answer: txt("approvals").slice(0, 200) });

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `m3-ask-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\n联动探针 4：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
