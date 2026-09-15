import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  assertIndependentUpgradeBranch,
  buildUpgradePullRequestBody,
  canCreateUpgradePr,
  inspectMigratedConsumer,
  preflightChildren,
  renderConsumerWorkflow,
  resolvePreflightTarget,
  rolloutHasFailure,
  selectRolloutBatch,
  validateChildInventory,
  validateRelease,
} from "./ui-upgrade-pr.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const waveOrder = ["W1", "W2", "W3A", "W3B", "W4", "W5"];
const manifest = {
  baseRepository: "geniusdapeng-collab/workloom-im",
  releasePolicy: "base-first-stable-only",
  ui: {
    package: "@workloom/ui",
    contractVersion: "2.0.0",
    candidateVersion: "1.2.4",
    latestStableVersion: "1.2.3",
    allowedIndustryOverrides: ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"],
    requiredClientPackages: ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"],
  },
  clientFoundation: {
    schemaVersion: "workloom.client-foundation/v1",
    stateFile: ".workloom-client-foundation.json",
    candidateVersion: "1.2.4",
    latestStableVersion: "1.2.3",
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

const hash = (content) => createHash("sha256").update(content).digest("hex");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createReadyConsumer(repo, repository = "geniusdapeng-collab/example") {
  writeJson(join(repo, "package.json"), {
    name: "workloom-example",
    private: true,
    packageManager: "pnpm@10.14.0",
    scripts: {
      "product:verify": "node scripts/verify-product-content.mjs",
      "bundle:governance": "tsx scripts/bundle-governance.mts",
    },
    devDependencies: { tsx: "^4.23.12" },
  });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), [
    "packages:",
    '  - "apps/*"',
    "onlyBuiltDependencies:",
    "  - node-pty",
    "",
  ].join("\n"));
  const clients = [
    {
      root: "apps/web",
      marker: "b-pc",
      imports: ["OverlayManager", "SideNavigation", "TopContextBar", "Drawer", "Button", "Input"],
    },
    {
      root: "apps/webb",
      marker: "b-mobile",
      imports: ["OverlayManager", "AppShell", "BottomTabs", "TopContextBar", "Drawer", "Button", "Input"],
    },
    {
      root: "apps/webc",
      marker: "c-mobile",
      imports: ["OverlayManager", "AppShell", "BottomTabs", "TopContextBar", "Drawer", "Button", "Input"],
    },
  ];
  for (const client of clients) {
    mkdirSync(join(repo, client.root, "src"), { recursive: true });
    writeJson(join(repo, client.root, "package.json"), { dependencies: { "@workloom/ui": "1.2.3" } });
    writeFileSync(join(repo, client.root, "src/main.tsx"), [
      `import { ${client.imports.join(", ")} } from "@workloom/ui";`,
      'import "@workloom/ui/tokens.css";',
      'import "@workloom/ui/content-safety.css";',
      'import "@workloom/ui/components.css";',
      `export function Client() { return <OverlayManager><main data-workloom-client="${client.marker}">${client.imports.slice(1).map((name) => `<${name} />`).join("")}</main></OverlayManager>; }`,
    ].join("\n"));
  }
  writeJson(join(repo, "apps/webc/public/service-front.config.json"), {
    schemaVersion: "workloom.service-front-shell/v1",
    industryProjectionPath: "industry/service-front.config.json",
  });
  writeJson(join(repo, "product.manifest.json"), {
    schemaVersion: "workloom.product/v1",
    productId: "example",
    role: "industry",
    repository,
    release: { appId: "com.workloom.example" },
    desktop: { portOffset: 100 },
    clients: {
      bPc: { enabled: true, entry: "apps/web" },
      bMobile: { enabled: true, entry: "apps/webb" },
      cMobile: { enabled: true, entry: "apps/webc" },
    },
  });
  writeJson(join(repo, ".workloom-ui.json"), {
    package: "@workloom/ui",
    version: "1.2.3",
    contractVersion: "2.0.0",
    source: "geniusdapeng-collab/workloom-im",
    updatePolicy: "upgrade-pr-only",
    releaseChannel: "stable",
    allowedIndustryOverrides: manifest.ui.allowedIndustryOverrides,
    requiredClientPackages: manifest.ui.requiredClientPackages,
    connectedClientPackages: manifest.ui.requiredClientPackages,
  });
  const managedFiles = {};
  for (const client of clients) {
    for (const path of [`${client.root}/package.json`, `${client.root}/src/main.tsx`]) {
      managedFiles[path] = { sha256: hash(readFileSync(join(repo, path))), mode: 420 };
    }
  }
  managedFiles["apps/webc/public/service-front.config.json"] = {
    sha256: hash(readFileSync(join(repo, "apps/webc/public/service-front.config.json"))),
    mode: 420,
  };
  writeJson(join(repo, ".workloom-client-foundation.json"), {
    schemaVersion: "workloom.client-foundation-state/v1",
    baseRepository: manifest.baseRepository,
    version: "1.2.3",
    sourceRef: "refs/tags/ui-v1.2.3",
    sourceCommit: "a".repeat(40),
    updatePolicy: "upgrade-pr-only",
    clients: { bPc: "apps/web", bMobile: "apps/webb", cMobile: "apps/webc" },
    allowedIndustryExtensionPaths: manifest.clientFoundation.allowedIndustryExtensionPaths,
    managedFiles,
  });
}

function initializeMainRepository(target) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@workloom.im", "commit", "-m", "fixture"], { cwd: target, stdio: "ignore" });
}

describe("UI 稳定发布门禁", () => {
  it("清单、包和目标三个版本必须完全一致", () => {
    assert.equal(validateRelease(manifest, { version: "1.2.3" }, "1.2.3"), true);
    assert.throws(() => validateRelease(manifest, { version: "1.2.2" }, "1.2.3"), /包版本/);
    assert.throws(
      () => validateRelease({ ...manifest, ui: { ...manifest.ui, latestStableVersion: null } }, { version: "1.2.3" }, "1.2.3"),
      /尚未登记/,
    );
    assert.throws(
      () => validateRelease({ ...manifest, releasePolicy: "anything" }, { version: "1.2.3" }, "1.2.3"),
      /base-first-stable-only/,
    );
  });

  it("首个稳定版为空时仍可对候选版做只读盘点，但不能借此绕过稳定发布", () => {
    const candidateOnly = { ...manifest, ui: { ...manifest.ui, latestStableVersion: null } };
    candidateOnly.clientFoundation = { ...manifest.clientFoundation, latestStableVersion: null };
    assert.deepEqual(resolvePreflightTarget(candidateOnly, { version: "1.2.4" }), { version: "1.2.4", channel: "candidate" });
    assert.throws(() => validateRelease(candidateOnly, { version: "1.2.4" }, "1.2.4"), /尚未登记/);
    assert.throws(() => resolvePreflightTarget(candidateOnly, { version: "1.2.4" }, "9.9.9"), /未登记/);
  });

  it("必须预检八个且不重复的下游仓", () => {
    const children = Array.from({ length: 8 }, (_, index) => ({ repo: `org/repo-${index}`, uiRolloutWave: index < 2 ? "W1" : "W2" }));
    assert.equal(validateChildInventory(children, waveOrder), true);
    assert.throws(() => validateChildInventory(children.slice(0, 7), waveOrder), /8 个仓库/);
    assert.throws(() => validateChildInventory([...children.slice(0, 7), children[0]], waveOrder), /重复仓库/);
    assert.throws(() => validateChildInventory(children.map((child, index) => index ? child : { ...child, uiRolloutWave: undefined }), waveOrder), /uiRolloutWave/);
  });

  it("真实订阅清单固化 W1 到 W5 的实施优先级", () => {
    const childManifest = JSON.parse(readFileSync(join(repoRoot, "sync/child-repos.json"), "utf8"));
    assert.deepEqual(childManifest.uiRolloutWaveOrder, waveOrder);
    assert.equal(validateChildInventory(childManifest.children, childManifest.uiRolloutWaveOrder), true);
    const waves = Object.fromEntries(childManifest.children.map((child) => [child.repo, child.uiRolloutWave]));
    assert.equal(waves["geniusdapeng-collab/workroom-andromeda"], "W1");
    assert.equal(waves["geniusdapeng-collab/workroom-eagle"], "W1");
    assert.equal(waves["geniusdapeng-collab/workroom-tiger"], "W5");
  });

  it("逐路径识别缺 B 端移动、产品清单和 UI 状态，不只返回仓名", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-blocked-"));
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    mkdirSync(join(repo, "apps/webc"), { recursive: true });
    writeJson(join(repo, "apps/web/package.json"), {});
    writeJson(join(repo, "apps/webc/package.json"), {});
    const blockers = inspectMigratedConsumer(repo, { repo: "org/blocked", pathPrefix: "" }, manifest);
    assert.ok(blockers.some((item) => item.code === "MISSING_CLIENT_PACKAGE" && item.path === "apps/webb/package.json"));
    assert.ok(blockers.some((item) => item.code === "MISSING_CLIENT_ENTRY" && item.path === "apps/web/src/main.tsx"));
    assert.ok(blockers.some((item) => item.code === "MISSING_PRODUCT_MANIFEST" && item.path === "product.manifest.json"));
    assert.ok(blockers.some((item) => item.code === "UNPINNED_PACKAGE_MANAGER" && item.path === "package.json"));
    assert.ok(blockers.some((item) => item.code === "MISSING_GOVERNANCE_COMMAND" && item.path === "package.json"));
    assert.ok(blockers.some((item) => item.code === "MISSING_BUILD_POLICY" && item.path === "pnpm-workspace.yaml"));
    assert.ok(blockers.some((item) => item.code === "MISSING_UI_STATE" && item.path === ".workloom-ui.json"));
    assert.ok(blockers.some((item) => item.code === "MISSING_CLIENT_FOUNDATION_STATE" && item.path === ".workloom-client-foundation.json"));
    assert.ok(blockers.every((item) => item.message && item.remediation));
  });

  it("完整三端、产品身份与共享消费契约通过只读检查", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-ready-"));
    createReadyConsumer(repo);
    assert.deepEqual(inspectMigratedConsumer(repo, { repo: "geniusdapeng-collab/example", pathPrefix: "" }, manifest), []);
  });

  it("pathPrefix 仓仍从 Git 仓根读取受保护产品身份", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-prefix-"));
    mkdirSync(join(repo, "governance"), { recursive: true });
    createReadyConsumer(join(repo, "governance"), "geniusdapeng-collab/workroom-tiger");
    const nestedProduct = JSON.parse(readFileSync(join(repo, "governance/product.manifest.json"), "utf8"));
    writeJson(join(repo, "product.manifest.json"), nestedProduct);
    const blockers = inspectMigratedConsumer(repo, { repo: "geniusdapeng-collab/workroom-tiger", pathPrefix: "governance/" }, manifest);
    assert.deepEqual(blockers, []);
  });

  it("存量迁移缺口会结构化报告，但不反向阻断基座稳定制品", () => {
    const children = Array.from({ length: 8 }, (_, index) => ({ repo: `org/repo-${index}`, pathPrefix: "", uiRolloutWave: index < 2 ? "W1" : "W2" }));
    let cloneCalls = 0;
    const report = preflightChildren({
      children,
      waveOrder,
      manifest,
      version: "1.2.3",
      cloneChild(_child, target) {
        cloneCalls += 1;
        initializeMainRepository(target);
      },
    });
    assert.equal(cloneCalls, 8);
    assert.equal(report.schemaVersion, "workloom.ui-downstream-preflight/v1");
    assert.equal(report.targetChannel, "stable");
    assert.equal(report.requiredRepositoryCount, 8);
    assert.equal(report.targetArtifacts.sharedUi, "@workloom/ui@1.2.3");
    assert.equal(report.targetArtifacts.clientFoundation, "ui-v1.2.3");
    assert.equal(report.ready, true);
    assert.equal(report.baseReleaseReady, true);
    assert.equal(report.allMigrationsCurrent, false);
    assert.deepEqual(report.summary, { accessible: 8, unreachable: 0, stageOneReady: 0, phaseOneBlocked: 8, current: 0 });
    assert.equal(report.repositories.length, 8);
    assert.ok(report.repositories.every((item) => item.blockers.some((entry) => entry.code === "MISSING_CLIENT_PACKAGE")));
  });

  it("仓库不可访问仍会阻断基座发布资格", () => {
    const children = Array.from({ length: 8 }, (_, index) => ({ repo: `org/repo-${index}`, pathPrefix: "", uiRolloutWave: "W1" }));
    const report = preflightChildren({
      children,
      waveOrder,
      manifest,
      version: "1.2.3",
      cloneChild(child, target) {
        if (child.repo.endsWith("repo-7")) throw new Error("denied");
        initializeMainRepository(target);
      },
    });
    assert.equal(report.baseReleaseReady, false);
    assert.equal(report.summary.unreachable, 1);
    assert.ok(report.repositories.at(-1).blockers.some((entry) => entry.code === "CLONE_FAILED" && entry.phase === "access"));
  });

  it("默认只选择最早未完成波次，显式选择也不得越级", () => {
    const children = [
      { repo: "org/a", uiRolloutWave: "W1" },
      { repo: "org/b", uiRolloutWave: "W1" },
      { repo: "org/c", uiRolloutWave: "W2" },
    ];
    const repositories = [
      { repo: "org/a", targetVersionApplied: true },
      { repo: "org/b", targetVersionApplied: false },
      { repo: "org/c", targetVersionApplied: false },
    ];
    const automatic = selectRolloutBatch({ children, waveOrder, repositories });
    assert.equal(automatic.selectedWave, "W1");
    assert.deepEqual(automatic.selected.map((item) => item.repo), ["org/a", "org/b"]);
    const skipped = selectRolloutBatch({ children, waveOrder, repositories, wave: "W2" });
    assert.equal(skipped.blockedByEarlierWave, true);
    const whitelist = selectRolloutBatch({ children, waveOrder, repositories, repositoryWhitelist: ["org/b"] });
    assert.equal(whitelist.selectedWave, "W1");
    assert.deepEqual(whitelist.selected.map((item) => item.repo), ["org/b"]);
    assert.throws(
      () => selectRolloutBatch({ children, waveOrder, repositories, repositoryWhitelist: ["org/b", "org/c"] }),
      /同一 rollout 波次/,
    );
  });

  it("只有已完成阶段一且尚未升级到目标稳定版的仓可创建 PR", () => {
    assert.equal(canCreateUpgradePr({ accessStatus: "accessible", stageOneReady: true, targetVersionApplied: false }), true);
    assert.equal(canCreateUpgradePr({ accessStatus: "accessible", stageOneReady: false, targetVersionApplied: false }), false);
    assert.equal(canCreateUpgradePr({ accessStatus: "unreachable", stageOneReady: true, targetVersionApplied: false }), false);
    assert.equal(canCreateUpgradePr({ accessStatus: "accessible", stageOneReady: true, targetVersionApplied: true }), false);
  });

  it("选中仓阶段一阻断与升级失败都让 rollout 失败，单纯延后波次不误报", () => {
    assert.equal(rolloutHasFailure([{ status: "blocked-phase-1" }]), true);
    assert.equal(rolloutHasFailure([{ status: "failed" }]), true);
    assert.equal(rolloutHasFailure([{ status: "blocked-by-earlier-wave" }]), true);
    assert.equal(rolloutHasFailure([{ status: "deferred-wave" }, { status: "pr-opened" }]), false);
  });

  it("rollout 分支只能是版本化独立分支，main 永远非法", () => {
    assert.equal(assertIndependentUpgradeBranch("chore/workloom-ui-v1.2.3"), true);
    assert.throws(() => assertIndependentUpgradeBranch("main"), /非法升级分支/);
    assert.throws(() => assertIndependentUpgradeBranch("release/ui"), /非法升级分支/);
  });

  it("升级 PR 只列出消费工作流实际执行的门禁", () => {
    const body = buildUpgradePullRequestBody("1.2.3");
    assert.match(body, /三端逐一 typecheck 与生产 build/u);
    assert.match(body, /仓库现有 pnpm 测试/u);
    assert.match(body, /产品身份一致性与全量行业 Bundle/u);
    assert.match(body, /存在 Python 测试时同时运行 pytest/u);
    assert.match(body, /Playwright.*基础主入口、首帧及稳定帧横向溢出冒烟/u);
    assert.doesNotMatch(body, /租户负向|视觉回归/u);
  });

  it("消费工作流在普通仓和 Tiger governance 前缀下都指向真实客户端与证据路径", () => {
    const regular = renderConsumerWorkflow("");
    assert.match(regular, /WORKLOOM_DIR: \./u);
    assert.match(regular, /\.\/apps\/web\/playwright-report\/consumer/u);

    const tiger = renderConsumerWorkflow("governance/");
    assert.match(tiger, /WORKLOOM_DIR: governance/u);
    assert.match(tiger, /governance\/apps\/web\/playwright-report\/consumer/u);
    assert.doesNotMatch(tiger, /__REPO_DIR__/u);
    assert.doesNotMatch(tiger, /--if-present/u);
    const commands = tiger;
    for (const command of [
      "verify-ui-consumer.mjs",
      "verify-client-foundation-consumer.mjs",
      "verify-product-content.mjs",
      "bundle-governance.mts",
      'pnpm -C "$WORKLOOM_DIR" test',
      "python -m pytest -q",
      "for CLIENT in web webb webc",
      "test:consumer",
    ]) assert.match(commands, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.throws(() => renderConsumerWorkflow("../governance"), /非法消费仓 pathPrefix/u);
  });

  it("工作流严格先预检、再 publish、最后 rollout", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ui-release.yml"), "utf8");
    assert.match(workflow, /^# ui-v\* 只封存共享 UI 与三端客户端基座/mu);
    assert.match(workflow, /^name: shared-ui-client-foundation-release$/mu);
    assert.match(workflow, /候选 Bundle 契约、摘要与投影一致性门禁/u);
    assert.doesNotMatch(workflow, /BUNDLE_SIGNING_PRIVATE_KEY|BUNDLE_SIGNING_KEY_ID|pnpm bundle:release|build\/bundle-trust\.json/u);
    const preflight = workflow.indexOf("node sync/ui-upgrade-pr.mjs --preflight");
    const publish = workflow.indexOf('npm publish "${TARBALLS[0]}"');
    const rollout = workflow.indexOf("node sync/ui-upgrade-pr.mjs --rollout");
    assert.ok(preflight >= 0 && publish > preflight && rollout > publish);
    assert.match(workflow, /needs: verify-and-preflight/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.match(workflow, /inputs\.action == 'rollout'/);
    assert.match(workflow, /--wave "\$ROLLOUT_WAVE"/);
    assert.match(workflow, /--repos "\$ROLLOUT_REPOSITORIES"/);
    assert.match(workflow, /sync\/client-foundation\.test\.mjs/u);
    assert.match(workflow, /m\.clientFoundation\.latestStableVersion!==v/u);
    assert.match(workflow, /client-foundation\.mjs verify-source/u);
    const continueRollout = workflow.slice(workflow.indexOf("  continue-rollout:"));
    assert.match(continueRollout, /uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/u);
    assert.match(continueRollout, /git checkout --detach "ui-v\$STABLE_VERSION"/u);
    const desktopWorkflow = readFileSync(join(repoRoot, ".github/workflows/build-desktop.yml"), "utf8");
    assert.match(desktopWorkflow, /BUNDLE_SIGNING_PRIVATE_KEY/u);
    assert.match(desktopWorkflow, /pnpm bundle:release/u);
    assert.match(desktopWorkflow, /build\/bundle-trust\.json/u);
    const implementation = readFileSync(join(repoRoot, "sync/ui-upgrade-pr.mjs"), "utf8");
    assert.match(implementation, /base: "main"/u);
    assert.match(implementation, /applyClientFoundation/u);
    assert.match(implementation, /verify-client-foundation-consumer\.mjs/u);
    assert.match(implementation, /verify-production-client-boundary\.mjs/u);
    assert.doesNotMatch(implementation, /HEAD:main/u);
    const syncWorkflow = readFileSync(join(repoRoot, ".github/workflows/base-sync-push.yml"), "utf8");
    assert.match(syncWorkflow, /sync\/ui-consumer-template\.yml/u);
    const consumerWorkflow = readFileSync(join(repoRoot, "sync/ui-consumer-template.yml"), "utf8");
    assert.match(consumerWorkflow, /verify-client-foundation-consumer\.mjs/u);
    assert.match(consumerWorkflow, /pnpm -C "\$WORKLOOM_DIR" test/u);
    assert.match(consumerWorkflow, /python -m pytest -q/u);
    assert.match(consumerWorkflow, /for CLIENT in web webb webc/u);
    assert.match(consumerWorkflow, /playwright install --with-deps chromium/u);
    assert.match(consumerWorkflow, /test:consumer/u);
    assert.doesNotMatch(consumerWorkflow, /租户负向|视觉回归/u);
    const webPackage = JSON.parse(readFileSync(join(repoRoot, "apps/web/package.json"), "utf8"));
    assert.equal(webPackage.scripts["test:consumer"], "playwright test --config playwright.consumer.config.ts");
    assert.equal(webPackage.devDependencies["@playwright/test"], "1.63.0");
    assert.match(readFileSync(join(repoRoot, "apps/web/playwright.consumer.config.ts"), "utf8"), /consumer-e2e/u);
    assert.match(readFileSync(join(repoRoot, "apps/web/consumer-e2e/clients.playwright.ts"), "utf8"), /__workloomFirstClientFrame/u);
    const buildScriptDependencies = [...webPackage.scripts.build.matchAll(/\.\.\/\.\.\/(scripts\/[-A-Za-z0-9_.]+\.mjs)/gu)].map((match) => match[1]);
    for (const dependency of buildScriptDependencies) assert.match(implementation, new RegExp(dependency.replaceAll(".", "\\."), "u"));
  });
});
