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

  /** 整批处理：任一事件含白名单外字段 → 拒整批并告警（宁拒不错收） */
  ingestBatch(tenantId: string, events: ReportEvent[]): IngestVerdict[] {
    const now = (this.opts.now ?? Date.now)();
    // ① 白名单校验（整批）
    for (const e of events) {
      const extra = Object.keys(e).filter((k) => !(REPORT_FIELD_WHITELIST as readonly string[]).includes(k));
      if (extra.length > 0) {
        this.opts.onWhitelistBreach?.(tenantId, extra);
        return events.map(() => ({ action: "rejected", reason: `字段白名单外：${extra.join(",")}` } as IngestVerdict));
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
