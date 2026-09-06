/**
 * runtime/trigger-watchdog —— 漏触发检测（PRD V3.0 §18.2-3）
 *
 * 触发器引擎每次触发写 trigger.fire 事件；监督器按 cron 表达式独立重算"应触发时刻表"，
 * 对账实际触发——漏触发 >5min 即 P1（夜班、巡检、对账等关键任务永不静默丢失）。
 */

/** 极简 5 段 cron（分 时 日 月 周）下一触发时刻计算：支持 *、、、-、/n 与具体值 */
export function nextCronFire(expr: string, afterMs: number): number | null {
  const [minF, hourF] = expr.trim().split(/\s+/);
  if (minF === undefined || hourF === undefined) return null;
  const mins = expandField(minF, 0, 59);
  const hours = expandField(hourF, 0, 23);
  if (!mins || !hours) return null;
  // 自 afterMs 的下一分钟起，向前找 48h 内首个匹配
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let t = start; t <= afterMs + 48 * 3_600_000; t += 60_000) {
    const d = new Date(t);
    if (mins.has(d.getMinutes()) && hours.has(d.getHours())) return t;
  }
  return null;
}

function expandField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1] : part;
    if (base === "*") {
      for (let i = lo; i <= hi; i += step) out.add(i);
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split("-").map(Number);
      for (let i = a; i <= b; i += step) out.add(i);
    } else if (/^\d+$/.test(base)) {
      out.add(Number(base));
    } else {
      return null;
    }
  }
  return out;
}

export interface FireEvent { triggerId: string; firedAt: number }

export interface MissedTrigger { triggerId: string; expectedAt: number; missedByMs: number; level: "P1" }

export class TriggerWatchdog {
  constructor(private opts: { missThresholdMs?: number; now?: () => number } = {}) {}

  /** 对账一次：cron 应触发表 vs 实际 trigger.fire 事件 */
  reconcile(
    triggers: Array<{ triggerId: string; cron: string }>,
    fires: FireEvent[],
    windowStartMs: number,
  ): MissedTrigger[] {
    const now = (this.opts.now ?? Date.now)();
    const threshold = this.opts.missThresholdMs ?? 5 * 60_000;
    const missed: MissedTrigger[] = [];
    for (const t of triggers) {
      let expected = nextCronFire(t.cron, windowStartMs - 60_000);
      while (expected !== null && expected <= now - threshold) {
        const fired = fires.some((f) => f.triggerId === t.triggerId && Math.abs(f.firedAt - expected!) < 60_000);
        if (!fired) {
          missed.push({ triggerId: t.triggerId, expectedAt: expected, missedByMs: now - expected, level: "P1" });
        }
        expected = nextCronFire(t.cron, expected);
      }
    }
    return missed;
  }
}
