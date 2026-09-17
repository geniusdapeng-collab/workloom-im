/**
 * runtime/slo —— SLO 体系与错误预算（PRD V3.0 §18.5）
 *
 * 错误预算燃烧率：burn = 实际错误率 / 预算错误率（>1 即超速消耗）。
 * 响应纪律：预算消耗 >50% → 冻结非必要发布；对账是硬指标（100%，无预算，差异即冻结资金流）。
 */

export interface SloDef {
  name: string;
  target: number;          // 如 0.9995
  budgetWindowMs: number;  // 预算窗口（如月度 30d）
  response: string;        // 预算消耗响应纪律
}

/** §18.5 平台 SLO 登记表（单一事实源） */
export const PLATFORM_SLOS: SloDef[] = [
  { name: "ingest-ack",      target: 0.9995, budgetWindowMs: 30 * 86_400_000, response: "预算消耗 >50% → 冻结非必要发布" },
  { name: "ai-first-reply",  target: 0.99,   budgetWindowMs: 30 * 86_400_000, response: "连续 2 天不达标 → 模型路由策略复盘" },
  { name: "push-visibility", target: 0.99,   budgetWindowMs: 30 * 86_400_000, response: "超标 → 推送网关扩容/降级轮询" },
  { name: "projection-fresh",target: 0.995,  budgetWindowMs: 30 * 86_400_000, response: "超标 → 流处理器扩容" },
  { name: "reconcile",       target: 1.0,    budgetWindowMs: 86_400_000,      response: "硬指标无预算：差异即冻结相关资金流" },
  { name: "availability",    target: 0.999,  budgetWindowMs: 30 * 86_400_000, response: "预算耗尽 → 全量发布冻结，只许修障" },
];

export interface SloStatus {
  name: string;
  goodRatio: number;       // 窗口内达标率
  budgetTotal: number;     // 预算总量（允许的错误比例）
  budgetConsumed: number;  // 已消耗比例（0~∞）
  burnRate: number;        // 燃烧率（>1 超速）
  action: "ok" | "freeze_releases" | "freeze_funds" | "alert";
}

export function evaluateSlo(def: SloDef, total: number, bad: number): SloStatus {
  if (total <= 0) {
    return { name: def.name, goodRatio: 1, budgetTotal: 1 - def.target, budgetConsumed: 0, burnRate: 0, action: "ok" };
  }
  const goodRatio = 1 - bad / total;
  const budgetTotal = 1 - def.target;
  const errRate = bad / total;
  // 硬指标（target=1.0）：任何错误即越界
  if (budgetTotal === 0) {
    return { name: def.name, goodRatio, budgetTotal, budgetConsumed: bad > 0 ? 1 : 0, burnRate: bad > 0 ? Infinity : 0, action: bad > 0 ? "freeze_funds" : "ok" };
  }
  const consumed = errRate / budgetTotal;
  let action: SloStatus["action"] = "ok";
  if (consumed >= 1) action = "alert";
  else if (consumed > 0.5) action = "freeze_releases";
  return { name: def.name, goodRatio, budgetTotal, budgetConsumed: consumed, burnRate: consumed, action };
}
