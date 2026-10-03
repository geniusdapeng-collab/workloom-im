/**
 * night-shift · 清晨决策包（F4.4/H-7）：08:30 对夜间事件流做三段投影
 *   已完成（done）/ 待审批（pending）/ 需介入（need_human）
 * 铁律口径：
 *  - 不是报表，是日志的一次视图查询（纯投影，H-7 代码走查项：禁止另写汇总表）
 *  - 字段：动作摘要 / before-after / 命中围栏版本 / 证据快照链接
 *  - 整包 ≤20 条，超出按严重度截断（G6/APPROVAL_LIMITS.packageMaxItems）
 *  - 生成后写 night.package.deliver 事件（留痕 G8）+ 状态机 → package_generated
 */
import type pg from "pg";
import { APPROVAL_LIMITS, type BusinessEvent } from "@workloom/shared";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

/* ---------- 三段投影（纯函数，H-7 走查核心） ---------- */

export interface PackageItem {
  eventId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  fenceVersions: string[];
  snapshotUri?: string;
  /** 严重度（截断排序用）：need_human 3 > pending 2 > done 1 */
  severity: 1 | 2 | 3;
}

export interface NightPackage {
  done: PackageItem[];
  pending: PackageItem[];
  needHuman: PackageItem[];
  truncated: number;
  stats: { done: number; pending: number; need_human: number; credits_used: number };
}

/** 夜间事件流 → 三段投影（纯函数） */
export function projectNightPackage(events: BusinessEvent[]): NightPackage {
  const done: PackageItem[] = [];
  const pending: PackageItem[] = [];
  const needHuman: PackageItem[] = [];
  let credits = 0;

  for (const ev of events) {
    credits += ev.model_trace?.credits ?? 0;
    const impacts = ev.rule_impact ?? [];
    const item: PackageItem = {
      eventId: ev.event_id,
      summary: `${ev.who.id} · ${ev.decision.action}${ev.object.id ? `（${ev.object.id}）` : ""}`,
      before: ev.decision.before,
      after: ev.decision.after,
      fenceVersions: [...new Set(impacts.map((i) => `${i.rule_id}@${i.version}`))],
      snapshotUri: ev.receipt?.snapshot_uri,
      severity: 1,
    };
    if (impacts.some((i) => i.result === "blocked")) {
      item.severity = 3;
      needHuman.push(item); // 熔断/担保异常 → 需介入（L4.2 口径：不确定性只写需介入）
    } else if (impacts.some((i) => i.result === "review")) {
      item.severity = 2;
      pending.push(item); // 越围栏挂起 → 待审批
    } else if (ev.receipt?.synced || impacts.length === 0) {
      done.push(item); // 有回执的系统动作/只读动作 → 已完成
    } else {
      item.severity = 3; // 无回执 = 未核实（E3.7）→ 需介入
      item.summary += "（未核实）";
      needHuman.push(item);
    }
  }

  // 整包 ≤20 条，超出按严重度截断（G6）
  const all = [...needHuman, ...pending, ...done];
  const overflow = all.length - APPROVAL_LIMITS.packageMaxItems;
  let truncated = 0;
  if (overflow > 0) {
    truncated = overflow;
    let cut = overflow;
    while (cut > 0 && done.length > 0) { done.pop(); cut--; }
    while (cut > 0 && pending.length > 0) { pending.pop(); cut--; }
    while (cut > 0 && needHuman.length > 0) { needHuman.pop(); cut--; }
  }

  return {
    done, pending, needHuman, truncated,
    stats: { done: done.length, pending: pending.length, need_human: needHuman.length, credits_used: credits },
  };
}

/* ---------- PG 装配：取夜间窗口事件 → 投影 → 落库留痕 ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageItem(value: unknown, severity: PackageItem["severity"]): value is PackageItem {
  return isRecord(value)
    && typeof value.eventId === "string" && value.eventId.length > 0
    && typeof value.summary === "string"
    && value.severity === severity
    && Array.isArray(value.fenceVersions) && value.fenceVersions.every((version) => typeof version === "string")
    && (value.snapshotUri === undefined || typeof value.snapshotUri === "string");
}

function isPackageStats(value: unknown): value is NightPackage["stats"] {
  return isRecord(value)
    && [value.done, value.pending, value.need_human].every((count) =>
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    && typeof value.credits_used === "number" && Number.isFinite(value.credits_used);
}

function samePackageStats(value: unknown, expected: NightPackage["stats"]): boolean {
  return isPackageStats(value)
    && value.done === expected.done && value.pending === expected.pending
    && value.need_human === expected.need_human && value.credits_used === expected.credits_used;
}

function isNightPackage(value: unknown): value is NightPackage {
  if (!isRecord(value) || !isPackageStats(value.stats)
    || typeof value.truncated !== "number" || !Number.isSafeInteger(value.truncated) || value.truncated < 0
    || !Array.isArray(value.done) || !value.done.every((item) => isPackageItem(item, 1))
    || !Array.isArray(value.pending) || !value.pending.every((item) => isPackageItem(item, 2))
    || !Array.isArray(value.needHuman) || !value.needHuman.every((item) => isPackageItem(item, 3))) return false;
  return value.done.length + value.pending.length + value.needHuman.length <= APPROVAL_LIMITS.packageMaxItems
    && value.stats.done === value.done.length && value.stats.pending === value.pending.length
    && value.stats.need_human === value.needHuman.length;
}

/** 首次只增快照是交付结果；损坏旧记录不能用现场重算冒充已交付包。 */
function storedPackage(
  payload: unknown,
  scope: { tenantId: string; workspaceId: string },
  runId: string,
  runStats: unknown,
): NightPackage {
  if (!isRecord(payload) || !isRecord(payload.who) || !isRecord(payload.context)
    || !isRecord(payload.object) || !isRecord(payload.decision) || !isRecord(payload.decision.after)) {
    throw new Error(`夜班「${runId}」缺少有效首次交付快照`);
  }
  const after = payload.decision.after;
  if (payload.who.type !== "system" || payload.who.id !== "night-shift"
    || payload.context.tenant_id !== scope.tenantId || payload.context.workspace_id !== scope.workspaceId
    || payload.object.type !== "store" || payload.object.id !== scope.workspaceId
    || payload.decision.action !== "night.package.deliver" || after.runId !== runId
    || !isNightPackage(after.package) || !samePackageStats(after.stats, after.package.stats)
    || after.truncated !== after.package.truncated || !samePackageStats(runStats, after.package.stats)) {
    throw new Error(`夜班「${runId}」首次交付快照或统计不一致`);
  }
  return after.package;
}

export async function deliverPackage(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  runId: string,
  window: { from: string; to: string },
): Promise<NightPackage> {
  const client = await app.connect();
  let discardClient = false;
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

    // 同 run 的首次交付与重试在一把行锁内串行；工作区须真正属于调用租户。
    const run = (await client.query<{ status: string; stats: unknown }>(
      `SELECT nr.status, nr.stats FROM night_runs nr
       JOIN workspaces w ON w.id=nr.workspace_id AND w.tenant_id=$3
       WHERE nr.id=$1 AND nr.workspace_id=$2 FOR UPDATE OF nr`,
      [runId, scope.workspaceId, scope.tenantId],
    )).rows[0];
    if (!run) throw new Error(`夜班「${runId}」在本工作区不存在`);

    const firstDelivery = (await client.query<{ payload: unknown }>(
      `SELECT payload FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2
         AND payload->'decision'->>'action'='night.package.deliver'
         AND payload->'decision'->'after'->>'runId'=$3
       ORDER BY seq LIMIT 1`,
      [scope.tenantId, scope.workspaceId, runId],
    )).rows[0];
    if (run.status === "package_generated") {
      const pkg = storedPackage(firstDelivery?.payload, scope, runId, run.stats);
      await client.query("COMMIT");
      return pkg;
    }
    if (!["running", "paused", "ready"].includes(run.status) || firstDelivery) {
      throw new Error(`夜班「${runId}」状态 ${run.status} 与交付记录不一致`);
    }

    const r = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
       ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, window.from, window.to],
    );
    const pkg = projectNightPackage(r.rows.map((x) => x.payload));

    // 状态、统计与唯一投递事件在同一个事务中写入（D16/G8）。
    const upd = await client.query(
      `UPDATE night_runs SET status='package_generated', stats=$3 WHERE id=$1 AND workspace_id=$2 AND status IN ('running','paused','ready')`,
      [runId, scope.workspaceId, JSON.stringify(pkg.stats)],
    );
    if (upd.rowCount !== 1) throw new Error(`夜班「${runId}」交付状态更新失败`);
    // 保留 gateway 参数的公开签名；实际追加必须复用持锁 app client。
    const appended = await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: "night-shift", type: "system" },
    }, {
      who: { type: "system", id: "night-shift" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "夜班" },
      object: { type: "store", id: scope.workspaceId },
      decision: {
        action: "night.package.deliver",
        after: { runId, stats: pkg.stats, truncated: pkg.truncated, package: pkg },
      },
      rule_impact: [],
    } as never);
    // 读取网关脱敏和 JSON 持久化后的真实结果，使首返与所有重试逐字段一致。
    const persisted = (await client.query<{ payload: unknown }>(
      `SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3`,
      [scope.tenantId, scope.workspaceId, appended.eventId],
    )).rows[0];
    const result = storedPackage(persisted?.payload, scope, runId, pkg.stats);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discardClient = true;
      throw new AggregateError([err, rollbackError], "夜班交付失败且回滚确认失败");
    }
    throw err;
  } finally {
    client.release(discardClient);
  }
}
