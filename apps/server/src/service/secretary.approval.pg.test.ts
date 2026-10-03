/** MC-032/132: actual approval notifications under real restricted PostgreSQL roles. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { closeAllPools, getAppPool } from "@workloom/db";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";
import { runWithServiceScope, requireServiceScope, type ServiceScope } from "./scope.js";
import { inbox, inQuietHours, saveSettings, scan } from "./secretary.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1";
type Tier = "l2_captain" | "l3_fleet" | "l4_chairman";
type Status = "pending" | "approved" | "edited" | "rejected" | "expired";
type Fixture = { scope: ServiceScope; member: string };
type Observe = (label: string, actual: unknown) => void;
type Case = {
  name: string; preconditions: string; steps: string[]; expected: string;
  actual: Array<{ label: string; value: unknown }>; result: "pass" | "fail";
  assertion_error?: { name: string; message: string; code?: string };
};
const actor = { id: "synthetic-secretary-approval-operator", type: "human" as const };
const cases: Case[] = [];
let owner: pg.Pool | undefined;
let fixtureCount = 0;

function fixtureOwner(): pg.Pool {
  if (!owner) throw new Error("Secretary approval fixture owner is not initialized");
  return owner;
}

function requireOwnedDatabase(): void {
  if (process.env.SECRETARY_APPROVAL_TASK_OWNED !== "1"
      || !process.env.SECRETARY_APPROVAL_REPORT_DIR
      || !["base", "hotel"].includes(process.env.RAW_SCOPE_REPO ?? "")) {
    throw new Error("MC032 PostgreSQL tests require the dedicated task-owned runner");
  }
  const socket = process.env.RAW_SCOPE_SOCKET;
  const database = process.env.RAW_SCOPE_DATABASE;
  if (!socket?.startsWith("/tmp/wl-raw-scope-") || !/^raw_scope_(base|hotel)_[a-f0-9]{10}$/.test(database ?? "")) {
    throw new Error("MC032 fixture must use its private Unix socket and synthetic database");
  }
  for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
    const value = process.env[key];
    if (!value) throw new Error(`MC032 fixture requires ${key}`);
    const url = new URL(value);
    if (url.hostname !== "localhost" || url.searchParams.get("host") !== socket
        || url.pathname !== `/${database}` || url.password) {
      throw new Error(`MC032 ${key} does not point at the task-owned synthetic database`);
    }
  }
  if (process.env.LLM_PROVIDER !== "mock") throw new Error("MC032 fixtures must not call a real model");
}

async function workspace(tenantId?: string): Promise<ServiceScope> {
  const suffix = `${process.env.RAW_SCOPE_NONCE}-${++fixtureCount}-${randomUUID().slice(0, 8)}`;
  const scope = { tenantId: tenantId ?? `mc032-tenant-${suffix}`, workspaceId: `mc032-ws-${suffix}` };
  if (!tenantId) await fixtureOwner().query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic approval tenant')", [scope.tenantId]);
  await fixtureOwner().query(
    "INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'Synthetic approval workspace',$1,'synthetic')",
    [scope.workspaceId, scope.tenantId],
  );
  return scope;
}

async function fixture(): Promise<Fixture> {
  const scope = await workspace();
  const member = `mc032-member-${randomUUID().slice(0, 8)}`;
  await runWithServiceScope(scope, () => saveSettings(scope.workspaceId, member,
    { quiet_start: "00:00", quiet_end: "00:00", channels: {} }, actor));
  return { scope, member };
}

async function approval(f: Fixture, options: {
  snapshot?: unknown; tier?: Tier; status?: Status; eventAction?: string;
  createdAt?: string; eventId?: string; channel?: "inapp" | "dingtalk";
  approvalId?: string;
} = {}): Promise<{ id: string; eventId: string }> {
  const id = options.approvalId ?? `mc032-appr-${randomUUID()}`;
  return runWithServiceScope(f.scope, () => serviceTx(f.scope.workspaceId, async (client, scope) => {
    // Every event is written through the real canonical gateway. An explicit eventId is
    // reserved for missing/mismatched association fault injection, with no event rewrite.
    const eventId = options.eventId ?? (await appendEventOn(client, scope, actor, {
      objectType: "approval", objectId: id, action: options.eventAction ?? "approval.request",
      after: { status: "pending", tier: "snapshot-is-not-authoritative", title: "Synthetic pending approval" },
    })).eventId;
    await client.query(
      `INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,status,snapshot,tier,created_at,channel)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [id, scope.tenantId, scope.workspaceId, eventId, options.status ?? "pending",
        JSON.stringify(options.snapshot ?? {}), options.tier ?? "l4_chairman",
        options.createdAt ?? new Date().toISOString(), options.channel ?? "inapp"],
    );
    return { id, eventId };
  }));
}

async function scanAndRead(f: Fixture) {
  return runWithServiceScope(f.scope, async () => ({
    scan: await scan(f.scope.workspaceId, f.member),
    inbox: await inbox(f.scope.workspaceId, f.member, true),
  }));
}

function scenario(name: string, expected: string, action: (f: Fixture, observe: Observe) => Promise<void>): void {
  it(name, async () => {
    const record: Case = {
      name, preconditions: "Fresh synthetic workspace on task-owned Unix PG; NOSUPERUSER/NOBYPASSRLS app/gateway; real RLS/FK/append-only triggers; channels={}; no model",
      steps: ["Create valid synthetic workspace/settings and canonical event through the actual service transaction", "Call the actual secretary service with trusted tenant/workspace scope", "Read actual inbox/approval/event rows and evaluate the named assertion"],
      expected, actual: [], result: "fail",
    };
    cases.push(record);
    const observe: Observe = (label, value) => record.actual.push({ label, value });
    try {
      const f = await fixture();
      observe("scope", f);
      await action(f, observe);
      record.result = "pass";
    } catch (error) {
      record.assertion_error = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...((error as { code?: string })?.code ? { code: (error as { code: string }).code } : {}),
      };
      throw error;
    } finally {
      vi.useRealTimers();
    }
  });
}

describe.runIf(RUN_DB)("MC032 pending approval notification PG contract", () => {
  beforeAll(async () => {
    requireOwnedDatabase();
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 20_000 });
    const roles = await fixtureOwner().query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname");
    expect(roles.rows).toEqual([
      { rolname: "workloom_app", rolsuper: false, rolbypassrls: false },
      { rolname: "workloom_gateway", rolsuper: false, rolbypassrls: false },
    ]);
    const appRole = await getAppPool().query("SELECT current_user AS role");
    expect(appRole.rows).toEqual([{ role: "workloom_app" }]);
  });

  afterAll(async () => {
    const results = await Promise.allSettled([closeAllPools(), owner?.end()]);
    const cleanupFailures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (process.env.SECRETARY_APPROVAL_REPORT_DIR && process.env.SECRETARY_APPROVAL_TASK_OWNED === "1") {
      await writeFile(join(process.env.SECRETARY_APPROVAL_REPORT_DIR, `${process.env.RAW_SCOPE_REPO}-expanded-cases.json`),
        JSON.stringify({ schema: "workloom.secretary-approval/cases@1", cases, total: cases.length,
          passed: cases.filter(c => c.result === "pass").length, failed: cases.filter(c => c.result === "fail").map(c => c.name),
          evidence_grade: "B", event_rows_not_deleted: true, cleanup_failures: cleanupFailures.map(r => String(r.reason)) }, null, 2) + "\n", { flag: "wx" });
    }
    // The runner disposes the entire private cluster. Immutable event rows are never deleted.
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures.map(r => r.reason), "MC032 owned pool cleanup failed");
  });

  scenario("pending snapshot action generates the exact high judge notification", "One appr-ID high judge inbox item retains the title, action link, body and authority tier", async (f, observe) => {
    const a = await approval(f, { snapshot: { action: "synthetic.publish", tool: "ignored-tool", tier: "ignored-tier" }, tier: "l4_chairman" });
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan).toEqual({ added: 1 });
    expect(result.inbox.items).toHaveLength(1);
    expect(result.inbox.items[0]).toMatchObject({ source_key: `appr-${a.id}`, kind: "judge", level: "high",
      title: "有张审批卡等您拍板", body: "synthetic.publish（l4_chairman 级）。要点我整理好了，您看一眼就能定。",
      actions: [{ label: "去审批", link: "/p4" }], link: "/p4" });
  });

  scenario("repeat scans keep one existing approval notification", "First scan adds one; second adds zero; the same inbox row remains", async (f, observe) => {
    const a = await approval(f, { snapshot: { action: "synthetic.repeat" } });
    const first = await scanAndRead(f), second = await scanAndRead(f); observe("first", first); observe("second", second);
    expect(first.scan.added).toBe(1); expect(second.scan.added).toBe(0);
    expect(second.inbox.items).toHaveLength(1); expect(second.inbox.items[0]?.id).toBe(first.inbox.items[0]?.id);
    expect(second.inbox.items[0]?.source_key).toBe(`appr-${a.id}`);
  });

  scenario("concurrent scans deduplicate the same approval at the database constraint", "Eight simultaneous scans add one item in total with one stable source key", async (f, observe) => {
    const a = await approval(f, { snapshot: { action: "synthetic.concurrent" } });
    const scans = await Promise.all(Array.from({ length: 8 }, () => runWithServiceScope(f.scope, () => scan(f.scope.workspaceId, f.member))));
    const items = await runWithServiceScope(f.scope, () => inbox(f.scope.workspaceId, f.member)); observe("scans", scans); observe("inbox", items);
    expect(scans.reduce((sum, x) => sum + x.added, 0)).toBe(1);
    expect(items.items).toHaveLength(1); expect(items.items[0]?.source_key).toBe(`appr-${a.id}`);
  });

  for (const tier of ["l2_captain", "l3_fleet", "l4_chairman"] as const) {
    scenario(`authority tier ${tier} overrides snapshot and event metadata`, `Notification body uses ${tier} from approvals.tier`, async (f, observe) => {
      await approval(f, { snapshot: { action: "synthetic.tier", tier: "incorrect-snapshot-tier" }, tier });
      const result = await scanAndRead(f); observe("result", result);
      expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toContain(`（${tier} 级）`);
      expect(result.inbox.items[0]?.body).not.toContain("incorrect-snapshot-tier");
    });
  }

  scenario("snapshot tool is used when snapshot action is absent", "Tool label appears instead of generic approval.request", async (f, observe) => {
    await approval(f, { snapshot: { tool: "synthetic-tool" } });
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toContain("synthetic-tool（");
  });

  scenario("empty and space-only action falls back to a nonempty tool", "Whitespace is removed and empty action never hides the available tool label", async (f, observe) => {
    await approval(f, { snapshot: { action: "  ", tool: "  synthetic-whitespace-tool  " } });
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toMatch(/^synthetic-whitespace-tool（/);
  });

  scenario("canonical event action is used when snapshot metadata is absent", "The exact associated canonical event supplies a nonempty action label", async (f, observe) => {
    const a = await approval(f, { snapshot: {}, eventAction: "synthetic.event-only-label" });
    const events = await runWithServiceScope(f.scope, () => svcQuery(f.scope.workspaceId,
      "SELECT event_id,payload->'decision'->>'action' AS action FROM biz_events WHERE event_id=$1", [a.eventId]));
    const result = await scanAndRead(f); observe("events", events); observe("result", result);
    expect(events).toEqual([{ event_id: a.eventId, action: "synthetic.event-only-label" }]);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toMatch(/^synthetic.event-only-label（/);
  });

  scenario("missing event association retains pending row with explicit fallback", "A deliberately orphaned pending fixture still creates a reminder with 待审批操作 instead of undefined/null", async (f, observe) => {
    await approval(f, { eventId: `E-SYN-MISSING-${randomUUID()}`, snapshot: {} });
    const result = await scanAndRead(f); observe("fault_injection", "Absent associated event; no event trigger or FK is disabled"); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toMatch(/^待审批操作（/);
  });

  scenario("JSON null snapshot uses the actual canonical event label", "Malformed legacy metadata cannot remove a valid pending approval notification", async (f, observe) => {
    const a = await approval(f, { eventAction: "synthetic.null-metadata", snapshot: {} });
    await runWithServiceScope(f.scope, () => svcQuery(f.scope.workspaceId, "UPDATE approvals SET snapshot='null'::jsonb WHERE approval_id=$1", [a.id]));
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toMatch(/^synthetic.null-metadata（/);
  });

  scenario("empty approval queue returns zero without inbox rows", "No pending approvals gives added=0 and a truly empty inbox", async (f, observe) => {
    const result = await scanAndRead(f); observe("result", result);
    expect(result).toEqual({ scan: { added: 0 }, inbox: { items: [] } });
  });

  scenario("event-only historical pending signal cannot create a phantom approval", "An immutable pending approval.request without an approvals row produces no reminder", async (f, observe) => {
    await runWithServiceScope(f.scope, () => serviceTx(f.scope.workspaceId, (c, sc) => appendEventOn(c, sc, actor,
      { objectType: "approval", objectId: "synthetic-event-no-row", action: "approval.request", after: { status: "pending", tier: "l4_chairman" } })));
    const result = await scanAndRead(f); observe("result", result);
    expect(result).toEqual({ scan: { added: 0 }, inbox: { items: [] } });
  });

  for (const status of ["approved", "edited", "rejected", "expired"] as const) {
    scenario(`current ${status} approval ignores its immutable pending event`, `approvals.status=${status} produces no reminder despite the old pending event`, async (f, observe) => {
      const a = await approval(f, { status, snapshot: { action: `synthetic.${status}` } });
      const stored = await runWithServiceScope(f.scope, () => svcQuery(f.scope.workspaceId,
        "SELECT a.status,e.payload->'decision'->'after'->>'status' AS event_status FROM approvals a JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.event_id=a.event_id WHERE a.approval_id=$1", [a.id]));
      const result = await scanAndRead(f); observe("stored", stored); observe("result", result);
      expect(stored).toEqual([{ status, event_status: "pending" }]);
      expect(result).toEqual({ scan: { added: 0 }, inbox: { items: [] } });
    });
  }

  scenario("freshest ten pending rows retain the original scan limit", "Twelve distinct ordered pending approvals produce exactly the newest ten source keys", async (f, observe) => {
    const added = [];
    for (let i = 0; i < 12; i++) added.push(await approval(f, { snapshot: { action: `synthetic.limit-${i}` }, createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }));
    const result = await scanAndRead(f); observe("approval_ids", added); observe("result", result);
    expect(result.scan.added).toBe(10);
    expect(result.inbox.items.map(x => x.source_key).sort()).toEqual(added.slice(2).map(x => `appr-${x.id}`).sort());
  });

  scenario("equal timestamps use a stable tie breaker at the ten-row boundary", "Repeated scans select the same ten rows out of twelve equal created_at values", async (f, observe) => {
    const stamp = "2026-09-01T00:00:00Z"; const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await approval(f, { approvalId: `mc032-tie-${f.scope.workspaceId}-${String(i).padStart(2, "0")}`, snapshot: { action: `synthetic.tie-${i}` }, createdAt: stamp })).id);
    const first = await scanAndRead(f), second = await scanAndRead(f); observe("first", first); observe("second", second);
    expect(first.scan.added).toBe(10); expect(second.scan.added).toBe(0);
    expect(second.inbox.items.map(x => x.source_key).sort()).toEqual(ids.slice(2).map(id => `appr-${id}`).sort());
  });

  scenario("quiet hours suppress high approval and later scanning presents it", "During quiet hours no approval item is created; disabling quiet hours creates exactly one", async (f, observe) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-01T12:00:00"));
    await approval(f, { snapshot: { action: "synthetic.quiet" } });
    const quietSettings = await runWithServiceScope(f.scope, () => saveSettings(f.scope.workspaceId, f.member, { quiet_start: "11:00", quiet_end: "13:00" }, actor));
    expect(inQuietHours(quietSettings.settings)).toBe(true);
    const during = await scanAndRead(f); observe("during", during);
    expect(during).toEqual({ scan: { added: 0 }, inbox: { items: [] } });
    await runWithServiceScope(f.scope, () => saveSettings(f.scope.workspaceId, f.member, { quiet_start: "00:00", quiet_end: "00:00" }, actor));
    const after = await scanAndRead(f); observe("after", after);
    expect(after.scan.added).toBe(1); expect(after.inbox.items).toHaveLength(1);
  });

  scenario("quiet hours still allow an unrelated red task notification", "High approval is suppressed while the existing red thread-failure source remains present", async (f, observe) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-01T12:00:00"));
    await approval(f, { snapshot: { action: "synthetic.quiet-red" } });
    await runWithServiceScope(f.scope, () => saveSettings(f.scope.workspaceId, f.member, { quiet_start: "11:00", quiet_end: "13:00" }, actor));
    const threadId = `mc032-thread-${randomUUID()}`;
    await runWithServiceScope(f.scope, () => svcQuery(f.scope.workspaceId,
      "INSERT INTO threads(id,tenant_id,workspace_id,title,status,created_by,error) VALUES($1,$2,$3,'Synthetic failed task','failed','synthetic-operator','synthetic failure')",
      [threadId, f.scope.tenantId, f.scope.workspaceId]));
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan.added).toBe(1);
    expect(result.inbox.items).toHaveLength(1); expect(result.inbox.items[0]).toMatchObject({ source_key: `thread-fail-${threadId}`, level: "red", kind: "alert" });
  });

  scenario("separate members each retain their own deduplicated inbox", "One approval is presented once per member, without using another member inbox row", async (f, observe) => {
    const a = await approval(f, { snapshot: { action: "synthetic.members" } });
    const otherMember = `mc032-other-${randomUUID()}`;
    await runWithServiceScope(f.scope, () => saveSettings(f.scope.workspaceId, otherMember, { quiet_start: "00:00", quiet_end: "00:00", channels: {} }, actor));
    const first = await scanAndRead(f), second = await scanAndRead({ ...f, member: otherMember }); observe("first", first); observe("second", second);
    expect(first.scan.added).toBe(1); expect(second.scan.added).toBe(1);
    expect(first.inbox.items[0]?.source_key).toBe(`appr-${a.id}`); expect(second.inbox.items[0]?.source_key).toBe(`appr-${a.id}`);
    expect(first.inbox.items[0]?.id).not.toBe(second.inbox.items[0]?.id);
    expect(second.inbox.items[0]?.member_no).toBe(otherMember);
  });

  scenario("concurrent tenant and workspace scopes keep their nonempty approval data", "Parallel A/B scans each see one own approval body and no other tenant source key", async (f, observe) => {
    const other = await fixture();
    const a = await approval(f, { snapshot: { action: "synthetic.tenant-a" } }), b = await approval(other, { snapshot: { action: "synthetic.tenant-b" } });
    const results = await Promise.all([scanAndRead(f), scanAndRead(other)]); observe("results", results);
    expect(results.map(x => x.scan.added)).toEqual([1, 1]);
    expect(results[0]?.inbox.items.map(x => x.source_key)).toEqual([`appr-${a.id}`]);
    expect(results[1]?.inbox.items.map(x => x.source_key)).toEqual([`appr-${b.id}`]);
    expect(results[0]?.inbox.items[0]?.body).toMatch(/^synthetic.tenant-a（/);
    expect(results[1]?.inbox.items[0]?.body).toMatch(/^synthetic.tenant-b（/);
    expect(() => requireServiceScope(f.scope.workspaceId)).toThrow(/scope/);
  });

  scenario("same-tenant other workspace event cannot supply an approval label", "Deliberate mismatched event association uses the explicit fallback and never the other workspace private action", async (f, observe) => {
    const sibling = { scope: await workspace(f.scope.tenantId), member: f.member };
    const source = await approval(sibling, { snapshot: {}, eventAction: "synthetic.private-sibling-action" });
    await approval(f, { snapshot: {}, eventId: source.eventId, channel: "dingtalk" });
    const result = await scanAndRead(f); observe("fault_injection", "Approval eventId deliberately points at another workspace within the same tenant; RLS and append-only remain enabled"); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toMatch(/^待审批操作（/);
    expect(result.inbox.items[0]?.body).not.toContain("private-sibling");
  });

  scenario("wrong tenant cannot read or present a known workspace approval", "Wrong tenant yields zero private approval/inbox rows and creates no inbox data", async (f, observe) => {
    await approval(f, { snapshot: { action: "synthetic.private-a" } });
    const wrong = { ...f, scope: { ...f.scope, tenantId: `mc032-wrong-${randomUUID()}` } };
    const result = await scanAndRead(wrong); observe("result", result);
    const stored = await fixtureOwner().query("SELECT source_key FROM secretary_inbox WHERE workspace_id=$1", [f.scope.workspaceId]); observe("stored", stored.rows);
    expect(result).toEqual({ scan: { added: 0 }, inbox: { items: [] } }); expect(stored.rows).toEqual([]);
  });

  scenario("missing trusted scope is rejected before notification workload", "No ambient scope and an empty explicit tenant both reject and create no inbox rows", async (f, observe) => {
    await approval(f, { snapshot: { action: "synthetic.no-scope" } });
    await expect(scan(f.scope.workspaceId, f.member)).rejects.toThrow(/scope/);
    expect(() => runWithServiceScope({ tenantId: "", workspaceId: f.scope.workspaceId }, () => scan(f.scope.workspaceId, f.member))).toThrow(/tenantId/);
    const stored = await fixtureOwner().query("SELECT source_key FROM secretary_inbox WHERE workspace_id=$1", [f.scope.workspaceId]); observe("stored", stored.rows); expect(stored.rows).toEqual([]);
  });

  for (const table of ["approvals", "biz_events"] as const) {
    scenario(`actual ${table} query permission failure rejects scan and recovery works`, "The original SQLSTATE 42501 escapes scan, no success/empty result is returned, ACL restores and subsequent scan adds one", async (f, observe) => {
      await approval(f, { snapshot: { action: "synthetic.permission-failure" } });
      const before = (await fixtureOwner().query("SELECT has_table_privilege('workloom_app',$1,'SELECT') AS allowed", [table])).rows;
      expect(before).toEqual([{ allowed: true }]);
      await fixtureOwner().query(`REVOKE SELECT ON ${table} FROM workloom_app`);
      try {
        let failure: unknown;
        try { await runWithServiceScope(f.scope, () => scan(f.scope.workspaceId, f.member)); }
        catch (error) { failure = error; }
        observe("error", failure instanceof Error ? { name: failure.name, code: (failure as { code?: string }).code, message: failure.message } : { missing_error: true });
        expect(failure).toMatchObject({ code: "42501" });
        const stored = await fixtureOwner().query("SELECT source_key FROM secretary_inbox WHERE workspace_id=$1", [f.scope.workspaceId]); observe("during_failure", stored.rows); expect(stored.rows).toEqual([]);
      } finally {
        await fixtureOwner().query(`GRANT SELECT ON ${table} TO workloom_app`);
      }
      const restored = (await fixtureOwner().query("SELECT has_table_privilege('workloom_app',$1,'SELECT') AS allowed", [table])).rows; observe("restored_acl", restored); expect(restored).toEqual(before);
      const result = await scanAndRead(f); observe("after_recovery", result); expect(result.scan.added).toBe(1); expect(result.inbox.items).toHaveLength(1);
    });
  }

  scenario("special characters remain literal notification text", "Quoted Unicode/newline action metadata is returned literally and cannot alter query structure", async (f, observe) => {
    const text = "合成'审批; -- 演示\n第二行";
    await approval(f, { snapshot: { action: text } });
    const result = await scanAndRead(f); observe("result", result);
    expect(result.scan.added).toBe(1); expect(result.inbox.items[0]?.body).toBe(`${text}（l4_chairman 级）。要点我整理好了，您看一眼就能定。`);
    expect((await fixtureOwner().query("SELECT to_regclass('public.approvals') AS table_name")).rows).toEqual([{ table_name: "approvals" }]);
  });
});
