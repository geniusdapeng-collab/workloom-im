import { configDefaults, defineConfig } from "vitest/config";

// 这五套契约要求**任务专属**的私有 Unix PostgreSQL 集群与哨兵：
//   · aipm.snapshot 校验 /tmp/wl-aipm-proof-* 与 /aipm_proof_* 库名；
//   · devtools.cancel / devtools.thread / secretary.approval 校验 /tmp/wl-raw-scope-*
//     及各自的 *TASK_OWNED 哨兵；
//   · kb-publish 校验 /tmp/wl-kb-pg-*、kb_publish 库名与 owner nonce 哨兵。
// 通用 db-gate 的共享 Postgres 与它们不兼容，缺集群时 beforeAll 会主动 fail closed。
//
// 因此泛化 CI 显式设置 WORKLOOM_GENERIC_DB_CI=1 时才把它们移出发现面——**并且只允许在
// scripts/test-owned-server-pg.mjs 这条必需阶段真实执行它们的前提下**。排除不是豁免：
// scripts/test-owned-pg-contract.test.mjs 会断言补偿 runner 存在、清单一致、
// 哨兵仍在契约内、且该阶段不继承本开关。普通/直接运行保持原有发现（哨兵缺失即 fail closed）。
// 与 packages/base/vitest.config.mjs 同一约定。
export const taskOwnedPgTestFiles = [
  "src/service/aipm.snapshot.pg.test.ts",
  "src/service/devtools.cancel.pg.test.ts",
  "src/service/devtools.thread.pg.test.ts",
  "src/service/secretary.approval.pg.test.ts",
  "src/service/kb-publish.pg.test.ts",
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.WORKLOOM_GENERIC_DB_CI === "1" ? taskOwnedPgTestFiles : []),
    ],
  },
});
