/**
 * stability/slow-lane —— noisy neighbor 慢车道（PRD V3.0 §20.1 计算隔离）
 *
 * 流处理器消费者组按租户哈希分片；单租户事件速率超配额 10 倍 →
 * 该租户流量切入"慢车道"（独立低优先级队列），其他租户车道不受阻。
 */

export interface TenantRateQuota { tenantId: string; quotaPerMin: number }

interface RateWindow { count: number; windowStart: number }

export class SlowLaneRouter {
  private rates = new Map<string, RateWindow>();
  private slowLane = new Set<string>();

  constructor(
    private quotas: Map<string, number>, // tenantId → quotaPerMin
    private opts: { factor?: number; windowMs?: number; now?: () => number } = {},
  ) {}

  static fromQuotas(list: TenantRateQuota[], opts?: { factor?: number; windowMs?: number; now?: () => number }): SlowLaneRouter {
    return new SlowLaneRouter(new Map(list.map((q) => [q.tenantId, q.quotaPerMin])), opts);
  }

  /** 事件路由判定：返回 true=该租户应走慢车道 */
  route(tenantId: string): boolean {
    const now = (this.opts.now ?? Date.now)();
    const window = this.opts.windowMs ?? 60_000;
    const w = this.rates.get(tenantId) ?? { count: 0, windowStart: now };
    if (now - w.windowStart >= window) { w.count = 0; w.windowStart = now; }
    w.count += 1;
    this.rates.set(tenantId, w);

    const quota = this.quotas.get(tenantId) ?? 0;
    const factor = this.opts.factor ?? 10;
    if (quota > 0 && w.count > quota * factor) this.slowLane.add(tenantId);
    else if (quota > 0 && w.count <= quota) this.slowLane.delete(tenantId); // 回落即恢复
    return this.slowLane.has(tenantId);
  }

  isInSlowLane(tenantId: string): boolean { return this.slowLane.has(tenantId); }
  slowLaneTenants(): string[] { return [...this.slowLane]; }
}
