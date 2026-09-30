/**
 * M1 assertion: can the fence-rule tightening path be used more than once for the same rule_id?
 * Flow: fence.dryRun -> fence.confirmDryRun -> approvals.decide(approve) -> fence.rules readback
 * Expectation: every proposal lands a rule row and takes effect after approval.
 * Usage: MCD_BASE=http://127.0.0.1:8899 node m1-fence-rule-change.mjs
 */
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const RULE_ID = process.env.MCD_RULE_ID ?? "R7";
const WHEN = process.env.MCD_WHEN ?? "params.guarantee_anomaly != true";
const LEVEL1 = process.env.MCD_LEVEL1 ?? "review";
const LEVEL2 = process.env.MCD_LEVEL2 ?? "block";
const LEVEL3 = process.env.MCD_LEVEL3 ?? "auto";
// MC-103：基线 when 改写的显式放行位。不带 MCD_ALLOW_WHEN=1 时提案必须 400 且文案指向该参数；
// 带 1 时（dry-run 回放 + 人工确认后）允许改写 when，随后由审批手势决定是否生效。
const ALLOW_WHEN = process.env.MCD_ALLOW_WHEN === "1";
const confirmBody = (dryRunId, rule) => ({ dryRunId, rule, ...(ALLOW_WHEN ? { allowWhenChange: true } : {}) });

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
const rulesOf = (rows, ruleId) => rows.filter((r) => r.rule_id === ruleId);

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.result?.data?.token;
if (!token) { console.log("FAILED to login"); process.exit(1); }

async function attempt(level, label) {
  console.log(`\n=== attempt ${label}: ${RULE_ID} -> level=${level}`);
  const rule = { ruleId: RULE_ID, name: `${RULE_ID} tighten ${label}`, level, objectTypes: ["order"], actions: ["order.reconcile"], when: WHEN };
  const dry = await api("/trpc/fence.dryRun", { method: "POST", token, body: rule });
  const dryRunId = dry.data?.result?.data?.dryRunId;
  console.log(`- dryRun: ${dry.status} dryRunId=${dryRunId}`);
  if (!dryRunId) { console.log(JSON.stringify(dry.data).slice(0, 300)); return { ok: false, stage: "dryRun" }; }

  const confirm = await api("/trpc/fence.confirmDryRun", { method: "POST", token, body: confirmBody(dryRunId, rule) });
  const eventId = confirm.data?.result?.data?.eventId;
  console.log(`- confirmDryRun: ${confirm.status} eventId=${eventId}`);
  if (!eventId) {
    const message = confirm.data?.error?.message ?? JSON.stringify(confirm.data);
    console.log(`- confirmDryRun 未受理：${String(message).slice(0, 360)}`);
    return { ok: false, stage: "confirm", error: String(message) };
  }

  const queue = await query("/trpc/approvals.list", { status: "pending" }, token);
  const target = (queue.data?.result?.data ?? []).find((r) => r.event_id === eventId);
  if (!target) { console.log("no pending approval found for the proposal"); return { ok: false, stage: "queue" }; }

  const decided = await api("/trpc/approvals.decide", { method: "POST", token, body: { approvalId: target.approval_id, gesture: "approve" } });
  const err = decided.data?.error?.message;
  console.log(`- decide: ${decided.status}${err ? ` ERROR=${err}` : ` status=${decided.data?.result?.data?.status}`}`);

  const rows = await query("/trpc/fence.rules", {}, token);
  const mine = rulesOf(rows.data?.result?.data ?? [], RULE_ID);
  console.log("- fence.rules readback: " + mine.map((r) => `${r.id}/${r.version}/${r.level}/${r.status}`).join(" | "));
  return { ok: decided.status === 200, stage: "decide", decidedStatus: decided.status, error: err, rows: mine.map((r) => ({ id: r.id, version: r.version, level: r.level, status: r.status })) };
}

const first = await attempt(LEVEL1, 1);
const second = await attempt(LEVEL2, 2);

// 第三段：放宽提案必须被基线守卫拒绝（首次自定义后锚点不得丢失）
const loosenRule = { ruleId: RULE_ID, name: `${RULE_ID} loosen`, level: LEVEL3, objectTypes: ["order"], actions: ["order.reconcile"], when: WHEN };
const dry = await api("/trpc/fence.dryRun", { method: "POST", token, body: loosenRule });
const loosenDryRunId = dry.data?.result?.data?.dryRunId ?? null;
const loosenConfirm = loosenDryRunId
  ? await api("/trpc/fence.confirmDryRun", { method: "POST", token, body: confirmBody(loosenDryRunId, loosenRule) })
  : { status: 0, data: {} };
const loosenRejected = loosenConfirm.status >= 400;
console.log(`\n=== 第 3 次：放宽提案（level=${LEVEL3}）→ confirmDryRun ${loosenConfirm.status}${loosenRejected ? "（已拒绝，符合『只可加严』）" : "（未拒绝：基线锚点已丢失）"}`);

console.log("\n=== verdict");
console.log(`attempt1: ${first.ok ? "OK (approved+applied)" : `FAILED at ${first.stage}`}`);
console.log(`attempt2: ${second.ok ? "OK (approved+applied)" : `FAILED at ${second.stage}${second.error ? ` (${second.error})` : ""}`}`);
console.log(`attempt3 (loosen): ${loosenRejected ? "OK (rejected)" : "FAILED (guard let it through)"}`);
console.log(`attempt2 readback: ${JSON.stringify(second.rows ?? [])}`);
const appliedSecond = (second.rows ?? []).some((r) => r.level === LEVEL2 && r.status === "active");
console.log(`attempt2 生效校验：${appliedSecond ? "OK" : "FAILED（回读 level 与提案不一致）"}`);
process.exit(first.ok && second.ok && appliedSecond && loosenRejected ? 0 : 1);
