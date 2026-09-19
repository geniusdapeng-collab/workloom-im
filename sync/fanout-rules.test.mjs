import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  autoMergeEligibility,
  codeMergeEligibility,
  hasInFlightSyncPull,
  isAllowlistedPath,
  matchesGlob,
  normalizeBranchRef,
  requiredAssetDigests,
  syncDrift,
} from "./fanout-rules.mjs";

const pull = (overrides = {}) => ({
  number: "7",
  state: "open",
  mergeable_state: "mergeable",
  head: { ref: "sync/base-1234abcd" },
  ...overrides,
});
const ok = [{ context: "static-gate", state: "success" }];

test("glob：** 跨目录，* 不跨目录", () => {
  assert.equal(matchesGlob("sync/**", "sync/base/fanout.mjs"), true);
  assert.equal(matchesGlob("WORKLOOM_PRODUCT_CONTEXT.md", "WORKLOOM_PRODUCT_CONTEXT.md"), true);
  assert.equal(matchesGlob("docs/*.md", "docs/DEVELOPMENT-PROTOCOL.md"), true);
  assert.equal(matchesGlob("docs/*.md", "docs/sub/x.md"), false);
  assert.equal(matchesGlob("*.md", "README.md"), true);
});

test("白名单只覆盖根级受控资产，不覆盖运行时代码", () => {
  assert.equal(isAllowlistedPath(".workloom-base-sync.json"), true);
  assert.equal(isAllowlistedPath("docs/DEVELOPMENT-PROTOCOL.md"), true);
  assert.equal(isAllowlistedPath("packages/base/fence-engine/index.ts"), false);
  assert.equal(isAllowlistedPath("apps/web/src/App.tsx"), false);
});

test("纯同步 PR：白名单文件 + 门禁全绿 → 允许自动合并", () => {
  const verdict = autoMergeEligibility({
    pull: pull(),
    files: ["WORKLOOM_PRODUCT_CONTEXT.md", ".workloom-base-sync.json"],
    statuses: ok,
  });
  assert.deepEqual(verdict, { eligible: true, reasons: [] });
});

test("自动合并拒绝：门禁红 / 非 sync 分支 / 文件出圈 / 无门禁结果 / 平台不可合并", () => {
  const failing = autoMergeEligibility({
    pull: pull(),
    files: ["WORKLOOM_PRODUCT_CONTEXT.md"],
    statuses: [{ context: "protocol-gate", state: "error" }],
  });
  assert.equal(failing.eligible, false);
  assert.match(failing.reasons.join("；"), /门禁未通过：protocol-gate=error/);

  const wrongBranch = autoMergeEligibility({ pull: pull({ head: { ref: "task/T-2026-0919-0003" } }), files: ["AGENTS.md"], statuses: ok });
  assert.equal(wrongBranch.eligible, false);

  const outOfScope = autoMergeEligibility({ pull: pull(), files: ["WORKLOOM_PRODUCT_CONTEXT.md", "apps/server/src/index.ts"], statuses: ok });
  assert.equal(outOfScope.eligible, false);
  assert.match(outOfScope.reasons.join("；"), /不在自动合并白名单/);

  const noGate = autoMergeEligibility({ pull: pull(), files: ["AGENTS.md"], statuses: [] });
  assert.equal(noGate.eligible, false);
  assert.match(noGate.reasons.join("；"), /没有状态检查结果/);

  const conflicted = autoMergeEligibility({ pull: pull({ mergeable_state: "conflict" }), files: ["AGENTS.md"], statuses: ok });
  assert.equal(conflicted.eligible, false);
  assert.match(conflicted.reasons.join("；"), /平台可合并状态=conflict/);
});

test("在途同步 PR 检测：只认 sync/base-* 前缀", () => {
  const open = [{ head: { ref: "refs/heads/task/T-1" } }, { head: { ref: "refs/heads/sync/base-deadbee" } }];
  assert.equal(hasInFlightSyncPull(open)?.head.ref, "refs/heads/sync/base-deadbee");
  assert.equal(hasInFlightSyncPull([{ head: { ref: "refs/heads/docs/context-2026-09-19" } }]), null);
});

test("refs/heads 前缀必须被规范化（CNB 列表接口原样返回）", () => {
  assert.equal(normalizeBranchRef("refs/heads/sync/base-abc"), "sync/base-abc");
  assert.equal(normalizeBranchRef("sync/base-abc"), "sync/base-abc");
  assert.equal(normalizeBranchRef(undefined), "");
  const verdict = autoMergeEligibility({
    pull: pull({ head: { ref: "refs/heads/sync/base-deadbee" } }),
    files: ["WORKLOOM_PRODUCT_CONTEXT.md"],
    statuses: ok,
  });
  assert.equal(verdict.eligible, true);
});

test("存量文档分发分支只在显式开启 legacy 时才可自动合并", () => {
  const legacy = { pull: pull({ head: { ref: "docs/context-2026-09-19" } }), files: ["WORKLOOM_PRODUCT_CONTEXT.md"], statuses: ok };
  assert.equal(autoMergeEligibility(legacy).eligible, false);
  assert.equal(autoMergeEligibility(legacy, { acceptPrefixes: ["sync/base-", "docs/context-"] }).eligible, true);
});

const codePull = (overrides = {}) => ({
  number: "12",
  state: "open",
  mergeable_state: "mergeable",
  is_wip: false,
  labels: [],
  head: { ref: "task/T-2026-0919-0001" },
  ...overrides,
});
const oneHour = 60 * 60 * 1000;

test("代码 PR：门禁全绿 + 冷却期已过 + 无风险标签 → 允许串行合并", () => {
  const verdict = codeMergeEligibility({
    pull: codePull(),
    files: ["apps/server/src/service/eval.ts", "docs/exam-playbook.md"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.deepEqual(verdict, { eligible: true, reasons: [] });
});

test("代码 PR 拒绝：risk/review、risk/block、WIP", () => {
  const review = codeMergeEligibility({
    pull: codePull({ labels: [{ name: "risk/review" }] }),
    files: ["apps/web/src/App.tsx"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.equal(review.eligible, false);
  assert.match(review.reasons.join("；"), /risk\/review 标签/);

  const blocked = codeMergeEligibility({
    pull: codePull({ labels: ["risk/block"] }),
    files: ["apps/web/src/App.tsx"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join("；"), /risk\/block 标签/);

  const wip = codeMergeEligibility({
    pull: codePull({ is_wip: true }),
    files: ["apps/web/src/App.tsx"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.equal(wip.eligible, false);
  assert.match(wip.reasons.join("；"), /WIP/);
});

test("代码 PR 拒绝：门禁红 / 无门禁结果 / 冲突 / 冷却期内 / 非任务车道", () => {
  const red = codeMergeEligibility({
    pull: codePull(),
    files: ["apps/web/src/App.tsx"],
    statuses: [{ context: "static-gate", state: "error" }],
    headAgeMs: oneHour,
  });
  assert.match(red.reasons.join("；"), /门禁未通过：static-gate=error/);

  const noGate = codeMergeEligibility({ pull: codePull(), files: ["apps/web/src/App.tsx"], statuses: [], headAgeMs: oneHour });
  assert.match(noGate.reasons.join("；"), /没有状态检查结果/);

  const conflicted = codeMergeEligibility({
    pull: codePull({ mergeable_state: "conflict" }),
    files: ["apps/web/src/App.tsx"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.match(conflicted.reasons.join("；"), /平台可合并状态=conflict/);

  const hot = codeMergeEligibility({ pull: codePull(), files: ["apps/web/src/App.tsx"], statuses: ok, headAgeMs: 60_000 });
  assert.match(hot.reasons.join("；"), /冷却期 10 分钟/);

  const unknownAge = codeMergeEligibility({ pull: codePull(), files: ["apps/web/src/App.tsx"], statuses: ok, headAgeMs: null });
  assert.match(unknownAge.reasons.join("；"), /无法确认分支最近提交时间/);

  const wrongLane = codeMergeEligibility({
    pull: codePull({ head: { ref: "release/v1" } }),
    files: ["apps/web/src/App.tsx"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.match(wrongLane.reasons.join("；"), /不在代码合并车道/);
});

test("代码 PR 拒绝：治理与高风险路径不由无人值守扫描合并", () => {
  for (const path of ["sync/fanout-rules.mjs", "docs/DEVELOPMENT-PROTOCOL.md", ".cnb.yml", "platform-ops/deploy.yml", "packages/db/migrations/0001_init.sql", "AGENTS.md"]) {
    const verdict = codeMergeEligibility({
      pull: codePull(),
      files: [path],
      statuses: ok,
      headAgeMs: oneHour,
    });
    assert.equal(verdict.eligible, false, `${path} 应被治理路径拦截`);
    assert.match(verdict.reasons.join("；"), /治理\/高风险路径/);
  }
  const normal = codeMergeEligibility({
    pull: codePull(),
    files: ["packages/base/tenancy/index.ts"],
    statuses: ok,
    headAgeMs: oneHour,
  });
  assert.equal(normal.eligible, true);
});

test("同步回落车道：受控资产（allowPaths 命中）不算治理路径，其余治理路径仍拦截", () => {
  const allowPaths = ["WORKLOOM_PRODUCT_CONTEXT.md", "AGENTS.md", "docs/DEVELOPMENT-PROTOCOL.md", "sync/**"];
  const controlled = codeMergeEligibility({
    pull: codePull({ head: { ref: "sync/base-af278afd-full" } }),
    files: ["docs/DEVELOPMENT-PROTOCOL.md", "AGENTS.md", "sync/base-scope.json", ".workloom-runtime-deps/package.json"],
    statuses: ok,
    headAgeMs: oneHour,
  }, { branchPrefixes: ["sync/"], allowPaths });
  assert.equal(controlled.eligible, true, controlled.reasons.join("；"));

  const stillBlocked = codeMergeEligibility({
    pull: codePull({ head: { ref: "sync/base-af278afd-full" } }),
    files: ["docs/DEVELOPMENT-PROTOCOL.md", ".cnb.yml"],
    statuses: ok,
    headAgeMs: oneHour,
  }, { branchPrefixes: ["sync/"], allowPaths });
  assert.equal(stillBlocked.eligible, false);
  assert.match(stillBlocked.reasons.join("；"), /治理\/高风险路径：.cnb.yml/);
});

test("required-only 漂移只看资产摘要，full 还看基座发布点", () => {
  const digests = { "WORKLOOM_PRODUCT_CONTEXT.md": "aaa", "AGENTS.md#managed-section": "bbb" };
  const aligned = {
    lastSyncedBaseSha: "old",
    lastRequiredAssetsBaseSha: "old",
    requiredRootAssetsSha256: { ...digests },
  };
  assert.equal(syncDrift({ state: aligned, mode: "required-only", baseSha: "newsha", digests }).drift, false);
  assert.equal(syncDrift({ state: aligned, mode: "full", baseSha: "newsha", digests }).drift, true);

  const drifted = { ...aligned, requiredRootAssetsSha256: { ...digests, "WORKLOOM_PRODUCT_CONTEXT.md": "ccc" } };
  const verdict = syncDrift({ state: drifted, mode: "required-only", baseSha: "newsha", digests });
  assert.equal(verdict.drift, true);
  assert.match(verdict.reasons.join("；"), /根级资产漂移：WORKLOOM_PRODUCT_CONTEXT.md/);

  assert.equal(syncDrift({ state: null, mode: "required-only", baseSha: "s", digests }).drift, true);
});

test("requiredAssetDigests 与 base-sync 的 state 口径一致（整文件 + 复制文件 + 受控块）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fanout-rules-"));
  try {
    const write = (rel, content) => {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    write("WORKLOOM_PRODUCT_CONTEXT.md", "# 全景\n");
    write("sync/heartbeat-template.yml", "name: base-sync\n");
    write("AGENTS.md", "# 头部\n<!-- WORKLOOM-CONTEXT:BEGIN -->\n共享规则\n<!-- WORKLOOM-CONTEXT:END -->\n## 本仓\n");
    const scope = {
      requiredRootAssets: {
        files: ["WORKLOOM_PRODUCT_CONTEXT.md"],
        copiedFiles: { ".github/workflows/base-sync-heartbeat.yml": { source: "sync/heartbeat-template.yml" } },
        managedSections: {
          "AGENTS.md": {
            beginMarker: "<!-- WORKLOOM-CONTEXT:BEGIN -->",
            endMarker: "<!-- WORKLOOM-CONTEXT:END -->",
          },
        },
      },
    };
    const digests = requiredAssetDigests(dir, scope);
    assert.deepEqual(Object.keys(digests).sort(), [
      ".github/workflows/base-sync-heartbeat.yml",
      "AGENTS.md#managed-section",
      "WORKLOOM_PRODUCT_CONTEXT.md",
    ]);
    assert.deepEqual(requiredAssetDigests(dir, scope), digests, "同一内容必须得到同一摘要");

    write("WORKLOOM_PRODUCT_CONTEXT.md", "# 全景 v2\n");
    assert.notEqual(requiredAssetDigests(dir, scope)["WORKLOOM_PRODUCT_CONTEXT.md"], digests["WORKLOOM_PRODUCT_CONTEXT.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
