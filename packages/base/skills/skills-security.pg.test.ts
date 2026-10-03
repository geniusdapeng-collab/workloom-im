/** MC022: actual nonprivileged SQL, publication snapshots, distribution and transaction failures. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { createSkillDraft, dryRunSkill, teamSkillId } from "./forge.js";
import { getSkill, installSkill, listSkills, resolveAgentFenceBindings, uninstallSkill } from "./registry.js";
import { completePublish, proposePublish, reviewPublish, revokeSkill } from "./publish.js";
import { distStatus, loadStaging, rollbackSkill, syncDistribution } from "../skill-ops/receiver.js";
import { setSilentMode } from "../skill-ops/policy.js";
import { previewReflux, sendReflux, setRefluxOptIn } from "../skill-ops/reflux.js";
import { signPackage } from "../skill-ops/signature.js";
import { DistMeta, type SkillPackage } from "../skill-ops/types.js";
import { assemblePreset } from "../../runtime/src/assembly.js";

type Scope = { tenantId: string; workspaceId: string };
type RawIdentity = { tenant?: string; workspace?: string };
const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("MC022 full private asset boundaries (owned PostgreSQL)", () => {
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 12 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 12 });
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const run = `mc022-security-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const a: Scope = { tenantId: `tenant-${run}`, workspaceId: `ws-${run}` };
  const b: Scope = { tenantId: a.tenantId, workspaceId: `${a.workspaceId}-other` };
  const c: Scope = { tenantId: `${a.tenantId}-other`, workspaceId: `${a.workspaceId}-joint` };
  const scopes = [a, b, c]; const actor = `member-${run}`;
  const reviewer1 = `${actor}-reviewer1`; const reviewer2 = `${actor}-reviewer2`;
  const ids = new Set<string>(); const observations: unknown[] = [];
  const key = `synthetic-signing-${run}`; const agentId = `agent-${run}`;
  let privateProbe = ""; let foreignProbe = ""; let publicProbe = ""; let ready = false;
  const permissions = new Map<string, { select: boolean; update: boolean }>();
  let faultCounter = 0; const faultNames = new Set<string>();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const identity = (scope: Scope): RawIdentity => ({ tenant: scope.tenantId, workspace: scope.workspaceId });

  async function raw<T extends pg.QueryResultRow = pg.QueryResultRow>(pool: pg.Pool, input: RawIdentity,
    action: (client: pg.PoolClient) => Promise<pg.QueryResult<T>>): Promise<pg.QueryResult<T>> {
    const client = await pool.connect(); let destroy = false;
    try {
      await client.query("BEGIN");
      // Explicitly clear both settings even if this physical connection was used in an earlier case.
      await client.query("SELECT set_config('app.tenant_id','',true),set_config('app.workspace_id','',true)");
      if (input.tenant !== undefined) await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenant]);
      if (input.workspace !== undefined) await client.query("SELECT set_config('app.workspace_id',$1,true)", [input.workspace]);
      const result = await action(client); await client.query("COMMIT"); return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { destroy = true; throw new AggregateError([error, rollbackError], "Security probe query and rollback failed"); }
      throw error;
    } finally { client.release(destroy); }
  }
  const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(pool: pg.Pool, input: RawIdentity,
    sql: string, values: unknown[] = []) => raw<T>(pool, input, (client) => client.query<T>(sql, values));
  async function draft(scope: Scope, name: string, description = "synthetic private draft", bindings: string[] = []) {
    const result = await createSkillDraft(app, gateway, scope, {
      name, description, fenceBindings: bindings, by: actor,
      triplet: { trigger: "synthetic daily trigger", steps: ["read a local synthetic count"], boundary: "request human review" },
    });
    ids.add(result.skillId); return result;
  }
  const publicId = (label: string) => { const id = `skill-o-${run}-${label}`; ids.add(id); return id; };
  const packageFor = (id: string, version = "1.0.0", meta: Partial<ReturnType<typeof DistMeta.parse>> = {}): SkillPackage => {
    const pkg = { skillId: id, name: "synthetic public distribution", version, description: "synthetic public data",
      body: `# Synthetic public ${version}\n\n## 触发（何时用）\n每天\n\n## 步骤（怎么做）\n1. 查询\n\n## 边界（什么不做）\n由人审批`,
      fenceBindings: [] as string[], meta: DistMeta.parse(meta) };
    return { ...pkg, signature: signPackage(key, pkg) };
  };
  const sync = (scope: Scope, pkg: SkillPackage) => syncDistribution(app, gateway, scope, {
    registryUrl: "owned-synthetic-registry", signingKey: key, instance: { bundles: [], edition: "community" }, by: actor,
    fetcher: async () => ({ registryVersion: `${run}-${pkg.version}`, publishedAt: new Date().toISOString(), entries: [{ targets: {}, package: pkg }] }),
  });
  async function proposal(id: string, scope = a) {
    const skill = await getSkill(app, id, scope); expect(skill).not.toBeNull();
    return proposePublish(app, gateway, scope, { skillId: id, skillName: skill!.name, body: skill!.body, description: skill!.description, by: actor });
  }
  async function approve(id: string) {
    const p = await proposal(id);
    await reviewPublish(app, gateway, a, { reviewId: p.reviewId, by: reviewer1, gesture: "approve" });
    await reviewPublish(app, gateway, a, { reviewId: p.reviewId, by: reviewer2, gesture: "approve" });
    return p;
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.DATABASE_GATEWAY_URL) throw new Error("Explicit owned owner/app/gateway URLs required");
    const roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    expect(roles).toHaveLength(2); for (const role of roles) { expect(role.rolsuper).toBe(false); expect(role.rolbypassrls).toBe(false); }
    const grants = (await owner.query(`SELECT role,table_name,has_table_privilege(role,table_name,'SELECT') AS select,
      has_table_privilege(role,table_name,'UPDATE') AS update FROM unnest(ARRAY['workloom_app','workloom_gateway']) role
      CROSS JOIN unnest(ARRAY['skill_installs','skill_publish_reviews','skill_dist_staging','skill_dist_snapshots',
      'skill_dist_policy','skill_dist_state','skill_reflux_outbox']) table_name`)).rows;
    for (const grant of grants) permissions.set(`${grant.role}:${grant.table_name}`, grant);
    expect((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses).toBe("");
    for (const tenant of [...new Set(scopes.map((scope) => scope.tenantId))]) await owner.query("INSERT INTO tenants(id,name) VALUES($1,'synthetic security fixture')", [tenant]);
    for (const scope of scopes) {
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'synthetic security fixture',$1,'general','operating')", [scope.workspaceId, scope.tenantId]);
      await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'general','{\"synthetic\":true}')", [scope.workspaceId, scope.tenantId]);
    }
    for (const [member, role] of [[actor, "owner"], [reviewer1, "manager"], [reviewer2, "manager"]]) {
      await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,$3,$4)", [`id-${member}`, a.workspaceId, member, role]);
    }
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,status,fence_bindings,meta) VALUES($1,$2,'security-probe','synthetic probe','1.0.0','business','ready','[\"PRESET_BASE\"]','{}')", [agentId, a.workspaceId]);
    ready = true;
    privateProbe = (await draft(a, "raw-private-probe")).skillId; foreignProbe = (await draft(b, "raw-foreign-probe")).skillId;
    await dryRunSkill(app, gateway, a, { skillId: privateProbe, by: actor });
    await installSkill(app, gateway, a, { skillId: privateProbe, by: actor });
    await proposal(privateProbe);
    publicProbe = publicId("raw-public-probe"); await sync(a, packageFor(publicProbe));
    await setSilentMode(app, gateway, a, { mode: "silent", by: actor });
    await setRefluxOptIn(app, gateway, a, { optIn: true, by: actor });
    await sendReflux(app, gateway, a, { skillId: privateProbe, by: actor });
    observations.push({ setup: { roles, grants, privateProbe, foreignProbe, publicProbe, actualReviewers: [actor, reviewer1, reviewer2] } });
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      for (const name of faultNames) {
        await owner.query(`DROP TRIGGER IF EXISTS ${name} ON public.biz_events`);
        await owner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
      }
      if (ready) {
        const workspaces = scopes.map((scope) => scope.workspaceId);
        await owner.query("DELETE FROM skill_installs WHERE skill_id=ANY($1::text[])", [[...ids]]);
        await owner.query("DELETE FROM skill_publish_reviews WHERE from_workspace_id=ANY($1::text[])", [workspaces]);
        for (const table of ["skill_dist_staging", "skill_dist_snapshots", "skill_reflux_outbox", "skill_dist_policy", "skill_dist_state", "approvals"]) await owner.query(`DELETE FROM ${table} WHERE workspace_id=ANY($1::text[])`, [workspaces]);
        await owner.query("DELETE FROM skill_revocations WHERE skill_id=ANY($1::text[])", [[...ids]]);
        await owner.query("DELETE FROM skills WHERE id=ANY($1::text[])", [[...ids]]);
        await owner.query("DELETE FROM agents WHERE workspace_id=ANY($1::text[])", [workspaces]);
        await owner.query("DELETE FROM members WHERE workspace_id=ANY($1::text[])", [workspaces]);
        await owner.query("DELETE FROM profiles WHERE workspace_id=ANY($1::text[])", [workspaces]);
        const remaining = (await owner.query("SELECT id FROM skills WHERE id=ANY($1::text[])", [[...ids]])).rows;
        expect(remaining).toEqual([]); observations.push({ cleanup: { removedSkillIds: [...ids], remaining, auditRowsRetained: (await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=ANY($1::text[])", [workspaces])).rows[0].n } });
      }
      if (process.env.SKILLS_NAMESPACE_SECURITY_FACTS_PATH) writeFileSync(process.env.SKILLS_NAMESPACE_SECURITY_FACTS_PATH, JSON.stringify({ run, scopes, observations }, null, 2) + "\n", { flag: "wx" });
    } catch (error) { errors.push(error); }
    const closed = await Promise.allSettled([app.end(), gateway.end(), owner.end()]);
    for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, "Security evidence/cleanup/pool closure failed");
  });

  const rawScopeCases = [
    { label: "neither identity", get: (): RawIdentity => ({}) },
    { label: "tenant only", get: (): RawIdentity => ({ tenant: a.tenantId }) },
    { label: "workspace only", get: (): RawIdentity => ({ workspace: a.workspaceId }) },
    { label: "wrong registered tenant", get: (): RawIdentity => ({ tenant: c.tenantId, workspace: a.workspaceId }) },
    { label: "blank tenant", get: (): RawIdentity => ({ tenant: "", workspace: a.workspaceId }) },
    { label: "blank workspace", get: (): RawIdentity => ({ tenant: a.tenantId, workspace: "" }) },
    { label: "whitespace tenant", get: (): RawIdentity => ({ tenant: " \t", workspace: a.workspaceId }) },
    { label: "whitespace workspace", get: (): RawIdentity => ({ tenant: a.tenantId, workspace: " \t" }) },
  ];
  for (const [role, pool] of [["app", app], ["gateway", gateway]] as const) {
    for (const item of rawScopeCases) it(`raw ${role}: ${item.label} cannot SELECT/update/install private data or read its seven scoped tables`, async () => {
      const input = item.get(); const measured: Record<string, unknown> = {};
      measured.private = (await query(pool, input, "SELECT id,body FROM skills WHERE id=$1", [privateProbe])).rows;
      expect(measured.private).toEqual([]);
      expect((await query(pool, input, "SELECT body FROM skills WHERE id=$1", [publicProbe])).rowCount).toBe(1);
      expect((await query(pool, input, "UPDATE skills SET description='forbidden' WHERE id=$1", [privateProbe])).rowCount).toBe(0);
      await expect(query(pool, input, "INSERT INTO skill_installs(skill_id,workspace_id,installed_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [privateProbe, a.workspaceId, actor])).rejects.toMatchObject({ code: "42501" });
      for (const table of ["skill_installs", "skill_publish_reviews", "skill_dist_staging", "skill_dist_snapshots", "skill_dist_policy", "skill_dist_state", "skill_reflux_outbox"]) {
        const column = table === "skill_publish_reviews" ? "from_workspace_id" : "workspace_id";
        measured[table] = (await query(pool, input, `SELECT * FROM ${table} WHERE ${column}=$1`, [a.workspaceId])).rows;
        expect(measured[table]).toEqual([]);
        const write = () => query(pool, input, `UPDATE ${table} SET ${column}=${column} WHERE ${column}=$1`, [a.workspaceId]);
        if (permissions.get(`workloom_${role}:${table}`)!.update) expect((await write()).rowCount).toBe(0);
        else await expect(write()).rejects.toMatchObject({ code: "42501" });
      }
      await expect(query(pool, input, "SELECT public.skill_revoke($1,'invalid scope probe',$2)", [privateProbe, actor])).rejects.toMatchObject({ code: "42501" });
      observations.push({ case: `raw-${role}-${item.label}`, identity: input, measured });
    });
    it(`raw ${role}: valid exact double identity reads/updates its own rows, but cannot read/update/install foreign assets`, async () => {
      expect((await query(pool, identity(a), "SELECT body FROM skills WHERE id=$1", [privateProbe])).rowCount).toBe(1);
      expect((await query(pool, identity(a), "UPDATE skills SET description=description WHERE id=$1", [privateProbe])).rowCount).toBe(1);
      expect((await query(pool, identity(a), "SELECT id,body FROM skills WHERE id=$1", [foreignProbe])).rows).toEqual([]);
      expect((await query(pool, identity(a), "UPDATE skills SET description='forbidden' WHERE id=$1", [foreignProbe])).rowCount).toBe(0);
      await expect(query(pool, identity(a), "INSERT INTO skill_installs(skill_id,workspace_id,installed_by) VALUES($1,$2,$3)", [foreignProbe, a.workspaceId, actor])).rejects.toMatchObject({ code: "42501" });
      await expect(query(pool, identity(a), "UPDATE skills SET owner_workspace_id=$2 WHERE id=$1", [privateProbe, b.workspaceId])).rejects.toMatchObject({ code: "42501" });
      await expect(query(pool, identity(a), "UPDATE skills SET level='official',ownership_state='shared' WHERE id=$1", [privateProbe])).rejects.toMatchObject({ code: "42501" });
      for (const table of ["skill_installs", "skill_publish_reviews", "skill_dist_staging", "skill_dist_snapshots", "skill_dist_policy", "skill_dist_state", "skill_reflux_outbox"]) {
        const column = table === "skill_publish_reviews" ? "from_workspace_id" : "workspace_id";
        expect((await query(pool, identity(a), `SELECT * FROM ${table} WHERE ${column}=$1`, [a.workspaceId])).rowCount).toBeGreaterThan(0);
        const write = () => query(pool, identity(a), `UPDATE ${table} SET ${column}=${column} WHERE ${column}=$1`, [a.workspaceId]);
        if (permissions.get(`workloom_${role}:${table}`)!.update) expect((await write()).rowCount).toBeGreaterThan(0);
        else await expect(write()).rejects.toMatchObject({ code: "42501" });
      }
      observations.push({ case: `raw-${role}-positive-and-foreign-negative`, owner: (await owner.query("SELECT owner_tenant_id,owner_workspace_id,ownership_state FROM skills WHERE id=$1", [privateProbe])).rows[0] });
    });
    it(`raw ${role}: SECURITY DEFINER revocation ignores attacker temp tables and caller search_path`, async () => {
      await expect(raw(pool, identity(a), async (client) => {
        await client.query("SET LOCAL search_path TO pg_temp,public");
        await client.query("CREATE TEMP TABLE workspaces(id text,tenant_id text) ON COMMIT DROP");
        await client.query("CREATE TEMP TABLE skills(id text,ownership_state text,owner_tenant_id text,owner_workspace_id text) ON COMMIT DROP");
        await client.query("CREATE TEMP TABLE skill_revocations(skill_id text,reason text,revoked_by text) ON COMMIT DROP");
        await client.query("INSERT INTO pg_temp.workspaces VALUES($1,$2)", [a.workspaceId, a.tenantId]);
        await client.query("INSERT INTO pg_temp.skills VALUES($1,'owned',$2,$3)", [foreignProbe, a.tenantId, a.workspaceId]);
        return client.query("SELECT public.skill_revoke($1,'temp shadow attempt',$2)", [foreignProbe, actor]);
      })).rejects.toMatchObject({ code: "42501" });
      expect((await owner.query("SELECT skill_id FROM skill_revocations WHERE skill_id=$1", [foreignProbe])).rows).toEqual([]);
      const own = await draft(a, `direct-revoke-${role}`);
      expect((await query(pool, identity(a), "SELECT public.skill_revoke($1,'actual own revoke',$2) AS result", [own.skillId, actor])).rows[0]!.result).toBe(true);
      expect((await query(pool, identity(a), "SELECT public.skill_revoke($1,'idempotent own revoke',$2) AS result", [own.skillId, actor])).rows[0]!.result).toBe(false);
    });
  }

  it("connections reused by both pools cannot retain an earlier private identity", async () => {
    for (const pool of [app, gateway]) {
      await query(pool, identity(a), "SELECT id FROM skills WHERE id=$1", [privateProbe]);
      const client = await pool.connect();
      try {
        const scope = (await client.query("SELECT current_setting('app.tenant_id',true) AS tenant,current_setting('app.workspace_id',true) AS workspace")).rows[0];
        expect(scope.tenant ?? "").toBe(""); expect(scope.workspace ?? "").toBe("");
        expect((await client.query("SELECT body FROM skills WHERE id=$1", [privateProbe])).rows).toEqual([]);
      } finally { client.release(); }
    }
  });

  it("eight concurrent drafts serialize into one actual owner and eight exact versions/events", async () => {
    const name = "concurrent-logical-key";
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => draft(a, name, `concurrent body ${n}`)));
    expect(new Set(results.map((row) => row.skillId)).size).toBe(1);
    expect(results.map((row) => row.version).sort()).toEqual(Array.from({ length: 8 }, (_, n) => `1.${n}.0`));
    const events = (await owner.query("SELECT payload->'decision'->'after'->>'version' AS version FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 AND payload->'decision'->>'action'='skill.draft.created' ORDER BY seq", [a.workspaceId, results[0]!.skillId])).rows;
    expect(events.map((row) => row.version)).toEqual(Array.from({ length: 8 }, (_, n) => `1.${n}.0`));
    expect((await owner.query("SELECT owner_tenant_id,owner_workspace_id,version FROM skills WHERE id=$1", [results[0]!.skillId])).rows[0]).toMatchObject({ owner_tenant_id: a.tenantId, owner_workspace_id: a.workspaceId, version: "1.7.0" });
    observations.push({ case: "concurrent-eight-drafts", results, events });
  });

  it("concurrent cross-tenant legacy delimiter collisions remain separate and fallback iterations keep their ID", async () => {
    const results = await Promise.all([draft(a, "joint-race", "tenant A"), draft(c, "race", "tenant C")]);
    expect(teamSkillId("joint-race", a.workspaceId)).toBe(teamSkillId("race", c.workspaceId));
    expect(results[0]!.skillId).not.toBe(results[1]!.skillId);
    const next = await Promise.all([draft(a, "joint-race", "tenant A updated"), draft(c, "race", "tenant C updated")]);
    for (let n = 0; n < 2; n++) expect(next[n]).toEqual({ skillId: results[n]!.skillId, version: "1.1.0" });
    for (const [scope, expected] of [[a, "tenant A updated"], [c, "tenant C updated"]] as const) expect((await listSkills(app, scope, { level: "team" })).find((row) => row.id === results[scope === a ? 0 : 1]!.skillId)?.description).toBe(expected);
    observations.push({ case: "concurrent-collision-fallback-stability", results, next });
  });

  it("a dry-run for the previous version cannot authorize installation of a new private body", async () => {
    const first = await draft(a, "version-bound-preview");
    await dryRunSkill(app, gateway, a, { skillId: first.skillId, by: actor });
    const next = await draft(a, "version-bound-preview", "new current body");
    await expect(installSkill(app, gateway, a, { skillId: next.skillId, by: actor })).rejects.toMatchObject({ code: "NEED_DRY_RUN" });
    expect((await owner.query("SELECT skill_id FROM skill_installs WHERE skill_id=$1", [next.skillId])).rows).toEqual([]);
    await dryRunSkill(app, gateway, a, { skillId: next.skillId, by: actor });
    await installSkill(app, gateway, a, { skillId: next.skillId, by: actor });
    expect((await owner.query("SELECT installed_version FROM skill_installs WHERE skill_id=$1", [next.skillId])).rows[0].installed_version).toBe(next.version);
  });

  it("shared official library remains readable/installable and industry still follows its original source gate", async () => {
    expect((await getSkill(app, publicProbe))?.body).toContain("Synthetic public");
    await installSkill(app, gateway, c, { skillId: publicProbe, by: actor });
    const industry = publicId("shared-industry");
    await query(app, identity(a), "INSERT INTO skills(id,level,name,version,description,body,desensitized) VALUES($1,'industry','synthetic industry','1.0.0','shared','shared industry body',true)", [industry]);
    expect((await getSkill(app, industry))?.ownership_state).toBe("shared");
    expect((await listSkills(app, c, { level: "industry" })).some((row) => row.id === industry)).toBe(true);
    await expect(installSkill(app, gateway, c, { skillId: industry, by: actor })).rejects.toMatchObject({ code: "NOT_SIGNED" });
    const reserved = `skill-t-${run}-fake-official`; ids.add(reserved);
    await expect(query(app, identity(a), "INSERT INTO skills(id,level,name,version,description,body) VALUES($1,'official','fake','1.0.0','fake','fake')", [reserved])).rejects.toMatchObject({ code: "42501" });
  });

  it("a clean caller text cannot publish a dirty actual database body or name", async () => {
    for (const field of ["body", "name"] as const) {
      const d = await draft(a, `actual-content-${field}`);
      await query(app, identity(a), `UPDATE skills SET ${field}='synthetic password=fixture' WHERE id=$1`, [d.skillId]);
      await expect(proposePublish(app, gateway, a, { skillId: d.skillId, skillName: "clean", body: "clean", description: "clean", by: actor })).rejects.toMatchObject({ code: "PUBLISH_SCAN_FAILED" });
      expect((await owner.query("SELECT id FROM skill_publish_reviews WHERE skill_id=$1", [d.skillId])).rows).toEqual([]);
      expect((await getSkill(app, d.skillId, a))?.level).toBe("team");
    }
  });

  for (const field of ["name", "body", "description", "fence_bindings", "version"] as const) it(`approved snapshot refuses changed ${field} without exposing current private content`, async () => {
    const d = await draft(a, `stale-review-${field}`); const p = await approve(d.skillId);
    const values: unknown = field === "fence_bindings" ? JSON.stringify(["CHANGED_SCOPE"]) : field === "version" ? "2.0.0" : `changed ${field}`;
    await query(app, identity(a), `UPDATE skills SET ${field}=$2 WHERE id=$1`, [d.skillId, values]);
    await expect(completePublish(app, gateway, a, { reviewId: p.reviewId, by: reviewer1 })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    expect((await getSkill(app, d.skillId, a))?.level).toBe("team"); expect(await getSkill(app, d.skillId)).toBeNull();
    expect((await owner.query("SELECT status FROM skill_publish_reviews WHERE id=$1", [p.reviewId])).rows[0].status).toBe("approved");
  });

  it("pending stale reviews are retained as rejected and a fresh proposal requires two new reviewers", async () => {
    const first = await draft(a, "pending-review-iteration"); const old = await proposal(first.skillId);
    await reviewPublish(app, gateway, a, { reviewId: old.reviewId, by: reviewer1, gesture: "approve" });
    await draft(a, "pending-review-iteration", "updated after first reviewer");
    const fresh = await proposal(first.skillId); expect(fresh.reviewId).not.toBe(old.reviewId);
    expect((await owner.query("SELECT status,reason FROM skill_publish_reviews WHERE id=$1", [old.reviewId])).rows[0]).toMatchObject({ status: "rejected", reason: "content_changed_before_review" });
    await expect(completePublish(app, gateway, a, { reviewId: fresh.reviewId, by: reviewer1 })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    await expect(reviewPublish(app, gateway, a, { reviewId: fresh.reviewId, by: actor, gesture: "approve" })).rejects.toMatchObject({ code: "SELF_REVIEW_FORBIDDEN" });
    await reviewPublish(app, gateway, a, { reviewId: fresh.reviewId, by: reviewer1, gesture: "approve" });
    await expect(reviewPublish(app, gateway, a, { reviewId: fresh.reviewId, by: reviewer1, gesture: "approve" })).rejects.toMatchObject({ code: "DUPLICATE_REVIEW" });
    await reviewPublish(app, gateway, a, { reviewId: fresh.reviewId, by: reviewer2, gesture: "approve" });
    await completePublish(app, gateway, a, { reviewId: fresh.reviewId, by: reviewer1 });
    expect((await getSkill(app, first.skillId, b))?.level).toBe("industry");
  });

  it("a completed private-origin publication freezes reviewed shared content against raw owner edits", async () => {
    const d = await draft(a, "published-content-freeze"); const p = await approve(d.skillId);
    await completePublish(app, gateway, a, { reviewId: p.reviewId, by: reviewer1 });
    const before = (await owner.query("SELECT to_jsonb(s) AS row FROM skills s WHERE id=$1", [d.skillId])).rows[0].row;
    for (const [sql, value] of [
      ["body", "synthetic password=fixture"], ["name", "private name changed"], ["description", "private description changed"],
      ["version", "2.0.0"], ["fence_bindings", JSON.stringify(["PRIVATE_CHANGED"])], ["desensitized", false],
      ["bundle", "private-unreviewed-bundle"], ["dist_meta", JSON.stringify({ private: "unreviewed" })],
    ] as const) {
      const attempted = await query(app, identity(a), `UPDATE skills SET ${sql}=$2 WHERE id=$1`, [d.skillId, value])
        .then((result) => ({ rowCount: result.rowCount, errorCode: null as string | null }))
        .catch((error: { code?: string }) => ({ rowCount: null, errorCode: error.code ?? "unclassified" }));
      const foreignView = await getSkill(app, d.skillId, b);
      observations.push({ case: `published-private-origin-raw-${sql}`, attempted, foreignView });
      expect(attempted.errorCode).toBe("42501");
    }
    expect((await owner.query("SELECT to_jsonb(s) AS row FROM skills s WHERE id=$1", [d.skillId])).rows[0].row).toEqual(before);
    expect((await getSkill(app, d.skillId, b))?.body).toBe(before.body);
    observations.push({ case: "published-private-origin-content-freeze", rowHash: hash(before), retainedOwner: [before.owner_tenant_id, before.owner_workspace_id] });
  });

  it("actual signed private-prefix receiver rejection stores no private package in staging or snapshots", async () => {
    const own = await getSkill(app, foreignProbe, b); const pkg = packageFor(foreignProbe, "9.0.0");
    const r = await sync(a, pkg); expect(r.rejected).toHaveLength(1); expect(r.loaded).toEqual([]);
    expect((await owner.query("SELECT id FROM skill_dist_staging WHERE skill_id=$1", [foreignProbe])).rows).toEqual([]);
    expect((await owner.query("SELECT id FROM skill_dist_snapshots WHERE skill_id=$1", [foreignProbe])).rows).toEqual([]);
    expect(await getSkill(app, foreignProbe, b)).toEqual(own); await expect(previewReflux(app, a, foreignProbe)).rejects.toThrow();
  });

  it("prompt and L2 staging IDs include exact scope and foreign manual loads cannot use another approval", async () => {
    for (const tier of ["prompt", "L2"] as const) {
      const id = publicId(`scope-staging-${tier}`);
      const pkg = packageFor(id, "1.0.0", tier === "L2" ? { category: "tool-execution", toolWhitelist: ["synthetic.read"] } : {});
      if (tier === "prompt") for (const scope of [a, b]) await setSilentMode(app, gateway, scope, { mode: "prompt", by: actor });
      const [ra, rb] = await Promise.all([sync(a, pkg), sync(b, pkg)]);
      expect(ra.pending).toHaveLength(1); expect(rb.pending).toHaveLength(1);
      const sa = ra.pending[0]!; const sb = rb.pending[0]!; expect(sa.stagingId).not.toBe(sb.stagingId);
      await expect(loadStaging(app, gateway, b, { stagingId: sa.stagingId, by: actor })).rejects.toMatchObject({ code: "NOT_FOUND" });
      if (tier === "L2") {
        expect(sa.approvalId).not.toBe(sb.approvalId);
        await expect(loadStaging(app, gateway, a, { stagingId: sa.stagingId, by: actor })).rejects.toMatchObject({ code: "NOT_APPROVED" });
        await query(app, identity(a), "UPDATE approvals SET status='approved' WHERE approval_id=$1", [sa.approvalId]);
      }
      expect((await loadStaging(app, gateway, a, { stagingId: sa.stagingId, by: actor })).skillId).toBe(id);
      expect((await distStatus(app, b)).staging.some((row) => row.id === sb.stagingId)).toBe(true);
      observations.push({ case: `scoped-staging-${tier}`, sa, sb });
      for (const scope of [a, b]) await setSilentMode(app, gateway, scope, { mode: "silent", by: actor });
    }
  });

  it("another workspace's newer public load prevents a stale rollback, while valid reverse order still restores history", async () => {
    const id = publicId("stale-public-rollback");
    await sync(a, packageFor(id, "1.0.0")); await sync(a, packageFor(id, "2.0.0")); await sync(b, packageFor(id, "3.0.0"));
    const snapshots = (await owner.query("SELECT to_jsonb(s) AS row FROM skill_dist_snapshots s WHERE skill_id=$1 ORDER BY id", [id])).rows;
    await expect(rollbackSkill(app, gateway, a, { skillId: id, by: actor })).rejects.toMatchObject({ code: "BAD_STATE" });
    expect((await getSkill(app, id))?.version).toBe("3.0.0");
    expect((await owner.query("SELECT to_jsonb(s) AS row FROM skill_dist_snapshots s WHERE skill_id=$1 ORDER BY id", [id])).rows).toEqual(snapshots);
    expect((await rollbackSkill(app, gateway, b, { skillId: id, by: actor })).restoredVersion).toBe("2.0.0");
    expect((await rollbackSkill(app, gateway, a, { skillId: id, by: actor })).restoredVersion).toBe("1.0.0");
  });

  it("first-load removal refuses foreign installs and restores its consumed snapshot after the FK failure", async () => {
    const id = publicId("foreign-install-removal"); await sync(a, packageFor(id));
    await installSkill(app, gateway, b, { skillId: id, by: actor });
    const before = (await owner.query("SELECT to_jsonb(s) AS row FROM skill_dist_snapshots s WHERE skill_id=$1", [id])).rows;
    await expect(rollbackSkill(app, gateway, a, { skillId: id, by: actor })).rejects.toMatchObject({ code: "BAD_STATE" });
    expect((await owner.query("SELECT to_jsonb(s) AS row FROM skill_dist_snapshots s WHERE skill_id=$1", [id])).rows).toEqual(before);
    expect((await getSkill(app, id))?.version).toBe("1.0.0");
    await uninstallSkill(app, gateway, b, { skillId: id, by: actor });
    expect((await rollbackSkill(app, gateway, a, { skillId: id, by: actor })).restoredVersion).toBeNull();
    expect(await getSkill(app, id)).toBeNull(); expect((await owner.query("SELECT id FROM skill_dist_snapshots WHERE skill_id=$1", [id])).rows).toEqual([]);
  });

  it("both runtime binding paths exclude physically retained foreign, quarantined and revoked installs", async () => {
    const foreign = await draft(b, "runtime-foreign"); const revoked = await draft(a, "runtime-revoked");
    await dryRunSkill(app, gateway, a, { skillId: revoked.skillId, by: actor }); await installSkill(app, gateway, a, { skillId: revoked.skillId, by: actor });
    await revokeSkill(app, gateway, a, { skillId: revoked.skillId, reason: "synthetic revoke", by: actor });
    const quarantine = `skill-t-${run}-runtime-quarantine`; ids.add(quarantine);
    await owner.query("INSERT INTO skills(id,level,name,version,description,body,ownership_state,ownership_reason) VALUES($1,'team','quarantined','1.0.0','retained','retained synthetic body','quarantined','no_authoritative_draft')", [quarantine]);
    for (const [id, binding] of [[foreign.skillId, "FOREIGN_INSTALL"], [quarantine, "QUARANTINED_INSTALL"]]) await owner.query("INSERT INTO skill_installs(skill_id,workspace_id,installed_by,fence_bindings_snapshot) VALUES($1,$2,$3,$4)", [id, a.workspaceId, actor, JSON.stringify([binding])]);
    await owner.query("UPDATE skill_installs SET fence_bindings_snapshot='[\"REVOKED_INSTALL\"]' WHERE skill_id=$1 AND workspace_id=$2", [revoked.skillId, a.workspaceId]);
    const resolved = await resolveAgentFenceBindings(app, a, agentId);
    const assembled = await assemblePreset(app, a, { workspaceId: a.workspaceId, presetKey: "security-probe", goal: "synthetic runtime boundary" });
    for (const bindings of [resolved, assembled.fenceBindings]) {
      expect(bindings).toContain("PRESET_BASE");
      for (const blocked of ["FOREIGN_INSTALL", "QUARANTINED_INSTALL", "REVOKED_INSTALL"]) expect(bindings).not.toContain(blocked);
    }
    expect((await owner.query("SELECT skill_id FROM skill_installs WHERE skill_id=ANY($1::text[]) AND workspace_id=$2", [[foreign.skillId, quarantine, revoked.skillId], a.workspaceId])).rowCount).toBe(3);
    observations.push({ case: "runtime-retained-invalid-installs", resolved, assembled: assembled.fenceBindings });
  });

  async function businessSnapshot(id: string) {
    const state: Record<string, unknown> = {};
    for (const [table, column, order] of [["skills", "id", "id"], ["skill_installs", "skill_id", "workspace_id"], ["skill_publish_reviews", "skill_id", "id"], ["skill_revocations", "skill_id", "skill_id"]]) state[table!] = (await owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${column}=$1 ORDER BY ${order}`, [id])).rows;
    state.biz_events = (await owner.query("SELECT to_jsonb(e) AS row FROM biz_events e WHERE workspace_id=$1 ORDER BY seq", [a.workspaceId])).rows;
    return state;
  }
  async function fault(action: string, deferred: boolean, call: () => Promise<unknown>) {
    const name = `mc022_fail_${run.replace(/[^a-z0-9]/g, "").slice(-22)}_${++faultCounter}`; faultNames.add(name);
    const sql = `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='${a.tenantId}' AND NEW.workspace_id='${a.workspaceId}' AND NEW.payload->'decision'->>'action'='${action}'
      THEN RAISE EXCEPTION 'owned MC022 ${deferred ? "deferred COMMIT" : "BEFORE append"} fault' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`;
    await owner.query(sql);
    await owner.query(deferred
      ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON public.biz_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${name}()`
      : `CREATE TRIGGER ${name} BEFORE INSERT ON public.biz_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try { await expect(call()).rejects.toMatchObject({ code: "P0001" }); }
    finally { await owner.query(`DROP TRIGGER ${name} ON public.biz_events`); await owner.query(`DROP FUNCTION public.${name}()`); faultNames.delete(name); }
  }
  const operations = ["forge", "dry-run", "install", "uninstall", "propose", "review", "complete", "revoke"] as const;
  for (const deferred of [false, true]) for (const operation of operations) it(`${operation}: actual ${deferred ? "deferred COMMIT" : "BEFORE event append"} failure leaves no partial business/audit state and permits exactly one retry`, async () => {
    const label = `fault-${deferred ? "commit" : "append"}-${operation}`;
    let id = teamSkillId(label, a.workspaceId); ids.add(id);
    let reviewId = ""; let call: () => Promise<unknown>; let action: string;
    if (operation !== "forge") id = (await draft(a, label)).skillId;
    if (operation === "install" || operation === "uninstall") await dryRunSkill(app, gateway, a, { skillId: id, by: actor });
    if (operation === "uninstall") await installSkill(app, gateway, a, { skillId: id, by: actor });
    if (operation === "review") reviewId = (await proposal(id)).reviewId;
    if (operation === "complete") reviewId = (await approve(id)).reviewId;
    switch (operation) {
      case "forge": action = "skill.draft.created"; call = () => draft(a, label); break;
      case "dry-run": action = "skill.dry_run"; call = () => dryRunSkill(app, gateway, a, { skillId: id, by: actor }); break;
      case "install": action = "skill.installed"; call = () => installSkill(app, gateway, a, { skillId: id, by: actor }); break;
      case "uninstall": action = "skill.uninstalled"; call = () => uninstallSkill(app, gateway, a, { skillId: id, by: actor }); break;
      case "propose": action = "skill.publish.propose"; call = () => proposal(id); break;
      case "review": action = "skill.publish.approve"; call = () => reviewPublish(app, gateway, a, { reviewId, by: reviewer1, gesture: "approve" }); break;
      case "complete": action = "skill.publish.complete"; call = () => completePublish(app, gateway, a, { reviewId, by: reviewer1 }); break;
      case "revoke": action = "skill.revoke"; call = () => revokeSkill(app, gateway, a, { skillId: id, reason: "synthetic fault matrix", by: actor }); break;
    }
    const before = await businessSnapshot(id); await fault(action, deferred, call);
    const failed = await businessSnapshot(id); expect(failed).toEqual(before);
    const retry = await call(); const after = await businessSnapshot(id);
    expect((after.biz_events as unknown[]).length).toBe((before.biz_events as unknown[]).length + 1);
    switch (operation) {
      case "forge": expect(after.skills).toHaveLength(1); break;
      case "install": expect(after.skill_installs).toHaveLength(1); break;
      case "uninstall": expect(after.skill_installs).toEqual([]); break;
      case "propose": expect(after.skill_publish_reviews).toHaveLength(1); break;
      case "review": expect((after.skill_publish_reviews as Array<{ row: { approvals: unknown[] } }>)[0]!.row.approvals).toHaveLength(1); break;
      case "complete": expect((after.skills as Array<{ row: { level: string } }>)[0]!.row.level).toBe("industry"); expect((after.skill_publish_reviews as Array<{ row: { status: string } }>)[0]!.row.status).toBe("completed"); break;
      case "revoke": expect(after.skill_revocations).toHaveLength(1); break;
      case "dry-run": expect(after.skills).toEqual(before.skills); break;
    }
    observations.push({ case: label, stage: action, beforeHash: hash(before), failedHash: hash(failed), retry, auditIncrement: 1 });
  });
});
