/**
 * stability/circuit-breaker —— 模型供应链熔断器（PRD V3.0 §20.3 防线三）
 *
 * provider 熔断器：失败率 >50%/1min → 断开 30s → 半开试探（成功即闭合，失败再断开）。
 * 与现状降级链联动：主 provider 熔断 → 自动走链到备用；全链熔断 → 该档位任务排队 + 平台 P0。
 * 峰谷窗口、档位策略全部配置化热更新（第十九章 asset-cache）。
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  failureRateThreshold?: number; // 默认 0.5（§20.3：>50%/1min）
  windowMs?: number;             // 统计窗口，默认 60s
  minCalls?: number;             // 窗口内最小调用数（低流量不误断）
  openDurationMs?: number;       // 断开时长，默认 30s
  now?: () => number;
}

interface Call { ts: number; ok: boolean }

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private calls: Call[] = [];
  private openedAt = 0;

  constructor(private opts: BreakerOptions = {}) {}

  /** 是否允许本次调用通过 */
  allow(): boolean {
    const now = (this.opts.now ?? Date.now)();
    if (this.state === "open") {
      if (now - this.openedAt >= (this.opts.openDurationMs ?? 30_000)) {
        this.state = "half_open"; // 半开试探
        return true;
      }
      return false;
    }
    return true;
  }

  /** 记录一次调用结果（滑动窗口统计） */
  record(ok: boolean): void {
    const now = (this.opts.now ?? Date.now)();
    if (this.state === "half_open") {
      if (ok) { this.state = "closed"; this.calls = []; }
      else { this.state = "open"; this.openedAt = now; }
      return;
    }
    this.calls.push({ ts: now, ok });
    const window = this.opts.windowMs ?? 60_000;
    this.calls = this.calls.filter((c) => now - c.ts <= window);
    const min = this.opts.minCalls ?? 10;
    if (this.calls.length >= min) {
      const fails = this.calls.filter((c) => !c.ok).length;
      if (fails / this.calls.length > (this.opts.failureRateThreshold ?? 0.5)) {
        this.state = "open";
        this.openedAt = now;
      }
    }
  }

  getState(): BreakerState { return this.state; }
}

/**
 * 降级链：按序尝试 provider，熔断的跳过；全链熔断 → 排队 + P0。
 * 返回选中的 provider，或 null（调用方发 model.degraded 事件 + P0）。
 */
export function pickProvider(chain: Array<{ name: string; breaker: CircuitBreaker }>): string | null {
  for (const p of chain) if (p.breaker.allow()) return p.name;
  return null;
}

/**
 * 非核心路径降级预案表（§20.3：预案化，按压力自动或人工触发；核心路径永不降级）
 */
export const DEGRADATION_PLAYBOOK = {
  dashboard:        { degraded: "读 5 分钟前快照", core: false },
  health_score:     { degraded: "读昨日值", core: false },
  kb_recommend:     { degraded: "返回静态热门", core: false },
  push:             { degraded: "降级轮询", core: false },
  ingest_ack:       { degraded: "永不降级", core: true },  // 上报签收
  event_store:      { degraded: "永不降级", core: true },  // 事件落库
  approval:         { degraded: "永不降级", core: true },  // 审批
  credit_deduct:    { degraded: "永不降级", core: true },  // 扣费
} as const;

/** 依赖爆炸半径限定（§20.3）：任一依赖故障时的系统行为 */
export const BLAST_RADIUS = {
  redis_down:       ["限流退化为单机桶", "投影回源 PG", "降级不宕机"],
  clickhouse_down:  ["看板暂停更新", "读 PG 副本兜底"],
  jetstream_down:   ["写线不受影响（事件已落库，relay 续传）", "推送降级轮询"],
} as const;
