/**
 * 验证 AI 产品经理示例包重复装配不会改写已经存在的审批证据。
 * 审批只增不改；演示待办过期也不能靠延长旧 snapshot 来伪装成新审批。
 */
import assert from "node:assert/strict";
import pg from "pg";

import { seedAiPm } from "./seed-aipm.js";

const DATABASE_URL = process.env.DATABASE_URL;
assert(DATABASE_URL, "缺少 DATABASE_URL，拒绝在未知数据库上验证审批证据");

interface ApprovalEvidence {
  approval_id: string;
  event_id: string;
  channel: string;
  status: string;
  gesture: string | null;
  snapshot: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

async function readEvidence(client: pg.Client): Promise<ApprovalEvidence[]> {
  const result = await client.query<ApprovalEvidence>(
    `SELECT approval_id, event_id, channel, status, gesture::text, snapshot::text,
            decided_by, decided_at::text, created_at::text
       FROM approvals
      WHERE approval_id LIKE 'apr-seed-aipm-%'
      ORDER BY approval_id`,
  );
  return result.rows;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const before = await readEvidence(client);
    assert(before.length > 0, "请先执行一次 db:seed:aipm，再验证幂等性");
    await seedAiPm();
    const after = await readEvidence(client);
    assert.deepEqual(after, before, "重复 seed 改写了既有审批证据");
    console.log(`✅ AI 产品经理种子审批证据保持不变（${after.length} 条）`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("AI 产品经理种子幂等性验证失败:", error);
  process.exit(1);
});
