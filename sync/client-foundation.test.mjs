import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  applyClientFoundation,
  inspectClientFoundationState,
  loadStableFoundationSnapshot,
  materializeUiVersion,
  planClientFoundation,
  resolveStableFoundationVersion,
} from "./client-foundation.mjs";
import { verifyClientFoundationConsumer } from "../scripts/verify-client-foundation-consumer.mjs";

const VERSION = "1.2.3";

function manifest(stable = VERSION) {
  return {
    schemaVersion: 1,
    baseRepository: "geniusdapeng-collab/workloom-im",
    releasePolicy: "base-first-stable-only",
    ui: {
      package: "@workloom/ui",
      contractVersion: "2.0.0",
      candidateVersion: "1.2.4",
      latestStableVersion: stable,
      requiredClientPackages: ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"],
      allowedIndustryOverrides: ["--wl-brand-primary"],
    },
    clientFoundation: {
      schemaVersion: "workloom.client-foundation/v1",
      stateFile: ".workloom-client-foundation.json",
      candidateVersion: "1.2.4",
      latestStableVersion: stable,
      stableSourceRefPattern: "refs/tags/ui-v{version}",
      distribution: "stable-tag-upgrade-pr",
      maxManagedFiles: 500,
      managedRoots: ["apps/web", "apps/webb", "apps/webc"],
      requiredEntries: [
        "apps/web/src/main.tsx",
        "apps/webb/src/main.tsx",
        "apps/webc/src/main.tsx",
        "apps/webc/public/service-front.config.json",
      ],
      allowedIndustryExtensionPaths: [
        "apps/*/src/extensions/**",
        "apps/*/src/projections/**",
        "apps/*/src/config/industry/**",
        "apps/*/src/theme/industry/**",
        "apps/*/public/industry/**",
      ],
      ignoredRuntimePaths: ["apps/*/dist/**", "apps/*/node_modules/**", "apps/*/.vite/**"],
      protectedRootFiles: ["product.manifest.json", "electron-builder.yml"],
    },
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createIndustryRepo({ role = "industry" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workloom-foundation-target-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  writeJson(join(root, "product.manifest.json"), {
    schemaVersion: "workloom.product/v1",
    productId: "example-industry",
    role,
    repository: "geniusdapeng-collab/example-industry",
    release: { appId: role === "base" ? "com.workloom.im" : "com.workloom.example" },
    desktop: { portOffset: role === "base" ? 0 : 400 },
    clients: {
      bPc: { enabled: true, entry: "apps/web" },
      bMobile: { enabled: true, entry: "apps/webb" },
      cMobile: { enabled: true, entry: "apps/webc" },
    },
  });
  return root;
}

function makeSnapshot(version = VERSION, suffix = "v1", extra = {}) {
  const source = new Map();
  for (const app of ["web", "webb", "webc"]) {
    source.set(`apps/${app}/package.json`, {
      content: Buffer.from(`${JSON.stringify({ dependencies: { "@workloom/ui": version } }, null, 2)}\n`),
      mode: 0o644,
    });
    source.set(`apps/${app}/src/main.tsx`, { content: Buffer.from(`export const client = "${app}-${suffix}";\n`), mode: 0o644 });
  }
  source.set("apps/webc/public/service-front.config.json", {
    content: Buffer.from('{"schemaVersion":"workloom.service-front-shell/v1","industryProjectionPath":"industry/service-front.config.json"}\n'),
    mode: 0o644,
  });
  for (const [path, value] of Object.entries(extra)) {
    source.set(path, { content: Buffer.from(value), mode: 0o644 });
  }
  return {
    version,
    sourceRef: `refs/tags/ui-v${version}`,
    sourceCommit: "a".repeat(40),
    files: source,
  };
}

describe("三端客户端基座稳定分发", () => {
  it("只允许基座登记的 latest stable，候选版和 UI/壳版本错位均 fail closed", () => {
    assert.equal(resolveStableFoundationVersion(manifest(), undefined), VERSION);
    assert.throws(() => resolveStableFoundationVersion(manifest(), "1.2.4"), /只能采用 latestStableVersion/);
    assert.throws(() => resolveStableFoundationVersion(manifest(null)), /尚未发布稳定三端客户端基座/);
    const drifted = manifest();
    drifted.ui.latestStableVersion = "1.2.2";
    assert.throws(() => resolveStableFoundationVersion(drifted), /共享 UI 稳定版/);
  });

  it("新行业 scaffold 默认一次安装 PC/B移动/C移动，并保持 product.manifest 逐字节不变", () => {
    const repo = createIndustryRepo();
    const identityBefore = readFileSync(join(repo, "product.manifest.json"));
    const result = applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" });
    assert.equal(result.applied, true);
    assert.ok(result.filesTouched.includes("apps/web/src/main.tsx"));
    assert.ok(result.filesTouched.includes("apps/webb/src/main.tsx"));
    assert.ok(result.filesTouched.includes("apps/webc/src/main.tsx"));
    assert.deepEqual(readFileSync(join(repo, "product.manifest.json")), identityBefore);
    const state = JSON.parse(readFileSync(join(repo, ".workloom-client-foundation.json"), "utf8"));
    assert.equal(state.version, VERSION);
    assert.equal(state.updatePolicy, "upgrade-pr-only");
    assert.equal(Object.keys(state.managedFiles).length, 7);
    assert.deepEqual(inspectClientFoundationState({ repoRoot: repo, manifest: manifest() }).issues, []);
  });

  it("dry-run 返回完整计划但不写客户端或 state", () => {
    const repo = createIndustryRepo();
    const identityBefore = readFileSync(join(repo, "product.manifest.json"));
    const result = applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold", dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.ok(result.operations.length >= 7);
    assert.equal(readFileSync(join(repo, "product.manifest.json")).equals(identityBefore), true);
    assert.throws(() => readFileSync(join(repo, "apps/web/src/main.tsx")), /ENOENT/);
    assert.throws(() => readFileSync(join(repo, ".workloom-client-foundation.json")), /ENOENT/);
  });

  it("升级用上一稳定版 SHA 验真；行业直接修改受管导航时拒绝且零覆盖", () => {
    const repo = createIndustryRepo();
    applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(VERSION, "v1"), mode: "scaffold" });
    const path = join(repo, "apps/web/src/main.tsx");
    writeFileSync(path, "// 行业仓直接改了基座导航\n");
    const untouchedMobile = readFileSync(join(repo, "apps/webb/src/main.tsx"), "utf8");
    assert.throws(
      () => applyClientFoundation({ repoRoot: repo, manifest: manifest("1.2.4"), snapshot: makeSnapshot("1.2.4", "v2"), mode: "upgrade" }),
      /MANAGED_FILE_MODIFIED:apps\/web\/src\/main.tsx/,
    );
    assert.equal(readFileSync(path, "utf8"), "// 行业仓直接改了基座导航\n");
    assert.equal(readFileSync(join(repo, "apps/webb/src/main.tsx"), "utf8"), untouchedMobile);
    assert.equal(JSON.parse(readFileSync(join(repo, ".workloom-client-foundation.json"))).version, VERSION);
  });

  it("无冲突升级会更新、新增和删除受管文件，行业白名单扩展保持原样", () => {
    const repo = createIndustryRepo();
    const first = makeSnapshot(VERSION, "v1", { "apps/web/src/obsolete.ts": "export {};\n" });
    applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: first, mode: "scaffold" });
    const extension = join(repo, "apps/web/src/extensions/industry-card.tsx");
    mkdirSync(join(repo, "apps/web/src/extensions"), { recursive: true });
    writeFileSync(extension, "export const industryCard = true;\n");
    const second = makeSnapshot("1.2.4", "v2", { "apps/webc/src/new-base-state.ts": "export const shared = true;\n" });
    const result = applyClientFoundation({ repoRoot: repo, manifest: manifest("1.2.4"), snapshot: second, mode: "upgrade" });
    assert.equal(result.applied, true);
    assert.equal(readFileSync(join(repo, "apps/web/src/main.tsx"), "utf8"), 'export const client = "web-v2";\n');
    assert.throws(() => readFileSync(join(repo, "apps/web/src/obsolete.ts")), /ENOENT/);
    assert.equal(readFileSync(extension, "utf8"), "export const industryCard = true;\n");
    assert.equal(JSON.parse(readFileSync(join(repo, ".workloom-client-foundation.json"))).version, "1.2.4");
  });

  it("非白名单行业文件与基座身份均阻断 scaffold", () => {
    const repo = createIndustryRepo();
    mkdirSync(join(repo, "apps/web/src"), { recursive: true });
    writeFileSync(join(repo, "apps/web/src/custom-navigation.tsx"), "export {};\n");
    const plan = planClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" });
    assert.ok(plan.conflicts.some((item) => item.code === "ILLEGAL_INDUSTRY_APP_PATH" && item.path.endsWith("custom-navigation.tsx")));
    const baseRepo = createIndustryRepo({ role: "base" });
    assert.throws(
      () => applyClientFoundation({ repoRoot: baseRepo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" }),
      /独立且非基座的 product.manifest.json/,
    );
  });

  it("materialize 后三个客户端都锁定精确稳定 UI 版本", () => {
    const raw = makeSnapshot();
    for (const path of manifest().ui.requiredClientPackages) {
      raw.files.set(path, { content: Buffer.from('{"dependencies":{"@workloom/ui":"workspace:*"}}\n'), mode: 0o644 });
    }
    const result = materializeUiVersion(raw, manifest());
    for (const path of manifest().ui.requiredClientPackages) {
      assert.equal(JSON.parse(result.files.get(path).content).dependencies["@workloom/ui"], VERSION);
    }
  });

  it("下游自包含门禁复算所有指纹、扩展白名单和 UI 同版关系", () => {
    const repo = createIndustryRepo();
    applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" });
    writeJson(join(repo, ".workloom-ui.json"), { package: "@workloom/ui", version: VERSION });
    assert.deepEqual(verifyClientFoundationConsumer(repo), []);
    writeFileSync(join(repo, "apps/webb/src/main.tsx"), "// 漂移\n");
    assert.ok(verifyClientFoundationConsumer(repo).some((error) => error.includes("指纹漂移：apps/webb/src/main.tsx")));
  });

  it("篡改 state 扩展白名单或来源标签不能给非法客户端文件洗白", () => {
    const repo = createIndustryRepo();
    applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" });
    const statePath = join(repo, ".workloom-client-foundation.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.sourceRef = "refs/tags/ui-v9.9.9";
    state.allowedIndustryExtensionPaths.push("apps/*/src/**");
    writeJson(statePath, state);
    assert.throws(
      () => planClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "upgrade" }),
      /同版稳定标签|扩展白名单/,
    );
    const errors = verifyClientFoundationConsumer(repo);
    assert.ok(errors.some((error) => error.includes("来源必须是同版本")));
    assert.ok(errors.some((error) => error.includes("扩展白名单被修改")));
  });

  it("禁止客户端基座降级，也禁止稳定标签同版本换提交", () => {
    const repo = createIndustryRepo();
    applyClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: makeSnapshot(), mode: "scaffold" });
    assert.throws(
      () => planClientFoundation({
        repoRoot: repo,
        manifest: manifest("1.2.2"),
        snapshot: makeSnapshot("1.2.2"),
        mode: "upgrade",
      }),
      /拒绝.*降级/,
    );
    const movedTag = makeSnapshot();
    movedTag.sourceCommit = "b".repeat(40);
    assert.throws(
      () => planClientFoundation({ repoRoot: repo, manifest: manifest(), snapshot: movedTag, mode: "upgrade" }),
      /同版本异内容/,
    );
  });

  it("稳定快照只从 ui-v 标签读取，不受标签后的工作树内容影响", () => {
    const base = mkdtempSync(join(tmpdir(), "workloom-foundation-base-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
    writeJson(join(base, "sync/base-capabilities.json"), manifest());
    writeJson(join(base, "packages/ui/package.json"), { name: "@workloom/ui", version: VERSION });
    for (const app of ["web", "webb", "webc"]) {
      writeJson(join(base, `apps/${app}/package.json`), { dependencies: { "@workloom/ui": "workspace:*" } });
      mkdirSync(join(base, `apps/${app}/src`), { recursive: true });
      writeFileSync(join(base, `apps/${app}/src/main.tsx`), `export const source = "tag-${app}";\n`);
    }
    writeJson(join(base, "apps/webc/public/service-front.config.json"), {
      schemaVersion: "workloom.service-front-shell/v1",
      industryProjectionPath: "industry/service-front.config.json",
    });
    writeJson(join(base, "apps/webc/public/industry/service-front.config.json"), {
      brandName: "基座示例品牌不得下发",
    });
    execFileSync("git", ["add", "-A"], { cwd: base });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@workloom.im", "commit", "-m", "stable"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["tag", `ui-v${VERSION}`], { cwd: base });
    writeFileSync(join(base, "apps/web/src/main.tsx"), "export const source = 'dirty-candidate';\n");
    const result = loadStableFoundationSnapshot(base, manifest(), VERSION);
    assert.equal(result.version, VERSION);
    assert.equal(result.sourceRef, `refs/tags/ui-v${VERSION}`);
    assert.equal(result.files.get("apps/web/src/main.tsx").content.toString(), 'export const source = "tag-web";\n');
    assert.equal(JSON.parse(result.files.get("apps/web/package.json").content).dependencies["@workloom/ui"], VERSION);
    assert.equal(result.files.has("apps/webc/public/service-front.config.json"), true);
    assert.equal(result.files.has("apps/webc/public/industry/service-front.config.json"), false);
  });
});
