/**
 * MC-010：影子裁决只追加带 dry_run 的审计，不改审批或业务状态。
 * 调用真实 runQueueBeat / gateway；有状态客户端把 SQL 写入和提交显式分开。
 * PostgreSQL 真实迁移与 RLS 回归另由 work/ceo-shadow-pg-check.mjs 覆盖。
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { defaultCharter, type Charter, type CeoMode } from "./charter.js";
import { runQueueBeat, type Scope } from "./loop.js";

const scope: Scope = { tenantId: "shadow-unit-tenant", workspaceId: "shadow-unit-workspace" };

interface Approval {
  approval_id: string;
  tenant_id: string;
  workspace_id: string;
  event_id: string;
  status: string;
  tier: string;
  snapshot: Record<string, unknown>;
  gesture: unknown;
  decided_by: string | null;
  decided_at: string | null;
  consumed_at: string | null;
}

interface Audit {
  who: { id: string; type: string };
  context: { tenant_id: string; workspace_id: string };
  decision: { action: string; params: Record<string, unknown>; basis: string[] };
}

function charter(mode: CeoMode = "shadow"): Charter {
  const c = defaultCharter();
  c.mode = mode;
  c.autonomy.ranges = { unit: { label: "变更比例", lower: 0.8, upper: 1.2, anchor: 1 } };
  return c;
}

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    approval_id: "shadow-unit-approval", tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
    event_id: "E-7100", status: "pending", tier: "l2_captain",
    snapshot: { action: "record.update", params: {}, autonomy_range_key: "unit", autonomy_range_value: 1.19 },
    gesture: null, decided_by: null, decided_at: null, consumed_at: null, ...patch,
  };
}

function fixture(options: {
  charter?: Charter;
  rows?: Approval[];
  readonly?: boolean;
  bindings?: string[];
  rosterStatus?: string;
  queueError?: Error;
  appendError?: Error;
  updateMatches?: boolean;
} = {}) {
  const rows = structuredClone(options.rows ?? [approval()]);
  const c = options.charter ?? charter();
  const events: Audit[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const releases: boolean[] = [];
  let nextEvent = 8200;
  const app = {
    async connect() {
      const releaseIndex = releases.push(false) - 1;
      let transaction = false;
      let tenant: string | undefined;
      let workspace: string | undefined;
      let pendingEvents: Audit[] = [];
      const changes = new Map<string, Approval>();
      return {
        async query(source: string, params: unknown[] = []) {
          const sql = source.replace(/\s+/g, " ").trim();
          queries.push({ sql, params });
          const result = (out: unknown[] = [], rowCount = out.length) => ({ rows: out, rowCount });
          if (sql === "BEGIN") { expect(transaction).toBe(false); transaction = true; return result(); }
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            expect(transaction).toBe(true);
            if (sql === "COMMIT") {
              events.push(...pendingEvents);
              for (const [id, updated] of changes) {
                const index = rows.findIndex((row) => row.approval_id === id);
                expect(index).toBeGreaterThanOrEqual(0);
                rows[index] = updated;
              }
            }
            transaction = false; workspace = undefined; tenant = undefined;
            pendingEvents = []; changes.clear();
            return result();
          }
          expect(transaction, `事务外 SQL：${sql}`).toBe(true);
          if (sql.includes("set_config('app.workspace_id'")) { workspace = String(params[0]); return result(); }
          if (sql.includes("set_config('app.tenant_id'")) { tenant = String(params[0]); return result(); }
          expect(workspace).toBe(scope.workspaceId);
          if (sql.startsWith("SELECT archive, (archive->'charter')::text AS charter_snapshot FROM profiles")) {
            expect(tenant).toBe(scope.tenantId);
            expect(params).toEqual([scope.workspaceId, scope.tenantId]);
            expect(sql).toContain("WHERE workspace_id=$1 AND tenant_id=$2");
            return result([{ archive: { charter: c }, charter_snapshot: JSON.stringify(c) }]);
          }
          if (sql === "SELECT clock_timestamp() < $1::timestamptz AS valid") return result([{ valid: Date.now() < Date.parse(String(params[0])) }]);
          if (sql.startsWith("SELECT a.approval_id, a.event_id, a.snapshot")) {
            expect(tenant).toBe(scope.tenantId);
            if (options.queueError) throw options.queueError;
            const selected = rows.filter((row) => row.workspace_id === params[0] && row.status === "pending" && row.tier === "l2_captain"
              && (!row.snapshot.expires_at || Date.parse(String(row.snapshot.expires_at)) > Date.now()));
            return result(selected.sort((a, b) => a.approval_id.localeCompare(b.approval_id)).slice(0, 20).map((row) => structuredClone(row)));
          }
          if (sql.startsWith("UPDATE approvals SET")) {
            expect(tenant).toBe(scope.tenantId);
            if (options.updateMatches === false) return result();
            const stored = rows.find((row) => row.approval_id === params[0] && row.workspace_id === params[1] && row.status === "pending");
            if (!stored) return result();
            const updated = structuredClone(stored);
            if (sql.includes("SET tier='l4_chairman'")) {
              updated.tier = "l4_chairman";
              updated.snapshot = { ...updated.snapshot, ...JSON.parse(String(params[2])) };
            } else {
              updated.status = String(params[2]); updated.gesture = JSON.parse(String(params[3]));
              updated.decided_by = String(params[4]); updated.decided_at = new Date().toISOString();
            }
            changes.set(updated.approval_id, updated);
            return result([], 1);
          }
          if (sql.startsWith("SELECT readonly, fence_bindings, meta FROM agents")) {
            expect(tenant).toBe(scope.tenantId);
            expect(params).toEqual([scope.workspaceId, "company-ceo"]);
            return result((options.rosterStatus ?? "ready") === "ready"
              ? [{ readonly: options.readonly ?? false, fence_bindings: options.bindings ?? ["unit-policy"], meta: {} }] : []);
          }
          if (sql.startsWith("SELECT pg_advisory_xact_lock")) return result();
          if (sql.startsWith("SELECT seq, hash FROM biz_events")) return result();
          if (sql.startsWith("SELECT nextval('biz_events_eid_seq')")) return result([{ v: String(++nextEvent) }]);
          if (sql.startsWith("SELECT * FROM append_event_insert")) {
            expect(tenant).toBe(scope.tenantId);
            expect(params[1]).toBe(scope.tenantId); expect(params[2]).toBe(scope.workspaceId);
            if (options.appendError) throw options.appendError;
            pendingEvents.push(JSON.parse(String(params[4])) as Audit);
            return result([{ seq: String(nextEvent), inserted: true }]);
          }
          if (sql.startsWith("SELECT payload->'decision'->>'action' AS action")) return result();
          if (sql.startsWith("SELECT kind, content FROM org_memory")) return result();
          if (sql.startsWith("SELECT count(*)::text AS n FROM biz_events")) return result([{ n: "0" }]);
          throw new Error(`客户端未登记生产 SQL：${sql}`);
        },
        release() { expect(transaction).toBe(false); releases[releaseIndex] = true; },
      };
    },
  } as unknown as pg.Pool;
  return { app, rows, events, queries, releases };
}

function expectShadow(f: ReturnType<typeof fixture>, before: Approval[], verdict: string, count = 1) {
  expect(f.rows).toEqual(before);
  expect(f.queries.filter(({ sql }) => /^(UPDATE|INSERT INTO|DELETE FROM) /.test(sql))).toEqual([]);
  expect(f.events).toHaveLength(count);
  expect(f.events.every((event) => event.decision.action === "ceo.decision" && event.decision.params.dry_run === true)).toBe(true);
  expect(f.events.every((event) => event.decision.params.verdict === verdict && event.decision.params.mode === "shadow")).toBe(true);
  expect(f.events.every((event) => event.who.id === "company-ceo" && event.who.type === "agent"
    && event.context.tenant_id === scope.tenantId && event.context.workspace_id === scope.workspaceId
    && event.decision.basis.length > 0)).toBe(true);
  expect(f.releases.every(Boolean)).toBe(true);
}

describe("影子期队列裁决的写入边界（MC-010）", () => {
  it("规则上浮保留审批整行，每拍追加一条 dry_run 审计", async () => {
    const f = fixture(); const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toEqual({ decided: 0, escalated: 1, tiers: { micro: 1, standard: 0, major: 0 } });
    expectShadow(f, before, "escalate");
  });

  it("常规模型上浮不写 tier 或 ceo_rationale", async () => {
    const f = fixture({ rows: [approval({ snapshot: { action: "record.update", params: {} } })] });
    const before = structuredClone(f.rows);
    await runQueueBeat(f.app, scope, { llmCall: async () => JSON.stringify({ verdict: "escalate", rationale: "需要复核" }) });
    expectShadow(f, before, "escalate");
  });

  it("重大决策候选均不可行时仍只预演上浮", async () => {
    const f = fixture({ rows: [approval({ snapshot: { action: "record.update", params: {}, irreversible: true } })] });
    const before = structuredClone(f.rows);
    await runQueueBeat(f.app, scope, { llmCall: async (prompt) => prompt.includes("候选方案")
      ? JSON.stringify([{ label: "待复核", params: {}, stance: "conservative" }]) : "不可行，需要上浮" });
    expectShadow(f, before, "escalate");
  });

  it("模型失败回到保守规则，上浮仍无业务写入", async () => {
    const f = fixture({ rows: [approval({ snapshot: { action: "record.update", params: {} } })] });
    const before = structuredClone(f.rows);
    await runQueueBeat(f.app, scope, { llmCall: async () => { throw new Error("unit-model-offline"); } });
    expectShadow(f, before, "escalate");
  });

  it("预演批准也保留审批整行和审计归因", async () => {
    const f = fixture({ rows: [approval({ snapshot: { action: "record.update", params: {}, autonomy_range_key: "unit", autonomy_range_value: 1 } })] });
    const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 1, escalated: 0 });
    expectShadow(f, before, "approve");
  });

  it("连续和并发预演保持原行；每次有效预演各追加一条标记审计", async () => {
    const f = fixture(); const before = structuredClone(f.rows);
    await runQueueBeat(f.app, scope); await runQueueBeat(f.app, scope);
    await Promise.all(Array.from({ length: 4 }, () => runQueueBeat(f.app, scope)));
    expectShadow(f, before, "escalate", 6);
  });

  it("空队列不写审计，过滤已过期、非待审、非 L2 和其他工作区", async () => {
    const f = fixture({ rows: [approval({ status: "approved" }), approval({ approval_id: "expired", snapshot: { expires_at: new Date(0).toISOString() } }),
      approval({ approval_id: "l4", tier: "l4_chairman" }), approval({ approval_id: "other", workspace_id: "other-workspace" })] });
    const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 0 });
    expectShadow(f, before, "escalate", 0);
  });

  it("最多 20 件且特殊字符参数不进入 SQL 文本", async () => {
    const specialId = "000-'引号\"换行\n%_";
    const f = fixture({ rows: Array.from({ length: 21 }, (_, index) => approval({ approval_id: index === 0 ? specialId : `approval-${String(index).padStart(2, "0")}`, event_id: `E-${7200 + index}` })) });
    const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 20 });
    expectShadow(f, before, "escalate", 20);
    expect(f.events[0]?.decision.params.approval_id).toBe(specialId);
    expect(f.queries.every(({ sql }) => !sql.includes(specialId))).toBe(true);
  });

  it.each(["disabled", "suspended"] as const)("%s 完全跳过队列且无审计", async (mode) => {
    const f = fixture({ charter: charter(mode) }); const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 0, skipped: expect.stringContaining(mode) });
    expectShadow(f, before, "escalate", 0);
    expect(f.queries.some(({ sql }) => sql.includes("FROM approvals"))).toBe(false);
  });

  it.each([
    { label: "只读", options: { readonly: true }, reason: /只读 preset/ },
    { label: "无绑定", options: { bindings: [] }, reason: /未声明 fence_bindings/ },
    { label: "停用", options: { rosterStatus: "disabled" }, reason: /未声明 fence_bindings/ },
  ])("$label 岗位不绕过 gateway，错误回滚且保留审批", async ({ options, reason }) => {
    const f = fixture(options); const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).rejects.toThrow(reason);
    expect(f.rows).toEqual(before); expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK"); expect(f.releases.every(Boolean)).toBe(true);
  });

  it.each(["queueError", "appendError"] as const)("%s 上抛原错且不留业务写入或成功审计", async (key) => {
    const error = new Error(`unit-${key}`); const f = fixture({ [key]: error }); const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).rejects.toBe(error);
    expect(f.rows).toEqual(before); expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK"); expect(f.releases.every(Boolean)).toBe(true);
  });
});

describe("正式执行保持审批与事件同事务（MC-010 回归）", () => {
  it.each(["active", "trial"] as const)("%s 上浮真正变为 L4，审计无 dry_run；顺序重跑不再选取", async (mode) => {
    const f = fixture({ charter: charter(mode), rows: [approval({ snapshot: { action: "record.update", params: {} } })] });
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 1 });
    expect(f.rows[0]).toMatchObject({ tier: "l4_chairman", status: "pending", snapshot: { ceo_escalated: true, ceo_rationale: expect.any(String) } });
    expect(f.events).toHaveLength(1); expect(f.events[0]?.decision.params.dry_run).toBeUndefined();
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 0 });
    expect(f.events).toHaveLength(1); expect(f.releases.every(Boolean)).toBe(true);
  });

  it("正式微决策批准写 status / 手势 / 决策身份且只留一条成功审计", async () => {
    const f = fixture({ charter: charter("active"), rows: [approval({ snapshot: { action: "record.update", params: {}, autonomy_range_key: "unit", autonomy_range_value: 1 } })] });
    await runQueueBeat(f.app, scope);
    expect(f.rows[0]).toMatchObject({ status: "approved", tier: "l2_captain", gesture: { type: "approve" }, decided_by: "company-ceo", decided_at: expect.any(String) });
    expect(f.events).toHaveLength(1); expect(f.events[0]?.decision.params.dry_run).toBeUndefined();
  });

  it("正式 UPDATE 未命中时不制造成功计数或事件", async () => {
    const f = fixture({ charter: charter("active"), updateMatches: false }); const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 0 });
    expect(f.rows).toEqual(before); expect(f.events).toEqual([]);
  });

  it("正式事件失败回滚此前 L4 更新", async () => {
    const error = new Error("unit-append-failed"); const f = fixture({ charter: charter("active"), appendError: error });
    const before = structuredClone(f.rows);
    await expect(runQueueBeat(f.app, scope)).rejects.toBe(error);
    expect(f.rows).toEqual(before); expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK"); expect(f.releases.every(Boolean)).toBe(true);
  });
});
