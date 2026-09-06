/**
 * gateway/ingest-gateway —— 事件上报通道（PRD V3.0 §17.2）
 *
 * 客户实例 → 平台 的唯一写入口前置处理链：
 *   实例证书鉴权 → 租户级限流（令牌桶，超额 429 + 退避）→ 字段级脱敏白名单校验
 *   （白名单外字段直接拒绝整批并告警——数据红线 R-PL4 的工程执行面）
 *   → 幂等签收（event_id 去重，重复返回"已签收"不入库）→ 落库（经 gateway 三段瀑布）。
 * 时钟纪律：双时间戳（客户端时间展示/审计 + 服务端时间排序/判定），乱序容忍窗口 5min，
 * 超时事件走迟到通道单独标记（§17.2）。
 */
import { TokenBucket } from "../stability/token-bucket.js";

/** §9.2 字段级白名单：平台侧只接收这些字段（客户原始经营数据不出库） */
export const REPORT_FIELD_WHITELIST = [
  "event_id", "tenant_id", "instance_id", "type", "occurred_at", "version",
  "metrics", "error_code", "ticket_id", "status", "level", "summary",
] as const;

/**
 * 通道化白名单（审计修订）：不同上报通道的数据敏感度不同，白名单按通道分 profile——
 * - meta（默认）：客户实例元数据通道（§18.6 巡检下沉），严格白名单，客户业务字段一律拒批；
 * - internal：平台内部事件通道（同机房/同 VPC 服务间，如积分/工单事件），携带业务字段为合法。
 * 原单一白名单会把 credits.grant（pool/amount）等内部合法事件误拒整批。
 */
export const CHANNEL_PROFILES = {
  meta: REPORT_FIELD_WHITELIST,
  internal: [
    ...REPORT_FIELD_WHITELIST,
    "pool", "amount", "model_trace", "payload", "prev_hash", "hash", "assignee", "intent", "priority",
  ],
} as const;
export type IngestChannel = keyof typeof CHANNEL_PROFILES;

export interface ReportEvent {
  event_id: string;
  tenant_id: string;
  type: string;
  occurred_at: number; // 客户端时间（展示/审计）
  [k: string]: unknown;
}

export type IngestVerdict =
  | { action: "accept"; serverTs: number }
  | { action: "duplicate"; serverTs: number }        // 幂等签收：重复直接确认，不入库
  | { action: "late"; serverTs: number }              // 迟到通道：单独标记
  | { action: "rate_limited"; retryAfterMs: number }  // 429 + 退避指引
  | { action: "rejected"; reason: string };           // 白名单外字段：拒整批 + 告警

export class IngestGateway {
  private seen = new Set<string>(); // 幂等签收表（生产：UNIQUE(tenant_id,event_id) 约束 + 短期缓存）
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private opts: {
      perTenantRatePerMin?: number;
      disorderWindowMs?: number; // 乱序容忍窗口，默认 5min
      now?: () => number;
      onWhitelistBreach?: (tenantId: string, fields: string[]) => void; // 告警钩子（ops-signals）
    } = {},
  ) {}

  private bucketOf(tenant: string): TokenBucket {
    if (!this.buckets.has(tenant)) {
      this.buckets.set(tenant, new TokenBucket({
        capacity: this.opts.perTenantRatePerMin ?? 600,
        refillPerSec: (this.opts.perTenantRatePerMin ?? 600) / 60,
        now: this.opts.now,
      }));
    }
    return this.buckets.get(tenant)!;
  }

  /** 整批处理：任一事件含通道白名单外字段 → 拒整批并告警（宁拒不错收） */
  ingestBatch(tenantId: string, events: ReportEvent[], channel: IngestChannel = "meta"): IngestVerdict[] {
    const now = (this.opts.now ?? Date.now)();
    const whitelist = CHANNEL_PROFILES[channel] as readonly string[];
    // ① 白名单校验（整批，按通道 profile）
    for (const e of events) {
      const extra = Object.keys(e).filter((k) => !whitelist.includes(k));
      if (extra.length > 0) {
        this.opts.onWhitelistBreach?.(tenantId, extra);
        return events.map(() => ({ action: "rejected", reason: `字段白名单外(${channel})：${extra.join(",")}` } as IngestVerdict));
      }
    }
    // ② 逐条：限流 → 幂等 → 乱序
    return events.map((e) => this.ingestOne(tenantId, e, now));
  }

  private ingestOne(tenantId: string, e: ReportEvent, now: number): IngestVerdict {
    if (!this.bucketOf(tenantId).tryTake(1)) {
      return { action: "rate_limited", retryAfterMs: this.bucketOf(tenantId).retryAfterMs(1) };
    }
    const key = `${tenantId}:${e.event_id}`;
    if (this.seen.has(key)) return { action: "duplicate", serverTs: now };
    this.seen.add(key);
    const window = this.opts.disorderWindowMs ?? 5 * 60_000;
    if (now - e.occurred_at > window) return { action: "late", serverTs: now }; // 迟到通道：标记但仍入账
    return { action: "accept", serverTs: now };
  }

  /** 测试/对账用：签收表大小 */
  seenCount(): number { return this.seen.size; }
}
