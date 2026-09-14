import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  anchorNeedsSync,
  extractManagedSection,
  gitAuthEnv,
  mergeKeepChildExtra,
  mergeManagedSection,
  redact,
  registryCapabilityReadiness,
  repoUrl,
} from "./base-sync.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "base-sync.mjs");
const ADOPT = join(HERE, "adopt.sh");
const REAL_BASE = resolve(HERE, "..");
const SCANNER = join(REAL_BASE, "scripts/secret-scan.mjs");
const NODE = process.execPath;
const BEGIN = "<!-- WORKLOOM-CONTEXT:BEGIN -->";
const END = "<!-- WORKLOOM-CONTEXT:END -->";
const MANAGED = { beginMarker: BEGIN, endMarker: END };

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.invalid");
}

function commitAll(path, message) {
  git(path, "add", "--all");
  git(path, "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-sync-test-"));
  const base = join(root, "base");
  const child = join(root, "tiger");
  initRepo(base);
  write(join(base, "AGENTS.md"), `# Base only\n\n${BEGIN}\nshared-v2\n${END}\n\nbase-tail\n`);
  write(join(base, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v2\n");
  write(join(base, "AGENTS.repo.md"), "# workloom-im only\n\nbase-specific commands\n");
  write(join(base, ".github/workflows/base-sync-push.yml"), "name: parent-base-sync-push\n");
  write(join(base, "sync/heartbeat-template.yml"), "name: base-sync-heartbeat\n");
  copyFileSync(ENGINE, join(base, "sync/base-sync.mjs"));
  copyFileSync(ADOPT, join(base, "sync/adopt.sh"));
  mkdirSync(join(base, "scripts"), { recursive: true });
  copyFileSync(SCANNER, join(base, "scripts/secret-scan.mjs"));
  write(join(base, "shared/core.txt"), "core-v2\n");
  write(join(base, "sync/base-scope.json"), JSON.stringify({
    version: 3,
    requiredRootAssets: {
      files: ["WORKLOOM_PRODUCT_CONTEXT.md"],
      copiedFiles: {
        ".github/workflows/base-sync-heartbeat.yml": { source: "sync/heartbeat-template.yml" },
      },
      managedSections: { "AGENTS.md": MANAGED },
    },
    preCommitSecretScanner: "scripts/secret-scan.mjs",
    adoptMigrations: {
      "AGENTS.repo.md": {
        strategy: "replace-if-identical-to-base",
        scaffold: "# 本仓专属开发规则\n\n> 请结合本仓实际内容填写。\n",
      },
      ".github/workflows/base-sync-push.yml": {
        strategy: "remove-if-identical-to-base",
      },
    },
    include: ["shared/**"],
    exclude: [],
    anchorMerge: {},
    appendOnlyDirs: [],
    pollutionGuard: { pathBlacklist: [], maxFilesPerSync: 20 },
  }, null, 2));
  const baseSha = commitAll(base, "base");

  initRepo(child);
  mkdirSync(join(child, "governance"), { recursive: true });
  write(join(child, "AGENTS.md"), `# Tiger own rules\n\n${BEGIN}\nshared-v1\n${END}\n\nKEEP-TIGER\n`);
  write(join(child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v1\n");
  write(join(child, "governance/shared/core.txt"), "core-v1\n");
  write(join(child, "governance/.workloom-base-sync.json"), JSON.stringify({
    baseRepo: "example/base",
    lastSyncedBaseSha: baseSha,
  }, null, 2));
  write(join(child, "notes.txt"), "clean\n");
  commitAll(child, "child");
  return { root, base, child, baseSha };
}

function cli(args, cwd, env = process.env) {
  return spawnSync(NODE, [ENGINE, ...args], { cwd, encoding: "utf8", env });
}

function tempEntries(prefix) {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
}

function readScope(base) {
  return JSON.parse(readFileSync(join(base, "sync/base-scope.json"), "utf8"));
}

function writeScope(base, scope) {
  write(join(base, "sync/base-scope.json"), JSON.stringify(scope, null, 2) + "\n");
}

test("AGENTS 只替换唯一受控区块并保留子仓内容", () => {
  const base = `base-prefix\n${BEGIN}\nnew\n${END}\nbase-tail\n`;
  const child = `child-prefix\n${BEGIN}\nold\n${END}\nchild-tail\n`;
  const merged = mergeManagedSection(base, child, MANAGED);
  assert.equal(merged, `child-prefix\n${BEGIN}\nnew\n${END}\nchild-tail\n`);
  assert.equal(extractManagedSection(merged, MANAGED), `${BEGIN}\nnew\n${END}`);
  assert.throws(() => mergeManagedSection(base, `${BEGIN}\nbroken`, MANAGED), /必须且只能各出现一次/);
});

test("未知且无标记的子仓 AGENTS 原文保留并追加受控区块", () => {
  const base = `${BEGIN}\nrequired\n${END}\n`;
  assert.equal(mergeManagedSection(base, "child-only\n", MANAGED), `child-only\n\n${BEGIN}\nrequired\n${END}\n`);
});

test("已知 legacy AGENTS 精确命中 SHA-256 才整文件迁移；一字节变化则保留追加", () => {
  const base = `base-only\n${BEGIN}\nrequired\n${END}\nbase-tail\n`;
  const legacy = "legacy WorkLoom IM generic guide\n";
  const config = {
    ...MANAGED,
    missingFilePrefix: "# WorkLoom 仓库开发指引",
    missingFileSuffix: "## 本仓专属规则\n\nsee AGENTS.repo.md",
    replaceWholeFileSha256: [createHash("sha256").update(legacy).digest("hex")],
  };
  const replaced = mergeManagedSection(base, legacy, config);
  assert.doesNotMatch(replaced, /legacy WorkLoom IM|base-only|base-tail/);
  assert.match(replaced, /^# WorkLoom 仓库开发指引/);
  assert.match(replaced, /see AGENTS\.repo\.md/);

  const oneByteDifferent = `${legacy}x`;
  const preserved = mergeManagedSection(base, oneByteDifferent, config);
  assert.match(preserved, /legacy WorkLoom IM generic guide\nx/);
  assert.match(preserved, /WORKLOOM-CONTEXT:BEGIN/);
});

test("pull report 暴露 legacy 精确替换与未知无 marker 人工迁移标志", () => {
  const known = fixture();
  const unknown = fixture();
  try {
    const legacy = "legacy generic agent guide\n";
    const knownScope = readScope(known.base);
    knownScope.requiredRootAssets.managedSections["AGENTS.md"].replaceWholeFileSha256 = [
      createHash("sha256").update(legacy).digest("hex"),
    ];
    writeScope(known.base, knownScope);
    commitAll(known.base, "allow legacy fingerprint");
    write(join(known.child, "AGENTS.md"), legacy);
    commitAll(known.child, "legacy agents");
    const knownPull = cli([
      "pull", "--repo", "governance", "--base-dir", known.base,
      "--required-only", "--no-commit", "--json",
    ], known.child);
    assert.equal(knownPull.status, 0, knownPull.stderr || knownPull.stdout);
    const knownReport = JSON.parse(knownPull.stdout);
    assert.equal(knownReport.legacyAgentsReplaced, true);
    assert.equal(knownReport.manualMigrationRequired, false);
    assert.doesNotMatch(readFileSync(join(known.child, "AGENTS.md"), "utf8"), /legacy generic/);

    write(join(unknown.child, "AGENTS.md"), "child-specific guide\n");
    commitAll(unknown.child, "custom agents without markers");
    const unknownPull = cli([
      "pull", "--repo", "governance", "--base-dir", unknown.base,
      "--required-only", "--no-commit", "--json",
    ], unknown.child);
    assert.equal(unknownPull.status, 0, unknownPull.stderr || unknownPull.stdout);
    const unknownReport = JSON.parse(unknownPull.stdout);
    assert.equal(unknownReport.legacyAgentsReplaced, false);
    assert.equal(unknownReport.manualMigrationRequired, true);
    assert.match(unknownReport.warnings.join("\n"), /fingerprint 未知/);
    assert.match(readFileSync(join(unknown.child, "AGENTS.md"), "utf8"), /child-specific guide/);
  } finally {
    rmSync(known.root, { recursive: true, force: true });
    rmSync(unknown.root, { recursive: true, force: true });
  }
});

test("完全缺失的 AGENTS 使用通用根级 scaffold，不带基座专属尾部", () => {
  const base = `# Base only\n${BEGIN}\nrequired\n${END}\nbase-only-tail\n`;
  const config = {
    ...MANAGED,
    missingFilePrefix: "# WorkLoom 仓库开发指引\n\nshared intro",
    missingFileSuffix: "## 本仓专属规则\n\nwrite local rules here",
  };
  const merged = mergeManagedSection(base, "", config);
  assert.equal(merged, `# WorkLoom 仓库开发指引\n\nshared intro\n\n${BEGIN}\nrequired\n${END}\n\n## 本仓专属规则\n\nwrite local rules here\n`);
  assert.doesNotMatch(merged, /Base only|base-only-tail/);
});

test("认证不进入 URL，错误输出会脱敏", () => {
  const credentialSample = ["ghp", "A".repeat(36)].join("_");
  const url = repoUrl("https://github.com/", "owner/repo");
  assert.equal(url, "https://github.com/owner/repo.git");
  assert.ok(!url.includes(credentialSample));
  const env = gitAuthEnv(credentialSample);
  assert.ok(Object.values(env).some((value) => String(value).startsWith("AUTHORIZATION: basic ")));
  const unsafeUrl = ["https://user:", credentialSample, "@example.test"].join("");
  assert.ok(!redact(`failed ${credentialSample} ${unsafeUrl}`, credentialSample).includes(credentialSample));
  const embeddedCredential = ["https://user:", "plain-secret", "@github.com"].join("");
  assert.throws(() => repoUrl(embeddedCredential, "owner/repo"), /\[REDACTED\]@github\.com/);
});

test("@workloom/ui 由稳定制品升级维护，锚点合并保留子仓精确版本", () => {
  const basePackage = {
    dependencies: { "@workloom/ui": "workspace:*", react: "19.2.0" },
  };
  const childPackage = {
    dependencies: { "@workloom/ui": "1.2.3", react: "19.2.0", "industry-only": "1.0.0" },
  };
  const merged = mergeKeepChildExtra(basePackage, childPackage, ["dependencies"], ["@workloom/ui"]);
  assert.equal(merged.dependencies["@workloom/ui"], "1.2.3");
  assert.equal(merged.dependencies["industry-only"], "1.0.0");
  assert.equal(anchorNeedsSync(basePackage, childPackage, ["dependencies"], ["@workloom/ui"]), false);
  assert.equal(anchorNeedsSync(
    basePackage,
    { dependencies: { ...childPackage.dependencies, react: "18.0.0" } },
    ["dependencies"],
    ["@workloom/ui"],
  ), true);
});

test("缺少 B 端移动客户端时只报告第一阶段迁移，绝不伪装三端合规", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-registry-readiness-"));
  try {
    const capability = {
      package: "@workloom/ui",
      distribution: "stable-registry-upgrade-pr",
      consumerGate: "scripts/verify-ui-consumer.mjs",
      consumers: ["apps/web", "apps/webb", "apps/webc"],
    };
    for (const client of ["apps/web", "apps/webc"]) {
      write(join(root, client, "package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "1.2.3" } }));
    }
    const [missing] = registryCapabilityReadiness(root, { registryCapabilities: [capability] });
    assert.deepEqual(missing.missingConsumers, ["apps/webb"]);
    assert.equal(missing.phase, "phase-1-client-structure-required");
    assert.equal(missing.compliance, "unverified");

    write(join(root, "apps/webb/package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "1.2.3" } }));
    const [complete] = registryCapabilityReadiness(root, { registryCapabilities: [capability] });
    assert.deepEqual(complete.missingConsumers, []);
    assert.equal(complete.phase, "consumer-gate-required");
    assert.equal(complete.compliance, "unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v4 scope 明确保护桌面产品身份，不整文件同步 electron-builder.yml", () => {
  const scope = JSON.parse(readFileSync(join(REAL_BASE, "sync/base-scope.json"), "utf8"));
  assert.equal(scope.version, 4);
  assert.ok(scope.protectedChildAssets.files.includes("electron-builder.yml"));
  assert.ok(scope.protectedChildAssets.files.includes("product.manifest.json"));
  assert.ok(scope.exclude.includes("electron-builder.yml"));
  assert.ok(!scope.include.includes("electron-builder.yml"));
  assert.ok(scope.include.includes("packages/industry-contract/**"));
  assert.ok(scope.exclude.includes("apps/server/src/industry/**"));
  assert.ok(scope.exclude.includes("apps/server/src/service/adapters/**"));
  assert.equal(scope.registryCapabilities[0].distribution, "stable-registry-upgrade-pr");
});

test("相同 base SHA 仍逐项验真；Tiger required assets 写根目录且 state 同提交迁移", () => {
  const fx = fixture();
  try {
    const detect = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(detect.status, 2, detect.stderr || detect.stdout);
    const report = JSON.parse(detect.stdout);
    assert.equal(report.localSha, fx.baseSha);
    assert.equal(report.contentDrift, true);
    assert.equal(report.stateDrift, true);
    assert.deepEqual(report.files.sort(), ["shared/core.txt", "root:AGENTS.md#managed-section", "root:WORKLOOM_PRODUCT_CONTEXT.md", "root:.github/workflows/base-sync-heartbeat.yml", "root:.workloom-base-sync.json"].sort());

    const pull = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    const agents = readFileSync(join(fx.child, "AGENTS.md"), "utf8");
    assert.match(agents, /# Tiger own rules/);
    assert.match(agents, /shared-v2/);
    assert.match(agents, /KEEP-TIGER/);
    assert.doesNotMatch(agents, /Base only|base-tail/);
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), "core-v2\n");
    const state = JSON.parse(readFileSync(join(fx.child, ".workloom-base-sync.json"), "utf8"));
    assert.equal(state.lastSyncedBaseSha, fx.baseSha);
    assert.equal(state.lastRequiredAssetsBaseSha, fx.baseSha);
    assert.equal(Object.keys(state.requiredRootAssetsSha256).length, 3);
    assert.equal(state.pathPrefix, "governance");
    const committed = git(fx.child, "show", "--pretty=format:", "--name-status", "HEAD");
    assert.match(committed, /\.workloom-base-sync\.json/);
    assert.match(committed, /WORKLOOM_PRODUCT_CONTEXT\.md/);
    assert.match(committed, /AGENTS\.md/);
    assert.match(committed, /\.github\/workflows\/base-sync-heartbeat\.yml/);
    assert.match(committed, /governance\/shared\/core\.txt/);
    assert.match(committed, /governance\/\.workloom-base-sync\.json/);
    assert.equal(git(fx.child, "status", "--porcelain"), "");

    const after = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(JSON.parse(after.stdout).behind, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("内容一致但 state 缺失时 detect 退出 2，pull 创建 state-only 提交", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "AGENTS.md"), `# Tiger own rules\n\n${BEGIN}\nshared-v2\n${END}\n\nKEEP-TIGER\n`);
    write(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v2\n");
    write(join(fx.child, ".github/workflows/base-sync-heartbeat.yml"), "name: base-sync-heartbeat\n");
    rmSync(join(fx.child, "governance/.workloom-base-sync.json"));
    commitAll(fx.child, "content aligned without state");

    const detect = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--json"], fx.child);
    assert.equal(detect.status, 2, detect.stderr || detect.stdout);
    const report = JSON.parse(detect.stdout);
    assert.equal(report.contentDrift, false);
    assert.equal(report.stateDrift, true);
    assert.deepEqual(report.files, ["root:.workloom-base-sync.json"]);

    const before = git(fx.child, "rev-parse", "HEAD");
    const pull = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--json"], fx.child);
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    assert.notEqual(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD"), ".workloom-base-sync.json");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--required-only --no-commit 允许脏树但只写根资产/state且不暂存", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "notes.txt"), "user-change\n");
    const beforeHead = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--no-commit", "--json"], fx.child);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    assert.equal(readFileSync(join(fx.child, ".github/workflows/base-sync-heartbeat.yml"), "utf8"), "name: base-sync-heartbeat\n");
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), "core-v1\n");
    assert.equal(JSON.parse(readFileSync(join(fx.child, ".workloom-base-sync.json"), "utf8")).lastSyncMode, "required-only");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("默认自动提交拒绝既有脏工作树", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "notes.txt"), "user-change\n");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /拒绝自动提交.*未提交改动/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("本地 --base-dir 只允许受控来源与 HEAD 一致，无关脏文件不阻塞", () => {
  const fx = fixture();
  try {
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), "uncommitted-context\n");
    const blocked = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /基座受控源文件与 HEAD 不一致/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");

    git(fx.base, "restore", "--", "WORKLOOM_PRODUCT_CONTEXT.md");
    write(join(fx.base, "unrelated-local-note.txt"), "not read by sync\n");
    const allowed = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(allowed.status, 2, allowed.stderr || allowed.stdout);
    assert.doesNotMatch(allowed.stderr, /受控源文件与 HEAD 不一致/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("源 required asset 为 dangling symlink 时 fail closed", () => {
  const fx = fixture();
  try {
    rmSync(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"));
    symlinkSync(join(fx.root, "never-created-source"), join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"));
    commitAll(fx.base, "malicious source symlink");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不允许 symlink/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("目标 dangling symlink 与 pathPrefix symlink escape 均被拒绝", () => {
  const fx = fixture();
  try {
    const outsideTarget = join(fx.root, "never-created-target");
    rmSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"));
    symlinkSync(outsideTarget, join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"));
    commitAll(fx.child, "malicious target symlink");
    const targetResult = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(targetResult.status, 1);
    assert.match(targetResult.stderr, /不允许 symlink/);
    assert.equal(existsSync(outsideTarget), false);

    git(fx.child, "rm", "WORKLOOM_PRODUCT_CONTEXT.md");
    write(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v1\n");
    rmSync(join(fx.child, "governance"), { recursive: true, force: true });
    const outsideRepo = join(fx.root, "outside-repo");
    initRepo(outsideRepo);
    write(join(outsideRepo, "outside.txt"), "untouched\n");
    commitAll(outsideRepo, "outside");
    symlinkSync(outsideRepo, join(fx.child, "governance"));
    commitAll(fx.child, "path prefix symlink escape");
    const outsideHead = git(outsideRepo, "rev-parse", "HEAD");
    const prefixResult = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(prefixResult.status, 1);
    assert.match(prefixResult.stderr, /--repo 目标路径\s*不允许 symlink/);
    assert.equal(git(outsideRepo, "rev-parse", "HEAD"), outsideHead);
    assert.equal(git(outsideRepo, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("lockfile 刷新故障 fail closed：显式 ignore-scripts，且不写 state/不提交", () => {
  const fx = fixture();
  try {
    const scope = readScope(fx.base);
    scope.include.push("package.json");
    scope.anchorMerge["package.json"] = { strategy: "json-merge-keep-child-extra", mergeKeys: ["dependencies"] };
    writeScope(fx.base, scope);
    write(join(fx.base, "package.json"), JSON.stringify({ name: "base", dependencies: { base: "1.0.0" } }, null, 2) + "\n");
    commitAll(fx.base, "add anchor package");
    write(join(fx.child, "governance/package.json"), JSON.stringify({ name: "child", dependencies: { child: "1.0.0" } }, null, 2) + "\n");
    commitAll(fx.child, "add child package");
    const before = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base], fx.child, { ...process.env, PATH: "/usr/bin:/bin" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lockfile 刷新失败.*未写 state、未提交/);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, "governance/.workloom-base-sync.json")), true);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("pre-commit staged secret scan 失败时不写假 state、不提交且不留 staged", () => {
  const fx = fixture();
  try {
    const secretLike = ["ghp", "Z".repeat(36)].join("_");
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), `credential sample: ${secretLike}\n`);
    commitAll(fx.base, "inject scanner fixture");
    const before = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /提交前密钥扫描失败.*未写 state、未提交/);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, "governance/.workloom-base-sync.json")), true);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--no-commit 密钥扫描失败时回滚本次 required assets，保留同步前工作树", () => {
  const fx = fixture();
  try {
    const secretLike = ["ghp", "Y".repeat(36)].join("_");
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), `credential sample: ${secretLike}\n`);
    commitAll(fx.base, "inject no-commit scanner fixture");
    const beforeStatus = git(fx.child, "status", "--porcelain");
    const result = cli([
      "pull", "--repo", "governance", "--base-dir", fx.base,
      "--required-only", "--no-commit",
    ], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-commit 写入后密钥扫描失败.*未写 state、未提交/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".github/workflows/base-sync-heartbeat.yml")), false);
    assert.equal(git(fx.child, "status", "--porcelain"), beforeStatus);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("临时 base/child clone 在失败与 dry-run 路径都清理", () => {
  const fx = fixture();
  try {
    const basesBefore = tempEntries("workloom-base-");
    const failed = cli(["detect", "--repo", "governance", "--base-url", `file://${join(fx.root, "missing-remotes")}`], fx.child);
    assert.equal(failed.status, 1);
    assert.deepEqual(tempEntries("workloom-base-"), basesBefore);

    const remotes = join(fx.root, "remotes");
    mkdirSync(join(remotes, "owner"), { recursive: true });
    run("git", ["clone", "--bare", fx.child, join(remotes, "owner/child.git")], fx.root);
    write(join(fx.base, "sync/child-repos.json"), JSON.stringify({
      children: [{ repo: "owner/child", pathPrefix: "governance/", extraExclude: [] }],
    }, null, 2));
    commitAll(fx.base, "add child list");
    const childrenBefore = tempEntries("workloom-child-");
    const dry = cli(["push", "--base", fx.base, "--base-url", `file://${remotes}`, "--dry-run", "--required-only", "--json"], fx.base);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    const pushReport = JSON.parse(dry.stdout);
    assert.equal(pushReport.results[0].pathPrefix, "governance");
    assert.equal(pushReport.results[0].stateUpdated, true);
    assert.deepEqual(pushReport.results[0].copied.sort(), [
      "root:.github/workflows/base-sync-heartbeat.yml",
      "root:WORKLOOM_PRODUCT_CONTEXT.md",
    ].sort());
    assert.deepEqual(pushReport.results[0].managed, ["root:AGENTS.md#managed-section"]);
    assert.doesNotMatch(JSON.stringify(pushReport.results[0]), /shared\/core\.txt/);
    assert.deepEqual(tempEntries("workloom-child-"), childrenBefore);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("push 对 manifest pathPrefix symlink（含 dangling）fail closed", () => {
  const fx = fixture();
  try {
    const remotes = join(fx.root, "remotes");
    const malicious = join(fx.root, "malicious-child");
    mkdirSync(join(remotes, "owner"), { recursive: true });
    initRepo(malicious);
    symlinkSync("never-created", join(malicious, "governance"));
    write(join(malicious, "safe.txt"), "safe\n");
    commitAll(malicious, "dangling path prefix");
    run("git", ["clone", "--bare", malicious, join(remotes, "owner/malicious.git")], fx.root);
    write(join(fx.base, "sync/child-repos.json"), JSON.stringify({
      children: [{ repo: "owner/malicious", pathPrefix: "governance/", extraExclude: [] }],
    }, null, 2));
    commitAll(fx.base, "add malicious child list");
    const before = tempEntries("workloom-child-");
    const result = cli([
      "push", "--base", fx.base, "--base-url", `file://${remotes}`,
      "--dry-run", "--required-only", "--json",
    ], fx.base);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].ok, false);
    assert.match(report.results[0].error, /pathPrefix 不允许 symlink/);
    assert.deepEqual(tempEntries("workloom-child-"), before);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("adopt 支持 .git 为文件的 linked worktree，并且不提交", () => {
  const fx = fixture();
  const source = join(fx.root, "source");
  const child = join(fx.root, "linked-child");
  const fixtureAdopt = join(fx.base, "sync/adopt.sh");
  try {
    initRepo(source);
    write(join(source, "seed.txt"), "seed\n");
    commitAll(source, "seed");
    git(source, "worktree", "add", "-b", "linked-child", child);
    write(join(child, "governance/child.txt"), "industry\n");
    write(join(child, "AGENTS.repo.md"), readFileSync(join(fx.base, "AGENTS.repo.md"), "utf8"));
    write(join(child, ".github/workflows/base-sync-push.yml"), readFileSync(join(fx.base, ".github/workflows/base-sync-push.yml"), "utf8"));
    write(join(child, ".github/workflows/industry.yml"), "name: industry-owned\n");
    commitAll(child, "template-derived child");
    const beforeHead = git(child, "rev-parse", "HEAD");
    const pathDir = dirname(NODE);
    const rejected = spawnSync("bash", [fixtureAdopt, child, "--path-prefix", "../"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
    });
    assert.equal(rejected.status, 64);
    assert.match(rejected.stdout, /安全相对目录/);
    const result = spawnSync("bash", [fixtureAdopt, child, "--path-prefix", "governance/"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(child, "rev-parse", "HEAD"), beforeHead);
    assert.match(readFileSync(join(child, "AGENTS.md"), "utf8"), /WORKLOOM-CONTEXT:BEGIN/);
    assert.equal(readFileSync(join(child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    const state = JSON.parse(readFileSync(join(child, ".workloom-base-sync.json"), "utf8"));
    assert.equal(state.lastSyncMode, "required-only");
    assert.equal(state.pathPrefix, "governance");
    assert.ok(readFileSync(join(child, ".github/workflows/base-sync-heartbeat.yml"), "utf8").includes("base-sync-heartbeat"));
    assert.equal(readFileSync(join(child, "AGENTS.repo.md"), "utf8"), "# 本仓专属开发规则\n\n> 请结合本仓实际内容填写。\n");
    assert.equal(existsSync(join(child, ".github/workflows/base-sync-push.yml")), false);
    assert.equal(readFileSync(join(child, ".github/workflows/industry.yml"), "utf8"), "name: industry-owned\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("adopt 对已定制的 AGENTS.repo 与同名 workflow 均保留不覆盖", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "AGENTS.repo.md"), "# child-custom\n");
    write(join(fx.child, ".github/workflows/base-sync-push.yml"), "name: child-custom-workflow\n");
    commitAll(fx.child, "customized inherited files");
    const result = cli([
      "pull", "--repo", join(fx.child, "governance"), "--base-dir", fx.base,
      "--required-only", "--no-commit", "--adopt", "--json",
    ], fx.base);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.pathPrefix, "governance");
    assert.deepEqual(report.adopted, []);
    assert.equal(report.warnings.filter((line) => /fingerprint 不同/.test(line)).length, 2);
    assert.equal(readFileSync(join(fx.child, "AGENTS.repo.md"), "utf8"), "# child-custom\n");
    assert.equal(readFileSync(join(fx.child, ".github/workflows/base-sync-push.yml"), "utf8"), "name: child-custom-workflow\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
