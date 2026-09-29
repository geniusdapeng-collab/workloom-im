#!/usr/bin/env node
/**
 * 批 E 断言（MC-114）：数字职场「遇阻」与「请示待裁」必须共存（信息不丢、可直达）。
 *
 * 修复前断面（M3 真机实测）：pricing-agent 既有近 30 分钟 blocked 事件、又有 pending 审批时，
 * captain.theater.floor 该员工条目 state=blocked 且 pendingTier/approvalId=null——
 * 楼层上看不到「有单待裁」，审批直达号丢失（而 pendingByTier 里明明有这条审批）。
 * 现在：blocked 仍是主态（V-06：出事优先），但并列下发 pendingTier/approvalId + asking 标志，
 * statusLine 同时给出「遇阻 · 请示待裁」两个信号。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8981 node f1-floor-blocked-asking.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence", "fix-e");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "yunqi-hotel";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const GOAL = process.env.MCD_GOAL ?? `把周日招牌菜调价 8%（F1 楼层探针 ${Date.now()}）`;

const out = { probe: "f1-floor-blocked-asking", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, goal: GOAL, assertions: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 420)}`}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("登录（owner）", Boolean(token), unwrap(login)?.identity?.workspaceId);

const dispatch = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: GOAL, runImmediately: true } });
const threadId = unwrap(dispatch)?.threadId;
check("派遣高风险任务（调价 → 围栏挂起）", Boolean(threadId), { threadId, status: unwrap(dispatch)?.status });

let thread = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  thread = unwrap(await q("/trpc/threads.get", token, { threadId }));
  if (thread && !["running", "queued"].includes(thread.status)) break;
}
const approvalId = thread?.pending_approval_id ?? null;
const presetKey = thread?.preset_key ?? null;
out.thread = { id: threadId, status: thread?.status, presetKey, approvalId };
check("线程进入 pending_review 且带审批单号", thread?.status === "pending_review" && Boolean(approvalId), out.thread);

const theater = unwrap(await q("/trpc/captain.theater", token));
const agents = theater?.floor?.agents ?? [];
out.floor = agents.map((a) => ({ presetKey: a.presetKey, state: a.state, asking: a.asking ?? false, pendingTier: a.pendingTier, approvalId: a.approvalId, statusLine: a.statusLine }));
const entry = agents.find((a) => a.approvalId === approvalId) ?? agents.find((a) => a.presetKey === presetKey);
check("前置：该岗位处于 blocked（近 30 分钟遇阻）——MC-114 场景成立", entry?.state === "blocked", entry ?? agents.filter((a) => a.state === "blocked"));
/**
 * 楼层每员工只给一个直达号（同员工多条 pending 时取最早一条，FIFO），并用 pendingCount 报出总数；
 * 因此判据是「有直达号 + 待裁总数 ≥ 本次派生的这条」——既证明信息不丢，也不把"必须是这一条"写死。
 */
check("blocked 条目仍下发审批直达号（信息不丢）", Boolean(entry?.approvalId), { approvalId, entry });
check("blocked 条目报出待裁总数（pendingCount ≥ 1）", (entry?.pendingCount ?? 0) >= 1, { pendingCount: entry?.pendingCount });
check("blocked 条目下发审批分级 pendingTier", Boolean(entry?.pendingTier), { pendingTier: entry?.pendingTier });
check("blocked 条目带 asking 标志（前端可同时渲染请示入口）", entry?.asking === true, { asking: entry?.asking });
check("statusLine 并列「遇阻」与「请示待裁」两个信号",
  /遇阻/.test(entry?.statusLine ?? "") && /请示待裁/.test(entry?.statusLine ?? ""), { statusLine: entry?.statusLine });

/* 收尾：批准该审批 → 线程离开 pending_review（顺带回归 MC-101 自动续跑接线仍生效） */
const dec = await api("/trpc/approvals.decide", { method: "POST", token, body: { approvalId, gesture: "approve" } });
check("批准手势成功（收尾）", unwrap(dec)?.status === "approved", unwrap(dec));
let after = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  after = unwrap(await q("/trpc/threads.get", token, { threadId }));
  if (after && after.status !== "pending_review") break;
}
check("批准后线程自动续跑（MC-101 接线未被本批破坏）", after?.status !== "pending_review", { status: after?.status });

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `f1-floor-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\nf1 楼层共存：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
