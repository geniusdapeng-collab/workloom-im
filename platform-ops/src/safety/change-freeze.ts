/**
 * safety/change-freeze —— 熔断体系补全（对焦方案 §3.2 三个层级）
 *
 * ① 变更熔断：SLO 燃烧率超标 → 全局变更冻结（CI 拒收 C1+，只放行 hotfix）；
 * ② 功能熔断：复用 stability/circuit-breaker（本模块只发冻结判令）；
 * ③ 资产熔断：Bundle/技能触发围栏异常或考题回归失败 → 自动下架回滚 + 冻结同类发布队列；
 * 另：围栏异动检测——拦截率偏离 3σ → P1 + 冻结该规则相关资产再变更。
 * 全部判令落事件账本（可审计的判令，不是黑箱）。
 */
import { evaluateSlo, type SloDef } from "../runtime/slo.js";

export type FreezeScope = "global-changes" | "funds" | "asset" | "fence-rule";

export interface FreezeOrder {
  scope: FreezeScope;
  target?: string;          // asset/fence-rule 时的对象
  reason: string;           // 触发依据（指标与阈值，进账本）
  triggeredAt: number;
  level: "P0" | "P1";
  /** hotfix 快轨是否豁免（变更冻结时只允许止损类变更） */
  hotfixExempt: boolean;
}

/* ---------------- ① 全局变更冻结（SLO 燃烧率驱动） ---------------- */

export function evaluateChangeFreeze(
  slos: Array<{ def: SloDef; total: number; bad: number }>,
  now: number,
): FreezeOrder[] {
  const orders: FreezeOrder[] = [];
  for (const s of slos) {
    const st = evaluateSlo(s.def, s.total, s.bad);
    if (st.action === "freeze_funds") {
      orders.push({ scope: "funds", reason: `${s.def.name} 硬指标越界（对账差异），冻结相关资金流`, triggeredAt: now, level: "P1", hotfixExempt: false });
    } else if (st.action === "freeze_releases" || st.action === "alert") {
      orders.push({
        scope: "global-changes",
        reason: `${s.def.name} 错误预算消耗 ${(st.budgetConsumed * 100).toFixed(0)}%${st.action === "alert" ? "（耗尽，只许修障）" : "（>50%，冻结非必要变更）"}`,
        triggeredAt: now, level: st.action === "alert" ? "P0" : "P1", hotfixExempt: true,
      });
    }
  }
  return orders;
}

/* ---------------- ② 变更准入（CI 闸门对接点） ---------------- */

export type AdmissionDecision = { admit: boolean; reason: string };

/** 冻结状态下的变更准入判定：全局冻结只放行 hotfix；资金冻结拒绝一切账务相关 */
export function admitChange(
  activeFreezes: FreezeOrder[],
  change: { hotfix?: boolean; touchesFunds?: boolean; level: string },
): AdmissionDecision {
  for (const f of activeFreezes) {
    if (f.scope === "funds" && change.touchesFunds) {
      return { admit: false, reason: `资金冻结中（${f.reason}），账务相关变更一律拒绝` };
    }
    if (f.scope === "global-changes" && !change.hotfix) {
      return { admit: false, reason: `全局变更冻结中（${f.reason}），仅 hotfix 止损通道放行` };
    }
  }
  return { admit: true, reason: "无激活冻结判令" };
}

/* ---------------- ③ 资产熔断 ---------------- */

export interface AssetHealth {
  assetId: string;                 // bundle/skill 标识
  fenceAnomalies: number;          // 观察窗内围栏拦截异常
  examRegressionFailures: number;  // 考题回归失败数
}

export const ASSET_CIRCUIT_THRESHOLDS = { fenceAnomalies: 3, examRegressionFailures: 1 } as const;

export function evaluateAssetCircuit(assets: AssetHealth[], now: number): FreezeOrder[] {
  const orders: FreezeOrder[] = [];
  for (const a of assets) {
    if (a.examRegressionFailures >= ASSET_CIRCUIT_THRESHOLDS.examRegressionFailures) {
      orders.push({
        scope: "asset", target: a.assetId,
        reason: `考题回归失败 ${a.examRegressionFailures} 次 → 自动下架回滚上一快照，冻结同类资产发布队列`,
        triggeredAt: now, level: "P1", hotfixExempt: false,
      });
    } else if (a.fenceAnomalies > ASSET_CIRCUIT_THRESHOLDS.fenceAnomalies) {
      orders.push({
        scope: "asset", target: a.assetId,
        reason: `围栏拦截异常 ${a.fenceAnomalies} 次（阈值 ${ASSET_CIRCUIT_THRESHOLDS.fenceAnomalies}）→ 下架回滚`,
        triggeredAt: now, level: "P1", hotfixExempt: false,
      });
    }
  }
  return orders;
}

/* ---------------- 围栏异动检测（3σ） ---------------- */

export interface FenceInterceptionStats { ruleId: string; dailyCounts: number[] }

/** 拦截率偏离基线 3σ（突降=防线失效嫌疑，突升=攻击/异常流量嫌疑） */
export function detectFenceAnomaly(
  stats: FenceInterceptionStats,
  opts: { minSamples?: number; now: number },
): FreezeOrder | null {
  const { dailyCounts } = stats;
  const min = opts.minSamples ?? 7;
  if (dailyCounts.length < min + 1) return null;
  const baseline = dailyCounts.slice(0, -1);
  const today = dailyCounts[dailyCounts.length - 1]!;
  const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
  const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / baseline.length;
  const std = Math.sqrt(variance);
  if (std === 0) {
    // 基线恒定时：从 0 到非 0 或从非 0 到 0 都是异动（保守判定）
    if ((mean === 0) !== (today === 0)) {
      return { scope: "fence-rule", target: stats.ruleId, reason: `拦截次数 ${mean}→${today}（基线恒定突变）`, triggeredAt: opts.now, level: "P1", hotfixExempt: false };
    }
    return null;
  }
  if (Math.abs(today - mean) > 3 * std) {
    const dir = today < mean ? "突降（防线失效嫌疑）" : "突升（异常流量/攻击嫌疑）";
    return { scope: "fence-rule", target: stats.ruleId, reason: `拦截次数 ${today} 偏离基线 ${mean.toFixed(1)}±3σ（${dir}），冻结该规则相关资产再变更`, triggeredAt: opts.now, level: "P1", hotfixExempt: false };
  }
  return null;
}
