import { describe, expect, it } from "vitest";
import { requireServiceScope, runWithServiceScope, validatedServiceScope } from "./scope.js";

const a = { tenantId: "synthetic-tenant-a", workspaceId: "synthetic-workspace-a" };
const b = { tenantId: "synthetic-tenant-b", workspaceId: "synthetic-workspace-b" };

describe("authenticated service scope propagation", () => {
  it.each([
    { tenantId: "", workspaceId: a.workspaceId },
    { tenantId: " \t", workspaceId: a.workspaceId },
    { tenantId: a.tenantId, workspaceId: "" },
    { tenantId: a.tenantId, workspaceId: " \n" },
  ])("rejects empty scope before entering a call chain: %j", (scope) => {
    expect(() => runWithServiceScope(scope, () => true)).toThrow(/scope/);
  });

  it("requires an explicit trusted scope outside a request", () => {
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
    expect(requireServiceScope(a.workspaceId, a)).toEqual(a);
    expect(() => requireServiceScope(a.workspaceId, b)).toThrow(/scope/);
  });

  it("isolates concurrent delayed continuations", async () => {
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const task = (scope: typeof a) => runWithServiceScope(scope, async () => {
      ready += 1;
      if (ready === 2) release();
      await barrier;
      await Promise.resolve();
      return requireServiceScope(scope.workspaceId);
    });
    expect(await Promise.all([task(a), task(b)])).toEqual([a, b]);
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
  });

  it("restores outer scope after a nested async run and denies explicit escape", async () => {
    await runWithServiceScope(a, async () => {
      expect(() => requireServiceScope(b.workspaceId, b)).toThrow(/scope/);
      expect(await runWithServiceScope(b, async () => {
        await Promise.resolve();
        return requireServiceScope(b.workspaceId);
      })).toEqual(b);
      expect(requireServiceScope(a.workspaceId)).toEqual(a);
    });
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
  });

  it("clears context after both synchronous and asynchronous failures", async () => {
    expect(() => runWithServiceScope(a, () => { throw new Error("synthetic sync failure"); }))
      .toThrow("synthetic sync failure");
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
    await expect(runWithServiceScope(a, async () => {
      await Promise.resolve();
      throw new Error("synthetic async failure");
    })).rejects.toThrow("synthetic async failure");
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
  });

  it("copies identity so later caller mutation cannot change an in-flight request", async () => {
    const input = { ...a };
    await runWithServiceScope(input, async () => {
      input.tenantId = b.tenantId;
      input.workspaceId = b.workspaceId;
      await Promise.resolve();
      const current = requireServiceScope(a.workspaceId);
      expect(current).toEqual(a);
      expect(Object.isFrozen(current)).toBe(true);
    });
    expect(Object.isFrozen(validatedServiceScope(a))).toBe(true);
  });
});
