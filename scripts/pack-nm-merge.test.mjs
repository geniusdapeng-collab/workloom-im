import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMergedRuntimeManifest, runtimeDependencySources } from "./pack-nm-merge.mjs";
import { payloadPolicyFor } from "./payload-policy.mjs";

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixture({ withPlatformOps = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workloom-pack-nm-"));
  writeJson(join(root, "package.json"), {
    dependencies: { hono: "1.0.0" },
    devDependencies: { tsx: "4.0.0", electron: "99.0.0" },
  });
  writeJson(join(root, "apps/server/package.json"), { dependencies: { pg: "8.0.0" } });
  writeJson(join(root, "apps/web/package.json"), { devDependencies: { vite: "7.0.0" } });
  writeJson(join(root, "packages/base/package.json"), {
    dependencies: { zod: "4.0.0", "@workloom/shared": "workspace:*" },
  });
  if (withPlatformOps) {
    writeJson(join(root, "platform-ops/package.json"), {
      name: "@workloom/platform-ops",
      dependencies: { "platform-only-dep": "1.2.3" },
    });
  }
  return root;
}

const basePolicy = payloadPolicyFor({
  productId: "workloom-im",
  role: "base",
  repository: "geniusdapeng-collab/workloom-im",
});
const andromedaPolicy = payloadPolicyFor({
  productId: "workroom-andromeda",
  role: "platform",
  repository: "geniusdapeng-collab/workroom-andromeda",
});

test("基座物理存在 platform-ops 时依赖合成仍排除平台工程", () => {
  const root = fixture();
  try {
    const sources = runtimeDependencySources(root, basePolicy).map(([file]) => file);
    assert.equal(sources.includes("platform-ops/package.json"), false);
    const merged = buildMergedRuntimeManifest(root, basePolicy);
    assert.equal(Object.hasOwn(merged.dependencies, "platform-only-dep"), false);
    assert.deepEqual(merged.dependencies, {
      hono: "1.0.0",
      pg: "8.0.0",
      tsx: "4.0.0",
      vite: "7.0.0",
      zod: "4.0.0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("仙女座精确身份收集 platform-ops，缺包则阻断", () => {
  const root = fixture();
  const missingRoot = fixture({ withPlatformOps: false });
  try {
    const sources = runtimeDependencySources(root, andromedaPolicy).map(([file]) => file);
    assert.equal(sources.includes("platform-ops/package.json"), true);
    assert.equal(buildMergedRuntimeManifest(root, andromedaPolicy).dependencies["platform-only-dep"], "1.2.3");
    assert.throws(
      () => runtimeDependencySources(missingRoot, andromedaPolicy),
      /缺少 platform-ops\/package\.json/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
