/**
 * MC-013/113：真实组合根 HTTP 的派单幂等、改派、授权和错误语义回归。
 * Native Node 子进程加载实际 index/appRouter/context/gateway；不替换路由或授权。
 * 只在 runner 提供自有 Unix socket、随机 nonce 和原始迁移夹具时连接数据库。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closeAllPools, getAppPool, getGatewayPool } from "@workloom/db";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";
import { eventHash } from "@workloom/base/workdata";

const enabled = process.env.RUN_TICKET_ASSIGNMENT_DB_TESTS === "1";
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const nonce = process.env.TICKET_ASSIGNMENT_NONCE ?? "disabled";
const prefix = `it-assign-${nonce.slice(0, 12)}`;
const scopeA = { tenantId: `${prefix}-tenant-a`, workspaceId: `${prefix}-ws-a` };
const scopeB = { tenantId: `${prefix}-tenant-b`, workspaceId: `${prefix}-ws-b` };
const scopeSibling = { tenantId: scopeA.tenantId, workspaceId: `${prefix}-ws-sibling` };
const identity = (scope: typeof scopeA, suffix: string, memberNo: string): Identity => ({
  kind: "member", memberId: `${prefix}-member-${suffix}`, memberNo,
  name: `合成派单管理员${suffix}`, role: "owner", plan: "pro", ...scope,
});
const ownerA = identity(scopeA, "a", "MEM-971");
const ownerB = identity(scopeB, "b", "MEM-972");
const ownerSibling = identity(scopeSibling, "sibling", "MEM-973");
type Status = "created" | "assigned" | "processing" | "done" | "closed";
interface Reply {
  status: number;
  data: { ticket?: Record<string, unknown>; [key: string]: unknown } | null;
  error: { message: string; data: { code: string; httpStatus: number; stack?: string; ref?: string } } | null;
}
interface State {
  ticket: Record<string, unknown> | null;
  local: Array<{ id: string; action: string; actor_type: string; actor_id: string; detail: Record<string, unknown> }>;
  business: Array<{ event_id: string; payload: { who: { id: string; type: string }; object: { type: string; id: string }; decision: { action: string; after: Record<string, unknown> } }; prev_hash: string; hash: string }>;
  approvals: number;
  notifications: number;
}
interface Case {
  id: string; preconditions: string[]; steps: string[]; expected: string[];
  actual: unknown; evidence_grade: "B";
}

describe.skipIf(!enabled)("MC-013/113 真 HTTP PostgreSQL：派单与服务错误契约", () => {
  let owner: pg.Pool | undefined;
  let server: ChildProcess | undefined;
  let serverOutput = "";
  let base = "";
  let tokenA = "";
  let tokenB = "";
  let tokenSibling = "";
  let nextFixture = 0;
  const cases: Case[] = [];

  function record(id: string, preconditions: string[], steps: string[], expected: string[], actual: unknown): void {
    const item: Case = { id, preconditions, steps, expected, actual, evidence_grade: "B" };
    cases.push(item);
    console.log(JSON.stringify(item));
  }

  async function request(path: string, input: unknown, token: string | null = tokenA): Promise<Reply> {
    const response = await fetch(`${base}/trpc/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input), signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json() as { result?: { data?: Reply["data"] }; error?: Reply["error"] };
    return { status: response.status, data: body.result?.data ?? null, error: body.error ?? null };
  }

  const assign = (input: unknown, token: string | null = tokenA) => request("service.tickets.assign", input, token);

  async function cRequest(path: string, token?: string, body?: unknown) {
    const response = await fetch(`${base}/c${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.173", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async function cSession(label: string, scope = scopeA): Promise<{ token: string; userId: string }> {
    const result = await cRequest("/session", undefined, { channel: "h5", openid: `${prefix}-c-${label}`, workspaceKey: scope.workspaceId });
    expect(result.status).toBe(200);
    const value = result.body as { token: string; user: { id: string } };
    return { token: value.token, userId: value.user.id };
  }

  async function fixture(label: string, status: Status = "assigned", scope = scopeA, options: { dept?: string | null; assignee?: string | null } = {}): Promise<string> {
    const id = `${prefix}-ticket-${++nextFixture}-${label}`;
    await owner!.query(
      `INSERT INTO c_tickets (id,workspace_id,c_user_id,conversation_id,kind,title,payload,status,priority,dept,assignee,sla_due_at,result,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'repair',$5,$6,$7,'high',$8,$9,'2031-01-02T03:04:05Z',$10,$11,'2026-01-02T03:04:05.123456Z','2026-01-03T04:05:06.654321Z')`,
      [id, scope.workspaceId, `${scope.workspaceId}-c-user`, `${prefix}-conversation`, `${prefix} ${label}`,
        JSON.stringify({ nested: { values: [1, "甲", "😀"], empty: {} }, details: "合成私密补充信息" }), status,
        options.dept === undefined ? "原部门" : options.dept, options.assignee === undefined ? "原受理人" : options.assignee,
        JSON.stringify({ text: "原结果字段保留" }), `${id}-key`],
    );
    return id;
  }

  async function state(ticketId: string, scope = scopeA): Promise<State> {
    const [ticket, local, business, effects] = await Promise.all([
      owner!.query<{ ticket: Record<string, unknown> }>("SELECT to_jsonb(t) AS ticket FROM c_tickets t WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, ticketId]),
      owner!.query<State["local"][number]>("SELECT id::text,action,actor_type,actor_id,detail FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY id", [scope.workspaceId, ticketId]),
      owner!.query<State["business"][number]>("SELECT event_id,payload,prev_hash,hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'object'->>'id'=$3 ORDER BY seq", [scope.tenantId, scope.workspaceId, ticketId]),
      owner!.query<{ approvals: number; notifications: number }>(
        `SELECT (SELECT count(*)::int FROM approvals a JOIN biz_events e ON e.event_id=a.event_id AND e.tenant_id=a.tenant_id
                 WHERE a.workspace_id=$1 AND e.workspace_id=$1 AND e.payload->'object'->>'id'=$2) AS approvals,
                (SELECT count(*)::int FROM c_notifications WHERE workspace_id=$1 AND payload->>'ticketId'=$2) AS notifications`,
        [scope.workspaceId, ticketId]),
    ]);
    return { ticket: ticket.rows[0]?.ticket ?? null, local: local.rows, business: business.rows, ...effects.rows[0]! };
  }

  function unchangedFields(before: State, after: State): void {
    const dropMutable = (value: State) => Object.fromEntries(Object.entries(value.ticket!).filter(([key]) => !["status", "dept", "assignee", "updated_at"].includes(key)));
    expect(dropMutable(after)).toEqual(dropMutable(before));
    expect(after.approvals).toBe(before.approvals);
    expect(after.notifications).toBe(before.notifications);
  }

  function assignedEffects(after: State, dept: string | null, assignee: string | null, count = 1, reassigned = true): void {
    expect(after.ticket).toMatchObject({ status: "assigned", dept, assignee });
    expect(after.local).toHaveLength(count);
    expect(after.local.at(-1)).toMatchObject({ action: "assign", actor_type: "system", actor_id: "service-desk", detail: { dept, assignee, ...(reassigned ? { reassigned: true, from_status: "assigned" } : {}) } });
    expect(after.business).toHaveLength(count);
    expect(after.business.at(-1)?.payload).toMatchObject({ who: { type: "human", id: ownerA.memberNo }, object: { type: "ticket", id: after.ticket!.id }, decision: { action: "service.ticket.assign", after: { dept, assignee } } });
    for (const event of after.business) expect(event.hash).toBe(eventHash(event.prev_hash, event.payload));
  }

  function semantic(reply: Reply, status: number, code: string): void {
    expect(reply.status).toBe(status);
    expect(reply.data).toBeNull();
    expect(reply.error?.data).toMatchObject({ code, httpStatus: status });
  }

  function safeFailure(reply: Reply, status = 500, code = "INTERNAL_SERVER_ERROR", rawMessage?: string): void {
    semantic(reply, status, code);
    expect(reply.error?.message).toMatch(/^服务内部错误（已记录，ref=[a-f0-9]{8}）$/);
    expect(reply.error?.data.ref).toMatch(/^[a-f0-9]{8}$/);
    expect(reply.error?.data.stack).toBeUndefined();
    if (rawMessage) {
      expect(JSON.stringify(reply)).not.toContain(rawMessage);
      const expectedRef = createHash("sha256").update(`service.tickets.assign|${code}|${rawMessage}`).digest("hex").slice(0, 8);
      expect(reply.error?.data.ref).toBe(expectedRef);
    }
  }

  beforeAll(async () => {
    const socket = process.env.TICKET_ASSIGNMENT_SOCKET;
    const port = process.env.TICKET_ASSIGNMENT_PORT;
    if (!socket?.startsWith("/tmp/wl-assign-pg-") || !/^\d+$/.test(port ?? "") || nonce === "disabled") throw new Error("Refusing assignment regression without owned Unix fixture");
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"] as const) {
      const parsed = new URL(process.env[key] ?? "");
      if (parsed.pathname !== "/ticket_assignment" || parsed.searchParams.get("host") !== socket || parsed.searchParams.get("port") !== port) throw new Error(`Non-fixture ${key}`);
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const sentinel = await owner.query<{ nonce: string; listener: string }>("SELECT nonce,current_setting('listen_addresses') AS listener FROM ticket_assignment_fixture_owner");
    if (sentinel.rows.length !== 1 || sentinel.rows[0]!.nonce !== nonce || sentinel.rows[0]!.listener !== "") throw new Error("Fixture nonce/TCP ownership mismatch");
    for (const [index, scope] of [scopeA, scopeB, scopeSibling].entries()) {
      if (index !== 2) await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro')", [scope.tenantId, `合成派单租户${index}`]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry,is_example) VALUES ($1,$2,$3,$1,'general',true)", [scope.workspaceId, scope.tenantId, `合成派单工作区${index}`]);
      const member = [ownerA, ownerB, ownerSibling][index]!;
      await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role,status,permissions) VALUES ($1,$2,$3,$4,'owner','active','{}')", [member.memberId, member.workspaceId, member.memberNo, member.name]);
      await owner.query("INSERT INTO c_users (id,workspace_id,channel,openid) VALUES ($1,$2,'h5',$1)", [`${scope.workspaceId}-c-user`, scope.workspaceId]);
    }
    tokenA = await signDemoToken(ownerA);
    tokenB = await signDemoToken(ownerB);
    tokenSibling = await signDemoToken(ownerSibling);
    await owner.query(`
      CREATE TABLE ticket_assignment_faults (stage text PRIMARY KEY, ticket_id text, title text);
      CREATE FUNCTION ticket_assignment_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fixture$
      DECLARE target_ticket text; target_title text; actual_ticket text; actual_title text;
      BEGIN
        SELECT ticket_id,title INTO target_ticket,target_title FROM public.ticket_assignment_faults WHERE stage=TG_ARGV[0];
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME='c_tickets' THEN actual_ticket=NEW.id; actual_title=NEW.title;
        ELSIF TG_TABLE_NAME='c_ticket_events' THEN actual_ticket=NEW.ticket_id;
        ELSIF TG_TABLE_NAME='biz_events' THEN actual_ticket=NEW.payload->'object'->>'id'; END IF;
        IF actual_title IS NULL THEN SELECT title INTO actual_title FROM public.c_tickets WHERE id=actual_ticket; END IF;
        IF actual_ticket=target_ticket OR actual_title=target_title THEN RAISE EXCEPTION 'ticket_assignment injected failure at %',TG_ARGV[0]; END IF;
        RETURN NEW;
      END;
      $fixture$;
      CREATE TRIGGER ticket_assignment_update BEFORE UPDATE ON c_tickets FOR EACH ROW EXECUTE FUNCTION ticket_assignment_fault('update');
      CREATE TRIGGER ticket_assignment_local BEFORE INSERT ON c_ticket_events FOR EACH ROW EXECUTE FUNCTION ticket_assignment_fault('local');
      CREATE TRIGGER ticket_assignment_business BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION ticket_assignment_fault('business');
      CREATE CONSTRAINT TRIGGER ticket_assignment_commit AFTER UPDATE ON c_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ticket_assignment_fault('commit');
    `);
    const instanceId = `assignment-${nonce}`;
    base = `http://127.0.0.1:${process.env.TICKET_ASSIGNMENT_HTTP_PORT}`;
    // 仅测试进程：在实际应用池的指定 fixture SELECT 上注入错误；其余 SQL 与鉴权原样执行。
    // 不修改被测文件，不重新构建 router，不替换任何业务/授权模块。
    const prelude = `
      import { pathToFileURL } from 'node:url';
      const db = await import('@workloom/db');
      const { ServiceHttpError } = await import(pathToFileURL(process.cwd() + '/apps/server/src/service/ticket.ts').href);
      const { TRPCError } = await import(pathToFileURL(process.cwd() + '/apps/server/node_modules/@trpc/server/dist/index.mjs').href);
      const pool = db.getAppPool();
      const nativeConnect = pool.connect.bind(pool);
      const patched = new WeakSet();
      pool.connect = async function (...args) {
        const client = await nativeConnect(...args);
        if (!patched.has(client)) {
          patched.add(client);
          const nativeQuery = client.query.bind(client);
          client.query = function (...queryArgs) {
            const sql = queryArgs[0];
            const id = queryArgs[1]?.[1];
            if (typeof sql === 'string' && /^SELECT \\* FROM c_tickets[\\s\\S]*FOR UPDATE$/.test(sql.trim()) && typeof id === 'string' && id.startsWith(${JSON.stringify(`${prefix}-semantic-`)})) {
              const kind = id.slice(${JSON.stringify(`${prefix}-semantic-`)}.length);
              if (/^\\d+$/.test(kind)) throw new ServiceHttpError('合成服务语义-' + kind, Number(kind));
              if (kind === 'precondition') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '合成前置条件未满足', cause: new Error('fixture-original-precondition-cause') });
              throw new Error('fixture-private-table constraint marker');
            }
            return nativeQuery(...queryArgs);
          };
        }
        return client;
      };
      await import(pathToFileURL(process.cwd() + '/apps/server/src/index.ts').href);
    `;
    server = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", prelude], {
      cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, NODE_ENV: "test", SERVER_HOST: "127.0.0.1", SERVER_PORT: process.env.TICKET_ASSIGNMENT_HTTP_PORT,
        SERVER_INSTANCE_ID: instanceId, SERVICE_C_DEMO_AUTH: "true", SERVICE_C_WORKSPACE_ID: "",
        SERVICE_C_WORKSPACE_MAP: JSON.stringify(Object.fromEntries([scopeA, scopeB, scopeSibling].map((scope) => [scope.workspaceId, scope.workspaceId]))),
      },
    });
    server.stdout?.on("data", (value: Buffer) => { serverOutput += value.toString(); });
    server.stderr?.on("data", (value: Buffer) => { serverOutput += value.toString(); });
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Native fixture server exited: ${serverOutput.slice(-1500)}`);
      let response: Response | undefined;
      try { response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); }
      catch (error) { if (Date.now() >= deadline) throw error; }
      if (response?.ok) {
        const health = await response.json() as { instanceId?: string };
        if (health.instanceId !== instanceId) throw new Error("HTTP fixture port belongs to another instance");
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Native fixture server did not become ready: ${serverOutput.slice(-1500)}`);
  }, 60_000);

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise<void>((resolve) => server!.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
      }
    }
    if (process.env.TICKET_ASSIGNMENT_SERVER_LOG) writeFileSync(process.env.TICKET_ASSIGNMENT_SERVER_LOG, serverOutput);
    if (process.env.TICKET_ASSIGNMENT_RESULTS) writeFileSync(process.env.TICKET_ASSIGNMENT_RESULTS, JSON.stringify({
      schema: "workloom.ticket-assignment-pg@1", cases, actual_http: true, actual_index: true,
      actual_router: true, actual_member_authority: true, actual_c_gateway: true,
      database_fixture: { unix_socket: true, nonce_verified: true, original_migrations: true },
      native_child_stopped: !server || server.exitCode !== null || server.signalCode !== null,
      synthetic_scopes: [scopeA, scopeB, scopeSibling],
    }, null, 2) + "\n");
    try { await closeAllPools(); }
    finally { if (owner) await owner.end(); }
  });

  it("真实 app/gateway 非超级角色，无 GUC 时看不到工单且不能旁路写事件", async () => {
    const ticketId = await fixture("rls");
    const roles = [];
    for (const [pool, name] of [[getAppPool(), "workloom_app"], [getGatewayPool(), "workloom_gateway"]] as const) {
      const flags = await pool.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      const hidden = await pool.query("SELECT id FROM c_tickets");
      roles.push({ flags: flags.rows, hidden: hidden.rows });
      expect(flags.rows[0]).toEqual({ current_user: name, rolsuper: false, rolbypassrls: false });
      expect(hidden.rows).toEqual([]);
    }
    let bypass: { code?: string } | null = null;
    try { await getAppPool().query("INSERT INTO biz_events (event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-99999999','x','x','{}','GENESIS','x')"); }
    catch (error) { bypass = error as { code?: string }; }
    record("roles-rls", ["original migrations", "synthetic ticket exists"], ["inspect actual application roles", "read without GUC", "attempt direct app INSERT"], ["NOSUPERUSER/NOBYPASSRLS", "empty rows", "42501 permission denied"], { roles, bypassCode: bypass?.code, ticketId });
    expect(bypass?.code).toBe("42501");
  });

  it("created 单首次派单同时写本地事件和人工五元事件，保留其余字段", async () => {
    const ticketId = await fixture("first", "created", scopeA, { dept: null, assignee: null });
    const before = await state(ticketId);
    const response = await assign({ ticketId, dept: "派单部门", assignee: "MEM-974" });
    const after = await state(ticketId);
    record("created-assign", ["created fixture with immutable payload/SLA/result"], ["real HTTP assign", "read ticket and both event stores"], ["200 assigned", "one local/one business event", "unrelated fields identical"], { response, before, after });
    expect(response.status).toBe(200);
    assignedEffects(after, "派单部门", "MEM-974", 1, false);
    unchangedFields(before, after);
  });

  it.each(["exact", "omitted", "dept-only-same", "assignee-only-same"] as const)("assigned 同值重复派单 %s 原样返回，时间戳与两层事件不变", async (variant) => {
    const ticketId = await fixture(`no-op-${variant}`);
    const before = await state(ticketId);
    const input = { ticketId, ...(variant === "exact" || variant === "dept-only-same" ? { dept: "原部门" } : {}), ...(variant === "exact" || variant === "assignee-only-same" ? { assignee: "原受理人" } : {}) };
    const response = await assign(input);
    const after = await state(ticketId);
    record(`assigned-no-op-${variant}`, ["assigned original department/assignee"], ["HTTP same-value or omitted-field assignment"], ["200 original ticket", "microsecond updated_at unchanged", "no local or business writes"], { response, before, after });
    expect(response.status).toBe(200);
    expect(response.data?.ticket).toMatchObject({ id: ticketId, status: "assigned", dept: "原部门", assignee: "原受理人" });
    expect(after).toEqual(before);
  });

  it.each(["both", "dept-only", "assignee-only", "special-empty"] as const)("assigned 原地改派 %s 仅改派单字段，逐条写 reassigned 事件", async (variant) => {
    const ticketId = await fixture(`reassign-${variant}`);
    const before = await state(ticketId);
    const input = variant === "both" ? { ticketId, dept: "新部门", assignee: "新受理人" }
      : variant === "dept-only" ? { ticketId, dept: "新部门" }
        : variant === "assignee-only" ? { ticketId, assignee: "新受理人" }
          : { ticketId, dept: "引号\" 换行\n 反斜线\\ 😀", assignee: "" };
    const response = await assign(input);
    const after = await state(ticketId);
    record(`assigned-reassign-${variant}`, ["assigned populated fixture"], ["HTTP changed assignment", "read both event stores and all ticket fields"], ["200 assigned", "one reassigned local event", "one attributed business event", "omitted fields preserve existing value"], { response, before, after });
    expect(response.status).toBe(200);
    assignedEffects(after, input.dept ?? "原部门", input.assignee ?? "原受理人");
    unchangedFields(before, after);
    expect(after.ticket!.updated_at).not.toBe(before.ticket!.updated_at);
    const repeated = await assign(input);
    expect(repeated.status).toBe(200);
    expect(await state(ticketId)).toEqual(after);
  });

  it("created 单省略部门时走基座路由，随后相同默认分派幂等", async () => {
    const ticketId = await fixture("default", "created", scopeA, { dept: null, assignee: null });
    const response = await assign({ ticketId });
    const first = await state(ticketId);
    const repeated = await assign({ ticketId });
    const after = await state(ticketId);
    record("default-route", ["created repair fixture with null assignment"], ["assign with omitted fields twice"], ["base support-team default", "one pair of events", "second request has no effects"], { response, repeated, first, after });
    expect(response.status).toBe(200);
    assignedEffects(first, "服务支持团队", null, 1, false);
    expect(repeated.status).toBe(200);
    expect(after).toEqual(first);
  });

  it.each(["created", "assigned"] as const)("12 路并发同值派单 %s 只提交一组事件，后续重试时间戳不漂移", async (status) => {
    const ticketId = await fixture(`parallel-same-${status}`, status);
    const responses = await Promise.all(Array.from({ length: 12 }, () => assign({ ticketId, dept: "并发部门", assignee: "并发受理人" })));
    const after = await state(ticketId);
    record(`parallel-same-${status}`, [`${status} fixture`], ["12 concurrent real HTTP same-value assignments"], ["all 200", "one local/one business event", "all receipts have same timestamp"], { responses, after });
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect(new Set(responses.map((response) => response.data?.ticket?.updatedAt)).size).toBe(1);
    assignedEffects(after, "并发部门", "并发受理人", 1, status === "assigned");
    expect((await assign({ ticketId, dept: "并发部门", assignee: "并发受理人" })).status).toBe(200);
    expect(await state(ticketId)).toEqual(after);
  });

  it("12 路不同改派串行提交且字段成对，无丢失事件、撕裂字段或哈希断链", async () => {
    const ticketId = await fixture("parallel-different");
    const changes = Array.from({ length: 12 }, (_, index) => ({ ticketId, dept: `并发部门${index}`, assignee: `并发受理人${index}` }));
    const responses = await Promise.all(changes.map((input) => assign(input)));
    const after = await state(ticketId);
    record("parallel-different", ["assigned fixture"], ["12 concurrent distinct assignments"], ["all 200", "12 local and 12 business events", "each pair exactly represented", "final department/assignee match one submitted pair", "event hashes valid"], { responses, after });
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(after.local).toHaveLength(12);
    expect(after.business).toHaveLength(12);
    const expected = changes.map((input) => `${input.dept}|${input.assignee}`).sort();
    expect(after.local.map((event) => `${event.detail.dept}|${event.detail.assignee}`).sort()).toEqual(expected);
    expect(after.business.map((event) => `${event.payload.decision.after.dept}|${event.payload.decision.after.assignee}`).sort()).toEqual(expected);
    expect(expected).toContain(`${after.ticket!.dept}|${after.ticket!.assignee}`);
    for (const event of after.business) expect(event.hash).toBe(eventHash(event.prev_hash, event.payload));
  });

  it.each(["processing", "done", "closed"] as const)("%s 工单拒绝再派 HTTP409，原因文案可读且全库业务状态不变", async (status) => {
    const ticketId = await fixture(`terminal-${status}`, status);
    const before = await state(ticketId);
    const response = await assign({ ticketId, dept: "不应生效" });
    const after = await state(ticketId);
    record(`terminal-${status}`, [`${status} fixture`], ["real HTTP reassign"], ["409 CONFLICT", "illegal-transition explanation", "no mutation"], { response, before, after });
    semantic(response, 409, "CONFLICT");
    expect(response.error?.message).toContain("非法迁移");
    expect(after).toEqual(before);
  });

  it.each(["missing", "empty"] as const)("%s id 返回真实 HTTP404，没有成功回执或业务事件", async (variant) => {
    const ticketId = variant === "empty" ? "" : `${prefix}-not-found`;
    const before = await state(ticketId);
    const response = await assign({ ticketId });
    const after = await state(ticketId);
    record(`not-found-${variant}`, ["no ticket exists"], ["real HTTP assign"], ["404 NOT_FOUND", "no effects"], { response, before, after });
    semantic(response, 404, "NOT_FOUND");
    expect(after).toEqual(before);
  });

  it.each(["other-tenant", "same-tenant-other-workspace"] as const)("跨 scope %s 不能通过额外 input 字段改派他人工作区工单", async (variant) => {
    const scope = variant === "other-tenant" ? scopeB : scopeSibling;
    const foreignId = await fixture(`foreign-${variant}`, "assigned", scope);
    const before = await state(foreignId, scope);
    const response = await assign({ ticketId: foreignId, dept: "不应生效", workspaceId: scope.workspaceId, tenantId: scope.tenantId, cUserId: `${scope.workspaceId}-c-user` });
    const reverse = await assign({ ticketId: await fixture(`reverse-${variant}`), dept: "不应生效" }, variant === "other-tenant" ? tokenB : tokenSibling);
    const after = await state(foreignId, scope);
    record(`cross-scope-${variant}`, ["valid owner JWT in distinct authoritative scope"], ["assign foreign id with forged input scope", "reverse direction request"], ["both 404", "foreign ticket and receipts unchanged"], { response, reverse, before, after });
    semantic(response, 404, "NOT_FOUND");
    semantic(reverse, 404, "NOT_FOUND");
    expect(after).toEqual(before);
  });

  it.each(["deny", "readonly", "guest", "inactive"] as const)("实时成员 %s 覆盖旧 owner JWT，禁止派单且没有副作用", async (variant) => {
    const ticketId = await fixture(`authority-${variant}`);
    const before = await state(ticketId);
    await owner!.query("UPDATE members SET permissions=$2,role=$3,member_no=$4,status=$5 WHERE id=$1", [ownerA.memberId,
      JSON.stringify(variant === "deny" ? { deny: ["workspace.write"] } : {}), variant === "readonly" ? "readonly" : "owner", variant === "guest" ? "GUEST" : ownerA.memberNo, variant === "inactive" ? "removed" : "active"]);
    let response: Reply;
    try { response = await assign({ ticketId, dept: "不应生效" }); }
    finally { await owner!.query("UPDATE members SET permissions='{}',role='owner',member_no=$2,status='active' WHERE id=$1", [ownerA.memberId, ownerA.memberNo]); }
    const after = await state(ticketId);
    record(`authority-${variant}`, ["old valid owner token", `live ${variant} member state`], ["HTTP assign with unchanged old JWT", "restore synthetic member"], [variant === "inactive" ? "401 UNAUTHORIZED" : "403 FORBIDDEN", "no ticket/event changes"], { response, before, after });
    semantic(response!, variant === "inactive" ? 401 : 403, variant === "inactive" ? "UNAUTHORIZED" : "FORBIDDEN");
    expect(after).toEqual(before);
  });

  it.each(["none", "invalid", "wrong-workspace", "wrong-tenant", "c-user-token"] as const)("会话 %s HTTP401，不能靠签名或 C 身份越过 B 端授权", async (variant) => {
    const ticketId = await fixture(`session-${variant}`);
    const before = await state(ticketId);
    let token: string | null = null;
    if (variant === "invalid") token = "fake-invalid-token";
    if (variant === "wrong-workspace") token = await signDemoToken({ ...ownerA, workspaceId: scopeB.workspaceId });
    if (variant === "wrong-tenant") token = await signDemoToken({ ...ownerA, tenantId: scopeB.tenantId });
    if (variant === "c-user-token") token = (await cSession("b-authority-boundary")).token;
    const response = await assign({ ticketId, dept: "不应生效" }, token);
    const after = await state(ticketId);
    record(`session-${variant}`, [`${variant} session`], ["real HTTP staff assignment"], ["401 UNAUTHORIZED", "zero effects"], { response, before, after });
    semantic(response, 401, "UNAUTHORIZED");
    expect(after).toEqual(before);
  });

  it.each([
    ["id-number", { ticketId: 12 }], ["dept-array", { ticketId: "fixture", dept: ["部门"] }],
    ["assignee-object", { ticketId: "fixture", assignee: { id: "受理人" } }],
    ["large-invalid", { ticketId: "fixture", dept: ["长".repeat(4096)] }],
  ] as const)("派单参数 %s 保持 Zod HTTP400，输入错误不伪装成内部故障", async (label, input) => {
    const before = await state("fixture");
    const response = await assign(input);
    const after = await state("fixture");
    record(`validation-assign-${label}`, ["valid current owner authority"], ["real HTTP malformed assignment"], ["400 BAD_REQUEST", "no ticket or event writes"], { response, before, after });
    semantic(response, 400, "BAD_REQUEST");
    expect(after).toEqual(before);
  });

  it.each([
    ["empty-title", "", "有效内容"], ["max-title", "题".repeat(201), "有效内容"],
    ["empty-content", "合成标题", ""], ["max-content", "合成标题", "内".repeat(100001)],
  ] as const)("KB 同根映射边界 %s 保持实际 HTTP400，文档/审批/内容事件零写入", async (label, title, contentMd) => {
    const counts = async () => (await owner!.query(
      `SELECT (SELECT count(*)::int FROM kb_documents WHERE workspace_id=$1) AS documents,
              (SELECT count(*)::int FROM approvals WHERE workspace_id=$1) AS approvals,
              (SELECT count(*)::int FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'<>'system.error') AS business`, [scopeA.workspaceId])).rows[0];
    const before = await counts();
    const response = await request("service.kb.upsertDocument", { collectionId: `${prefix}-not-a-collection`, title, contentMd });
    const after = await counts();
    record(`validation-kb-${label}`, ["current valid owner identity", "invalid input before SQL"], ["actual native appRouter HTTP upsertDocument"], ["400 BAD_REQUEST", "documents/approvals/non-error business counts unchanged"], { inputLengths: { title: title.length, content: contentMd.length }, response, before, after });
    semantic(response, 400, "BAD_REQUEST");
    expect(after).toEqual(before);
  });

  it.each([[400, "BAD_REQUEST"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [409, "CONFLICT"], [503, "SERVICE_UNAVAILABLE"]] as const)("ServiceHttpError %i 经实际 HTTP 映射为 %s", async (status, code) => {
    const ticketId = `${prefix}-semantic-${status}`;
    const before = await state(ticketId);
    const response = await assign({ ticketId });
    const after = await state(ticketId);
    record(`semantic-${status}`, ["test-only native application-pool SELECT fault", "all routing/authorization/transactions actual"], ["HTTP assignment raises typed service error"], [`HTTP ${status} ${code}`, "no effects", status >= 500 ? "safe message/stack/ref" : "original contract message"], { response, before, after });
    semantic(response, status, code);
    if (status >= 500) safeFailure(response, status, code, `合成服务语义-${status}`);
    else expect(response.error?.message).toBe(`合成服务语义-${status}`);
    expect(after).toEqual(before);
  });

  it("显式 TRPCError 与非空 cause 保持 PRECONDITION_FAILED/412", async () => {
    const ticketId = `${prefix}-semantic-precondition`;
    const response = await assign({ ticketId });
    record("explicit-trpc-cause", ["actual route downstream throws TRPCError with Error cause"], ["real HTTP assignment"], ["412 PRECONDITION_FAILED", "explicit wrapper/message retained"], { response, after: await state(ticketId) });
    semantic(response, 412, "PRECONDITION_FAILED");
    expect(response.error?.message).toBe("合成前置条件未满足");
  });

  it("未知错误仍 HTTP500，响应不含数据库原文或堆栈，ref 与服务端日志一致", async () => {
    const response = await assign({ ticketId: `${prefix}-semantic-unknown` });
    record("unknown-error", ["native pool fault throws unknown Error"], ["real HTTP assignment", "inspect safe response and server log reference"], ["500 INTERNAL_SERVER_ERROR", "no private text/stack", "same eight-character ref in server log"], { response });
    safeFailure(response, 500, "INTERNAL_SERVER_ERROR", "fixture-private-table constraint marker");
    expect(serverOutput).toContain(`ref=${response.error?.data.ref}`);
    expect(serverOutput).toContain("fixture-private-table constraint marker");
  });

  it.each((["created", "assigned"] as const).flatMap((status) => (["update", "local", "business", "commit"] as const).map((stage) => [status, stage] as const)))("%s 派单 %s SQL/COMMIT 故障回滚全部副作用，原请求重试恰好一次", async (status, stage) => {
    const ticketId = await fixture(`rollback-${status}-${stage}`, status);
    const before = await state(ticketId);
    const input = { ticketId, dept: "故障恢复部门", assignee: "故障恢复受理人" };
    await owner!.query("INSERT INTO ticket_assignment_faults (stage,ticket_id) VALUES ($1,$2)", [stage, ticketId]);
    let failed: Reply;
    try { failed = await assign(input); }
    finally { await owner!.query("DELETE FROM ticket_assignment_faults WHERE stage=$1", [stage]); }
    const rolledBack = await state(ticketId);
    const retry = await assign(input);
    const after = await state(ticketId);
    record(`rollback-${status}-${stage}`, [`${status} ticket`, `${stage} actual SQL trigger failure`], ["HTTP assign", "read after rollback", "remove fault and replay identical input"], ["safe HTTP500", "all ticket fields and both event stores rolled back", "retry 200 one event pair"], { failed, before, rolledBack, retry, after });
    safeFailure(failed!);
    expect(rolledBack).toEqual(before);
    expect(retry.status).toBe(200);
    assignedEffects(after, input.dept, input.assignee, 1, status === "assigned");
    unchangedFields(before, after);
    expect((await assign(input)).status).toBe(200);
    expect(await state(ticketId)).toEqual(after);
  });

  it("C 建单自动派单、B 改派后安全重放、跨用户/异内容冲突保持 MC-011", async () => {
    const customerA = await cSession("create-owner");
    const customerOther = await cSession("create-other");
    const input = { kind: "repair", title: `${prefix} C 端私密工单`, payload: { details: { a: 1, b: ["甲", "乙"] } }, idempotencyKey: `${prefix}-create-replay` };
    const first = await cRequest("/tickets", customerA.token, input);
    expect(first.status).toBe(200);
    const ticket = first.body.ticket as { id: string; status: string; dept: string; cUserId: string };
    const before = await state(ticket.id);
    const moved = await assign({ ticketId: ticket.id, dept: "B 端新部门", assignee: "新受理人" });
    const afterAssignment = await state(ticket.id);
    const replay = await cRequest("/tickets", customerA.token, input);
    const other = await cRequest("/tickets", customerOther.token, input);
    const changed = await cRequest("/tickets", customerA.token, { ...input, payload: { different: true } });
    const deniedDetail = await cRequest(`/tickets/${ticket.id}`, customerOther.token);
    const after = await state(ticket.id);
    record("c-create-assignment-replay", ["two actual C sessions in one synthetic scope"], ["C create+automatic assign", "B reassign", "owner replays", "other C user and changed body retry"], ["create 200 assigned and one receipt", "B reassign 200", "replay retains latest assignment, no new effects", "cross-user/changed request 409 no private ticket", "other-user detail 404"], { first, before, moved, afterAssignment, replay, other, changed, deniedDetail, after });
    expect(ticket.status).toBe("assigned");
    expect(ticket.cUserId).toBe(customerA.userId);
    expect(before.local.map((event) => event.action)).toEqual(["create", "assign"]);
    expect(before.business.map((event) => event.payload.decision.action)).toEqual(["service.ticket.create"]);
    expect(before.notifications).toBe(1);
    expect(moved.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ticket: { id: ticket.id, dept: "B 端新部门", assignee: "新受理人" }, idempotentReplay: true, receipt: { idempotentReplay: true } });
    expect(replay.body.receipt).not.toHaveProperty("eventId");
    expect(replay.body.receipt).not.toHaveProperty("delivery");
    for (const conflict of [other, changed]) {
      expect(conflict.status).toBe(409);
      expect(conflict.body).not.toHaveProperty("ticket");
      expect(JSON.stringify(conflict.body)).not.toContain(ticket.id);
      expect(JSON.stringify(conflict.body)).not.toContain(customerA.userId);
      expect(JSON.stringify(conflict.body)).not.toContain(input.title);
    }
    expect(deniedDetail.status).toBe(404);
    expect(after).toEqual(afterAssignment);
    expect(before.local[0]!.detail.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(after.local[0]).toEqual(before.local[0]);
  });

  it.each(["local", "business", "commit"] as const)("C 自动派单 %s 故障不留下建单/派单/通知，解除后同键可建单", async (stage) => {
    const customer = await cSession(`create-rollback-${stage}`);
    const input = { kind: "repair", title: `${prefix} rollback C ${stage}`, payload: {}, idempotencyKey: `${prefix}-rollback-C-${stage}` };
    const effects = async () => (await owner!.query(
      `SELECT (SELECT count(*)::int FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2) AS tickets,
              (SELECT count(*)::int FROM c_ticket_events e JOIN c_tickets t ON t.id=e.ticket_id WHERE t.workspace_id=$1 AND t.idempotency_key=$2) AS local,
              (SELECT count(*)::int FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='service.ticket.create' AND payload->'decision'->'after'->>'title'=$3) AS business,
              (SELECT count(*)::int FROM c_notifications WHERE workspace_id=$1 AND payload->>'title'=$3) AS notifications`,
      [scopeA.workspaceId, input.idempotencyKey, input.title])).rows[0];
    await owner!.query("INSERT INTO ticket_assignment_faults (stage,title) VALUES ($1,$2)", [stage, input.title]);
    let failed: Awaited<ReturnType<typeof cRequest>>;
    try { failed = await cRequest("/tickets", customer.token, input); }
    finally { await owner!.query("DELETE FROM ticket_assignment_faults WHERE stage=$1", [stage]); }
    const rolledBack = await effects();
    const retry = await cRequest("/tickets", customer.token, input);
    const after = await effects();
    record(`c-create-rollback-${stage}`, ["actual C session", `${stage} actual trigger failure`], ["C HTTP create", "remove fault", "identical key retry"], ["safe 500", "zero ticket/local/business/notification effects", "retry creates one ticket and one pair plus notification"], { failed, rolledBack, retry, after });
    expect(failed!.status).toBe(500);
    expect(failed!.body).toEqual({ error: "服务内部错误", requestId: expect.any(String) });
    expect(rolledBack).toEqual({ tickets: 0, local: 0, business: 0, notifications: 0 });
    expect(retry.status).toBe(200);
    expect(after).toEqual({ tickets: 1, local: 2, business: 1, notifications: 1 });
  });
});
