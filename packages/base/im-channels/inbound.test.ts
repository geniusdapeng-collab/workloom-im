/**
 * MC-170 · 入站单事务断言。
 * 纯校验始终运行；PG 用例要求 RUN_DB_TESTS=1 与三条显式测试连接。
 * 每轮使用独有 synthetic scope，故障触发器仅命中该轮；不调用真实通道或模型。
 */
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeParseBusinessEvent } from "@workloom/shared";
import {
  findInboundEvent,
  ingestInbound,
  resolveMemberByOpenid,
  validateInbound,
  type InboundMessage,
} from "./inbound.js";
import { ChannelError, type ApprovalChannel } from "./registry.js";
import { GatewayReject, gatewayAppend, gatewayAppendOnClient, type EventDraft } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";

type Scope = { tenantId: string; workspaceId: string };
type MatrixRow = {
  id: string; given: string; steps: string[]; expected: string;
  actual: "PASS" | "FAIL"; errorClass?: string;
};
const matrix: MatrixRow[] = [];
const definedCases: Array<Omit<MatrixRow, "actual" | "errorClass">> = [];
function check(
  id: string, given: string, steps: string[], expected: string, run: () => Promise<void> | void,
) {
  definedCases.push({ id, given, steps, expected });
  it(`${id}: ${expected}`, async () => {
    try {
      await run();
      matrix.push({ id, given, steps, expected, actual: "PASS" });
    } catch (error) {
      matrix.push({ id, given, steps, expected, actual: "FAIL", errorClass: error instanceof Error ? error.name : "NonError" });
      throw error;
    }
  });
}
afterAll(async () => {
  if (process.env.MC170_EVIDENCE_JSON) {
    await writeFile(process.env.MC170_EVIDENCE_JSON, JSON.stringify({
      schemaVersion: "workloom.mc170.case-matrix/v1", synthetic: true,
      environment: "local-preview", customerData: false, externalMessages: 0, modelCalls: 0,
      runDb: process.env.RUN_DB_TESTS === "1",
      cases: definedCases.map((definition) => matrix.find((row) => row.id === definition.id) ?? { ...definition, actual: "NOT_RUN_OR_TIMEOUT" }),
      totals: { pass: matrix.filter((row) => row.actual === "PASS").length, fail: matrix.filter((row) => row.actual === "FAIL").length, notRunOrTimeout: definedCases.length - matrix.length },
    }, null, 2) + "\n");
  }
});

const message = (tag: string, changes: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "dingtalk", channelMsgId: `message-${tag}`, conversationId: "synthetic-conversation",
  kind: "direct", senderOpenId: "synthetic-visitor", text: "合成入站消息",
  sentAt: "2026-10-03T08:00:00+08:00", ...changes,
});
const invalid = (input: unknown) => {
  try {
    validateInbound(input as InboundMessage);
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).code).toBe("INVALID_MESSAGE");
    return;
  }
  throw new Error("Expected INVALID_MESSAGE");
};
describe("MC170 · 归一化边界", () => {
  for (const [name, value] of [["null", null], ["undefined", undefined], ["array", []], ["number", 7], ["string", "raw"]] as const) {
    check(`VALIDATE-object-${name}`, "运行时输入不是消息对象", ["直接调用 validateInbound"], "明确 ChannelError 拒绝非法对象", () => invalid(value));
  }
  for (const key of ["channelMsgId", "conversationId", "senderOpenId", "text"] as const) {
    for (const [name, value] of [["empty", ""], ["blank", " \n\t "], ["number", 17], ["boolean", false], ["object", {}], ["array", []], ["null", null]] as const) {
      check(`VALIDATE-${key}-${name}`, `${key} 缺失、空白或类型错误`, ["直接调用 validateInbound"], "拒绝非法必填字符串", () => invalid({ ...message("invalid"), [key]: value }));
    }
  }
  for (const value of [undefined, null, "broadcast", 9]) {
    check(`VALIDATE-kind-${String(value)}`, "消息 kind 非 direct/group", ["调用归一化校验"], "拒绝非法会话类型", () => invalid({ ...message("kind"), kind: value }));
  }
  for (const value of [null, 123, "", "invalid-date", "2026-10-03", "2026-99-03T00:00:00Z"]) {
    check(`VALIDATE-time-${String(value)}`, "sentAt 不符合共享五元事件时间契约", ["调用归一化校验"], "拒绝非法可选发送时间", () => invalid({ ...message("time"), sentAt: value }));
  }
  check("VALIDATE-enabled-channel", "四个启用通道与合法 Z/偏移时间", ["逐通道校验"], "启用通道、Unicode 与 2000 UTF-16 边界通过", () => {
    for (const channel of ["inapp", "dingtalk", "wecom", "feishu"] as const) {
      expect(() => validateInbound(message("valid", { channel, text: "😀".repeat(1000) }))).not.toThrow();
      expect(() => validateInbound(message("valid", { channel, sentAt: "2026-10-03T00:00:00Z" }))).not.toThrow();
      expect(() => validateInbound(message("valid", { channel, sentAt: undefined }))).not.toThrow();
    }
    invalid(message("long", { text: "x".repeat(2001) }));
  });
  check("VALIDATE-unknown-planned", "未知与 planned 通道", ["校验 unknown 与 slack"], "沿用未知/未启用通道错误码", () => {
    expect(() => validateInbound({ ...message("unknown"), channel: "unknown" } as never)).toThrowError(ChannelError);
    expect(() => validateInbound(message("planned", { channel: "slack" }))).toThrowError(ChannelError);
  });
  check("VALIDATE-before-connect", "非法 kind 且 DB connect 会抛哨兵错误", ["调用 ingestInbound"], "非法消息在申请数据库连接前拒绝", async () => {
    let connections = 0;
    const noDb = { connect: async () => { connections += 1; throw new Error("SHOULD_NOT_CONNECT"); } } as unknown as pg.Pool;
    await expect(ingestInbound(noDb, noDb, { tenantId: "t", workspaceId: "w" }, { ...message("bad"), kind: "broadcast" } as never))
      .rejects.toBeInstanceOf(ChannelError);
    expect(connections).toBe(0);
  });
});

const RUN_DB = process.env.RUN_DB_TESTS === "1";
const dbDescribe = RUN_DB ? describe : describe.skip;
dbDescribe("MC170 · 真实 PostgreSQL 原子性、幂等与安全边界", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const scope: Scope = { tenantId: `mc170-tenant-${suffix}`, workspaceId: `mc170-workspace-${suffix}` };
  const otherWorkspace: Scope = { tenantId: scope.tenantId, workspaceId: `mc170-other-workspace-${suffix}` };
  const otherTenant: Scope = { tenantId: `mc170-other-tenant-${suffix}`, workspaceId: `mc170-other-tenant-workspace-${suffix}` };
  const boundOpenId = `mc170-bound-${suffix}`;
  const readonlyOpenId = `mc170-readonly-${suffix}`;
  const memberNo = "MEM-170";
  const table = `mc170_fault_${suffix}`;
  const functionName = `mc170_fault_check_${suffix}`;
  const eventTrigger = `mc170_event_fault_${suffix}`;
  const backfillTrigger = `mc170_backfill_fault_${suffix}`;
  let owner: pg.Pool;
  let app: pg.Pool;
  let gateway: pg.Pool;
  let triggersInstalled = false;

  beforeAll(async () => {
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      if (!process.env[key]) throw new Error(`MC170 RUN_DB_TESTS=1 requires explicit ${key}`);
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 20 });
    gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
    expect((await app.query("SELECT current_user AS role")).rows[0]?.role).toBe("workloom_app");
    expect((await gateway.query("SELECT current_user AS role")).rows[0]?.role).toBe("workloom_gateway");
    await owner.query("INSERT INTO tenants (id,name) VALUES ($1,'MC170 synthetic'),($2,'MC170 synthetic other')", [scope.tenantId, otherTenant.tenantId]);
    for (const item of [scope, otherWorkspace, otherTenant]) {
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'MC170 synthetic',$1,'synthetic-test')", [item.workspaceId, item.tenantId]);
      await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role,im_openids) VALUES ($1,$2,$3,'MC170 synthetic member','owner',$4)",
        [`member-${item.workspaceId}`, item.workspaceId, item === otherTenant ? "MEM-171" : memberNo, JSON.stringify({ dingtalk: boundOpenId })]);
    }
    await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role,im_openids) VALUES ($1,$2,'MEM-172','MC170 readonly human','readonly',$3)",
      [`readonly-${suffix}`, scope.workspaceId, JSON.stringify({ dingtalk: readonlyOpenId })]);
    const roles = await owner.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname");
    expect(roles.rows).toEqual([
      { rolname: "workloom_app", rolsuper: false, rolbypassrls: false },
      { rolname: "workloom_gateway", rolsuper: false, rolbypassrls: false },
    ]);
    await owner.query(`CREATE TABLE ${table} (workspace_id text NOT NULL, channel_msg_id text NOT NULL, phase text NOT NULL, PRIMARY KEY (workspace_id, channel_msg_id, phase))`);
    await owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN
        IF TG_TABLE_NAME='biz_events' THEN
          IF EXISTS (SELECT 1 FROM ${table} f WHERE f.workspace_id=NEW.workspace_id
            AND f.channel_msg_id=NEW.payload->'decision'->'after'->>'channel_msg_id' AND f.phase='event') THEN
            RAISE EXCEPTION 'MC170_SYNTHETIC_EVENT_INSERT' USING ERRCODE='P0001';
          END IF;
        ELSE
          IF EXISTS (SELECT 1 FROM ${table} f WHERE f.workspace_id=NEW.workspace_id AND f.channel_msg_id=NEW.channel_msg_id AND f.phase='backfill') THEN
            RAISE EXCEPTION 'MC170_SYNTHETIC_BACKFILL' USING ERRCODE='P0001';
          END IF;
          IF EXISTS (SELECT 1 FROM ${table} f WHERE f.workspace_id=NEW.workspace_id AND f.channel_msg_id=NEW.channel_msg_id AND f.phase='backfill-suppressed') THEN
            RETURN NULL;
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await owner.query(`CREATE TRIGGER ${eventTrigger} BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    await owner.query(`CREATE TRIGGER ${backfillTrigger} BEFORE UPDATE ON im_inbound_dedupe FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    triggersInstalled = true;
  });
  afterAll(async () => {
    try {
      if (triggersInstalled) {
        await owner.query(`DROP TRIGGER IF EXISTS ${eventTrigger} ON biz_events`);
        await owner.query(`DROP TRIGGER IF EXISTS ${backfillTrigger} ON im_inbound_dedupe`);
        await owner.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await owner.query(`DROP TABLE IF EXISTS ${table}`);
      }
    } finally {
      await Promise.all([app?.end(), gateway?.end(), owner?.end()]);
    }
  });

  async function scoped<T>(pool: pg.Pool, item: Scope, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true), set_config('app.tenant_id',$2,true)", [item.workspaceId, item.tenantId]);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function snapshot(msg: InboundMessage, item = scope) {
    const claims = await owner.query<{ event_id: string }>("SELECT event_id FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3", [item.workspaceId, msg.channel, msg.channelMsgId]);
    const events = await owner.query<{ event_id: string; payload: any }>(`SELECT event_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2
      AND payload->'decision'->>'action'='im.message' AND payload->'context'->>'channel'=$3
      AND payload->'decision'->'after'->>'channel_msg_id'=ANY($4::text[]) ORDER BY seq`, [item.tenantId, item.workspaceId, msg.channel, [...new Set([msg.channelMsgId, maskText(msg.channelMsgId).text])]]);
    return { claimCount: claims.rowCount, eventCount: events.rowCount, eventIds: events.rows.map((row) => row.event_id), receipt: claims.rows[0]?.event_id ?? null, events: events.rows };
  }
  async function fault(msg: InboundMessage, phase: string, run: () => Promise<void>) {
    await owner.query(`INSERT INTO ${table} VALUES ($1,$2,$3)`, [scope.workspaceId, msg.channelMsgId, phase]);
    try { await run(); } finally { await owner.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND channel_msg_id=$2 AND phase=$3`, [scope.workspaceId, msg.channelMsgId, phase]); }
  }
  async function claim(msg: InboundMessage, eventId = "", item = scope) {
    await scoped(app, item, (client) => client.query("INSERT INTO im_inbound_dedupe (workspace_id,channel,channel_msg_id,event_id) VALUES ($1,$2,$3,$4)", [item.workspaceId, msg.channel, msg.channelMsgId, eventId]));
  }
  function draft(msg: InboundMessage, item = scope, mappedMember: string | null = null): EventDraft {
    const who = mappedMember ?? `ext:${msg.channel}:${msg.senderOpenId}`;
    return {
      who: { type: "human", id: who }, context: { tenant_id: item.tenantId, workspace_id: item.workspaceId, time: msg.sentAt!, channel: msg.channel },
      object: { type: "im_conversation", id: `${msg.channel}:${msg.conversationId}` },
      decision: { action: "im.message", after: { text: msg.text, kind: msg.kind, channel_msg_id: msg.channelMsgId, sender_open_id: msg.senderOpenId, mapped_member: mappedMember } }, rule_impact: [],
    };
  }
  function appWithQuery(intercept: (client: pg.PoolClient, sql: string, params?: unknown[]) => Promise<pg.QueryResult> | undefined, released?: (discard: boolean) => void): pg.Pool {
    return { connect: async () => {
      const client = await app.connect();
      return {
        query: (sql: string, params?: unknown[]) => intercept(client, sql, params) ?? client.query(sql, params),
        release: (error?: Error | boolean) => { released?.(Boolean(error)); client.release(error); },
      };
    } } as unknown as pg.Pool;
  }
  const noGateway = { connect: async () => { throw new Error("GATEWAY_POOL_MUST_NOT_OPEN_SECOND_TRANSACTION"); } } as unknown as pg.Pool;
  async function assertOne(msg: InboundMessage, expectedId: string, item = scope) {
    const state = await snapshot(msg, item);
    expect(state.claimCount).toBe(1);
    expect(state.eventCount).toBe(1);
    expect(state.receipt).toBe(expectedId);
    expect(state.eventIds).toEqual([expectedId]);
  }
  async function assertDistinctAliases(firstMsg: InboundMessage, secondMsg: InboundMessage, firstId: string, secondId: string) {
    expect(firstId).not.toBe(secondId);
    const claims = await owner.query<{ channel_msg_id: string; event_id: string }>(
      `SELECT channel_msg_id,event_id FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=ANY($3::text[])`,
      [scope.workspaceId, firstMsg.channel, [firstMsg.channelMsgId, secondMsg.channelMsgId]],
    );
    expect(claims.rowCount).toBe(2);
    expect(new Map(claims.rows.map((row) => [row.channel_msg_id, row.event_id])))
      .toEqual(new Map([[firstMsg.channelMsgId, firstId], [secondMsg.channelMsgId, secondId]]));
    const events = await owner.query<{ event_id: string; payload: any }>(
      "SELECT event_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=ANY($3::text[]) ORDER BY seq",
      [scope.tenantId, scope.workspaceId, [firstId, secondId]],
    );
    expect(events.rowCount).toBe(2);
    expect(events.rows[0]!.payload.decision.after.text).toBe(firstMsg.text);
    expect(events.rows[1]!.payload.decision.after.text).toBe(secondMsg.text);
  }

  check("PG-event-failure", "该消息事件 INSERT 被本轮触发器拒绝", ["触发失败", "查询去重和事件表", "解除故障重推"], "事件失败不留占位；重推新增一条真实事件", async () => {
    const msg = message("event-failure");
    await fault(msg, "event", async () => {
      await expect(ingestInbound(app, gateway, scope, msg)).rejects.toMatchObject({ code: "P0001" });
      expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0, receipt: null });
    });
    const retry = await ingestInbound(app, gateway, scope, msg);
    expect(retry.deduped).toBe(false);
    await assertOne(msg, retry.eventId!);
  });
  check("PG-member-resolution-failure", "成员 SELECT 在真实连接执行 SELECT 1/0", ["故障后查询两表", "正常重推"], "成员解析失败回滚占位且可重推", async () => {
    const msg = message("member-failure", { senderOpenId: boundOpenId });
    const failing = appWithQuery((client, sql) => /FROM members/.test(sql) ? client.query("SELECT 1/0") : undefined);
    await expect(ingestInbound(failing, gateway, scope, msg)).rejects.toMatchObject({ code: "22012" });
    expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    const retry = await ingestInbound(app, gateway, scope, msg);
    expect(retry).toMatchObject({ deduped: false, identity: "member", memberNo });
    await assertOne(msg, retry.eventId!);
  });
  check("PG-backfill-failure", "UPDATE 回执被真实 PG 触发器拒绝", ["触发失败并查询两表", "解除故障后重推"], "回填失败同时回滚事件与占位", async () => {
    const msg = message("backfill-failure");
    await fault(msg, "backfill", async () => {
      await expect(ingestInbound(app, gateway, scope, msg)).rejects.toMatchObject({ code: "P0001" });
      expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    });
    const retry = await ingestInbound(app, gateway, scope, msg);
    expect(retry.deduped).toBe(false);
    await assertOne(msg, retry.eventId!);
  });
  check("PG-backfill-zero-rows", "BEFORE UPDATE RETURN NULL 使回填 rowCount=0", ["抑制回填", "检查回滚", "解除故障重推"], "缺真实回执不得提交成功事件", async () => {
    const msg = message("backfill-zero");
    await fault(msg, "backfill-suppressed", async () => {
      await expect(ingestInbound(app, gateway, scope, msg)).rejects.toThrow();
      expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    });
    const retry = await ingestInbound(app, gateway, scope, msg);
    await assertOne(msg, retry.eventId!);
  });
  check("PG-one-client", "兼容的 gateway 参数拒绝申请连接", ["仅使用真实 app 连接 ingest"], "网关与业务写共享同一个事务连接", async () => {
    const msg = message("one-client");
    let connections = 0;
    const tracked = appWithQuery(() => undefined);
    const original = tracked.connect.bind(tracked);
    tracked.connect = (async () => { connections += 1; return original(); }) as pg.Pool["connect"];
    const result = await ingestInbound(tracked, noGateway, scope, msg);
    expect(connections).toBe(1);
    await assertOne(msg, result.eventId!);
  });
  check("PG-connection-termination", "回填前终止本次持有的真实 app backend", ["仅终止该连接 PID", "读取事务回滚结果", "用新连接同 ID 重推"], "连接中断不留下占位或事件且可重推", async () => {
    const msg = message("connection-termination");
    let terminated = false;
    const connectionErrors: Error[] = [];
    const disconnected = appWithQuery((client, sql, params) => {
      if (!/UPDATE im_inbound_dedupe/.test(sql)) return undefined;
      client.on("error", (error) => { connectionErrors.push(error); });
      return (async () => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        const killed = await owner.query<{ terminated: boolean }>("SELECT pg_terminate_backend($1) AS terminated", [pid]);
        terminated = killed.rows[0]!.terminated;
        return client.query(sql, params);
      })();
    });
    await expect(ingestInbound(disconnected, gateway, scope, msg)).rejects.toThrow();
    expect(terminated).toBe(true);
    expect(connectionErrors.every((error) => error instanceof Error)).toBe(true);
    expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    const retry = await ingestInbound(app, gateway, scope, msg);
    expect(retry.deduped).toBe(false);
    await assertOne(msg, retry.eventId!);
  });
  check("PG-concurrent-12", "十二路并发投递同一消息", ["Promise.all 同 ID", "核对赢家/重复回执/表行"], "并发只落一条且每路返回同一非空 eventId", async () => {
    const msg = message("concurrent");
    const results = await Promise.all(Array.from({ length: 12 }, () => ingestInbound(app, gateway, scope, msg)));
    expect(results.filter((row) => !row.deduped)).toHaveLength(1);
    const winner = results.find((row) => !row.deduped)!;
    expect(winner.eventId).toMatch(/^E-\d+$/);
    expect(new Set(results.map((row) => row.eventId))).toEqual(new Set([winner.eventId]));
    await assertOne(msg, winner.eventId!);
  });
  check("PG-concurrent-first-failure", "首路在成员解析持锁，六路同 ID 已发 INSERT", ["首路真实 SELECT 1/0 回滚", "等后续并发完成"], "首路失败后等待方仍可选出一位成功赢家", async () => {
    const msg = message("concurrent-first-failure");
    let reached!: () => void;
    let proceed!: () => void;
    const atMember = new Promise<void>((resolve) => { reached = resolve; });
    const releaseMember = new Promise<void>((resolve) => { proceed = resolve; });
    const failing = appWithQuery((client, sql) => {
      if (!/FROM members/.test(sql)) return undefined;
      reached();
      return releaseMember.then(() => client.query("SELECT 1/0"));
    });
    const first = ingestInbound(failing, gateway, scope, msg).then(() => null, (error: { code?: string }) => error.code);
    await atMember;
    let dispatched = 0;
    let allDispatched!: () => void;
    const insertDispatched = new Promise<void>((resolve) => { allDispatched = resolve; });
    const peers = appWithQuery((_client, sql) => {
      if (/INSERT INTO im_inbound_dedupe/.test(sql) && ++dispatched === 6) allDispatched();
      return undefined;
    });
    const others = Promise.all(Array.from({ length: 6 }, () => ingestInbound(peers, gateway, scope, msg)));
    try { await insertDispatched; } finally { proceed(); }
    expect(await first).toBe("22012");
    const results = await others;
    expect(results.filter((row) => !row.deduped)).toHaveLength(1);
    const winner = results.find((row) => !row.deduped)!;
    expect(new Set(results.map((row) => row.eventId))).toEqual(new Set([winner.eventId]));
    await assertOne(msg, winner.eventId!);
  });
  check("PG-success-identity-stable", "已映射成员的成功事件，再以不同 sender 重推同 ID", ["先处理成员消息", "重复投递"], "重复返回原事件的成员身份与同一回执", async () => {
    const msg = message("mapped", { senderOpenId: boundOpenId });
    const first = await ingestInbound(app, gateway, scope, msg);
    const duplicate = await ingestInbound(app, gateway, scope, { ...msg, senderOpenId: "synthetic-new-sender" });
    expect(first).toMatchObject({ deduped: false, identity: "member", memberNo });
    expect(duplicate).toEqual({ eventId: first.eventId, deduped: true, identity: "member", memberNo });
    await assertOne(msg, first.eventId!);
  });
  check("PG-visitor-success", "未绑定访客合法消息", ["投递后重复一次", "读取 payload"], "访客 who 沿用 ext 身份且回执稳定", async () => {
    const msg = message("visitor");
    const first = await ingestInbound(app, gateway, scope, msg);
    const duplicate = await ingestInbound(app, gateway, scope, msg);
    expect(first.identity).toBe("visitor");
    expect(duplicate).toMatchObject({ eventId: first.eventId, deduped: true, identity: "visitor" });
    expect((await snapshot(msg)).events[0]!.payload.who.id).toBe(`ext:${msg.channel}:${msg.senderOpenId}`);
  });
  check("PG-readonly-human-message", "绑定 readonly 人类成员发送普通消息", ["投递消息并重推", "读取成员映射"], "普通入站消息保留 human 语义与 readonly 映射", async () => {
    const msg = message("readonly-human", { senderOpenId: readonlyOpenId });
    const first = await ingestInbound(app, gateway, scope, msg);
    expect(first).toMatchObject({ identity: "member", memberNo: "MEM-172", deduped: false });
    expect((await ingestInbound(app, gateway, scope, msg))).toMatchObject({ eventId: first.eventId, identity: "member", memberNo: "MEM-172", deduped: true });
    await assertOne(msg, first.eventId!);
  });
  for (const channel of ["inapp", "dingtalk", "wecom", "feishu"] as const) {
    check(`PG-channel-${channel}`, "启用通道同一消息 ID、特殊字符与时间偏移", ["投递并读取原始事件"], `${channel} 正常入站且按通道区分幂等键`, async () => {
      const msg = message("same-id-each-channel", { channel, kind: "group", text: "合成中文 😀 ' 引号 \\ 换行\n文本", conversationId: "synthetic:'\\群" });
      const result = await ingestInbound(app, gateway, scope, msg);
      await assertOne(msg, result.eventId!);
      const payload = (await snapshot(msg)).events[0]!.payload;
      expect(payload.decision.after.text).toBe(msg.text);
      expect(payload.decision.after.kind).toBe("group");
      expect(payload.context.time).toBe(msg.sentAt);
    });
  }
  check("PG-legacy-empty-no-event", "旧版遗留空占位，无历史成功事件", ["插入空占位", "重推", "再次重复"], "空占位可恢复一条真实事件且后续稳定去重", async () => {
    const msg = message("legacy-empty");
    await claim(msg);
    const recovered = await ingestInbound(app, gateway, scope, msg);
    expect(recovered.deduped).toBe(false);
    await assertOne(msg, recovered.eventId!);
    expect((await ingestInbound(app, gateway, scope, msg)).eventId).toBe(recovered.eventId);
  });
  check("PG-legacy-empty-concurrent", "已提交空占位，无成功事件，十二路重推", ["插入旧空占位", "并发恢复"], "历史空占位恢复同样只落一条事件", async () => {
    const msg = message("legacy-concurrent");
    await claim(msg);
    const results = await Promise.all(Array.from({ length: 12 }, () => ingestInbound(app, gateway, scope, msg)));
    expect(results.filter((row) => !row.deduped)).toHaveLength(1);
    expect(new Set(results.map((row) => row.eventId)).size).toBe(1);
    expect(results[0]!.eventId).toMatch(/^E-\d+$/);
    await assertOne(msg, results[0]!.eventId!);
  });
  check("PG-legacy-empty-with-event", "旧版空占位已有经网关成功的成员事件", ["网关写真实历史事件", "插入空占位", "重推"], "回填历史回执且不双写，沿用原成员身份", async () => {
    const msg = message("legacy-success", { senderOpenId: boundOpenId });
    const event = await gatewayAppend(gateway, { ...scope, actor: { id: memberNo, type: "human" } }, draft(msg, scope, memberNo));
    await claim(msg);
    const recovered = await ingestInbound(app, gateway, scope, msg);
    expect(recovered).toEqual({ eventId: event.eventId, deduped: true, identity: "member", memberNo });
    await assertOne(msg, event.eventId);
  });
  check("PG-legacy-masked-key", "原始消息 ID 是合成 PII，历史事件已按既有 PII 规则脱敏", ["网关写历史事件", "空占位重推", "旧查询入口检索"], "脱敏历史幂等键安全恢复并复用真实事件", async () => {
    const msg = message("legacy-pii", { channelMsgId: "13800001234", text: "合成电话 13800001234" });
    const event = await gatewayAppend(gateway, { ...scope, actor: { id: `ext:${msg.channel}:${msg.senderOpenId}`, type: "human" } }, draft(msg));
    await claim(msg);
    const result = await ingestInbound(app, gateway, scope, msg);
    expect(result).toMatchObject({ eventId: event.eventId, deduped: true });
    expect(await findInboundEvent(app, scope, msg.channel, msg.channelMsgId)).toBe(event.eventId);
    await assertOne(msg, event.eventId);
    expect(JSON.stringify((await snapshot(msg)).events[0]!.payload)).not.toContain(msg.channelMsgId);
  });
  check("PG-alias-new-claim", "另一真实消息 ID 等于已成功 PII 消息的公开占位字符串", ["先投递原始 PII ID", "投递不同原始键的新消息", "核对两个真实回执", "重推第二条"], "新占位只写自己的事件，不能通过脱敏别名误去重", async () => {
    const firstMsg = message("alias-new-first", { channelMsgId: "13700001001", text: "第一条合成别名消息" });
    const secondMsg = message("alias-new-second", { channelMsgId: maskText(firstMsg.channelMsgId).text, text: "第二条合成别名消息" });
    const first = await ingestInbound(app, gateway, scope, firstMsg);
    const second = await ingestInbound(app, gateway, scope, secondMsg);
    expect(second.deduped).toBe(false);
    await assertDistinctAliases(firstMsg, secondMsg, first.eventId!, second.eventId!);
    expect(await ingestInbound(app, gateway, scope, secondMsg)).toMatchObject({ eventId: second.eventId, deduped: true });
  });
  check("PG-alias-empty-claim", "公开占位字串原始键有旧空占位，真实事件已绑定另一原始 PII 键", ["铸真实 PII 事件", "给另一原始键插空占位", "恢复空占位"], "已有其他原始键绑定的事件不能被旧空占位复用", async () => {
    const firstMsg = message("alias-empty-first", { channelMsgId: "13700001002", text: "第一条旧空占位合成消息" });
    const secondMsg = message("alias-empty-second", { channelMsgId: maskText(firstMsg.channelMsgId).text, text: "第二条旧空占位合成消息" });
    const first = await ingestInbound(app, gateway, scope, firstMsg);
    await claim(secondMsg);
    const second = await ingestInbound(app, gateway, scope, secondMsg);
    expect(second.deduped).toBe(false);
    await assertDistinctAliases(firstMsg, secondMsg, first.eventId!, second.eventId!);
  });
  check("PG-alias-two-empty-ambiguous", "两条不同原始键均有旧空占位，唯一历史事件的脱敏字段无法区分归属", ["铸历史真实事件", "插两个旧空占位", "拒绝歧义恢复", "仅清理合成歧义空键后恢复原键", "新键正常入站"], "历史归属有歧义时拒绝猜测，解除歧义后原键可恢复、新键仍独立", async () => {
    const firstMsg = message("alias-two-empty-first", { channelMsgId: "13700001003", text: "第一条歧义合成消息" });
    const secondMsg = message("alias-two-empty-second", { channelMsgId: maskText(firstMsg.channelMsgId).text, text: "第二条歧义合成消息" });
    const event = await gatewayAppend(gateway, { ...scope, actor: { id: `ext:${firstMsg.channel}:${firstMsg.senderOpenId}`, type: "human" } }, draft(firstMsg));
    await claim(firstMsg);
    await claim(secondMsg);
    await expect(ingestInbound(app, gateway, scope, firstMsg)).rejects.toThrow();
    await expect(ingestInbound(app, gateway, scope, secondMsg)).rejects.toThrow();
    expect(await snapshot(firstMsg)).toMatchObject({ claimCount: 1, eventCount: 1, receipt: "" });
    expect(await snapshot(secondMsg)).toMatchObject({ claimCount: 1, eventCount: 1, receipt: "" });
    const removed = await scoped(app, scope, (client) => client.query(
      "DELETE FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3 AND event_id=''",
      [scope.workspaceId, secondMsg.channel, secondMsg.channelMsgId],
    ));
    expect(removed.rowCount).toBe(1);
    const restored = await ingestInbound(app, gateway, scope, firstMsg);
    expect(restored).toMatchObject({ eventId: event.eventId, deduped: true });
    const second = await ingestInbound(app, gateway, scope, secondMsg);
    expect(second.deduped).toBe(false);
    await assertDistinctAliases(firstMsg, secondMsg, event.eventId, second.eventId!);
  });
  check("PG-alias-audit-query", "成功 PII 原始键，另一个公开占位字串原始键尚未投递", ["铸成功事件", "用另一原始键调用历史查询"], "排障查询不能把另一原始键的真实事件报告为本消息", async () => {
    const msg = message("alias-audit", { channelMsgId: "13700001004" });
    const first = await ingestInbound(app, gateway, scope, msg);
    expect(await findInboundEvent(app, scope, msg.channel, maskText(msg.channelMsgId).text)).toBeNull();
    expect(await findInboundEvent(app, scope, msg.channel, msg.channelMsgId)).toBe(first.eventId);
  });
  check("PG-alias-corrupt-nonempty-claim", "另一原始键的坏非空占位指向 PII 消息的真实事件", ["铸成功事件", "伪造另一原始键回执", "拒绝重复成功"], "脱敏文本匹配也不能证明另一原始键的坏回执有效", async () => {
    const msg = message("alias-corrupt", { channelMsgId: "13700001005" });
    const first = await ingestInbound(app, gateway, scope, msg);
    const aliasMsg = message("alias-corrupt-other", { channelMsgId: maskText(msg.channelMsgId).text });
    await claim(aliasMsg, first.eventId!);
    await expect(ingestInbound(app, gateway, scope, aliasMsg)).rejects.toThrow();
    expect((await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3", [scope.tenantId, scope.workspaceId, first.eventId])).rows[0]!.n).toBe(1);
  });
  check("PG-corrupt-missing-receipt", "已提交的非空占位指向不存在的 E-999999999", ["插入坏回执占位", "重复投递"], "不存在的事件不得作为已处理成功回执", async () => {
    const msg = message("missing-receipt");
    await claim(msg, "E-999999999");
    await expect(ingestInbound(app, gateway, scope, msg)).rejects.toThrow();
    expect(await snapshot(msg)).toMatchObject({ claimCount: 1, eventCount: 0, receipt: "E-999999999" });
  });
  check("PG-corrupt-wrong-message", "坏占位指向本工作区另一消息的真实事件", ["先铸真实事件", "不同消息占位引用它", "投递不同消息"], "真实事件也必须绑定正确 channel 与 message ID", async () => {
    const original = message("receipt-source");
    const result = await ingestInbound(app, gateway, scope, original);
    const msg = message("receipt-wrong-message");
    await claim(msg, result.eventId!);
    await expect(ingestInbound(app, gateway, scope, msg)).rejects.toThrow();
    expect((await snapshot(msg)).eventCount).toBe(0);
    await assertOne(original, result.eventId!);
  });
  check("PG-scope-same-message", "同租户不同工作区、不同租户的工作区使用同消息 ID 与 openid", ["逐 scope 投递", "读取各自映射与回执"], "相同消息 ID 不跨租户或工作区去重/映射", async () => {
    const msg = message("same-scope-id", { senderOpenId: boundOpenId });
    const results = [];
    for (const item of [scope, otherWorkspace, otherTenant]) {
      const result = await ingestInbound(app, gateway, item, msg);
      expect(result).toMatchObject({ deduped: false, identity: "member", memberNo: item === otherTenant ? "MEM-171" : memberNo });
      await assertOne(msg, result.eventId!, item);
      results.push(result.eventId);
    }
    expect(new Set(results).size).toBe(3);
  });
  check("PG-scope-wrong-pair-new", "tenant B 与 tenant A 的工作区混配", ["新消息投递", "查询占位/事件", "合法作用域重推"], "错误归属网关拒绝且不留下新占位", async () => {
    const msg = message("wrong-pair-new");
    const wrong = { tenantId: otherTenant.tenantId, workspaceId: scope.workspaceId };
    await expect(ingestInbound(app, gateway, wrong, msg)).rejects.toThrow();
    expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    const retry = await ingestInbound(app, gateway, scope, msg);
    await assertOne(msg, retry.eventId!);
  });
  check("PG-scope-wrong-pair-existing", "已有成功成员消息，混配 tenant 重试", ["合法 scope 成功", "错误 tenant 重试", "错误 tenant 解析成员"], "错误 tenant 不复用成功回执、不映射别租户成员", async () => {
    const msg = message("wrong-pair-existing", { senderOpenId: boundOpenId });
    const result = await ingestInbound(app, gateway, scope, msg);
    const wrong = { tenantId: otherTenant.tenantId, workspaceId: scope.workspaceId };
    await expect(ingestInbound(app, gateway, wrong, msg)).rejects.toThrow();
    expect(await resolveMemberByOpenid(app, wrong, msg.channel, boundOpenId)).toBeNull();
    await assertOne(msg, result.eventId!);
  });
  check("PG-scope-foreign-receipt", "本区坏占位指向另一租户工作区成功事件", ["外区铸事件", "本区坏占位引用它", "投递本区消息"], "外租户事件编号不得被本区去重回执复用", async () => {
    const msg = message("foreign-receipt");
    const result = await ingestInbound(app, gateway, otherTenant, msg);
    await claim(msg, result.eventId!);
    await expect(ingestInbound(app, gateway, scope, msg)).rejects.toThrow();
    expect((await snapshot(msg)).eventCount).toBe(0);
    await assertOne(msg, result.eventId!, otherTenant);
  });
  check("PG-pii-on-current-write", "文本含仅用于测试的电话、证件与邮箱", ["正常 ingest", "读取事件 payload"], "既有 PII 瀑布仍覆盖入站事件的字符串叶子", async () => {
    const msg = message("pii", { text: "合成电话 13900001111，证件 110101199003077758，邮箱 mc170@example.invalid" });
    const result = await ingestInbound(app, gateway, scope, msg);
    const payload = JSON.stringify((await snapshot(msg)).events[0]!.payload);
    for (const raw of ["13900001111", "110101199003077758", "mc170@example.invalid"]) expect(payload).not.toContain(raw);
    for (const kind of ["PHONE", "IDCARD", "EMAIL"]) expect(payload).toContain(`[PII:${kind}:`);
    await assertOne(msg, result.eventId!);
  });
  check("PG-nul-storage-failure", "合法长度文本包含 PostgreSQL JSONB 不接受的 NUL", ["投递 NUL 文本", "查询两表", "去 NUL 后同 ID 重推"], "底层存储异常整事务回滚且可以重推", async () => {
    const msg = message("nul", { text: "合成\u0000文本" });
    await expect(ingestInbound(app, gateway, scope, msg)).rejects.toThrow();
    expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    const retry = await ingestInbound(app, gateway, scope, { ...msg, text: "合成文本" });
    await assertOne(msg, retry.eventId!);
  });
  check("PG-rollback-connection-discard", "真实成员 SQL 失败，ROLLBACK 故障缝返回失败", ["查询真实数据回滚", "记录连接释放参数", "查询两表"], "回滚失败显式报错并销毁该池连接", async () => {
    const msg = message("rollback-discard");
    let discarded = false;
    const failing = appWithQuery((client, sql) => {
      if (/FROM members/.test(sql)) return client.query("SELECT 1/0");
      if (sql === "ROLLBACK") return client.query(sql).then(() => { throw new Error("MC170_SYNTHETIC_ROLLBACK_TRANSPORT_FAILURE"); });
      return undefined;
    }, (value) => { discarded = value; });
    await expect(ingestInbound(failing, gateway, scope, msg)).rejects.toThrow();
    expect(discarded).toBe(true);
    expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
  });
  check("PG-rls-and-append-only", "真实 app 角色不绕过 RLS，owner 也受 append-only trigger 保护", ["未设 scope 查询", "合法他区查询外区", "app 直写", "owner 改/删/清事件"], "无 scope/合法跨区读为空、直写和事件改写均拒绝", async () => {
    const noScope = await app.query("SELECT count(*) AS n FROM biz_events");
    expect(Number(noScope.rows[0]!.n)).toBe(0);
    await scoped(app, otherTenant, async (client) => {
      const foreign = await client.query("SELECT count(*) AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId]);
      expect(Number(foreign.rows[0]!.n)).toBe(0);
    });
    await expect(app.query("INSERT INTO biz_events (event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-170-bypass','t','w','{}','GENESIS','h')")).rejects.toMatchObject({ code: "42501" });
    const before = Number((await owner.query("SELECT count(*) AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0]!.n);
    expect(before).toBeGreaterThan(0);
    await expect(owner.query("UPDATE biz_events SET hash='forged' WHERE workspace_id=$1", [scope.workspaceId])).rejects.toThrow(/append-only/);
    await expect(owner.query("DELETE FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE biz_events")).rejects.toThrow(/append-only/);
    expect(Number((await owner.query("SELECT count(*) AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0]!.n)).toBe(before);
  });
  for (const stage of ["permission", "authorization", "serialization"] as const) {
    check(`PG-gateway-tx-${stage}`, "网关原语与手动占位共用真实 app 事务；此用例不冒称 human ingest 会做 Agent 授权", ["事务插占位", "gatewayAppendOnClient 拒绝/序列化失败", "查询回滚"], `${stage} 失败也无法留下事务内业务占位或事件`, async () => {
      const msg = message(`gateway-${stage}`);
      const attempted = scoped(app, scope, async (client) => {
        await client.query("INSERT INTO im_inbound_dedupe (workspace_id,channel,channel_msg_id) VALUES ($1,$2,$3)", [scope.workspaceId, msg.channel, msg.channelMsgId]);
        const actor = { id: "mc170-agent", type: "agent" as const, fenceBindings: ["R1"], readonly: stage === "permission", highRisk: stage === "authorization" };
        const event: EventDraft = { ...draft(msg), who: { type: "agent", id: actor.id, version: "synthetic-v1" }, decision: { action: "price.adjust", after: stage === "serialization" ? { amount: 1n } : { amount: 100 } } };
        return gatewayAppendOnClient(client, { ...scope, actor }, event);
      });
      if (stage === "serialization") {
        await expect(attempted).rejects.toThrow(/BigInt/);
      } else {
        await expect(attempted).rejects.toBeInstanceOf(GatewayReject);
        await expect(attempted).rejects.toMatchObject({ stage });
      }
      expect(await snapshot(msg)).toMatchObject({ claimCount: 0, eventCount: 0 });
    });
  }
  check("PG-nonempty-chain", "本轮三条非空 scoped 链与所有成功入站事件", ["逐条独立重算 canonical SHA256", "逐条共享事件 Schema 校验"], "每条链从 GENESIS 连续、hash/payload/tenant/workspace 一致", async () => {
    const stable = (value: any): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    };
    for (const item of [scope, otherWorkspace, otherTenant]) {
      const rows = await owner.query<{ event_id: string; payload: any; prev_hash: string; hash: string }>("SELECT event_id,payload,prev_hash,hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq", [item.tenantId, item.workspaceId]);
      expect(rows.rows.length).toBeGreaterThan(0);
      let previous = "GENESIS";
      for (const row of rows.rows) {
        expect(row.prev_hash).toBe(previous);
        expect(row.hash).toBe(createHash("sha256").update(previous + stable(row.payload)).digest("hex"));
        expect(row.payload.event_id).toBe(row.event_id);
        expect(row.payload.context).toMatchObject({ tenant_id: item.tenantId, workspace_id: item.workspaceId });
        expect(safeParseBusinessEvent(row.payload).success).toBe(true);
        previous = row.hash;
      }
    }
  });
});
