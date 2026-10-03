/**
 * MC-019/119: actual public ingress, original SQL migrations and least-privilege
 * app/gateway roles. Owner access is restricted to synthetic fixtures, fault
 * injection and independent committed-state inspection. No shared DB URL is read.
 * Reproduction: python3 work/im-inbound-verify.py pg <fresh-phase> base hotel.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { boundOpenidOfMember, findInboundEvent, ingestInbound, resolveMemberByOpenid, type InboundMessage } from "./inbound.js";
import { gatewayAppend, type EventDraft } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1";
const d = RUN_DB ? describe : describe.skip;
interface Scope { tenantId: string; workspaceId: string }
interface Fixture {
  scope: Scope;
  otherWorkspace: Scope;
  otherTenant: Scope;
  msg: InboundMessage;
  memberNo: string;
  memberOpenId: string;
}
interface EventRow { event_id: string; tenant_id: string; workspace_id: string; payload: EventDraft; seq: string; prev_hash: string; hash: string }
interface ClaimRow { event_id: string; created_at: string }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string; code?: string } };
type Fault = "insert" | "commit" | "backfill" | "skip-backfill" | "terminate";

d("IM inbound atomicity, durable receipts and interrupted-claim recovery (owned PG)", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let gateway: pg.Pool;
  let fixture: Fixture;
  let baseConfig: pg.PoolConfig;
  const observations: Array<Record<string, unknown>> = [];
  const poolErrors: string[] = [];
  const scopes: Scope[] = [];
  const trackedPools = new Set<pg.Pool>();
  let sequence = 0;
  let nonce = "";
  let repo = "";
  let reportDir = "";

  const record = (name: string, details: Record<string, unknown>): void => { observations.push({ name, ...details }); };
  async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
    try { return { ok: true, value: await promise }; }
    catch (error) {
      const e = error as Error & { code?: string };
      return { ok: false, error: { name: e.name, message: e.message, code: e.code } };
    }
  }
  function pool(user: string, max: number, name: string): pg.Pool {
    const value = new pg.Pool({ ...baseConfig, user, max, application_name: `im-inbound-${name}-${nonce}` });
    value.on("error", (error) => poolErrors.push(`${name}: ${error.message}`));
    trackedPools.add(value);
    return value;
  }
  async function createScope(tenant: string, workspace: string): Promise<Scope> {
    await owner.query("INSERT INTO tenants(id,name) VALUES ($1,'合成 IM 租户') ON CONFLICT DO NOTHING", [tenant]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES ($1,$2,'合成 IM 工作区',$1,'synthetic','shadow')", [workspace, tenant]);
    const scope = { tenantId: tenant, workspaceId: workspace };
    scopes.push(scope);
    return scope;
  }
  async function state(scope = fixture.scope, msg = fixture.msg): Promise<{ claims: ClaimRow[]; events: EventRow[] }> {
    const claims = await owner.query<ClaimRow>(
      "SELECT event_id, created_at::text AS created_at FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3",
      [scope.workspaceId, msg.channel, msg.channelMsgId],
    );
    const events = await owner.query<EventRow>(
      `SELECT event_id,tenant_id,workspace_id,payload,seq,prev_hash,hash FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='im.message'
         AND payload->'context'->>'channel'=$3 AND payload->'decision'->'after'->>'channel_msg_id'=$4 ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, msg.channel, maskText(msg.channelMsgId).text],
    );
    return { claims: claims.rows, events: events.rows };
  }
  async function legacyClaim(eventId = "", scope = fixture.scope, msg = fixture.msg): Promise<ClaimRow> {
    const r = await owner.query<ClaimRow>(
      `INSERT INTO im_inbound_dedupe(workspace_id,channel,channel_msg_id,event_id,created_at)
       VALUES ($1,$2,$3,$4,'2000-01-01T00:00:00Z') RETURNING event_id, created_at::text AS created_at`,
      [scope.workspaceId, msg.channel, msg.channelMsgId, eventId],
    );
    return r.rows[0]!;
  }
  function draft(scope = fixture.scope, msg = fixture.msg): EventDraft {
    const id = `ext:${msg.channel}:${msg.senderOpenId}`;
    return {
      who: { type: "human", id },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: msg.sentAt ?? new Date().toISOString(), channel: msg.channel },
      object: { type: "im_conversation", id: `${msg.channel}:${msg.conversationId}` },
      decision: { action: "im.message", after: { text: msg.text, kind: msg.kind, channel_msg_id: msg.channelMsgId, sender_open_id: msg.senderOpenId, mapped_member: null } },
      rule_impact: [],
    };
  }
  async function canonicalEvent(scope = fixture.scope, msg = fixture.msg): Promise<string> {
    const ev = draft(scope, msg);
    const r = await gatewayAppend(gateway, { ...scope, actor: { type: "human", id: ev.who.id } }, ev);
    return r.eventId;
  }
  function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
  async function installFault(fault: Fault): Promise<void> {
    const { scope, msg } = fixture;
    const args = [scope.workspaceId, msg.channel, msg.channelMsgId].map(literal).join(",");
    const eventPredicate = "NEW.workspace_id=TG_ARGV[0] AND NEW.payload->'decision'->>'action'='im.message' AND NEW.payload->'context'->>'channel'=TG_ARGV[1] AND NEW.payload->'decision'->'after'->>'channel_msg_id'=TG_ARGV[2]";
    const claimPredicate = "NEW.workspace_id=TG_ARGV[0] AND NEW.channel=TG_ARGV[1] AND NEW.channel_msg_id=TG_ARGV[2]";
    const body = fault === "skip-backfill" ? "RETURN NULL;"
      : fault === "terminate" ? "PERFORM pg_terminate_backend(pg_backend_pid());"
      : `RAISE EXCEPTION 'MC019 synthetic ${fault} failure' USING ERRCODE='P0001';`;
    const isClaim = fault === "backfill" || fault === "skip-backfill";
    await owner.query(`CREATE FUNCTION im_inbound_task_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${isClaim ? claimPredicate : eventPredicate} THEN ${body} END IF; RETURN NEW; END $$`);
    if (fault === "commit") {
      await owner.query(`CREATE CONSTRAINT TRIGGER im_inbound_task_event_fault AFTER INSERT ON biz_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION im_inbound_task_fault(${args})`);
    } else if (isClaim) {
      await owner.query(`CREATE TRIGGER im_inbound_task_claim_fault BEFORE UPDATE OF event_id ON im_inbound_dedupe FOR EACH ROW EXECUTE FUNCTION im_inbound_task_fault(${args})`);
    } else {
      await owner.query(`CREATE TRIGGER im_inbound_task_event_fault BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION im_inbound_task_fault(${args})`);
    }
  }
  async function removeFault(): Promise<void> {
    await owner.query("DROP TRIGGER IF EXISTS im_inbound_task_event_fault ON biz_events");
    await owner.query("DROP TRIGGER IF EXISTS im_inbound_task_claim_fault ON im_inbound_dedupe");
    await owner.query("DROP FUNCTION IF EXISTS im_inbound_task_fault()");
  }
  async function assertOneEvent(expectedId: string | null, scope = fixture.scope, msg = fixture.msg): Promise<void> {
    const s = await state(scope, msg);
    expect.soft(expectedId).toEqual(expect.stringMatching(/^E-\d+$/));
    expect.soft(s.claims).toHaveLength(1);
    expect.soft(s.events).toHaveLength(1);
    expect.soft(s.claims[0]?.event_id).toBe(expectedId);
    expect.soft(s.events[0]?.event_id).toBe(expectedId);
  }
  async function unscopedCounts(db: pg.Pool): Promise<Record<string, unknown>> {
    const c = await db.connect();
    try {
      const r = await c.query(`SELECT current_setting('app.tenant_id',true) AS tenant,
        current_setting('app.workspace_id',true) AS workspace,
        (SELECT count(*) FROM biz_events)::text AS events,
        (SELECT count(*) FROM im_inbound_dedupe)::text AS claims,
        (SELECT count(*) FROM members)::text AS members`);
      return r.rows[0]!;
    } finally { c.release(); }
  }
  async function until(check: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Owned PostgreSQL synchronization timed out: ${label}`);
  }
  function canonicalIndependent(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalIndependent).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalIndependent(object[key])}`).join(",")}}`;
  }
  async function chain(scope: Scope): Promise<{ rows: number; issues: string[] }> {
    const rows = (await owner.query<EventRow>("SELECT event_id,seq,payload,prev_hash,hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq", [scope.tenantId, scope.workspaceId])).rows;
    const issues: string[] = [];
    let previous = "GENESIS";
    for (const row of rows) {
      if (row.prev_hash !== previous) issues.push(`${row.event_id}: broken predecessor`);
      const hash = createHash("sha256").update(previous + canonicalIndependent(row.payload), "utf8").digest("hex");
      if (row.hash !== hash) issues.push(`${row.event_id}: independent hash mismatch`);
      previous = row.hash;
    }
    return { rows: rows.length, issues };
  }

  beforeAll(async () => {
    const env = process.env;
    nonce = env.IM_INBOUND_NONCE ?? "";
    repo = env.IM_INBOUND_REPO ?? "";
    reportDir = env.IM_INBOUND_REPORT_DIR ?? "";
    const database = env.IM_INBOUND_DATABASE ?? "";
    if (env.IM_INBOUND_TASK_OWNED !== "1" || !env.IM_INBOUND_SOCKET?.startsWith("/tmp/wl-im-inbound-")
        || !/^[a-f0-9]{10}$/.test(nonce) || !["base", "hotel"].includes(repo)
        || database !== `im_inbound_${repo}_${nonce}` || !reportDir) {
      throw new Error("Task-owned synthetic IM PostgreSQL sentinel required; generic DATABASE_URL is never used");
    }
    baseConfig = { host: env.IM_INBOUND_SOCKET, port: Number(env.IM_INBOUND_PORT), database,
      connectionTimeoutMillis: 5000, statement_timeout: 12000 };
    owner = pool("postgres", 3, "owner");
    app = pool("workloom_app", 1, "app");
    gateway = pool("workloom_gateway", 1, "gateway");
    const roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    expect(roles).toEqual([{ rolname: "workloom_app", rolsuper: false, rolbypassrls: false }, { rolname: "workloom_gateway", rolsuper: false, rolbypassrls: false }]);
    record("minimum-privilege-roles", { roles });
  });
  beforeEach(async () => {
    const id = `${nonce}-${++sequence}-${randomUUID().slice(0, 8)}`;
    const tenant = `im-inbound-tenant-${id}`;
    fixture = {
      scope: await createScope(tenant, `im-inbound-ws-${id}-a`),
      otherWorkspace: await createScope(tenant, `im-inbound-ws-${id}-b`),
      otherTenant: await createScope(`im-inbound-other-${id}`, `im-inbound-ws-${id}-c`),
      msg: { channel: "dingtalk", channelMsgId: `im-${id}`, conversationId: `conversation-${id}`,
        kind: "direct", senderOpenId: `sender_${id}`, text: "合成入站消息" },
      memberNo: "MEM-041", memberOpenId: `member_${id}`,
    };
    await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role,im_openids) VALUES ($1,$2,$3,'合成映射成员','manager',$4::jsonb)",
      [`im-inbound-member-${id}`, fixture.scope.workspaceId, fixture.memberNo, JSON.stringify({ dingtalk: fixture.memberOpenId })]);
  });
  afterEach(async (context) => {
    if (!owner || !fixture) return;
    await removeFault();
    await owner.query("GRANT SELECT ON members TO workloom_app");
    record(context.task.name, { final: await state(), unscopedApp: await unscopedCounts(app),
      unscopedGateway: await unscopedCounts(gateway), independentChain: await chain(fixture.scope) });
    for (const db of trackedPools) {
      if (db === owner || db === app || db === gateway) continue;
      await db.end();
      trackedPools.delete(db);
    }
  });
  afterAll(async () => {
    if (!owner) return;
    try {
      const chains = [];
      for (const scope of scopes) chains.push({ scope, ...(await chain(scope)) });
      await writeFile(join(reportDir, `${repo}-scenario-states.json`), `${JSON.stringify({ repo, observations, chains, poolErrors }, null, 2)}\n`, { flag: "wx" });
      expect(chains.every((entry) => entry.issues.length === 0)).toBe(true);
    } finally { await Promise.all([...trackedPools].map((db) => db.end())); }
  });

  it("ordinary first ingestion and exact replay return one committed nonempty receipt", async () => {
    const first = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const replay = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record("ordinary-results", { first, replay });
    expect(first).toMatchObject({ deduped: false, identity: "visitor" });
    expect(replay).toMatchObject({ eventId: first.eventId, deduped: true });
    await assertOneEvent(first.eventId);
    expect(await findInboundEvent(app, fixture.scope, fixture.msg.channel, fixture.msg.channelMsgId)).toBe(first.eventId);
  });
  it("mapped member and PII masking remain effective with a one-connection app pool", async () => {
    fixture.msg.senderOpenId = fixture.memberOpenId;
    fixture.msg.text = "合成联系电话 13812345678；邮箱 synthetic@example.test";
    const r = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const stored = await state();
    expect(r).toMatchObject({ identity: "member", memberNo: fixture.memberNo, deduped: false });
    expect(stored.events[0]?.payload.who).toMatchObject({ type: "human", id: fixture.memberNo });
    expect(JSON.stringify(stored.events)).not.toContain("13812345678");
    expect(JSON.stringify(stored.events)).not.toContain("synthetic@example.test");
    expect(JSON.stringify(stored.events)).toContain("[PII:PHONE:");
    expect(await resolveMemberByOpenid(app, fixture.scope, "dingtalk", fixture.memberOpenId)).toMatchObject({ memberNo: fixture.memberNo });
    expect(await boundOpenidOfMember(app, fixture.scope, "dingtalk", fixture.memberNo)).toBe(fixture.memberOpenId);
    await assertOneEvent(r.eventId);
  });
  it.each(["inapp", "dingtalk", "wecom", "feishu"] as const)("enabled channel %s keeps its own key and group/offset metadata", async (channel) => {
    fixture.msg = { ...fixture.msg, channel, kind: "group", sentAt: "2026-08-19T23:00:00+08:00", text: "引用 \"转义\"\n特殊字符 <>&🎉" };
    const r = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const s = await state();
    expect(s.events[0]?.payload.context).toMatchObject({ channel, time: fixture.msg.sentAt });
    expect(s.events[0]?.payload.decision.after).toMatchObject({ text: fixture.msg.text, kind: "group", channel_msg_id: fixture.msg.channelMsgId });
    await assertOneEvent(r.eventId);
  });
  it.each([
    ["empty key", { channelMsgId: " " }], ["empty conversation", { conversationId: "" }],
    ["empty sender", { senderOpenId: "" }], ["empty text", { text: "\t " }],
    ["too long", { text: "字".repeat(2001) }], ["planned channel", { channel: "slack" }],
    ["unknown channel", { channel: "whatsapp" }],
  ])("invalid message %s creates neither a claim nor an event", async (_name, change) => {
    const input = { ...fixture.msg, ...(change as Partial<InboundMessage>) };
    await expect(ingestInbound(app, gateway, fixture.scope, input)).rejects.toThrow();
    const rows = await owner.query("SELECT (SELECT count(*) FROM im_inbound_dedupe WHERE workspace_id=$1)::text AS claims, (SELECT count(*) FROM biz_events WHERE workspace_id=$1)::text AS events", [fixture.scope.workspaceId]);
    expect(rows.rows[0]).toEqual({ claims: "0", events: "0" });
  });
  it("maximum 2000-character text commits and replays without truncation", async () => {
    fixture.msg.text = "字".repeat(2000);
    const first = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const second = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    expect((await state()).events[0]?.payload.decision.after).toMatchObject({ text: fixture.msg.text });
    expect(second.eventId).toBe(first.eventId);
    await assertOneEvent(first.eventId);
  });
  it.each([["PHONE", "13812345678"], ["EMAIL", "synthetic@example.test"]] as const)("PII-shaped provider key %s remains dedupable without exposing its event plaintext", async (kind, key) => {
    fixture.msg.channelMsgId = key;
    const first = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const replay = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const expectedKey = `[PII:${kind}:${createHmac("sha256", "synthetic-im-inbound-test-salt").update(key, "utf8").digest("hex").slice(0, 12)}]`;
    const actual = (await owner.query<{ payload: EventDraft }>("SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3", [fixture.scope.tenantId, fixture.scope.workspaceId, first.eventId])).rows[0];
    expect(actual?.payload.decision.after).toMatchObject({ channel_msg_id: expectedKey });
    expect(replay).toMatchObject({ eventId: first.eventId, deduped: true });
    expect(await findInboundEvent(app, fixture.scope, fixture.msg.channel, key)).toBe(first.eventId);
    await assertOneEvent(first.eventId);
  });

  it.each([
    ["insert", false], ["commit", false], ["backfill", false], ["skip-backfill", false],
    ["insert", true], ["commit", true], ["backfill", true], ["skip-backfill", true],
  ] as const)("%s fault rolls back atomically; legacy blank=%s retries once without deleting history", async (fault, legacy) => {
    const before = legacy ? await legacyClaim() : null;
    await installFault(fault);
    const failed = await outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
    const afterFailure = await state();
    await removeFault();
    const retry = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const replay = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record(`fault-${fault}-legacy-${legacy}`, { failed, afterFailure, retry, replay, before });
    expect.soft(failed.ok).toBe(false);
    expect.soft(afterFailure.events).toHaveLength(0);
    expect.soft(afterFailure.claims).toHaveLength(legacy ? 1 : 0);
    if (legacy) expect.soft(afterFailure.claims[0]).toEqual(before);
    expect.soft(retry.deduped).toBe(false);
    expect.soft(replay.eventId).toBe(retry.eventId);
    expect.soft(replay.deduped).toBe(true);
    await assertOneEvent(retry.eventId);
    if (legacy) expect.soft((await state()).claims[0]?.created_at).toBe(before?.created_at);
  });
  it("member SELECT failure leaves no durable placeholder and the same key recovers", async () => {
    await owner.query("REVOKE SELECT ON members FROM workloom_app");
    const failed = await outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
    const afterFailure = await state();
    await owner.query("GRANT SELECT ON members TO workloom_app");
    const retry = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record("member-permission-failure", { failed, afterFailure, retry });
    expect.soft(failed.ok).toBe(false);
    if (!failed.ok) expect.soft(failed.error.code).toBe("42501");
    expect.soft(afterFailure).toEqual({ claims: [], events: [] });
    await assertOneEvent(retry.eventId);
  });
  it("event schema rejection leaves no placeholder and corrected timestamp retries safely", async () => {
    const failed = await outcome(ingestInbound(app, gateway, fixture.scope, { ...fixture.msg, sentAt: "not-a-time" }));
    const afterFailure = await state();
    const retry = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record("event-schema-failure", { failed, afterFailure, retry });
    expect.soft(failed.ok).toBe(false);
    expect.soft(afterFailure).toEqual({ claims: [], events: [] });
    await assertOneEvent(retry.eventId);
  });
  it("backend termination does not poison the app pool or strand the message key", async () => {
    await installFault("terminate");
    const failed = await outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
    const afterFailure = await state();
    await removeFault();
    const retry = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record("backend-termination", { failed, afterFailure, retry });
    expect.soft(failed.ok).toBe(false);
    expect.soft(afterFailure).toEqual({ claims: [], events: [] });
    await assertOneEvent(retry.eventId);
    expect(await unscopedCounts(app)).toMatchObject({ events: "0", claims: "0", members: "0" });
  });

  it("blocked winner keeps a duplicate pending until a complete committed receipt exists", async () => {
    const contender = pool("workloom_app", 1, "contender");
    const blocker = await owner.connect();
    let duplicateDone = false;
    let duplicateValue: unknown;
    let winner: Promise<Outcome<Awaited<ReturnType<typeof ingestInbound>>>> | undefined;
    let duplicate: Promise<Outcome<Awaited<ReturnType<typeof ingestInbound>>>> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-chain:${fixture.scope.tenantId}:${fixture.scope.workspaceId}`]);
      winner = outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
      await until(async () => (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [`im-inbound-app-${nonce}`])).rows[0].n === 1, "winner waiting on actual chain lock");
      duplicate = outcome(ingestInbound(contender, gateway, fixture.scope, fixture.msg)).then((value) => {
        duplicateDone = true; duplicateValue = value; return value;
      });
      await until(async () => duplicateDone || (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`im-inbound-contender-${nonce}`])).rows[0].n === 1, "duplicate completion or real PG row wait");
      const activity = (await owner.query("SELECT application_name,state,wait_event_type,wait_event FROM pg_stat_activity WHERE application_name IN ($1,$2) ORDER BY application_name", [`im-inbound-app-${nonce}`, `im-inbound-contender-${nonce}`])).rows;
      record("blocked-winner-before-commit", { duplicateDone, duplicateValue, activity, committed: await state() });
      expect.soft(duplicateDone).toBe(false);
      expect.soft((await state()).claims).toHaveLength(0);
      await blocker.query("COMMIT");
      const results = await Promise.all([winner, duplicate]);
      record("blocked-winner-after-commit", { results });
      expect.soft(results.every((result) => result.ok)).toBe(true);
      if (results[0]!.ok && results[1]!.ok) {
        expect.soft(results[0].value.deduped).toBe(false);
        expect.soft(results[1].value).toMatchObject({ eventId: results[0].value.eventId, deduped: true });
        await assertOneEvent(results[0].value.eventId);
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.all([winner, duplicate]);
    }
  });
  it.each([false, true])("12 simultaneous deliveries have one winner and 12 full receipts; legacy blank=%s", async (legacy) => {
    const before = legacy ? await legacyClaim() : null;
    const concurrent = pool("workloom_app", 16, "race");
    const results = await Promise.all(Array.from({ length: 12 }, () => ingestInbound(concurrent, gateway, fixture.scope, fixture.msg)));
    record(`concurrent-legacy-${legacy}`, { results, before });
    expect.soft(results.filter((result) => !result.deduped)).toHaveLength(1);
    const id = (await state()).events[0]?.event_id ?? null;
    expect.soft(results.map((result) => result.eventId)).toEqual(Array(12).fill(id));
    await assertOneEvent(id);
    if (legacy) expect.soft((await state()).claims[0]?.created_at).toBe(before?.created_at);
  });
  it("identical provider IDs in distinct channels/workspaces/tenants remain separate", async () => {
    const calls = [
      [fixture.scope, fixture.msg], [fixture.scope, { ...fixture.msg, channel: "wecom" as const }],
      [fixture.otherWorkspace, fixture.msg], [fixture.otherTenant, fixture.msg],
    ] as const;
    const concurrent = pool("workloom_app", 8, "separate");
    const results = await Promise.all(calls.map(([scope, msg]) => ingestInbound(concurrent, gateway, scope, msg)));
    expect(new Set(results.map((result) => result.eventId)).size).toBe(4);
    for (const [index, [scope, msg]] of calls.entries()) {
      await assertOneEvent(results[index]!.eventId, scope, msg);
      expect(await findInboundEvent(app, scope, msg.channel, msg.channelMsgId)).toBe(results[index]!.eventId);
    }
  });
  it("unregistered synthetic workspaces keep compatibility while tenant-specific receipts stay private", async () => {
    const scope = { tenantId: fixture.scope.tenantId, workspaceId: `${fixture.scope.workspaceId}-unregistered` };
    scopes.push(scope);
    const first = await ingestInbound(app, gateway, scope, fixture.msg);
    const bad = { tenantId: fixture.otherTenant.tenantId, workspaceId: scope.workspaceId };
    const replay = await outcome(ingestInbound(app, gateway, bad, fixture.msg));
    const audit = await findInboundEvent(app, bad, fixture.msg.channel, fixture.msg.channelMsgId);
    record("unregistered-workspace-scope", { first, replay, audit });
    expect.soft(replay.ok).toBe(false);
    expect.soft(audit).toBeNull();
    await assertOneEvent(first.eventId, scope);
  });
  it("legacy blank at an unregistered workspace cannot adopt another tenant's event or overwrite its claim", async () => {
    const scope = { tenantId: fixture.scope.tenantId, workspaceId: `${fixture.scope.workspaceId}-orphan` };
    const bad = { tenantId: fixture.otherTenant.tenantId, workspaceId: scope.workspaceId };
    scopes.push(scope, bad);
    const id = await canonicalEvent(scope);
    const claim = await legacyClaim("", scope);
    const before = await state(scope);
    const result = await outcome(ingestInbound(app, gateway, bad, fixture.msg));
    const foreign = await state(bad);
    record("unregistered-legacy-blank-foreign-tenant", { scope, bad, id, claim, before, result, foreign, after: await state(scope) });
    expect.soft(result.ok).toBe(false);
    expect.soft(foreign.events).toHaveLength(0);
    expect.soft(await state(scope)).toEqual(before);
    // The original tenant can recover from its own unique canonical receipt.
    const restored = await ingestInbound(app, gateway, scope, fixture.msg);
    expect.soft(restored).toMatchObject({ eventId: id, deduped: true });
    await assertOneEvent(id, scope);
    expect.soft((await state(scope)).claims[0]?.created_at).toBe(claim.created_at);
  });
  it("legacy blank without workspace ownership or a current-tenant event fails closed and preserves the original row", async () => {
    const scope = { tenantId: fixture.scope.tenantId, workspaceId: `${fixture.scope.workspaceId}-ownerless-blank` };
    scopes.push(scope);
    const claim = await legacyClaim("", scope);
    const result = await outcome(ingestInbound(app, gateway, scope, fixture.msg));
    record("unregistered-legacy-blank-no-proof", { scope, claim, result, after: await state(scope) });
    expect.soft(result.ok).toBe(false);
    expect.soft(await state(scope)).toEqual({ claims: [claim], events: [] });
  });
  it("a changed duplicate payload retains the first committed event and never rewrites it", async () => {
    const first = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const before = await state();
    const replay = await ingestInbound(app, gateway, fixture.scope, { ...fixture.msg, text: "不得改写首条事件", senderOpenId: fixture.memberOpenId });
    expect(replay).toMatchObject({ eventId: first.eventId, deduped: true });
    expect(await state()).toEqual(before);
  });

  it("legacy blank with no event recovers without replacing its original claim", async () => {
    const before = await legacyClaim();
    const result = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    record("legacy-empty-no-event", { result, before });
    expect.soft(result.deduped).toBe(false);
    await assertOneEvent(result.eventId);
    expect.soft((await state()).claims[0]?.created_at).toBe(before.created_at);
  });
  it.each([false, true])("an existing canonical event is adopted without append; blank claim=%s", async (blank) => {
    const id = await canonicalEvent();
    const before = blank ? await legacyClaim() : null;
    const concurrent = pool("workloom_app", 8, "adopt");
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestInbound(concurrent, gateway, fixture.scope, fixture.msg)));
    record(`legacy-existing-event-blank-${blank}`, { id, before, results });
    expect.soft(results.every((result) => result.deduped && result.eventId === id)).toBe(true);
    await assertOneEvent(id);
    if (blank) expect.soft((await state()).claims[0]?.created_at).toBe(before?.created_at);
  });
  it.each(["missing", "foreign-workspace", "foreign-message", "mismatched-pointer"] as const)("invalid durable pointer %s is rejected without repair or a new event", async (kind) => {
    let id = "E-987654321";
    if (kind === "foreign-workspace") id = await canonicalEvent(fixture.otherTenant);
    if (kind === "foreign-message") id = await canonicalEvent(fixture.scope, { ...fixture.msg, channelMsgId: `${fixture.msg.channelMsgId}-foreign` });
    if (kind === "mismatched-pointer") { await canonicalEvent(); id = "E-987654321"; }
    await legacyClaim(id);
    const before = await state();
    const result = await outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
    record(`invalid-pointer-${kind}`, { result, before });
    expect.soft(result.ok).toBe(false);
    expect.soft(await state()).toEqual(before);
  });
  it.each(["", "first"])("two legacy events for one key fail closed; pointer=%s; audit rows stay intact", async (pointer) => {
    const first = await canonicalEvent();
    await canonicalEvent();
    await legacyClaim(pointer ? first : "");
    const before = await state();
    const result = await outcome(ingestInbound(app, gateway, fixture.scope, fixture.msg));
    record(`ambiguous-events-pointer-${pointer}`, { result, before });
    expect.soft(result.ok).toBe(false);
    expect.soft(await state()).toEqual(before);
    expect.soft((await state()).events).toHaveLength(2);
  });

  it("wrong tenant cannot poison a known workspace's new key or return its duplicate receipt", async () => {
    const badScope = { tenantId: fixture.otherTenant.tenantId, workspaceId: fixture.scope.workspaceId };
    const wrongFirst = await outcome(ingestInbound(app, gateway, badScope, fixture.msg));
    const afterWrong = await state();
    const correct = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const beforeReplay = await state();
    const wrongReplay = await outcome(ingestInbound(app, gateway, badScope, fixture.msg));
    record("wrong-tenant-at-same-workspace", { wrongFirst, afterWrong, correct, wrongReplay });
    expect.soft(wrongFirst.ok).toBe(false);
    expect.soft(afterWrong).toEqual({ claims: [], events: [] });
    await assertOneEvent(correct.eventId);
    expect.soft(wrongReplay.ok).toBe(false);
    expect.soft(await state()).toEqual(beforeReplay);
  });
  it("wrong tenant is denied member, reverse-openid and audit lookups at a known workspace", async () => {
    const good = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const bad = { tenantId: fixture.otherTenant.tenantId, workspaceId: fixture.scope.workspaceId };
    const member = await outcome(resolveMemberByOpenid(app, bad, "dingtalk", fixture.memberOpenId));
    const bound = await outcome(boundOpenidOfMember(app, bad, "dingtalk", fixture.memberNo));
    const audit = await outcome(findInboundEvent(app, bad, fixture.msg.channel, fixture.msg.channelMsgId));
    const replay = await outcome(ingestInbound(app, gateway, bad, fixture.msg));
    record("wrong-tenant-read-surfaces", { good, member, bound, audit, replay });
    expect.soft(member.ok).toBe(false);
    expect.soft(bound.ok).toBe(false);
    expect.soft(audit.ok).toBe(false);
    expect.soft(replay.ok).toBe(false);
  });
  it.each([{ tenantId: "", workspaceId: "valid" }, { tenantId: "valid", workspaceId: "" }])("empty scope %j is denied before creating a key", async (scope) => {
    const result = await outcome(ingestInbound(app, gateway, scope, fixture.msg));
    expect.soft(result.ok).toBe(false);
    const claims = (await owner.query("SELECT * FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel_msg_id=$2", [scope.workspaceId, fixture.msg.channelMsgId])).rows;
    expect.soft(claims).toHaveLength(0);
  });
  it("missing GUCs are default-denied, pools do not retain scope and app cannot bypass the event gateway", async () => {
    const r = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    const appState = await unscopedCounts(app);
    const gatewayState = await unscopedCounts(gateway);
    expect(appState).toMatchObject({ events: "0", claims: "0", members: "0" });
    expect(gatewayState).toMatchObject({ events: "0", claims: "0", members: "0" });
    expect(appState.tenant ?? "").toBe(""); expect(appState.workspace ?? "").toBe("");
    expect(gatewayState.tenant ?? "").toBe(""); expect(gatewayState.workspace ?? "").toBe("");
    const acl = (await owner.query("SELECT has_table_privilege('workloom_app','biz_events','INSERT') AS insert, has_table_privilege('workloom_app','biz_events','UPDATE') AS update, has_table_privilege('workloom_app','biz_events','DELETE') AS delete, has_table_privilege('workloom_app','biz_events','TRUNCATE') AS truncate")).rows[0];
    expect(acl).toEqual({ insert: false, update: false, delete: false, truncate: false });
    await expect(app.query("INSERT INTO biz_events(event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-111','fake','fake','{}','GENESIS','fake')")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("INSERT INTO im_inbound_dedupe(workspace_id,channel,channel_msg_id) VALUES ($1,'dingtalk',$2)", [fixture.scope.workspaceId, `${fixture.msg.channelMsgId}-unscoped`])).rejects.toMatchObject({ code: "42501" });
    await assertOneEvent(r.eventId);
  });
  it("gateway role cannot claim an inbound key and append-only protections remain enforced", async () => {
    const denied = await outcome(ingestInbound(gateway, gateway, fixture.scope, fixture.msg));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("42501");
    expect(await state()).toEqual({ claims: [], events: [] });
    const r = await ingestInbound(app, gateway, fixture.scope, fixture.msg);
    await expect(owner.query("UPDATE biz_events SET payload=payload WHERE event_id=$1", [r.eventId])).rejects.toThrow(/append-only/);
    await expect(owner.query("DELETE FROM biz_events WHERE event_id=$1", [r.eventId])).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE biz_events")).rejects.toThrow(/append-only/);
    await assertOneEvent(r.eventId);
  });
});
