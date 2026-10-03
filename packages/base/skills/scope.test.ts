/** MC022: connection identity must leave only after a completed rollback or destruction. */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { releaseSkillClient, rollbackSkills, setSkillScope, withSkillScope } from "./scope.js";

const scope = { tenantId: "tenant-scope-unit", workspaceId: "ws-scope-unit" };
function fixture(fail?: (sql: string) => Promise<unknown> | unknown) {
  const queries: string[] = [];
  const release = vi.fn();
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      await fail?.(sql);
      return { rows: [{ exists: 1 }], rowCount: 1 };
    }, release,
  } as unknown as pg.PoolClient;
  return { queries, release, client, pool: { connect: async () => client } as unknown as pg.Pool };
}

describe("MC022 skill transaction connection lifecycle", () => {
  it("sets both transaction-local identities and commits before returning a value", async () => {
    const f = fixture(); const action = vi.fn(async () => "completed");
    await expect(withSkillScope(f.pool, scope, action)).resolves.toBe("completed");
    expect(f.queries[0]).toBe("BEGIN");
    expect(f.queries[1]).toContain("set_config('app.tenant_id'");
    expect(f.queries[1]).toContain("set_config('app.workspace_id'");
    expect(f.queries[1]).toContain(",true)");
    expect(f.queries[2]).toContain("FROM workspaces WHERE id=$1 AND tenant_id=$2");
    expect(f.queries.at(-1)).toBe("COMMIT");
    expect(action).toHaveBeenCalledWith(f.client); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("awaits delayed ROLLBACK before returning an action error or releasing its connection", async () => {
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    const original = new Error("action failed");
    const f = fixture(async (sql) => { if (sql === "ROLLBACK") await delayed; });
    const result = withSkillScope(f.pool, scope, async () => { throw original; });
    const checked = expect(result).rejects.toBe(original);
    await vi.waitFor(() => expect(f.queries.at(-1)).toBe("ROLLBACK"));
    expect(f.release).not.toHaveBeenCalled();
    finish(); await checked;
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false); expect(f.queries).not.toContain("COMMIT");
  });

  it.each(["BEGIN", "COMMIT"])("%s failure rolls back and rejects instead of publishing an uncommitted result", async (statement) => {
    const original = new Error(`${statement} failed`);
    const f = fixture((sql) => { if (sql === statement) throw original; });
    await expect(withSkillScope(f.pool, scope, async () => "uncommitted")).rejects.toBe(original);
    expect(f.queries.at(-1)).toBe("ROLLBACK"); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("failed rollback preserves both errors and destroys the connection", async () => {
    const original = new Error("statement failed"); const rollback = new Error("rollback failed");
    const f = fixture((sql) => { if (sql === "ROLLBACK") throw rollback; });
    const result = await withSkillScope(f.pool, scope, async () => { throw original; }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors).toEqual([original, rollback]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("manual skill-ops rollback uses the same connection destruction rule", async () => {
    const original = new Error("manual statement"); const rollback = new Error("manual rollback");
    const f = fixture((sql) => { if (sql === "ROLLBACK") throw rollback; });
    await expect(rollbackSkills(f.client, original)).rejects.toMatchObject({ errors: [original, rollback] });
    expect(f.release).not.toHaveBeenCalled(); releaseSkillClient(f.client);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("unregistered or mismatched real workspace prevents action execution", async () => {
    const f = fixture();
    f.client.query = vi.fn(async () => ({ rows: [], rowCount: 0 })) as never;
    const action = vi.fn(async () => "forbidden");
    await expect(withSkillScope(f.pool, scope, action)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(action).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([
    { tenantId: "", workspaceId: "ws-scope-unit" },
    { tenantId: "  ", workspaceId: "ws-scope-unit" },
    { tenantId: "tenant-scope-unit", workspaceId: "" },
    { tenantId: "tenant-scope-unit", workspaceId: "\t " },
  ])("blank identity never qualifies even if a malformed registry row exists: %j", async (input) => {
    const f = fixture();
    await expect(setSkillScope(f.client, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.queries).toEqual([]);
  });
});
