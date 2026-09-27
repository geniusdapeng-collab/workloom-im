import { test } from "node:test";
import assert from "node:assert/strict";

import { autoMergeEligibility, codeMergeEligibility } from "./fanout-rules.mjs";
import { mergeNow } from "./merge-sync-prs.mjs";

const makePull = (overrides = {}) => ({
  number: 7,
  title: "sync(base): 根级资产同步",
  state: "open",
  mergeable_state: "mergeable",
  is_wip: false,
  labels: [],
  head: { ref: "refs/heads/sync/base-1234abcd", sha: "head-1" },
  base: { ref: "refs/heads/main", sha: "base-1" },
  ...overrides,
});
const candidate = {
  number: 7,
  title: "sync(base): 根级资产同步",
  head: "refs/heads/sync/base-1234abcd",
  headSha: "head-1",
  baseSha: "base-1",
};
const report = () => ({ merged: [], skipped: [], failed: [] });

function servicesFor(latest, files, statuses = [{ context: "static-gate", state: "success" }]) {
  let merged = false;
  let mergeCalls = 0;
  return {
    services: {
      getPull: async () => merged ? { ...latest, state: "closed", is_merged: true } : latest,
      inspectSync: async (_slug, pull) => ({
        ...autoMergeEligibility({ pull, files, statuses }),
        head: pull.head.ref,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
      }),
      inspectCode: async (_slug, pull, options) => ({
        ...codeMergeEligibility({ pull, files, statuses, headAgeMs: 60 * 60 * 1000 }, options),
        head: pull.head.ref,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
      }),
      mergePull: async () => { mergeCalls += 1; merged = true; return {}; },
    },
    mergeCalls: () => mergeCalls,
  };
}

test("合并前复核：正常根级资产同步仍可合并", async () => {
  const state = report();
  const { services, mergeCalls } = servicesFor(makePull(), ["WORKLOOM_PRODUCT_CONTEXT.md", ".workloom-base-sync.json"]);
  await mergeNow(state, "workloom-ai/workloom-hotel", candidate, "squash", "sync", { acceptPrefixes: ["sync/base-"] }, services);
  assert.equal(mergeCalls(), 1);
  assert.equal(state.merged.length, 1);
  assert.deepEqual(state.skipped, []);
});

test("合并前复核：改动治理脚本、风险标签或 WIP 后不调用合并接口", async () => {
  const cases = [
    { latest: makePull(), files: ["sync/merge-sync-prs.mjs", ".workloom-base-sync.json"], expected: /不在自动合并白名单/ },
    { latest: makePull({ labels: ["risk/block"] }), files: ["WORKLOOM_PRODUCT_CONTEXT.md"], expected: /risk\/block/ },
    { latest: makePull({ is_wip: true }), files: ["WORKLOOM_PRODUCT_CONTEXT.md"], expected: /WIP/ },
  ];
  for (const item of cases) {
    const state = report();
    const { services, mergeCalls } = servicesFor(item.latest, item.files);
    await mergeNow(state, "workloom-ai/workloom-hotel", candidate, "squash", "sync", { acceptPrefixes: ["sync/base-"] }, services);
    assert.equal(mergeCalls(), 0);
    assert.match(state.skipped[0].reasons.join("；"), item.expected);
  }
});

test("合并前复核：源分支或目标 main 变化后退回队列", async () => {
  for (const latest of [
    makePull({ head: { ref: candidate.head, sha: "head-2" } }),
    makePull({ base: { ref: "refs/heads/main", sha: "base-2" } }),
    makePull({ base: { ref: "refs/heads/release", sha: "base-1" } }),
  ]) {
    const state = report();
    const { services, mergeCalls } = servicesFor(latest, ["WORKLOOM_PRODUCT_CONTEXT.md"]);
    await mergeNow(state, "workloom-ai/workloom-hotel", candidate, "squash", "sync", { acceptPrefixes: ["sync/base-"] }, services);
    assert.equal(mergeCalls(), 0);
    assert.equal(state.skipped.length, 1);
  }
});

test("合并前复核：门禁变红与代码车道治理路径仍拦截", async () => {
  const red = servicesFor(makePull(), ["WORKLOOM_PRODUCT_CONTEXT.md"], [{ context: "static-gate", state: "failure" }]);
  const redReport = report();
  await mergeNow(redReport, "workloom-ai/workloom-hotel", candidate, "squash", "sync", { acceptPrefixes: ["sync/base-"] }, red.services);
  assert.equal(red.mergeCalls(), 0);
  assert.match(redReport.skipped[0].reasons.join("；"), /门禁未通过/);

  const governance = servicesFor(makePull(), ["sync/base-sync.mjs", "WORKLOOM_PRODUCT_CONTEXT.md"]);
  const governanceReport = report();
  await mergeNow(governanceReport, "workloom-ai/workloom-hotel", candidate, "squash", "code", {
    codeOptions: { branchPrefixes: ["sync/base-"], allowPaths: ["WORKLOOM_PRODUCT_CONTEXT.md"] },
  }, governance.services);
  assert.equal(governance.mergeCalls(), 0);
  assert.match(governanceReport.skipped[0].reasons.join("；"), /治理\/高风险路径/);
});
