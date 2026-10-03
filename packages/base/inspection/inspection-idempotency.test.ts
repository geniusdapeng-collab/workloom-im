/** MC-027/MC-127: real PostgreSQL competition must converge to one committed receipt. */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchFromAnomaly, resolveAnomaly } from "./dispatch.js";
import { gatewayAppend } from "../workdata/gateway.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const run = randomBytes(8).toString("hex");
const CONCURRENCY = 10;

/** Hold only actual empty preflight reads; no SQL result or write is fabricated. */
function synchronizedReaders(pool: pg.Pool, reads: number) {
  const gates = Array.from({ length: reads }, () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { arrived: 0, open, promise };
  });
  const arrivals: number[] = [];
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Actual preflight competition did not arrive")), 10_000);
    timer.unref();
  });
  const facades = Array.from({ length: CONCURRENCY }, (_, request) => {
    let read = 0;
    return { connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          if (text.trim().startsWith("SELECT event_id FROM biz_events") && read < reads) {
            expect(result.rows).toHaveLength(0);
            const ordinal = read++;
            const gate = gates[ordinal]!;
            gate.arrived += 1;
            arrivals.push(request * reads + ordinal);
            if (gate.arrived === CONCURRENCY) gate.open();
            await Promise.race([gate.promise, timeout]);
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
    } } as unknown as pg.Pool;
  });
  return { facades, gates, arrivals };
}

describe.runIf(RUN_DB)("inspection atomic idempotence on an owned PostgreSQL cluster", () => {
  let app: pg.Pool;
  let gateway: pg.Pool;
  let owner: pg.Pool;
  const references: Array<{ table: "threads" | "biz_events"; key: string; rows: unknown[] }> = [];

  beforeAll(async () => {
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const url = new URL(process.env[key]!);
      expect(url.hostname).toBe("localhost");
      expect(url.pathname).toMatch(/^\/inspection_proof_(base|hotel)$/);
      expect(url.searchParams.get("host")).toMatch(/^\/tmp\/wl-inspection-proof-/);
    }
    app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 12 });
    gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 12 });
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const roles = await owner.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname");
    expect(roles.rows).toHaveLength(2);
    expect(roles.rows.every((row) => !row.rolsuper && !row.rolbypassrls)).toBe(true);
    expect((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses).toBe("");
    for (const [table, key] of [["threads", "id"], ["biz_events", "seq"]] as const) {
      const rows = (await owner.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY ${key}`)).rows.map((row) => row.value);
      references.push({ table, key, rows });
    }
  });

  afterAll(async () => {
    await Promise.all([app?.end(), gateway?.end(), owner?.end()]);
  });

  async function anomaly(kind: string) {
    return gatewayAppend(gateway, { ...scope, actor: { id: "MEM-001", type: "human" } }, {
      who: { id: "MEM-001", type: "human" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "inspection", id: `test-mc027-${kind}-${run}` },
      decision: { action: "inspect.anomaly", after: { severity: "low", summary: `test-mc027-${kind}-${run}` } },
      rule_impact: [],
    });
  }

  async function eventRows(anomalyId: string, actions: string[]) {
    return (await owner.query("SELECT * FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'=ANY($3::text[]) AND payload->'links' @> $4::jsonb ORDER BY seq",
      [scope.tenantId, scope.workspaceId, actions, JSON.stringify([anomalyId])])).rows;
  }

  it("ten concurrent dispatches return one committed thread/event pair and one creator", async () => {
    const source = await anomaly("dispatch");
    const before = Number((await owner.query("SELECT count(*) FROM threads")).rows[0].count);
    const barrier = synchronizedReaders(app, 1);
    const results = await Promise.all(barrier.facades.map((pool) => dispatchFromAnomaly(pool, gateway, scope, {
      anomalyEventId: source.eventId, presetKey: "test-proof-agent", by: "MEM-001",
    })));
    expect(barrier.gates.map((gate) => gate.arrived)).toEqual([CONCURRENCY]);
    expect(results.filter((row) => !row.deduped)).toHaveLength(1);
    expect(new Set(results.map((row) => row.threadId)).size).toBe(1);
    expect(new Set(results.map((row) => row.eventId)).size).toBe(1);
    const created = results[0]!;
    const thread = (await owner.query("SELECT * FROM threads WHERE id=$1", [created.threadId])).rows;
    const events = await eventRows(source.eventId, ["inspect.dispatch"]);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ tenant_id: scope.tenantId, workspace_id: scope.workspaceId, status: "queued", agent_id: "test-proof-agent" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_id: created.eventId, session_id: created.threadId });
    expect(events[0].payload.decision.after.threadId).toBe(created.threadId);
    expect(events[0].payload.links).toEqual([source.eventId]);
    expect(Number((await owner.query("SELECT count(*) FROM threads")).rows[0].count)).toBe(before + 1);
  });

  it.each(["resolved", "escalated", "mixed"] as const)("ten concurrent %s resolutions commit one outcome across both actions", async (kind) => {
    const source = await anomaly(kind);
    const dispatched = await dispatchFromAnomaly(app, gateway, scope, { anomalyEventId: source.eventId, presetKey: "test-proof-agent", by: "MEM-001" });
    const barrier = synchronizedReaders(app, 2);
    const results = await Promise.all(barrier.facades.map((pool, index) => resolveAnomaly(pool, gateway, scope, {
      anomalyEventId: source.eventId, threadId: dispatched.threadId,
      ok: kind === "resolved" || (kind === "mixed" && index % 2 === 0), by: "MEM-001", note: `request-${index}`,
    })));
    expect(barrier.gates.map((gate) => gate.arrived)).toEqual([CONCURRENCY, CONCURRENCY]);
    expect(results.filter((row) => !row.deduped)).toHaveLength(1);
    expect(new Set(results.map((row) => row.eventId)).size).toBe(1);
    const events = await eventRows(source.eventId, ["inspect.resolved", "inspect.escalated"]);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe(results[0]!.eventId);
    expect(events[0].payload.links).toEqual([source.eventId, dispatched.threadId]);
    const outcome = events[0].payload.decision.action;
    const creator = results.findIndex((row) => !row.deduped);
    const creatorOk = kind === "resolved" || (kind === "mixed" && creator % 2 === 0);
    expect(outcome).toBe(creatorOk ? "inspect.resolved" : "inspect.escalated");
    expect(["inspect.resolved", "inspect.escalated"]).toContain(outcome);
    if (outcome === "inspect.escalated") {
      expect(events[0].payload.decision.after).toMatchObject({ fromSeverity: "low", toSeverity: "medium", need_human: true });
    }
    for (const ok of [true, false]) {
      const repeated = await resolveAnomaly(app, gateway, scope, { anomalyEventId: source.eventId, threadId: dispatched.threadId, ok, by: "MEM-001" });
      expect(repeated).toEqual({ eventId: events[0].event_id, deduped: true });
    }
    expect(await eventRows(source.eventId, ["inspect.resolved", "inspect.escalated"])).toEqual(events);
  });

  it("retains every original full row including event seq, payload and hashes", async () => {
    for (const reference of references) {
      const rows = (await owner.query(`SELECT to_jsonb(t) AS value FROM ${reference.table} t ORDER BY ${reference.key}`)).rows.map((row) => row.value);
      const keys = new Set(reference.rows.map((row) => (row as Record<string, unknown>)[reference.key]));
      expect(rows.filter((row) => keys.has(row[reference.key]))).toEqual(reference.rows);
    }
  });
});
