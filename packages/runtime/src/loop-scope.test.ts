/** MC-038：运行真实 Quest 入口与作用域事务工具；仅替换装配、事件和 PG 边界。 */
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({ assemble: vi.fn(), append: vi.fn(), register: vi.fn() }));
vi.mock("./assembly.js", () => ({ assemblePreset: doubles.assemble }));
vi.mock("@workloom/base/fence-engine", () => ({
  judge: () => ({ level: "auto", impacts: [], triggeredBy: [], evalErrors: [] }),
  judgeViews: () => ({ level: "auto", impacts: [], triggeredBy: [], evalErrors: [] }),
}));
vi.mock("@workloom/base/workdata", () => ({
  gatewayAppend: doubles.append, gatewayAppendOnClient: doubles.append, registerWriteActions: doubles.register,
}));
vi.mock("@workloom/base/captain", () => ({ loadCharter: vi.fn(), routeTier: vi.fn() }));
vi.mock("@workloom/base/evolve", () => ({
  loadActivePreferences: async () => [], buildPreferenceBlock: () => "", preferenceMemoryRefs: () => [],
  recordPreferenceUsageInTx: async () => undefined,
}));

import { runQuest, type QuestStep } from "./loop.js";

const scope = { tenantId: "tenant-owned", workspaceId: "workspace-owned" };
const step: QuestStep = { stepId: "s1", action: "facts.read", objectType: "facts", tool: "facts.read", params: {}, label: "读取事实" };
const input = { threadId: "thread-owned", goal: step.label, presetKey: "reader", fallbackPlanner: () => [step] };
type Query = { connection: number; sql: string; params: unknown[] };
type Failure = { subject: "rules" | "update"; commit: boolean; rollback: boolean; error: Error; rollbackError: Error };
let queries: Query[];
let releases: Array<{ connection: number; destroy: boolean | Error | undefined }>;
let connections: number;
let rowCount: number | null | undefined;
let failure: Failure | undefined;
let pool: pg.Pool;

beforeEach(() => {
  vi.clearAllMocks();
  queries = []; releases = []; connections = 0; rowCount = 1; failure = undefined;
  doubles.assemble.mockResolvedValue({
    agentId: "agent-owned", presetKey: "reader", version: "v1", highRisk: false, fenceBindings: [], prompt: null,
    essentials: { archive: { dataMode: "real" }, stage: "production", goal: input.goal },
    tools: [{ name: step.tool, access: "read", desc: step.label }],
  });
  doubles.append.mockResolvedValue({ eventId: "event-owned" });
  pool = { connect: async () => {
    const connection = ++connections;
    // 装配与偏好边界是桩；真实入口的第 1 个连接读规则，第 6 个连接写 running。
    const target = failure && connection === (failure.subject === "rules" ? 1 : 6);
    return {
      release: (destroy?: boolean | Error) => releases.push({ connection, destroy }),
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ connection, sql, params });
        if (target && ((failure!.commit && sql === "COMMIT") || (!failure!.commit && sql.startsWith("SELECT rule_id"))
          || (!failure!.commit && /^UPDATE threads SET updated_at/.test(sql)))) throw failure!.error;
        if (target && failure!.rollback && sql === "ROLLBACK") throw failure!.rollbackError;
        if (sql.includes("SELECT 1 FROM workspaces WHERE id=$1 AND tenant_id=$2")) {
          const own = params[0] === scope.workspaceId && params[1] === scope.tenantId;
          return { rows: own ? [{ "?column?": 1 }] : [], rowCount: own ? 1 : 0 };
        }
        if (/^UPDATE threads SET updated_at/.test(sql)) return { rows: [], rowCount };
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config(") || sql.startsWith("UPDATE threads SET plan=")) return { rows: [], rowCount: 1 };
        if (sql.includes("FROM fence_rules") || sql.includes("FROM approvals") || sql.includes("SELECT payload FROM biz_events")
          || sql.includes("SELECT plan, plan_version FROM threads")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("UPDATE threads SET progress_done=")) return { rows: [], rowCount: 1 };
        throw new Error(`作用域回归未定义的 SQL：${sql}`);
      },
    };
  } } as unknown as pg.Pool;
});

const execute = () => vi.fn(async () => ({ result: { fixture: "owned-local" }, receipt: { synced: true, mode: "simulated" as const } }));

describe("MC-038 双作用域与线程写回契约", () => {
  it("读规则与三次局部状态更新都校验属主，更新同时绑定 tenant/workspace/thread", async () => {
    const tool = execute();
    await expect(runQuest(pool, pool, scope, { ...input, toolExecutor: tool })).resolves.toMatchObject({ status: "completed", stepsDone: 1 });
    const rule = queries.find(query => query.sql.startsWith("SELECT rule_id"))!;
    const updates = queries.filter(query => /^UPDATE threads SET updated_at/.test(query.sql));
    expect(updates).toHaveLength(3);
    for (const query of [rule, ...updates]) {
      const transaction = queries.filter(item => item.connection === query.connection);
      expect(transaction[0]?.sql).toBe("BEGIN");
      expect(transaction.find(item => item.sql.includes("set_config('app.tenant_id'"))?.params)
        .toEqual([scope.tenantId, scope.workspaceId]);
      expect(transaction.find(item => item.sql.includes("SELECT 1 FROM workspaces"))?.params)
        .toEqual([scope.workspaceId, scope.tenantId]);
      expect(transaction.at(-1)?.sql).toBe("COMMIT");
    }
    expect(updates.every(query => query.sql.includes("WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3"))).toBe(true);
    expect(updates.every(query => JSON.stringify(query.params.slice(0, 3)) === JSON.stringify([input.threadId, scope.workspaceId, scope.tenantId]))).toBe(true);
    expect(tool).toHaveBeenCalledExactlyOnceWith(step.tool, {});
    expect(doubles.append).toHaveBeenCalledTimes(1);
  });

  it.each([0, null, undefined, 2])("影响行数 %s 不构成成功写回，回滚后停止工具执行", async (count) => {
    rowCount = count;
    const tool = execute();
    await expect(runQuest(pool, pool, scope, { ...input, toolExecutor: tool })).rejects.toThrow("状态写回失败");
    expect(tool).not.toHaveBeenCalled(); expect(doubles.append).not.toHaveBeenCalled();
    const update = queries.find(query => /^UPDATE threads SET updated_at/.test(query.sql))!;
    expect(queries.filter(query => query.connection === update.connection).at(-1)?.sql).toBe("ROLLBACK");
    expect(releases.find(release => release.connection === update.connection)?.destroy).toBe(false);
  });

  it.each([
    { tenantId: "", workspaceId: scope.workspaceId }, { tenantId: " \t ", workspaceId: scope.workspaceId },
    { tenantId: scope.tenantId, workspaceId: "" }, { tenantId: scope.tenantId, workspaceId: " \t " },
    { tenantId: "tenant-foreign", workspaceId: scope.workspaceId }, { tenantId: scope.tenantId, workspaceId: "workspace-foreign" },
  ])("不完整或不一致的身份 %j 在规则读取前失败", async (invalid) => {
    const tool = execute();
    await expect(runQuest(pool, pool, invalid, { ...input, toolExecutor: tool })).rejects.toThrow("作用域");
    expect(queries.some(query => query.sql.startsWith("SELECT rule_id"))).toBe(false);
    expect(tool).not.toHaveBeenCalled(); expect(doubles.append).not.toHaveBeenCalled(); expect(doubles.register).not.toHaveBeenCalled();
  });

  for (const subject of ["rules", "update"] as const) {
    it(`${subject} 提交异常原样抛出，不能在 finally 吞错或继续执行`, async () => {
      failure = { subject, commit: true, rollback: false, error: new Error("owned commit failed"), rollbackError: new Error("owned rollback failed") };
      const tool = execute();
      await expect(runQuest(pool, pool, scope, { ...input, toolExecutor: tool })).rejects.toBe(failure.error);
      expect(tool).not.toHaveBeenCalled(); expect(doubles.append).not.toHaveBeenCalled();
      if (subject === "rules") expect(doubles.register).not.toHaveBeenCalled();
      expect(releases.at(-1)?.destroy).toBe(false);
    });

    it(`${subject} 查询与回滚同时失败保留两个错误，并销毁未知事务状态的连接`, async () => {
      failure = { subject, commit: false, rollback: true, error: new Error("owned query failed"), rollbackError: new Error("owned rollback failed") };
      const tool = execute();
      let actual: unknown;
      try { await runQuest(pool, pool, scope, { ...input, toolExecutor: tool }); } catch (error) { actual = error; }
      expect(actual).toBeInstanceOf(AggregateError);
      expect((actual as AggregateError).errors).toEqual([failure.error, failure.rollbackError]);
      expect(releases.at(-1)?.destroy).toBe(true);
      expect(tool).not.toHaveBeenCalled(); expect(doubles.append).not.toHaveBeenCalled();
    });
  }
});
