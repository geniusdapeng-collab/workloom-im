/**
 * MC-103 专项探针（fix_b_fence）：
 *  ① 基线 when 改写默认被拒，且错误文案指向可设置的参数（allowWhenChange=true）；
 *  ② 被拒的提案不消耗 dry-run：同一条 dryRunId 在显式放行后可再次确认（修复前先确认后守卫，拒一次就再也确认不了）；
 *  ③ 显式放行 + 审批手势后规则真正生效（覆盖行 active，基线锚点行保持 active）。
 * 用法：MCD_BASE=http://127.0.0.1:8941 node when-retry-probe.mjs
 */
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8941";
const RULE_ID = process.env.MCD_RULE_ID ?? "R7";
const WHEN = process.env.MCD_WHEN ?? "true";

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

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.result?.data?.token;
if (!token) { console.log("FAILED to login"); process.exit(1); }

const rule = { ruleId: RULE_ID, name: `${RULE_ID} when 改写探针`, level: "block", objectTypes: ["order"], actions: ["order.reconcile"], when: WHEN };
const dry = await api("/trpc/fence.dryRun", { method: "POST", token, body: rule });
const dryRunId = dry.data?.result?.data?.dryRunId;
check("dry-run 生成", Boolean(dryRunId), `dryRunId=${dryRunId}`);

const blocked = await api("/trpc/fence.confirmDryRun", { method: "POST", token, body: { dryRunId, rule } });
const blockedMessage = String(blocked.data?.error?.message ?? "");
check("无放行位时 confirmDryRun 拒绝", blocked.status >= 400, `status=${blocked.status}`);
check("拒绝文案指向 allowWhenChange=true（参数可达）", blockedMessage.includes("allowWhenChange=true"), blockedMessage.slice(0, 120));

const retried = await api("/trpc/fence.confirmDryRun", {
  method: "POST", token, body: { dryRunId, rule, allowWhenChange: true },
});
const eventId = retried.data?.result?.data?.eventId;
check("同一条 dryRunId 显式放行后可再次确认（被拒不消耗 dry-run）", Boolean(eventId), `status=${retried.status} eventId=${eventId}`);

const queue = await query("/trpc/approvals.list", { status: "pending" }, token);
const target = (queue.data?.result?.data ?? []).find((r) => r.event_id === eventId);
check("提案进入审批队列", Boolean(target), `approvalId=${target?.approval_id}`);
if (target) {
  const decided = await api("/trpc/approvals.decide", { method: "POST", token, body: { approvalId: target.approval_id, gesture: "approve" } });
  check("审批通过", decided.status === 200, `status=${decided.status} ${decided.data?.error?.message ?? ""}`);
}

const rows = await query("/trpc/fence.rules", {}, token);
const mine = (rows.data?.result?.data ?? []).filter((r) => r.rule_id === RULE_ID);
console.log("fence.rules readback: " + mine.map((r) => `${r.id}/${r.version}/${r.level}/${r.status}`).join(" | "));
check("显式放行的 when 改写已生效（覆盖行 active 且非出厂版本）", mine.some((r) => r.status === "active" && r.version !== "hotel-baseline/v1"));
check("基线锚点行保持 active", mine.some((r) => r.status === "active" && r.is_baseline === true));

console.log(`\nverdict: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
