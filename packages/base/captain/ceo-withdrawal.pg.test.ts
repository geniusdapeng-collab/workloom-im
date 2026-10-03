/**
 * MC-021/121：章程变化与正式 CEO 节拍的同事务授权线性化。
 * 使用真实 runQueueBeat、gateway 和非超级用户 PostgreSQL。测试运行器先执行全部迁移，
 * 并显式提供自己的一次性 Unix socket；合成触发器只测数据库通知，不调用外部连接器。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCharter, type CeoMode, type Charter } from "./charter.js";
import { runQueueBeat, runBriefingBeat, runHrReviewBeat, runBoardPackBeat, runDeviationBeat, runBreakerBeat, runOutcomeReviewBeat, runOrgScanBeat, type Scope } from "./loop.js";
import { gatewayAppend } from "../workdata/gateway.js";
import { eventHash } from "../workdata/events.js";

const socket = process.env.CEO_ESCALATION_SOCKET ?? "";
const database = process.env.CEO_ESCALATION_DATABASE ?? "";
const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && process.env.CEO_WITHDRAWAL_TASK_OWNED === "1"
  && /^\/tmp\/wl-ceo-escalation-withdrawal-[a-z0-9_-]+$/i.test(socket)
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

describe.runIf(RUN_DB)("MC-021 真实 PostgreSQL 章程撤权与节拍", () => {
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
    console.info(`MC-021 evidence ${JSON.stringify({ name, value })}`);
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
    approvals?: ApprovalRow[]; actions?: string[];
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
      expect(expected.actions ?? ["ceo.decision"]).toContain(row.payload.decision.action);
      if (expected.dryRun) expect(row.payload.decision.params.dry_run).toBe(true);
      else expect(row.payload.decision.params.dry_run).not.toBe(true);
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
    charter.autonomy.caps = { unit: { label: "单笔上限", limit: 1000 } };
    charter.circuit_breaker.kpi_floor = { occ: 0.7 };
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
    owner = new pg.Pool({ ...config, user: "postgres", max: 4 });
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
      await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,fence_bindings) VALUES($1,$2,'company-ceo','test-only CEO','unit-v1','commander','[\"test-only-policy\"]')", [`company-ceo-${scope.workspaceId}`, scope.workspaceId]);
    }
    await owner.query(`CREATE TABLE ${logTable}(id BIGSERIAL PRIMARY KEY,actor text NOT NULL,approval_id text NOT NULL)`);
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,fence_bindings) VALUES($1,$2,'unit-worker','test-only worker','unit-v1','specialist','[\"test-only-policy\"]')", [`${scopeA.workspaceId}_worker`, scopeA.workspaceId]);
    await owner.query(`CREATE FUNCTION ${writeTrigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      DECLARE body jsonb; row_data jsonb; BEGIN
        row_data=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
        IF row_data->>'workspace_id' LIKE '${prefix}_ws_%' THEN
          body=jsonb_build_object('actor',session_user,'approval_id',TG_TABLE_NAME||':'||COALESCE(row_data->>'approval_id',row_data->>'id',row_data->>'workspace_id'));
          INSERT INTO ${logTable}(actor,approval_id) VALUES(session_user,body->>'approval_id');
          PERFORM pg_notify('${changeChannel}',body::text);
        END IF; RETURN NULL; END $$`);
    for (const table of ['approvals','profiles','agents']) await owner.query(`CREATE TRIGGER ${writeTrigger} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${writeTrigger}()`);
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

  type Hook = () => Promise<void>;
  type Beat = { name: string; actions: string[]; writes: number; run: (pool: pg.Pool, hook?: Hook, target?: Scope) => Promise<unknown>; shadowAudits: number };

  function betweenReadAndWrite(pool: pg.Pool, hook?: Hook, checkpoint: (sql: string) => boolean = (sql) => /^SELECT archive/.test(sql)): pg.Pool {
    if (!hook) return pool;
    let used = false;
    return { async connect() {
      const client = await pool.connect();
      return { async query(sql: string, values?: unknown[]) {
        const response = await client.query(sql, values);
        if (!used && checkpoint(sql.trim()) && !/FOR SHARE|FOR UPDATE/.test(sql)) { used = true; await hook(); }
        return response;
      }, release() { client.release(); } };
    } } as unknown as pg.Pool;
  }

  const beats: Beat[] = [
    ...(["approve", "escalate"] as const).map((verdict): Beat => ({ name: `queue-${verdict}`, actions: ["ceo.decision"], writes: 1, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runQueueBeat(pool, target, { llmCall: async () => { await hook?.(); return model(verdict)(); } }) })),
    { name: "briefing", actions: ["ceo.briefing"], writes: 0, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runBriefingBeat(pool, target, "daily", { llmCall: async () => { await hook?.(); return "test-only complete model briefing"; } }) },
    { name: "hr", actions: ["hr.review", "hr.replacement_proposal"], writes: 1, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runHrReviewBeat(pool, target, { llmCall: async () => { await hook?.(); return JSON.stringify({ sop_fixes: ["unit"], fence_bindings: ["test-only-policy"], prompt_notes: "unit" }); } }) },
    { name: "board", actions: ["ceo.board_pack"], writes: 0, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runBoardPackBeat(betweenReadAndWrite(pool, hook, (sql) => /^SELECT count\(\*\)::text AS total/.test(sql)), target) },
    { name: "deviation", actions: ["initiative.launch"], writes: 0, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runDeviationBeat(betweenReadAndWrite(pool, hook, (sql) => /^SELECT payload FROM biz_events/.test(sql) && sql.includes("'goal.tracking'")), target) },
    { name: "breaker", actions: ["ceo.circuit_breaker"], writes: 1, shadowAudits: 0,
      run: (pool, hook, target = scopeA) => runBreakerBeat(betweenReadAndWrite(pool, hook, (sql) => /^SELECT payload FROM biz_events/.test(sql) && sql.includes("'store.daily.summary'")), target) },
    { name: "outcome", actions: ["decision.outcome"], writes: 0, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runOutcomeReviewBeat(betweenReadAndWrite(pool, hook, (sql) => /^SELECT payload FROM biz_events/.test(sql) && sql.includes("'store.daily.summary'")), target) },
    { name: "org", actions: ["org.hiring_proposal"], writes: 1, shadowAudits: 1,
      run: (pool, hook, target = scopeA) => runOrgScanBeat(betweenReadAndWrite(pool, hook, (sql) => /^SELECT payload->'who'->>'id' AS who/.test(sql)), target) },
  ];

  async function rawCharter(): Promise<Charter> {
    return (await owner.query<{ charter: Charter }>("SELECT archive->'charter' AS charter FROM profiles WHERE workspace_id=$1", [scopeA.workspaceId])).rows[0]!.charter;
  }
  async function writeCharter(charter: unknown, client: pg.Pool | pg.PoolClient = owner, target = scopeA): Promise<void> {
    await client.query("UPDATE profiles SET archive=jsonb_set(archive,'{charter}',$2::jsonb) WHERE workspace_id=$1", [target.workspaceId, JSON.stringify(charter)]);
  }
  async function seed(action: string, params: Record<string, unknown> = {}, after: Record<string, unknown> = {}, who = "company-ceo") {
    await gatewayAppend(gateway, { ...scopeA, actor: { id: who, type: "human" } }, {
      who: { type: "human", id: who }, context: { tenant_id: scopeA.tenantId, workspace_id: scopeA.workspaceId, time: new Date().toISOString() },
      object: { type: "unit", id: scopeA.workspaceId }, decision: { action, params, after, basis: ["synthetic fixture"] }, rule_impact: [],
    });
  }
  async function prepare(beat: Beat, mode: CeoMode = "active") {
    await reset(mode);
    if (beat.name === "hr") {
      for (let i = 0; i < 3; i++) await seed("incident.unit", {}, {}, `${scopeA.workspaceId}_worker`);
      await seed("hr.review", { agent_id: `${scopeA.workspaceId}_worker`, grade: "辅导" });
    }
    if (beat.name === "breaker") await seed("store.daily.summary", {}, { occ: 0.5 });
    if (beat.name === "deviation") await seed("goal.tracking", {}, { deviation_pt: -8 });
    if (beat.name === "outcome") {
      await seed("store.daily.summary", {}, { occ: 0.8 });
      await seed("ceo.decision", { expected: { target: 0.7, review_at: new Date(0).toISOString() } });
    }
    if (beat.name === "org") for (let i = 0; i < 9; i++) await insert(`${prefix}_extra_${i}`);
  }
  function expectNoSuccess(response: unknown) {
    const row = response as Record<string, unknown>;
    for (const key of ["decided", "escalated", "initiatives", "reviewed", "hits", "coaching", "replacementProposals"]) if (key in row) expect(row[key]).toBe(0);
    for (const key of ["tightened", "proposal"]) if (key in row) expect(row[key]).toBe(false);
    if ("eventId" in row) expect(row.eventId).toBe("");
  }
  async function untilExpired(deadline: string) {
    await waitUntil(async () => (await owner.query<{ expired: boolean }>("SELECT clock_timestamp()>=$1::timestamptz AS expired", [deadline])).rows[0]!.expired, "actual PostgreSQL grant deadline");
  }
  function grant(deadline: string, mode: "active" | "trial" = "active"): NonNullable<Charter["grant"]> {
    return { event_id: "E-7000", granted_by: "unit-owner", granted_at: new Date().toISOString(), disclosure_version: "unit-v1", clauses: ["unit"], shadow_days: 3, trial_days: 7,
      trial_ends_at: mode === "trial" ? deadline : null, retain_until: mode === "active" ? deadline : null };
  }
  const changes = [
    ["version", (c: Charter) => ({ ...c, version: c.version + 1 })],
    ["suspended", (c: Charter) => ({ ...c, mode: "suspended" })],
    ["disabled", (c: Charter) => ({ ...c, mode: "disabled" })],
    ["shadow", (c: Charter) => ({ ...c, mode: "shadow" })],
    ["budget-tightened", (c: Charter) => ({ ...c, autonomy: { ...c.autonomy, caps: { unit: { label: "单笔上限", limit: 10 } } } })],
  ] as const;

  describe.each(beats)("$name 正式节拍", (beat) => {
    it("有效授权正常运行并形成真实回执", async () => {
      await prepare(beat); const previous = await before(); const response = await beat.run(app);
      evidence("normal", { beat: beat.name, response });
      await effects(previous, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    });
    it.each(changes)("推理/真实取数后 %s 先提交，旧结果不能提交任何正式效果，重新授权后重试", async (name, change) => {
      await prepare(beat); const original = await rawCharter(); const previous = await before(); let calls = 0;
      const response = await beat.run(app, async () => { calls++; await writeCharter(change(original)); });
      expect(calls).toBe(1); evidence("withdrawn", { beat: beat.name, name, response }); expectNoSuccess(response);
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      expect(await rawCharter()).toEqual(change(original));
      await writeCharter({ ...original, version: original.version + 1, updated_at: new Date().toISOString() });
      const retry = await before(); await beat.run(app);
      await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    });
    it.each(["active", "trial"] as const)("%s 授权自然截止在推理/实际取数期间到达，旧结果回滚且恢复可重试", async (mode) => {
      await prepare(beat, mode); const original = await rawCharter(); const deadline = new Date(Date.now() + 600).toISOString();
      const expiring = { ...original, grant: grant(deadline, mode) }; await writeCharter(expiring); const previous = await before();
      const response = await beat.run(app, () => untilExpired(deadline)); expectNoSuccess(response);
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals }); expect(await rawCharter()).toEqual(expiring);
      await writeCharter({ ...original, version: original.version + 1 }); const retry = await before(); await beat.run(app);
      await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    }, 10000);
    it.each([["active", "facts"], ["trial", "facts"], ["active", "audit"], ["trial", "audit"]] as const)("%s 授权在真实 %s 锁等待期间截止，整拍回滚后重试", async (mode, point) => {
        await prepare(beat, mode); const original = await rawCharter(); const deadline = new Date(Date.now() + 1200).toISOString();
        const expiring = { ...original, grant: grant(deadline, mode) }; await writeCharter(expiring); const previous = await before();
        const blocker = await owner.connect(); await blocker.query("BEGIN");
        if (point === "facts") await blocker.query(`LOCK TABLE ${beat.name.startsWith("queue") ? "approvals" : "biz_events"} IN ACCESS EXCLUSIVE MODE`);
        else await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-chain:${scopeA.tenantId}:${scopeA.workspaceId}`]);
        let released = false; const settled = beat.run(app).then((response) => ({ response }), (error: unknown) => ({ error }));
        try {
          await waitUntil(async () => (await owner.query(
            point === "facts"
              ? "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT %' AND (query LIKE '%FROM biz_events%' OR query LIKE '%FROM approvals%')"
              : "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtext%'",
          )).rowCount !== 0, `actual ${point} lock wait`);
          evidence("deadline-real-lock-wait", { beat: beat.name, mode, point, deadline });
          await untilExpired(deadline); await blocker.query("COMMIT"); released = true;
          const outcome = await settled; if ("error" in outcome) throw outcome.error;
          expectNoSuccess(outcome.response); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
          expect(await rawCharter()).toEqual(expiring);
        } finally { if (!released) await blocker.query("ROLLBACK"); blocker.release(); await settled; }
        await writeCharter({ ...original, version: original.version + 1 }); const retry = await before(); await beat.run(app);
        await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    }, 15000);
    it("撤权先持真实章程行锁，取数后正式拍等待并读取新章程", async () => {
      await prepare(beat); const original = await rawCharter(); const previous = await before(); const writer = await owner.connect(); let ended = false;
      const settled = beat.run(app, async () => { await writer.query("BEGIN"); await writeCharter({ ...original, mode: "disabled" }, writer); })
        .then((response) => ({ response }), (error: unknown) => ({ error }));
      try {
        await waitUntil(async () => (await owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT archive%'" )).rowCount !== 0, "actual profile lock wait after facts");
        await writer.query("COMMIT"); ended = true; const outcome = await settled; if ("error" in outcome) throw outcome.error;
        expectNoSuccess(outcome.response); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      } finally { if (!ended) await writer.query("ROLLBACK"); writer.release(); await settled; }
      await writeCharter({ ...original, version: original.version + 1 }); const retry = await before(); await beat.run(app);
      await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    }, 10000);
    it.each(["other-tenant", "other-workspace"] as const)("%s 撤权只影响自身作用域", async (otherScope) => {
      await prepare(beat); const original = await rawCharter(); const previous = await before(); const target = otherScope === "other-tenant" ? scopeB : scopeC;
      await beat.run(app, () => writeCharter({ ...original, mode: "disabled" }, owner, target));
      await effects(previous, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
      expect((await owner.query("SELECT archive->'charter'->>'mode' AS mode FROM profiles WHERE workspace_id=$1", [target.workspaceId])).rows[0]!.mode).toBe("disabled");
    });
    it("作用域 tenant/workspace 不匹配时无业务审计写入", async () => {
      await prepare(beat); const previous = await before();
      expectNoSuccess(await beat.run(app, undefined, { tenantId: scopeB.tenantId, workspaceId: scopeA.workspaceId }));
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      const retry = await before(); await beat.run(app);
      await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    });
    it("不变的影子授权各拍独立 dry_run，不写业务；breaker 保持执行态守卫", async () => {
      await prepare(beat, "shadow"); const previous = await before(); await beat.run(app); await beat.run(app);
      await effects(previous, { writes: 0, audits: beat.name === "outcome" ? beat.shadowAudits : beat.shadowAudits * 2, dryRun: true, actions: beat.actions, approvals: previous.approvals });
    });
    it.each(["audit", "commit"])("%s SQL 故障时整个事务回滚并可恢复重试", async (point) => {
      await prepare(beat); const previous = await before(); const name = `${prefix}_failure`;
      await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${scopeA.workspaceId}' THEN RAISE EXCEPTION 'test-only MC021 ${point} failure'; END IF; RETURN NEW; END $$`);
      await owner.query(point === "commit" ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON biz_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()` : `CREATE TRIGGER ${name} BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      try { await expect(beat.run(app)).rejects.toThrow(`test-only MC021 ${point} failure`); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals }); }
      finally { await owner.query(`DROP TRIGGER ${name} ON biz_events`); await owner.query(`DROP FUNCTION ${name}()`); }
      const retry = await before(); await beat.run(app); await effects(retry, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions });
    });
    it("事务已获得章程锁后撤权 UPDATE 实际等待，合法拍先提交后撤权生效", async () => {
      await prepare(beat); const previous = await before(); const original = await rawCharter(); const name = `${prefix}_lockgate`;
      const blocker = await owner.connect(); const writer = await owner.connect(); let released = false; let writerEnded = false;
      await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF NEW.workspace_id='${scopeA.workspaceId}' AND NEW.payload->'decision'->>'action'='${beat.actions[0]}' THEN PERFORM pg_advisory_xact_lock(hashtext('${name}')); END IF; RETURN NEW; END $$`);
      await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
      const settled = beat.run(app).then((response) => ({ response }), (error: unknown) => ({ error }));
      let withdrawal: Promise<void> | undefined;
      try {
        await waitUntil(async () => (await owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM append_event_insert%'" )).rowCount !== 0, "actual beat blocked during gateway audit");
        await writer.query("BEGIN"); const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        withdrawal = writeCharter({ ...original, mode: "suspended" }, writer);
        await waitUntil(async () => (await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE profiles%'", [pid])).rowCount !== 0, "actual concurrent charter UPDATE waits for beat lock");
        evidence("real-writer-blocked", { beat: beat.name, writerPid: pid });
        await blocker.query("COMMIT"); released = true; const outcome = await settled; if ("error" in outcome) throw outcome.error;
        await withdrawal; await writer.query("COMMIT"); writerEnded = true;
        await effects(previous, { writes: beat.writes, audits: beat.actions.length, actions: beat.actions }); expect((await rawCharter()).mode).toBe("suspended");
      } finally {
        if (!released) await blocker.query("ROLLBACK"); blocker.release();
        await settled; await withdrawal;
        if (!writerEnded) await writer.query("ROLLBACK"); writer.release();
        await owner.query(`DROP TRIGGER ${name} ON biz_events`); await owner.query(`DROP FUNCTION ${name}()`);
      }
    }, 15000);
  });

  describe.each(["approve", "escalate"] as const)("queue %s 授权边界补充", (verdict) => {
    it.each(["version", "range", "escalate", "regrant", "removed", "invalid"])("%s 变化使旧模型失效", async (change) => {
      await reset(); const original = await rawCharter(); const previous = await before();
      const next = structuredClone(original);
      if (change === "version") next.version++;
      if (change === "range") next.autonomy.ranges.unit = { label: "变更比例", lower: 0.99, upper: 1.01, anchor: 1 };
      if (change === "escalate") next.escalate.push("record.update");
      if (change === "regrant") next.grant = grant(new Date(Date.now() + 86400e3).toISOString());
      const response = await runQueueBeat(app, scopeA, { llmCall: async () => {
        if (change === "removed") await owner.query("UPDATE profiles SET archive=archive-'charter' WHERE workspace_id=$1", [scopeA.workspaceId]);
        else await writeCharter(change === "invalid" ? { mode: "unknown" } : next);
        return model(verdict)();
      } });
      expectNoSuccess(response); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
    });
    it.each(["active", "trial"] as const)("%s 授权在审批行锁等待期间自然截止", async (mode) => {
      await reset(mode); const original = await rawCharter(); const deadline = new Date(Date.now() + 1200).toISOString();
      await writeCharter({ ...original, grant: grant(deadline, mode) }); const previous = await before(); const blocker = await owner.connect();
      await blocker.query("BEGIN"); await blocker.query("SELECT approval_id FROM approvals WHERE approval_id=$1 FOR UPDATE", [`${prefix}_approval`]);
      let released = false; const settled = runQueueBeat(app, scopeA, { llmCall: model(verdict) }).then((response) => ({ response }), (error: unknown) => ({ error }));
      try {
        await waitUntil(async () => (await owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'UPDATE approvals%'")).rowCount !== 0, "actual approval lock wait before deadline");
        await untilExpired(deadline); await blocker.query("COMMIT"); released = true; const outcome = await settled; if ("error" in outcome) throw outcome.error;
        expectNoSuccess(outcome.response); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      } finally { if (!released) await blocker.query("ROLLBACK"); blocker.release(); await settled; }
    }, 10000);
    it("撤权先持行锁，正式拍真实等待后读到新章程而失效", async () => {
      await reset(); const original = await rawCharter(); const previous = await before(); const writer = await owner.connect(); let ended = false;
      const settled = runQueueBeat(app, scopeA, { llmCall: async () => { await writer.query("BEGIN"); await writeCharter({ ...original, mode: "disabled" }, writer); return model(verdict)(); } }).then((response) => ({ response }), (error: unknown) => ({ error }));
      try {
        await waitUntil(async () => (await owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='workloom_app' AND wait_event_type='Lock' AND query LIKE 'SELECT archive%'" )).rowCount !== 0, "actual profile lock wait");
        await writer.query("COMMIT"); ended = true; const outcome = await settled; if ("error" in outcome) throw outcome.error;
        expectNoSuccess(outcome.response); await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      } finally { if (!ended) await writer.query("ROLLBACK"); writer.release(); await settled; }
    }, 10000);
  });

  describe.each(["approve", "escalate"] as const)("MC021 candidate: %s while authorization is withdrawn", (verdict) => {
    it.each(["suspended", "disabled"] as const)("new %s charter forbids the old model result from committing", async (mode) => {
      await reset(); const previous = await before(); let calls = 0;
      const response = await runQueueBeat(app, scopeA, { llmCall: async () => {
        calls++;
        const current = (await owner.query<{ archive: Record<string, unknown> }>(
          "SELECT archive FROM profiles WHERE workspace_id=$1", [scopeA.workspaceId],
        )).rows[0]!.archive;
        const charter = { ...(current.charter as Record<string, unknown>), mode, updated_at: new Date().toISOString() };
        await owner.query("UPDATE profiles SET archive=jsonb_set(archive,'{charter}',$2::jsonb) WHERE workspace_id=$1",
          [scopeA.workspaceId, JSON.stringify(charter)]);
        evidence("MC021-withdrawal-committed-before-model-response", { mode, verdict, charter });
        return model(verdict)();
      } });
      evidence("MC021-withdrawn-response", response); expect(calls).toBe(1);
      await effects(previous, { writes: 0, audits: 0, approvals: previous.approvals });
      expect(response).toMatchObject({ decided: 0, escalated: 0 });
      expect((await owner.query("SELECT archive->'charter'->>'mode' AS mode FROM profiles WHERE workspace_id=$1", [scopeA.workspaceId])).rows[0]?.mode).toBe(mode);
    });
  });


  it.each(["disabled", "suspended", "regranted"] as const)("到期预处理与新 %s 竞争时不覆盖已提交的新章程", async (change) => {
    await reset(); const active = await rawCharter(); const expired = { ...active, grant: grant(new Date(0).toISOString()) };
    await writeCharter(expired); const previous = await before();
    const updated = { ...active, version: active.version + 1, mode: change === "regranted" ? "active" : change,
      grant: grant(new Date(Date.now() + 86400e3).toISOString()) };
    const response = await runBriefingBeat(betweenReadAndWrite(app, () => writeCharter(updated)), scopeA, "daily");
    expect(await rawCharter()).toEqual(updated);
    if (change === "disabled") expectNoSuccess(response); else expect(response.eventId).not.toBe("");
    await effects(previous, { writes: 0, audits: change === "disabled" ? 0 : 1, actions: ["ceo.briefing"], approvals: previous.approvals });
  });

  it("全部实际审计保持原事件、哈希链、作用域与 append-only", async () => {
    const tails = new Map<string, string>();
    for (const row of await auditRows()) { const key = `${row.tenant_id}:${row.workspace_id}`; expect(row.prev_hash).toBe(tails.get(key) ?? "GENESIS"); expect(row.hash).toBe(eventHash(row.prev_hash, row.payload)); tails.set(key, row.hash); }
    expect(tails.size).toBeGreaterThan(0);
  });
});
