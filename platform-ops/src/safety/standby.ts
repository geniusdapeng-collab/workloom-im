/**
 * safety/standby —— 主备切换机制（对焦方案 §5：主 + 温备，授权自动切换）
 *
 * 已对焦决策：P0 满足三条件（探针连续 3 分钟全断 + 备库健康 + 抢到 fencing 租约）即自动切换；
 * 备库带病时禁止切换（带病切换比不切更危险）；回切走灰度流程。
 *
 * 组件：fencing token 租约（脑裂防护）/ 合成探针 / 切换判定器 / 回切规划器。
 */

/* ---------------- fencing token（外部共识主租约，TTL 60s） ---------------- */

export interface FenceTokenStore {
  /** 尝试获取/续约主租约；返回当前持约人（CAS 语义：租约未过期时他人抢不到） */
  acquire(holder: string, ttlMs: number, now: number): { acquired: boolean; currentHolder: string; expiresAt: number };
  release(holder: string): void;
  currentHolder(): string | null;
}

export class MemoryFenceTokenStore implements FenceTokenStore {
  private holder: string | null = null;
  private expiresAt = 0;
  acquire(holder: string, ttlMs: number, now: number): { acquired: boolean; currentHolder: string; expiresAt: number } {
    if (this.holder === null || now > this.expiresAt || this.holder === holder) {
      this.holder = holder;
      this.expiresAt = now + ttlMs;
      return { acquired: true, currentHolder: holder, expiresAt: this.expiresAt };
    }
    return { acquired: false, currentHolder: this.holder, expiresAt: this.expiresAt };
  }
  release(holder: string): void {
    if (this.holder === holder) { this.holder = null; this.expiresAt = 0; }
  }
  currentHolder(): string | null { return this.holder; }
}

/* ---------------- 合成探针（synthetic probe） ---------------- */

export interface ProbeResult { ts: number; ok: boolean; latencyMs?: number }

export class ProbeTracker {
  private results: ProbeResult[] = [];
  constructor(private windowMs = 3 * 60_000) {}
  record(r: ProbeResult): void { this.results.push(r); }
  /** 窗口内连续失败判定（对焦判据：连续 3 分钟全断） */
  isTotalBlackout(now: number): boolean {
    const window = this.results.filter((r) => now - r.ts <= this.windowMs);
    return window.length >= 3 && window.every((r) => !r.ok);
  }
}

/* ---------------- 备库健康检查 ---------------- */

export interface StandbyHealth {
  replicationLagSec: number;   // 备库复制延迟（禁止切换阈值 60s）
  chainVerifyOk: boolean;      // 备库独立验链结果（备库数据持续被证明可用）
  eventMirrorLagMs: number;    // 事件流镜像延迟
}

export function standbyHealthy(h: StandbyHealth): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (h.replicationLagSec > 60) reasons.push(`备库复制延迟 ${h.replicationLagSec}s > 60s`);
  if (!h.chainVerifyOk) reasons.push("备库验链失败（数据不可信）");
  if (h.eventMirrorLagMs > 60_000) reasons.push(`事件镜像延迟 ${(h.eventMirrorLagMs / 1000).toFixed(0)}s > 60s`);
  return { ok: reasons.length === 0, reasons };
}

/* ---------------- 切换判定器 ---------------- */

export type SwitchDecision =
  | { action: "auto-switch"; reason: string }
  | { action: "manual-review"; reason: string }
  | { action: "forbid"; reasons: string[] }
  | { action: "hold" };

export interface SwitchInput {
  primaryBlackout: boolean;       // 探针连续 3 分钟全断
  primaryDegraded: boolean;       // 有响应但 SLO 全面崩溃（P1 人工通道）
  standby: StandbyHealth;
  fenceAcquired: boolean;         // 备系统是否抢到 fencing token
  now: number;
}

export function decideSwitch(input: SwitchInput): SwitchDecision {
  // 禁止切换优先：备库带病时，带病切换比不切更危险
  const health = standbyHealthy(input.standby);
  if (!health.ok && (input.primaryBlackout || input.primaryDegraded)) {
    return { action: "forbid", reasons: ["备库不健康，禁止切换，降级为本地抢修", ...health.reasons] };
  }
  // 自动切换（P0，对焦已授权：三条件齐备先斩后奏）
  if (input.primaryBlackout && health.ok && input.fenceAcquired) {
    return { action: "auto-switch", reason: "探针连续 3 分钟全断 + 备库健康 + 拿到 fencing 租约——自动提升备为主，电话+短信通知值班人" };
  }
  if (input.primaryBlackout && health.ok && !input.fenceAcquired) {
    return { action: "manual-review", reason: "主系统全断但 fencing 租约未获取（疑似脑裂风险），需人工确认" };
  }
  // 人工裁决窗（P1：未全断但全面崩溃）
  if (input.primaryDegraded && health.ok) {
    return { action: "manual-review", reason: "主系统 SLO 全面崩溃但探针未全断——值班人+Owner 双人确认（10 分钟裁决窗）" };
  }
  return { action: "hold" };
}

/* ---------------- 回切规划器（§5.3：切回去比切过来更谨慎） ---------------- */

export type FailbackPhase =
  | { phase: "role-reversed-observation"; remainingMs: number }  // 角色互换观察 ≥24h
  | { phase: "data-verify"; checks: string[] }                    // 全量验链 + 关键投影比对
  | { phase: "canary-failback"; percent: number }                 // 5% 灰度回切 24h
  | { phase: "full-failback" }
  | { phase: "blocked"; reason: string };

export function planFailback(input: {
  repairedAt: number;
  observationMs?: number;          // 默认 24h
  chainVerifyOk: boolean;
  balanceDiffOk: boolean;          // 积分余额双库比对零差异
  canaryPercent?: number;          // 默认 5%
  now: number;
}): FailbackPhase {
  const observationMs = input.observationMs ?? 24 * 3_600_000;
  const elapsed = input.now - input.repairedAt;
  if (elapsed < observationMs) {
    return { phase: "role-reversed-observation", remainingMs: observationMs - elapsed };
  }
  if (!input.chainVerifyOk || !input.balanceDiffOk) {
    const missing = [
      !input.chainVerifyOk ? "事件库全量验链未通过" : null,
      !input.balanceDiffOk ? "积分余额双库比对存在差异" : null,
    ].filter(Boolean).join("；");
    return { phase: "blocked", reason: `数据补齐校验未过：${missing}（补齐前禁止回切）` };
  }
  const canary = input.canaryPercent ?? 5;
  if (canary < 100) return { phase: "canary-failback", percent: canary };
  return { phase: "full-failback" };
}

/** 双主窗口纪律：写流量永远只走一边（fencing token 保证），读流量可双走 */
export function writeTargetFor(fenceHolder: string | null, nodeId: string): "accept" | "reject-readonly" {
  return fenceHolder === nodeId ? "accept" : "reject-readonly";
}
