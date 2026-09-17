/**
 * streams/anomaly-detector —— 异常扣费检测器（PRD V3.0 §16.3 / §18.4 账务检项域）
 *
 * 规则：单租户扣费速率超基线 3σ，或单笔超阈值 → credit.anomaly 事件 → 必人审（围栏 R-PL1）。
 * 基线为滚动窗口均值/方差（Welford 在线算法，无状态重启后可从窗口重放缓存重建）。
 */
import type { CreditEvent } from "./credit-balance.js";

export interface Anomaly {
  tenantId: string;
  kind: "rate_3sigma" | "single_over_threshold";
  observed: number;
  baselineMean: number;
  baselineStd: number;
  detectedAt: number;
}

interface Window { n: number; mean: number; m2: number; bucketSpend: Map<number, number> }

export class CreditAnomalyDetector {
  private windows = new Map<string, Window>();
  /** 单笔阈值（分），超过即必审 */
  constructor(
    private opts: { singleTxThreshold: number; minSamples?: number; bucketMs?: number; now?: () => number },
  ) {}

  /** 逐事件喂入；命中规则返回 Anomaly（调用方据此发 credit.anomaly 事件走 R-PL1） */
  observe(e: CreditEvent): Anomaly | null {
    if (e.type !== "model.call") return null;
    const now = (this.opts.now ?? Date.now)();
    const spend = e.model_trace?.credits ?? 0;
    const w = this.windows.get(e.tenant_id) ?? { n: 0, mean: 0, m2: 0, bucketSpend: new Map() };
    this.windows.set(e.tenant_id, w);

    // 规则二：单笔超阈值（无基线依赖，冷启动即生效）
    if (spend > this.opts.singleTxThreshold) {
      return this.hit(e.tenant_id, "single_over_threshold", spend, w, now);
    }

    // 规则一：窗口扣费速率超基线 3σ（样本不足不告警，避免冷启动误报）
    const bucket = Math.floor(now / (this.opts.bucketMs ?? 60_000));
    const cur = (w.bucketSpend.get(bucket) ?? 0) + spend;
    w.bucketSpend.set(bucket, cur);
    const minSamples = this.opts.minSamples ?? 30;
    if (w.n >= minSamples) {
      const std = Math.sqrt(w.m2 / w.n);
      if (std > 0 && cur > w.mean + 3 * std) {
        return this.hit(e.tenant_id, "rate_3sigma", cur, w, now);
      }
    }
    // 用上一完整窗口更新基线（当前窗口不进基线，防止自证）
    for (const [b, v] of w.bucketSpend) {
      if (b < bucket) {
        w.n += 1;
        const d = v - w.mean;
        w.mean += d / w.n;
        w.m2 += d * (v - w.mean);
        w.bucketSpend.delete(b);
      }
    }
    return null;
  }

  private hit(tenant: string, kind: Anomaly["kind"], observed: number, w: Window, now: number): Anomaly {
    return { tenantId: tenant, kind, observed, baselineMean: w.mean, baselineStd: w.n > 0 ? Math.sqrt(w.m2 / w.n) : 0, detectedAt: now };
  }
}
