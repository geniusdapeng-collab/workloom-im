/**
 * hotupdate/rollout —— 灰度发布状态机（PRD V3.0 §19.2）
 *
 * 批次：内部租户 → 5% → 50% → 100%（R-PL5 每批必审）；
 * 每批次观察期 24h：自动采集 错误率/工单密度/围栏拦截异常/积分消耗异常，
 * 超阈值自动暂停并回滚上一批次（快照恢复 bundle_snapshots）；
 * 回滚本身也走审批（防止误回滚）。
 */

export type BatchName = "internal" | "5%" | "50%" | "100%";
export const BATCH_ORDER: BatchName[] = ["internal", "5%", "50%", "100%"];

export interface ObservationMetrics {
  errorRate: number;        // 批内租户错误率
  ticketDensityDelta: number; // 工单密度相对基线变化（+0.4 = +40%）
  fenceAnomalies: number;   // 围栏拦截异常次数
  creditAnomalies: number;  // 积分消耗异常次数
}

export interface RolloutThresholds {
  maxErrorRate: number;          // 默认 0.01
  maxTicketDensityDelta: number; // 默认 +0.3
  maxFenceAnomalies: number;     // 默认 3
  maxCreditAnomalies: number;    // 默认 1
}

export const DEFAULT_THRESHOLDS: RolloutThresholds = {
  maxErrorRate: 0.01, maxTicketDensityDelta: 0.3, maxFenceAnomalies: 3, maxCreditAnomalies: 1,
};

export type RolloutState =
  | { phase: "awaiting_approval"; batch: BatchName }     // R-PL5 人审
  | { phase: "observing"; batch: BatchName; startedAt: number }
  | { phase: "paused"; batch: BatchName; reason: string } // 超阈值自动暂停
  | { phase: "rolled_back"; toSnapshot: string; reason: string }
  | { phase: "completed" };

export class RolloutController {
  private state: RolloutState;
  private batchIdx = 0;

  constructor(
    private bundleVersion: string,
    private thresholds: RolloutThresholds = DEFAULT_THRESHOLDS,
    private opts: { observationMs?: number; now?: () => number } = {},
  ) {
    this.state = { phase: "awaiting_approval", batch: BATCH_ORDER[0] };
  }

  getState(): RolloutState { return this.state; }
  currentBatch(): BatchName | null {
    return this.state.phase === "completed" || this.state.phase === "rolled_back" ? null : BATCH_ORDER[this.batchIdx];
  }

  /** R-PL5 审批通过 → 进入观察期 */
  approve(): void {
    if (this.state.phase !== "awaiting_approval") throw new Error(`当前状态 ${this.state.phase} 不可批准`);
    const batch = (this.state as { batch: BatchName }).batch;
    this.state = { phase: "observing", batch, startedAt: (this.opts.now ?? Date.now)() };
  }

  /** 观察期指标喂入：超阈值 → 自动暂停（不等人，熔断优先于审批） */
  observe(m: ObservationMetrics): { ok: boolean; breaches: string[] } {
    if (this.state.phase !== "observing") return { ok: true, breaches: [] };
    const t = this.thresholds;
    const breaches: string[] = [];
    if (m.errorRate > t.maxErrorRate) breaches.push(`错误率 ${(m.errorRate * 100).toFixed(2)}% > ${(t.maxErrorRate * 100).toFixed(2)}%`);
    if (m.ticketDensityDelta > t.maxTicketDensityDelta) breaches.push(`工单密度 +${(m.ticketDensityDelta * 100).toFixed(0)}% > +${(t.maxTicketDensityDelta * 100).toFixed(0)}%`);
    if (m.fenceAnomalies > t.maxFenceAnomalies) breaches.push(`围栏拦截异常 ${m.fenceAnomalies} > ${t.maxFenceAnomalies}`);
    if (m.creditAnomalies > t.maxCreditAnomalies) breaches.push(`积分消耗异常 ${m.creditAnomalies} > ${t.maxCreditAnomalies}`);
    if (breaches.length > 0) {
      const batch = (this.state as { batch: BatchName }).batch;
      this.state = { phase: "paused", batch, reason: breaches.join("；") };
      return { ok: false, breaches };
    }
    return { ok: true, breaches };
  }

  /** 观察期满（24h）且指标正常 → 申请下一批审批；100% 批满 → 完成 */
  advanceIfObservationPassed(): void {
    if (this.state.phase !== "observing") return;
    const now = (this.opts.now ?? Date.now)();
    const started = (this.state as { startedAt: number }).startedAt;
    if (now - started < (this.opts.observationMs ?? 24 * 3_600_000)) return;
    this.batchIdx += 1;
    if (this.batchIdx >= BATCH_ORDER.length) {
      this.state = { phase: "completed" };
    } else {
      this.state = { phase: "awaiting_approval", batch: BATCH_ORDER[this.batchIdx] };
    }
  }

  /** 回滚上一批次（快照恢复；回滚本身也走审批——本方法只在审批通过后调用） */
  rollbackApproved(toSnapshot: string, reason: string): void {
    this.state = { phase: "rolled_back", toSnapshot, reason };
  }

  version(): string { return this.bundleVersion; }
}
