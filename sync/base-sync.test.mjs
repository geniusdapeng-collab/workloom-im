import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { pullRequestPayload, resolveRemoteWritePolicy, syncBranchName, validateChildrenConfig } from "./base-sync.mjs";

const syncDir = dirname(fileURLToPath(import.meta.url));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function initRepo(path, files) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(path, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: path });
}

function spawnNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("base-sync 与版本化 UI 边界", () => {
  it("远程写入缺凭据、缺门禁成功证明或 SHA 不匹配时都强制 dry-run", () => {
    const base = { requestedDry: false, remoteWriteRequested: true, baseSha: "a".repeat(40), gateUrl: "https://github.com/example/base/actions/runs/123" };
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "", gateStatus: "success", gateSha: base.baseSha }).dryRun, true);
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "token", gateStatus: "failure", gateSha: base.baseSha }).dryRun, true);
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "token", gateStatus: "success", gateSha: "b".repeat(40) }).dryRun, true);
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "token", gateStatus: "success", gateSha: base.baseSha, gateUrl: "" }).dryRun, true);
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "token", gateStatus: "success", gateSha: base.baseSha, baseClean: false }).dryRun, true);
    assert.equal(resolveRemoteWritePolicy({ ...base, token: "token", gateStatus: "success", gateSha: base.baseSha }).dryRun, false);
  });

  it("升级 PR 固定以独立分支为 head、main 为评审目标并记录门禁与文件清单", () => {
    const baseSha = "a".repeat(40);
    const branch = syncBranchName(baseSha);
    const payload = pullRequestPayload({
      branch,
      baseSha,
      copied: ["packages/base/public.ts"],
      merged: ["packages/base/package.json"],
      skippedAppendOnly: [],
      gateUrl: "https://github.com/example/base/actions/runs/123",
      scopeVersion: 2,
      extraExclude: ["industry-only/**"],
    });
    assert.match(branch, /^chore\/workloom-base-/);
    assert.notEqual(branch, "main");
    assert.equal(payload.head, branch);
    assert.equal(payload.base, "main");
    assert.match(payload.body, new RegExp(baseSha));
    assert.match(payload.body, /ci-gate 已通过/);
    assert.match(payload.body, /第 2 版/);
    assert.match(payload.body, /industry-only/);
    assert.match(payload.body, /packages\/base\/public\.ts/);
  });

  it("拒绝重复子仓和可越界的 pathPrefix", () => {
    assert.throws(() => validateChildrenConfig([]), /不能为空/);
    assert.throws(() => validateChildrenConfig([{ repo: "owner/repo" }, { repo: "owner/repo" }]), /重复/);
    assert.throws(() => validateChildrenConfig([{ repo: "owner/repo", pathPrefix: "../outside" }]), /pathPrefix/);
    assert.equal(validateChildrenConfig([{ repo: "owner/repo", pathPrefix: "governance/" }])[0].repo, "owner/repo");
  });

  it("工作流只接受 main push 的成功门禁，adopt 先真实拉齐再只读复检", () => {
    const workflow = readFileSync(join(syncDir, "../.github/workflows/base-sync-push.yml"), "utf8");
    const adopt = readFileSync(join(syncDir, "adopt.sh"), "utf8");
    const heartbeat = readFileSync(join(syncDir, "heartbeat-template.yml"), "utf8");
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /workflow_run\.conclusion == 'success'/);
    assert.match(workflow, /workflow_run\.event == 'push'/);
    assert.match(workflow, /workflow_run\.head_sha/);
    assert.match(workflow, /workflow_dispatch[\s\S]*EXTRA_ARGS="--dry-run"/);
    assert.doesNotMatch(workflow, /main:main/);
    assert.doesNotMatch(heartbeat, /pull --repo .*--push/);
    const pullAt = adopt.indexOf("base-sync.mjs\" pull");
    const detectAt = adopt.indexOf("base-sync.mjs\" detect");
    assert.ok(pullAt >= 0 && detectAt > pullAt);
    assert.match(adopt, /pull --repo "\$WORKDIR" --base-dir "\$BASE_DIR" --no-commit/);
    assert.match(adopt, /detect --repo "\$WORKDIR" --base-dir "\$BASE_DIR" --dry-run/);
    assert.doesNotMatch(adopt, /lastSyncedBaseSha/);
  });

  it("不会把基座 workspace UI 依赖覆盖到行业仓稳定版本", () => {
    const fixture = mkdtempSync(join(tmpdir(), "workloom-base-sync-"));
    const base = join(fixture, "base");
    const child = join(fixture, "child");
    mkdirSync(join(base, "sync"), { recursive: true });
    mkdirSync(join(child, "apps/web"), { recursive: true });
    writeJson(join(base, "sync/base-scope.json"), {
      include: ["apps/web/package.json"],
      exclude: [],
      anchorMerge: {
        "apps/web/package.json": {
          strategy: "json-merge-keep-child-extra",
          mergeKeys: ["dependencies"],
          ignoreDependencyKeys: ["@workloom/ui"],
        },
      },
      appendOnlyDirs: [],
      pollutionGuard: { pathBlacklist: [], maxFilesPerSync: 10 },
    });
    writeJson(join(base, "apps/web/package.json"), {
      name: "base-web",
      dependencies: { "@workloom/ui": "workspace:*", react: "19.2.0" },
    });
    writeJson(join(child, "apps/web/package.json"), {
      name: "base-web",
      dependencies: { "@workloom/ui": "1.2.3", react: "19.2.0", "industry-only": "1.0.0" },
    });
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["add", "-A"], { cwd: base });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: base });
    const stdout = execFileSync(process.execPath, [
      join(syncDir, "base-sync.mjs"), "pull", "--repo", child, "--base-dir", base, "--dry-run", "--json",
    ], { encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.changed, 0);
  });

  it("新行业首次接入会真实复制基座文件后再记录 SHA，且可选择不自动提交", () => {
    const fixture = mkdtempSync(join(tmpdir(), "workloom-adopt-sync-"));
    const base = join(fixture, "base");
    const child = join(fixture, "child");
    mkdirSync(join(base, "sync"), { recursive: true });
    mkdirSync(child, { recursive: true });
    writeJson(join(base, "sync/base-scope.json"), {
      include: ["packages/base/**"], exclude: [], anchorMerge: {}, appendOnlyDirs: [],
      pollutionGuard: { pathBlacklist: [], maxFilesPerSync: 10 },
    });
    mkdirSync(join(base, "packages/base"), { recursive: true });
    writeFileSync(join(base, "packages/base/public-capability.txt"), "base-first\n", { flag: "w" });
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["add", "-A"], { cwd: base });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: base });
    const stdout = execFileSync(process.execPath, [
      join(syncDir, "base-sync.mjs"), "pull", "--repo", child, "--base-dir", base, "--no-commit", "--json",
    ], { encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.changed, 1);
    assert.equal(report.committed, false);
    assert.equal(readFileSync(join(child, "packages/base/public-capability.txt"), "utf8"), "base-first\n");
    const statePath = join(child, ".workloom-base-sync.json");
    const stateText = readFileSync(statePath, "utf8");
    const state = JSON.parse(stateText);
    assert.equal(state.lastSyncedBaseSha, report.baseSha);
    const detect = execFileSync(process.execPath, [
      join(syncDir, "base-sync.mjs"), "detect", "--repo", child, "--base-dir", base, "--json",
    ], { encoding: "utf8" });
    assert.equal(JSON.parse(detect).behind, false);
    assert.equal(readFileSync(statePath, "utf8"), stateText, "detect 必须保持状态账本只读");
  });

  it("门禁成功时只推升级分支并创建 PR，行业仓 main 保持不变", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "workloom-sync-pr-"));
    const base = join(fixture, "base");
    const childSource = join(fixture, "child-source");
    const remotes = join(fixture, "remotes");
    const bare = join(remotes, "owner", "child.git");
    mkdirSync(join(remotes, "owner"), { recursive: true });

    initRepo(childSource, { "packages/base/public-capability.txt": "industry-old\n" });
    execFileSync("git", ["clone", "-q", "--bare", childSource, bare]);

    mkdirSync(join(base, "sync"), { recursive: true });
    writeJson(join(base, "sync/base-scope.json"), {
      include: ["packages/base/**"], exclude: [], anchorMerge: {}, appendOnlyDirs: [],
      pollutionGuard: { pathBlacklist: [], maxFilesPerSync: 10 },
    });
    writeJson(join(base, "sync/child-repos.json"), {
      children: [{ repo: "owner/child", pathPrefix: "", extraExclude: [] }],
    });
    mkdirSync(join(base, "packages/base"), { recursive: true });
    writeFileSync(join(base, "packages/base/public-capability.txt"), "base-new\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    execFileSync("git", ["add", "-A"], { cwd: base });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: base });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim();
    const expectedBranch = syncBranchName(baseSha);

    const noCredential = await spawnNode([
      join(syncDir, "base-sync.mjs"), "push", "--base", base,
      "--base-url", `file://${remotes}`, "--json",
    ], {
      env: {
        ...process.env,
        SYNC_TOKEN: "",
        GH_TOKEN: "",
        BASE_SYNC_GATE_STATUS: "success",
        BASE_SYNC_GATE_SHA: baseSha,
        BASE_SYNC_GATE_URL: "https://github.com/example/base/actions/runs/123",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(noCredential.code, 0, noCredential.stderr);
    const noCredentialReport = JSON.parse(noCredential.stdout);
    assert.equal(noCredentialReport.dryRun, true);
    assert.match(noCredentialReport.dryRunReason, /未提供同步凭据/);
    assert.equal(noCredentialReport.results[0].status, "planned");
    assert.throws(() => execFileSync("git", ["--git-dir", bare, "show-ref", "--verify", `refs/heads/${expectedBranch}`], { stdio: "ignore" }));

    const requests = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ html_url: "https://github.com/owner/child/pull/1" }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      const execution = await spawnNode([
        join(syncDir, "base-sync.mjs"), "push", "--base", base,
        "--base-url", `file://${remotes}`, "--json",
      ], {
        env: {
          ...process.env,
          SYNC_TOKEN: "test-token",
          BASE_SYNC_GATE_STATUS: "success",
          BASE_SYNC_GATE_SHA: baseSha,
          BASE_SYNC_GATE_URL: "https://github.com/example/base/actions/runs/123",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(execution.code, 0, execution.stderr);
      const report = JSON.parse(execution.stdout);
      assert.equal(report.dryRun, false);
      assert.equal(report.results[0].status, "pr-opened");
      const branch = report.results[0].branch;
      assert.equal(execFileSync("git", ["--git-dir", bare, "show", "main:packages/base/public-capability.txt"], { encoding: "utf8" }), "industry-old\n");
      assert.equal(execFileSync("git", ["--git-dir", bare, "show", `${branch}:packages/base/public-capability.txt`], { encoding: "utf8" }), "base-new\n");
      const state = JSON.parse(execFileSync("git", ["--git-dir", bare, "show", `${branch}:.workloom-base-sync.json`], { encoding: "utf8" }));
      assert.equal(state.lastSyncedBaseSha, baseSha);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url, "/repos/owner/child/pulls");
      assert.equal(requests[0].body.head, branch);
      assert.equal(requests[0].body.base, "main");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
