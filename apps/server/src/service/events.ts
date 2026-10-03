/**
 * service · 五元事件写入助手（D16 同事务纪律）
 *  - serviceTx：可信双作用域 → BEGIN + set_config 双 GUC → 回调 → COMMIT/ROLLBACK
 *  - appendEventOn：事务内经 gatewayAppendOnClient 落五元事件（三段瀑布 + 哈希链 + 幂等）
 * C 端 actor 为 c_user（who.type=human，id=cUserId）；B 端为成员编号（MEM-xxx）；系统动作 type=system。
 */
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, type ActorInfo } from "@workloom/base/workdata";
import { requireServiceScope, runWithServiceScope, type ServiceScope } from "./scope.js";
export type { ServiceScope } from "./scope.js";

/** 在已认证的 RLS 上下文执行；非 HTTP 调用方可传已有可信 scope，禁止属主反查。 */
export async function serviceTx<T>(
  workspaceId: string,
  fn: (client: pg.PoolClient, scope: ServiceScope) => Promise<T>,
  explicitScope?: ServiceScope,
): Promise<T> {
  const scope = requireServiceScope(workspaceId, explicitScope);
  const pool = getAppPool();
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true), set_config('app.tenant_id', $2, true)", [scope.workspaceId, scope.tenantId]);
    const result = await runWithServiceScope(scope, () => fn(client, scope));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([err, rollbackError], "serviceTx: 事务回滚失败", { cause: err });
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

/** 单查询便捷封装：RLS 事务上下文内执行一条 SQL 并返回行（service 层全部读写必须走 RLS 上下文） */
export async function svcQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  workspaceId: string,
  sql: string,
  params: unknown[] = [],
  explicitScope?: ServiceScope,
): Promise<T[]> {
  return serviceTx(workspaceId, async (client) => {
    const r = await client.query(sql, params);
    return r.rows as T[];
  }, explicitScope);
}

/** 事务内落五元事件（调用方须在 serviceTx 回调内使用，与业务写同一 COMMIT） */
export async function appendEventOn(
  client: pg.PoolClient,
  scope: ServiceScope,
  actor: ActorInfo,
  draft: { objectType: string; objectId: string; action: string; after?: unknown; channel?: string; basis?: string[] },
): Promise<{ eventId: string }> {
  const ev = await gatewayAppendOnClient(client, { ...scope, actor }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: draft.channel ?? "inapp" },
    object: { type: draft.objectType, id: draft.objectId },
    decision: { action: draft.action, after: draft.after, ...(draft.basis?.length ? { basis: draft.basis } : {}) },
    rule_impact: [],
  });
  return { eventId: ev.eventId };
}
