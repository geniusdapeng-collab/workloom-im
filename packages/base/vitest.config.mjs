import { configDefaults, defineConfig } from "vitest/config";

// These guards require runner-owned Unix sockets and legacy rows.
// Ordinary/direct runs keep their previous behavior. Only generic CI opts in;
// the mandatory db-gate invokes scripts/test-owned-pg.mjs for the four legacy
// suites and scripts/test-owned-ceo-night-pg.mjs for the three CEO/night suites.
export const ownedPgTestFiles = [
  "im-channels/im-inbound.pg.test.ts",
  "inspection/inspection-idempotency.test.ts",
  "skills/skills-security.pg.test.ts",
  "skills/skills-upgrade.pg.test.ts",
];

// CEO 并发/撤权与首次夜班决策包同样只由任务专属 runner 执行；泛化 base 阶段若
// 不排除它们，vitest 会发现却整块 skip，断言永远不会变红——排除必须由必需阶段的
// test-owned-ceo-night-pg.mjs 补偿，否则等于静默摘掉必需检查。
export const ownedCeoNightPgTestFiles = [
  "captain/ceo-escalation.pg.test.ts",
  "captain/ceo-withdrawal.pg.test.ts",
  "night-shift/night-package.pg.test.ts",
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.WORKLOOM_GENERIC_DB_CI === "1" ? [...ownedPgTestFiles, ...ownedCeoNightPgTestFiles] : []),
    ],
  },
});
