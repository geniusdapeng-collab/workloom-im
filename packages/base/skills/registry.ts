/**
 * skills · 注册、预览凭证与安装（F8.1–F8.3，L8.1–L8.4）
 * MC-022：team 归属由 owner_tenant_id/owner_workspace_id 与真实工作区决定；ID 只作标识。
 * 所有私有读写使用同一事务双 GUC。安装校验、安装快照与事件同一 COMMIT，版本变化须重新预览。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { withSkillScope, type SkillScope as Scope } from "./scope.js";

export type SkillLevel = "official" | "team" | "industry";
export interface SkillRow {
  id: string;
  level: SkillLevel;
  bundle: string | null;
  name: string;
  version: string;
  description: string;
  fence_bindings: string[];
  body: string;
  desensitized: boolean;
  /** 旧纯函数调用可省略；数据库行由 0055 提供且私有鉴权不允许缺失。 */
  owner_tenant_id?: string | null;
  owner_workspace_id?: string | null;
  ownership_state?: "owned" | "shared" | "quarantined";
  ownership_reason?: string | null;
  dist_meta?: Record<string, unknown>;
}
export class SkillError extends Error {
  constructor(public readonly code:
      | "NOT_FOUND" | "NOT_DESENSITIZED" | "NOT_SIGNED"
      | "FENCE_CONFLICT" | "NEED_DRY_RUN" | "NOT_INSTALLED"
      | "SKILL_REVOKED" | "PUBLISH_SCAN_FAILED" | "SELF_REVIEW_FORBIDDEN"
      | "DUPLICATE_REVIEW" | "EMPTY_REASON" | "NOT_APPROVED", message: string) {
    super(message); this.name = "SkillError";
  }
}
async function emitInTx(client: pg.PoolClient, scope: Scope, by: string,
  decision: Record<string, unknown>, links?: string[]): Promise<string> {
  const r = await gatewayAppendOnClient(client, { ...scope, actor: { id: by, type: "human" } }, {
    who: { type: "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never, rule_impact: [], links,
  });
  return r.eventId;
}
/** 不带 scope 的兼容调用只能读共享资产，任何私有正文都不会经此入口返回。 */
export async function getSkill(app: pg.Pool, skillId: string, scope?: Scope): Promise<SkillRow | null> {
  if (!scope) {
    const r = await app.query<SkillRow>("SELECT * FROM skills WHERE id=$1 AND ownership_state='shared'", [skillId]);
    return r.rows[0] ?? null;
  }
  return withSkillScope(app, scope, async (client) => {
    const r = await client.query<SkillRow>("SELECT * FROM skills WHERE id=$1", [skillId]);
    return r.rows[0] ?? null;
  });
}
/** RLS 只返回共享资产与显式属于本租户、本工作区的私有行，不使用 LIKE 或字符串前缀授权。 */
export async function listSkills(app: pg.Pool, scope: Scope, opts: { level?: SkillLevel } = {}): Promise<SkillRow[]> {
  return withSkillScope(app, scope, async (client) => {
    const r = opts.level
      ? await client.query<SkillRow>("SELECT * FROM skills WHERE level=$1 ORDER BY id", [opts.level])
      : await client.query<SkillRow>("SELECT * FROM skills ORDER BY id");
    return r.rows;
  });
}
export async function listInstalls(app: pg.Pool, scope: Scope): Promise<Array<{ skill_id: string; installed_by: string; installed_at: Date }>> {
  return withSkillScope(app, scope, async (client) => (await client.query<{
    skill_id: string; installed_by: string; installed_at: Date;
  }>(`SELECT i.skill_id,i.installed_by,i.installed_at FROM skill_installs i
      JOIN skills s ON s.id=i.skill_id WHERE i.workspace_id=$1 ORDER BY i.installed_at`, [scope.workspaceId])).rows);
}
/** 来源白名单只描述来源；team 的实际归属另外由 RLS 与 owner 字段校验。 */
export function isSignedSource(skill: SkillRow, scope: Scope): boolean {
  if (skill.level === "official") return true;
  if (skill.level === "team") return skill.id.startsWith("skill-t-");
  return false; // industry 共享层另走白名单签发，首版不放行。
}
export function isOwnWorkspaceSkill(skill: SkillRow, scope: Scope): boolean {
  return skill.level !== "team" || (skill.ownership_state === "owned"
    && skill.owner_tenant_id === scope.tenantId && skill.owner_workspace_id === scope.workspaceId);
}
export function detectFenceConflicts(bindings: string[], activeRuleIds: Set<string>): { missing: string[] } {
  return { missing: bindings.filter((binding) => !activeRuleIds.has(binding)) };
}
/** 同一 COMMIT 内锁定所安装的行，避免预览后草稿改变或校验后正文被替换。 */
export async function installSkill(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; by: string }): Promise<{ installed: boolean; deduped: boolean; bindings: string[] }> {
  void gateway;
  const outcome = await withSkillScope(app, scope, async (client) => {
    const r = await client.query<SkillRow>("SELECT * FROM skills WHERE id=$1 FOR UPDATE", [input.skillId]);
    const skill = r.rows[0];
    if (!skill || !isOwnWorkspaceSkill(skill, scope)) {
      const eventId = await emitInTx(client, scope, input.by, {
        action: "skill.install.blocked", after: { skillId: input.skillId, reason: "NOT_OWN_WORKSPACE" },
        basis: ["私有技能必须属于实际租户与工作区（MC-022），不可见资产拒绝消费"],
      });
      return { error: new SkillError("NOT_SIGNED", `技能不可用于本工作区，已拦截并留痕 ${eventId}`) };
    }
    if (skill.level === "industry" && !skill.desensitized) {
      throw new SkillError("NOT_DESENSITIZED", `行业共享技能「${skill.name}」未脱敏，拦截安装（L8.1/E8.4）`);
    }
    const revoked = await client.query("SELECT 1 FROM skill_revocations WHERE skill_id=$1", [skill.id]);
    const blockedReason = revoked.rowCount ? "SKILL_REVOKED" : !isSignedSource(skill, scope) ? "NOT_SIGNED" : null;
    if (blockedReason) {
      const eventId = await emitInTx(client, scope, input.by, {
        action: "skill.install.blocked", after: { skillId: skill.id, name: skill.name, reason: blockedReason, level: skill.level },
        basis: ["生产技能必须通过来源白名单且未吊销（L8.2/D15-④）"],
      });
      return { error: new SkillError(blockedReason, `技能「${skill.name}」禁止安装，已留痕 ${eventId}`) };
    }
    if (skill.level === "team") {
      const trace = await client.query(
        `SELECT 1 FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2
         AND payload->'decision'->>'action'='skill.dry_run'
         AND payload->'decision'->'after'->>'skillId'=$3
         AND payload->'decision'->'after'->>'version'=$4 LIMIT 1`,
        [scope.tenantId, scope.workspaceId, skill.id, skill.version]);
      if (!trace.rowCount) throw new SkillError("NEED_DRY_RUN", `团队技能「${skill.name}」当前版本生效前须 dry-run 预览（F8.3）`);
    }
    const bindings = skill.fence_bindings ?? [];
    if (bindings.length) {
      const active = await client.query<{ rule_id: string }>(
        "SELECT DISTINCT rule_id FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'", [scope.workspaceId]);
      const { missing } = detectFenceConflicts(bindings, new Set(active.rows.map((row) => row.rule_id)));
      if (missing.length) {
        const eventId = await emitInTx(client, scope, input.by, {
          action: "skill.install.conflict", after: { skillId: skill.id, name: skill.name, missingBindings: missing },
          basis: ["技能绑定围栏未生效，冲突项逐条人审（E8.1）"],
        });
        await client.query(
          `INSERT INTO approvals (approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot)
           VALUES ($1,$2,$3,$4,'inapp','pending',$5)`,
          [`apr-${eventId.toLowerCase()}`, scope.tenantId, scope.workspaceId, eventId,
           JSON.stringify({ kind: "skill_fence_conflict", skillId: skill.id, missingBindings: missing, high_risk: true })]);
        return { error: new SkillError("FENCE_CONFLICT", `技能「${skill.name}」绑定围栏 ${missing.join("/")} 未生效，冲突项已进审批（E8.1）`) };
      }
    }
    const inserted = await client.query(
      `INSERT INTO skill_installs (skill_id,workspace_id,installed_by,fence_bindings_snapshot,installed_version)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (skill_id,workspace_id) DO NOTHING`,
      [skill.id, scope.workspaceId, input.by, JSON.stringify(bindings), skill.version]);
    const deduped = inserted.rowCount === 0;
    if (!deduped) await emitInTx(client, scope, input.by, {
      action: "skill.installed", after: { skillId: skill.id, name: skill.name, level: skill.level, bindings },
      basis: ["安装即绑定围栏（F8.2）；绑定快照、版本与安装事件同一事务（D16）"],
    });
    return { data: { installed: true as const, deduped, bindings } };
  });
  // 拦截与冲突回执提交后再抛业务错误；数据库错误使整笔事务回滚。
  if (outcome.error) throw outcome.error;
  return outcome.data!;
}
export async function uninstallSkill(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; by: string }): Promise<{ uninstalled: boolean; revokedBindings: string[] }> {
  void gateway;
  return withSkillScope(app, scope, async (client) => {
    const r = await client.query<SkillRow>("SELECT * FROM skills WHERE id=$1 FOR UPDATE", [input.skillId]);
    const skill = r.rows[0];
    if (!skill) throw new SkillError("NOT_FOUND", "技能不存在或不属于本工作区");
    const removed = await client.query<{ fence_bindings_snapshot: string[] }>(
      `DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2 RETURNING fence_bindings_snapshot`, [skill.id, scope.workspaceId]);
    if (!removed.rowCount) throw new SkillError("NOT_INSTALLED", `技能「${skill.name}」未安装到本工作区`);
    const revokedBindings = removed.rows[0]?.fence_bindings_snapshot ?? skill.fence_bindings ?? [];
    await emitInTx(client, scope, input.by, {
      action: "skill.uninstalled", after: { skillId: skill.id, name: skill.name, revokedBindings },
      basis: ["卸载即撤销安装时围栏快照（F8.2/L8.3），删除与撤销事件同一事务"],
    });
    return { uninstalled: true, revokedBindings };
  });
}
/** preset 声明 ∪ 可见、未吊销技能的安装快照；保留的历史非法安装行不会进入运行时。 */
export async function resolveAgentFenceBindings(app: pg.Pool, scope: Scope, agentId: string): Promise<string[]> {
  return withSkillScope(app, scope, async (client) => {
    const agent = await client.query<{ fence_bindings: string[] }>(
      "SELECT fence_bindings FROM agents WHERE id=$1 AND workspace_id=$2", [agentId, scope.workspaceId]);
    const installs = await client.query<{ fence_bindings_snapshot: string[] }>(
      `SELECT i.fence_bindings_snapshot FROM skill_installs i JOIN skills s ON s.id=i.skill_id
       WHERE i.workspace_id=$1 AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id=i.skill_id)`, [scope.workspaceId]);
    const union = new Set<string>(agent.rows[0]?.fence_bindings ?? []);
    for (const row of installs.rows) for (const binding of row.fence_bindings_snapshot ?? []) union.add(binding);
    return [...union].sort();
  });
}
export function isAssetReusable(asset: { share_scope: string; desensitized: boolean; payload?: { verified?: boolean } }): boolean {
  if (asset.payload?.verified !== true) return false;
  if (asset.share_scope === "industry" && !asset.desensitized) return false;
  return true;
}
