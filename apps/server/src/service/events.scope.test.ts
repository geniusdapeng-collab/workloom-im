import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireServiceScope, runWithServiceScope } from "./scope.js";

const mocked = vi.hoisted(() => {
  const order: string[] = [];
  const client = {
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 })),
    release: vi.fn((_error?: Error) => { order.push("release"); }),
  };
  const connect = vi.fn(async () => client);
  return { order, client, connect, getAppPool: vi.fn(() => ({ connect })) };
});
vi.mock("@workloom/db", async (original) => ({
  ...await original<typeof import("@workloom/db")>(),
  getAppPool: mocked.getAppPool,
}));
import { serviceTx } from "./events.js";

const scope = { tenantId: "synthetic-lifecycle-tenant", workspaceId: "synthetic-lifecycle-workspace" };
const foreign = { tenantId: "synthetic-foreign-tenant", workspaceId: "synthetic-foreign-workspace" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("serviceTx trusted scope and connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.order.length = 0;
    mocked.client.query.mockImplementation(async (sql) => {
      mocked.order.push(sql);
      return { rows: [], rowCount: 0 };
    });
  });

  it("rejects missing, mismatched and escaped identities before acquiring a pool", async () => {
    await expect(serviceTx(scope.workspaceId, async () => true)).rejects.toThrow(/scope/);
    await expect(serviceTx(scope.workspaceId, async () => true, foreign)).rejects.toThrow(/scope/);
    await expect(runWithServiceScope(scope, () => serviceTx(foreign.workspaceId, async () => true, foreign)))
      .rejects.toThrow(/scope/);
    expect(mocked.getAppPool).not.toHaveBeenCalled();
    expect(mocked.connect).not.toHaveBeenCalled();
  });

  it("sets both local GUCs before business code and awaits COMMIT before releasing", async () => {
    const committing = deferred();
    const reachedCommit = deferred();
    mocked.client.query.mockImplementation(async (sql) => {
      mocked.order.push(sql);
      if (sql === "COMMIT") { reachedCommit.resolve(); await committing.promise; }
      return { rows: [], rowCount: 0 };
    });
    const tx = serviceTx(scope.workspaceId, async (_client, current) => {
      mocked.order.push("business");
      expect(current).toEqual(scope);
      await Promise.resolve();
      expect(requireServiceScope(scope.workspaceId)).toEqual(scope);
      return "synthetic-result";
    }, scope);
    await reachedCommit.promise;
    expect(mocked.client.release).not.toHaveBeenCalled();
    expect(mocked.client.query.mock.calls[1]).toEqual([
      "SELECT set_config('app.workspace_id', $1, true), set_config('app.tenant_id', $2, true)",
      [scope.workspaceId, scope.tenantId],
    ]);
    expect(mocked.order.slice(0, 4)).toEqual([
      "BEGIN", mocked.client.query.mock.calls[1]![0], "business", "COMMIT",
    ]);
    committing.resolve();
    await expect(tx).resolves.toBe("synthetic-result");
    expect(mocked.order.at(-1)).toBe("release");
    expect(mocked.client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });

  it.each(["BEGIN", "GUC", "callback", "COMMIT"])(
    "preserves the %s failure and waits for ROLLBACK before release", async (stage) => {
      const primary = new Error(`synthetic-${stage}-failure`);
      const rollingBack = deferred();
      const reachedRollback = deferred();
      mocked.client.query.mockImplementation(async (sql) => {
        mocked.order.push(sql);
        if (sql === "ROLLBACK") { reachedRollback.resolve(); await rollingBack.promise; }
        if (sql === stage || stage === "GUC" && sql.startsWith("SELECT set_config")) throw primary;
        return { rows: [], rowCount: 0 };
      });
      const tx = serviceTx(scope.workspaceId, async () => {
        mocked.order.push("business");
        if (stage === "callback") throw primary;
        return true;
      }, scope);
      const result = tx.then(() => null, (error: unknown) => error);
      await reachedRollback.promise;
      expect(mocked.client.release).not.toHaveBeenCalled();
      rollingBack.resolve();
      expect(await result).toBe(primary);
      expect(mocked.order.at(-1)).toBe("release");
      expect(mocked.client.release).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
    },
  );

  it("reports both failures and discards the connection when ROLLBACK fails", async () => {
    const primary = new Error("synthetic-business-failure");
    const rollback = new Error("synthetic-rollback-failure");
    mocked.client.query.mockImplementation(async (sql) => {
      mocked.order.push(sql);
      if (sql === "ROLLBACK") throw rollback;
      return { rows: [], rowCount: 0 };
    });
    const error = await serviceTx(scope.workspaceId, async () => { throw primary; }, scope)
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, rollback]);
    expect((error as Error).cause).toBe(primary);
    expect(mocked.client.release).toHaveBeenCalledExactlyOnceWith(rollback);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });

  it("does not run business code or release a nonexistent client when connect fails", async () => {
    const primary = new Error("synthetic-connect-failure");
    mocked.connect.mockRejectedValueOnce(primary);
    const business = vi.fn(async () => true);
    await expect(serviceTx(scope.workspaceId, business, scope)).rejects.toBe(primary);
    expect(business).not.toHaveBeenCalled();
    expect(mocked.client.release).not.toHaveBeenCalled();
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });
});
