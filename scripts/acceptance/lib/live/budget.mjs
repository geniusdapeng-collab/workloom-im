/**
 * budget.mjs · 生产实测（P 域）额度闸与成本台账（RDAS v3.1 §19）
 *
 * 为什么要单独一个闸：
 *   生图/生视频按张、按秒计费，成本比文本 token 高两个数量级（`packages/base/model-router/gen-pool.ts`
 *   的分池分计量口径）。验收器如果只写“少跑几个 case”，没人能证明真的没超。
 *   本模块把「少跑」变成**可审计的硬上限**：超限即中止该任务（fail-closed），并把每次付费调用
 *   写进 `live/budget-ledger.jsonl`（只增不改，随报告归档）。
 *
 * 纪律：
 *   1. 上限只能收紧不能放宽：profile 声明值高于基座下限时按基座下限执行并写告警；
 *   2. 图片按张、视频按秒与段数双计量；LLM 按调用次数与 token 双计量；
 *   3. 任何一次调用前先占额（reserve），调用后回填实际用量（commit）；异常未回填则按预估计入（不释放）；
 *   4. 台账不得记录提示词全文以外的秘密；密钥永不进账。
 */
import { appendFileSync, constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** 基座硬上限：profile 只能更紧，不能更松（v3.1 默认值 = 产品所有者 2026-09-20 给定配额） */
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
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isValidBudgetTaskId = (id) => typeof id === "string" && /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u.test(id);
const money = (value) => Number(value.toPrecision(15));

/** 应用硬上限：max* 取更小者，min* 取更大者；返回告警列表（不静默） */
export function normalizeBudgets(declared = {}) {
  if (!object(declared)) throw new TypeError("live.budgets 必须是对象");
  const warnings = [];
  const out = { ...DEFAULT_LIVE_BUDGETS };
  for (const [key, cap] of Object.entries(LIVE_BUDGET_CAPS)) {
    const value = declared[key];
    if (value === undefined || value === null) continue;
    const integral = !["maxCostCny", "maxWallClockMin"].includes(key);
    if (!number(value) || (integral && !integer(value))) throw new TypeError(`live.budgets.${key} 必须是有限非负${integral ? "安全整数" : "数字"}`);
    const isMin = key.startsWith("min");
    if (isMin && value < cap) warnings.push(`live.budgets.${key}=${value} 低于基座下限 ${cap}，已抬到下限`);
    else if (!isMin && value > cap) warnings.push(`live.budgets.${key}=${value} 高于基座上限 ${cap}，已收到上限`);
    out[key] = isMin ? Math.max(cap, value) : Math.min(cap, value);
  }
  if (out.minVideoSeconds > out.maxVideoSeconds) throw new RangeError("live.budgets 视频时长区间为空");
  const declaredPricing = declared.pricing === undefined ? {} : declared.pricing;
  if (!object(declaredPricing)) throw new TypeError("live.budgets.pricing 必须是对象");
  const pricing = { ...DEFAULT_PRICING };
  for (const [key, value] of Object.entries(declaredPricing)) {
    if (!Object.hasOwn(pricing, key) || !number(value)) throw new TypeError("live.budgets.pricing 包含非法单价");
    pricing[key] = value;
  }
  out.pricing = Object.freeze(pricing);
  return { budgets: Object.freeze(out), warnings };
}

const DEFAULT_PRICING = Object.freeze({ llmCnyPer1kTokens: 0.002, imageCny: 0.35, videoCnyPerSecond: 1.2 });
const SCHEMA = "workloom.live-budget/v2";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
const integer = (value) => number(value) && Number.isSafeInteger(value);

/**
 * 创建额度闸。
 * @param {object} args
 * @param {object} args.budgets  已归一化的额度（normalizeBudgets().budgets）
 * @param {string} args.outDir  产物目录（写 budget-ledger.jsonl / budget-summary.json）
 * @param {string} [args.environmentKind]
 */
export function createBudget({ budgets: declaredBudgets, outDir, environmentKind = "local-preview", runId = "default" }) {
  const { budgets } = normalizeBudgets(declaredBudgets);
  const pricing = Object.freeze({ ...DEFAULT_PRICING, ...(budgets.pricing ?? {}) });
  if (typeof runId !== "string" || !runId.trim()) throw new Error("预算 runId 必须是非空字符串");
  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, "budget-ledger.jsonl");
  const lockPath = `${ledgerPath}.lock`;
  const estimate = ({ kind, units = 0, tokens = 0 }) => {
    if (kind === "llm") return money((tokens / 1000) * pricing.llmCnyPer1kTokens);
    if (kind === "image") return money(units * pricing.imageCny);
    if (kind === "video") return money(units * pricing.videoCnyPerSecond);
    return 0;
  };
  const record = (entry) => {
    const fd = openSync(ledgerPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { appendFileSync(fd, `${JSON.stringify({ schema: SCHEMA, runId, at: new Date().toISOString(), environmentKind, ...entry })}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  // 一个 outDir/runId 是一个共享配额事务。锁内回放日志，不依赖各 writer 的内存快照。
  // 进程崩溃留下的锁不擅自删除；无法证明安全时阻断，避免两个 writer 同时占额。
  function locked(fn) {
    const until = Date.now() + 5000;
    while (true) {
      try { mkdirSync(lockPath); break; } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= until) throw new Error("预算事务锁不可用；尚未占额，禁止付费调用");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); } finally { rmSync(lockPath, { recursive: true }); }
  }

  function replay() {
    if (existsSync(ledgerPath) && (!lstatSync(ledgerPath).isFile() || lstatSync(ledgerPath).isSymbolicLink() || lstatSync(ledgerPath).nlink !== 1)) throw new Error("预算账本必须是独立普通文件，不能通过链接替换");
    if (existsSync(ledgerPath) && ((lstatSync(ledgerPath).mode & 0o444) === 0 || (lstatSync(ledgerPath).mode & 0o222) === 0)) throw new Error("预算账本没有可读写权限，尚未占额");
    const text = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf-8") : "";
    const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (runId === "default" && records.some((row) => !row.runId)) throw new Error("旧预算账本缺少 runId，不能安全恢复；请使用新运行标识");
    const rows = records.filter((row) => row.runId === runId);
    if (rows.some((row) => row.schema !== SCHEMA)) throw new Error("预算账本 schema 不兼容，禁止继续付费调用");
    const init = rows.filter((row) => row.event === "budget-init");
    if (init.length > 1) throw new Error("预算账本有重复初始化，禁止继续付费调用");
    const reservations = new Map();
    const blocked = [];
    const frozen = [];
    for (const row of rows) {
      if (typeof row.event !== "string" || row.environmentKind !== environmentKind || !Number.isFinite(Date.parse(row.at))) throw new Error("预算账本事件/时间无效或环境不一致，禁止继续付费调用");
      if (row.event === "reserve") {
        if (!identify(row) || !quantities(row) || !number(row.estimateCny) || row.estimateCny !== estimate(row)) throw new Error("预算账本占额计量无效，禁止继续付费调用");
        if (reservations.has(row.reservationId)) throw new Error("预算账本重复占额，禁止继续付费调用");
        reservations.set(row.reservationId, { ...row, settlement: null });
      } else if (row.event === "commit") {
        const reservation = reservations.get(row.reservationId);
        if (!reservation || reservation.settlement || reservation.taskId !== row.taskId || reservation.kind !== row.kind || !identify(row) || !quantities(row, true) || !integer(row.calls) || (row.kind !== "llm" && row.calls !== 0) || typeof row.measured !== "boolean" || (row.measured && row.kind === "llm" && row.calls > 0 && row.tokens === 0) || (row.costCny !== null && !number(row.costCny)) || !["ok", "failed", "blocked"].includes(row.status)) throw new Error("预算账本结算链断裂或计量非法，禁止继续付费调用");
        reservation.settlement = row;
      } else if (row.event === "usage-unverified") {
        if (typeof row.taskId !== "string" || !row.taskId.trim() || typeof row.reason !== "string" || !row.reason.trim()) throw new Error("预算账本缺少未计量原因，禁止继续付费调用");
        frozen.push({ taskId: row.taskId, reason: row.reason });
      } else if (row.event.endsWith("-denied")) {
        blocked.push({ taskId: row.taskId, reservationId: row.reservationId, reason: row.reason });
      } else if (row.event !== "budget-init") throw new Error("预算账本包含未知事件，禁止继续付费调用");
    }
    if (init[0] && (!integer(init[0].startedAt) || init[0].startedAt > Date.now() || JSON.stringify(init[0].pricing) !== JSON.stringify(pricing))) throw new Error("预算账本初始时间/单价非法，禁止继续付费调用");
    return { init: init[0] ?? null, reservations, blocked, frozen };
  }

  locked(() => {
    const state = replay();
    if (state.init) {
      if (JSON.stringify(state.init.budgets) !== JSON.stringify(budgets) || state.init.environmentKind !== environmentKind) {
        throw new Error("共享运行的预算/环境不一致，禁止重置或覆盖账本");
      }
    } else record({ event: "budget-init", startedAt: Date.now(), budgets, pricing });
  });

  const emptyUsage = () => ({ llmCalls: 0, llmTokens: 0, images: 0, videoClips: 0, videoSeconds: 0, costCny: 0 });
  function usage(state) {
    const used = emptyUsage();
    const pending = emptyUsage();
    const actual = emptyUsage();
    const unmeasured = emptyUsage();
    for (const reservation of state.reservations.values()) {
      const s = reservation.settlement;
      const conservative = { tokens: Math.max(reservation.tokens, s?.tokens ?? 0), units: Math.max(reservation.units, s?.units ?? 0) };
      const cost = Math.max(reservation.estimateCny, estimate({ kind: reservation.kind, ...conservative }), s?.costCny ?? 0);
      const add = (to, tokens, units, costCny, calls = reservation.kind === "llm" ? 1 : 0) => {
        if (reservation.kind === "llm") { to.llmCalls += calls; to.llmTokens += tokens; }
        if (reservation.kind === "image") to.images += units;
        if (reservation.kind === "video") { to.videoClips += units > 0 ? 1 : 0; to.videoSeconds += units; }
        to.costCny = money(to.costCny + costCny);
      };
      add(used, conservative.tokens, conservative.units, cost, reservation.kind === "llm" ? Math.max(1, s?.calls ?? 0) : 0);
      if (!s) add(pending, reservation.tokens, reservation.units, reservation.estimateCny);
      else if (s.measured) add(actual, s.tokens, s.units, s.costCny ?? estimate(s), s.calls);
      else add(unmeasured, conservative.tokens, conservative.units, cost);
    }
    return { used, pending, actual, unmeasured };
  }

  const frozenBy = (state) => [...state.frozen, ...[...state.reservations.values()].filter((reservation) => reservation.settlement?.measured === false).map((reservation) => ({ taskId: reservation.taskId, reservationId: reservation.reservationId, reason: reservation.settlement.detail || "实际用量没有取得供应商计量，后续付费调用冻结" }))];

  function exceeded(used) {
    return [
      ["llmCalls", "maxLlmCalls"], ["llmTokens", "maxLlmTokens"], ["images", "maxImages"],
      ["videoClips", "maxVideoClips"], ["videoSeconds", "maxVideoSecondsTotal"], ["costCny", "maxCostCny"],
    ].filter(([key, limit]) => used[key] > budgets[limit]).map(([key]) => key);
  }
  const exceededState = (state) => [...new Set([...exceeded(usage(state).used), ...[...state.reservations.values()].some((r) => r.kind === "video" && Math.max(r.units, r.settlement?.units ?? 0) > budgets.maxVideoSeconds) ? ["videoDuration"] : [],
    ...[...state.reservations.values()].some((r) => r.settlement) && (Date.now() - state.init.startedAt) / 60000 >= budgets.maxWallClockMin ? ["wallClock"] : []])];

  function deny(event, args, reason, estimateCny = 0) {
    record({ event: `${event}-denied`, taskId: args.taskId, kind: args.kind, reservationId: args.reservationId, reason });
    return { allowed: false, committed: false, reason, estimateCny };
  }

  function identify(args) {
    return isValidBudgetTaskId(args.taskId) && isValidBudgetTaskId(args.reservationId)
      && ["llm", "image", "video"].includes(args.kind);
  }
  function quantities({ kind, units, tokens }, settlement = false) {
    if (!integer(tokens) || !number(units)) return false;
    if (kind === "llm") return integer(units) && units <= 1 && (settlement || tokens > 0);
    if (tokens !== 0 || (!settlement && units === 0)) return false;
    return kind === "video" && settlement ? true : integer(units);
  }

  /**
   * 占额：超限返回 {allowed:false, reason}，调用方必须把任务标为 blocked（不得静默跳过）。
   * @returns {{allowed:boolean, reason?:string, estimateCny:number}}
   */
  function reserve({ taskId, reservationId = taskId, kind, units = 0, tokens = 0, detail = "" } = {}) {
    return locked(() => {
      const args = { taskId, reservationId, kind, units, tokens };
      if (!identify(args) || !quantities(args)) {
        return deny("reserve", args, "占额参数无效：任务/幂等键/模态/数量必须明确且为有限非负值");
      }
      const state = replay();
      const prior = state.reservations.get(reservationId);
      if (prior) {
        const same = prior.taskId === taskId && prior.kind === kind && prior.units === units && prior.tokens === tokens;
        if (!same) return deny("reserve", args, "幂等键已被不同占额参数使用");
        return { allowed: true, duplicate: true, settled: Boolean(prior.settlement), reservationId, estimateCny: prior.estimateCny };
      }
      const { used } = usage(state);
      const est = estimate(args);
      if (!number(est)) return deny("reserve", args, "占额成本超出有限数字范围，尚未付费调用");
      if (frozenBy(state).length) return deny("reserve", args, "此前实际用量未验证，禁止后续付费调用", est);
      if ((Date.now() - state.init.startedAt) / 60000 >= budgets.maxWallClockMin) return deny("reserve", args, "实测墙钟已达上限", est);
      if (exceededState(state).length) return deny("reserve", args, "此前实际用量已超额，禁止后续付费调用", est);
      if (money(used.costCny + est) > budgets.maxCostCny) return deny("reserve", args, "本次预占将超过成本上限", est);
      if (kind === "llm" && (used.llmCalls + 1 > budgets.maxLlmCalls || used.llmTokens + tokens > budgets.maxLlmTokens)) return deny("reserve", args, "本次预占将超过 LLM 调用/token 上限", est);
      if (kind === "image" && used.images + units > budgets.maxImages) return deny("reserve", args, "本次预占将超过图片张数上限", est);
      if (kind === "video" && (units < budgets.minVideoSeconds || units > budgets.maxVideoSeconds || used.videoClips + 1 > budgets.maxVideoClips || used.videoSeconds + units > budgets.maxVideoSecondsTotal)) {
        return deny("reserve", args, "本次视频时长/段数/累计秒数超出允许范围", est);
      }
      // 先持久化才放行；文件写失败不能返回 allowed=true。
      record({ event: "reserve", ...args, detail, estimateCny: est });
      return { allowed: true, duplicate: false, reservationId, estimateCny: est };
    });
  }

  /** 回填实际用量：实际超过预估的部分补记；实际少于预估**不退还**（保守口径，防超支） */
  function commit(input = {}) {
    const { taskId, reservationId = taskId, kind, units = 0, tokens = 0, calls = kind === "llm" ? 1 : 0, costCny = null, status = "ok", detail = "" } = input;
    const measured = input.measured === undefined ? input.usageVerified ?? false : input.measured;
    return locked(() => {
      const args = { taskId, reservationId, kind, units, tokens, calls, costCny, measured, status };
      if (!identify(args) || !quantities(args, true) || !integer(calls) || (kind !== "llm" && calls !== 0) || typeof measured !== "boolean" || (input.usageVerified !== undefined && (typeof input.usageVerified !== "boolean" || input.measured !== undefined && input.usageVerified !== measured)) || (measured && kind === "llm" && calls > 0 && tokens === 0) || (costCny !== null && !number(costCny)) || !["ok", "failed", "blocked"].includes(status)) {
        return deny("commit", args, "结算参数无效；原预占继续保守计量");
      }
      const state = replay();
      const prior = state.reservations.get(reservationId);
      if (!prior || prior.taskId !== taskId || prior.kind !== kind) return deny("commit", args, "没有匹配的已放行占额；禁止凭空结算");
      if (prior.settlement) {
        const same = ["units", "tokens", "calls", "costCny", "measured", "status"].every((key) => prior.settlement[key] === args[key]);
        if (!same) return deny("commit", args, "幂等键已结算；冲突结算不得覆盖或重复计量");
        const over = exceededState(state);
        return { committed: true, allowed: over.length === 0, duplicate: true, idempotent: true, reservationId, exceeded: over, usageVerified: measured, accounting: measured ? "verified" : "estimated" };
      }
      record({ event: "commit", ...args, detail });
      const over = exceededState(replay());
      return { committed: true, allowed: over.length === 0, duplicate: false, idempotent: false, reservationId, exceeded: [...new Set(over)], usageVerified: measured, accounting: measured ? "verified" : "estimated" };
    });
  }

  /** Freeze the run when aggregate evidence cannot prove its complete usage. */
  function freeze({ taskId, reason }) {
    if (typeof taskId !== "string" || !taskId.trim() || typeof reason !== "string" || !reason.trim()) throw new Error("冻结用量需要明确任务及原因");
    return locked(() => {
      const state = replay();
      if (state.frozen.some((entry) => entry.taskId === taskId && entry.reason === reason)) return { frozen: true, duplicate: true };
      record({ event: "usage-unverified", taskId, reason });
      return { frozen: true, duplicate: false };
    });
  }

  function snapshot(state) {
    const { used, pending, actual, unmeasured } = usage(state);
    const frozen = frozenBy(state);
    const rounded = (value) => ({ ...value, costCny: money(value.costCny) });
    const reservations = [...state.reservations.values()];
    const pendingIds = reservations.filter((r) => !r.settlement).map((r) => r.taskId);
    const unverifiedIds = reservations.filter((r) => r.settlement?.measured !== true).map((r) => r.taskId);
    const measurementComplete = frozen.length === 0 && reservations.every((r) => r.settlement?.measured === true);
    return {
      schema: SCHEMA,
      runId,
      budgets,
      pricing,
      costBasis: { used: "预占/实际用量取较大者的冻结单价估算", actual: "已取得供应商计量的用量按冻结单价估算；非供应商账单", unmeasured: "实际量不可得，继续持有预占；不能称为实际零用量", invoiced: null },
      used: { ...rounded(used), wallClockMin: Number(((Date.now() - state.init.startedAt) / 60000).toFixed(2)) },
      pending: rounded(pending),
      actual: rounded(actual),
      unmeasured: rounded(unmeasured),
      measurementComplete,
      accounting: { mode: !reservations.length ? "not-started" : measurementComplete ? "verified" : "estimated", verified: reservations.length > 0 && measurementComplete, pending: pendingIds, unverified: unverifiedIds, auditFailure: false, costBasis: "frozen-price-conservative-estimate; not supplier invoice" },
      frozenBy: frozen,
      reservations: [...state.reservations.values()].map((r) => ({ reservationId: r.reservationId, taskId: r.taskId, kind: r.kind, units: r.units, tokens: r.tokens, status: r.settlement?.status ?? "pending", settlement: r.settlement })),
      exceeded: exceededState(state),
      blocked: state.blocked,
      ledger: ledgerPath,
    };
  }

  const summary = () => locked(() => snapshot(replay()));

  function persist() {
    return locked(() => {
      const s = snapshot(replay());
      const temp = join(outDir, `.budget-summary-${process.pid}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify(s, null, 1), { flag: "wx" });
        renameSync(temp, join(outDir, "budget-summary.json"));
      } finally { rmSync(temp, { force: true }); }
      return s;
    });
  }

  return { reserve, commit, freeze, summary, persist, ledgerPath, pricing };
}
