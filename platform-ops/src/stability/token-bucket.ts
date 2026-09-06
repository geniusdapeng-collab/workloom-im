/**
 * stability/token-bucket —— 四级令牌桶（PRD V3.0 §20.2 防线二）
 *
 * L1 边缘：上报/公开网关租户级桶（超额 429 + 退避；客户侧 outbox 积压补投不丢数据）
 * L2 服务：成员级 + 租户级（排队 + 降级响应，读请求回退缓存快照）
 * L3 模型：provider×档位并发池 + 租户积分熔断（现状）
 * L4 事件：gateway 写入口全局 TPS 保护阀——非关键事件采样降级，关键事件（账务/审批/工单）永不采样
 *
 * 原则：限流宁可拒绝，不可雪崩；被限的必须可恢复（补投/重试），不许静默丢失。
 */

export interface BucketOptions {
  capacity: number;      // 桶容量（突发上限）
  refillPerSec: number;  // 匀速补充速率
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private opts: BucketOptions) {
    this.tokens = opts.capacity;
    this.lastRefill = (opts.now ?? Date.now)();
  }

  private refill(): void {
    const now = (this.opts.now ?? Date.now)();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsed * this.opts.refillPerSec);
    this.lastRefill = now;
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }

  /** 预计可放行等待时长（429 响应的 Retry-After 指引） */
  retryAfterMs(n = 1): number {
    this.refill();
    const deficit = n - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / this.opts.refillPerSec) * 1000);
  }

  available(): number { this.refill(); return Math.floor(this.tokens); }
}

/** L4 事件写入口保护阀：全局 TPS 阀 + 关键事件白名单（永不采样） */
export const CRITICAL_EVENT_TYPES = ["credits.", "approval.", "ticket.", "fence."] as const;

export class WriteIngressValve {
  constructor(private bucket: TokenBucket, private sampleRate = 1.0, private rand: () => number = Math.random) {}

  /**
   * 返回 true=放行入库；false=采样丢弃。
   * 纪律（§20.2 审计修订）：
   * - 关键事件（账务/审批/工单/围栏）**永不采样、永不拒绝**——其背压由上游队列深度承载（§17.3 削峰靠队列不靠丢消息）；
   * - 非关键事件（遥测类）：先占桶；桶空时按 sampleRate 采样放行（降级采样），其余丢弃。
   */
  admit(eventType: string): boolean {
    const critical = CRITICAL_EVENT_TYPES.some((p) => eventType.startsWith(p));
    if (critical) return true; // 审计修复：旧实现桶空时误拒关键事件，违反"关键事件永不采样"
    if (this.bucket.tryTake(1)) return true;
    return this.rand() < this.sampleRate; // 审计修复：旧实现采样路径二次占桶必失败，采样率形同虚设
  }
}
