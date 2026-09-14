/**
 * 活库契约：考试题只能从已验证活动 Bundle 或服务端显式夹具装载；题源门禁
 * 失败时题库、场次、考生与事件账本均保持零写入。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("考试院题源 PG 契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `tenant-eval-source-${suffix}`;
  const activeWorkspaceId = `ws-eval-active-${suffix}`;
  const emptyWorkspaceId = `ws-eval-empty-${suffix}`;
  let seedQuestionsIfEmpty: typeof import("./eval.js").seedQuestionsIfEmpty;
  let expectedQuestionCount = 0;

  beforeAll(async () => {
    ({ seedQuestionsIfEmpty } = await import("./eval.js"));
    const { loadVerifiedBundleEvalQuestions } = await import("@workloom/base/bundles");
    expectedQuestionCount = loadVerifiedBundleEvalQuestions("ai-pm").questions.length;
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'community')`, [tenantId, "考试题源隔离租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, bundle_id)
       VALUES ($1,$3,'活动题源工作区',$4,'ai-pm','ai-pm'),
              ($2,$3,'无题源工作区',$5,'general',NULL)`,
      [activeWorkspaceId, emptyWorkspaceId, tenantId, `eval-active-${suffix}`, `eval-empty-${suffix}`],
    );
    await owner.query(
      `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
       VALUES ($1,$2,'ai-pm','{}','active')`,
      [`bi-eval-${suffix}`, activeWorkspaceId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM eval_questions WHERE workspace_id = ANY($1::text[])`, [[activeWorkspaceId, emptyWorkspaceId]]).catch(() => undefined);
    await owner.query(`DELETE FROM bundle_installs WHERE workspace_id = ANY($1::text[])`, [[activeWorkspaceId, emptyWorkspaceId]]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[activeWorkspaceId, emptyWorkspaceId]]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("活动 Bundle 题集按工作区确定性装载且可幂等重跑", async () => {
    expect(await seedQuestionsIfEmpty(activeWorkspaceId)).toBe(expectedQuestionCount);
    expect(await seedQuestionsIfEmpty(activeWorkspaceId)).toBe(0);
    const stored = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM eval_questions WHERE workspace_id=$1`,
      [activeWorkspaceId],
    );
    expect(Number(stored.rows[0]?.count)).toBe(expectedQuestionCount);
  });

  it("没有活动 Bundle 时失败关闭并保持业务表与事件账本零写入", async () => {
    const before = await owner.query<{ questions: string; exams: string; users: string; events: string }>(
      `SELECT
         (SELECT count(*) FROM eval_questions WHERE workspace_id=$1)::text AS questions,
         (SELECT count(*) FROM eval_exams WHERE workspace_id=$1)::text AS exams,
         (SELECT count(*) FROM c_users WHERE workspace_id=$1)::text AS users,
         (SELECT count(*) FROM biz_events WHERE workspace_id=$1)::text AS events`,
      [emptyWorkspaceId],
    );
    await expect(seedQuestionsIfEmpty(emptyWorkspaceId)).rejects.toThrow(/没有生效装配|拒绝开考/);
    const after = await owner.query<{ questions: string; exams: string; users: string; events: string }>(
      `SELECT
         (SELECT count(*) FROM eval_questions WHERE workspace_id=$1)::text AS questions,
         (SELECT count(*) FROM eval_exams WHERE workspace_id=$1)::text AS exams,
         (SELECT count(*) FROM c_users WHERE workspace_id=$1)::text AS users,
         (SELECT count(*) FROM biz_events WHERE workspace_id=$1)::text AS events`,
      [emptyWorkspaceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]).toEqual({ questions: "0", exams: "0", users: "0", events: "0" });
  });
});
