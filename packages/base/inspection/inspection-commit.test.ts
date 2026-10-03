/** MC-026: transaction failures cannot turn into successful inspection receipts. */
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchFromAnomaly, resolveAnomaly } from "./dispatch.js";

const append = vi.hoisted(() => vi.fn());
vi.mock("../workdata/gateway.js", () => ({
  gatewayAppend: append,
  gatewayAppendOnClient: append,
}));

const scope = { tenantId: "tenant-test", workspaceId: "ws-test" };
const input = { anomalyEventId: "E-100", presetKey: "test-agent", by: "MEM-001" };
const resolution = { anomalyEventId: input.anomalyEventId, threadId: "T-104", by: input.by, ok: true };
const anomaly = {
  event_id: input.anomalyEventId,
  payload: { decision: { after: { summary: "signal", severity: "low" } }, object: { type: "test-signal", id: "signal-1" } },
};

interface ClientOptions {
  fail?: RegExp;
  error?: Error;
  rollbackError?: Error;
  commitGate?: Promise<void>;
  existing?: boolean;
}

function connection(options: ClientOptions = {}) {
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    statements.push(sql);
    if (sql === "ROLLBACK" && options.rollbackError) throw options.rollbackError;
    if (options.fail?.test(sql)) throw options.error;
    if (sql === "COMMIT" && options.commitGate) await options.commitGate;
    if (sql.startsWith("SELECT event_id, payload FROM biz_events")) return { rows: [anomaly] };
    if (sql.startsWith("SELECT event_id FROM biz_events")) return { rows: options.existing ? [{ event_id: "E-500" }] : [] };
    if (sql.startsWith("SELECT payload FROM biz_events")) return { rows: [{ payload: { decision: { after: { threadId: "T-104" } } } }] };
    if (sql === "SELECT public.threads_max_t_no() AS n") return { rows: [{ n: 104 }] };
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT readable_id_\d+|RELEASE SAVEPOINT readable_id_\d+|ROLLBACK TO SAVEPOINT readable_id_\d+)$/.test(sql)
      || sql.startsWith("SELECT set_config('app.") || sql.startsWith("INSERT INTO threads ")
      || sql === "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))") return { rows: [] };
    throw new Error(`Unregistered transaction test SQL: ${sql}`);
  });
  return { query, release, statements };
}

function pool(clients: ReturnType<typeof connection>[]) {
  let cursor = 0;
  return { connect: vi.fn(async () => {
    const client = clients[cursor++];
    if (!client) throw new Error("Unexpected inspection connection");
    return client;
  }) } as unknown as pg.Pool;
}

function dispatchClients(target: number, options: ClientOptions, deduped = false) {
  return Array.from({ length: 3 }, (_, index) => connection({
    ...(index === 1 ? { existing: deduped } : {}),
    ...(index === target ? options : {}),
  }));
}

function expectReusable(client: ReturnType<typeof connection>) {
  expect(client.release).toHaveBeenCalledOnce();
  expect([undefined, false]).toContain(client.release.mock.calls[0]?.[0]);
}

beforeEach(() => {
  append.mockReset();
  append.mockResolvedValue({ eventId: "E-501", seq: 501n, hash: "test-hash", deduped: false, piiHits: 0 });
});

describe("inspection transaction receipts (MC-026)", () => {
  it.each([0, 1, 2])("propagates COMMIT failure from dispatch transaction %i", async (target) => {
    const primary = Object.assign(new Error("test-commit-rejected"), { code: "P0001" });
    const clients = dispatchClients(target, { fail: /^COMMIT$/, error: primary });
    await expect(dispatchFromAnomaly(pool(clients), pool([]), scope, input)).rejects.toBe(primary);
    expect(clients[target]!.statements.at(-1)).toBe("ROLLBACK");
    expectReusable(clients[target]!);
  });

  it("awaits the write COMMIT before resolving the persisted identifiers", async () => {
    let finishCommit!: () => void;
    const gate = new Promise<void>((resolve) => { finishCommit = resolve; });
    const clients = dispatchClients(2, { commitGate: gate });
    let finished = false;
    const result = dispatchFromAnomaly(pool(clients), pool([]), scope, input).then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(clients[2]!.statements.at(-1)).toBe("COMMIT"));
    expect(finished).toBe(false);
    expect(clients[2]!.release).not.toHaveBeenCalled();
    finishCommit();
    await expect(result).resolves.toEqual({ threadId: "T-104", eventId: "E-501", deduped: false });
    expectReusable(clients[2]!);
  });

  const statements = [/^SELECT event_id, payload/, /^SELECT event_id FROM/, /^INSERT INTO threads/];
  it.each([0, 1, 2])("rolls back a SQL failure without sending COMMIT afterwards in transaction %i", async (target) => {
    const primary = Object.assign(new Error("test-statement-rejected"), { code: "22012" });
    const clients = dispatchClients(target, { fail: statements[target], error: primary });
    await expect(dispatchFromAnomaly(pool(clients), pool([]), scope, input)).rejects.toBe(primary);
    expect(clients[target]!.statements.at(-1)).toBe("ROLLBACK");
    expect(clients[target]!.statements).not.toContain("COMMIT");
    expectReusable(clients[target]!);
  });

  it.each([0, 1, 2])("retains the primary error and discards a client whose ROLLBACK fails in transaction %i", async (target) => {
    const primary = Object.assign(new Error("test-commit-primary"), { code: "P0001" });
    const rollback = Object.assign(new Error("test-rollback-disconnected"), { code: "57P01" });
    const clients = dispatchClients(target, { fail: /^COMMIT$/, error: primary, rollbackError: rollback });
    await expect(dispatchFromAnomaly(pool(clients), pool([]), scope, input)).rejects.toBe(primary);
    expect(clients[target]!.statements.at(-1)).toBe("ROLLBACK");
    expect(clients[target]!.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("rejects a deduped dispatch whose receipt lookup COMMIT fails", async () => {
    const primary = new Error("test-deduped-commit-rejected");
    const clients = dispatchClients(2, { fail: /^COMMIT$/, error: primary }, true);
    await expect(dispatchFromAnomaly(pool(clients), pool([]), scope, input)).rejects.toBe(primary);
    expect(append).not.toHaveBeenCalled();
    expect(clients[2]!.statements.at(-1)).toBe("ROLLBACK");
    expectReusable(clients[2]!);
  });

  it("does not replace a deduped receipt lookup error with a rollback error", async () => {
    const primary = new Error("test-deduped-primary");
    const clients = dispatchClients(2, {
      fail: /^SELECT payload FROM/,
      error: primary,
      rollbackError: new Error("test-rollback-disconnected"),
    }, true);
    await expect(dispatchFromAnomaly(pool(clients), pool([]), scope, input)).rejects.toBe(primary);
    expect(clients[2]!.statements).not.toContain("COMMIT");
    expect(clients[2]!.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([true, false])("does not resolve ok=%s after an anomaly read COMMIT failure", async (ok) => {
    const primary = new Error("test-resolve-read-commit-rejected");
    const client = connection({ fail: /^COMMIT$/, error: primary });
    await expect(resolveAnomaly(pool([client]), pool([]), scope, { ...resolution, ok })).rejects.toBe(primary);
    expect(append).not.toHaveBeenCalled();
    expectReusable(client);
  });

  it.each([1, 2])("does not emit a resolution after idempotence read transaction %i fails COMMIT", async (target) => {
    const primary = new Error("test-resolve-idempotence-commit-rejected");
    const clients = dispatchClients(target, { fail: /^COMMIT$/, error: primary });
    await expect(resolveAnomaly(pool(clients), pool([]), scope, resolution)).rejects.toBe(primary);
    expect(append).not.toHaveBeenCalled();
    expectReusable(clients[target]!);
  });

  it("returns an existing resolution only after its read transaction commits", async () => {
    const primary = new Error("test-existing-resolution-commit-rejected");
    const clients = dispatchClients(1, { fail: /^COMMIT$/, error: primary }, true);
    await expect(resolveAnomaly(pool(clients), pool([]), scope, resolution)).rejects.toBe(primary);
    expect(append).not.toHaveBeenCalled();
    expectReusable(clients[1]!);
  });
});
