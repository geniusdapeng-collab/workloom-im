import { configDefaults, defineConfig } from "vitest/config";

// 这四套契约要求任务专属的私有 Unix PostgreSQL 集群与合成数据库：aipm.snapshot
// 校验 /tmp/wl-aipm-proof-*，devtools.cancel/thread 与 secretary.approval 校验
// /tmp/wl-raw-scope-* 及各自的 *TASK_OWNED 哨兵。缺少专属 runner 时它们在
// beforeAll 主动 fail closed，因此不属于通用 db-gate 的发现面。
//
// 普通/直接运行保持原有发现（哨兵缺失即 fail closed，不静默跳过）；只有泛化 CI
// 显式设置 WORKLOOM_GENERIC_DB_CI=1 时才把它们交给专属阶段的 runner。
// 与 packages/base/vitest.config.mjs 同一约定。
export const taskOwnedPgTestFiles = [
  "src/service/aipm.snapshot.pg.test.ts",
  "src/service/devtools.cancel.pg.test.ts",
  "src/service/devtools.thread.pg.test.ts",
  "src/service/secretary.approval.pg.test.ts",
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.WORKLOOM_GENERIC_DB_CI === "1" ? taskOwnedPgTestFiles : []),
    ],
  },
});
