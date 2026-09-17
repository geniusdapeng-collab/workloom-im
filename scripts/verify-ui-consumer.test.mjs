import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { verifyUiConsumerRepo } from "./verify-ui-consumer.mjs";
import { bindUiLockfileIntegrity } from "../sync/ui-lockfile-integrity.mjs";

const CLIENTS = [
  { root: "apps/web", marker: "b-pc", shells: "OverlayManager, SideNavigation, TopContextBar, Overlay, Button, Textarea", body: "<OverlayManager><SideNavigation /><TopContextBar /><Overlay /><Button /><Textarea label=\"任务目标\" /></OverlayManager>" },
  { root: "apps/webb", marker: "b-mobile", shells: "OverlayManager, AppShell, BottomTabs, TopContextBar, Drawer, Button, Select", body: "<OverlayManager><AppShell><BottomTabs /><TopContextBar /><Drawer /><Button /><Select label=\"驳回原因\" /></AppShell></OverlayManager>" },
  { root: "apps/webc", marker: "c-mobile", shells: "OverlayManager, AppShell, BottomTabs, TopContextBar, Sheet, Button, Input", body: "<OverlayManager><AppShell><BottomTabs /><TopContextBar /><Sheet /><Button /><Input label=\"咨询内容\" /></AppShell></OverlayManager>" },
];
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const GOVERNANCE_FILES = ["verify-ui-consumer.mjs", "ui-governance-rules.mjs"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const UI_VERSION = "1.2.3";
const UI_URL = `https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v${UI_VERSION}/workloom-ui-${UI_VERSION}.tgz`;
const UI_SHA512 = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const PNPM_10_CLI = process.env.WORKLOOM_PNPM_10_CLI;
const PNPM_COMMAND = PNPM_10_CLI ? process.execPath : "pnpm";
const PNPM_PREFIX = PNPM_10_CLI ? [PNPM_10_CLI] : [];
const PNPM_VERSION = spawnSync(PNPM_COMMAND, [...PNPM_PREFIX, "--version"], { encoding: "utf8" }).stdout?.trim();

function uiState(sha512 = UI_SHA512) {
  return {
    schemaVersion: "workloom.ui-consumer-state/v1",
    package: "@workloom/ui",
    version: UI_VERSION,
    contractVersion: "2.0.0",
    source: "workloom-ai/workloom-im",
    updatePolicy: "upgrade-pr-only",
    releaseChannel: "stable",
    requiredClientPackages: CLIENTS.map((client) => `${client.root}/package.json`),
    connectedClientPackages: CLIENTS.map((client) => `${client.root}/package.json`),
    artifact: {
      type: "github-release-tarball",
      assetName: `workloom-ui-${UI_VERSION}.tgz`,
      url: UI_URL,
      sha512,
    },
  };
}

function runPnpm(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(PNPM_COMMAND, [...PNPM_PREFIX, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writeUiLockfile(repo, {
  url = UI_URL,
  integrity = UI_SHA512,
  includeIntegrity = true,
  omitImporter = "",
  extraPackages = {},
} = {}) {
  const lines = [
    "lockfileVersion: '9.0'",
    "overrides:",
    `  '@workloom/ui@${UI_VERSION}': ${url}`,
    "importers:",
  ];
  for (const client of CLIENTS.filter(({ root }) => root !== omitImporter)) {
    lines.push(
      `  ${client.root}:`,
      "    dependencies:",
      "      '@workloom/ui':",
      `        specifier: ${url}`,
      `        version: ${url}`,
    );
  }
  lines.push(
    "packages:",
    `  '@workloom/ui@${url}':`,
    `    resolution: {${includeIntegrity ? `integrity: ${integrity}, ` : ""}tarball: ${url}}`,
    `    version: ${UI_VERSION}`,
  );
  for (const [key, value] of Object.entries(extraPackages)) {
    const fields = value.resolution ?? {};
    lines.push(
      `  '${key}':`,
      `    resolution: {${fields.integrity ? `integrity: ${fields.integrity}, ` : ""}tarball: ${fields.tarball}}`,
      `    version: ${value.version}`,
    );
  }
  lines.push("snapshots:", `  '@workloom/ui@${url}': {}`, "");
  writeFileSync(join(repo, "pnpm-lock.yaml"), lines.join("\n"));
}

function installGovernanceState(repo) {
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const files = {};
  for (const name of GOVERNANCE_FILES) {
    const relativePath = `scripts/${name}`;
    const target = join(repo, relativePath);
    copyFileSync(join(SCRIPT_ROOT, name), target);
    files[relativePath] = { sha256: sha256(readFileSync(target)) };
  }
  writeFileSync(join(repo, ".workloom-ui-governance.json"), `${JSON.stringify({
    schemaVersion: "workloom.ui-governance-state/v1",
    dependency: "npm:typescript@5.9.3",
    yamlDependency: "npm:yaml@2.9.0",
    updatePolicy: "stable-upgrade-pr-only",
    files,
  })}\n`);
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "workloom-ui-consumer-"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    devDependencies: {
      "typescript-governance": "npm:typescript@5.9.3",
      "yaml-governance": "npm:yaml@2.9.0",
    },
    pnpm: { overrides: { [`@workloom/ui@${UI_VERSION}`]: UI_URL } },
  })}\n`);
  writeFileSync(join(repo, ".workloom-ui.json"), `${JSON.stringify(uiState())}\n`);
  for (const client of CLIENTS) {
    mkdirSync(join(repo, client.root, "src"), { recursive: true });
    writeFileSync(join(repo, client.root, "package.json"), `${JSON.stringify({ dependencies: { "@workloom/ui": UI_VERSION } })}\n`);
    writeFileSync(join(repo, client.root, "src/main.tsx"), [
      'import "@workloom/ui/tokens.css";',
      'import "@workloom/ui/content-safety.css";',
      'import "@workloom/ui/components.css";',
      'import "./App";',
    ].join("\n"));
    writeFileSync(join(repo, client.root, "src/App.tsx"), `import { ${client.shells} } from "@workloom/ui";\nexport function Client(){return <main data-workloom-client="${client.marker}">${client.body}</main>}`);
  }
  writeUiLockfile(repo);
  return repo;
}

describe("行业仓共享界面消费门禁", () => {
  it("强制模式验证治理 state、固定依赖以及 verifier/规则文件指纹", () => {
    const repo = fixture();
    installGovernanceState(repo);
    assert.deepEqual(verifyUiConsumerRepo(repo, { requireGovernanceState: true }), []);
    const cli = spawnSync(process.execPath, [
      join(SCRIPT_ROOT, "verify-ui-consumer.mjs"),
      "--repo",
      repo,
      "--require-governance-state",
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
  });

  it("强制模式拒绝 verifier 在稳定升级 PR 外漂移", () => {
    const repo = fixture();
    installGovernanceState(repo);
    writeFileSync(join(repo, "scripts/verify-ui-consumer.mjs"), "// drifted verifier\n");
    assert.ok(verifyUiConsumerRepo(repo, { requireGovernanceState: true })
      .some((error) => error.includes("verify-ui-consumer.mjs") && error.includes("指纹不一致")));
  });

  it("强制模式拒绝 AST 规则在稳定升级 PR 外漂移", () => {
    const repo = fixture();
    installGovernanceState(repo);
    writeFileSync(join(repo, "scripts/ui-governance-rules.mjs"), "// drifted rules\n");
    assert.ok(verifyUiConsumerRepo(repo, { requireGovernanceState: true })
      .some((error) => error.includes("ui-governance-rules.mjs") && error.includes("指纹不一致")));
  });

  it("强制模式缺少治理 state 时 fail closed", () => {
    const repo = fixture();
    installGovernanceState(repo);
    rmSync(join(repo, ".workloom-ui-governance.json"));
    assert.ok(verifyUiConsumerRepo(repo, { requireGovernanceState: true })
      .some((error) => error.includes("缺少 .workloom-ui-governance.json")));
  });

  it("强制模式拒绝治理 state 的 schema 与更新策略漂移", () => {
    const repo = fixture();
    installGovernanceState(repo);
    const statePath = join(repo, ".workloom-ui-governance.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.schemaVersion = "workloom.ui-governance-state/v2";
    state.updatePolicy = "manual-copy";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const errors = verifyUiConsumerRepo(repo, { requireGovernanceState: true });
    assert.ok(errors.some((error) => error.includes("schemaVersion 必须为")));
    assert.ok(errors.some((error) => error.includes("updatePolicy 必须为")));
  });

  it("强制模式拒绝 state 与 package 同时漂移固定 AST 依赖", () => {
    const repo = fixture();
    installGovernanceState(repo);
    writeFileSync(join(repo, "package.json"), '{"devDependencies":{"typescript-governance":"npm:typescript@5.9.2"}}\n');
    const statePath = join(repo, ".workloom-ui-governance.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.dependency = "npm:typescript@5.9.2";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const errors = verifyUiConsumerRepo(repo, { requireGovernanceState: true });
    assert.ok(errors.some((error) => error.includes("dependency 必须为 npm:typescript@5.9.3")));
    assert.ok(errors.some((error) => error.includes("必须精确依赖 typescript-governance")));
  });

  it("要求三端真实渲染共享壳、弹层和表单", () => {
    assert.deepEqual(verifyUiConsumerRepo(fixture()), []);
  });

  it("Release URL、SHA-512 与根 pnpm override 任一漂移都 fail closed", () => {
    const repo = fixture();
    const statePath = join(repo, ".workloom-ui.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.artifact.url = "https://github.com/someone/fork/releases/download/ui-v1.2.3/workloom-ui-1.2.3.tgz";
    state.artifact.sha512 = "sha512-not-a-digest";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const rootPath = join(repo, "package.json");
    const rootPackage = JSON.parse(readFileSync(rootPath, "utf8"));
    rootPackage.pnpm.overrides = {
      "@workloom/ui@1.2.2": "https://example.invalid/stale.tgz",
    };
    writeFileSync(rootPath, `${JSON.stringify(rootPackage)}\n`);
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("artifact.url")));
    assert.ok(errors.some((error) => error.includes("artifact.sha512")));
    assert.ok(errors.some((error) => error.includes("pnpm.overrides 必须精确设置")));
    assert.ok(errors.some((error) => error.includes("过期的共享 UI override")));
  });

  it("把受控 SHA-512 注入唯一 canonical tarball resolution，重复执行保持幂等", () => {
    const repo = fixture();
    writeUiLockfile(repo, { includeIntegrity: false });
    const first = bindUiLockfileIntegrity(repo);
    assert.equal(first.changed, true);
    assert.equal(first.integrity, UI_SHA512);
    assert.deepEqual(verifyUiConsumerRepo(repo), []);
    const firstBytes = readFileSync(join(repo, "pnpm-lock.yaml"));
    const second = bindUiLockfileIntegrity(repo);
    assert.equal(second.changed, false);
    assert.deepEqual(readFileSync(join(repo, "pnpm-lock.yaml")), firstBytes);
  });

  it("SRI 绑定器在写锁文件前拒绝伪造或不完整的稳定制品 state", () => {
    const mutations = [
      ["schema", (state) => { state.schemaVersion = "workloom.ui-consumer-state/v2"; }],
      ["contract", (state) => { state.contractVersion = "1.0.0"; }],
      ["source", (state) => { state.source = "someone/fork"; }],
      ["channel", (state) => { state.releaseChannel = "candidate"; }],
      ["policy", (state) => { state.updatePolicy = "manual-copy"; }],
      ["asset", (state) => { state.artifact.assetName = "forged.tgz"; }],
      ["url", (state) => { state.artifact.url = "https://example.invalid/forged.tgz"; }],
      ["clients", (state) => { state.requiredClientPackages = ["apps/web/package.json"]; }],
    ];
    for (const [label, mutate] of mutations) {
      const repo = fixture();
      try {
        writeUiLockfile(repo, { includeIntegrity: false });
        const statePath = join(repo, ".workloom-ui.json");
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        mutate(state);
        writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        const before = readFileSync(join(repo, "pnpm-lock.yaml"));
        assert.throws(
          () => bindUiLockfileIntegrity(repo),
          /缺少可用于锁文件验真的稳定 UI 制品契约/u,
          label,
        );
        assert.deepEqual(readFileSync(join(repo, "pnpm-lock.yaml")), before, label);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("真实 pnpm 10.14 frozen install 会拒绝同 URL 下被替换的 tarball 字节", {
    skip: PNPM_VERSION === "10.14.0" ? false : `需要 pnpm 10.14.0，当前为 ${PNPM_VERSION || "不可用"}`,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-ui-pnpm-sri-"));
    const archiveRoot = join(root, "archive");
    const packageRoot = join(archiveRoot, "package");
    const tarballPath = join(root, "workloom-ui-1.2.3.tgz");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@workloom/ui",
      version: UI_VERSION,
      private: true,
      main: "index.js",
    })}\n`);
    writeFileSync(join(packageRoot, "index.js"), "export const stable = true;\n");
    execFileSync("tar", ["-czf", tarballPath, "-C", archiveRoot, "package"]);
    const originalBytes = readFileSync(tarballPath);
    const originalIntegrity = `sha512-${createHash("sha512").update(originalBytes).digest("base64")}`;
    let servedBytes = originalBytes;
    const server = createServer((request, response) => {
      if (request.url !== "/workloom-ui-1.2.3.tgz") {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-length", String(servedBytes.length));
      response.end(servedBytes);
    });
    try {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/workloom-ui-1.2.3.tgz`;
      const localRootPackage = {
        name: "ui-sri-integration",
        private: true,
        packageManager: "pnpm@10.14.0",
        pnpm: { overrides: { [`@workloom/ui@${UI_VERSION}`]: url } },
      };
      writeFileSync(join(root, "package.json"), `${JSON.stringify(localRootPackage, null, 2)}\n`);
      writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
      for (const client of CLIENTS) {
        mkdirSync(join(root, client.root), { recursive: true });
        writeFileSync(join(root, client.root, "package.json"), `${JSON.stringify({
          private: true,
          dependencies: { "@workloom/ui": UI_VERSION },
        })}\n`);
      }
      const generated = await runPnpm([
        "install", "--lockfile-only", "--ignore-scripts", "--fetch-retries=0",
        "--store-dir", join(root, "store-generate"),
      ], root);
      assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
      const lockPath = join(root, "pnpm-lock.yaml");
      const generatedSource = readFileSync(lockPath, "utf8");
      const generatedLock = YAML.parse(generatedSource);
      assert.equal(String(generatedLock.lockfileVersion), "9.0");
      assert.equal(generatedLock.overrides[`@workloom/ui@${UI_VERSION}`], url);
      for (const client of CLIENTS) {
        assert.deepEqual(generatedLock.importers[client.root].dependencies["@workloom/ui"], {
          specifier: url,
          version: url,
        });
      }
      const generatedEntries = Object.entries(generatedLock.packages)
        .filter(([key]) => key.startsWith("@workloom/ui@"));
      assert.equal(generatedEntries.length, 1);
      const [generatedKey, generatedPackage] = generatedEntries[0];
      assert.equal(generatedKey, `@workloom/ui@${url}`);
      assert.equal(generatedPackage.version, UI_VERSION);
      assert.deepEqual(generatedPackage.resolution, { tarball: url });
      assert.doesNotMatch(generatedSource, new RegExp(originalIntegrity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

      // 生产 binder 仍只接受 canonical GitHub Release；这里只把真实 pnpm 生成结构中的 URL
      // 等值替换为 canonical URL，验证它写入 pnpm 实际使用的同一 packages resolution 字段。
      writeFileSync(lockPath, generatedSource.replaceAll(url, UI_URL));
      writeFileSync(join(root, "package.json"), `${JSON.stringify({
        ...localRootPackage,
        pnpm: { overrides: { [`@workloom/ui@${UI_VERSION}`]: UI_URL } },
      }, null, 2)}\n`);
      writeFileSync(join(root, ".workloom-ui.json"), `${JSON.stringify(uiState(originalIntegrity))}\n`);
      assert.equal(bindUiLockfileIntegrity(root).changed, true);
      const canonicalLock = YAML.parse(readFileSync(lockPath, "utf8"));
      const canonicalEntry = Object.entries(canonicalLock.packages)
        .find(([key]) => key.startsWith("@workloom/ui@"));
      assert.equal(canonicalEntry[1].resolution.integrity, originalIntegrity);

      // 独立证明 pnpm 10.14 会执行该 SRI：测试代码直接向本地 URL 的真实生成锁注入摘要，
      // 不给生产 binder 增加任何允许非 canonical URL 的测试后门。
      writeFileSync(join(root, "package.json"), `${JSON.stringify(localRootPackage, null, 2)}\n`);
      const localDocument = YAML.parseDocument(generatedSource);
      localDocument.setIn(["packages", generatedKey, "resolution", "integrity"], originalIntegrity);
      writeFileSync(lockPath, String(localDocument));

      servedBytes = Buffer.from("tampered-release-asset");
      const frozen = await runPnpm([
        "install", "--frozen-lockfile", "--ignore-scripts", "--fetch-retries=0",
        "--store-dir", join(root, "store-tampered"),
      ], root);
      assert.notEqual(frozen.status, 0, "同 URL 异内容 tarball 不得通过 frozen install");
      assert.match(`${frozen.stdout}\n${frozen.stderr}`, /ERR_PNPM_TARBALL_INTEGRITY|unexpected checksum/u);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("锁文件的 SRI、三端 importer、唯一 tarball 与 override 任一漂移都 fail closed", () => {
    const wrongIntegrity = fixture();
    writeUiLockfile(wrongIntegrity, { integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` });
    assert.ok(verifyUiConsumerRepo(wrongIntegrity)
      .some((error) => error.includes("resolution.integrity")));

    const missingImporter = fixture();
    writeUiLockfile(missingImporter, { omitImporter: "apps/webb" });
    assert.ok(verifyUiConsumerRepo(missingImporter)
      .some((error) => error.includes("importer apps/webb 未锁定")));

    const duplicatePackage = fixture();
    writeUiLockfile(duplicatePackage, {
      extraPackages: {
        "@workloom/ui@https://example.invalid/other.tgz": {
          resolution: { tarball: "https://example.invalid/other.tgz", integrity: UI_SHA512 },
          version: UI_VERSION,
        },
      },
    });
    assert.ok(verifyUiConsumerRepo(duplicatePackage)
      .some((error) => error.includes("必须且只能锁定一个")));
  });

  it("拒绝伪造 state schema、包名、来源、通道与预发布版本", () => {
    const repo = fixture();
    const statePath = join(repo, ".workloom-ui.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.schemaVersion = "workloom.ui-consumer-state/v2";
    state.package = "@fork/ui";
    state.source = "someone/fork";
    state.releaseChannel = "candidate";
    state.version = "1.2.3-rc.1";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const errors = verifyUiConsumerRepo(repo);
    for (const fragment of ["schemaVersion", "package 必须为", "source 必须为", "releaseChannel", "精确稳定 semver"]) {
      assert.ok(errors.some((error) => error.includes(fragment)), `未阻断 ${fragment}`);
    }
  });

  it("只导入但不渲染共享壳仍然失败", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8").replace("<AppShell>", "<main>").replace("</AppShell>", "</main>"));
    assert.ok(verifyUiConsumerRepo(repo).some((error) => error.includes("apps/webc 未实际渲染共享基座组件 AppShell")));
  });

  it("state 伪造空三端数组不能跳过固定三端验证", () => {
    const repo = fixture();
    const statePath = join(repo, ".workloom-ui.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.requiredClientPackages = [];
    state.connectedClientPackages = [];
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const missingPath = join(repo, "apps/webc/package.json");
    writeFileSync(missingPath, "{}\n");
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("requiredClientPackages 必须精确登记固定三端")));
    assert.ok(errors.some((error) => error.includes("connectedClientPackages 必须证明固定三端")));
    assert.ok(errors.some((error) => error.includes("apps/webc/package.json 必须精确依赖")));
  });

  it("操作按钮不能代替共享表单控件的真实消费", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(", Input", "")
      .replace('<Input label="咨询内容" />', ""));
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("apps/webc 未实际渲染共享基座组件 共享表单控件")));
    assert.equal(errors.some((error) => error.includes("apps/webc 未实际渲染共享基座组件 共享操作按钮")), false);
  });

  it("共享表单控件也不能代替操作按钮的真实消费", () => {
    const repo = fixture();
    const path = join(repo, "apps/web/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(", Button", "")
      .replace("<Button />", ""));
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("apps/web 未实际渲染共享基座组件 共享操作按钮")));
    assert.equal(errors.some((error) => error.includes("apps/web 未实际渲染共享基座组件 共享表单控件")), false);
  });

  it("拒绝重定义共享令牌和同名公共组件", () => {
    const repo = fixture();
    writeFileSync(join(repo, "apps/webb/src/styles.css"), ":root { --wl-color-action: red; --wl-brand-primary: blue; }\n");
    writeFileSync(join(repo, "apps/webb/src/Button.tsx"), "export function Button(){ return <button>本地按钮</button>; }\n");
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("重新定义共享令牌 --wl-color-action")));
    assert.ok(errors.some((error) => error.includes("疑似本地复制分叉")));
    assert.equal(errors.some((error) => error.includes("--wl-brand-primary")), false);
  });

  it("拒绝骨架、空态、告警条、状态标签、Badge 与 Card 的同义复制", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/local-feedback.tsx");
    writeFileSync(path, [
      "export function SkeletonList(){ return <div>加载中</div>; }",
      "export function EmptyState(){ return <div>暂无数据</div>; }",
      "export function BannerAlert(){ return <div>需要处理</div>; }",
      "export function StatusChip(){ return <span>处理中</span>; }",
      "export function Badge(){ return <span>标签</span>; }",
      "export function Card(){ return <section>内容</section>; }",
    ].join("\n"));
    const errors = verifyUiConsumerRepo(repo);
    for (const component of ["SkeletonList", "EmptyState", "BannerAlert", "StatusChip", "Badge", "Card"]) {
      assert.ok(errors.some((error) => error.includes(`本地定义 ${component}`)), `未拦截 ${component}`);
    }
  });

  it("行业新文件不能绕过底层字段、模态层级与 PC 左侧导航门禁", () => {
    const repo = fixture();
    mkdirSync(join(repo, "apps/web/src/extensions/hotel"), { recursive: true });
    mkdirSync(join(repo, "apps/web/src/config/industry"), { recursive: true });
    mkdirSync(join(repo, "apps/web/src/theme/industry"), { recursive: true });
    mkdirSync(join(repo, "apps/web/public/industry"), { recursive: true });
    writeFileSync(join(repo, "apps/web/src/extensions/hotel/Page.tsx"), `
      const modalSurface = {};
      export function Page({ response }) {
        return <><PageNav /><nav><button>概览</button></nav><p>{response.tenant_id}</p>
          <div {...modalSurface} data-wl-managed-surface="dialog" role="dialog">{response.error.message}</div></>;
      }
    `);
    writeFileSync(join(repo, "apps/web/src/config/industry/NavConfig.tsx"), "export const NavConfig=()=> <nav>配置导航</nav>;\n");
    writeFileSync(join(repo, "apps/web/src/theme/industry/ThemeTop.tsx"), "export const ThemeTop=()=> <TopNav />;\n");
    writeFileSync(join(repo, "apps/web/public/industry/navigation.js"), "export const PublicNav=()=> <PageNavigation />;\n");
    writeFileSync(join(repo, "apps/web/src/config/industry/HotelModal.tsx"), "export function HotelModal(){ return <div className=\"fixed inset-0 z-50\">确认</div>; }\n");
    writeFileSync(join(repo, "apps/web/src/theme/industry/InlineLayer.tsx"), "export const InlineLayer=()=> <section style={{ position: \"fixed\", inset: 0, zIndex: 999 }}>确认</section>;\n");
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("tenant_id")));
    assert.ok(errors.some((error) => error.includes("共享受管表面")));
    for (const file of ["NavConfig.tsx", "ThemeTop.tsx", "public/industry/navigation.js"]) {
      assert.ok(errors.some((error) => error.includes(file) && error.includes("不得自建顶部/横向导航")), `未拦截 ${file}`);
    }
    assert.ok(errors.some((error) => error.includes("HotelModal.tsx") && error.includes("必须委托")));
    assert.ok(errors.some((error) => error.includes("HotelModal.tsx") && error.includes("无 role 覆盖层")));
    assert.ok(errors.some((error) => error.includes("InlineLayer.tsx") && error.includes("无 role 覆盖层")));
    assert.ok(errors.some((error) => error.includes("本地定义") || error.includes("PageNav")));
  });

  it("行业非导航配置、共享左栏和共享受管浮层保持可用", () => {
    const repo = fixture();
    mkdirSync(join(repo, "apps/web/src/config/industry"), { recursive: true });
    mkdirSync(join(repo, "apps/web/src/theme/industry"), { recursive: true });
    writeFileSync(join(repo, "apps/web/src/config/industry/SectionView.tsx"), `
      import { SectionNavigation } from "@workloom/ui";
      export const SectionView=()=> <SectionNavigation items={[]} />;
    `);
    writeFileSync(join(repo, "apps/web/src/config/industry/DecisionSurface.tsx"), `
      import { Dialog as BaseDialog } from "@workloom/ui";
      export function DecisionSurface(){ return <BaseDialog open title="确认" onClose={()=>{}}>内容</BaseDialog>; }
    `);
    writeFileSync(join(repo, "apps/web/src/theme/industry/theme.ts"), `
      export const industryTheme = { placement: "left", density: "comfortable" };
    `);
    assert.deepEqual(verifyUiConsumerRepo(repo), []);
  });

  it("拒绝跨文件第三方 surface 转出、变量 alias 与 CSS module 覆盖层", () => {
    const repo = fixture();
    const industryDir = join(repo, "apps/web/src/config/industry");
    mkdirSync(industryDir, { recursive: true });
    writeFileSync(join(industryDir, "surface-barrel.ts"), 'export { HotelDialog } from "third-party-ui";\n');
    writeFileSync(join(industryDir, "UseHotelDialog.tsx"), `
      import { HotelDialog } from "./surface-barrel";
      export const UseHotelDialog=()=> <HotelDialog />;
    `);
    writeFileSync(join(industryDir, "surface-alias.ts"), `
      import { ThirdPartyModal } from "third-party-ui";
      export const HotelDialog = ThirdPartyModal;
    `);
    writeFileSync(join(industryDir, "cover.module.css"), ".cover { position: fixed; inset: 0; z-index: 999; }\n");
    writeFileSync(join(industryDir, "ShadowDecoy.tsx"), `
      import { Dialog } from "@workloom/ui";
      import { VendorPanel } from "third-party-ui";
      export function HotelDialog(){ return <VendorPanel />; }
      function Decoy(){ function HotelDialog(){ return <Dialog open />; } return null; }
    `);
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("surface-barrel.ts") && error.includes("不得从非 @workloom/ui 来源重导出")));
    assert.ok(errors.some((error) => error.includes("UseHotelDialog.tsx") && error.includes("禁止未知或第三方包装")));
    assert.ok(errors.some((error) => error.includes("surface-alias.ts") && error.includes("变量 alias")));
    assert.ok(errors.some((error) => error.includes("cover.module.css") && error.includes("不得自建 fixed")));
    assert.ok(errors.some((error) => error.includes("ShadowDecoy.tsx") && error.includes("同名或词法阴影")));
  });

  it("允许跨文件直接委托共享 surface 的包装与普通 fixed 页头", () => {
    const repo = fixture();
    const industryDir = join(repo, "apps/web/src/config/industry");
    mkdirSync(industryDir, { recursive: true });
    writeFileSync(join(industryDir, "RejectDialog.tsx"), `
      import { Dialog as BaseDialog } from "@workloom/ui";
      export function RejectDialog(props){ return <BaseDialog {...props} />; }
    `);
    writeFileSync(join(industryDir, "UseRejectDialog.tsx"), `
      import { RejectDialog } from "./RejectDialog";
      export const UseRejectDialog=()=> <RejectDialog open />;
    `);
    writeFileSync(join(industryDir, "header.module.scss"), ".header { position: fixed; top: 0; z-index: 20; }\n");
    writeFileSync(join(industryDir, "ScopedDialog.tsx"), `
      import { Dialog as BaseDialog } from "@workloom/ui";
      export function ScopedFeature(){
        function LocalDialog(props){ return <BaseDialog {...props} />; }
        return <LocalDialog open />;
      }
    `);
    assert.deepEqual(verifyUiConsumerRepo(repo), []);
  });

  it("拒绝行业样式用强制单行、伪元素原始属性逃逸", () => {
    const repo = fixture();
    writeFileSync(join(repo, "apps/webc/src/industry.css"), '.raw::before{content:attr(data-status);white-space:nowrap}.variable::after{content:var(--raw-status)}\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("强制单行")));
    assert.ok(errors.some((error) => error.includes("未治理属性")));
    assert.ok(errors.some((error) => error.includes("变量注入")));
  });

  it("行业 JSON 文案、远端资源、跨扩展样式与嵌入式 fork UI 均 fail closed", () => {
    const repo = fixture();
    const extension = join(repo, "apps/web/src/extensions/hotel");
    const publicIndustry = join(repo, "apps/web/public/industry/hotel");
    mkdirSync(join(extension, "styles"), { recursive: true });
    mkdirSync(publicIndustry, { recursive: true });
    writeFileSync(join(extension, "labels.json"), '{"title":"tenant_id"}\n');
    writeFileSync(join(extension, "messages.yml"), "display:\n  title: |-\n    tenant_id console\n");
    writeFileSync(join(extension, "Page.tsx"), `
      import labels from "./labels.json";
      import messages from "./messages.yml";
      export const Page=()=> <><span>{labels.title}</span>
        <iframe src="https://fork.example/ui" />
        <iframe src="/unmanaged.html" />
        <iframe src="/industry/other/help.html" />
        <iframe src="/industry/hotel/missing.html" />
        <object data="/industry/hotel/app.js" />
        <embed src={remoteUrl} />
      </>;
    `);
    writeFileSync(join(extension, "styles/main.scss"), [
      '@import "https://cdn.example/fork.css";',
      '@use "../../../other/styles";',
      '@import $dynamicTheme;',
    ].join("\n"));
    writeFileSync(join(publicIndustry, "index.html"), [
      '<html lang="zh-CN"><head>',
      '<script src="https://cdn.example/fork.js"></script>',
      '<link rel="stylesheet" href="//cdn.example/fork.css">',
      '</head><body></body></html>',
    ].join("\n"));
    writeFileSync(join(repo, "apps/web/public/unmanaged.html"), '<html lang="zh-CN"><script src="https://fork.example/ui.js"></script></html>\n');
    mkdirSync(join(repo, "apps/webb/public/industry/hotel"), { recursive: true });
    writeFileSync(join(repo, "apps/webb/public/industry/hotel/index.html"), '<html lang="zh-CN"><iframe src="https://fork.example/ui"></iframe></html>\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("labels.json") && error.includes("tenant_id")));
    assert.ok(errors.some((error) => error.includes("labels.json") && error.includes("display 与 machine")));
    assert.ok(errors.some((error) => error.includes("messages.yml") && error.includes("block scalar")));
    assert.ok(errors.some((error) => error.includes("main.scss") && error.includes("禁止外部")));
    assert.ok(errors.some((error) => error.includes("main.scss") && error.includes("越出当前扩展边界")));
    assert.ok(errors.some((error) => error.includes("main.scss") && error.includes("无插值")));
    assert.ok(errors.some((error) => error.includes("index.html") && error.includes("静态相对本地资源")));
    assert.ok(errors.some((error) => error.includes("Page.tsx") && error.includes("iframe/webview/object/embed")));
    assert.ok(errors.some((error) => error.includes("Page.tsx") && error.includes("/industry/hotel/")));
    assert.ok(errors.some((error) => error.includes("Page.tsx") && error.includes("HTML 不存在")));
    assert.ok(errors.some((error) => error.includes("Page.tsx") && error.includes("必须指向受审 HTML")));
    assert.ok(errors.some((error) => error.includes("apps/webb/public/industry/hotel/index.html") && error.includes("嵌入界面")));
  });

  it("行业 machine/display 分离及本地 CSS/HTML 递归资源图保持可用", () => {
    const repo = fixture();
    const extension = join(repo, "apps/web/src/extensions/hotel");
    const styles = join(extension, "styles");
    const publicIndustry = join(repo, "apps/web/public/industry/hotel");
    mkdirSync(join(styles, "partials"), { recursive: true });
    mkdirSync(publicIndustry, { recursive: true });
    writeFileSync(join(extension, "labels.json"), JSON.stringify({
      machine: { tenant_id: "raw_tenant" },
      display: { title: "租户" },
    }));
    writeFileSync(join(extension, "Page.tsx"), `
      import labels from "./labels.json";
      export const Page=()=> <><span>{labels.display.title}</span><iframe src="/industry/hotel/index.html" /></>;
    `);
    writeFileSync(join(styles, "main.scss"), '@use "./partials/tokens";\n');
    writeFileSync(join(styles, "partials/_tokens.scss"), '@import "./more.css";\n.header { position: fixed; top: 0; z-index: 20; }\n');
    writeFileSync(join(styles, "partials/more.css"), ".copy { overflow-wrap: anywhere; }\n");
    writeFileSync(join(publicIndustry, "index.html"), '<html lang="zh-CN"><head><script src="./app.js"></script><link rel="stylesheet" href="./app.css"></head><body>帮助<iframe src="./nested.html"></iframe><object data="/industry/hotel/nested.html"></object></body></html>\n');
    writeFileSync(join(publicIndustry, "nested.html"), '<html lang="zh-CN"><head><script src="./nested.js"></script></head><body>详情</body></html>\n');
    writeFileSync(join(publicIndustry, "nested.js"), "export const ready = true;\n");
    writeFileSync(join(publicIndustry, "app.js"), "export const ready = true;\n");
    writeFileSync(join(publicIndustry, "app.css"), ".copy { overflow-wrap: anywhere; }\n");
    assert.deepEqual(verifyUiConsumerRepo(repo), []);
  });

  it("行业 public 配置与安装清单中的英文底层字段不能逃逸", () => {
    const repo = fixture();
    mkdirSync(join(repo, "apps/webc/public/industry"), { recursive: true });
    mkdirSync(join(repo, "apps/web/public/install"), { recursive: true });
    mkdirSync(join(repo, "apps/webb/public"), { recursive: true });
    writeFileSync(join(repo, "apps/webc/public/industry/custom.json"), '{"title":"tenant_id console"}\n');
    writeFileSync(join(repo, "apps/webb/public/manifest.webmanifest"), '{"name":"status console","lang":"en"}\n');
    writeFileSync(join(repo, "apps/web/public/manifest.json"), '{"name":"tenant_id console","lang":"en"}\n');
    writeFileSync(join(repo, "apps/web/public/install/app.webmanifest"), '{"name":"raw status","lang":"en"}\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("custom.json") && error.includes("英文底层字段")));
    assert.ok(errors.some((error) => error.includes("manifest.webmanifest") && error.includes("中文语言")));
    assert.ok(errors.some((error) => error.includes("manifest.json") && error.includes("中文语言")));
    assert.ok(errors.some((error) => error.includes("app.webmanifest") && error.includes("中文语言")));
  });

  it("Firebase 与嵌套 Worker 的系统通知文案不能逃逸", () => {
    const repo = fixture();
    mkdirSync(join(repo, "apps/webb/public/push"), { recursive: true });
    mkdirSync(join(repo, "apps/webc/public/nested"), { recursive: true });
    writeFileSync(join(repo, "apps/webb/public/push/firebase-messaging-sw.js"), 'self.registration.showNotification("tenant_id console");\n');
    writeFileSync(join(repo, "apps/webc/public/nested/service-worker.js"), 'self.registration.showNotification("raw_status");\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("firebase-messaging-sw.js") && error.includes("英文")));
    assert.ok(errors.some((error) => error.includes("nested/service-worker.js") && error.includes("英文")));
  });

  it("自定义 Worker、递归脚本、离线 HTML 与任意 webmanifest 不能逃逸", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    mkdirSync(join(repo, "apps/webb/public"), { recursive: true });
    writeFileSync(mainPath, `${readFileSync(mainPath, "utf8")}\nnavigator.serviceWorker.register("./push-worker.js");\n`);
    writeFileSync(join(repo, "apps/webb/public/push-worker.js"), 'importScripts("./worker-copy.js");\n');
    writeFileSync(join(repo, "apps/webb/public/worker-copy.js"), 'self.registration.showNotification("tenant_id console");\n');
    writeFileSync(join(repo, "apps/webb/public/offline.html"), '<html lang="zh-CN"><body>raw_status console</body></html>\n');
    writeFileSync(join(repo, "apps/webb/public/site.webmanifest"), '{"name":"workspace_id console","lang":"en"}\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("worker-copy.js") && error.includes("英文")));
    assert.ok(errors.some((error) => error.includes("offline.html") && error.includes("英文")));
    assert.ok(errors.some((error) => error.includes("site.webmanifest") && error.includes("中文语言")));
  });

  it("计算属性注册与 importScripts 仍递归纳管任意 public Worker", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    mkdirSync(join(repo, "apps/webb/public"), { recursive: true });
    writeFileSync(mainPath, `${readFileSync(mainPath, "utf8")}
navigator["service" + "Worker"]["reg" + "ister"]("/hidden-" + "worker.js");
navigator.serviceWorker.register.call(navigator.serviceWorker, "/hidden-worker.js");
`);
    writeFileSync(join(repo, "apps/webb/public/hidden-worker.js"), [
      'self["import" + "Scripts"]("./un" + "scanned.js");',
      'self.importScripts.call(self, "./unscanned.js");',
    ].join("\n"));
    writeFileSync(join(repo, "apps/webb/public/unscanned.js"), 'self.registration.showNotification("tenant_id console");\n');
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("unscanned.js") && error.includes("英文")));
  });

  it("模块 Service Worker 的 import、export-from 与 importScripts 依赖全部递归纳管", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    mkdirSync(join(repo, "apps/webb/public/modules"), { recursive: true });
    writeFileSync(mainPath, readFileSync(mainPath, "utf8") + [
      "",
      'const nav = window["navigator"];',
      'const sw = nav["serviceWorker"];',
      "const registerWorker = sw.register.bind(sw);",
      'registerWorker("./module-worker.mjs", { type: "module" });',
    ].join("\n"));
    writeFileSync(join(repo, "apps/webb/public/module-worker.mjs"), [
      'import "./modules/imported.js";',
      'export { report } from "./modules/reexported.js";',
      'importScripts("./modules/classic.js");',
    ].join("\n"));
    writeFileSync(join(repo, "apps/webb/public/modules/imported.js"), 'self.registration.showNotification("tenant_id console");\n');
    writeFileSync(join(repo, "apps/webb/public/modules/reexported.js"), 'export const report = "ok"; self.registration.showNotification("raw_status");\n');
    writeFileSync(join(repo, "apps/webb/public/modules/classic.js"), 'self.registration.showNotification("workspace_id console");\n');
    const errors = verifyUiConsumerRepo(repo);
    for (const file of ["modules/imported.js", "modules/reexported.js", "modules/classic.js"]) {
      assert.ok(errors.some((error) => error.includes(file) && error.includes("英文")), "未递归纳管 " + file);
    }
  });

  it("已注册 Worker 的动态 import、外部与裸模块说明符全部关闭失败", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    mkdirSync(join(repo, "apps/webb/public"), { recursive: true });
    writeFileSync(mainPath, readFileSync(mainPath, "utf8") + '\nnavigator.serviceWorker.register("./module-worker.mjs", { type: "module" });\n');
    writeFileSync(join(repo, "apps/webb/public/module-worker.mjs"), [
      'import("./runtime-copy.js");',
      'import "https://cdn.example/remote-copy.js";',
      'export * from "worker-package";',
      "importScripts(workerPath);",
    ].join("\n"));
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("Worker 禁止动态 import")));
    assert.ok(errors.some((error) => error.includes("外部或裸模块说明符")));
    assert.ok(errors.some((error) => error.includes("importScripts 路径必须使用静态本地路径")));
  });

  it("注释、字符串与普通 Web Worker 不会被误判成 Service Worker 依赖图", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    mkdirSync(join(repo, "apps/webb/public"), { recursive: true });
    writeFileSync(mainPath, readFileSync(mainPath, "utf8") + [
      "",
      '// navigator.serviceWorker.register("./comment-worker.js");',
      'const example = \'navigator["serviceWorker"]["register"]("./string-worker.js")\';',
      'new Worker("./ordinary-worker.js");',
    ].join("\n"));
    writeFileSync(join(repo, "apps/webb/public/ordinary-worker.js"), 'self.registration.showNotification("tenant_id console");\n');
    assert.deepEqual(verifyUiConsumerRepo(repo), []);
  });

  it("动态 Worker 路径被阻断，不能把通知实现移出治理范围", () => {
    const repo = fixture();
    const mainPath = join(repo, "apps/webb/src/main.tsx");
    writeFileSync(mainPath, `${readFileSync(mainPath, "utf8")}\nconst workerPath = getPath(); navigator.serviceWorker.register(workerPath);\n`);
    assert.ok(verifyUiConsumerRepo(repo).some((error) => error.includes("Service Worker 注册路径必须使用静态本地路径")));
  });

  it("固定 AST 依赖，避免下游 TypeScript 漂移让门禁静默失效", () => {
    const repo = fixture();
    writeFileSync(join(repo, "package.json"), '{"devDependencies":{"typescript-governance":"^5.9.0"}}\n');
    assert.ok(verifyUiConsumerRepo(repo).some((error) => error.includes("必须精确依赖 typescript-governance")));
  });

  it("行业源码与 public 目录禁止用符号链接隐藏或逃逸治理扫描", () => {
    const repo = fixture();
    const outside = mkdtempSync(join(tmpdir(), "workloom-ui-outside-"));
    writeFileSync(join(outside, "Hidden.tsx"), "export const Hidden=()=> <div>tenant_id console</div>;\n");
    symlinkSync(outside, join(repo, "apps/web/src/extensions"));
    assert.throws(() => verifyUiConsumerRepo(repo), /UI 治理目录禁止符号链接/u);
  });
});
