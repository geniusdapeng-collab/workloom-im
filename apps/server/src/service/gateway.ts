/**
 * service · C 端公开网关（Hono 子应用，挂 /c，独立于员工 tRPC）
 *  - POST /c/session（S2）：h5 匿名设备直登仅 SERVICE_C_DEMO_AUTH==='true' 放行；正式 H5 必须验证
 *    受信身份网关的短期 entry_token，并从签名声明解析 workspaceKey/appId/subject；
 *    wechat-mini/alipay 走 code→openid 交换 seam（无凭据 503「渠道未配置」）；
 *    IP+channel 限流 60 次/分（限流 Map 5 分钟 TTL 清扫）
 *  - 鉴权：Bearer c-token（verifyCToken）；内存限流 60 次/分钟/用户
 *  - POST /c/chat：service-dialog 流水线；行业 toolCall 仅由已验证活动 Bundle 声明的适配器执行；
 *    ticketDraft + confirmTicket:true → 服务端幂等键 + createTicket/assignTicket/五元事件同一 serviceTx（H2）；
 *    pushMessage 失败 catch 落库 status='failed' 不阻断响应
 *  - 契约（H6，以 webc types.ts 为准）：行业卡片只返回已本地化的标题、中文状态、
 *    中文字段行和展示金额；行业私有字段与机读枚举不会穿过网关；
 *    工单附 statusText 中文枚举（保留英文 status）；/notifications 每项含 read:false
 *  - 输入约束（M9）：/chat text≤2000；/tickets kind 白名单 + title≤120 + payload JSON≤10KB
 * 工作区解析：只接受 SERVICE_C_WORKSPACE_ID 或 SERVICE_C_WORKSPACE_MAP 的服务端可信映射；
 * 未配置或目标不存在时 fail closed，禁止选择数据库第一条记录。
 */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getOwnerPool } from "@workloom/db";
import {
  CHANNELS, cSecret, exchangeCodeForOpenid, getCUser, h5EntrySecret, issueCToken, listNotifications, pushMessage,
  resolveCUser, verifyCToken, verifyH5EntryToken, type Channel, type CTokenPayload,
} from "./channels.js";
import { handleMessage } from "./dialog.js";
import {
  BusinessAdapterError,
  businessDisplayText,
  projectBusinessIdentityChallenge,
  runBusinessTool,
  type BusinessCatalogResult,
  type BusinessMemberResult,
  type BusinessOrderResult,
  type BusinessTool,
  type ServiceFrontBusinessAdapter,
} from "./adapters/business.js";
import {
  resolveWorkspaceBusinessAdapter,
  type BusinessAdapterBinding,
} from "./adapters/business-registry.js";
import {
  ServiceHttpError, assignTicketOn, createTicketOn, getTicket, listTickets, rateTicketOn, ticketTimeline,
  type Ticket,
} from "./ticket.js";
import { appendEventOn, serviceTx } from "./events.js";
import { ServiceWorkspaceRoutingError, selectServiceWorkspaceId } from "./workspace-routing.js";

export const serviceGateway = new Hono();

function projectedDepartment(adapter: ServiceFrontBusinessAdapter | null, kind: string): string | undefined {
  const department = adapter?.departmentForTicket?.(kind);
  return department ? businessDisplayText(department, "ticket.department") : undefined;
}

/** S2：h5/openid 演示直登开关（开发缺省 true；P1-11：生产环境缺省 false，必须显式配置渠道凭据或显式开启） */
export const DEMO_AUTH = (process.env.SERVICE_C_DEMO_AUTH ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
if (DEMO_AUTH) {
  console.warn("[service-c] SERVICE_C_DEMO_AUTH 已开启：h5/openid 演示直登可用（生产环境必须置 false 并配置渠道 code 交换凭据）");
}

/** C 端工作区解析仅在建立会话时走 owner 池，并逐个校验配置目标确实存在。 */
const validatedWorkspaceIds = new Set<string>();
async function cWorkspaceId(workspaceKey?: string): Promise<string> {
  let id: string;
  try {
    id = selectServiceWorkspaceId({
      fixedWorkspaceId: process.env.SERVICE_C_WORKSPACE_ID,
      workspaceMap: process.env.SERVICE_C_WORKSPACE_MAP,
      workspaceKey,
    });
  } catch (err) {
    if (err instanceof ServiceWorkspaceRoutingError) throw new ServiceHttpError(err.message, 503);
    throw err;
  }
  if (validatedWorkspaceIds.has(id)) return id;
  const found = await getOwnerPool().query(`SELECT id FROM workspaces WHERE id=$1 LIMIT 1`, [id]);
  if (!found.rows[0]?.id) {
    throw new ServiceHttpError("C 端配置的工作区不存在，请联系管理员检查站点映射", 503);
  }
  validatedWorkspaceIds.add(id);
  return id;
}

/* ---------------- 内存限流（60 次/分钟；Map 5 分钟 TTL 清扫防内存膨胀） ---------------- */
const buckets = new Map<string, { count: number; resetAt: number; touchedAt: number }>();
const BUCKET_TTL_MS = 5 * 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now || now - b.touchedAt > BUCKET_TTL_MS) buckets.delete(k);
  }
}, 60_000);
sweeper.unref?.();

function rateLimited(key: string, limit = 60): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000, touchedAt: now });
    return false;
  }
  b.count += 1;
  b.touchedAt = now;
  return b.count > limit;
}

/* ---------------- 鉴权中间件（Bearer c-token） ---------------- */
async function cAuth(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "未认证（缺少 c-token）" }, 401);
  const payload = await verifyCToken(auth.slice(7), cSecret());
  if (!payload) return c.json({ error: "c-token 无效或已过期" }, 401);
  if (rateLimited(`c:${payload.cUserId}`)) return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
  c.set("cAuth", payload);
  await next();
}

function authOf(c: Context): CTokenPayload {
  return c.get("cAuth") as CTokenPayload;
}

/** 解析 JSON body（非法/空 body → {}），属性经 Partial 访问、校验后使用 */
async function bodyOf<T>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 统一错误映射：ServiceHttpError → 语义状态码；其余 → 500 带 requestId（L9） */
function fail(c: Context, err: unknown, requestId: string): Response {
  if (err instanceof ServiceHttpError) return c.json({ error: err.message, requestId }, err.status as 400);
  if (err instanceof BusinessAdapterError) {
    return c.json({ error: err.message, requestId, code: err.code }, err.status as 400);
  }
  console.warn(`[service-c] 请求处理失败 requestId=${requestId}：`, err instanceof Error ? err.message : err);
  return c.json({ error: "服务内部错误", requestId }, 500);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ---------------- H6 契约序列化 ---------------- */

/** 工单状态 → webc 中文枚举（保留英文 status，提供 statusText） */
const TICKET_STATUS_TEXT: Record<string, string> = {
  created: "已受理",
  assigned: "已受理",
  processing: "处理中",
  done: "已完成",
  closed: "已关闭",
};

export function serializeTicket(t: Ticket): Ticket & { statusText: string } {
  return { ...t, statusText: TICKET_STATUS_TEXT[t.status] ?? "状态更新中" };
}

function unavailableBusinessAdapter(binding: BusinessAdapterBinding): ServiceFrontBusinessAdapter | null {
  if (binding.state === "ready") return binding.adapter;
  if (binding.state === "adapter-not-declared" || binding.state === "front-disabled") return null;
  throw new BusinessAdapterError("当前服务前台的业务能力暂不可用", 503, "BUSINESS_ADAPTER_UNAVAILABLE");
}

/** 工单受理推送：失败 catch 落库 status='failed' 不阻断响应（H2） */
interface DeliveryReceipt {
  state: "demo" | "pending" | "failed" | "sent";
  notificationId?: string;
}

async function pushAcceptedSafely(input: {
  workspaceId: string; cUserId: string; ticketId: string; title: string; dept: string | null;
}): Promise<DeliveryReceipt> {
  const payload = {
    ticketId: input.ticketId, title: input.title,
    text: `您的工单「${input.title}」已受理，${input.dept ?? "客服部"}将尽快跟进。`,
  };
  try {
    const result = await pushMessage({ workspaceId: input.workspaceId, cUserId: input.cUserId, kind: "ticket.accepted", payload });
    return {
      state: result.mock ? "demo" : result.delivered ? "sent" : "pending",
      notificationId: result.notificationId,
    };
  } catch (err) {
    console.warn(`[service-c] 受理推送失败，落 failed 通知（不阻断建单响应）：`, err instanceof Error ? err.message : err);
    try {
      const id = await serviceTx(input.workspaceId, async (client) => {
        const saved = await client.query(
          `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
           VALUES ($1,$2,'h5','ticket.accepted',$3,'mock','failed') RETURNING id`,
          [input.workspaceId, input.cUserId, JSON.stringify(payload)],
        );
        return String(saved.rows[0]?.id ?? "");
      });
      return { state: "failed", notificationId: id || undefined };
    } catch (err2) {
      console.warn(`[service-c] failed 通知落库也失败：`, err2 instanceof Error ? err2.message : err2);
      return { state: "failed" };
    }
  }
}

/** 建单链路（H2）：createTicket + assignTicket + 五元事件同一 serviceTx；幂等命中直接返回原单 */
async function createTicketFlow(input: {
  workspaceId: string; cUserId: string; channel: string; conversationId?: string;
  kind: string; title: string; payload: Record<string, unknown>; idempotencyKey: string; dept?: string;
}): Promise<{ ticket: Ticket; deduped: boolean; eventId?: string }> {
  return serviceTx(input.workspaceId, async (client, scope) => {
    const { ticket, deduped } = await createTicketOn(client, {
      workspaceId: input.workspaceId, cUserId: input.cUserId, conversationId: input.conversationId,
      kind: input.kind, title: input.title, payload: input.payload, idempotencyKey: input.idempotencyKey,
    });
    if (deduped) return { ticket, deduped: true }; // 幂等重放：不重复派单/推送/留痕
    const assigned = await assignTicketOn(client, {
      workspaceId: input.workspaceId, ticketId: ticket.id, dept: input.dept,
    });
    const event = await appendEventOn(client, scope, { id: input.cUserId, type: "human" }, {
      objectType: "ticket", objectId: ticket.id, action: "service.ticket.create",
      after: { kind: input.kind, title: input.title, dept: assigned.dept, channel: input.channel },
      channel: input.channel,
    });
    return { ticket: assigned, deduped: false, eventId: event.eventId };
  });
}

/* ---------------- 会话 ---------------- */
serviceGateway.post("/session", async (c) => {
  const requestId = randomUUID();
  try {
    const body = await bodyOf<{
      channel: string; openid: string; nickname: string; code: string; workspaceKey: string; entryToken: string;
    }>(c);
    if (!body.channel || !(CHANNELS as readonly string[]).includes(body.channel)) {
      return c.json({ error: `channel 须为 ${CHANNELS.join("/")}` }, 400);
    }
    const channel = body.channel as Channel;
    // S2：IP+channel 限流（60 次/分，防 openid 爆破）
    if (rateLimited(`session:${clientIp(c)}:${channel}`)) {
      return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
    }
    let openid: string;
    let trustedWorkspaceKey = body.workspaceKey;
    let authMode: "demo" | "channel" = "channel";
    if (channel === "h5") {
      if (DEMO_AUTH) {
        // 演示工作区允许当前会话内的匿名设备标识，但必须持续显示演示身份。
        if (!body.openid) return c.json({ error: "缺少演示会话标识" }, 400);
        openid = body.openid;
        authMode = "demo";
      } else {
        const entrySecret = h5EntrySecret();
        if (!entrySecret) {
          return c.json({
            error: "正式网页入口尚未配置签名验证",
            requestId,
            code: "H5_ENTRY_NOT_CONFIGURED",
          }, 503);
        }
        if (!body.entryToken) {
          return c.json({ error: "请从服务方提供的可信入口重新进入", requestId, code: "H5_ENTRY_REQUIRED" }, 401);
        }
        const entry = await verifyH5EntryToken(body.entryToken, entrySecret);
        if (!entry) {
          return c.json({ error: "网页入口已失效，请从服务方重新进入", requestId, code: "H5_ENTRY_INVALID" }, 401);
        }
        if (body.workspaceKey && body.workspaceKey !== entry.workspaceKey) {
          return c.json({ error: "网页入口与当前站点不匹配", requestId, code: "H5_ENTRY_SCOPE_MISMATCH" }, 403);
        }
        trustedWorkspaceKey = entry.workspaceKey;
        // 数据库只保存不可逆的身份别名，避免把外部 subject 直接释放到业务表与客户端。
        openid = `h5_${sha256(`${entry.appId}:${entry.subject}`).slice(0, 40)}`;
      }
    } else if (DEMO_AUTH && body.openid) {
      openid = body.openid; // 开发态：小程序渠道也允许 openid 直登
      authMode = "demo";
    } else {
      // wechat-mini / alipay：code → openid 交换 seam（无凭据 503 渠道未配置）
      if (!body.code) return c.json({ error: `缺少 code（${channel} 需经 code 换取 openid）` }, 400);
      const ex = await exchangeCodeForOpenid(channel, body.code);
      if (!ex.ok) return c.json({ error: `渠道未配置：${channel}（${ex.reason}）`, requestId }, 503);
      openid = ex.openid;
    }
    const workspaceId = await cWorkspaceId(trustedWorkspaceKey);
    const user = await resolveCUser({
      workspaceId,
      channel,
      openid,
      nickname: authMode === "demo" ? body.nickname : "已验证用户",
    });
    const token = await issueCToken({ workspaceId, cUserId: user.id, channel: user.channel, secret: cSecret() });
    return c.json({
      token,
      user: {
        ...user,
        authMode,
        ...(user.verified ? { identityMode: DEMO_AUTH ? "demo" : "verified" } : {}),
      },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 身份绑定（行业身份源由活动 Bundle 适配器提供） ---------------- */

serviceGateway.post("/identity/code", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const body = await bodyOf<{ phone: string }>(c);
    const phone = body.phone?.trim() ?? "";
    if (!/^1\d{10}$/.test(phone)) {
      return c.json({ error: "请输入有效的 11 位手机号", requestId, code: "INVALID_PHONE" }, 400);
    }
    if (!DEMO_AUTH) {
      return c.json({
        error: "当前租户尚未配置短信身份核验，请联系服务方人工绑定",
        requestId,
        code: "IDENTITY_PROVIDER_NOT_CONFIGURED",
      }, 503);
    }
    const binding = await resolveWorkspaceBusinessAdapter(authOf(c).workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    if (!adapter?.identity) {
      throw new BusinessAdapterError("当前服务前台未配置身份绑定能力", 503, "IDENTITY_ADAPTER_UNAVAILABLE");
    }
    const challenge = projectBusinessIdentityChallenge(await adapter.identity.requestCode(phone));
    return c.json({ ...challenge, requestId });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/identity/bind", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ phone: string; code: string }>(c);
    const phone = body.phone?.trim() ?? "";
    if (!/^1\d{10}$/.test(phone)) {
      return c.json({ error: "请输入有效的 11 位手机号", requestId, code: "INVALID_PHONE" }, 400);
    }
    if (!DEMO_AUTH) {
      return c.json({
        error: "当前租户尚未配置短信身份核验，请联系服务方人工绑定",
        requestId,
        code: "IDENTITY_PROVIDER_NOT_CONFIGURED",
      }, 503);
    }
    const binding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    if (!adapter?.identity) {
      throw new BusinessAdapterError("当前服务前台未配置身份绑定能力", 503, "IDENTITY_ADAPTER_UNAVAILABLE");
    }

    const result = await serviceTx(a.workspaceId, async (client, scope) => {
      const identity = await adapter.identity!.verifyCode(client, {
        workspaceId: a.workspaceId, cUserId: a.cUserId,
      }, { phone, code: body.code ?? "" });
      const subjectId = identity.subjectId;
      const current = await client.query<{ member_id: string | null; phone_hash: string | null }>(
        `SELECT member_id, phone_hash FROM c_users WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [a.workspaceId, a.cUserId],
      );
      if (!current.rows[0]) throw new ServiceHttpError("当前用户不存在，请重新登录", 404);
      if (current.rows[0].member_id && current.rows[0].member_id !== subjectId) {
        throw new ServiceHttpError("当前账号已绑定其他业务身份，请联系服务方人工处理", 409);
      }
      const phoneHash = sha256(phone);
      const idempotentReplay = current.rows[0].member_id === subjectId && current.rows[0].phone_hash === phoneHash;
      let eventId: string | undefined;
      if (!idempotentReplay) {
        await client.query(
          `UPDATE c_users SET member_id=$3, phone_hash=$4 WHERE workspace_id=$1 AND id=$2`,
          [a.workspaceId, a.cUserId, subjectId, phoneHash],
        );
        const event = await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
          objectType: "c_user",
          objectId: a.cUserId,
          action: "service.identity.bind",
          after: { subjectId, demo: identity.demo, adapterId: adapter.id },
          channel: a.channel,
        });
        eventId = event.eventId;
      }
      return { subjectId, demo: identity.demo, idempotentReplay, eventId };
    });
    const user = await getCUser(a.workspaceId, a.cUserId);
    if (!user) throw new ServiceHttpError("身份绑定已记录，但用户回读失败", 500);
    return c.json({
      user: { ...user, authMode: DEMO_AUTH ? "demo" : "channel", identityMode: result.demo ? "demo" : "verified" },
      receipt: {
        requestId,
        state: "bound",
        resourceId: result.subjectId,
        idempotentReplay: result.idempotentReplay,
        demo: result.demo,
        ...(result.eventId ? { eventId: result.eventId } : {}),
      },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 对话 ---------------- */
serviceGateway.post("/chat", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      conversationId: string; text: string; confirmTicket: boolean; idempotencyKey: string;
      ticketDraft: { kind: string; title: string; payload: Record<string, unknown> };
    }>(c);
    if (!body.text?.trim()) return c.json({ error: "缺少 text" }, 400);
    if (body.text.length > 2000) return c.json({ error: "text 超长（≤2000 字符）" }, 400);

    const businessBinding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const businessAdapter = businessBinding.state === "ready" ? businessBinding.adapter : null;
    const r = await handleMessage({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel,
      text: body.text.trim(), conversationId: body.conversationId,
      businessAdapter,
    });

    // 业务查询工具：执行适配器并渲染契约卡片（H6：{kind:'order'|'member'|'catalog', data}）
    const cards: Array<{ kind: "order" | "member" | "catalog"; data: object }> = [];
    let answer = r.answer;
    if (r.toolCall) {
      if (r.toolCall.tool === "query_ticket") {
        const requestedId = typeof r.toolCall.params.ticketId === "string" ? r.toolCall.params.ticketId : null;
        const owned = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
        const ticket = requestedId ? owned.find((item) => item.id === requestedId) ?? null : owned[0] ?? null;
        answer = ticket
          ? `您的工单「${ticket.title}」当前状态：${TICKET_STATUS_TEXT[ticket.status] ?? "状态更新中"}，${ticket.dept ?? "相关团队"}正在跟进。`
          : "暂未查到您的工单记录。";
      } else {
        if (!businessAdapter) {
          throw new BusinessAdapterError("当前服务前台未开通此项业务查询", 503, "BUSINESS_ADAPTER_UNAVAILABLE");
        }
        const user = await getCUser(a.workspaceId, a.cUserId);
        const data = await runBusinessTool(businessAdapter, r.toolCall.tool as BusinessTool, {
          workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
        });
        if (data.bindRequired) {
          answer = data.hint ?? "请先完成身份绑定后再查询。";
        } else if (r.toolCall.tool === "query_order") {
          const orders = (data as BusinessOrderResult).orders;
          for (const order of orders) cards.push({ kind: "order", data: order });
        } else if (r.toolCall.tool === "query_member") {
          const member = (data as BusinessMemberResult).member;
          if (member) cards.push({ kind: "member", data: { ...member, demo: member.demo ?? data.demo } });
        } else if (r.toolCall.tool === "query_catalog") {
          const catalog = data as BusinessCatalogResult;
          cards.push({
            kind: "catalog",
            data: { cardTitle: catalog.cardTitle, items: catalog.items, demo: catalog.demo },
          });
        }
      }
    }

    // 工单草稿确认：confirmTicket:true → 服务端幂等键 + 同事务建单/派单/五元事件（H2）
    let ticket: (Ticket & { statusText: string }) | null = null;
    let ticketReceipt: Record<string, unknown> | null = null;
    let deduped = false;
    const draft = body.confirmTicket ? (body.ticketDraft ?? r.ticketDraft) : undefined; // 客户端显式回传的草稿优先于本轮新产生的兜底草稿
    if (draft) {
      const idempotencyKey = body.idempotencyKey ?? `chat:${r.conversationId}:${sha256(body.text.trim()).slice(0, 16)}`;
      const flow = await createTicketFlow({
        workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: r.conversationId,
        kind: draft.kind, title: draft.title.slice(0, 120), payload: draft.payload ?? {}, idempotencyKey,
        dept: projectedDepartment(businessAdapter, draft.kind),
      });
      deduped = flow.deduped;
      const delivery = !flow.deduped
        ? await pushAcceptedSafely({
          workspaceId: a.workspaceId, cUserId: a.cUserId,
          ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
        })
        : undefined;
      ticket = serializeTicket(flow.ticket);
      ticketReceipt = {
        requestId,
        state: "accepted",
        resourceId: flow.ticket.id,
        idempotentReplay: flow.deduped,
        ...(flow.eventId ? { eventId: flow.eventId } : {}),
        ...(delivery ? { delivery } : {}),
      };
    }

    return c.json({
      conversationId: r.conversationId,
      intent: r.intent,
      answer,
      confidence: r.confidence,
      citations: r.citations,
      cards,
      ticket,
      ...(ticketReceipt ? { receipt: ticketReceipt } : {}),
      ...(deduped ? { deduped: true } : {}),
      ticketDraft: r.ticketDraft ?? null,
      latencyMs: r.latencyMs,
      ...(r.mock ? { mock: true } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 行业业务查询（只消费已验证活动 Bundle 投影） ---------------- */
serviceGateway.get("/orders", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const binding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    if (!adapter) return c.json({ orders: [], demo: false, available: false });
    const user = await getCUser(a.workspaceId, a.cUserId);
    const data = await runBusinessTool(adapter, "query_order", {
      workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
    }) as BusinessOrderResult;
    return c.json({
      orders: data.orders,
      demo: data.demo,
      available: true,
      ...(data.bindRequired ? { bindRequired: true, hint: data.hint } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/member", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const binding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    if (!adapter) {
      return c.json({ title: "权益信息不可用", benefits: [], demo: false, available: false });
    }
    const user = await getCUser(a.workspaceId, a.cUserId);
    const data = await runBusinessTool(adapter, "query_member", {
      workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
    }) as BusinessMemberResult;
    if (data.bindRequired || !data.member) {
      return c.json({
        title: "身份尚未绑定", benefits: [], demo: data.demo,
        available: true, bindRequired: true, hint: data.hint,
      });
    }
    return c.json({ ...data.member, demo: data.member.demo ?? data.demo, available: true });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 工单 ---------------- */
const TICKET_KINDS = ["delivery", "repair", "complaint", "other", "service_request", "consult"] as const;

serviceGateway.post("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      kind: string; title: string; payload: Record<string, unknown>;
      conversationId: string; idempotencyKey: string;
    }>(c);
    if (!body.kind || !body.title?.trim()) {
      return c.json({ error: "请选择工单类型并填写标题", requestId, code: "INVALID_TICKET" }, 400);
    }
    // M9 输入约束：kind 白名单 / title≤120 / payload JSON≤10KB
    if (!(TICKET_KINDS as readonly string[]).includes(body.kind)) {
      return c.json({ error: "暂不支持该工单类型", requestId, code: "INVALID_TICKET_KIND" }, 400);
    }
    const title = body.title.trim();
    if (title.length > 120) return c.json({ error: "工单标题不能超过 120 个字符", requestId }, 400);
    const payload = body.payload ?? {};
    if (JSON.stringify(payload).length > 10 * 1024) return c.json({ error: "工单补充信息过长", requestId }, 400);
    // H2：客户端传入幂等键优先，否则服务端强制生成（重放安全）
    const idempotencyKey = body.idempotencyKey
      ?? `ticket:${a.cUserId}:${sha256(`${body.kind}|${title}|${JSON.stringify(payload)}`).slice(0, 16)}`;
    const businessBinding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const businessAdapter = businessBinding.state === "ready" ? businessBinding.adapter : null;

    const flow = await createTicketFlow({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: body.conversationId,
      kind: body.kind, title, payload, idempotencyKey,
      dept: projectedDepartment(businessAdapter, body.kind),
    });
    const delivery = flow.deduped
      ? undefined
      : await pushAcceptedSafely({
          workspaceId: a.workspaceId, cUserId: a.cUserId,
          ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
        });
    return c.json({
      ticket: serializeTicket(flow.ticket),
      receipt: {
        requestId,
        state: "accepted",
        resourceId: flow.ticket.id,
        idempotentReplay: flow.deduped,
        ...(flow.eventId ? { eventId: flow.eventId } : {}),
        ...(delivery ? { delivery } : {}),
      },
      ...(flow.deduped ? { idempotentReplay: true } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const tickets = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ tickets: tickets.map(serializeTicket) });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets/:id", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const ticket = await getTicket(a.workspaceId, String(c.req.param("id")));
    if (!ticket || ticket.cUserId !== a.cUserId) return c.json({ error: "工单不存在", requestId }, 404);
    const timeline = await ticketTimeline({ workspaceId: a.workspaceId, ticketId: ticket.id });
    // H6：detail 归一为字符串（webc TimelineItem.detail: string）
    const items = timeline.map((e) => ({
      action: e.action,
      actorType: e.actorType,
      actorId: e.actorId,
      detail: typeof e.detail === "string" ? e.detail : String((e.detail as Record<string, unknown>).note ?? JSON.stringify(e.detail)),
      createdAt: e.createdAt,
    }));
    return c.json({ ticket: serializeTicket(ticket), timeline: items });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/tickets/:id/rate", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ score: number; comment: string }>(c);
    if (!body.score || body.score < 1 || body.score > 5) {
      return c.json({ error: "请选择 1 至 5 星评分", requestId, code: "INVALID_RATING" }, 400);
    }
    const score = body.score;
    // L9：仅 done 可评且只可评一次（rateTicket 内状态机/幂等断言，409/404 语义）
    const result = await serviceTx(a.workspaceId, async (client, scope) => {
      const ticket = await rateTicketOn(client, {
        workspaceId: a.workspaceId, ticketId: String(c.req.param("id")), cUserId: a.cUserId,
        score, comment: body.comment,
      });
      const event = await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
        objectType: "ticket", objectId: ticket.id, action: "service.ticket.rate",
        after: { score, comment: body.comment ?? null }, channel: a.channel,
      });
      return { ticket, eventId: event.eventId };
    });
    return c.json({
      ticket: serializeTicket(result.ticket),
      receipt: { requestId, state: "recorded", resourceId: result.ticket.id, eventId: result.eventId },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 推送箱 ---------------- */
serviceGateway.get("/notifications", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const notifications = await listNotifications({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ notifications });
  } catch (err) {
    return fail(c, err, requestId);
  }
});
