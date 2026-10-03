/**
 * MC-018/118：正式 L2 队列的并发状态转换。
 * 使用真实 runQueueBeat、gateway 和非超级用户 PostgreSQL。测试运行器先执行全部迁移，
 * 并显式提供自己的一次性 Unix socket；合成触发器只测数据库通知，不调用外部连接器。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCharter, type CeoMode } from "./charter.js";
import { runQueueBeat, type Scope } from "./loop.js";
import { eventHash } from "../workdata/events.js";

const socket = process.env.CEO_ESCALATION_SOCKET ?? "";
const database = process.env.CEO_ESCALATION_DATABASE ?? "";
const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && process.env.CEO_ESCALATION_TASK_OWNED === "1"
  && /^\/tmp\/wl-ceo-escalation-[a-z0-9_-]+$/i.test(socket)
  && /^ceo_escalation_(base|hotel)_[a-z0-9_]+$/.test(database);

type Verdict = "approve" | "escalate";
interface ApprovalRow extends pg.QueryResultRow {
  approval_id: string; tenant_id: string; workspace_id: string; event_id: string;
  status: string; tier: string; snapshot: Record<string, unknown>;
  gesture: unknown; decided_by: string | null; decided_at: Date | null;
}
interface AuditRow extends pg.QueryResultRow {
  seq: string; tenant_id: string; workspace_id: string; prev_hash: string; hash: string;
  payload: { who: { id: string; type: string }; decision: { action: string; params: Record<string, unknown> } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`test-only rendezvous timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitUntil(condition: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`test-only condition timeout: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe.runIf(RUN_DB)("MC-018 正式 CEO 队列 PostgreSQL 状态竞争", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = `ceo_escalation_${suffix}`;
  const scopeA: Scope = { tenantId: `${prefix}_tenant_a`, workspaceId: `${prefix}_ws_a` };
  const scopeB: Scope = { tenantId: `${prefix}_tenant_b`, workspaceId: `${prefix}_ws_b` };
  const scopeC: Scope = { tenantId: scopeA.tenantId, workspaceId: `${prefix}_ws_c` };
  const scopes = [scopeA, scopeB, scopeC];
  const ids = scopes.map((scope) => scope.workspaceId);
  const logTable = `${prefix}_writes`;
  const writeTrigger = `${prefix}_update`;
  const changeChannel = `${prefix}_changes`;
  const barrierChannel = `${prefix}_barrier`;
  const standard = { action: "record.update", params: {} };
  const notifications: Array<{ actor: string; approval_id: string }> = [];
  let owner: pg.Pool;
  let app: pg.Pool;
  let gateway: pg.Pool;
  let observer: pg.Client;
  let barrierSerial = 0;

  function evidence(name: string, value: unknown): void {
    console.info(`MC-018 evidence ${JSON.stringify({ name, value })}`);
  }

  async function drain(): Promise<void> {
    const marker = `${++barrierSerial}`;
    const gate = deferred();
    const onNotification = (notification: pg.Notification) => {
      if (notification.channel === barrierChannel && notification.payload === marker) gate.resolve();
    };
    observer.on("notification", onNotification);
    try {
      await owner.query("SELECT pg_notify($1,$2)", [barrierChannel, marker]);
      await waitFor(gate.promise, "notification delivery");
    } finally { observer.removeListener("notification", onNotification); }
  }

  async function approvalRows(): Promise<ApprovalRow[]> {
    return (await owner.query<ApprovalRow>(
      "SELECT * FROM approvals WHERE workspace_id=ANY($1::text[]) ORDER BY approval_id", [ids],
    )).rows;
  }

  async function auditRows(): Promise<AuditRow[]> {
    return (await owner.query<AuditRow>(
      "SELECT seq::text,tenant_id,workspace_id,payload,prev_hash,hash FROM biz_events WHERE workspace_id=ANY($1::text[]) ORDER BY biz_events.seq", [ids],
    )).rows;
  }

  async function before() {
    await drain(); notifications.length = 0;
    await owner.query(`DELETE FROM ${logTable}`);
    return { approvals: await approvalRows(), audits: await auditRows() };
  }

  async function effects(previous: Awaited<ReturnType<typeof before>>, expected: {
    writes: number; audits: number; verdict?: Verdict; dryRun?: boolean;
    approvals?: ApprovalRow[];
  }) {
    await drain();
    const approvals = await approvalRows();
    const allAudits = await auditRows();
    const audits = allAudits.slice(previous.audits.length);
    const writes = (await owner.query<{ actor: string; approval_id: string }>(`SELECT actor,approval_id FROM ${logTable} ORDER BY id`)).rows;
    const appWrites = writes.filter((row) => row.actor === "workloom_app");
    const appNotifications = notifications.filter((row) => row.actor === "workloom_app");
    evidence("committed-effects", { approvals, appWrites, fixtureWrites: writes.filter((row) => row.actor !== "workloom_app"), audits, appNotifications });
    expect(allAudits.slice(0, previous.audits.length)).toEqual(previous.audits);
    expect(appWrites).toHaveLength(expected.writes);
    expect(appNotifications).toHaveLength(expected.writes);
    expect(audits).toHaveLength(expected.audits);
    if (expected.approvals) expect(approvals).toEqual(expected.approvals);
    for (const row of audits) {
      expect(row.payload.who).toEqual({ type: "agent", id: "company-ceo" });
      expect(row.payload.decision.action).toBe("ceo.decision");
      expect(row.payload.decision.params.dry_run).toBe(expected.dryRun ? true : undefined);
      if (expected.verdict) expect(row.payload.decision.params.verdict).toBe(expected.verdict);
      expect(row.hash).toBe(eventHash(row.prev_hash, row.payload));
    }
    return { approvals, audits, appWrites };
  }

  async function insert(id: string, snapshot: Record<string, unknown> = standard, scope = scopeA, tier = "l2_captain") {
    await owner.query(
      "INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,channel,status,tier,snapshot) VALUES($1,$2,$3,$4,'inapp','pending',$5,$6::jsonb)",
      [id, scope.tenantId, scope.workspaceId, `E-RPL-${prefix}-${id}`, tier, JSON.stringify(snapshot)],
    );
  }

  async function reset(mode: CeoMode = "active", snapshot: Record<string, unknown> | null = standard) {
    await owner.query("DELETE FROM approvals WHERE workspace_id=ANY($1::text[])", [ids]);
    const charter = defaultCharter(); charter.mode = mode;
    charter.autonomy.ranges = { unit: { label: "变更比例", lower: 0.8, upper: 1.2, anchor: 1 } };
    for (const scope of scopes) {
      await owner.query("UPDATE profiles SET archive=$2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify({ charter })]);
      await owner.query("UPDATE agents SET status='ready',readonly=false,fence_bindings='[\"test-only-policy\"]',meta='{}' WHERE workspace_id=$1", [scope.workspaceId]);
    }
    if (snapshot) await insert(`${prefix}_approval`, snapshot);
  }

  const model = (verdict: Verdict, rationale = "test-only decision") => async () => JSON.stringify({ verdict, rationale });

  async function ordered(firstVerdict: Verdict, lateVerdict: Verdict) {
    let arrived = 0;
    const selected = deferred(); const lateGate = deferred();
    const arrive = async () => { if (++arrived === 2) selected.resolve(); await waitFor(selected.promise, "both selected L2"); };
    const first = runQueueBeat(app, scopeA, { llmCall: async () => { await arrive(); return model(firstVerdict)(); } });
    const late = runQueueBeat(app, scopeA, { llmCall: async () => {
      await arrive(); await waitFor(lateGate.promise, "first COMMIT"); return model(lateVerdict)();
    } });
    const observations = await Promise.all([
      first.finally(() => lateGate.resolve()), late,
    ]);
    expect(arrived).toBe(2); evidence("ordered-responses", observations);
    return observations;
  }

  beforeAll(async () => {
    const config = { host: socket, database, port: Number(process.env.CEO_ESCALATION_PORT), connectionTimeoutMillis: 5000, statement_timeout: 8000 };
    owner = new pg.Pool({ ...config, user: "postgres", max: 2 });
    app = new pg.Pool({ ...config, user: "workloom_app", max: 16 });
    gateway = new pg.Pool({ ...config, user: "workloom_gateway", max: 1 });
    expect((await owner.query("SHOW listen_addresses")).rows[0]?.listen_addresses).toBe("");
    for (const [pool, role] of [[app, "workloom_app"], [gateway, "workloom_gateway"]] as const) {
      const actual = (await pool.query("SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows;
      expect(actual).toEqual([{ role, rolsuper: false, rolbypassrls: false }]); evidence("actual-role", actual);
    }
    for (const tenant of [scopeA.tenantId, scopeB.tenantId]) await owner.query("INSERT INTO tenants(id,name) VALUES($1,'test-only CEO concurrency')", [tenant]);
    for (const scope of scopes) {
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'test-only CEO',$1,'unit')", [scope.workspaceId, scope.tenantId]);
      await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'unit','{}')", [scope.workspaceId, scope.tenantId]);
      await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,fence_bindings) VALUES($1,$2,'company-ceo','test-only CEO','unit-v1','commander','[\"test-only-policy\"]')", [`${scope.workspaceId}_agent`, scope.workspaceId]);
    }
    await owner.query(`CREATE TABLE ${logTable}(id BIGSERIAL PRIMARY KEY,actor text NOT NULL,approval_id text NOT NULL)`);
    await owner.query(`CREATE FUNCTION ${writeTrigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      DECLARE body jsonb; BEGIN
        IF OLD.workspace_id LIKE '${prefix}_ws_%' THEN
          INSERT INTO ${logTable}(actor,approval_id) VALUES(session_user,OLD.approval_id);
          body=jsonb_build_object('actor',session_user,'approval_id',OLD.approval_id);
          PERFORM pg_notify('${changeChannel}',body::text);
        END IF; RETURN NULL; END $$`);
    await owner.query(`CREATE TRIGGER ${writeTrigger} AFTER UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION ${writeTrigger}()`);
    observer = new pg.Client({ ...config, user: "postgres" }); await observer.connect();
    observer.on("notification", (notification) => {
      if (notification.channel === changeChannel && notification.payload) notifications.push(JSON.parse(notification.payload) as typeof notifications[number]);
    });
    await observer.query(`LISTEN ${changeChannel}`); await observer.query(`LISTEN ${barrierChannel}`);
  });

  afterAll(async () => {
    // 不删除或改写 append-only 账本；一次性 runner 在保存取证后销毁整个自有数据库集群。
    await observer?.end(); await app?.end(); await gateway?.end(); await owner?.end();
  });

  it.each([2, 12])("%i 路已读同一 L2 的正式上浮只提交一次", async (count) => {
    await reset(); const previous = await before(); let arrived = 0;
    const selected = deferred();
    const response = await Promise.all(Array.from({ length: count }, () => runQueueBeat(app, scopeA, { llmCall: async () => {
      if (++arrived === count) selected.resolve(); await waitFor(selected.promise, "all concurrent L2 reads"); return model("escalate")();
    } })));
    evidence("parallel-responses", response); expect(arrived).toBe(count);
    const actual = await effects(previous, { writes: 1, audits: 1, verdict: "escalate" });
    expect(response.reduce((sum, result) => sum + result.escalated, 0)).toBe(1);
    expect(actual.approvals[0]).toMatchObject({ status: "pending", tier: "l4_chairman", gesture: null, decided_by: null });
    expect(actual.approvals[0]?.snapshot).toMatchObject({ ...standard, ceo_escalated: true, ceo_rationale: expect.any(String) });
  });

  it.each([
    ["escalate", "approve"], ["approve", "escalate"], ["approve", "approve"], ["escalate", "escalate"],
  ] as const)("同读旧 L2 后 %s 先提交，迟到 %s 不再写入", async (firstVerdict, lateVerdict) => {
    await reset(); const previous = await before(); const response = await ordered(firstVerdict, lateVerdict);
    const actual = await effects(previous, { writes: 1, audits: 1, verdict: firstVerdict });
    expect(response[0]).toMatchObject(firstVerdict === "escalate" ? { escalated: 1, decided: 0 } : { decided: 1, escalated: 0 });
    expect(response[1]).toMatchObject({ decided: 0, escalated: 0 });
    expect(actual.approvals[0]).toMatchObject(firstVerdict === "escalate"
      ? { status: "pending", tier: "l4_chairman", decided_by: null, gesture: null }
      : { status: "approved", tier: "l2_captain", decided_by: "company-ceo", gesture: { type: "approve" } });
  });

  it.each(["l3_fleet", "l4_chairman"])("新读 %s 不进入 L2 模型或正式写路径", async (tier) => {
    await reset("active", null); await insert(`${prefix}_approval`, standard, scopeA, tier);
    const previous = await before(); let calls = 0;
    const response = await runQueueBeat(app, scopeA, { llmCall: async () => { calls++; return model("approve")(); } });
    expect(response).toMatchObject({ decided: 0, escalated: 0 }); expect(calls).toBe(0);
    await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
  });

  it.each(["approve", "escalate"] as const)("%s 推理期间有效 L2 自然过期后失效", async (verdict) => {
    const expires = Date.now() + 600;
    await reset("active", { ...standard, expires_at: new Date(expires).toISOString() });
    const previous = await before(); let calls = 0;
    const response = await runQueueBeat(app, scopeA, { llmCall: async () => {
      calls++;
      while (Date.now() <= expires) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return model(verdict)();
    } });
    evidence("expired-response", response); expect(calls).toBe(1);
    await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
    expect(response).toMatchObject({ decided: 0, escalated: 0 });
  });

  it.each(["approve", "escalate"] as const)("%s SQL 开始时有效但等待行锁期间过期也不生效", async (verdict) => {
    const expires = Date.now() + 1200;
    await reset("active", { ...standard, expires_at: new Date(expires).toISOString() });
    const previous = await before(); const blocker = await owner.connect();
    const locked = deferred(); let committed = false;
    const settled = runQueueBeat(app, scopeA, { llmCall: async () => {
      await blocker.query("BEGIN");
      await blocker.query("SELECT approval_id FROM approvals WHERE approval_id=$1 FOR UPDATE", [`${prefix}_approval`]);
      locked.resolve(); return model(verdict)();
    } }).then((response) => ({ response }), (error: unknown) => ({ error }));
    try {
      await waitFor(locked.promise, "row lock obtained");
      await waitUntil(async () => {
        const waiting = await owner.query<{ started: Date }>(
          "SELECT xact_start AS started FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'UPDATE approvals%'",
        );
        if (!waiting.rows.length) return false;
        expect(waiting.rows[0]?.started.getTime()).toBeLessThan(expires); return true;
      }, "actual UPDATE blocked on the approval");
      while (Date.now() <= expires) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await blocker.query("COMMIT"); committed = true;
      const outcome = await settled; if ("error" in outcome) throw outcome.error;
      evidence("expired-lock-wait-response", outcome.response);
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      expect(outcome.response).toMatchObject({ decided: 0, escalated: 0 });
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release(); await settled;
    }
  }, 10000);

  const staleChanges = [
    ["tier-l3", "UPDATE approvals SET tier='l3_fleet' WHERE approval_id=$1"],
    ["tier-l4", "UPDATE approvals SET tier='l4_chairman' WHERE approval_id=$1"],
    ["status-approved", "UPDATE approvals SET status='approved' WHERE approval_id=$1"],
    ["status-rejected", "UPDATE approvals SET status='rejected' WHERE approval_id=$1"],
    ["status-edited", "UPDATE approvals SET status='edited' WHERE approval_id=$1"],
    ["status-expired", "UPDATE approvals SET status='expired' WHERE approval_id=$1"],
    ["changed-snapshot", "UPDATE approvals SET snapshot=snapshot || '{\"params\":{\"changed\":true}}'::jsonb WHERE approval_id=$1"],
    ["rebound-event", "UPDATE approvals SET event_id=event_id || '-new' WHERE approval_id=$1"],
    ["deleted-approval", "DELETE FROM approvals WHERE approval_id=$1"],
  ] as const;

  describe.each(["approve", "escalate"] as const)("%s 旧快照竞争", (verdict) => {
    it.each(staleChanges)("%s 改变后保留新状态且不制造计数/通知/审计", async (_, sql) => {
      await reset(); const previous = await before(); let current: ApprovalRow[] = [];
      const response = await runQueueBeat(app, scopeA, { llmCall: async () => {
        await owner.query(sql, [`${prefix}_approval`]); current = await approvalRows(); return model(verdict)();
      } });
      evidence("stale-response", response);
      await effects(previous, { writes: 0, audits: 0, approvals: current });
      expect(response).toMatchObject({ decided: 0, escalated: 0 });
    });
  });

  it("推理期间审批移至同租户另一工作区后旧作用域失效", async () => {
    await reset(); const previous = await before(); let moved: ApprovalRow[] = [];
    const response = await runQueueBeat(app, scopeA, { llmCall: async () => {
      await owner.query("UPDATE approvals SET workspace_id=$2 WHERE approval_id=$1", [`${prefix}_approval`, scopeC.workspaceId]);
      moved = await approvalRows(); return model("approve")();
    } });
    await effects(previous, { writes: 0, audits: 0, approvals: moved }); expect(response.decided).toBe(0);
    expect((await app.query("SELECT count(*)::int AS n FROM approvals")).rows[0]?.n).toBe(0);
  });

  it("不同租户与同租户不同工作区只裁自己的有效审批", async () => {
    await reset("active", null);
    for (const scope of scopes) await insert(`${scope.workspaceId}_approval`, standard, scope);
    const previous = await before();
    const response = await Promise.all(scopes.map((scope) => runQueueBeat(app, scope, { llmCall: model("escalate") })));
    expect(response.map((row) => row.escalated)).toEqual([1, 1, 1]);
    const actual = await effects(previous, { writes: 3, audits: 3, verdict: "escalate" });
    for (const scope of scopes) expect(actual.audits.filter((row) => row.workspace_id === scope.workspaceId && row.tenant_id === scope.tenantId)).toHaveLength(1);
  });

  it("同工作区不同审批的并发不丢转换，每单各一次", async () => {
    await reset(); await insert(`${prefix}_approval_second`); const previous = await before();
    let arrived = 0; const selected = deferred();
    const response = await Promise.all(Array.from({ length: 2 }, () => {
      let calls = 0;
      return runQueueBeat(app, scopeA, { llmCall: async () => {
        if (++calls === 1) { if (++arrived === 2) selected.resolve(); await waitFor(selected.promise, "distinct approval queue reads"); }
        return model("escalate")();
      } });
    }));
    const actual = await effects(previous, { writes: 2, audits: 2, verdict: "escalate" });
    expect(response.reduce((sum, row) => sum + row.escalated, 0)).toBe(2);
    expect(new Set(actual.appWrites.map((row) => row.approval_id)).size).toBe(2);
  });

  it("特殊文本和空参数作为数据上浮，原快照字段保留", async () => {
    const id = `${prefix}_'引号\"换行\n%_\\😀`;
    const snapshot = { ...standard, title: id, params: {}, nested: { z: [null, "中文"], a: 1 }, expires_at: null };
    await reset("active", null); await insert(id, snapshot); const previous = await before();
    expect((await runQueueBeat(app, scopeA, { llmCall: model("escalate", "引号\"换行\n%_\\😀") })).escalated).toBe(1);
    const actual = await effects(previous, { writes: 1, audits: 1, verdict: "escalate" });
    expect(actual.approvals[0]?.snapshot).toMatchObject(snapshot);
    expect(actual.audits[0]?.payload.decision.params.approval_id).toBe(id);
  });

  it("影子并发每拍保留独立 dry_run 审计且没有审批写入", async () => {
    await reset("shadow"); const previous = await before(); let arrived = 0; const selected = deferred();
    const response = await Promise.all(Array.from({ length: 4 }, () => runQueueBeat(app, scopeA, { llmCall: async () => {
      if (++arrived === 4) selected.resolve(); await waitFor(selected.promise, "shadow reads"); return model("escalate")();
    } })));
    expect(response.map((row) => row.escalated)).toEqual([1, 1, 1, 1]);
    await effects(previous, { writes: 0, audits: 4, verdict: "escalate", dryRun: true, approvals: previous.approvals });
  });

  describe.each(["approve", "escalate"] as const)("%s 推理后权限回归", (verdict) => {
    it.each([
      ["只读", "readonly=true", /只读 preset/],
      ["停用", "status='disabled'", /未声明 fence_bindings/],
      ["去绑定", "fence_bindings='[]'", /未声明 fence_bindings/],
      ["高危逐次审批", "meta='{\"high_risk\":true}'", /缺少逐次授权引用/],
    ] as const)("推理后岗位%s权限实时收紧，业务与审计回滚，恢复后可重试", async (_, change, reason) => {
      await reset(); const previous = await before();
      await expect(runQueueBeat(app, scopeA, { llmCall: async () => {
        await owner.query(`UPDATE agents SET ${change} WHERE workspace_id=$1`, [scopeA.workspaceId]); return model(verdict)();
      } })).rejects.toThrow(reason);
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      await owner.query("UPDATE agents SET status='ready',readonly=false,fence_bindings='[\"test-only-policy\"]',meta='{}' WHERE workspace_id=$1", [scopeA.workspaceId]);
      const retry = await before(); const response = await runQueueBeat(app, scopeA, { llmCall: model(verdict) });
      expect(response.decided + response.escalated).toBe(1);
      await effects(retry, { writes: 1, audits: 1, verdict });
    });
  });

  describe.each(["approve", "escalate"] as const)("%s 事务失败重试", (verdict) => {
    it.each(["approval-update", "audit-insert", "commit"] as const)("%s SQL 失败回滚审批/通知/审计，去故障后重试一次", async (point) => {
      await reset(); const previous = await before(); const name = `${prefix}_failure`;
      const table = point === "approval-update" ? "approvals" : "biz_events";
      const condition = point === "approval-update" ? "session_user='workloom_app'" : `NEW.workspace_id='${scopeA.workspaceId}'`;
      await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'test-only MC018 ${point} failure'; END IF; RETURN NEW; END $$`);
      try {
        const definition = point === "commit"
          ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`
          : `CREATE TRIGGER ${name} BEFORE ${point === "approval-update" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`;
        await owner.query(definition);
        try {
          await expect(runQueueBeat(app, scopeA, { llmCall: model(verdict) })).rejects.toThrow(`test-only MC018 ${point} failure`);
          await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
        } finally { await owner.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`); }
      } finally { await owner.query(`DROP FUNCTION IF EXISTS ${name}()`); }
      const retry = await before(); const response = await runQueueBeat(app, scopeA, { llmCall: model(verdict) });
      expect(response.decided + response.escalated).toBe(1);
      await effects(retry, { writes: 1, audits: 1, verdict });
    });
  });

  it.each(["approve", "escalate"] as const)("%s 首拍拿锁后审计失败，已等锁后拍接续且仍只提交一次", async (verdict) => {
    await reset(); const previous = await before(); const name = `${prefix}_fail_once`;
    const blocker = await owner.connect(); const lateGate = deferred(); const selected = deferred();
    let arrived = 0; let committed = false;
    await owner.query(`CREATE SEQUENCE ${name}`);
    await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN IF NEW.workspace_id='${scopeA.workspaceId}' AND nextval('public.${name}')=1 THEN
        PERFORM pg_advisory_xact_lock(hashtext('${name}')); RAISE EXCEPTION 'test-only MC018 first audit fails';
      END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
    const arrive = async () => { if (++arrived === 2) selected.resolve(); await waitFor(selected.promise, "both before first failure"); };
    const first = runQueueBeat(app, scopeA, { llmCall: async () => { await arrive(); return model(verdict)(); } });
    const late = runQueueBeat(app, scopeA, { llmCall: async () => { await arrive(); await waitFor(lateGate.promise, "first audit blocked"); return model(verdict)(); } });
    const settled = Promise.allSettled([first, late]);
    try {
      await waitUntil(async () => (await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM append_event_insert%'",
      )).rowCount !== 0, "first audit waits on injected fault gate");
      lateGate.resolve();
      await waitUntil(async () => (await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'UPDATE approvals%'",
      )).rowCount !== 0, "follower waits for first approval transaction");
      await blocker.query("COMMIT"); committed = true;
      const outcomes = await settled;
      evidence("failed-first-concurrent-responses", outcomes.map((entry) => entry.status === "fulfilled"
        ? entry : { status: entry.status, reason: String(entry.reason) }));
      expect(outcomes[0]?.status).toBe("rejected");
      if (outcomes[0]?.status === "rejected") expect(String(outcomes[0].reason)).toContain("test-only MC018 first audit fails");
      expect(outcomes[1]?.status).toBe("fulfilled");
      if (outcomes[1]?.status === "fulfilled") expect(outcomes[1].value.decided + outcomes[1].value.escalated).toBe(1);
      await effects(previous, { writes: 1, audits: 1, verdict });
    } finally {
      lateGate.resolve(); if (!committed) await blocker.query("ROLLBACK");
      blocker.release(); await settled;
      await owner.query(`DROP TRIGGER IF EXISTS ${name} ON biz_events`);
      await owner.query(`DROP FUNCTION IF EXISTS ${name}()`); await owner.query(`DROP SEQUENCE IF EXISTS ${name}`);
    }
  }, 15000);

  it("所有自测审计逐租户工作区哈希链保持追加语义", async () => {
    const tails = new Map<string, string>(); const rows = await auditRows();
    for (const row of rows) {
      const key = `${row.tenant_id}:${row.workspace_id}`;
      expect(row.prev_hash).toBe(tails.get(key) ?? "GENESIS"); expect(row.hash).toBe(eventHash(row.prev_hash, row.payload)); tails.set(key, row.hash);
    }
    expect(tails.size).toBe(3); evidence("audit-chain", { events: rows.length, independentChains: tails.size });
  });
});
