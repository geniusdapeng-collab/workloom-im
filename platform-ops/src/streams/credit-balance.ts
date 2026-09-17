/**
 * streams/credit-balance —— 积分三池余额实时投影（PRD V3.0 §16.3）
 *
 * model.call / credits.grant / credits.purchase 事件 → Redis 余额投影 HSET bal:{tenant} {pool} {amount}
 * 一致性纪律（§16.3 不可妥协）：
 *   - 扣费判定（余额是否足够）读 PG 投影（强一致路径）——钱的路径不走缓存；
 *   - 监控/展示/客服查账读 Redis 投影（最终一致，s 级，99% 命中 <1ms，未命中回源 PG 并回填）。
 */

export type CreditPool = "gift" | "booster" | "principal"; // 赠送池/加油包池/本金池
export const CREDIT_POOLS: CreditPool[] = ["gift", "booster", "principal"];

export interface CreditEvent {
  event_id: string;
  tenant_id: string;
  type: "credits.grant" | "credits.purchase" | "model.call";
  pool?: CreditPool;
  amount?: number;               // grant/purchase：入账额
  model_trace?: { credits: number }; // model.call：出账（先扣先到期由扣费链路决定，投影只记总量）
}

/** Redis 语义的最小接口（生产：ioredis；起步/测试：内存） */
export interface BalanceCache {
  hincrby(key: string, field: string, delta: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, number>>;
}

export class MemoryBalanceCache implements BalanceCache {
  private data = new Map<string, Map<string, number>>();
  async hincrby(key: string, field: string, delta: number): Promise<number> {
    if (!this.data.has(key)) this.data.set(key, new Map());
    const h = this.data.get(key)!;
    const v = (h.get(field) ?? 0) + delta;
    h.set(field, v);
    return v;
  }
  async hgetall(key: string): Promise<Record<string, number>> {
    return Object.fromEntries(this.data.get(key) ?? new Map());
  }
}

const balKey = (tenant: string) => `bal:${tenant}`; // §20.1 缓存隔离：键命名空间按租户

/** 投影写（幂等：增量式 HINCRBY，重放同批事件由 projector 的 event_id 去重保护） */
export async function applyCreditEvents(cache: BalanceCache, events: CreditEvent[]): Promise<void> {
  // 微批合并：同 tenant 多条事件合并为一次写（§16.3 写放大控制）
  const delta = new Map<string, Map<CreditPool, number>>();
  for (const e of events) {
    if (!delta.has(e.tenant_id)) delta.set(e.tenant_id, new Map());
    const d = delta.get(e.tenant_id)!;
    if (e.type === "model.call") {
      const out = e.model_trace?.credits ?? 0;
      d.set("principal", (d.get("principal") ?? 0) - out); // 出账按扣费顺序聚合到总量（三池扣减序由扣费链路保证）
    } else {
      const pool = e.pool ?? "gift";
      d.set(pool, (d.get(pool) ?? 0) + (e.amount ?? 0));
    }
  }
  for (const [tenant, pools] of delta) {
    for (const [pool, d] of pools) await cache.hincrby(balKey(tenant), pool, d);
  }
}

/**
 * 余额读（cache-aside）：99% 命中缓存；未命中回源 PG 投影并回填。
 * 注意：本函数只服务监控/展示/查账作答；扣费判定永远走 PG 强一致路径（不进这里）。
 */
export async function readBalance(
  cache: BalanceCache,
  tenant: string,
  pgFallback: () => Promise<Record<string, number>>,
): Promise<{ pools: Record<string, number>; source: "cache" | "pg" }> {
  const hit = await cache.hgetall(balKey(tenant));
  if (Object.keys(hit).length > 0) return { pools: hit, source: "cache" };
  const fromPg = await pgFallback();
  for (const [pool, v] of Object.entries(fromPg)) await cache.hincrby(balKey(tenant), pool, v);
  return { pools: fromPg, source: "pg" };
}
