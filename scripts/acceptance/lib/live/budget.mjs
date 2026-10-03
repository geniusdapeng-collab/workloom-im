/**
 * budget.mjs · 生产实测（P 域）额度闸与成本台账（RDAS v3.1 §19）
 *
 * 调用前按唯一预留单同步占额；结算只补该单超过预估的部分，失败不释放。
 * 计量台账只增不改。缺失/零 usage 保留估计并明确未验证；实际超额会计入
 * 真实用量并锁住后续调用，不能把已发生的超额或估计写成生产实测通过。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 基座硬上限：profile 只能更紧，不能更松。 */
export const LIVE_BUDGET_CAPS = Object.freeze({
  maxLlmCalls: 40,
  maxLlmTokens: 300_000,
  maxImages: 8,
  maxVideoClips: 3,
  minVideoSeconds: 10,
  maxVideoSeconds: 15,
  maxVideoSecondsTotal: 45,
  maxCostCny: 120,
  maxWallClockMin: 45,
});
export const DEFAULT_LIVE_BUDGETS = Object.freeze({ ...LIVE_BUDGET_CAPS });
const DEFAULT_PRICING = Object.freeze({ llmCnyPer1kTokens: 0.002, imageCny: 0.35, videoCnyPerSecond: 1.2 });
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isAmount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const money = (n) => Number(n.toPrecision(15));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const isValidBudgetTaskId = (id) => typeof id === "string" && /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u.test(id);

/** max 取小、min 取大；非法配置直接失败，禁止 NaN/Infinity 或负数穿透闸。 */
export function normalizeBudgets(declared = {}) {
  if (!isObject(declared)) throw new TypeError("live.budgets 必须是对象");
  const warnings = [];
  const out = { ...DEFAULT_LIVE_BUDGETS };
  for (const [key, cap] of Object.entries(LIVE_BUDGET_CAPS)) {
    const value = declared[key];
    if (value === undefined || value === null) continue;
    const integral = !["maxCostCny", "maxWallClockMin"].includes(key);
    if (!isAmount(value) || (integral && !isCount(value))) {
      throw new TypeError(`live.budgets.${key} 必须是有限非负${integral ? "安全整数" : "数字"}`);
    }
    const isMin = key.startsWith("min");
    if (isMin && value < cap) warnings.push(`live.budgets.${key}=${value} 低于基座下限 ${cap}，已抬到下限`);
    else if (!isMin && value > cap) warnings.push(`live.budgets.${key}=${value} 高于基座上限 ${cap}，已收到上限`);
    out[key] = isMin ? Math.max(cap, value) : Math.min(cap, value);
  }
  if (out.minVideoSeconds > out.maxVideoSeconds) throw new RangeError("live.budgets 视频时长区间为空");
  const declaredPricing = declared.pricing ?? {};
  if (!isObject(declaredPricing)) throw new TypeError("live.budgets.pricing 必须是对象");
  const pricing = { ...DEFAULT_PRICING };
  for (const [key, value] of Object.entries(declaredPricing)) {
    if (!Object.hasOwn(pricing, key) || !isAmount(value)) throw new TypeError("live.budgets.pricing 包含非法单价");
    pricing[key] = value;
  }
  out.pricing = Object.freeze(pricing);
  return { budgets: Object.freeze(out), warnings };
}

/** 一轮一个新目录；已有账本绝不清空或复用。 */
export function createBudget({ budgets, outDir, environmentKind = "local-preview" }) {
  // 再次核验，调用方不能靠绕过 normalizeBudgets 放宽基座红线。
  budgets = normalizeBudgets(budgets).budgets;
  const pricing = budgets.pricing;
  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, "budget-ledger.jsonl");
  writeFileSync(ledgerPath, "", { flag: "wx" });
  const state = {
    llmCalls: 0, llmTokens: 0, images: 0, videoClips: 0, videoSeconds: 0, costCny: 0,
    startedAt: Date.now(), blocked: [], exceeded: [], auditFailure: false, unverifiedSettlement: false,
  };
  const reservations = new Map();
  const taskReservations = new Map();
  const record = (entry) => {
    try {
      appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), environmentKind, ...entry })}\n`);
    } catch (error) {
      state.auditFailure = true;
      throw error; // 无可持久化回执时，不允许开始动作；下一次 reserve 也会阻断。
    }
  };
  const estimate = ({ kind, units = 0, tokens = 0 }) => {
    if (kind === "llm") return money((tokens / 1000) * pricing.llmCnyPer1kTokens);
    return money(units * (kind === "image" ? pricing.imageCny : pricing.videoCnyPerSecond));
  };
  const expired = () => (Date.now() - state.startedAt) / 60_000 >= budgets.maxWallClockMin;
  function deny(event, input, reason, estimateCny = 0) {
    const taskId = isValidBudgetTaskId(input?.taskId) ? input.taskId : "(invalid)";
    if (!state.auditFailure) record({ event, taskId, kind: input?.kind ?? null, reason });
    state.blocked.push({ taskId, reason });
    return { allowed: false, reason, estimateCny };
  }
  function validate(input, settlement = false) {
    if (!isObject(input) || !isValidBudgetTaskId(input.taskId)) return "taskId 必须是非空且无路径/控制字符的任务标识";
    if (!["llm", "image", "video"].includes(input.kind)) return "未知计量类型";
    const units = input.units ?? 0;
    const tokens = input.tokens ?? 0;
    if (!isCount(units) || !isCount(tokens)) return "units/tokens 必须是有限非负安全整数";
    if (input.kind === "llm") {
      if (units > 1 || (!settlement && tokens === 0)) return "LLM 每次预留需要正 token 估计且最多一次调用";
    } else if (tokens !== 0 || (!settlement && units === 0)) return "生成任务需要正 units 且不得携带 LLM token";
    if (settlement && input.costCny != null && !isAmount(input.costCny)) return "costCny 必须是有限非负数字";
    if (input.usageVerified != null && typeof input.usageVerified !== "boolean") return "usageVerified 必须是布尔值";
    return null;
  }

  /** 同步占额，在任何 await/外部调用前返回唯一 reservationId。 */
  function reserve(input = {}) {
    const invalid = validate(input);
    if (invalid) return deny("reserve-denied", input, invalid);
    const { taskId, kind, units = 0, tokens = 0, detail = "" } = input;
    if (state.auditFailure) return deny("reserve-denied", input, "预算台账写入失败，禁止继续调用");
    if (state.unverifiedSettlement) return deny("reserve-denied", input, "先前实际用量不可核验，禁止继续调用");
    if (state.exceeded.length) return deny("reserve-denied", input, "先前实际结算已超额，禁止继续调用");
    if (taskReservations.has(taskId)) return deny("reserve-denied", input, "任务已有预留单，禁止重复派发");
    if (expired()) return deny("reserve-denied", input, `实测墙钟已达 ${budgets.maxWallClockMin} 分钟上限`);
    const est = estimate({ kind, units, tokens });
    if (!isAmount(est) || money(state.costCny + est) > budgets.maxCostCny) {
      return deny("reserve-denied", input, `成本上限 ${budgets.maxCostCny} 元将被超过`, Number.isFinite(est) ? est : 0);
    }
    if (kind === "llm" && (state.llmCalls + 1 > budgets.maxLlmCalls || state.llmTokens + tokens > budgets.maxLlmTokens)) {
      return deny("reserve-denied", input, `LLM 调用/token 上限将被超过（${state.llmCalls + 1}/${budgets.maxLlmCalls}，${state.llmTokens + tokens}/${budgets.maxLlmTokens}）`, est);
    }
    if (kind === "image" && state.images + units > budgets.maxImages) {
      return deny("reserve-denied", input, `图片张数上限 ${budgets.maxImages} 将被超过`, est);
    }
    if (kind === "video") {
      if (units < budgets.minVideoSeconds || units > budgets.maxVideoSeconds) {
        return deny("reserve-denied", input, `视频时长超出允许区间 ${budgets.minVideoSeconds}–${budgets.maxVideoSeconds}s`, est);
      }
      if (state.videoClips + 1 > budgets.maxVideoClips || state.videoSeconds + units > budgets.maxVideoSecondsTotal) {
        return deny("reserve-denied", input, "视频段数/总秒数上限将被超过", est);
      }
    }
    const reservationId = randomUUID();
    const reservation = { reservationId, taskId, kind, units, tokens, estimateCny: est, chargedUnits: units, chargedTokens: tokens, chargedCostCny: est, settled: false, usageVerified: false };
    record({ event: "reserve", reservationId, taskId, kind, units, tokens, detail, estimateCny: est });
    reservations.set(reservationId, reservation);
    taskReservations.set(taskId, reservationId);
    if (kind === "llm") { state.llmCalls += 1; state.llmTokens += tokens; }
    if (kind === "image") state.images += units;
    if (kind === "video") { state.videoClips += 1; state.videoSeconds += units; }
    state.costCny = money(state.costCny + est);
    return { allowed: true, reservationId, estimateCny: est };
  }

  /** 每个预留只结算一次；旧调用方可以按唯一 taskId 找回预留单。 */
  function commit(input = {}) {
    const invalid = validate(input, true);
    if (invalid) return deny("commit-denied", input, invalid);
    const { taskId, kind, units = null, tokens = null, costCny = null, detail = "" } = input;
    const id = input.reservationId ?? taskReservations.get(taskId);
    const reservation = reservations.get(id);
    if (!reservation || reservation.taskId !== taskId || reservation.kind !== kind) {
      return deny("commit-denied", input, "结算必须匹配本任务、本类型的已获准预留单");
    }
    const usageVerified = input.usageVerified !== false && (kind === "llm" ? tokens > 0 : units > 0);
    const settlement = JSON.stringify({ units, tokens, costCny, usageVerified });
    if (reservation.settled) {
      if (reservation.settlement !== settlement) return deny("commit-denied", input, "同一预留单重复结算的用量不一致");
      return { ...reservation.result, idempotent: true };
    }
    const chargedTokens = Math.max(reservation.tokens, tokens ?? 0);
    const chargedUnits = Math.max(reservation.units, units ?? 0);
    const chargedCostCny = Math.max(reservation.estimateCny, costCny ?? 0, estimate({ kind, tokens: chargedTokens, units: chargedUnits }));
    if (!isAmount(chargedCostCny)) return deny("commit-denied", input, "实际成本溢出，保留预留估计");
    const nextTokens = state.llmTokens + (kind === "llm" ? chargedTokens - reservation.chargedTokens : 0);
    const nextImages = state.images + (kind === "image" ? chargedUnits - reservation.chargedUnits : 0);
    const nextSeconds = state.videoSeconds + (kind === "video" ? chargedUnits - reservation.chargedUnits : 0);
    const nextCost = money(state.costCny + Math.max(0, chargedCostCny - reservation.chargedCostCny));
    const violations = [];
    if (nextTokens > budgets.maxLlmTokens) violations.push("LLM token 实际累计超限");
    if (nextImages > budgets.maxImages) violations.push("图片实际累计超限");
    if (nextSeconds > budgets.maxVideoSecondsTotal || (kind === "video" && chargedUnits > budgets.maxVideoSeconds)) violations.push("视频实际秒数超限");
    if (nextCost > budgets.maxCostCny) violations.push("实际成本超限");
    if (expired()) violations.push("结算时墙钟已超限");
    const reason = violations.join("；") || undefined;
    const result = { allowed: !violations.length, reservationId: id, usageVerified, accounting: usageVerified ? "verified" : "estimated", ...(reason ? { reason } : {}) };
    // 先落账再改内存：审计不可写不会把一次失败的 reserve 当作获准动作。
    record({ event: "commit", reservationId: id, taskId, kind, units, tokens, costCny, detail, chargedUnits, chargedTokens, chargedCostCny, usageVerified, violations });
    Object.assign(reservation, { chargedUnits, chargedTokens, chargedCostCny, settled: true, settlement, usageVerified, result });
    state.llmTokens = nextTokens;
    state.images = nextImages;
    state.videoSeconds = nextSeconds;
    state.costCny = nextCost;
    if (!usageVerified) state.unverifiedSettlement = true;
    if (reason) { state.exceeded.push({ taskId, reservationId: id, reason }); state.blocked.push({ taskId, reason }); }
    return result;
  }

  function summary() {
    const all = [...reservations.values()];
    const pending = all.filter((r) => !r.settled).map((r) => r.taskId);
    const unverified = all.filter((r) => !r.usageVerified).map((r) => r.taskId);
    return {
      budgets,
      used: {
        llmCalls: state.llmCalls, llmTokens: state.llmTokens, images: state.images,
        videoClips: state.videoClips, videoSeconds: state.videoSeconds,
        costCny: money(state.costCny),
        wallClockMin: Number(((Date.now() - state.startedAt) / 60000).toFixed(2)),
      },
      accounting: { mode: !all.length ? "not-started" : unverified.length ? "estimated" : "verified", verified: all.length > 0 && !unverified.length && !state.auditFailure, pending, unverified, auditFailure: state.auditFailure, costBasis: "conservative-estimate-or-reported-cost" },
      reservations: all.map(({ result, ...r }) => ({ ...r })),
      exceeded: state.exceeded.map((v) => ({ ...v })),
      blocked: state.blocked.map((v) => ({ ...v })),
      ledger: ledgerPath,
    };
  }
  function persist() {
    const s = summary();
    writeFileSync(join(outDir, "budget-summary.json"), JSON.stringify(s, null, 1));
    return s;
  }
  return { reserve, commit, summary, persist, ledgerPath, pricing };
}
