import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertArchivePayloadBoundary,
  assertRuntimePayloadBoundary,
  findForbiddenArchiveEntries,
  loadPayloadPolicy,
  payloadPolicyFor,
} from "./payload-policy.mjs";

function product(overrides = {}) {
  return {
    schemaVersion: "workloom.product/v1",
    productId: "workloom-im",
    role: "base",
    displayName: "WorkLoom 织元",
    repository: "geniusdapeng-collab/workloom-im",
    demoWorkspaceSlug: "ai-pm-demo",
    demoMemberNo: "MEM-001",
    desktop: { portOffset: 0 },
    ...overrides,
  };
}

function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), "workloom-payload-policy-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (manifest) writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify(manifest)}\n`);
  return root;
}

test("只有仙女座精确身份允许携带 platform-ops", () => {
  const andromeda = payloadPolicyFor(product({
    productId: "workroom-andromeda",
    role: "platform",
    repository: "geniusdapeng-collab/workroom-andromeda",
  }));
  assert.equal(andromeda.includePlatformOps, true);
  assert.deepEqual(andromeda.forbiddenRuntimePaths, []);

  for (const forged of [
    product({ role: "platform" }),
    product({ productId: "workroom-andromeda", role: "platform" }),
    product({ productId: "workroom-andromeda", role: "platform", repository: "attacker/workroom-andromeda" }),
    product({ productId: "hotel", role: "industry", repository: "geniusdapeng-collab/workloom-hotel" }),
  ]) {
    const policy = payloadPolicyFor(forged);
    assert.equal(policy.includePlatformOps, false);
    assert.deepEqual(policy.forbiddenRuntimePaths, [
      "platform-ops",
      "node_modules/@workloom/platform-ops",
    ]);
  }
});

test("基座即使物理存在平台源码和内部包也会被装包后检查阻断", () => {
  const root = fixture(product());
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "platform-ops"), { recursive: true });
  mkdirSync(join(runtime, "node_modules", "@workloom", "platform-ops"), { recursive: true });
  try {
    const policy = loadPayloadPolicy(root);
    assert.throws(
      () => assertRuntimePayloadBoundary(runtime, policy),
      /平台工程边界违规/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("归档清单对大小写、Windows 分隔符和相对段统一失败关闭", () => {
  const policy = payloadPolicyFor(product());
  const entries = [
    "./runtime/apps/server/index.js",
    ".\\runtime\\node_modules\\@workloom\\PLATFORM-OPS\\package.json",
    "payload/../runtime/platform-ops/bin/guard.mjs",
  ];
  assert.deepEqual(findForbiddenArchiveEntries(entries, policy), entries.slice(1));
  assert.throws(() => assertArchivePayloadBoundary(entries, policy), /平台工程边界违规/u);
});

test("缺失或不可校验的产品清单不能生成载荷策略", () => {
  for (const manifest of [
    null,
    product({ schemaVersion: "workloom.product/v0" }),
    product({ role: "platform/operator" }),
  ]) {
    const root = fixture(manifest);
    try {
      assert.throws(() => loadPayloadPolicy(root), /product\.manifest\.json|schemaVersion|产品角色/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("仙女座载荷检查允许平台源码，但不放宽其他产品", () => {
  const root = fixture(product({
    productId: "workroom-andromeda",
    role: "platform",
    repository: "geniusdapeng-collab/workroom-andromeda",
  }));
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "platform-ops"), { recursive: true });
  mkdirSync(join(runtime, "node_modules", "@workloom", "platform-ops"), { recursive: true });
  try {
    const policy = loadPayloadPolicy(root);
    assert.doesNotThrow(() => assertRuntimePayloadBoundary(runtime, policy));
    assert.doesNotThrow(() => assertArchivePayloadBoundary([
      "runtime/platform-ops/package.json",
      "runtime/node_modules/@workloom/platform-ops/package.json",
    ], policy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
