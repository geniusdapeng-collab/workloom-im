/**
 * M1 assertion (MC-106): 高危写动作的"逐次授权"是否一次性
 *
 * 场景：审批行 status=approved 且 snapshot 未绑定 object/action（工艺上可由 captain/skill-ops 等
 * 非步骤级路径产生）。同一 approvalRef 被两次高危写动作引用。
 * 期望：第二次被拒（逐次授权 = 一次审批放行一次动作），或系统显式记录"通用授权"例外。
 * 现状：两次都放行 → 断言红。
 *
 * 用法：node_modules/.bin/tsx --env-file=<env> outputs/mine-clear/T-2026-0929-0200/assertions/m1-approval-reuse.mts
 */
import pg from "pg";
import { gatewayAppend } from "@workloom/base/workdata";

const GW_URL = process.env.DATABASE_GATEWAY_URL!;
const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const tag = `mc106-${Date.now().toString(36)}`;
const gw = new pg.Pool({ connectionString: GW_URL, max: 3 });

const draft = (suffix: string) => ({
  who: { type: "agent" as const, id: "desktop-agent", version: "v0.9" },
  context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
  object: { type: "desktop", id: `screen-${tag}` },
  decision: { action: "desktop.gui", params: { step: suffix } },
  rule_impact: [],
});
const actor = { id: "desktop-agent", type: "agent" as const, fenceBindings: ["R2"], highRisk: true };

/** 夹具：一条 approved 审批行；bind=false 模拟 captain/skill-ops 的无绑定快照，bind=true 模拟步骤级绑定快照 */
async function mkApproval(suffix: string, bind: boolean): Promise<string> {
  const approvalId = `apr-${tag}-${suffix}`;
  const snapshot = bind
    ? { object_type: "desktop", object_id: `screen-${tag}`, action: "desktop.gui", expires_at: new Date(Date.now() + 864e5).toISOString() }
    : { kind: "generic-fixture", expires_at: new Date(Date.now() + 864e5).toISOString() };
  const c = await gw.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
    await c.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
       VALUES ($1,$2,$3,$4,'inapp','approved',$5)`,
      [approvalId, scope.tenantId, scope.workspaceId, `E-RPL-${tag}-${suffix}`, JSON.stringify(snapshot)],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  return approvalId;
}

async function tryWrite(approvalRef: string, round: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await gatewayAppend(gw, { ...scope, actor, approvalRef }, draft(`r${round}`));
    console.log(`  · 第 ${round} 次写动作：放行（事件 ${r.eventId}）`);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`  · 第 ${round} 次写动作：拒绝（${error}）`);
    return { ok: false, error };
  }
}

console.log("场景 A：snapshot 无 object/action 绑定（非步骤级路径产生）");
const unbound = await mkApproval("unbound", false);
const a1 = await tryWrite(unbound, 1);
const a2 = await tryWrite(unbound, 2);
console.log(`  期望：两次都拒绝（缺绑定不得作为高危写授权）。实测：第一次 ${a1.ok ? "放行" : "拒绝"}、第二次 ${a2.ok ? "放行" : "拒绝"}`);

console.log("场景 B：snapshot 已绑定 object/action");
const bound = await mkApproval("bound", true);
const b1 = await tryWrite(bound, 1);
const b2 = await tryWrite(bound, 2);
console.log(`  期望：第一次放行、第二次拒绝（逐次授权 = 一次性）。实测：第一次 ${b1.ok ? "放行" : "拒绝"}、第二次 ${b2.ok ? "放行" : "拒绝"}`);

await gw.end();
const pass = !a1.ok && !a2.ok && b1.ok && !b2.ok;
console.log(pass
  ? "OK：无绑定审批被拒；绑定审批一次性消费"
  : "BUG：高危授权语义未落地（无绑定审批仍可放行，或同一审批被复用）");
process.exit(pass ? 0 : 1);
