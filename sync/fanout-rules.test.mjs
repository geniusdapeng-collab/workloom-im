import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  autoMergeEligibility,
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
