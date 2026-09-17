import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveUiReleaseArtifact, resolveUiVersion, setUiVersion } from "./set-ui-version.mjs";

const integrity = (byte) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;

const manifest = {
  baseRepository: "geniusdapeng-collab/workloom-im",
  ui: {
    package: "@workloom/ui",
    contractVersion: "2.0.0",
    candidateVersion: "0.1.0",
    latestStableVersion: null,
    allowedIndustryOverrides: ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"],
    requiredClientPackages: ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"],
    distribution: {
      type: "github-release-tarball",
      urlTemplate: "https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v{version}/workloom-ui-{version}.tgz",
      assetNameTemplate: "workloom-ui-{version}.tgz",
      integrityByVersion: {
        "0.1.0": integrity(1),
        "1.2.3": integrity(2),
        "1.2.4": integrity(3),
      },
    },
  },
};

describe("UI 稳定版本接入", () => {
  it("没有稳定版本时阻断新行业接入", () => {
    assert.throws(() => resolveUiVersion(manifest), /尚未发布稳定 UI 版本/);
    assert.equal(resolveUiVersion(manifest, undefined, true), "0.1.0");
  });

  it("默认只允许 latestStableVersion，拒绝任意显式版本", () => {
    const stableManifest = { ...manifest, ui: { ...manifest.ui, latestStableVersion: "1.2.3" } };
    assert.equal(resolveUiVersion(stableManifest), "1.2.3");
    assert.equal(resolveUiVersion(stableManifest, "1.2.3"), "1.2.3");
    assert.throws(() => resolveUiVersion(stableManifest, "1.2.4"), /不是当前稳定版/);
  });

  it("只接受官方仓库、HTTPS、同版本资产名与有效 SHA-512", () => {
    const artifact = resolveUiReleaseArtifact(manifest, "1.2.3");
    assert.equal(artifact.assetName, "workloom-ui-1.2.3.tgz");
    assert.equal(artifact.url, "https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v1.2.3/workloom-ui-1.2.3.tgz");
    assert.equal(artifact.sha512, integrity(2));
    assert.equal(artifact.overrideSelector, "@workloom/ui@1.2.3");

    const wrongRepository = structuredClone(manifest);
    wrongRepository.baseRepository = "someone/fork";
    assert.throws(() => resolveUiReleaseArtifact(wrongRepository, "1.2.3"), /仓库必须为/);
    const insecure = structuredClone(manifest);
    insecure.ui.distribution.urlTemplate = insecure.ui.distribution.urlTemplate.replace("https://", "http://");
    assert.throws(() => resolveUiReleaseArtifact(insecure, "1.2.3"), /urlTemplate/);
    const badIntegrity = structuredClone(manifest);
    badIntegrity.ui.distribution.integrityByVersion["1.2.3"] = "sha512-not-a-digest";
    assert.throws(() => resolveUiReleaseArtifact(badIntegrity, "1.2.3"), /无效登记/);
    assert.throws(() => resolveUiReleaseArtifact(manifest, "1.2"), /精确稳定 semver/);
  });

  it("存量迁移只有显式关闭三端要求时才可分步写状态", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-adopt-"));
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({
      pnpm: {
        overrides: {
          "unrelated-package": "2.0.0",
          "@workloom/ui@1.2.2": "https://example.invalid/stale.tgz",
        },
      },
    })}\n`);
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    writeFileSync(join(repo, "apps/web/package.json"), '{"dependencies":{"industry-only":"1.0.0"}}\n');
    const touched = setUiVersion({ repo, version: "1.2.3", manifest, requireAll: false });
    assert.deepEqual(touched, ["apps/web/package.json"]);
    const packageJson = JSON.parse(readFileSync(join(repo, "apps/web/package.json"), "utf8"));
    assert.equal(packageJson.dependencies["@workloom/ui"], "1.2.3");
    assert.equal(packageJson.dependencies["industry-only"], "1.0.0");
    const state = JSON.parse(readFileSync(join(repo, ".workloom-ui.json"), "utf8"));
    assert.equal(state.updatePolicy, "upgrade-pr-only");
    assert.equal(state.releaseChannel, "stable");
    assert.deepEqual(state.allowedIndustryOverrides, manifest.ui.allowedIndustryOverrides);
    assert.equal(state.schemaVersion, "workloom.ui-consumer-state/v1");
    assert.deepEqual(state.artifact, {
      type: "github-release-tarball",
      assetName: "workloom-ui-1.2.3.tgz",
      url: "https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v1.2.3/workloom-ui-1.2.3.tgz",
      sha512: integrity(2),
    });
    const rootPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    assert.equal(rootPackage.pnpm.overrides["@workloom/ui@1.2.3"], state.artifact.url);
    assert.equal(rootPackage.pnpm.overrides["@workloom/ui@1.2.2"], undefined);
    assert.equal(rootPackage.pnpm.overrides["unrelated-package"], "2.0.0");
  });

  it("新行业默认要求三个生产客户端齐备", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-strict-"));
    writeFileSync(join(repo, "package.json"), "{}\n");
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    writeFileSync(join(repo, "apps/web/package.json"), "{}\n");
    assert.throws(
      () => setUiVersion({ repo, version: "1.2.3", manifest }),
      /三个生产客户端/,
    );
  });
});
