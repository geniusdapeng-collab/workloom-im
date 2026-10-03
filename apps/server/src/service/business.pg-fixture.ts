/** Test-owned hotel business records. Never import this fixture from runtime code. */
import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";

export interface ServiceBusinessFixture {
  workspaceId: string;
  gold: { memberId: string; phone: string; orderIds: string[]; amountOrderId: string };
  silver: { memberId: string; phone: string; orderIds: string[] };
  dispose(): Promise<void>;
}

/** Setup/teardown uses the explicitly configured fixture owner; HTTP reads keep their real RLS roles. */
async function withOwnerTransaction<T>(
  databaseUrl: string,
  workspaceId: string,
  action: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let began = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "业务测试夹具事务与回滚均失败");
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

/** The stable assertions concern display/isolation, independently of any industry's example seed IDs. */
export async function createServiceBusinessFixture(workspaceId: string): Promise<ServiceBusinessFixture> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("业务测试夹具必须显式配置 DATABASE_URL");
  const nonce = randomUUID();
  const goldId = `mc014-${nonce}-gold`;
  const silverId = `mc014-${nonce}-silver`;
  const goldOrderIds = [`mc014-${nonce}-gold-current`, `mc014-${nonce}-gold-history`];
  const silverOrderIds = [`mc014-${nonce}-silver-current`];
  const [goldPhone, silverPhone] = await withOwnerTransaction(databaseUrl, workspaceId, async (client) => {
    const workspace = await client.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId]);
    if (workspace.rowCount !== 1) throw new Error(`业务测试夹具工作区不存在：${workspaceId}`);
    let phones: string[] | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidates = Array.from({ length: 2 }, () => `199${randomInt(100_000_000).toString().padStart(8, "0")}`);
      if (candidates[0] === candidates[1]) continue;
      const collision = await client.query(
        "SELECT 1 FROM demo_members WHERE workspace_id=$1 AND phone=ANY($2::text[])", [workspaceId, candidates],
      );
      if (collision.rowCount === 0) {
        phones = candidates;
        break;
      }
    }
    if (!phones) throw new Error("业务测试夹具无法分配独立手机号");
    await client.query(
      `INSERT INTO demo_members (workspace_id, member_id, name, phone, tier, points)
       VALUES ($1,$2,'测试金卡会员',$3,'金卡',2680), ($1,$4,'测试银卡会员',$5,'银卡',860)`,
      [workspaceId, goldId, phones[0], silverId, phones[1]],
    );
    await client.query(
      `INSERT INTO demo_orders (workspace_id, order_id, member_id, room_type, check_in, check_out, amount_fen, status)
       VALUES ($1,$2,$3,'豪华大床房','2026-08-21','2026-08-23',117600,'confirmed'),
              ($1,$4,$3,'行政双床房','2026-08-18','2026-08-19',68800,'done'),
              ($1,$5,$6,'山景大床房','2026-08-25','2026-08-26',52800,'confirmed')`,
      [workspaceId, goldOrderIds[0], goldId, goldOrderIds[1], silverOrderIds[0], silverId],
    );
    return phones as [string, string];
  });
  return {
    workspaceId,
    gold: { memberId: goldId, phone: goldPhone, orderIds: goldOrderIds, amountOrderId: goldOrderIds[0]! },
    silver: { memberId: silverId, phone: silverPhone, orderIds: silverOrderIds },
    async dispose() {
      await withOwnerTransaction(databaseUrl, workspaceId, async (client) => {
        // A successful /identity/bind can reference these synthetic members. Clear only those exact references.
        await client.query(
          "UPDATE c_users SET member_id=NULL, phone_hash=NULL WHERE workspace_id=$1 AND member_id=ANY($2::text[])",
          [workspaceId, [goldId, silverId]],
        );
        await client.query(
          "DELETE FROM demo_orders WHERE workspace_id=$1 AND order_id=ANY($2::text[])",
          [workspaceId, [...goldOrderIds, ...silverOrderIds]],
        );
        await client.query(
          "DELETE FROM demo_members WHERE workspace_id=$1 AND member_id=ANY($2::text[])",
          [workspaceId, [goldId, silverId]],
        );
      });
    },
  };
}
