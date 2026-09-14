import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveUiVersion, setUiVersion } from "./set-ui-version.mjs";

const manifest = {
  baseRepository: "geniusdapeng-collab/workloom-im",
  ui: {
    package: "@workloom/ui",
    contractVersion: "1.0.0",
    candidateVersion: "0.1.0",
    latestStableVersion: null,
    allowedIndustryOverrides: ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"],
    requiredClientPackages: ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"],
  },
};

describe("UI 稳定版本接入", () => {
  it("没有稳定版本时阻断新行业接入", () => {
    assert.throws(() => resolveUiVersion(manifest), /尚未发布稳定 UI 版本/);
    assert.equal(resolveUiVersion(manifest, undefined, true), "0.1.0");
  });

  it("只更新实际存在的客户端并写入可审计状态", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-adopt-"));
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    writeFileSync(join(repo, "apps/web/package.json"), '{"dependencies":{"industry-only":"1.0.0"}}\n');
    const touched = setUiVersion({ repo, version: "1.2.3", manifest });
    assert.deepEqual(touched, ["apps/web/package.json"]);
    const packageJson = JSON.parse(readFileSync(join(repo, "apps/web/package.json"), "utf8"));
    assert.equal(packageJson.dependencies["@workloom/ui"], "1.2.3");
    assert.equal(packageJson.dependencies["industry-only"], "1.0.0");
    const state = JSON.parse(readFileSync(join(repo, ".workloom-ui.json"), "utf8"));
    assert.equal(state.updatePolicy, "upgrade-pr-only");
    assert.deepEqual(state.allowedIndustryOverrides, manifest.ui.allowedIndustryOverrides);
  });

  it("新行业严格模式要求三个生产客户端齐备", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-strict-"));
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    writeFileSync(join(repo, "apps/web/package.json"), "{}\n");
    assert.throws(
      () => setUiVersion({ repo, version: "1.2.3", manifest, requireAll: true }),
      /三个生产客户端/,
    );
  });
});
