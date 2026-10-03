/**
 * skills · 零代码自定义技能（F8.3）+ dry-run 预览
 *  - 自然语言三要素（触发 / 步骤 / 边界）引导式生成技能草稿（SKILL.md 标准目录，F8.1 资产不锁死）
 *  - 生成物进版本管理：同名再生成 = version 递增（skills 行 UPDATE version）
 *  - 生效前 dry-run 预览：回放最近 10 条历史动作（F2.5 同口径），写 skill.dry_run 事件留痕——
 *    本事件即 installSkill 的「已预览」前置凭证（registry.ts hasDryRunTrace）
 */
import type pg from "pg";
import { DRY_RUN_REPLAY_LIMIT, type BusinessEvent } from "@workloom/shared";
import { replayRules, type RuntimeRule } from "../fence-engine/index.js";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { SkillError, type SkillRow } from "./registry.js";
import { withSkillScope } from "./scope.js";

interface Scope { tenantId: string; workspaceId: string }

/** 三要素（F8.3 原文：触发 / 步骤 / 边界） */
export interface SkillTriplet {
  trigger: string;
  steps: string[];
  boundary: string;
}

/** 渲染 SKILL.md（纯函数）：YAML frontmatter + 三要素正文 */
export function renderSkillMarkdown(name: string, description: string, triplet: SkillTriplet): string {
  const steps = triplet.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `---
name: ${name}
description: ${description}
---

# ${name}

## 触发（何时用）
${triplet.trigger}

## 步骤（怎么做）
${steps}

## 边界（什么不做）
${triplet.boundary}
`;
}

/** 兼容旧 ID；只用于候选标识，归属由数据库 owner 字段验证。 */
export function teamSkillId(name: string, workspaceId: string): string {
  return `skill-t-${workspaceId}-${skillSlug(name)}`;
}
const skillSlug = (name: string): string => name.trim().toLowerCase()
  .replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
/** UTF-8 hex 段可逆且分隔明确；前缀后无连字符，不能与旧 workspace-slug 拼接 ID 相等。 */
function fallbackSkillId(scope: Scope, name: string): string {
  const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
  return `skill-t-v2.${hex(scope.tenantId)}.${hex(scope.workspaceId)}.${hex(skillSlug(name))}`;
}
function nextVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? `${match[1]}.${Number(match[2]) + 1}.0` : "1.0.0";
}

/** 创建/迭代只更新锁定的本区 team 行；未知主键占位只能跳过，绝不 UPSERT 覆写。 */
export async function createSkillDraft(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { name: string; description: string; triplet: SkillTriplet; fenceBindings?: string[]; by: string },
): Promise<{ skillId: string; version: string }> {
  void gateway;
  const body = renderSkillMarkdown(input.name, input.description, input.triplet);
  return withSkillScope(app, scope, async (client) => {
    const logicalKey = JSON.stringify([scope.tenantId, scope.workspaceId, skillSlug(input.name)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [logicalKey]);
    const legacyId = teamSkillId(input.name, scope.workspaceId);
    const fallbackId = fallbackSkillId(scope, input.name);
    // 已在备用命名空间创建的草稿继续迭代，即使后来旧主键被删除也不另造第二份。
    const existingFallback = await client.query<SkillRow>(
      `SELECT * FROM skills WHERE level='team' AND ownership_state='owned'
       AND owner_tenant_id=$1 AND owner_workspace_id=$2
       AND (id=$3 OR starts_with(id,$3 || '.')) ORDER BY id FOR UPDATE`,
      [scope.tenantId, scope.workspaceId, fallbackId]);
    if (existingFallback.rows.length > 1) throw new SkillError("NOT_SIGNED", "团队草稿存在多份归属，拒绝猜测更新");
    let current = existingFallback.rows[0];
    if (!current) {
      current = (await client.query<SkillRow>(
        "SELECT * FROM skills WHERE id=$1 AND level='team' AND ownership_state='owned' FOR UPDATE", [legacyId])).rows[0];
    }
    let skillId = current?.id ?? legacyId;
    let version = current ? nextVersion(current.version) : "1.0.0";
    if (!current) {
      let generation = 0;
      while (true) {
        // 无 UPDATE 子句：ON CONFLICT 对他区/隔离/共享行只作占位检查，正文不被读出或改写。
        const inserted = await client.query(
          `INSERT INTO skills (id,level,bundle,name,version,description,fence_bindings,body,desensitized,
             owner_tenant_id,owner_workspace_id,ownership_state,ownership_reason)
           VALUES ($1,'team',NULL,$2,$3,$4,$5,$6,false,$7,$8,'owned','explicit_scope')
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [skillId, input.name, version, input.description, JSON.stringify(input.fenceBindings ?? []), body,
           scope.tenantId, scope.workspaceId]);
        if (inserted.rowCount) break;
        const own = (await client.query<SkillRow>(
          "SELECT * FROM skills WHERE id=$1 AND level='team' AND ownership_state='owned' FOR UPDATE", [skillId])).rows[0];
        if (own) { current = own; version = nextVersion(own.version); break; }
        skillId = generation++ === 0 ? fallbackId : `${fallbackId}.${generation - 1}`;
      }
    }
    if (current) {
      const updated = await client.query(
        `UPDATE skills SET name=$2,version=$3,description=$4,fence_bindings=$5,body=$6
         WHERE id=$1 AND level='team' AND ownership_state='owned' AND owner_tenant_id=$7 AND owner_workspace_id=$8`,
        [skillId, input.name, version, input.description, JSON.stringify(input.fenceBindings ?? []), body,
         scope.tenantId, scope.workspaceId]);
      if (updated.rowCount !== 1) throw new SkillError("NOT_SIGNED", "团队草稿归属在更新前发生变化");
    }
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "skill", id: skillId },
      decision: {
        action: "skill.draft.created",
        after: { skillId, name: input.name, version, triplet: input.triplet, fenceBindings: input.fenceBindings ?? [] },
        basis: ["三要素生成团队技能（F8.3）；实际租户与工作区显式归属（MC-022）", "草稿版本与事件同一事务递增（D16）"],
      }, rule_impact: [],
    } as never);
    return { skillId, version };
  });
}

export interface SkillDryRunReport {
  skillId: string;
  replayed: number;
  /** 按绑定规则分组的模拟判定 */
  perRule: Array<{ ruleId: string; version: string; wouldBlock: number; wouldReview: number; pass: number }>;
}

/** dry-run 预览（F8.3 生效前）：对技能声明的绑定围栏逐条回放最近 10 条（F2.5 口径） */
export async function dryRunSkill(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; by: string }): Promise<SkillDryRunReport> {
  void gateway;
  return withSkillScope(app, scope, async (client) => {
    const skill = (await client.query<SkillRow>("SELECT * FROM skills WHERE id=$1 FOR UPDATE", [input.skillId])).rows[0];
    if (!skill) throw new SkillError("NOT_FOUND", "技能不存在或不属于本工作区");
    const events = (await client.query<{ payload: BusinessEvent }>(
      "SELECT payload FROM biz_events WHERE workspace_id=$1 ORDER BY seq DESC LIMIT $2",
      [scope.workspaceId, DRY_RUN_REPLAY_LIMIT])).rows.map((row) => row.payload);
    let rules: RuntimeRule[] = [];
    const bindings = skill.fence_bindings ?? [];
    if (bindings.length) {
      const r = await client.query<{
        rule_id: string; version: string; name: string; level: RuntimeRule["level"];
        is_baseline: boolean; match_spec: { object_types?: string[]; actions?: string[]; when?: string };
      }>(`SELECT DISTINCT ON (rule_id) rule_id,version,name,level,is_baseline,match_spec
          FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id=ANY($2)
          ORDER BY rule_id, CASE level WHEN 'block' THEN 2 WHEN 'review' THEN 1 ELSE 0 END DESC,
                   is_baseline DESC,created_at DESC`, [scope.workspaceId, bindings]);
      rules = r.rows.map((row) => ({ rule_id: row.rule_id,version: row.version,name: row.name,
        level: row.level,is_baseline: row.is_baseline,objectTypes: row.match_spec.object_types ?? [],
        actions: row.match_spec.actions ?? [],when: row.match_spec.when ?? "true" }));
    }
    const perRule = rules.map((rule) => {
      const { verdicts } = replayRules(events, [rule], "auto");
      return { ruleId: rule.rule_id,version: rule.version,
        wouldBlock: verdicts.filter((v) => v.verdict.level === "block").length,
        wouldReview: verdicts.filter((v) => v.verdict.level === "review").length,
        pass: verdicts.filter((v) => v.verdict.level === "auto").length };
    });
    const report: SkillDryRunReport = { skillId: skill.id,replayed: events.length,perRule };
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId,workspace_id: scope.workspaceId,time: new Date().toISOString(),channel: "inapp" },
      object: { type: "skill",id: skill.id },
      decision: { action: "skill.dry_run",after: { ...report,name: skill.name,version: skill.version },
        basis: ["当前归属与版本下预览，预览凭证与读取正文同一事务（F8.3/MC-022）"] },rule_impact: [],
    } as never);
    return report;
  });
}
