#!/usr/bin/env node
/**
 * M3 联动排雷 · 探针 5：步骤级审批「驳回 → 线程终态」与线程时间线面
 * （MCD v1.0 模板④；任务卡 T-2026-0929-0200；对照 MC-101 的 approve 分支与 MC-104 的手势事件归属）
 *
 * 真机制造状态变更：dispatch(runImmediately) → pending_review → approvals.decide(reject)
 * 断言：
 *  1）线程被联动取消（GR-10 口径：cancelled + error 记原因）
 *  2）审批台该条转 rejected
 *  3）线程事件流（threads.events）能否看到这次人工决策（MC-104 口径：应看到但不能）
 * 用法：node .../m3-linkage-reject.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "yunqi-hotel";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const GOAL = `把周日招牌菜调价 3%（M3 驳回探针 ${Date.now()}）`;

const out = { probe: "m3-reject-linkage", started_at: new Date().toISOString(), base: BASE, goal: GOAL, assertions: [] };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const dispatch = await api("/trpc/threads.dispatch", { method: "POST", token, body: { title: GOAL, runImmediately: true } });
const threadId = unwrap(dispatch)?.threadId;
check("派遣建档", Boolean(threadId), { threadId, status: unwrap(dispatch)?.status });

let thread = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  thread = unwrap(await q("/trpc/threads.get", token, { threadId }));
  if (thread && !["running", "queued"].includes(thread.status)) break;
}
out.pending = thread;
check("挂起进审批（pending_review + 审批单号）", thread?.status === "pending_review" && Boolean(thread?.pending_approval_id),
  { status: thread?.status, approvalId: thread?.pending_approval_id });

const approvalId = thread?.pending_approval_id;
const rej = await api("/trpc/approvals.decide", {
  method: "POST", token,
  body: { approvalId, gesture: "reject", reasonEnum: "price.too_high", reasonText: "M3 联动探针：验证驳回联动" },
});
out.reject = { status: rej.status, data: unwrap(rej) };
check("驳回手势成功", unwrap(rej)?.status === "rejected", unwrap(rej));

await sleep(2000);
const after = unwrap(await q("/trpc/threads.get", token, { threadId }));
out.thread_after = after;
check("[联动] 驳回后线程转 cancelled（GR-10 终态联动）", after?.status === "cancelled", { status: after?.status });

const events = unwrap(await q("/trpc/threads.events", token, { threadId, limit: 50 })) ?? [];
out.thread_events = events.map((e) => e?.decision?.action ?? e?.action ?? "?");
check("[联动断点候选] 线程事件流包含本次人工决策（approval.gesture）",
  out.thread_events.includes("approval.gesture"), { actions: out.thread_events });

const settled = unwrap(await q("/trpc/threads.settledSince", token, { since: Date.now() - 10 * 60_000, limit: 10 })) ?? [];
check("[联动] 结算流水（X-08）能看到该 cancelled 线程", settled.some((t) => t.id === threadId), { ids: settled.map((t) => t.id) });

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `m3-reject-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\n联动探针 5：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
