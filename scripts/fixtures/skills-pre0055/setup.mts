/** CI fixture: six byte-frozen pre-0055 modules execute real synthetic writes with current public dependencies.
 * This is a targeted migration fixture, not a complete historical product replay.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createSkillDraft, dryRunSkill } from "../packages/base/skills/forge.js";
import { getSkill, installSkill } from "../packages/base/skills/registry.js";
import { proposePublish, reviewPublish, completePublish, revokeSkill } from "../packages/base/skills/publish.js";
import { setRefluxOptIn, sendReflux } from "../packages/base/skill-ops/reflux.js";
import { syncDistribution } from "../packages/base/skill-ops/receiver.js";
import { signPackage } from "../packages/base/skill-ops/signature.js";
import { DistMeta, type SkillPackage } from "../packages/base/skill-ops/types.js";
import { gatewayAppend } from "../packages/base/workdata/gateway.js";

type Scope = { tenantId: string; workspaceId: string };
type Row = Record<string, unknown>;
interface Capture { columns: string[]; keys: string[]; rows: Row[]; sha256: string }
interface Manifest {
  run: string; scopes: { a: Scope; b: Scope; c: Scope }; ids: Record<string, string>;
  invalidScopes: Scope[];
  expectedOwnership: Array<{ id: string; state: string; tenant: string | null; workspace: string | null; reason?: string }>;
  expectedSnapshots: Array<{ id: string; version: string | null }>;
  observations: Row[]; tables: Record<string, Capture>;
}
const mode = process.argv[2];
const manifestPath = process.env.SKILLS_NAMESPACE_LEGACY_MANIFEST;
const reportPath = process.env.SKILLS_NAMESPACE_UPGRADE_REPORT;
assert(mode === "prepare" || mode === "verify", "Explicit preparation or verification mode required");
assert(manifestPath && reportPath, "Explicit immutable evidence paths required");
for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
  const value = process.env[key];
  assert(value, `${key} must be explicit`);
  const url = new URL(value);
  assert(url.searchParams.get("host")?.startsWith("/tmp/wl-mc022-pg-"), "Only this runner's owned Unix socket may be used");
  assert.equal(url.pathname, "/skills_namespace");
}
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Row).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const rowKey = (row: Row, keys: string[]) => canonical(keys.map((key) => row[key]));
async function capture(table: string, columns?: string[], keys?: string[]): Promise<Capture> {
  columns ??= (await owner.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map((row) => row.column_name);
  keys ??= (await owner.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
     WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::smallint[],a.attnum)`, [table])).rows.map((row) => row.name);
  assert(columns.length && keys.length, `Full columns and primary keys must exist for ${table}`);
  const rows = (await owner.query<{ row: Row }>(`SELECT to_jsonb(r) AS row FROM (SELECT ${columns.map(ident).join(",")} FROM ${ident(table)}) r ORDER BY ${keys.map(ident).join(",")}`)).rows.map((row) => row.row);
  return { columns, keys, rows, sha256: hash(rows) };
}
const preservedTables = ["skills", "skill_installs", "skill_publish_reviews", "skill_revocations", "skill_dist_staging", "skill_dist_snapshots", "skill_dist_policy", "skill_dist_state", "skill_reflux_outbox", "biz_events", "_migrations"];

try {
  assert.equal((await owner.query("SELECT current_setting('listen_addresses') AS addresses")).rows[0].addresses, "");
  const roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
  assert.equal(roles.length, 2);
  assert(roles.every((row) => !row.rolsuper && !row.rolbypassrls));
  if (mode === "prepare") {
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='skills' AND column_name='owner_tenant_id'")).rows[0].n, 0, "Legacy setup must execute before 0055 exists");
    const run = `mc022-legacy-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const a = { tenantId: `tenant-${run}`, workspaceId: `ws-${run}` };
    const b = { tenantId: a.tenantId, workspaceId: `${a.workspaceId}-other` };
    const c = { tenantId: `tenant-${run}-c`, workspaceId: `${a.workspaceId}-joint` };
    const invalidScopes = [{ tenantId: " \t ", workspaceId: `ws-${run}-blank-tenant` }, { tenantId: a.tenantId, workspaceId: " \n " }];
    const manifest: Manifest = { run, scopes: { a, b, c }, invalidScopes, ids: {}, expectedOwnership: [], expectedSnapshots: [], observations: [], tables: {} };
    for (const tenant of [a.tenantId, c.tenantId, invalidScopes[0]!.tenantId]) await owner.query("INSERT INTO tenants(id,name) VALUES($1,'MC022 owned synthetic legacy tenant')", [tenant]);
    for (const scope of [a, b, c, ...invalidScopes]) {
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'MC022 legacy fixture',$1,'general','ready')", [scope.workspaceId, scope.tenantId]);
      await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'general',$3)", [scope.workspaceId, scope.tenantId, JSON.stringify({ purpose: "MC022 synthetic owned legacy upgrade" })]);
    }
    const by = `member-${run}`;
    const draft = async (scope: Scope, name: string) => createSkillDraft(app, gateway, scope, { name, description: `synthetic old draft ${name}`, triplet: { trigger: "t", steps: ["s"], boundary: "b" }, by });
    for (const [index, scope] of invalidScopes.entries()) {
      const oldBlank = await draft(scope, `legacy-blank-${index}`);
      manifest.ids[`blank${index}`] = oldBlank.skillId;
      manifest.expectedOwnership.push({ id: oldBlank.skillId, state: "quarantined", tenant: null, workspace: null, reason: "draft_scope_mismatch" });
      manifest.observations.push({ case: "actual_old_blank_identity_draft", scope, result: oldBlank });
    }
    const owned = await draft(a, "legacy-owned");
    const ownedAgain = await draft(a, "legacy-owned");
    assert.equal(ownedAgain.skillId, owned.skillId); assert.equal(ownedAgain.version, "1.1.0");
    await dryRunSkill(app, gateway, a, { skillId: owned.skillId, by });
    await installSkill(app, gateway, a, { skillId: owned.skillId, by });
    manifest.ids.owned = owned.skillId;
    manifest.expectedOwnership.push({ id: owned.skillId, state: "owned", tenant: a.tenantId, workspace: a.workspaceId, reason: "unique_authoritative_draft" });

    const foreign = await draft(b, "legacy-foreign");
    await dryRunSkill(app, gateway, a, { skillId: foreign.skillId, by });
    const illicit = await installSkill(app, gateway, a, { skillId: foreign.skillId, by });
    assert.equal(illicit.installed, true, "Old prefix guard must actually permit this historical illegal installation");
    await owner.query("UPDATE skill_installs SET fence_bindings_snapshot='[\"LEGACY_FOREIGN\"]' WHERE skill_id=$1 AND workspace_id=$2", [foreign.skillId, a.workspaceId]);
    manifest.observations.push({ case: "actual_old_foreign_install", scope: a, foreignScope: b, result: illicit, note: "Synthetic binding marker added by fixture owner after real old-product installation" });
    manifest.ids.foreign = foreign.skillId;
    manifest.expectedOwnership.push({ id: foreign.skillId, state: "owned", tenant: b.tenantId, workspace: b.workspaceId });

    const collisionA = await draft(a, "joint-plan"); const collisionC = await draft(c, "plan");
    assert.equal(collisionA.skillId, collisionC.skillId, "Old delimiter collision must be real");
    manifest.ids.ambiguous = collisionA.skillId;
    manifest.expectedOwnership.push({ id: collisionA.skillId, state: "quarantined", tenant: null, workspace: null, reason: "ambiguous_draft_owners" });

    const rawTeam = async (id: string, name: string) => {
      await owner.query("INSERT INTO skills(id,level,name,version,description,body,fence_bindings) VALUES($1,'team',$2,'1.0.0','synthetic raw legacy row','synthetic private legacy body','[]')", [id, name]);
      return id;
    };
    const noProof = await rawTeam(`skill-t-${a.workspaceId}-no-proof`, "legacy-no-proof");
    await owner.query("INSERT INTO skill_installs(skill_id,workspace_id,installed_by,installed_version,fence_bindings_snapshot) VALUES($1,$2,$3,'1.0.0','[\"LEGACY_NO_PROOF\"]')", [noProof, a.workspaceId, by]);
    manifest.ids.noProof = noProof;
    manifest.expectedOwnership.push({ id: noProof, state: "quarantined", tenant: null, workspace: null, reason: "no_authoritative_draft" });
    for (const [key, object] of [["wrongObject", { type: "skill", id: "wrong-object" }], ["missingObjectId", { type: "skill" }]] as const) {
      const id = await rawTeam(`skill-t-${a.workspaceId}-${key}`, key);
      await gatewayAppend(gateway, { ...a, actor: { id: by, type: "human" } }, {
        who: { id: by, type: "human" }, context: { tenant_id: a.tenantId, workspace_id: a.workspaceId, time: new Date().toISOString() },
        object, decision: { action: "skill.draft.created", after: { skillId: id, version: "1.0.0" } }, rule_impact: [],
      });
      manifest.ids[key] = id;
      manifest.expectedOwnership.push({ id, state: "quarantined", tenant: null, workspace: null, reason: "draft_scope_mismatch" });
    }

    const pending = await draft(a, "legacy-approved-private");
    const skill = await getSkill(app, pending.skillId); assert(skill);
    const proposal = await proposePublish(app, gateway, a, { skillId: skill.id, skillName: skill.name, body: skill.body, description: skill.description, by });
    for (const reviewer of [`reviewer-a-${run}`, `reviewer-b-${run}`]) await reviewPublish(app, gateway, a, { reviewId: proposal.reviewId, by: reviewer, gesture: "approve" });
    manifest.ids.legacyApproved = pending.skillId; manifest.ids.legacyReview = proposal.reviewId;
    manifest.expectedOwnership.push({ id: pending.skillId, state: "owned", tenant: a.tenantId, workspace: a.workspaceId });

    const industry = await draft(a, "legacy-published-industry");
    const industryRow = await getSkill(app, industry.skillId); assert(industryRow);
    const industryProposal = await proposePublish(app, gateway, a, { skillId: industryRow.id, skillName: industryRow.name, body: industryRow.body, description: industryRow.description, by });
    for (const reviewer of [`industry-a-${run}`, `industry-b-${run}`]) await reviewPublish(app, gateway, a, { reviewId: industryProposal.reviewId, by: reviewer, gesture: "approve" });
    await completePublish(app, gateway, a, { reviewId: industryProposal.reviewId, by });
    manifest.ids.industry = industry.skillId;
    manifest.expectedOwnership.push({ id: industry.skillId, state: "shared", tenant: null, workspace: null });

    const revoked = await draft(b, "legacy-revoked");
    await dryRunSkill(app, gateway, b, { skillId: revoked.skillId, by });
    await installSkill(app, gateway, b, { skillId: revoked.skillId, by });
    await owner.query("UPDATE skill_installs SET fence_bindings_snapshot='[\"LEGACY_REVOKED\"]' WHERE skill_id=$1 AND workspace_id=$2", [revoked.skillId, b.workspaceId]);
    await revokeSkill(app, gateway, b, { skillId: revoked.skillId, reason: "synthetic legacy revocation", by });
    manifest.ids.revoked = revoked.skillId;
    manifest.expectedOwnership.push({ id: revoked.skillId, state: "owned", tenant: b.tenantId, workspace: b.workspaceId });

    const key = "MC022-local-synthetic-distribution-signature";
    const pkg = (skillId: string, version: string): SkillPackage => {
      const unsigned = { skillId, name: "legacy public distribution", version, description: "synthetic public library", body: `synthetic public body ${version}`, fenceBindings: [], meta: DistMeta.parse({}) };
      return { ...unsigned, signature: signPackage(key, unsigned) };
    };
    const sync = async (scope: Scope, item: SkillPackage) => syncDistribution(app, gateway, scope, {
      registryUrl: "https://mc022.invalid/owned-manifest", signingKey: key, instance: { bundles: ["general"], edition: "community" }, by,
      fetcher: async () => ({ registryVersion: item.version, publishedAt: new Date().toISOString(), entries: [{ targets: {}, package: item }] }),
    });
    const publicId = `skill-public-${run}`;
    assert.equal((await sync(a, pkg(publicId, "1.0.0"))).loaded.length, 1);
    await installSkill(app, gateway, a, { skillId: publicId, by });
    assert.equal((await sync(a, pkg(publicId, "2.0.0"))).loaded.length, 1);
    manifest.ids.public = publicId;
    manifest.expectedOwnership.push({ id: publicId, state: "shared", tenant: null, workspace: null });
    for (const row of (await owner.query("SELECT id,reason FROM skill_dist_snapshots WHERE skill_id=$1 ORDER BY created_at", [publicId])).rows) {
      manifest.expectedSnapshots.push({ id: row.id, version: row.reason.includes("@2.0.0") ? "2.0.0" : "1.0.0" });
    }

    await setRefluxOptIn(app, gateway, a, { optIn: true, by });
    const outbox = await sendReflux(app, gateway, a, { skillId: foreign.skillId, by });
    manifest.ids.foreignOutbox = outbox.outboxId;
    manifest.observations.push({ case: "actual_old_foreign_reflux_cache", outboxId: outbox.outboxId, sourceSkill: foreign.skillId });
    const cache = await draft(b, "legacy-private-cache");
    assert.equal((await sync(a, pkg(cache.skillId, "2.0.0"))).loaded.length, 1, "Old receiver must really overwrite this private body and retain its private snapshot");
    manifest.ids.privateCache = cache.skillId;
    manifest.expectedOwnership.push({ id: cache.skillId, state: "owned", tenant: b.tenantId, workspace: b.workspaceId });
    const privateSnap = (await owner.query("SELECT id FROM skill_dist_snapshots WHERE skill_id=$1", [cache.skillId])).rows[0];
    assert(privateSnap); manifest.ids.privateSnapshot = privateSnap.id;
    const privateStage = (await owner.query("SELECT id FROM skill_dist_staging WHERE skill_id=$1", [cache.skillId])).rows[0];
    assert(privateStage); manifest.ids.privateStaging = privateStage.id;

    const uncertainSnapshot = `snap-unproved-${run}`;
    const publicBefore = (await owner.query("SELECT to_jsonb(s) AS row FROM skills s WHERE id=$1", [publicId])).rows[0].row;
    await owner.query("INSERT INTO skill_dist_snapshots(id,skill_id,workspace_id,skill_row,reason) VALUES($1,$2,$3,$4,'synthetic old cache without a load receipt')", [uncertainSnapshot, publicId, b.workspaceId, JSON.stringify(publicBefore)]);
    manifest.ids.unprovedPublicSnapshot = uncertainSnapshot;
    manifest.expectedSnapshots.push({ id: uncertainSnapshot, version: null });

    // The runner explicitly creates this synthetic unproved row using the historical identifier.
    manifest.expectedOwnership.push({ id: "skill-t-ws-yunqi-weekly-ops-review", state: "quarantined", tenant: null, workspace: null, reason: "no_authoritative_draft" });
    for (const table of preservedTables) manifest.tables[table] = await capture(table);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ mode, run, scopes: manifest.scopes, tables: Object.fromEntries(Object.entries(manifest.tables).map(([table, c]) => [table, { rows: c.rows.length, columns: c.columns.length, sha256: c.sha256 }])), observations: manifest.observations }));
  } else {
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const preservation: Row[] = [];
    for (const [table, before] of Object.entries(manifest.tables)) {
      const after = await capture(table, before.columns, before.keys);
      const current = new Map(after.rows.map((row) => [rowKey(row, before.keys), row]));
      for (const row of before.rows) assert.deepEqual(current.get(rowKey(row, before.keys)), row, `Old row/column changed or disappeared in ${table}`);
      preservation.push({ table, oldRows: before.rows.length, currentRows: after.rows.length, oldColumns: before.columns.length, sha256: before.sha256, oldRowsPreserved: true });
    }
    const ownership: Row[] = [];
    for (const expected of manifest.expectedOwnership) {
      const row = (await owner.query("SELECT id,ownership_state,owner_tenant_id,owner_workspace_id,ownership_reason FROM skills WHERE id=$1", [expected.id])).rows[0];
      assert(row); assert.equal(row.ownership_state, expected.state); assert.equal(row.owner_tenant_id, expected.tenant); assert.equal(row.owner_workspace_id, expected.workspace);
      if (expected.reason) assert.equal(row.ownership_reason, expected.reason);
      ownership.push(row);
    }
    const snapshots: Row[] = [];
    for (const expected of manifest.expectedSnapshots) {
      const row = (await owner.query("SELECT id,loaded_version FROM skill_dist_snapshots WHERE id=$1", [expected.id])).rows[0];
      assert(row); assert.equal(row.loaded_version, expected.version); snapshots.push(row);
    }
    const report = { run: manifest.run, roles, preservation, ownership, snapshots, verified: true, oldEventsRewritten: false, oldMigrationsRewritten: false };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(report));
  }
} finally {
  const ended = await Promise.allSettled([app.end(), gateway.end(), owner.end()]);
  const errors = ended.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Owned legacy helper pool shutdown failed");
}
