import { configDefaults, defineConfig } from "vitest/config";

// These four unchanged guards require runner-owned Unix sockets and legacy rows.
// Ordinary/direct runs keep their previous behavior. Only generic CI opts in;
// the mandatory db-gate invokes scripts/test-owned-pg.mjs for all four suites.
export const ownedPgTestFiles = [
  "im-channels/im-inbound.pg.test.ts",
  "inspection/inspection-idempotency.test.ts",
  "skills/skills-security.pg.test.ts",
  "skills/skills-upgrade.pg.test.ts",
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.WORKLOOM_GENERIC_DB_CI === "1" ? ownedPgTestFiles : []),
    ],
  },
});
