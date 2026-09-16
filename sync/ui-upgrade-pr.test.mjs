import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import YAML from "yaml";
import { resolveUiReleaseArtifact } from "./set-ui-version.mjs";
import { findUiReleaseWorkflowRisks } from "./ui-release-workflow-contract.mjs";
import {
  assertExactUpgradePathSet,
  assertReleaseArtifactIntegrity,
  assertReleasePayloadIntegrity,
  assertIndependentUpgradeBranch,
  buildUpgradePullRequestBody,
  canCreateUpgradePr,
  classifyCloneFailure,
  cloneChildReadOnly,
  inspectMigratedConsumer,
  packTaggedUiArtifact,
  preflightChildren,
  readCanonicalGithubReleaseArtifact,
  redactCloneDiagnostic,
  renderConsumerWorkflow,
  resolvePreflightTarget,
  rolloutHasFailure,
  sanitizedSubprocessEnvironment,
  selectRolloutBatch,
  stageExactUpgradeChanges,
  validateChildInventory,
  validateRelease,
  verifyPublishedArtifact,
  verifyCanonicalReleaseTag,
} from "./ui-upgrade-pr.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const waveOrder = ["W1", "W2", "W3A", "W3B", "W4", "W5"];
const fixtureArtifactBytes = Buffer.from("export const source = 'stable-tag';\n");
const fixtureArtifactIntegrity = `sha512-${createHash("sha512").update(fixtureArtifactBytes).digest("base64")}`;
const fixtureReleaseUrl = "https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v1.2.3/workloom-ui-1.2.3.tgz";
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
    distribution: {
      type: "github-release-tarball",
      urlTemplate: "https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v{version}/workloom-ui-{version}.tgz",
      assetNameTemplate: "workloom-ui-{version}.tgz",
      integrityByVersion: { "1.2.3": fixtureArtifactIntegrity },
    },
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

function writeReadyConsumerLockfile(repo) {
  writeFileSync(join(repo, "pnpm-lock.yaml"), YAML.stringify({
    lockfileVersion: "9.0",
    overrides: { "@workloom/ui@1.2.3": fixtureReleaseUrl },
    importers: Object.fromEntries(manifest.ui.requiredClientPackages.map((packagePath) => [
      packagePath.replace(/\/package\.json$/u, ""),
      { dependencies: { "@workloom/ui": { specifier: fixtureReleaseUrl, version: fixtureReleaseUrl } } },
    ])),
    packages: {
      [`@workloom/ui@${fixtureReleaseUrl}`]: {
        resolution: { tarball: fixtureReleaseUrl, integrity: fixtureArtifactIntegrity },
        version: "1.2.3",
      },
    },
    snapshots: { [`@workloom/ui@${fixtureReleaseUrl}`]: {} },
  }));
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
    pnpm: {
      overrides: {
        "@workloom/ui@1.2.3": fixtureReleaseUrl,
      },
    },
    devDependencies: {
      tsx: "^4.23.12",
      "typescript-governance": "npm:typescript@5.9.3",
      "yaml-governance": "npm:yaml@2.9.0",
    },
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
    schemaVersion: "workloom.ui-consumer-state/v1",
    package: "@workloom/ui",
    version: "1.2.3",
    contractVersion: "2.0.0",
    source: "geniusdapeng-collab/workloom-im",
    updatePolicy: "upgrade-pr-only",
    releaseChannel: "stable",
    allowedIndustryOverrides: manifest.ui.allowedIndustryOverrides,
    requiredClientPackages: manifest.ui.requiredClientPackages,
    connectedClientPackages: manifest.ui.requiredClientPackages,
    artifact: {
      type: "github-release-tarball",
      assetName: "workloom-ui-1.2.3.tgz",
      url: fixtureReleaseUrl,
      sha512: fixtureArtifactIntegrity,
    },
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
  writeReadyConsumerLockfile(repo);
}

function initializeMainRepository(target) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: target, stdio: "ignore" });
  const fixturePaths = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
    cwd: target,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  execFileSync("git", ["add", "--", ...fixturePaths], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@workloom.im", "commit", "-m", "fixture"], { cwd: target, stdio: "ignore" });
}

function commitFixture(target, message) {
  execFileSync("git", ["add", "--all"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@workloom.im", "commit", "-m", message], { cwd: target, stdio: "ignore" });
}

function createBareOrigin(target, origin, { pushMain = true, pushTag = true } = {}) {
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: target, stdio: "ignore" });
  if (pushMain) execFileSync("git", ["push", "origin", "main"], { cwd: target, stdio: "ignore" });
  if (pushTag) execFileSync("git", ["push", "origin", "refs/tags/ui-v1.2.3"], { cwd: target, stdio: "ignore" });
}

function writeTaggedReleaseSource(root) {
  writeJson(join(root, "package.json"), { name: "fixture-root", private: true, packageManager: "pnpm@10.14.0" });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeJson(join(root, "tsconfig.base.json"), { compilerOptions: {} });
  writeJson(join(root, "sync/base-capabilities.json"), manifest);
  writeJson(join(root, "sync/child-repos.json"), {
    uiRolloutWaveOrder: ["W1"],
    children: Array.from({ length: 8 }, (_, index) => ({ repo: `org/repo-${index}`, uiRolloutWave: "W1" })),
  });
  writeFileSync(join(root, "sync/ui-consumer-template.yml"), "name: consumer\n# __REPO_DIR__\n");
  for (const path of [
    "sync/ui-upgrade-pr.mjs",
    "sync/client-foundation.mjs",
    "sync/set-ui-version.mjs",
    "sync/install-ui-governance.mjs",
    "sync/install-adoption-assets.mjs",
    "sync/ui-lockfile-integrity.mjs",
  ]) writeFileSync(join(root, path), `// release controller ${path}\n`);
  for (const path of [
    "scripts/verify-ui-consumer.mjs",
    "scripts/ui-governance-rules.mjs",
    "scripts/verify-client-foundation-consumer.mjs",
    "scripts/verify-production-client-boundary.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `// release payload ${path}\n`);
  }
  writeJson(join(root, "packages/ui/package.json"), {
    name: "@workloom/ui",
    version: "1.2.3",
    private: true,
    files: ["index.js"],
  });
  writeFileSync(join(root, "packages/ui/index.js"), "export const source = 'stable-tag';\n");
  for (const client of ["web", "webb", "webc"]) {
    writeJson(join(root, `apps/${client}/package.json`), { dependencies: { "@workloom/ui": "workspace:*" } });
    mkdirSync(join(root, `apps/${client}/src`), { recursive: true });
    writeFileSync(join(root, `apps/${client}/src/main.tsx`), `export const client = ${JSON.stringify(client)};\n`);
  }
  writeJson(join(root, "apps/webc/public/service-front.config.json"), { schemaVersion: "workloom.service-front-shell/v1" });
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
    assert.throws(
      () => validateRelease({
        ...manifest,
        ui: { ...manifest.ui, distribution: { ...manifest.ui.distribution, urlTemplate: "https://attacker.invalid/{version}.tgz" } },
      }, { version: "1.2.3" }, "1.2.3"),
      /urlTemplate/u,
    );
    assert.throws(
      () => validateRelease({
        ...manifest,
        ui: { ...manifest.ui, distribution: { ...manifest.ui.distribution, integrityByVersion: {} } },
      }, { version: "1.2.3" }, "1.2.3"),
      /缺少有效 SHA-512/u,
    );
  });

  it("rollout 从固定 ui-v 标签生成 npm pack，并与 GitHub Release 及基座登记值三方核对", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "workloom-ui-tagged-pack-"));
    const root = join(fixtureRoot, "base");
    const origin = join(fixtureRoot, "origin.git");
    const packFixture = ({ cwd }) => [{
      name: "@workloom/ui",
      version: "1.2.3",
      integrity: `sha512-${createHash("sha512").update(readFileSync(join(cwd, "index.js"))).digest("base64")}`,
    }];
    const taggedPackOptions = {
      root,
      manifest,
      version: "1.2.3",
      prepack: () => "vitest stdout 噪声必须与 npm pack JSON 隔离",
      pack: packFixture,
      readNpmVersion: () => "11.6.2",
      readPnpmVersion: () => "10.14.0",
      expectedOriginUrl: origin,
    };
    try {
      writeTaggedReleaseSource(root);
      initializeMainRepository(root);
      execFileSync("git", ["tag", "ui-v1.2.3"], { cwd: root, stdio: "ignore" });
      createBareOrigin(root, origin);

      const tagged = packTaggedUiArtifact(taggedPackOptions);
      assert.equal(tagged.package, "@workloom/ui");
      assert.equal(tagged.version, "1.2.3");
      assert.equal(tagged.sourceRef, "refs/tags/ui-v1.2.3");
      assert.match(tagged.integrity, /^sha512-/u);
      assert.equal(assertReleasePayloadIntegrity(tagged.releasePayload), true);
      assert.ok(tagged.releasePayload.clientFoundation.fileCount >= 7);
      assert.equal(tagged.releasePayload.governance.fileCount, 13);
      assert.ok(tagged.releasePayload.files.some((file) => (
        file.category === "governance" && file.path === "sync/ui-lockfile-integrity.mjs"
      )));
      assert.equal(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/workloom-release-verification"], { cwd: root, encoding: "utf8" }).trim(), "");

      // 工作树即使出现未提交污染，重新 pack 仍只读取固定标签。
      writeFileSync(join(root, "packages/ui/index.js"), "export const source = 'dirty-worktree';\n");
      const repacked = packTaggedUiArtifact(taggedPackOptions);
      assert.equal(repacked.integrity, tagged.integrity);
      const downloaded = {
        url: fixtureReleaseUrl,
        assetName: "workloom-ui-1.2.3.tgz",
        integrity: tagged.integrity,
        size: fixtureArtifactBytes.length,
      };
      const verified = verifyPublishedArtifact(manifest, "1.2.3", {
        root,
        packArtifact: () => repacked,
        readReleaseArtifact: () => downloaded,
      });
      assert.equal(verified.integrity, tagged.integrity);
      assert.equal(verified.declaredIntegrity, tagged.integrity);
      assert.equal(verified.githubReleaseIntegrity, tagged.integrity);
      assert.equal(verified.releaseAssetUrl, fixtureReleaseUrl);
      assert.equal(verified.releaseAssetSize, fixtureArtifactBytes.length);
      assert.throws(
        () => assertReleaseArtifactIntegrity(repacked, { ...downloaded, integrity: `sha512-${"A".repeat(88)}` }, manifest, "@workloom/ui", "1.2.3"),
        /GitHub Release .*integrity.*登记值不一致/u,
      );
      assert.throws(
        () => assertReleaseArtifactIntegrity(repacked, { ...downloaded, integrity: "1.2.3" }, manifest, "@workloom/ui", "1.2.3"),
        /未返回.*有效非空 tarball/u,
      );
      const mismatchedRegistration = structuredClone(repacked);
      const otherIntegrity = `sha512-${createHash("sha512").update("other artifact").digest("base64")}`;
      mismatchedRegistration.releaseArtifact.sha512 = otherIntegrity;
      const mismatchedManifest = structuredClone(manifest);
      mismatchedManifest.ui.distribution.integrityByVersion["1.2.3"] = otherIntegrity;
      assert.throws(
        () => assertReleaseArtifactIntegrity(mismatchedRegistration, downloaded, mismatchedManifest, "@workloom/ui", "1.2.3"),
        /base-capabilities\.json.*本地 pack 不一致/u,
      );
      const tamperedPayload = structuredClone(repacked);
      tamperedPayload.releasePayload.files[0].sha256 = "0".repeat(64);
      assert.throws(
        () => assertReleaseArtifactIntegrity(tamperedPayload, downloaded, manifest, "@workloom/ui", "1.2.3"),
        /载荷摘要不一致/u,
      );
      assert.throws(
        () => packTaggedUiArtifact({ ...taggedPackOptions, readNpmVersion: () => "latest" }),
        /工具链必须固定/u,
      );

      for (const controller of [
        "sync/ui-upgrade-pr.mjs",
        "sync/client-foundation.mjs",
        "sync/set-ui-version.mjs",
        "sync/install-ui-governance.mjs",
        "sync/install-adoption-assets.mjs",
      ]) {
        const controllerPath = join(root, controller);
        const original = execFileSync("git", ["show", `refs/tags/ui-v1.2.3:${controller}`], { cwd: root });
        writeFileSync(controllerPath, "// dirty rollout controller\n");
        assert.throws(
          () => packTaggedUiArtifact(taggedPackOptions),
          /工作树字节与 canonical .*拒绝下发未封存治理载荷/u,
          `${controller} 脏改必须在任何下游访问前 fail closed`,
        );
        writeFileSync(controllerPath, original);
      }
      const childInventoryPath = join(root, "sync/child-repos.json");
      const childInventory = execFileSync("git", ["show", "refs/tags/ui-v1.2.3:sync/child-repos.json"], { cwd: root });
      writeJson(childInventoryPath, {
        uiRolloutWaveOrder: ["W1"],
        children: Array.from({ length: 8 }, (_, index) => ({ repo: `attacker/repo-${index}`, uiRolloutWave: "W1" })),
      });
      assert.throws(
        () => packTaggedUiArtifact(taggedPackOptions),
        /child-repos\.json 工作树字节与 canonical .*拒绝下发未封存治理载荷/u,
      );
      writeFileSync(childInventoryPath, childInventory);

      execFileSync("git", ["add", "packages/ui/index.js"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@workloom.im", "commit", "-m", "after stable tag"], { cwd: root, stdio: "ignore" });
      assert.throws(
        () => packTaggedUiArtifact(taggedPackOptions),
        /必须在已固定 refs\/tags\/ui-v1\.2\.3/u,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("prepack 真实 stdout 噪声与 npm pack JSON 分离，且 pack 禁止重复脚本", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "workloom-ui-prepack-output-"));
    const root = join(fixtureRoot, "base");
    const origin = join(fixtureRoot, "origin.git");
    const bin = join(fixtureRoot, "bin");
    const marker = join(fixtureRoot, "prepack-complete");
    const lifecycleLog = join(fixtureRoot, "lifecycle.log");
    const previousEnvironment = {
      PATH: process.env.PATH,
      WORKLOOM_PREPACK_MARKER: process.env.WORKLOOM_PREPACK_MARKER,
      WORKLOOM_PACK_LIFECYCLE_LOG: process.env.WORKLOOM_PACK_LIFECYCLE_LOG,
    };
    const restoreEnvironment = () => {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      writeTaggedReleaseSource(root);
      initializeMainRepository(root);
      execFileSync("git", ["tag", "ui-v1.2.3"], { cwd: root, stdio: "ignore" });
      createBareOrigin(root, origin);
      mkdirSync(bin, { recursive: true });
      const pnpmShim = join(bin, "pnpm");
      writeFileSync(pnpmShim, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("10.14.0\\n"); process.exit(0); }
fs.appendFileSync(process.env.WORKLOOM_PACK_LIFECYCLE_LOG, \`pnpm \${args.join(" ")}\\n\`);
if (args[0] !== "run" || args[1] !== "prepack") process.exit(21);
fs.writeFileSync(process.env.WORKLOOM_PREPACK_MARKER, "complete\\n");
process.stdout.write("vitest stdout noise\\n[not npm pack json]\\n");
`);
      chmodSync(pnpmShim, 0o755);
      const npmShim = join(bin, "npm");
      writeFileSync(npmShim, `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("11.6.2\\n"); process.exit(0); }
fs.appendFileSync(process.env.WORKLOOM_PACK_LIFECYCLE_LOG, \`npm \${args.join(" ")}\\n\`);
if (args[0] !== "pack") process.exit(22);
if (!args.includes("--ignore-scripts")) process.stdout.write("prepack pollution before JSON\\n");
if (!fs.existsSync(process.env.WORKLOOM_PREPACK_MARKER)) process.exit(23);
const destination = args[args.indexOf("--pack-destination") + 1];
const bytes = fs.readFileSync(path.join(process.cwd(), "index.js"));
const filename = "workloom-ui-1.2.3.tgz";
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, filename), bytes);
const integrity = \`sha512-\${crypto.createHash("sha512").update(bytes).digest("base64")}\`;
process.stdout.write(JSON.stringify([{ name: "@workloom/ui", version: "1.2.3", filename, integrity }]));
`);
      chmodSync(npmShim, 0o755);
      process.env.PATH = `${bin}:${previousEnvironment.PATH ?? ""}`;
      process.env.WORKLOOM_PREPACK_MARKER = marker;
      process.env.WORKLOOM_PACK_LIFECYCLE_LOG = lifecycleLog;

      const artifact = packTaggedUiArtifact({
        root,
        manifest,
        version: "1.2.3",
        expectedOriginUrl: origin,
      });
      assert.equal(artifact.integrity, fixtureArtifactIntegrity);
      const invocations = readFileSync(lifecycleLog, "utf8").trim().split("\n");
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0], "pnpm run prepack");
      assert.match(invocations[1], /^npm pack --ignore-scripts --json --pack-destination /u);
      assert.equal(existsSync(marker), true);
    } finally {
      restoreEnvironment();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("canonical tag 信任锚拒绝无远端、同名歧义标签与非 main 祖先", () => {
    const roots = [];
    try {
      const noRemote = mkdtempSync(join(tmpdir(), "workloom-ui-no-origin-"));
      roots.push(noRemote);
      initializeMainRepository(noRemote);
      execFileSync("git", ["tag", "ui-v1.2.3"], { cwd: noRemote, stdio: "ignore" });
      assert.throws(
        () => verifyCanonicalReleaseTag({ root: noRemote, sourceRef: "refs/tags/ui-v1.2.3" }),
        /缺少 canonical origin/u,
      );

      const ambiguousRoot = mkdtempSync(join(tmpdir(), "workloom-ui-ambiguous-tag-"));
      roots.push(ambiguousRoot);
      const ambiguousRepo = join(ambiguousRoot, "base");
      const ambiguousOrigin = join(ambiguousRoot, "origin.git");
      initializeMainRepository(ambiguousRepo);
      execFileSync("git", ["tag", "ui-v1.2.3"], { cwd: ambiguousRepo, stdio: "ignore" });
      createBareOrigin(ambiguousRepo, ambiguousOrigin);
      mkdirSync(join(ambiguousRepo, "apps/web"), { recursive: true });
      writeFileSync(join(ambiguousRepo, "apps/web/tampered.tsx"), "export const tampered = true;\n");
      commitFixture(ambiguousRepo, "local payload tamper");
      execFileSync("git", ["tag", "--force", "ui-v1.2.3"], { cwd: ambiguousRepo, stdio: "ignore" });
      assert.throws(
        () => verifyCanonicalReleaseTag({
          root: ambiguousRepo,
          sourceRef: "refs/tags/ui-v1.2.3",
          expectedOriginUrl: ambiguousOrigin,
        }),
        /同名标签不一致/u,
      );

      const sideRoot = mkdtempSync(join(tmpdir(), "workloom-ui-side-tag-"));
      roots.push(sideRoot);
      const sideRepo = join(sideRoot, "base");
      const sideOrigin = join(sideRoot, "origin.git");
      initializeMainRepository(sideRepo);
      execFileSync("git", ["tag", "ui-v1.2.3"], { cwd: sideRepo, stdio: "ignore" });
      createBareOrigin(sideRepo, sideOrigin, { pushTag: false });
      execFileSync("git", ["switch", "-c", "side-release"], { cwd: sideRepo, stdio: "ignore" });
      writeFileSync(join(sideRepo, "SIDE.md"), "not merged to main\n");
      commitFixture(sideRepo, "side release");
      execFileSync("git", ["tag", "--force", "ui-v1.2.3"], { cwd: sideRepo, stdio: "ignore" });
      execFileSync("git", ["push", "--force", "origin", "refs/tags/ui-v1.2.3"], { cwd: sideRepo, stdio: "ignore" });
      assert.throws(
        () => verifyCanonicalReleaseTag({
          root: sideRepo,
          sourceRef: "refs/tags/ui-v1.2.3",
          expectedOriginUrl: sideOrigin,
        }),
        /不是 canonical origin\/main 的祖先/u,
      );
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  it("GitHub Release 下载固定 canonical URL、禁用 curlrc 并从真实字节计算 sha512", () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-malicious-curl-home-"));
    const maliciousHome = join(root, "home");
    mkdirSync(maliciousHome, { recursive: true });
    writeFileSync(join(maliciousHome, ".curlrc"), "url = https://attacker.invalid/payload.tgz\n");
    try {
      const actual = readCanonicalGithubReleaseArtifact({
        manifest,
        targetVersion: "1.2.3",
        ambientEnvironment: {
          ...process.env,
          HOME: maliciousHome,
          GH_TOKEN: "must-not-leak",
          GITHUB_TOKEN: "must-not-leak",
          NPM_CONFIG_REGISTRY: "https://registry.attacker.invalid",
        },
        execute(command, args, options) {
          assert.equal(command, "curl");
          assert.equal(args[0], "--disable");
          assert.equal(args.at(-1), fixtureReleaseUrl);
          assert.deepEqual(args.slice(args.indexOf("--proto"), args.indexOf("--proto") + 2), ["--proto", "=https"]);
          assert.deepEqual(args.slice(args.indexOf("--proto-redir"), args.indexOf("--proto-redir") + 2), ["--proto-redir", "=https"]);
          assert.equal(options.encoding, null);
          assert.equal(options.env.GH_TOKEN, undefined);
          assert.equal(options.env.GITHUB_TOKEN, undefined);
          assert.equal(options.env.NPM_CONFIG_REGISTRY, undefined);
          return fixtureArtifactBytes;
        },
      });
      assert.deepEqual(actual, {
        url: fixtureReleaseUrl,
        assetName: "workloom-ui-1.2.3.tgz",
        integrity: fixtureArtifactIntegrity,
        size: fixtureArtifactBytes.length,
      });
      assert.deepEqual(resolveUiReleaseArtifact(manifest, "1.2.3"), {
        type: "github-release-tarball",
        url: fixtureReleaseUrl,
        assetName: "workloom-ui-1.2.3.tgz",
        sha512: fixtureArtifactIntegrity,
        overrideSelector: "@workloom/ui@1.2.3",
      });
      assert.throws(
        () => readCanonicalGithubReleaseArtifact({
          manifest: {
            ...manifest,
            ui: { ...manifest.ui, distribution: { ...manifest.ui.distribution, assetNameTemplate: "other-{version}.tgz" } },
          },
          targetVersion: "1.2.3",
          execute: () => { throw new Error("不应访问网络"); },
        }),
        /assetNameTemplate 必须为/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("公开下游只读克隆固定 HTTP/1.1，并在两个瞬态失败后用全新目录成功", () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-ui-clone-retry-"));
    const targets = [];
    const delays = [];
    try {
      const checkout = cloneChildReadOnly({ repo: "org/example" }, root, "", {
        backoffMs: 2,
        sleep(milliseconds) { delays.push(milliseconds); },
        cloneRunner({ attempt, target, args }) {
          targets.push(target);
          assert.deepEqual(args.slice(0, 3), ["-c", "http.version=HTTP/1.1", "clone"]);
          assert.deepEqual(args.slice(3, 6), ["--depth", "1", "--no-tags"]);
          assert.equal(args.at(-2), "https://github.com/org/example.git");
          assert.equal(args.at(-1), target);
          if (attempt < 3) {
            mkdirSync(target, { recursive: true });
            writeFileSync(join(target, "partial"), "incomplete\n");
            const error = new Error("RPC failed");
            error.stderr = Buffer.from("error: RPC failed; HTTP/2 stream closed; early EOF");
            throw error;
          }
          initializeMainRepository(target);
        },
      });

      assert.equal(new Set(targets).size, 3, "每次重试必须使用全新目标目录");
      assert.deepEqual(delays, [2, 4]);
      assert.equal(checkout, targets[2]);
      assert.ok(existsSync(join(checkout, ".git")));
      assert.equal(existsSync(dirname(targets[0])), false, "第一次失败残留必须清理");
      assert.equal(existsSync(dirname(targets[1])), false, "第二次失败残留必须清理");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("瞬态克隆永久失败会在有限重试后 fail closed、清理残留并结构化脱敏", () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-ui-clone-permanent-"));
    const token = ["ghp", "A".repeat(36)].join("_");
    const encodedHeader = Buffer.from(`x-access-token:${token}`).toString("base64");
    let attempts = 0;
    let caught;
    try {
      cloneChildReadOnly({ repo: "org/missing" }, root, token, {
        backoffMs: 0,
        sleep() {},
        cloneRunner({ target, args }) {
          attempts += 1;
          assert.equal(args.at(-2), "https://github.com/org/missing.git");
          assert.doesNotMatch(args.join(" "), /x-access-token|ghp_/u, "认证不得进入 URL 或命令参数");
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "partial"), "incomplete\n");
          const error = new Error("clone failed");
          error.stderr = Buffer.from([
            "error: RPC failed; HTTP/2 stream closed; early EOF",
            `Authorization: Basic ${encodedHeader}`,
            ["fatal: unable to access '", "https://", `x-access-token:${token}`, "@github.com/org/missing.git'"].join(""),
          ].join("\n"));
          throw error;
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught);
    assert.equal(caught.code, "WORKLOOM_READ_ONLY_CLONE_FAILED");
    assert.equal(caught.classification, "network-transient");
    assert.equal(caught.attempts, 3);
    assert.equal(attempts, 3);
    assert.doesNotMatch(caught.message, new RegExp(token, "u"));
    assert.doesNotMatch(caught.message, new RegExp(encodedHeader, "u"));
    assert.doesNotMatch(caught.message, /https:\/\/x-access-token:/u);
    assert.match(caught.message, /\[REDACTED\]/u);
    assert.deepEqual(readdirSync(root), [], "永久失败不得留下半克隆目录");
    rmSync(root, { recursive: true, force: true });
  });

  it("克隆错误分类与通用诊断脱敏保持确定性", () => {
    assert.equal(classifyCloneFailure("RPC failed; HTTP/2 stream closed"), "network-transient");
    assert.equal(classifyCloneFailure("HTTP 429 rate limit exceeded"), "rate-limited");
    assert.equal(classifyCloneFailure("Authentication failed"), "authentication");
    assert.equal(classifyCloneFailure("Repository not found"), "repository-unavailable");
    assert.equal(classifyCloneFailure("unexpected git error"), "unknown");
    assert.equal(
      redactCloneDiagnostic(["fatal https://", "user:password", "@example.test/repo.git"].join("")),
      "fatal https://[REDACTED]@example.test/repo.git",
    );
  });

  it("存量迁移缺口会结构化报告，但不反向阻断基座稳定制品", () => {
    const children = Array.from({ length: 8 }, (_, index) => ({ repo: `org/repo-${index}`, pathPrefix: "", uiRolloutWave: index < 2 ? "W1" : "W2" }));
    let cloneCalls = 0;
    const cloneRoots = [];
    const report = preflightChildren({
      children,
      waveOrder,
      manifest,
      version: "1.2.3",
      cloneChild(_child, target) {
        cloneCalls += 1;
        cloneRoots.push(target);
        initializeMainRepository(target);
      },
    });
    assert.equal(cloneCalls, 8);
    assert.ok(cloneRoots.every((target) => !existsSync(target)), "成功预检的临时工作树也必须全部清理");
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
    let failedTemp;
    const report = preflightChildren({
      children,
      waveOrder,
      manifest,
      version: "1.2.3",
      cloneChild(child, target) {
        if (child.repo.endsWith("repo-7")) {
          failedTemp = target;
          writeFileSync(join(target, "partial"), "incomplete\n");
          throw new Error("denied");
        }
        initializeMainRepository(target);
      },
    });
    assert.equal(report.baseReleaseReady, false);
    assert.equal(report.summary.unreachable, 1);
    assert.equal(existsSync(failedTemp), false, "preflight 最终路径必须在失败后清理");
    assert.ok(report.repositories.at(-1).blockers.some((entry) => entry.code === "CLONE_FAILED"
      && entry.phase === "access"
      && entry.failureClass === "unknown"
      && entry.attempts === 1));
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

  it("升级编排只逐路径暂存声明且实际变化的精确白名单", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-exact-stage-"));
    try {
      initializeMainRepository(repo);
      writeFileSync(join(repo, "README.md"), "updated\n");
      mkdirSync(join(repo, ".github/workflows"), { recursive: true });
      writeFileSync(join(repo, ".github/workflows/workloom-ui-contract.yml"), "name: contract\n");
      const staged = stageExactUpgradeChanges({
        repoRoot: repo,
        allowedPaths: ["README.md", ".github/workflows/workloom-ui-contract.yml", "pnpm-lock.yaml"],
      });
      assert.deepEqual(staged, [".github/workflows/workloom-ui-contract.yml", "README.md"]);
      const cached = execFileSync(
        "git",
        ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"],
        { cwd: repo, encoding: "utf8" },
      ).split("\0").filter(Boolean).sort();
      assert.deepEqual(cached, staged);
      assert.equal(execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD", "--"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean).length, 2);
      assert.equal(execFileSync("git", ["diff", "--name-only", "--no-renames", "--"], { cwd: repo, encoding: "utf8" }).trim(), "");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("升级编排对生成的额外资产及暂存遗漏或夹带一律 fail closed", () => {
    const repo = mkdtempSync(join(tmpdir(), "workloom-ui-exact-stage-blocked-"));
    try {
      initializeMainRepository(repo);
      writeFileSync(join(repo, "README.md"), "updated\n");
      mkdirSync(join(repo, "playwright-report"), { recursive: true });
      writeFileSync(join(repo, "playwright-report/result.json"), "{}\n");
      assert.throws(
        () => stageExactUpgradeChanges({ repoRoot: repo, allowedPaths: ["README.md"] }),
        /未声明变更.*playwright-report\/result\.json/u,
      );
      assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).trim(), "");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }

    const ignoredRepo = mkdtempSync(join(tmpdir(), "workloom-ui-exact-stage-ignored-"));
    try {
      writeFileSync(join(ignoredRepo, ".gitignore"), ".workloom-ui.json\n");
      initializeMainRepository(ignoredRepo);
      writeFileSync(join(ignoredRepo, ".workloom-ui.json"), "{}\n");
      assert.throws(
        () => stageExactUpgradeChanges({ repoRoot: ignoredRepo, allowedPaths: [".workloom-ui.json"] }),
        undefined,
        "声明资产即使被目标仓 ignore 也不能漏报为 already-current",
      );
      assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: ignoredRepo, encoding: "utf8" }).trim(), "");
    } finally {
      rmSync(ignoredRepo, { recursive: true, force: true });
    }

    assert.throws(
      () => assertExactUpgradePathSet({
        allowedPaths: ["package.json", "pnpm-lock.yaml"],
        changedPaths: ["package.json", "pnpm-lock.yaml"],
        stagedPaths: ["package.json"],
      }),
      /遗漏：pnpm-lock\.yaml/u,
    );
    assert.throws(
      () => assertExactUpgradePathSet({
        allowedPaths: ["package.json", "pnpm-lock.yaml"],
        changedPaths: ["package.json"],
        stagedPaths: ["package.json", "pnpm-lock.yaml"],
      }),
      /额外：pnpm-lock\.yaml/u,
    );
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

  it("跨仓 token 不会被 pnpm、npm、verifier 或普通 git 子进程继承", () => {
    const environment = sanitizedSubprocessEnvironment({
      PATH: "/fixture/bin",
      SYNC_TOKEN: "fixture-sync-secret",
      GH_TOKEN: "fixture-gh-secret",
      GITHUB_TOKEN: "fixture-github-secret",
      NPM_TOKEN: "fixture-npm-secret",
      NODE_AUTH_TOKEN: "fixture-node-auth-secret",
      NPM_CONFIG_USERCONFIG: "/tmp/secret-npmrc",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic sentinel",
    }, {
      LANG: "zh_CN.UTF-8",
      SYNC_TOKEN: "explicit-secret-must-still-be-removed",
    });
    assert.equal(environment.PATH, "/fixture/bin");
    assert.equal(environment.LANG, "zh_CN.UTF-8");
    assert.equal(environment.SYNC_TOKEN, undefined);
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.NPM_TOKEN, undefined);
    assert.equal(environment.NODE_AUTH_TOKEN, undefined);
    assert.equal(environment.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(environment.GIT_CONFIG_COUNT, undefined);
    assert.equal(environment.GIT_CONFIG_KEY_0, undefined);
    assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
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

  it("工作流以固定 main 标签完成无凭据预检、受保护 GitHub Release 发布与逐步 rollout", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ui-release.yml"), "utf8");
    const parsed = YAML.parse(workflow);
    assert.match(workflow, /^# ui-v\* 只封存共享 UI 与三端客户端基座/mu);
    assert.match(workflow, /^name: shared-ui-client-foundation-release$/mu);
    assert.match(workflow, /候选 Bundle 契约、摘要与投影一致性门禁/u);
    assert.doesNotMatch(workflow, /BUNDLE_SIGNING_PRIVATE_KEY|BUNDLE_SIGNING_KEY_ID|pnpm bundle:release|build\/bundle-trust\.json/u);
    assert.deepEqual(findUiReleaseWorkflowRisks(workflow), []);
    assert.deepEqual(parsed.concurrency, {
      group: "shared-ui-release-${{ github.ref }}",
      "cancel-in-progress": false,
    });

    const verify = parsed.jobs["verify-and-preflight"];
    const releaseTarget = verify.steps.find((step) => step.id === "release-target");
    const preflight = verify.steps.find((step) => step.name === "八个下游仓访问与迁移现状只读预检");
    assert.ok(releaseTarget && preflight);
    assert.match(releaseTarget.run, /git merge-base --is-ancestor "\$TARGET_SHA" refs\/remotes\/origin\/main/u);
    assert.match(releaseTarget.run, /git checkout --detach "\$TARGET_SHA"/u);
    assert.equal(preflight.if, undefined, "公开八仓 preflight 不得被 token 条件跳过");
    assert.doesNotMatch(JSON.stringify(preflight), /SYNC_TOKEN/u);

    const publish = parsed.jobs["publish-github-release"];
    const automaticRollout = parsed.jobs["rollout-after-release"];
    const continueRollout = parsed.jobs["continue-rollout"];
    assert.equal(publish.needs, "verify-and-preflight");
    assert.deepEqual(automaticRollout.needs, ["verify-and-preflight", "publish-github-release"]);
    assert.equal(continueRollout.needs, "verify-and-preflight");
    for (const job of [publish, automaticRollout, continueRollout]) assert.equal(job.environment, "production");
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.deepEqual(automaticRollout.permissions, { contents: "read" });
    assert.doesNotMatch(JSON.stringify(parsed.jobs), /id-token/u);
    for (const job of Object.values(parsed.jobs)) assert.equal(job.env?.SYNC_TOKEN, undefined, "跨仓 token 不得放到 job scope");
    const tokenSteps = Object.entries(parsed.jobs).flatMap(([jobName, job]) => (job.steps ?? [])
      .filter((step) => step.env?.SYNC_TOKEN !== undefined)
      .map((step) => `${jobName}:${step.name}`));
    assert.deepEqual(tokenSteps, [
      "continue-rollout:按严格波次继续创建独立升级 PR",
    ]);
    assert.doesNotMatch(JSON.stringify(automaticRollout), /SYNC_TOKEN|--rollout/u);
    assert.match(JSON.stringify(automaticRollout), /--verify-artifact/u);
    const fakeRollout = structuredClone(parsed);
    fakeRollout.jobs["continue-rollout"].steps
      .find((step) => step.name === "按严格波次继续创建独立升级 PR").run = [
        "ARGS=(--rollout --version \"$STABLE_VERSION\")",
        "# node sync/ui-upgrade-pr.mjs \"${ARGS[@]}\"",
        "echo \"没有执行跨仓写入\"",
      ].join("\n");
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(fakeRollout))
      .some((risk) => risk.includes("只能在实际写 rollout 的 step")),
    "只有 ARGS 或注释中的命令不得获得 SYNC_TOKEN");

    const versionOnlyManualGate = structuredClone(parsed);
    versionOnlyManualGate.jobs["continue-rollout"].steps
      .find((step) => step.name === "从 GitHub Release 核验手动 rollout 的不可变 UI 制品").run =
        'echo "$STABLE_VERSION"';
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(versionOnlyManualGate))
      .some((risk) => risk.includes("GitHub Release sha512 预校验")),
    "手动 rollout 只读版本号不得通过语义契约");

    const lateIntegrityGate = structuredClone(parsed);
    const lateSteps = lateIntegrityGate.jobs["continue-rollout"].steps;
    const integrityIndex = lateSteps.findIndex((step) => step.name === "从 GitHub Release 核验手动 rollout 的不可变 UI 制品");
    lateSteps.push(...lateSteps.splice(integrityIndex, 1));
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(lateIntegrityGate))
      .some((risk) => risk.includes("先通过 GitHub Release sha512")),
    "完整性核验位于跨仓写入之后不得通过");

    const floatingPackCli = structuredClone(parsed);
    floatingPackCli.jobs["continue-rollout"].steps
      .find((step) => step.name === "固定复算不可变制品的 npm CLI").run = "npm install --global npm@latest";
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(floatingPackCli))
      .some((risk) => risk.includes("固定 npm 11.6.2")),
    "手动复算不得使用随时间漂移的 npm CLI");
    const pollutedPackMetadata = structuredClone(parsed);
    const packStep = pollutedPackMetadata.jobs["verify-and-preflight"].steps
      .find((step) => step.name === "生成待发布的不可变 UI 制品");
    packStep.run = packStep.run
      .replace("pnpm -C packages/ui run prepack", "echo 跳过显式 prepack")
      .replace("npm pack --ignore-scripts --json", "npm pack --json");
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(pollutedPackMetadata))
      .some((risk) => risk.includes("--ignore-scripts 生成纯净 JSON metadata")),
    "npm pack 不得让 prepack 测试输出污染 JSON metadata");
    const noByteComparison = structuredClone(parsed);
    noByteComparison.jobs["publish-github-release"].steps
      .find((step) => step.name === "发布或逐字节核验 GitHub Release 稳定制品").run =
        noByteComparison.jobs["publish-github-release"].steps
          .find((step) => step.name === "发布或逐字节核验 GitHub Release 稳定制品").run
          .replace('cmp -s "$TARBALL" "$REMOTE_DIR/$EXPECTED_ASSET"', "echo 跳过逐字节比较");
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(noByteComparison))
      .some((risk) => risk.includes("cmp -s")),
    "已有 Release 资产未逐字节核验不得继续 rollout");
    const floatingDistribution = structuredClone(parsed);
    floatingDistribution.jobs["verify-and-preflight"].steps
      .find((step) => step.name === "校验 UI 标签、稳定版本登记与 GitHub Release 分发契约").run =
        'node -e \'console.log("只检查版本")\' "$VERSION"';
    assert.ok(findUiReleaseWorkflowRisks(YAML.stringify(floatingDistribution))
      .some((risk) => risk.includes("GitHub Release 分发模板与 sha512")),
    "标签内分发 URL、资产名和 sha512 登记不得漂移");
    assert.equal(automaticRollout.steps[0].with.ref, "${{ needs.verify-and-preflight.outputs.release-sha }}");
    assert.equal(continueRollout.steps[0].with.ref, "${{ needs.verify-and-preflight.outputs.release-sha }}");

    const decoy = structuredClone(parsed);
    decoy.jobs["publish-github-release"].permissions.contents = "read";
    decoy.jobs.decoy = { permissions: { contents: "write" }, steps: [{ run: "echo gh release upload fake" }] };
    const decoyRisks = findUiReleaseWorkflowRisks(YAML.stringify(decoy));
    assert.ok(decoyRisks.some((risk) => risk.includes("publish-github-release 必须且只能拥有 contents: write")),
      "错误 job 的 Release 文本不得让真正 publish job 通过");

    assert.match(workflow, /inputs\.action == 'rollout'/);
    assert.match(workflow, /--wave "\$ROLLOUT_WAVE"/);
    assert.match(workflow, /--repos "\$ROLLOUT_REPOSITORIES"/);
    assert.match(workflow, /sync\/client-foundation\.test\.mjs/u);
    assert.match(workflow, /m\.clientFoundation\?\.latestStableVersion!==v/u);
    assert.match(workflow, /client-foundation\.mjs verify-source/u);
    const desktopWorkflow = readFileSync(join(repoRoot, ".github/workflows/build-desktop.yml"), "utf8");
    assert.match(desktopWorkflow, /BUNDLE_SIGNING_PRIVATE_KEY/u);
    assert.match(desktopWorkflow, /pnpm bundle:release/u);
    assert.match(desktopWorkflow, /build\/bundle-trust\.json/u);
    const implementation = readFileSync(join(repoRoot, "sync/ui-upgrade-pr.mjs"), "utf8");
    assert.match(implementation, /base: "main"/u);
    assert.match(implementation, /applyClientFoundation/u);
    assert.match(implementation, /installUiGovernance/u);
    assert.match(implementation, /installUiGovernance\(\{ repo: workdir, repositoryRoot: checkout, sourceRoot: baseDir \}\)/u);
    assert.match(implementation, /verify-client-foundation-consumer\.mjs/u);
    assert.match(implementation, /ADOPTION_SCRIPTS/u);
    assert.match(implementation, /SYNC_TOKEN\|GH_TOKEN\|GITHUB_TOKEN\|NPM_TOKEN\|NODE_AUTH_TOKEN/u);
    assert.match(implementation, /resolveUiReleaseArtifact/u);
    assert.match(implementation, /readCanonicalGithubReleaseArtifact/u);
    assert.match(implementation, /assertReleaseArtifactIntegrity/u);
    assert.match(implementation, /githubReleaseIntegrity/u);
    assert.match(implementation, /base-capabilities\.json/u);
    assert.match(implementation, /packTaggedUiArtifact/u);
    assert.match(implementation, /prepack\s*=\s*\(\{ cwd \}\)\s*=>\s*run\("pnpm", \["run", "prepack"\]/u);
    assert.match(implementation, /run\("npm", \["pack", "--ignore-scripts", "--json"/u);
    const explicitPrepack = implementation.indexOf("prepack({ cwd: packageRoot");
    const cleanPack = implementation.indexOf("const metadata = pack({ cwd: packageRoot");
    assert.ok(explicitPrepack >= 0 && cleanPack > explicitPrepack,
      "必须先单独执行 prepack，再解析 --ignore-scripts npm pack 的干净 JSON");
    assert.match(implementation, /verifyCanonicalReleaseTag/u);
    assert.match(implementation, /merge-base.*--is-ancestor/su);
    assert.match(implementation, /workloom\.ui-release-payload\/v1/u);
    assert.match(implementation, /clientFoundationDigest/u);
    assert.match(implementation, /governanceDigest/u);
    assert.doesNotMatch(implementation, /npm", \["view"/u);
    assert.doesNotMatch(implementation, /git", \["add", "-A"/u);
    assert.match(implementation, /stageExactUpgradeChanges/u);
    const rolloutIntegrity = implementation.indexOf('const verifiedArtifact = options.mode === "rollout"');
    const downstreamPreflight = implementation.indexOf("const preflight = preflightChildren");
    assert.ok(rolloutIntegrity >= 0 && downstreamPreflight > rolloutIntegrity,
      "任何下游访问都必须发生在固定标签与 GitHub Release 三方完整性核验之后");
    assert.doesNotMatch(implementation, /HEAD:main/u);
    const governanceInstaller = readFileSync(join(repoRoot, "sync/install-ui-governance.mjs"), "utf8");
    assert.match(governanceInstaller, /scripts\/verify-ui-consumer\.mjs/u);
    assert.match(governanceInstaller, /scripts\/ui-governance-rules\.mjs/u);
    assert.match(governanceInstaller, /npm:typescript@5\.9\.3/u);
    assert.match(governanceInstaller, /拒绝静默覆盖/u);
    const lockOnly = implementation.indexOf('"--lockfile-only"');
    const lockIntegrityBinding = implementation.indexOf("bindUiLockfileIntegrity(workdir)");
    const frozenInstall = implementation.indexOf('"--frozen-lockfile"');
    const consumerVerify = implementation.indexOf('scripts/verify-ui-consumer.mjs"), "--repo"');
    assert.ok(lockOnly >= 0 && lockIntegrityBinding > lockOnly && frozenInstall > lockIntegrityBinding && consumerVerify > frozenInstall,
      "rollout 必须先更新锁文件、注入 canonical SRI，再 frozen 安装并运行 verifier");
    const syncWorkflow = readFileSync(join(repoRoot, ".github/workflows/base-sync-push.yml"), "utf8");
    assert.match(syncWorkflow, /sync\/ui-consumer-template\.yml/u);
    const syncSecretSelfTest = syncWorkflow.indexOf("node scripts/secret-scan.mjs --self-test");
    const syncDependencyInstall = syncWorkflow.indexOf("CI=true pnpm install --frozen-lockfile --ignore-scripts");
    const syncEngineTests = syncWorkflow.indexOf("node --test sync/base-sync.test.mjs");
    assert.ok(
      syncSecretSelfTest >= 0 && syncDependencyInstall > syncSecretSelfTest && syncEngineTests > syncDependencyInstall,
      "base-sync plan 必须先自测密钥闸门，再以 ignore-scripts 安装锁定依赖，最后执行同步引擎测试",
    );
    const consumerWorkflow = readFileSync(join(repoRoot, "sync/ui-consumer-template.yml"), "utf8");
    const consumerContract = YAML.parse(consumerWorkflow);
    const consumerGate = consumerContract.jobs["ui-contract"].steps
      .find((step) => step.name === "禁止 UI 分叉并校验三端版本");
    assert.equal(
      consumerGate?.run,
      'node "$WORKLOOM_DIR/scripts/verify-ui-consumer.mjs" --repo "$WORKLOOM_DIR" --require-governance-state',
      "行业仓 required check 不得移除治理 state 与指纹强制校验",
    );
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
    const adoptionInstaller = readFileSync(join(repoRoot, "sync/install-adoption-assets.mjs"), "utf8");
    for (const dependency of buildScriptDependencies) {
      assert.match(`${implementation}\n${adoptionInstaller}`, new RegExp(dependency.replaceAll(".", "\\."), "u"));
    }
  });
});
