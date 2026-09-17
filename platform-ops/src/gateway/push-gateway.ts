/**
 * gateway/push-gateway —— 状态变更推送网关（PRD V3.0 §17.5 / ADR-4）
 *
 * 设计要点：
 * - 订阅模型：客户端连接后声明订阅（本租户工单状态/审批待办/告警级别阈值）；
 *   推送匹配器按订阅过滤，单条事件只推给该看的租户（租户隔离延伸到推送层）。
 * - 推送内容：只推 事件ID+类型+摘要（<2KB），客户端拉详情走 tRPC——推送通道不承载业务数据明文。
 * - 降级：WS 断连/网关不可达 → 客户端自动回退现有轮询（5-30s）；平台侧 P0 告警同时走短信/电话通道。
 * - 连接注册表存 Redis（conn:{tenant}:{member} → gateway_id），网关无状态横向扩。
 *
 * 传输层可插拔：生产为 Hono + ws；本模块实现匹配/隔离/载荷纪律的纯逻辑，传输以接口注入（可测）。
 */

export type Topic = "ticket.status" | "approval.pending" | "alert" | "credits" | "bundle.version";

export interface Subscription {
  tenantId: string;
  memberId: string;
  topics: Topic[];
  /** 告警级别阈值：只推 >= 该级别的告警 */
  alertLevel?: "P0" | "P1" | "P2";
  /** 免打扰时段（移动端可选）："22:00-08:00" 格式，P0 除外 */
  quietHours?: string;
}

export interface PushEvent {
  eventId: string;
  tenantId: string;
  topic: Topic;
  level?: "P0" | "P1" | "P2";
  summary: string;
  occurredAt: number;
}

export interface PushFrame { event_id: string; topic: Topic; summary: string; ts: number }

export interface ConnectionRegistry {
  set(connId: string, sub: Subscription): Promise<void>;
  remove(connId: string): Promise<void>;
  byTenant(tenantId: string): Promise<Array<{ connId: string; sub: Subscription }>>;
}

export class MemoryConnectionRegistry implements ConnectionRegistry {
  private conns = new Map<string, Subscription>();
  async set(id: string, sub: Subscription): Promise<void> { this.conns.set(id, sub); }
  async remove(id: string): Promise<void> { this.conns.delete(id); }
  async byTenant(t: string): Promise<Array<{ connId: string; sub: Subscription }>> {
    return [...this.conns.entries()].filter(([, s]) => s.tenantId === t).map(([connId, sub]) => ({ connId, sub }));
  }
}

const LEVEL_ORDER = { P0: 0, P1: 1, P2: 2 } as const;
const MAX_PAYLOAD_BYTES = 2048; // §17.5：推送只承载 ID+类型+摘要

export class PushMatcher {
  constructor(private registry: ConnectionRegistry, private now: () => number = () => Date.now()) {}

  /** 匹配接收者（租户隔离 + 主题订阅 + 告警阈值 + 免打扰） */
  async match(ev: PushEvent): Promise<Array<{ connId: string; frame: PushFrame }>> {
    const candidates = await this.registry.byTenant(ev.tenantId); // 隔离：绝不跨租户扇出
    const out: Array<{ connId: string; frame: PushFrame }> = [];
    for (const { connId, sub } of candidates) {
      if (!sub.topics.includes(ev.topic)) continue;
      if (ev.topic === "alert" && sub.alertLevel && ev.level) {
        if (LEVEL_ORDER[ev.level] > LEVEL_ORDER[sub.alertLevel]) continue;
      }
      if (sub.quietHours && ev.level !== "P0" && inQuietHours(this.now(), sub.quietHours)) continue;
      const frame: PushFrame = { event_id: ev.eventId, topic: ev.topic, summary: ev.summary, ts: ev.occurredAt };
      const bytes = Buffer.byteLength(JSON.stringify(frame), "utf-8");
      if (bytes > MAX_PAYLOAD_BYTES) {
        // 载荷纪律：超长即截断摘要——推送通道永不承载业务数据明文
        frame.summary = frame.summary.slice(0, 256) + "…";
      }
      out.push({ connId, frame });
    }
    return out;
  }
}

/** 免打扰判定（"22:00-08:00" 跨零点窗口） */
export function inQuietHours(nowMs: number, window: string): boolean {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return false;
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 降级协议：WS 不可达时客户端回退轮询的参数（§17.5 / ADR-4 零改造成本降级路径） */
export function pollingFallback(topic: Topic): { intervalMs: number; endpoint: string } {
  switch (topic) {
    case "ticket.status":     return { intervalMs: 5_000,  endpoint: "/trpc/threads.poll" };
    case "approval.pending":  return { intervalMs: 10_000, endpoint: "/trpc/approvals.poll" };
    case "alert":             return { intervalMs: 15_000, endpoint: "/trpc/events.poll" };
    default:                  return { intervalMs: 30_000, endpoint: "/trpc/events.poll" };
  }
}
