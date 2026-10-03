/** MC022: actual legacy product rows survive 42 original migrations -> appended 0055. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createSkillDraft } from "./forge.js";
import { getSkill, listInstalls, listSkills, resolveAgentFenceBindings } from "./registry.js";
import { completePublish } from "./publish.js";
import { rollbackSkill } from "../skill-ops/receiver.js";
import { assemblePreset } from "../../runtime/src/assembly.js";

type Scope = { tenantId: string; workspaceId: string };
interface LegacyFixture {
  run: string; scopes: { a: Scope; b: Scope; c: Scope }; ids: Record<string, string>;
  invalidScopes: Scope[];
  expectedOwnership: Array<{ id: string; state: string; tenant: string | null; workspace: string | null; reason?: string }>;
}
const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("MC022 legacy upgrade ownership and cached payloads (owned PostgreSQL)", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const created = new Set<string>();
  const observations: unknown[] = [];
  let fixture: LegacyFixture;
  let agentId: string;
  const raw = async (pool: pg.Pool, scope: Scope, sql: string, values: unknown[] = []) => {
    const client = await pool.connect(); let destroy = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
      const result = await client.query(sql, values); await client.query("COMMIT"); return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { destroy = true; throw new AggregateError([error, rollbackError], "Legacy assertion query and rollback failed"); }
      throw error;
    } finally { client.release(destroy); }
  };

  beforeAll(async () => {
    if (!process.env.SKILLS_NAMESPACE_LEGACY_MANIFEST) throw new Error("Real pre-0055 product fixture manifest is required; use the owned runner --upgrade-proof");
    fixture = JSON.parse(readFileSync(process.env.SKILLS_NAMESPACE_LEGACY_MANIFEST, "utf8"));
    expect((await owner.query("SELECT count(*)::int AS n FROM _migrations WHERE name='0055_private_skill_ownership.sql'")).rows[0].n).toBe(1);
    agentId = `agent-${fixture.run}`;
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,status,fence_bindings,meta) VALUES($1,$2,'legacy-probe','legacy probe','1.0.0','business','ready','[\"PRESET_BASE\"]','{}')", [agentId, fixture.scopes.a.workspaceId]);
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (fixture) {
        await owner.query("DELETE FROM agents WHERE id=$1", [agentId]);
        await owner.query("DELETE FROM skills WHERE id=ANY($1::text[])", [[...created]]);
        observations.push({ retainedLegacySkills: (await owner.query("SELECT id,ownership_state FROM skills WHERE id=ANY($1::text[]) ORDER BY id", [fixture.expectedOwnership.map((row) => row.id)])).rows });
      }
      if (process.env.SKILLS_NAMESPACE_UPGRADE_FACTS_PATH) writeFileSync(process.env.SKILLS_NAMESPACE_UPGRADE_FACTS_PATH, JSON.stringify({ run: fixture?.run, observations }, null, 2) + "\n", { flag: "wx" });
    } catch (error) { errors.push(error); }
    const closed = await Promise.allSettled([app.end(), gateway.end(), owner.end()]);
    for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, "Legacy upgrade evidence and pool cleanup failed");
  });

  it("unique old draft proof keeps original ID; ambiguous, absent and invalid proof quarantine without guessed ownership", async () => {
    for (const expected of fixture.expectedOwnership) {
      const row = (await owner.query("SELECT id,owner_tenant_id,owner_workspace_id,ownership_state,ownership_reason FROM skills WHERE id=$1", [expected.id])).rows[0];
      expect(row).toMatchObject({ id: expected.id, owner_tenant_id: expected.tenant, owner_workspace_id: expected.workspace, ownership_state: expected.state });
      if (expected.reason) expect(row.ownership_reason).toBe(expected.reason);
      for (const pool of [app, gateway]) {
        for (const scope of Object.values(fixture.scopes)) {
          const visible = (await raw(pool, scope, "SELECT id,body FROM skills WHERE id=$1", [expected.id])).rows;
          expect(visible.length).toBe(expected.state === "shared" || (expected.state === "owned" && expected.tenant === scope.tenantId && expected.workspace === scope.workspaceId) ? 1 : 0);
        }
      }
    }
    observations.push({ case: "legacy_proof_classification", expected: fixture.expectedOwnership });
  });

  it("real old foreign and unproved installs remain physically present but disappear from both runtime binding paths", async () => {
    const scope = fixture.scopes.a;
    const retained = (await owner.query("SELECT skill_id,fence_bindings_snapshot FROM skill_installs WHERE workspace_id=$1 ORDER BY skill_id", [scope.workspaceId])).rows;
    expect(retained.some((row) => row.skill_id === fixture.ids.foreign)).toBe(true);
    expect(retained.some((row) => row.skill_id === fixture.ids.noProof)).toBe(true);
    const visible = await listInstalls(app, scope);
    expect(visible.some((row) => row.skill_id === fixture.ids.foreign || row.skill_id === fixture.ids.noProof)).toBe(false);
    const bindings = await resolveAgentFenceBindings(app, scope, agentId);
    const assembled = await assemblePreset(app, scope, { workspaceId: scope.workspaceId, presetKey: "legacy-probe", goal: "synthetic upgrade probe" });
    for (const result of [bindings, assembled.fenceBindings]) {
      expect(result).toContain("PRESET_BASE"); expect(result).not.toContain("LEGACY_FOREIGN"); expect(result).not.toContain("LEGACY_NO_PROOF");
    }
    expect(await resolveAgentFenceBindings(app, fixture.scopes.b, "no-agent")).not.toContain("LEGACY_REVOKED");
    observations.push({ case: "legacy_install_runtime", retained, visible, bindings, assembledBindings: assembled.fenceBindings });
  });

  it("actual registered old whitespace identities never authorize private rows or privileged revocation after upgrade", async () => {
    expect(fixture.invalidScopes).toHaveLength(2);
    for (const [index, scope] of fixture.invalidScopes.entries()) {
      const id = fixture.ids[`blank${index}`]!;
      expect((await owner.query("SELECT id FROM workspaces WHERE id=$1 AND tenant_id=$2", [scope.workspaceId, scope.tenantId])).rowCount).toBe(1);
      expect((await owner.query("SELECT ownership_state,ownership_reason FROM skills WHERE id=$1", [id])).rows[0]).toMatchObject({ ownership_state: "quarantined", ownership_reason: "draft_scope_mismatch" });
      for (const pool of [app, gateway]) {
        expect((await raw(pool, scope, "SELECT id,body FROM skills WHERE id=$1", [id])).rows).toEqual([]);
        await expect(raw(pool, scope, "SELECT public.skill_revoke($1,'synthetic whitespace scope refusal','synthetic actor')", [id])).rejects.toMatchObject({ code: "42501" });
      }
      await expect(getSkill(app, id, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      observations.push({ case: "registered_legacy_whitespace_scope_denied", id, scope });
    }
  });

  it("old approved review without a content snapshot cannot release current private data", async () => {
    const scope = fixture.scopes.a; const reviewId = fixture.ids.legacyReview!;
    await expect(completePublish(app, gateway, scope, { reviewId, by: "synthetic reviewer" })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    await expect(raw(app, scope, "UPDATE skills SET level='industry',desensitized=true,ownership_state='shared' WHERE id=$1", [fixture.ids.legacyApproved])).rejects.toMatchObject({ code: "42501" });
    expect((await owner.query("SELECT status,reviewed_body FROM skill_publish_reviews WHERE id=$1", [reviewId])).rows[0]).toMatchObject({ status: "approved", reviewed_body: null });
    expect((await getSkill(app, fixture.ids.legacyApproved!, scope))?.ownership_state).toBe("owned");
    expect(await getSkill(app, fixture.ids.legacyApproved!)).toBeNull();
  });

  it("old foreign outbox and private staging/snapshot payloads stay on disk while raw app and gateway reads return no body", async () => {
    for (const [table, id] of [["skill_reflux_outbox", fixture.ids.foreignOutbox], ["skill_dist_staging", fixture.ids.privateStaging], ["skill_dist_snapshots", fixture.ids.privateSnapshot]] as const) {
      expect((await owner.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount).toBe(1);
      for (const pool of [app, gateway]) expect((await raw(pool, fixture.scopes.a, `SELECT * FROM ${table} WHERE id=$1`, [id])).rows).toEqual([]);
    }
    await expect(rollbackSkill(app, gateway, fixture.scopes.a, { skillId: fixture.ids.privateCache!, by: "synthetic rollback" })).rejects.toMatchObject({ code: "BAD_STATE" });
    await expect(rollbackSkill(app, gateway, fixture.scopes.b, { skillId: fixture.ids.public!, by: "synthetic rollback" })).rejects.toMatchObject({ code: "BAD_STATE" });
    expect((await owner.query("SELECT id,loaded_version FROM skill_dist_snapshots WHERE id=$1", [fixture.ids.unprovedPublicSnapshot])).rows[0]).toMatchObject({ id: fixture.ids.unprovedPublicSnapshot, loaded_version: null });
  });

  it("historical shared library and completed industry asset remain shared; actual old public snapshot can roll back", async () => {
    expect((await getSkill(app, fixture.ids.public!))?.level).toBe("official");
    expect((await getSkill(app, fixture.ids.industry!))?.level).toBe("industry");
    expect((await listSkills(app, fixture.scopes.c)).some((row) => row.id === fixture.ids.industry)).toBe(true);
    const result = await rollbackSkill(app, gateway, fixture.scopes.a, { skillId: fixture.ids.public!, by: "synthetic upgrade reviewer" });
    expect(result.restoredVersion).toBe("1.0.0");
    expect((await getSkill(app, fixture.ids.public!))?.version).toBe("1.0.0");
    expect((await owner.query("SELECT installed_version FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2", [fixture.ids.public, fixture.scopes.a.workspaceId])).rows[0].installed_version).toBe("1.0.0");
    expect((await owner.query("SELECT id FROM skill_dist_snapshots WHERE id=$1", [result.snapshotId])).rows).toEqual([]);
    observations.push({ case: "old_public_rollback_receipt", result });
  });

  it("new colliding drafts use separate IDs without editing the quarantined historical row or its old events", async () => {
    const old = (await owner.query("SELECT to_jsonb(s) AS row FROM skills s WHERE id=$1", [fixture.ids.ambiguous])).rows[0].row;
    const results = [];
    for (const [scope, name] of [[fixture.scopes.a, "joint-plan"], [fixture.scopes.c, "plan"]] as const) {
      const result = await createSkillDraft(app, gateway, scope, { name, description: "synthetic new collision-safe draft", triplet: { trigger: "t", steps: ["s"], boundary: "b" }, by: "synthetic creator" });
      created.add(result.skillId); expect(result.skillId).not.toBe(fixture.ids.ambiguous); results.push(result);
    }
    expect(results[0]!.skillId).not.toBe(results[1]!.skillId);
    expect((await owner.query("SELECT to_jsonb(s) AS row FROM skills s WHERE id=$1", [fixture.ids.ambiguous])).rows[0].row).toEqual(old);
    observations.push({ case: "quarantined_collision_preserved", old, results });
  });
});
