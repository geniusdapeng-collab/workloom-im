/**
 * CEO 岗位与节拍写入的回归：只读位、围栏与高危标记必须来自当前工作区名册。
 * 使用真实节拍与 gateway；假客户端只登记这些生产函数实际发出的 SQL，未登记即报错。
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { checkPermission, isWriteAction, type EventDraft } from "@workloom/base/workdata";
import { defaultCharter, type Charter } from "./charter.js";
import {
  ceoActor, runBriefingBeat, runQueueBeat, runDeviationBeat, runBreakerBeat,
  runOutcomeReviewBeat, runHrReviewBeat, applyReplacement, runBoardPackBeat, runOrgScanBeat,
} from "./loop.js";

const scope = { tenantId: "unit-tenant", workspaceId: "unit-workspace" };
const bindings = ["unit-ceo-report", "unit-ceo-decision"];

interface RosterRow {
  workspace_id: string;
  preset_key: string;
  status: "ready" | "disabled" | "invalid";
  readonly: boolean;
  fence_bindings: unknown;
  meta?: { high_risk?: boolean };
}

function readyRow(): RosterRow {
  return {
    workspace_id: scope.workspaceId, preset_key: "company-ceo", status: "ready",
    readonly: false, fence_bindings: [...bindings], meta: {},
  };
}

function draft(whoId = "company-ceo"): EventDraft {
  return {
    who: { type: "agent", id: whoId },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "company_ceo", id: scope.workspaceId },
    decision: { action: "ceo.briefing", basis: ["岗位名册回归"] }, rule_impact: [],
  };
}

function activeCharter(): Charter {
  const charter = defaultCharter();
  charter.mode = "active";
  charter.autonomy.ranges = { unit: { label: "变更比例", lower: 0.8, upper: 1.2, anchor: 1 } };
  charter.circuit_breaker.kpi_floor = { occ: 0.7 };
  return charter;
}

type StoredEvent = { who: { id: string; type: string }; decision: { action: string; params?: Record<string, unknown> } };

/** 每次 connect 都有独立事务/GUC；COMMIT 才公开其待写事件，ROLLBACK 丢弃。 */
function fixture(rows: RosterRow[] = [readyRow()], options: { charter?: Charter; rosterError?: Error; appendError?: Error } = {}) {
  const events: StoredEvent[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const releases: boolean[] = [];
  let archiveCharter = options.charter ?? activeCharter();
  let nextEvent = 8000;
  const app = {
    async connect() {
      const releaseIndex = releases.push(false) - 1;
      let inTransaction = false;
      let workspaceId: string | undefined;
      let tenantId: string | undefined;
      let pending: StoredEvent[] = [];
      let pendingCharter: Charter | undefined;
      return {
        async query(source: string, params: unknown[] = []) {
          const sql = source.replace(/\s+/g, " ").trim();
          queries.push({ sql, params });
          const result = (out: unknown[] = [], count = out.length) => ({ rows: out, rowCount: count });
          if (sql === "BEGIN") { expect(inTransaction).toBe(false); inTransaction = true; return result(); }
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            expect(inTransaction).toBe(true);
            if (sql === "COMMIT") {
              events.push(...pending);
              if (pendingCharter) archiveCharter = pendingCharter;
            }
            inTransaction = false;
            workspaceId = undefined; tenantId = undefined; pending = []; pendingCharter = undefined;
            return result();
          }
          expect(inTransaction, `SQL 必须在事务内：${sql}`).toBe(true);
          if (sql.includes("set_config('app.workspace_id'")) { workspaceId = String(params[0]); return result(); }
          if (sql.includes("set_config('app.tenant_id'")) { tenantId = String(params[0]); return result(); }
          expect(workspaceId).toBe(scope.workspaceId);
          if (/FROM agents WHERE workspace_id=\$1 AND preset_key=\$2/.test(sql)) {
            expect(tenantId).toBe(scope.tenantId);
            expect(params).toEqual([scope.workspaceId, "company-ceo"]);
            expect(sql).toContain("status='ready'");
            expect(sql).toContain("FOR SHARE");
            if (options.rosterError) throw options.rosterError;
            return result(rows.filter((row) => row.workspace_id === params[0] && row.preset_key === params[1] && row.status === "ready"));
          }
          if (sql.startsWith("SELECT archive, (archive->'charter')::text AS charter_snapshot FROM profiles")) {
            expect(tenantId).toBe(scope.tenantId);
            expect(params).toEqual([scope.workspaceId, scope.tenantId]);
            expect(sql).toContain("WHERE workspace_id=$1 AND tenant_id=$2");
            const current = pendingCharter ?? archiveCharter;
            return result([{ archive: { charter: current }, charter_snapshot: JSON.stringify(current) }]);
          }
          if (sql === "SELECT clock_timestamp() < $1::timestamptz AS valid") return result([{ valid: Date.now() < Date.parse(String(params[0])) }]);
          if (sql.startsWith("UPDATE profiles SET archive")) { pendingCharter = JSON.parse(String(params[1])) as Charter; return result([], 1); }
          if (sql.startsWith("SELECT pg_try_advisory_xact_lock")) return result([{ ok: true }]);
          if (sql.startsWith("SELECT pg_advisory_xact_lock")) return result();
          if (sql.startsWith("SELECT seq, hash FROM biz_events")) return result();
          if (sql.startsWith("SELECT nextval('biz_events_eid_seq')")) return result([{ v: String(++nextEvent) }]);
          if (sql.startsWith("SELECT * FROM append_event_insert")) {
            expect(tenantId).toBe(scope.tenantId);
            expect(params[1]).toBe(scope.tenantId);
            expect(params[2]).toBe(scope.workspaceId);
            if (options.appendError) throw options.appendError;
            pending.push(JSON.parse(String(params[4])) as StoredEvent);
            return result([{ seq: String(nextEvent), inserted: true }]);
          }
          if (sql.startsWith("SELECT a.approval_id, a.event_id, a.snapshot")) return result([{
            approval_id: "unit-approval", event_id: "E-7000",
            snapshot: { action: "record.update", params: {}, autonomy_range_key: "unit", autonomy_range_value: 1 },
          }]);
          if (sql.startsWith("UPDATE approvals SET")) return result([], 1);
          if (sql.startsWith("INSERT INTO approvals")) return result([], 1);
          if (sql.startsWith("UPDATE agents SET status='disabled'")) return result([], 1);
          if (sql.startsWith("INSERT INTO agents")) return result([], 1);
          if (sql.startsWith("SELECT payload FROM biz_events") && sql.includes("'goal.tracking'")) return result([{ payload: { decision: { after: { deviation_pt: -8 } } } }]);
          if (sql.startsWith("SELECT payload FROM biz_events") && sql.includes("'store.daily.summary'")) return result([{ payload: { decision: { after: { occ: 0.6, adr: 100 } } } }]);
          if (sql.startsWith("SELECT event_id, payload FROM biz_events")) return result([{
            event_id: "E-7001", payload: { decision: { params: { expected: { target: 0.7 } } } },
          }]);
          if (sql.startsWith("SELECT id, preset_key FROM agents")) return result([{ id: "unit-worker", preset_key: "unit-role" }]);
          if (sql.startsWith("SELECT a.status, count(*)")) return result([{ status: "approved", n: "4" }, { status: "rejected", n: "6" }]);
          if (sql.startsWith("SELECT count(*)::text AS n FROM biz_events")) return result([{ n: sql.includes("'hr.review'") ? "1" : sql.includes("'incident.%'") ? "3" : "5" }]);
          if (sql.startsWith("SELECT count(*)::text AS n FROM agents")) return result([{ n: "1" }]);
          if (sql.startsWith("SELECT count(*)::text AS n FROM approvals")) return result([{ n: "12" }]);
          if (sql.startsWith("SELECT count(*)::text AS total")) return result([{ total: "1", approved: "1" }]);
          if (sql.startsWith("SELECT status, meta FROM agents")) return result(rows.map((row) => ({ status: row.status, meta: row.meta })));
          if (sql.startsWith("SELECT tier, count(*)")) return result();
          if (sql.startsWith("SELECT status, GREATEST")) return result();
          if (sql.startsWith("SELECT payload->'decision'->'after'->>'overallRate'")) return result();
          if (sql.startsWith("SELECT payload->'decision'->>'action' AS action")) return result();
          if (sql.startsWith("SELECT payload->'decision'->'params'->>'verdict'")) return result();
          if (sql.startsWith("SELECT payload->'decision'->'params'->>'tier'")) return result();
          if (sql.startsWith("SELECT payload->'who'->>'id' AS who")) return result();
          throw new Error(`假客户端未登记生产 SQL：${sql}`);
        },
        release() { expect(inTransaction).toBe(false); releases[releaseIndex] = true; },
      };
    },
  } as unknown as pg.Pool;
  return { app, rows, events, queries, releases };
}

const beats: Array<{ label: string; run: (app: pg.Pool) => Promise<unknown>; actions: string[]; charter?: () => Charter }> = [
  { label: "晨报", run: (app) => runBriefingBeat(app, scope, "daily"), actions: ["ceo.briefing"] },
  { label: "队列裁决", run: (app) => runQueueBeat(app, scope), actions: ["ceo.decision"] },
  { label: "目标偏差", run: (app) => runDeviationBeat(app, scope), actions: ["initiative.launch"] },
  { label: "自治熔断", run: (app) => runBreakerBeat(app, scope), actions: ["ceo.circuit_breaker"] },
  { label: "决策回测", run: (app) => runOutcomeReviewBeat(app, scope), actions: ["decision.outcome"] },
  { label: "绩效评议及汰换提案", run: (app) => runHrReviewBeat(app, scope), actions: ["hr.review", "hr.replacement_proposal"] },
  { label: "汰换执行", run: (app) => applyReplacement(app, scope, { newPreset: { preset_key: "unit-role-v2", name: "新员工", fence_bindings: bindings, sop_fixes: ["依据链"], prompt_notes: "引用依据" } }, "unit-worker"), actions: ["hr.replacement_applied"] },
  { label: "董事会包", run: (app) => runBoardPackBeat(app, scope), actions: ["ceo.board_pack"] },
  { label: "编制扫描", run: (app) => runOrgScanBeat(app, scope), actions: ["org.hiring_proposal"] },
  { label: "试用到期降级与晨报", run: (app) => runBriefingBeat(app, scope, "daily"), actions: ["captain.mode_change", "ceo.briefing"], charter: () => {
    const charter = activeCharter();
    charter.mode = "trial";
    charter.grant = { event_id: "E-6000", granted_by: "unit-owner", granted_at: new Date().toISOString(), disclosure_version: "unit-v1", clauses: ["试用"], shadow_days: 3, trial_days: 7, trial_ends_at: new Date(0).toISOString(), retain_until: null };
    return charter;
  } },
];

describe("CEO actor 名册解析", () => {
  it("绑定按名册原样透传，不排序、扩权或引用其他工作区", async () => {
    const row = readyRow();
    row.fence_bindings = ["unit-z", "unit-a", "unit-z"];
    const f = fixture([row, { ...readyRow(), workspace_id: "other-workspace", fence_bindings: ["other-policy"] }]);
    await runBriefingBeat(f.app, scope, "daily");
    const client = await f.app.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const actor = await ceoActor(client, scope);
    expect(actor).toEqual({ id: "company-ceo", type: "agent", readonly: false, fenceBindings: ["unit-z", "unit-a", "unit-z"] });
    expect(actor.fenceBindings).not.toBe(row.fence_bindings);
    expect(() => checkPermission(actor, draft("other-agent"))).toThrow(/身份不一致/);
    await client.query("COMMIT"); client.release();
  });

  it.each([null, {}, "unit-policy", [""], [" "], ["unit-policy", 1]])("无效绑定 %j 失败关闭", async (value) => {
    const f = fixture([{ ...readyRow(), fence_bindings: value }]);
    await expect(runBriefingBeat(f.app, scope, "daily")).rejects.toThrow(/未声明 fence_bindings/);
    expect(f.events).toEqual([]);
  });

  it("同岗重复在编不挑选任意权限，失败关闭", async () => {
    const f = fixture([readyRow(), { ...readyRow(), readonly: true }]);
    await expect(runBriefingBeat(f.app, scope, "daily")).rejects.toThrow(/未声明 fence_bindings/);
    expect(f.events).toEqual([]);
  });

  it("每次实际写入重读名册，停用后下一拍不复用旧权限", async () => {
    const f = fixture();
    await runBriefingBeat(f.app, scope, "daily");
    f.rows[0]!.status = "disabled";
    await expect(runBriefingBeat(f.app, scope, "daily")).rejects.toThrow(/未声明 fence_bindings/);
    expect(f.events.map((event) => event.decision.action)).toEqual(["ceo.briefing"]);
  });

  it("宪章 disabled 完全静默，不查询岗位也不写事件", async () => {
    const f = fixture([], { charter: defaultCharter() });
    await expect(runBriefingBeat(f.app, scope, "daily")).resolves.toMatchObject({ eventId: "", skipped: expect.stringContaining("disabled") });
    expect(f.queries.some(({ sql }) => sql.includes("FROM agents"))).toBe(false);
    expect(f.events).toEqual([]);
  });
});

describe("治理模式继续经同一岗位权限链", () => {
  it.each(["shadow", "trial", "suspended", "active"] as const)("%s 简报保留治理模式，只有 shadow 标记 dry_run", async (mode) => {
    const charter = activeCharter();
    charter.mode = mode;
    const f = fixture([readyRow()], { charter });
    await runBriefingBeat(f.app, scope, "daily");
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.decision).toMatchObject({ action: "ceo.briefing", params: { mode } });
    expect(f.events[0]?.decision.params?.dry_run).toBe(mode === "shadow" ? true : undefined);
    expect(f.events[0]?.who).toEqual({ type: "agent", id: "company-ceo" });
    expect(f.releases.every(Boolean)).toBe(true);
  });

  it("影子期队列裁决记 dry_run 事件，审批行保持待审", async () => {
    const charter = activeCharter();
    charter.mode = "shadow";
    const f = fixture([readyRow()], { charter });
    await runQueueBeat(f.app, scope);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.decision).toMatchObject({ action: "ceo.decision", params: { dry_run: true } });
    expect(f.queries.some(({ sql }) => sql.startsWith("UPDATE approvals") || sql.startsWith("INSERT INTO approvals"))).toBe(false);
  });

  it.each(["disabled", "suspended"] as const)("%s 无队列执行权，不写事件、不读取 CEO 岗位", async (mode) => {
    const charter = activeCharter();
    charter.mode = mode;
    const f = fixture([], { charter });
    await expect(runQueueBeat(f.app, scope)).resolves.toMatchObject({ decided: 0, escalated: 0, skipped: expect.stringContaining(mode) });
    expect(f.events).toEqual([]);
    expect(f.queries.some(({ sql }) => sql.includes("FROM agents"))).toBe(false);
    expect(f.releases.every(Boolean)).toBe(true);
  });
});

describe.each(beats)("$label 实际节拍 → gateway 权限链", ({ run, actions, charter }) => {
  it("在编且有绑定：写入真实路径，who 与岗位身份一致", async () => {
    const f = fixture([readyRow()], { charter: charter?.() });
    await run(f.app);
    expect(f.events.map((event) => event.decision.action)).toEqual(actions);
    expect(f.events.every((event) => event.who.id === "company-ceo" && event.who.type === "agent")).toBe(true);
    expect(actions.every(isWriteAction)).toBe(true);
    expect(f.queries.filter(({ sql }) => sql.includes("FROM agents WHERE workspace_id=$1 AND preset_key=$2"))).toHaveLength(actions.length);
    expect(f.releases.every(Boolean)).toBe(true);
  });

  it.each([
    { label: "缺岗", rows: () => [] },
    { label: "停用", rows: () => [{ ...readyRow(), status: "disabled" as const }] },
    { label: "无效", rows: () => [{ ...readyRow(), status: "invalid" as const }] },
    { label: "无绑定", rows: () => [{ ...readyRow(), fence_bindings: [] }] },
    { label: "其他工作区", rows: () => [{ ...readyRow(), workspace_id: "other-workspace" }] },
  ])("$label：全部拒写并回滚，不以 system 身份豁免", async ({ rows }) => {
    const f = fixture(rows(), { charter: charter?.() });
    await expect(run(f.app)).rejects.toThrow(/未声明 fence_bindings/);
    expect(f.events).toEqual([]);
    expect(f.queries.some(({ sql }) => sql.startsWith("SELECT * FROM append_event_insert"))).toBe(false);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.releases.every(Boolean)).toBe(true);
  });

  it("只读岗位：gateway 拒写", async () => {
    const f = fixture([{ ...readyRow(), readonly: true }], { charter: charter?.() });
    await expect(run(f.app)).rejects.toThrow(/只读 preset/);
    expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("高危标记：透传给 gateway，无逐次审批引用拒写", async () => {
    const f = fixture([{ ...readyRow(), meta: { high_risk: true } }], { charter: charter?.() });
    await expect(run(f.app)).rejects.toThrow(/缺少逐次授权引用/);
    expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("岗位 SQL 失败：原错上抛、事件不写、事务释放", async () => {
    const error = new Error("unit-roster-query-failed");
    const f = fixture([readyRow()], { charter: charter?.(), rosterError: error });
    await expect(run(f.app)).rejects.toBe(error);
    expect(f.events).toEqual([]);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.releases.every(Boolean)).toBe(true);
  });
});

it("事件落库 SQL 失败不能回传成功 eventId", async () => {
  const error = new Error("unit-event-append-failed");
  const f = fixture([readyRow()], { appendError: error });
  await expect(runBriefingBeat(f.app, scope, "daily")).rejects.toBe(error);
  expect(f.events).toEqual([]);
  expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  expect(f.releases.every(Boolean)).toBe(true);
});
