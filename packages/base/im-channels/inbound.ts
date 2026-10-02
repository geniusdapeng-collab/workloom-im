/**
 * im-channels · 入站归一化（D14/B11：外部 IM 消息 → 五元事件）
 * 链路：dsh-im（L1 通道适配层）收到通道消息 → server im.inbound 转发至此 →
 *       归一化校验 → openid→成员映射（members.im_openids，E5.2 预留位）→
 *       网关三段瀑布落五元事件（G8 留痕 100%；PII 脱敏段天然覆盖通道文本）
 * 幂等：同一 (channel, channel_msg_id) 重复投递只落首条（L1.4 同口径，通道重推是常态）
 */
import type pg from "pg";
import { ContextSchema } from "@workloom/shared";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";
import { ChannelError, getChannel, type ApprovalChannel } from "./registry.js";

/** RLS 会话上下文封装（同 review-console 口径：每个 client 连接重设 set_config，池不共享会话级设置） */
async function scoped<T>(
  pool: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardConnection = false;
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    // 冲突占位之后的独立 SELECT 要看见赢家刚提交的回执，显式固定语句级快照。
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discardConnection = true;
      throw new AggregateError([err, rollbackError], "IM 事务回滚失败，已销毁连接");
    }
    throw err;
  } finally {
    client.release(discardConnection);
  }
}

/** 归一化入站消息（dsh-im 各渠道 runtime 输出归一到此结构；bind 时已做平台差异抹平） */
export interface InboundMessage {
  channel: ApprovalChannel;
  /** 通道侧消息唯一 ID（幂等键） */
  channelMsgId: string;
  /** 会话标识（私聊=对方 ID；群聊=群 ID） */
  conversationId: string;
  /** 群聊/私聊 */
  kind: "direct" | "group";
  /** 发送者 openid（平台侧用户标识；经 im_openids 映射成员） */
  senderOpenId: string;
  /** 文本正文（首版只接文字；富文本/附件后置） */
  text: string;
  /** 通道侧发送时间（缺省=服务端接收时间） */
  sentAt?: string;
}

/** 入站处理结果 */
export interface InboundResult {
  eventId: string | null;
  deduped: boolean;
  /** 成员映射结果：member=已映射（who=MEM-xxx）；visitor=未映射外部联系人（who.id=ext:…，只读口径） */
  identity: "member" | "visitor";
  memberNo?: string;
}

/** openid → 成员映射（E5.2：members.im_openids JSONB，形如 {"dingtalk":"ou_xxx"}；L7.1 越权返回空） */
export async function resolveMemberByOpenid(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  openId: string,
): Promise<{ memberNo: string; role: string; name: string } | null> {
  return scoped(app, scope, (c) => resolveMemberOnClient(c, scope, channel, openId));
}

/** 入站已经持有事务时复用连接；显式校验工作区属主，不能只依赖 workspace 粒度 RLS。 */
async function resolveMemberOnClient(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  openId: string,
): Promise<{ memberNo: string; role: string; name: string } | null> {
  const r = await client.query<{ member_no: string; role: string; name: string }>(
    `SELECT m.member_no, m.role, m.name FROM members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id=$1 AND m.im_openids->>$2 = $3 AND w.tenant_id=$4`,
    [scope.workspaceId, channel, openId, scope.tenantId],
  );
  const row = r.rows[0];
  return row ? { memberNo: row.member_no, role: row.role, name: row.name } : null;
}

/** 反向查询：会话成员在该通道绑定的 openid（P0-1 未验签降级用：仅允许本人操作） */
export async function boundOpenidOfMember(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  memberNo: string,
): Promise<string | null> {
  return scoped(app, scope, async (c) => {
    const r = await c.query<{ openid: string | null }>(
      `SELECT im_openids->>$2 AS openid FROM members
       WHERE workspace_id=$1 AND member_no=$3`,
      [scope.workspaceId, channel, memberNo],
    );
    return r.rows[0]?.openid ?? null;
  });
}

/** 入站归一化校验（纯函数，可单测；坏消息直接拒，不落库） */
export function validateInbound(msg: InboundMessage): void {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    throw new ChannelError("INVALID_MESSAGE", "入站消息必须是归一化对象");
  }
  if (typeof msg.channel !== "string") throw new ChannelError("INVALID_MESSAGE", "缺有效 channel");
  getChannel(msg.channel); // 未启用/未知通道在此抛 ChannelError
  for (const [key, message] of [
    ["channelMsgId", "缺 channel_msg_id（幂等键必填）"],
    ["conversationId", "缺 conversation_id"],
    ["senderOpenId", "缺 sender_open_id"],
    ["text", "首版仅支持文字消息（D14 口径同 dsh-im）"],
  ] as const) {
    if (typeof msg[key] !== "string" || !msg[key].trim()) throw new ChannelError("INVALID_MESSAGE", message);
  }
  if (msg.text.length > 2000) throw new ChannelError("INVALID_MESSAGE", "通道消息 ≤2000 字");
  if (msg.kind !== "direct" && msg.kind !== "group") throw new ChannelError("INVALID_MESSAGE", "kind 必须是 direct 或 group");
  if (msg.sentAt !== undefined && !ContextSchema.shape.time.safeParse(msg.sentAt).success) {
    throw new ChannelError("INVALID_MESSAGE", "sent_at 必须符合五元事件时间格式");
  }
}

interface InboundEventRow {
  event_id: string;
  mapped_member: string | null;
  channel_msg_id: string;
}

/** 只复用本租户/工作区里绑定该通道消息的真实事件；旧事件可能已把消息 ID 脱敏。 */
async function findInboundOnClient(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  channelMsgId: string,
  eventId: string | null = null,
): Promise<InboundEventRow | null> {
  const maskedKey = maskText(channelMsgId).text;
  // 普通机器标识不会经 PII 转换。转换后的键和字面 PII 占位字串可能同值，
  // 必须额外对账原始去重键，不能把展示层相等冒充原始消息相同。
  const mayHaveAlias = maskedKey !== channelMsgId || channelMsgId.includes("[PII:");
  const r = await client.query<InboundEventRow>(
    `SELECT e.event_id, e.payload->'decision'->'after'->>'mapped_member' AS mapped_member,
            e.payload->'decision'->'after'->>'channel_msg_id' AS channel_msg_id FROM biz_events e
     WHERE e.tenant_id=$1 AND e.workspace_id=$2
       AND e.payload->'context'->>'tenant_id'=$1 AND e.payload->'context'->>'workspace_id'=$2
       AND e.payload->'decision'->>'action'='im.message'
       AND e.payload->'decision'->'after'->>'channel_msg_id'=ANY($3::text[])
       AND e.payload->'context'->>'channel'=$4
       AND ($5::text IS NULL OR e.event_id=$5)
       AND (NOT $6::boolean OR NOT EXISTS (
         SELECT 1 FROM im_inbound_dedupe d
         WHERE d.workspace_id=$2 AND d.channel=$4 AND d.event_id=e.event_id AND d.channel_msg_id<>$7
       ))
     ORDER BY e.seq ASC LIMIT 1`,
    [scope.tenantId, scope.workspaceId, [...new Set([channelMsgId, maskedKey])], channel, eventId, mayHaveAlias, channelMsgId],
  );
  const event = r.rows[0] ?? null;
  if (event && eventId === null && mayHaveAlias) {
    // 遗留空占位没有真实 event_id 绑定；另一个空原始键也映射到同一展示值时，
    // 现有历史信息不足以证明归属。拒绝猜测，保留事件与空占位供对账。
    const blanks = await client.query<{ channel_msg_id: string }>(
      `SELECT channel_msg_id FROM im_inbound_dedupe
       WHERE workspace_id=$1 AND channel=$2 AND event_id='' AND channel_msg_id<>$3`,
      [scope.workspaceId, channel, channelMsgId],
    );
    if (blanks.rows.some((row) => maskText(row.channel_msg_id).text === event.channel_msg_id)) {
      throw new Error("IM 入站历史事件与多个原始消息键存在歧义，拒绝恢复");
    }
  }
  return event;
}

function duplicateResult(event: InboundEventRow): InboundResult {
  return event.mapped_member
    ? { eventId: event.event_id, deduped: true, identity: "member", memberNo: event.mapped_member }
    : { eventId: event.event_id, deduped: true, identity: "visitor" };
}

async function completeClaim(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  msg: InboundMessage,
  eventId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE im_inbound_dedupe SET event_id=$4
     WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3 AND event_id=''`,
    [scope.workspaceId, msg.channel, msg.channelMsgId, eventId],
  );
  if (result.rowCount !== 1) throw new Error("IM 入站事件回执未完成回填，事务拒绝提交");
}

/** 通道消息去重查询（L1.4 同口径：按 (channel, channel_msg_id) 查事件库投影）
 * @deprecated #29 起 ingestInbound 改走 im_inbound_dedupe 幂等键表（原子占位）；
 * 本函数仅保留作排障/审计查询，禁止再用于写入前查重（TOCTOU）。 */
export async function findInboundEvent(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  channelMsgId: string,
): Promise<string | null> {
  return scoped(app, scope, async (c) => (await findInboundOnClient(c, scope, channel, channelMsgId))?.event_id ?? null);
}

/**
 * 入站消息落五元事件（经网关三段瀑布；PII 脱敏段天然覆盖——通道文本里的手机号/身份证不落明文 F1.10）
 * 重复投递幂等：已落过即返回原 eventId，deduped=true
 *
 * MC-170：主键占位、锁定回执、成员映射、网关事件和回填共享同一事务。
 * 冲突投递等赢家提交后才读非空真实回执；旧空占位先查成功历史事件，
 * 有则恢复回执、无则完成入站。任一步失败全部回滚，不返回 null 假成功。
 */
export async function ingestInbound(
  app: pg.Pool,
  _gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  msg: InboundMessage,
): Promise<InboundResult> {
  validateInbound(msg);

  // gateway 参数保持调用兼容；网关原语使用 app 持有的事务，不再申请第二个连接。
  return scoped(app, scope, async (c) => {
    const inserted = await c.query(
      `INSERT INTO im_inbound_dedupe (workspace_id, channel, channel_msg_id, event_id)
       VALUES ($1,$2,$3,'') ON CONFLICT DO NOTHING`,
      [scope.workspaceId, msg.channel, msg.channelMsgId],
    );
    // 独立语句读取冲突赢家的新快照；行锁也使旧空占位只能被一路恢复。
    const claim = await c.query<{ event_id: string }>(
      `SELECT event_id FROM im_inbound_dedupe
       WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3 FOR UPDATE`,
      [scope.workspaceId, msg.channel, msg.channelMsgId],
    );
    const receipt = claim.rows[0]?.event_id;
    if (receipt === undefined) throw new Error("IM 入站去重占位不可见，事务拒绝提交");
    // 新原始键不能因历史展示值相同被当作重复；自动恢复只适用于既存空占位。
    const prior = receipt || inserted.rowCount === 0
      ? await findInboundOnClient(c, scope, msg.channel, msg.channelMsgId, receipt || null)
      : null;
    if (receipt) {
      if (!prior) throw new Error("IM 入站去重回执未绑定本工作区的真实消息事件");
      return duplicateResult(prior);
    }
    if (prior) {
      await completeClaim(c, scope, msg, prior.event_id);
      return duplicateResult(prior);
    }

    const member = await resolveMemberOnClient(c, scope, msg.channel, msg.senderOpenId);
    const whoId = member ? member.memberNo : `ext:${msg.channel}:${msg.senderOpenId}`;
    const res = await gatewayAppendOnClient(c, {
      ...scope,
      actor: { id: whoId, type: "human" },
    }, {
      who: { type: "human", id: whoId },
      context: {
        tenant_id: scope.tenantId,
        workspace_id: scope.workspaceId,
        time: msg.sentAt ?? new Date().toISOString(),
        channel: msg.channel,
      },
      object: { type: "im_conversation", id: `${msg.channel}:${msg.conversationId}` },
      decision: {
        action: "im.message",
        after: {
          text: msg.text,
          kind: msg.kind,
          channel_msg_id: msg.channelMsgId,
          sender_open_id: msg.senderOpenId,
          mapped_member: member?.memberNo ?? null,
        },
      },
      rule_impact: [],
    });
    await completeClaim(c, scope, msg, res.eventId);
    return {
      eventId: res.eventId,
      deduped: false,
      identity: member ? "member" : "visitor",
      memberNo: member?.memberNo,
    };
  });
}
