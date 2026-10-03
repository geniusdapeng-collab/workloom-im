/**
 * B10 技能/意识测试：白名单/冲突检测/资产闸门/SKILL.md 渲染/聚类/阈值校准（纯函数）+
 * PG 集成：安装绑定（F8.2）/ 幂等 / 卸载撤销（L8.3）/ 未脱敏拦截（L8.1）/ 冲突进审批（E8.1）
 *        / dry-run 前置（F8.3）/ 意识建议→确认固化→驳回校准（F8.4/E8.3）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { detectFenceConflicts, isAssetReusable, isSignedSource, type SkillRow } from "./registry.js";
import { renderSkillMarkdown, teamSkillId } from "./forge.js";
import { actionCategory, calibratedThreshold, clusterEvents } from "./awareness.js";
import type { BusinessEvent } from "@workloom/shared";

const skillRow = (over: Partial<SkillRow>): SkillRow => ({
  id: "skill-x", level: "official", bundle: "hotel", name: "x", version: "1.0.0",
  description: "", fence_bindings: [], body: "", desensitized: false, ...over,
});

describe("签名白名单（L8.2）与资产闸门（L8.4/L8.1）", () => {
  it("official 放行；team 须 skill-t- 命名空间；industry 首版不放行", () => {
    expect(isSignedSource(skillRow({ level: "official" }), null as never)).toBe(true);
    expect(isSignedSource(skillRow({ level: "team", id: "skill-t-abc" }), null as never)).toBe(true);
    expect(isSignedSource(skillRow({ level: "team", id: "skill-foreign" }), null as never)).toBe(false);
    expect(isSignedSource(skillRow({ level: "industry", desensitized: true }), null as never)).toBe(false);
  });

  it("未 verified 资产任何入口不可批量复用；industry 层未脱敏不可复用", () => {
    expect(isAssetReusable({ share_scope: "workspace", desensitized: false, payload: {} })).toBe(false);
    expect(isAssetReusable({ share_scope: "workspace", desensitized: false, payload: { verified: true } })).toBe(true);
    expect(isAssetReusable({ share_scope: "industry", desensitized: false, payload: { verified: true } })).toBe(false);
    expect(isAssetReusable({ share_scope: "industry", desensitized: true, payload: { verified: true } })).toBe(true);
  });
});

describe("围栏冲突检测（E8.1，纯函数）", () => {
  it("绑定缺失即冲突", () => {
    expect(detectFenceConflicts(["R1", "R9"], new Set(["R1", "R2"]))).toEqual({ missing: ["R9"] });
    expect(detectFenceConflicts(["R1"], new Set(["R1"]))).toEqual({ missing: [] });
  });
});

describe("SKILL.md 渲染与 ID（F8.3/F8.1）", () => {
  it("三要素渲染：触发/步骤/边界齐全 + frontmatter", () => {
    const md = renderSkillMarkdown("收益管理", "调价方法论", { trigger: "每日 07:00", steps: ["取竞对价", "算建议价"], boundary: "不破保底价" });
    expect(md).toContain("name: 收益管理");
    expect(md).toContain("## 触发（何时用）\n每日 07:00");
    expect(md).toContain("1. 取竞对价\n2. 算建议价");
    expect(md).toContain("## 边界（什么不做）\n不破保底价");
  });
  it("team 技能 ID 落 skill-t- 命名空间（白名单标识）", () => {
    expect(teamSkillId("差评跟进 SOP", "ws-yunqi")).toBe("skill-t-ws-yunqi-差评跟进-sop");
    expect(teamSkillId("  ", "ws-yunqi")).toBe("skill-t-ws-yunqi-unnamed");
  });
});

describe("意识系统聚类与校准（F8.4/E8.3，纯函数）", () => {
  const ev = (id: string, action: string, objType = "price"): BusinessEvent => ({
    event_id: id,
    who: { type: "agent", id: "pricing-agent" },
    context: { tenant_id: "t", workspace_id: "w", time: "2026-08-16T10:00:00+08:00" },
    object: { type: objType },
    decision: { action },
    rule_impact: [],
  });

  it("动作类别取前两段；系统动作不入观察", () => {
    expect(actionCategory("price.adjust")).toBe("price.adjust");
    expect(actionCategory("inspect.anomaly")).toBeNull();
    expect(actionCategory("skill.installed")).toBeNull();
    expect(actionCategory("bare")).toBeNull();
  });

  it("聚类按 对象类型×动作类别，样本 ≤5 条", () => {
    const events = [
      ev("E-1", "price.adjust"), ev("E-2", "price.adjust"), ev("E-3", "price.adjust"),
      ev("E-4", "price.adjust"), ev("E-5", "price.adjust"), ev("E-6", "price.adjust"),
      ev("E-7", "review.reply", "review"),
      ev("E-8", "inspect.anomaly", "channel"), // 系统动作不入
    ];
    const clusters = clusterEvents(events);
    expect(clusters.get("price::price.adjust")).toMatchObject({ count: 6 });
    expect(clusters.get("price::price.adjust")!.ids).toHaveLength(5);
    expect(clusters.get("review::review.reply")).toMatchObject({ count: 1 });
    expect(clusters.has("channel::inspect.anomaly")).toBe(false);
  });

  it("驳回校准：被驳回 key 阈值 ×2", () => {
    expect(calibratedThreshold(3, new Set(["a::b"]), "a::b")).toBe(6);
    expect(calibratedThreshold(3, new Set(["a::b"]), "c::d")).toBe(3);
  });
});

/* ---------- PG 集成 ---------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("技能/意识 PG 集成（M8 铁律）", async () => {
  const pg = await import("pg");
  const {
    installSkill, uninstallSkill, listInstalls, listSkills, resolveAgentFenceBindings,
    createSkillDraft, dryRunSkill, detectSuggestions, confirmSuggestion, rejectSuggestion,
  } = await import("./index.js");
  const { gatewayAppend } = await import("../workdata/gateway.js");
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const RUN = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  type Scope = { tenantId: string; workspaceId: string };
  const scope = { tenantId: `tenant-mc014-${RUN}`, workspaceId: `ws-mc014-${RUN}` };
  const scopeB = { tenantId: scope.tenantId, workspaceId: `ws-mc014-other-${RUN}` };
  const agentId = `agt-mc014-${RUN}`;
  const actor = `mc014-member-${RUN}`;
  const rules = {
    base: `R-MC014-${RUN}-base`, first: `R-MC014-${RUN}-first`,
    second: `R-MC014-${RUN}-second`, draft: `R-MC014-${RUN}-draft`, missing: `R-MC014-${RUN}-missing`,
  };
  const bindings = [rules.first, rules.second];
  const validId = `skill-mc014-${RUN}-valid`;
  const rawId = `skill-mc014-${RUN}-raw`;
  const conflictId = `skill-mc014-${RUN}-conflict`;
  const ownedSkillIds = new Set([validId, rawId, conflictId]);
  let fixturesReady = false;
  let seedScope: Scope;
  let seedSnapshot: SeedInstall[] = [];

  interface SeedInstall {
    skill_id: string; snap: string[]; ver: string; live: string[]; live_ver: string;
  }
  /** app 池断言查询辅助：事务内设置真实 RLS 上下文，含独立种子工作区查询。 */
  const qApp = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params: unknown[] = [], target: Scope = scope,
  ) => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [target.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [target.tenantId]);
      const r = await c.query<T>(sql, params);
      await c.query("COMMIT");
      return r;
    } catch (error) {
      try { await c.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "技能测试查询与回滚均失败"); }
      throw error;
    } finally {
      c.release();
    }
  };
  const ownerTx = async (action: (client: PoolClient) => Promise<void>) => {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await action(c);
      await c.query("COMMIT");
    } catch (error) {
      try { await c.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "技能夹具事务与回滚均失败"); }
      throw error;
    } finally {
      c.release();
    }
  };
  const seedInstalls = async () => (await qApp<SeedInstall & Record<string, unknown>>(
    `SELECT i.skill_id, i.fence_bindings_snapshot AS snap, i.installed_version AS ver,
            s.fence_bindings AS live, s.version AS live_ver
     FROM skill_installs i JOIN skills s ON s.id = i.skill_id
     WHERE i.workspace_id=$1
       AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id = i.skill_id)
     ORDER BY i.skill_id`, [seedScope.workspaceId], seedScope,
  )).rows;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.DATABASE_GATEWAY_URL) {
      throw new Error("技能 PG 测试夹具必须显式配置 DATABASE_URL 与 DATABASE_GATEWAY_URL");
    }
    const seedId = process.env.SERVICE_C_TEST_WORKSPACE_ID?.trim() || "ws-yunqi";
    const seeded = await owner.query<{ tenant_id: string }>("SELECT tenant_id FROM workspaces WHERE id=$1", [seedId]);
    if (!seeded.rows[0]) throw new Error(`技能种子回归工作区不存在：${seedId}`);
    seedScope = { workspaceId: seedId, tenantId: seeded.rows[0].tenant_id };
    seedSnapshot = await seedInstalls();
    await ownerTx(async (c) => {
      await c.query("INSERT INTO tenants (id, name) VALUES ($1,'技能测试租户')", [scope.tenantId]);
      await c.query(
        `INSERT INTO workspaces (id, tenant_id, name, slug, industry)
         VALUES ($1,$2,'技能测试工作区',$1,'general'), ($3,$2,'技能隔离工作区',$3,'general')`,
        [scope.workspaceId, scope.tenantId, scopeB.workspaceId],
      );
      for (const ruleId of [rules.base, ...bindings, rules.draft]) {
        await c.query(
          `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
           VALUES ($1,$2,'1.0.0',$3,'测试围栏','review',$4,'{"result":"review"}',false,'active',$5)`,
          [`fr-${ruleId}`, ruleId, scope.workspaceId,
           JSON.stringify({ object_types: ["review"], actions: ["review.reply"], when: "true" }), actor],
        );
      }
      await c.query(
        `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, fence_bindings)
         VALUES ($1,$2,'mc014-agent','技能测试 Agent','1.0.0','agent',$3)`,
        [agentId, scope.workspaceId, JSON.stringify([rules.base])],
      );
      for (const [id, level, fenceBindings] of [
        [validId, "official", bindings], [rawId, "industry", []],
        [conflictId, "official", [rules.first, rules.missing]],
      ] as const) {
        await c.query(
          `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
           VALUES ($1,$2,NULL,$1,'1.0.0','测试自持技能',$3,'',false)`,
          [id, level, JSON.stringify(fenceBindings)],
        );
      }
    });
    fixturesReady = true;
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      if (fixturesReady) {
        try {
          expect(await seedInstalls(), "测试不得安装/卸载或修改行业种子技能").toEqual(seedSnapshot);
        } catch (error) { failures.push(error); }
        try {
          await ownerTx(async (c) => {
            const workspaces = [scope.workspaceId, scopeB.workspaceId];
            await c.query("DELETE FROM skill_installs WHERE workspace_id=ANY($1::text[])", [workspaces]);
            await c.query("DELETE FROM trigger_fires WHERE workspace_id=ANY($1::text[])", [workspaces]);
            await c.query("DELETE FROM triggers WHERE workspace_id=ANY($1::text[])", [workspaces]);
            await c.query("DELETE FROM agents WHERE id=$1 AND workspace_id=$2", [agentId, scope.workspaceId]);
            await c.query("DELETE FROM fence_rules WHERE workspace_id=$1 AND rule_id=ANY($2::text[])",
              [scope.workspaceId, [rules.base, ...bindings, rules.draft]]);
            await c.query("DELETE FROM skills WHERE id=ANY($1::text[])", [[...ownedSkillIds]]);
            // 租户/工作区作为审计锚点保留；五元事件与冲突审批保持 append-only。
          });
        } catch (error) { failures.push(error); }
      }
    } finally {
      const closed = await Promise.allSettled([app.end(), gw.end(), owner.end()]);
      for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, "技能 PG 夹具清理/种子保留校验失败");
  });

  const appendTaskEvent = async (action: string, objType: string) => {
    await gatewayAppend(gw, { ...scope, actor: { id: agentId, type: "agent", fenceBindings: [rules.base] } }, {
      who: { type: "agent", id: agentId, version: "1.0.0" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: objType }, decision: { action }, rule_impact: [],
    } as never);
  };

  it("F8.2/L8.3 安装即绑定→并集生效；卸载即撤销；重复安装幂等", async () => {
    expect(await listInstalls(app, scope)).toEqual([]);
    expect(await resolveAgentFenceBindings(app, scope, agentId)).toEqual([rules.base]);
    const i1 = await installSkill(app, gw, scope, { skillId: validId, by: actor });
    expect(i1).toEqual({ installed: true, deduped: false, bindings });
    const installed = await qApp<{ snap: string[]; ver: string }>(
      `SELECT fence_bindings_snapshot AS snap, installed_version AS ver FROM skill_installs
       WHERE workspace_id=$1 AND skill_id=$2`, [scope.workspaceId, validId],
    );
    expect(installed.rows).toEqual([{ snap: bindings, ver: "1.0.0" }]);
    const expectedUnion = [rules.base, ...bindings].sort();
    expect(await resolveAgentFenceBindings(app, scope, agentId)).toEqual(expectedUnion);
    const installedEvents = async () => (await qApp<{ n: number }>(
      `SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1
       AND payload->'decision'->>'action'='skill.installed' AND payload->'object'->>'id'=$2`,
      [scope.workspaceId, validId],
    )).rows[0]!.n;
    expect(await installedEvents()).toBe(1);
    const i2 = await installSkill(app, gw, scope, { skillId: validId, by: actor });
    expect(i2).toEqual({ installed: true, deduped: true, bindings });
    expect((await listInstalls(app, scope)).map((item) => item.skill_id)).toEqual([validId]);
    expect(await installedEvents()).toBe(1);

    // 作者修改实时声明后，运行时仍消费安装快照；卸载撤销的也必须是该快照。
    await qApp("UPDATE skills SET fence_bindings=$2, version='2.0.0' WHERE id=$1", [validId, JSON.stringify([rules.missing])]);
    expect(await resolveAgentFenceBindings(app, scope, agentId)).toEqual(expectedUnion);
    expect((await qApp<{ snap: string[]; ver: string }>(
      "SELECT fence_bindings_snapshot AS snap, installed_version AS ver FROM skill_installs WHERE workspace_id=$1 AND skill_id=$2",
      [scope.workspaceId, validId],
    )).rows).toEqual([{ snap: bindings, ver: "1.0.0" }]);
    const u = await uninstallSkill(app, gw, scope, { skillId: validId, by: actor });
    expect(u).toEqual({ uninstalled: true, revokedBindings: bindings });
    expect(await listInstalls(app, scope)).toEqual([]);
    expect(await resolveAgentFenceBindings(app, scope, agentId)).toEqual([rules.base]);
    const uninstalled = await qApp<{ revoked: string[] }>(
      `SELECT payload->'decision'->'after'->'revokedBindings' AS revoked FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='skill.uninstalled' AND payload->'object'->>'id'=$2`,
      [scope.workspaceId, validId],
    );
    expect(uninstalled.rows).toEqual([{ revoked: bindings }]);
    await expect(uninstallSkill(app, gw, scope, { skillId: validId, by: actor })).rejects.toMatchObject({ code: "NOT_INSTALLED" });
  });

  it("seed 与运行时双路径安装快照同构：快照=实时绑定、版本对齐、并集一致（#17 口径回归）", async () => {
    const rows = await seedInstalls();
    expect(rows).toEqual(seedSnapshot);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.snap, `${row.skill_id} 种子安装快照须等于实时绑定`).toEqual(row.live);
      expect(row.ver, `${row.skill_id} 种子安装版本须对齐技能版本`).toBe(row.live_ver);
    }
    const agent = await qApp<{ id: string; fence_bindings: string[] }>(
      "SELECT id, fence_bindings FROM agents WHERE workspace_id=$1 AND preset_key='pricing-agent'",
      [seedScope.workspaceId], seedScope,
    );
    expect(agent.rows).toHaveLength(1);
    const union = await resolveAgentFenceBindings(app, seedScope, agent.rows[0]!.id);
    expect(union).toEqual([...new Set([
      ...agent.rows[0]!.fence_bindings, ...rows.flatMap((row) => row.snap),
    ])].sort());
  });

  it("L8.1 未脱敏 industry 技能拦截；E8.1 绑定冲突进审批不静默放行", async () => {
    await expect(installSkill(app, gw, scope, { skillId: rawId, by: actor }))
      .rejects.toMatchObject({ code: "NOT_DESENSITIZED" });
    const missing = await qApp(
      "SELECT rule_id FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id=$2",
      [scope.workspaceId, rules.missing],
    );
    expect(missing.rows).toEqual([]); // 独立 SQL 检查，反例不能借用碰巧已启用的 R9。
    await expect(installSkill(app, gw, scope, { skillId: conflictId, by: actor }))
      .rejects.toMatchObject({ code: "FENCE_CONFLICT" });
    const approval = await qApp<{ status: string; snapshot: Record<string, unknown>; event_id: string }>(
      "SELECT status, snapshot, event_id FROM approvals WHERE workspace_id=$1 AND snapshot->>'skillId'=$2",
      [scope.workspaceId, conflictId],
    );
    expect(approval.rows).toHaveLength(1);
    expect(approval.rows[0]).toMatchObject({ status: "pending", snapshot: {
      kind: "skill_fence_conflict", skillId: conflictId, missingBindings: [rules.missing], high_risk: true,
    } });
    const conflictEvent = await qApp<{ action: string; missing: string[] }>(
      `SELECT payload->'decision'->>'action' AS action, payload->'decision'->'after'->'missingBindings' AS missing
       FROM biz_events WHERE workspace_id=$1 AND event_id=$2 AND payload->'object'->>'id'=$3`,
      [scope.workspaceId, approval.rows[0]!.event_id, conflictId],
    );
    expect(conflictEvent.rows).toEqual([{ action: "skill.install.conflict", missing: [rules.missing] }]);
    expect((await qApp("SELECT skill_id FROM skill_installs WHERE workspace_id=$1 AND skill_id=ANY($2::text[])",
      [scope.workspaceId, [rawId, conflictId]])).rows).toEqual([]);
  });

  it("F8.3 三要素草稿 → 未 dry-run 拒装 → dry-run 预览 → 安装放行", async () => {
    const name = `差评跟进打法-${RUN}`;
    const draftId = `skill-t-${scope.workspaceId}-${name.toLowerCase()}`;
    ownedSkillIds.add(draftId);
    const draft = await createSkillDraft(app, gw, scope, {
      name, description: "差评回复方法论",
      triplet: { trigger: "出现 ≤3 分差评", steps: ["归因", "起草回复", "挂审批"], boundary: "不承诺档案外补偿" },
      fenceBindings: [rules.draft], by: actor,
    });
    expect(draft.skillId).toBe(draftId);
    expect(draft.version).toBe("1.0.0");
    await expect(installSkill(app, gw, scope, { skillId: draft.skillId, by: actor }))
      .rejects.toMatchObject({ code: "NEED_DRY_RUN" });
    const report = await dryRunSkill(app, gw, scope, { skillId: draft.skillId, by: actor });
    expect(report.skillId).toBe(draft.skillId);
    expect(report.perRule).toHaveLength(1);
    expect(report.perRule[0]).toMatchObject({ ruleId: rules.draft, version: "1.0.0" });
    const ok = await installSkill(app, gw, scope, { skillId: draft.skillId, by: actor });
    expect(ok).toEqual({ installed: true, deduped: false, bindings: [rules.draft] });
    expect(await uninstallSkill(app, gw, scope, { skillId: draft.skillId, by: actor }))
      .toEqual({ uninstalled: true, revokedBindings: [rules.draft] });
  });

  it("#23 跨工作区隔离：同名技能不互覆盖 / 列表隔离 / 他区技能安装拦截", async () => {
    const name = `同名跟进 SOP-${RUN}`;
    const input = { name, triplet: { trigger: "t", steps: ["s"], boundary: "b" }, fenceBindings: [], by: actor };
    for (const target of [scope, scopeB]) ownedSkillIds.add(teamSkillId(name, target.workspaceId));
    const a = await createSkillDraft(app, gw, scope, { ...input, description: "A 区方法论" });
    const b = await createSkillDraft(app, gw, scopeB, { ...input, description: "B 区方法论" });
    expect(a.skillId).not.toBe(b.skillId);
    expect(a.skillId).toContain(scope.workspaceId);
    expect(b.skillId).toContain(scopeB.workspaceId);
    const queried = await Promise.all([scope, scopeB].map((target) =>
      qApp<{ id: string; description: string }>("SELECT id, description FROM skills WHERE name=$1", [name], target)));
    const both = { rows: queried.flatMap((result) => result.rows) };
    expect(both.rows).toHaveLength(2);
    expect(new Set(both.rows.map((row) => row.description))).toEqual(new Set(["A 区方法论", "B 区方法论"]));
    const listA = await listSkills(app, scope, { level: "team" });
    const listB = await listSkills(app, scopeB, { level: "team" });
    expect(listA.some((skill) => skill.id === a.skillId)).toBe(true);
    expect(listA.some((skill) => skill.id === b.skillId)).toBe(false);
    expect(listB.some((skill) => skill.id === b.skillId)).toBe(true);
    expect(listB.some((skill) => skill.id === a.skillId)).toBe(false);
    await expect(installSkill(app, gw, scope, { skillId: b.skillId, by: actor })).rejects.toMatchObject({ code: "NOT_SIGNED" });
    expect((await qApp("SELECT skill_id FROM skill_installs WHERE workspace_id=$1 AND skill_id=$2",
      [scope.workspaceId, b.skillId])).rows).toEqual([]);
  });

  it("F8.4 高频检测建议 → 一键确认生成触发器 → 不再重复建议；E8.3 驳回后阈值 ×2", async () => {
    for (let i = 0; i < 3; i++) await appendTaskEvent(`competitor.scan${RUN}`, "channel");
    const suggestions = await detectSuggestions(app, scope);
    const hit = suggestions.find((item) => item.key === `channel::competitor.scan${RUN}`);
    expect(hit).toMatchObject({ count: 3, threshold: 3 });
    const confirmed = await confirmSuggestion(app, gw, scope, {
      suggestion: hit!, target: "trigger", by: actor, schedule: "0 6 * * *",
    });
    expect(confirmed.artifactId).toMatch(/^trg-auto-/);
    const trigger = await qApp("SELECT kind, schedule, enabled FROM triggers WHERE id=$1", [confirmed.artifactId]);
    expect(trigger.rows).toEqual([{ kind: "cron", schedule: "0 6 * * *", enabled: true }]);
    const again = await detectSuggestions(app, scope);
    expect(again.find((item) => item.key === hit!.key)).toBeUndefined();
    for (let i = 0; i < 3; i++) await appendTaskEvent(`content.draft${RUN}`, "content");
    await rejectSuggestion(gw, scope, { key: `content::content.draft${RUN}`, by: actor, reason: "频次误判" });
    const afterReject = await detectSuggestions(app, scope);
    expect(afterReject.find((item) => item.key === `content::content.draft${RUN}`)).toBeUndefined();
    for (let i = 0; i < 3; i++) await appendTaskEvent(`content.draft${RUN}`, "content");
    const six = await detectSuggestions(app, scope);
    expect(six.find((item) => item.key === `content::content.draft${RUN}`)).toMatchObject({ count: 6, threshold: 6 });
  });
});
