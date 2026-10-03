/** 技能生命周期统一事务上下文：真实工作区属主与双 GUC 一致才可消费私有资产。 */
import type pg from "pg";

export interface SkillScope { tenantId: string; workspaceId: string }

export class SkillScopeError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("技能作用域不存在或租户与工作区归属不一致");
    this.name = "SkillScopeError";
  }
}

/** 调用方须已 BEGIN；设置仅在该事务内有效，连接归池后不残留租户身份。 */
export async function setSkillScope(client: pg.PoolClient, scope: SkillScope): Promise<void> {
  if (!scope.tenantId.trim() || !scope.workspaceId.trim()) throw new SkillScopeError();
  await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)",
    [scope.tenantId, scope.workspaceId]);
  const workspace = await client.query(
    "SELECT 1 FROM workspaces WHERE id=$1 AND tenant_id=$2", [scope.workspaceId, scope.tenantId]);
  if (workspace.rowCount !== 1) throw new SkillScopeError();
}

const failedRollbacks = new WeakSet<pg.PoolClient>();

/** 回滚失败的连接必须销毁，不能带着未知事务身份归池。 */
export function releaseSkillClient(client: pg.PoolClient): void {
  const destroy = failedRollbacks.delete(client);
  client.release(destroy);
}

export async function rollbackSkills(client: pg.PoolClient, error: unknown): Promise<never> {
  try { await client.query("ROLLBACK"); }
  catch (rollbackError) {
    failedRollbacks.add(client);
    throw new AggregateError([error, rollbackError], "技能事务与回滚均失败");
  }
  throw error;
}

export async function withSkillScope<T>(
  app: pg.Pool, scope: SkillScope, action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await setSkillScope(client, scope);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { return await rollbackSkills(client, error); }
  finally { releaseSkillClient(client); }
}
