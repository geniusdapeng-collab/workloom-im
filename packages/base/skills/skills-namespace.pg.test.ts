/** MC-022 / MC-122: real PostgreSQL scope, namespace collision, and lifecycle regression. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { createSkillDraft, dryRunSkill, teamSkillId } from "./forge.js";
import { getSkill, installSkill, listInstalls, listSkills, uninstallSkill } from "./registry.js";
import { proposePublish } from "./publish.js";
import { previewReflux } from "../skill-ops/reflux.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("MC022 exact private skill namespace (owned PostgreSQL)", () => {
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const run = `mc022-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  type Scope = { tenantId: string; workspaceId: string };
  const a: Scope = { tenantId: `tenant-${run}`, workspaceId: `ws-${run}` };
  const b: Scope = { tenantId: a.tenantId, workspaceId: `${a.workspaceId}-other` };
  const c: Scope = { tenantId: `tenant-${run}-c`, workspaceId: `${a.workspaceId}-joint` };
  const wildcard: Scope = { tenantId: a.tenantId, workspaceId: `${a.workspaceId}_p%` };
  const wildcardPeer: Scope = { tenantId: c.tenantId, workspaceId: `${a.workspaceId}Zp-peer` };
  const slash: Scope = { tenantId: a.tenantId, workspaceId: `${a.workspaceId}\\` };
  const scopes = [a, b, c, wildcard, wildcardPeer, slash];
  const actor = `member-${run}`;
  const ids = new Set<string>();
  const facts: Record<string, unknown> = { run, scopes, relationships: { prefix: "B=A+\"-other\"", collision: "A/name=joint-plan and C=A+\"-joint\"/name=plan", wildcard: "literal underscore and percent vs Zp-peer", slash: "literal backslash" }, observations: [] };
  let seedRows: unknown[] = [];
  let ready = false;
  const record = (caseName: string, observation: unknown) => {
    (facts.observations as unknown[]).push({ caseName, observation });
  };
  const scoped = async <T extends pg.QueryResultRow = pg.QueryResultRow>(scope: Scope, sql: string, values: unknown[] = []) => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
      const result = await client.query<T>(sql, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Namespace assertion query and rollback failed"); }
      throw error;
    } finally { client.release(); }
  };
  const draft = async (scope: Scope, name: string, description = `private-${scope.workspaceId}`) => {
    const result = await createSkillDraft(app, gateway, scope, { name, description, triplet: { trigger: "t", steps: ["s"], boundary: "b" }, by: actor });
    ids.add(result.skillId);
    return result;
  };
  const errorOf = async (action: () => Promise<unknown>) => {
    try { return { value: await action(), error: null }; }
    catch (error) { return { value: null, error: { code: (error as { code?: string }).code, message: (error as Error).message } }; }
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.DATABASE_GATEWAY_URL) throw new Error("Explicit owned owner/app/gateway URLs required");
    facts.roles = (await owner.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    for (const role of facts.roles as Array<{ rolsuper: boolean; rolbypassrls: boolean }>) {
      expect(role.rolsuper).toBe(false); expect(role.rolbypassrls).toBe(false);
    }
    seedRows = (await owner.query("SELECT row_to_json(i) AS install FROM skill_installs i WHERE workspace_id='ws-yunqi' ORDER BY skill_id")).rows;
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      for (const tenant of [...new Set(scopes.map((s) => s.tenantId))]) await client.query("INSERT INTO tenants(id,name) VALUES($1,'namespace synthetic tenant')", [tenant]);
      for (const scope of scopes) await client.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'namespace fixture',$1,'general')", [scope.workspaceId, scope.tenantId]);
      await client.query("COMMIT");
      ready = true;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Namespace fixture creation and rollback failed"); }
      throw error;
    } finally { client.release(); }
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (ready) {
        facts.seedPreserved = JSON.stringify(seedRows) === JSON.stringify((await owner.query("SELECT row_to_json(i) AS install FROM skill_installs i WHERE workspace_id='ws-yunqi' ORDER BY skill_id")).rows);
        if (!facts.seedPreserved) errors.push(new Error("Seed skill installs changed"));
        const client = await owner.connect();
        try {
          await client.query("BEGIN");
          const workspaceIds = scopes.map((s) => s.workspaceId);
          await client.query("DELETE FROM skill_installs WHERE workspace_id=ANY($1::text[])", [workspaceIds]);
          await client.query("DELETE FROM skill_publish_reviews WHERE from_workspace_id=ANY($1::text[])", [workspaceIds]);
          await client.query("DELETE FROM skill_reflux_outbox WHERE workspace_id=ANY($1::text[])", [workspaceIds]);
          await client.query("DELETE FROM skill_revocations WHERE skill_id=ANY($1::text[])", [[...ids]]);
          await client.query("DELETE FROM skills WHERE id=ANY($1::text[])", [[...ids]]);
          await client.query("COMMIT");
          facts.cleanup = { mutableSkills: (await client.query("SELECT count(*)::int AS n FROM skills WHERE id=ANY($1::text[])", [[...ids]])).rows[0].n, installs: (await client.query("SELECT count(*)::int AS n FROM skill_installs WHERE workspace_id=ANY($1::text[])", [workspaceIds])).rows[0].n };
          facts.auditRetained = (await client.query("SELECT workspace_id, count(*)::int AS events FROM biz_events WHERE workspace_id=ANY($1::text[]) GROUP BY workspace_id ORDER BY workspace_id", [workspaceIds])).rows;
        } catch (error) {
          try { await client.query("ROLLBACK"); }
          catch (rollbackError) { errors.push(rollbackError); }
          errors.push(error);
        } finally { client.release(); }
      }
      if (process.env.SKILLS_NAMESPACE_FACTS_PATH) writeFileSync(process.env.SKILLS_NAMESPACE_FACTS_PATH, JSON.stringify(facts, null, 2) + "\n", { flag: "wx" });
    } catch (error) { errors.push(error); }
    finally {
      const closed = await Promise.allSettled([app.end(), gateway.end(), owner.end()]);
      for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length) throw new AggregateError(errors, "Namespace fixture evidence/preservation/cleanup failed");
  });

  it("prefix-related real workspaces never expose each other's team list", async () => {
    const own = await draft(a, "prefix-list"); const foreign = await draft(b, "prefix-list");
    const list = (await listSkills(app, a, { level: "team" })).map((s) => s.id);
    record("prefix-list", { own, foreign, list });
    expect(list).toContain(own.skillId); expect(list).not.toContain(foreign.skillId);
  });

  it("foreign dry-run cannot mint a credential and install another workspace's private skill", async () => {
    const foreign = await draft(b, "foreign-install");
    const preview = await errorOf(() => dryRunSkill(app, gateway, a, { skillId: foreign.skillId, by: actor }));
    const install = await errorOf(() => installSkill(app, gateway, a, { skillId: foreign.skillId, by: actor }));
    const rows = (await owner.query("SELECT skill_id,workspace_id,installed_version FROM skill_installs WHERE skill_id=$1", [foreign.skillId])).rows;
    const events = (await owner.query("SELECT workspace_id,payload->'decision' AS decision FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 ORDER BY seq", [a.workspaceId, foreign.skillId])).rows;
    record("foreign-install", { foreign, preview, install, rows, events });
    expect(install.error?.code).toBe("NOT_SIGNED");
    expect(rows).toEqual([]); expect(preview.error).not.toBeNull();
  });

  it("different tenants cannot overwrite one legacy ID produced by workspace/name delimiter collision", async () => {
    const first = await draft(a, "joint-plan", "first tenant private content");
    const second = await draft(c, "plan", "second tenant private content");
    const rows = (await owner.query("SELECT id,name,description,version FROM skills WHERE id=ANY($1::text[]) ORDER BY id", [[first.skillId, second.skillId]])).rows;
    record("cross-tenant-id-collision", { legacyA: teamSkillId("joint-plan", a.workspaceId), legacyC: teamSkillId("plan", c.workspaceId), first, second, rows });
    expect(teamSkillId("joint-plan", a.workspaceId)).toBe(teamSkillId("plan", c.workspaceId));
    expect(second.skillId).not.toBe(first.skillId);
    expect(rows).toHaveLength(2); expect(rows.find((r) => r.id === first.skillId)?.description).toBe("first tenant private content");
  });

  it("literal SQL LIKE metacharacters and backslash keep exact scope visibility", async () => {
    const own = await draft(wildcard, "literal-list"); const foreign = await draft(wildcardPeer, "literal-list");
    const slashOwn = await draft(slash, "slash-list");
    const list = (await listSkills(app, wildcard, { level: "team" })).map((s) => s.id);
    const slashList = (await listSkills(app, slash, { level: "team" })).map((s) => s.id);
    record("metacharacters", { own, foreign, slashOwn, list, slashList });
    expect(list).toContain(own.skillId); expect(list).not.toContain(foreign.skillId); expect(slashList).toContain(slashOwn.skillId);
  });

  it("unscoped getter cannot return a private body; foreign proposal/reflux preview cannot read it", async () => {
    const foreign = await draft(b, "foreign-read");
    const unscoped = await getSkill(app, foreign.skillId);
    const proposal = await errorOf(() => proposePublish(app, gateway, a, { skillId: foreign.skillId, skillName: "foreign-read", body: "safe", description: "safe", by: actor }));
    const reflux = await errorOf(() => previewReflux(app, a, foreign.skillId));
    record("private-read-publish-reflux", { foreign, unscoped, proposal, reflux });
    expect(unscoped).toBeNull(); expect(proposal.error).not.toBeNull(); expect(reflux.error).not.toBeNull();
  });

  it("same scope still forges, previews, installs idempotently and uninstalls", async () => {
    const first = await draft(a, "same-scope"); const second = await draft(a, "same-scope", "updated content");
    await dryRunSkill(app, gateway, a, { skillId: second.skillId, by: actor });
    expect(second).toEqual({ skillId: first.skillId, version: "1.1.0" });
    expect(await installSkill(app, gateway, a, { skillId: second.skillId, by: actor })).toMatchObject({ installed: true, deduped: false });
    expect(await installSkill(app, gateway, a, { skillId: second.skillId, by: actor })).toMatchObject({ installed: true, deduped: true });
    expect((await listInstalls(app, a)).some((row) => row.skill_id === second.skillId)).toBe(true);
    expect(await uninstallSkill(app, gateway, a, { skillId: second.skillId, by: actor })).toMatchObject({ uninstalled: true });
    expect((await scoped(a, "SELECT skill_id FROM skill_installs WHERE skill_id=$1", [second.skillId])).rows).toEqual([]);
    record("same-scope", { first, second });
  });
});
