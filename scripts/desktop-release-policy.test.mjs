import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

const workflowUrl = new URL("../.github/workflows/desktop-production-release.yml", import.meta.url);
const source = readFileSync(workflowUrl, "utf8");
const statePolicy = readFileSync(new URL("./desktop-release-state.mjs", import.meta.url), "utf8");
const workflow = YAML.parse(source);

function job(name) {
  const value = workflow.jobs?.[name];
  assert.ok(value, `missing job ${name}`);
  return value;
}

function stepByName(jobName, name) {
  const step = job(jobName).steps?.find((entry) => entry.name === name);
  assert.ok(step, `${jobName}: missing step ${name}`);
  return step;
}

function secretReferences(value) {
  return [...JSON.stringify(value ?? null).matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);
}

function inlineNodeContaining(run, marker) {
  const matches = [...String(run).matchAll(/node -e '([^']+)'/gu)].map((match) => match[1]);
  const code = matches.find((candidate) => candidate.includes(marker));
  assert.ok(code, `missing inline Node policy containing ${marker}`);
  return code;
}

function executeInline(code, args) {
  return spawnSync(process.execPath, ["-e", code, ...args], { encoding: "utf8" });
}

function inlineStdinNodeContaining(run, marker) {
  const matches = [...String(run).matchAll(/node\s+-[^\n]*<<'NODE'[^\n]*\n([\s\S]*?)\nNODE/gu)].map((match) => match[1]);
  const code = matches.find((candidate) => candidate.includes(marker));
  assert.ok(code, `missing inline stdin Node policy containing ${marker}`);
  return code;
}

function executeStdinNode(code, args) {
  return spawnSync(process.execPath, ["-", ...args], { input: code, encoding: "utf8" });
}

test("desktop release has one serialized writer and read-only platform builders", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(existsSync(new URL("../.github/workflows/build-desktop.yml", import.meta.url)), false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "desktop-production-release",
    "cancel-in-progress": false,
  });
  for (const name of ["preflight", "macos", "windows"]) {
    assert.deepEqual(job(name).permissions, { contents: "read" });
  }
  for (const name of ["macos", "windows", "publish-desktop-release"]) {
    assert.equal(job(name).environment, "desktop-production");
  }
  assert.deepEqual(job("publish-desktop-release").permissions, { actions: "read", contents: "write" });
  assert.deepEqual(job("publish-desktop-release").needs, ["preflight", "macos", "windows"]);
  const publisherSteps = job("publish-desktop-release").steps;
  assert.equal(publisherSteps.some((step) => String(step.uses ?? "").startsWith("actions/checkout@")), false);
  assert.equal(publisherSteps.some((step) => /\b(?:npm|pnpm|yarn)\s+(?:install|exec)\b/u.test(String(step.run ?? ""))), false);
  assert.doesNotMatch(publisherSteps.map((step) => String(step.run ?? "")).join("\n"), /node\s+scripts\//u);
  assert.doesNotMatch(source, /softprops\/action-gh-release|gh\s+issue\s+create/u);

  const writers = Object.entries(workflow.jobs).filter(([, value]) =>
    (value.steps ?? []).some((step) => /\bgh\s+release\s+(?:create|upload|edit|delete)\b/u.test(String(step.run ?? ""))),
  );
  assert.deepEqual(writers.map(([name]) => name), ["publish-desktop-release"]);
});

test("preflight binds an exact stable tag to the current reviewed main HEAD", () => {
  const preflight = job("preflight");
  const checkout = preflight.steps[0];
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["fetch-tags"], true);
  const run = stepByName("preflight", "固定稳定标签、提交与当前 main HEAD").run;
  assert.match(run, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.match(run, /TARGET_SHA" = "\$GITHUB_SHA/u);
  assert.match(run, /TARGET_SHA" = "\$MAIN_SHA/u);
  assert.doesNotMatch(run, /git merge-base --is-ancestor/u);
  assert.match(run, /git ls-remote origin/u);
  assert.match(run, /REMOTE_SHA/u);
  assert.match(run, /TARGET_SHA/u);

  for (const name of ["macos", "windows"]) {
    const platformCheckout = job(name).steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    assert.ok(platformCheckout);
    assert.equal(platformCheckout.with.ref, "${{ needs.preflight.outputs.release-sha }}");
    assert.equal(platformCheckout.with["persist-credentials"], false);
  }
});

test("unsigned platform builds require an explicit reviewed input and disclose their trust level", () => {
  const input = workflow.on.workflow_dispatch.inputs.platform_signing;
  assert.equal(input.required, true);
  assert.equal(input.type, "choice");
  assert.deepEqual(input.options, ["signed", "unsigned"]);
  assert.equal(input.default, "signed");
  assert.equal(job("preflight").outputs["platform-signing"], "${{ steps.target.outputs.platform-signing }}");

  const preflight = stepByName("preflight", "固定稳定标签、提交与当前 main HEAD");
  assert.equal(preflight.env.REQUESTED_PLATFORM_SIGNING, "${{ inputs.platform_signing }}");
  assert.match(preflight.run, /\^\(signed\|unsigned\)\$/u);
  assert.match(preflight.run, /platform-signing=\$PLATFORM_SIGNING/u);

  for (const [jobName, stepName] of [
    ["macos", "打包未签名 DMG（arm64）"],
    ["macos", "打包未签名 DMG（x64）"],
    ["windows", "打包未签名 NSIS 安装包"],
  ]) {
    const step = stepByName(jobName, stepName);
    assert.equal(step.if, "needs.preflight.outputs.platform-signing == 'unsigned'");
    assert.deepEqual(secretReferences(step), []);
    assert.equal(step.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  }

  assert.match(stepByName("macos", "打包未签名 DMG（arm64）").run, /mac\.notarize=false/u);
  const publish = stepByName("publish-desktop-release", "原子组装、发布并回读核验桌面端 Release");
  assert.equal(publish.env.PLATFORM_SIGNING, "${{ needs.preflight.outputs.platform-signing }}");
  assert.match(publish.run, /platformSigning/u);
  assert.match(publish.run, /未签名、未 Apple 公证安装包/u);
  assert.match(publish.run, /SmartScreen/u);
});

test("Windows package smoke is isolated from the build toolchain and retains all failure evidence", () => {
  const smoke = stepByName("windows", "拆包验收 + 冒烟（对 win-unpacked 载荷归档跑首启全流程——验证用户拿到的内容）");
  assert.deepEqual(smoke.env, {
    WORKLOOM_PG_PORT: "55432",
    WORKLOOM_SERVER_PORT: "58787",
    WORKLOOM_WEB_PORT: "55173",
    WORKLOOM_NATS_PORT: "54222",
  });
  const ports = Object.values(smoke.env).map(Number);
  assert.equal(ports.includes(5432), false);
  assert.equal(new Set(ports).size, ports.length);
  assert.match(smoke.run, /SMOKE_ROOT="\$RUNNER_TEMP\/wl-smoke"/u);
  assert.match(smoke.run, /APP_SMOKE_ROOT="\$RUNNER_TEMP\/wl-app-smoke"/u);
  assert.match(smoke.run, /RENDER_SMOKE_ROOT="\$RUNNER_TEMP\/wl-render-default"/u);
  assert.doesNotMatch(smoke.run, /\$\{TEMP\}\/wl-/u);

  const diagnostics = stepByName("windows", "留存失败诊断（私有 Actions Artifact）");
  const evidencePaths = String(diagnostics.with.path);
  for (const directory of ["wl-smoke", "wl-app-smoke", "wl-render-default"]) {
    assert.match(evidencePaths, new RegExp(`runner\\.temp \\}\\}/${directory}/logs`, "u"));
    assert.match(evidencePaths, new RegExp(`runner\\.temp \\}\\}/${directory}/install-state\\.json`, "u"));
  }
});

test("production secrets exist only in the minimum signing steps", () => {
  assert.deepEqual(secretReferences(workflow.env), []);
  for (const [jobName, value] of Object.entries(workflow.jobs)) {
    assert.deepEqual(secretReferences(value.env), [], `${jobName}: job env must not hold secrets`);
  }

  const actual = [];
  for (const [jobName, value] of Object.entries(workflow.jobs)) {
    for (const step of value.steps ?? []) {
      for (const secret of secretReferences(step)) actual.push(`${jobName}:${step.name ?? step.uses}:${secret}`);
      const run = String(step.run ?? "");
      assert.doesNotMatch(run, /\$\{\{\s*(?:inputs\.|env\.VERSION)/u, `${jobName}:${step.name}: untrusted expression in shell source`);
    }
  }
  assert.deepEqual(actual.sort(), [
    "macos:打包 DMG（arm64）:APPLE_APP_SPECIFIC_PASSWORD",
    "macos:打包 DMG（arm64）:APPLE_ID",
    "macos:打包 DMG（arm64）:APPLE_TEAM_ID",
    "macos:打包 DMG（arm64）:MAC_CSC_KEY_PASSWORD",
    "macos:打包 DMG（arm64）:MAC_CSC_LINK",
    "macos:打包 DMG（x64）:APPLE_APP_SPECIFIC_PASSWORD",
    "macos:打包 DMG（x64）:APPLE_ID",
    "macos:打包 DMG（x64）:APPLE_TEAM_ID",
    "macos:打包 DMG（x64）:MAC_CSC_KEY_PASSWORD",
    "macos:打包 DMG（x64）:MAC_CSC_LINK",
    "macos:生成签名 Bundle（最小私钥作用域）:BUNDLE_SIGNING_PRIVATE_KEY",
    "windows:打包 NSIS 安装包:WIN_CSC_KEY_PASSWORD",
    "windows:打包 NSIS 安装包:WIN_CSC_LINK",
    "windows:生成签名 Bundle（最小私钥作用域）:BUNDLE_SIGNING_PRIVATE_KEY",
  ].sort());

  for (const name of ["macos", "windows", "publish-desktop-release"]) {
    for (const step of job(name).steps ?? []) {
      if (/安装依赖|验证并构建 web|装配自包含载荷|冒烟|原子组装/u.test(String(step.name ?? ""))) {
        assert.deepEqual(secretReferences(step), [], `${name}:${step.name} must not receive production secrets`);
      }
    }
  }
});

test("platform jobs hand off three installers and publisher adds a verifiable public manifest", () => {
  const macSeal = stepByName("macos", "封存已验收 macOS 双架构制品").run;
  const winSeal = stepByName("windows", "封存已验收 Windows 制品").run;
  assert.match(macSeal, /WorkLoom-mac-arm64\.dmg/u);
  assert.match(macSeal, /WorkLoom-mac-x64\.dmg/u);
  assert.match(winSeal, /WorkLoom-win-x64\.exe/u);
  assert.match(macSeal, /sha512/u);
  assert.match(winSeal, /sha512/u);

  const publish = stepByName("publish-desktop-release", "原子组装、发布并回读核验桌面端 Release").run;
  assert.match(publish, /INSTALLERS=\("WorkLoom-mac-arm64\.dmg" "WorkLoom-mac-x64\.dmg" "WorkLoom-win-x64\.exe"\)/u);
  assert.match(publish, /WorkLoom-SHA512SUMS\.txt/u);
  assert.match(publish, /WorkLoom-release-manifest\.json/u);
  assert.match(publish, /product:\s*"workloom-desktop"/u);
  assert.doesNotMatch(publish, /verify_remote_assets remote/u);
  assert.match(publish, /公开 Release 必须与本次已签名候选逐字节绑定/u);
  assert.match(publish, /verify_public_release_with_retry/u);
  assert.match(publish, /公开 Release 在 \$\{max_attempts\} 次回读后仍无法完成最终证明/u);
  assert.match(publish, /已公开版本重跑全程只读/u);
  assert.doesNotMatch(publish, /--latest="\$TARGET_IS_HIGHEST"/u);
  assert.match(publish, /Release 列表可能被截断/u);
  assert.match(statePolicy, /Release 列表可能被截断/u);
  assert.match(publish, /仓库 latest 必须指向最高桌面稳定版/u);
  assert.match(publish, /--draft --latest=false/u);
  assert.match(publish, /绝不对公开\/不可变 Release clobber/u);
  assert.doesNotMatch(publish, /--clobber/u);
  assert.match(publish, /gh release delete-asset "\$RELEASE_TAG" "\$name"/u);
  assert.match(publish, /草稿旧候选删除响应异常，但服务端空状态已回读证明/u);
  assert.match(publish, /草稿候选上传响应异常，但服务端完成状态已回读证明/u);
  assert.match(publish, /可恢复草稿必须由当前桌面发布器创建并绑定精确提交/u);
  assert.match(publish, /verify_remote_assets/u);
  assert.match(publish, /cmp -s/u);
  assert.match(publish, /sha512sum/u);
  assert.match(publish, /verify_tag/u);
  assert.match(publish, /rollback_public_release/u);
  assert.match(publish, /PREPROMOTION_PROVEN=true/u);
  assert.match(publish, /TARGET_REPROVEN=false/u);
  assert.match(publish, /reprove_target_with_retry/u);
  assert.match(publish, /\[ "\$reprove_status" -eq 20 \] \|\|/u);
  assert.match(publish, /拒绝基于不确定性改写 latest/u);
  assert.match(publish, /只有确定性不一致才允许调用方清除 latest/u);
  assert.match(publish, /远端标签发生漂移[^\n]+return 20/u);
  assert.match(publish, /gh release edit "\$RELEASE_TAG"[^\n]+--latest=false \|\| demote_status=\$\?/u);
  assert.match(publish, /未证明的不可变目标仍占据 latest/u);
  assert.match(publish, /targetReproven\|\|r\.tagName!==target/u);
  assert.match(publish, /for candidate in "\$\{restore_candidates\[@\]\}"/u);
  assert.match(publish, /if \[ "\$TARGET_REPROVEN" = "true" \]; then[^]*RESTORE_TAG="\$RELEASE_TAG"/u);
  assert.match(publish, /\[ "\$proof_status" -eq 20 \]/u);
  assert.match(publish, /历史候选证明遇到远端不确定状态；拒绝跳过它并选择更低版本/u);
  assert.match(publish, /\[ "\$TARGET_REPROVEN" = "true" \] \|\| return 1/u);
  assert.match(publish, /不可变失败后 latest 未恢复到最高已证明桌面稳定版/u);
  assert.match(publish, /prove_public_candidate_shape "\$candidate"/u);
  assert.match(publish, /latest 候选 manifest 身份不正确/u);
  assert.match(publish, /verify_tag "\$tag" "\$candidate_sha"/u);
  assert.match(publish, /公开 Release 未进入 GitHub 不可变状态/u);
  assert.match(publish, /不可变目标重新绑定本次候选并修复 latest 后已通过闭环/u);
  assert.match(statePolicy, /release\?\.isImmutable !== true/u);
  assert.match(publish, /--draft=false --latest=true/u);
  assert.match(publish, /已公开 Release 资产不完整或字节不一致，已撤回为草稿/u);
});

test("candidate artifacts support partial reruns without crossing the workflow run or commit", () => {
  assert.match(source, /选择不晚于当前 attempt 的最近有效候选/u);
  assert.match(source, /绝不跨 run/u);
  const uploads = [
    stepByName("macos", "上传已验收 macOS 候选制品"),
    stepByName("windows", "上传已验收 Windows 候选制品"),
  ];
  const resolver = stepByName("publish-desktop-release", "解析同一运行最近的双平台候选");
  const downloads = [
    stepByName("publish-desktop-release", "下载 macOS 候选制品"),
    stepByName("publish-desktop-release", "下载 Windows 候选制品"),
  ];
  for (const step of uploads) {
    assert.match(step.with.name, /candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/u);
  }
  assert.equal(resolver.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(resolver.env.RELEASE_SHA, "${{ needs.preflight.outputs.release-sha }}");
  assert.equal(resolver.env.REPOSITORY_ID, "${{ github.repository_id }}");
  assert.match(resolver.run, /gh api --paginate --slurp/u);
  assert.match(resolver.run, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/artifacts\?per_page=100&direction=desc/u);
  assert.match(resolver.run, /workflowRun\.repository_id !== repositoryId/u);
  assert.match(resolver.run, /workflowRun\.head_repository_id !== repositoryId/u);
  assert.match(resolver.run, /workflowRun\.head_branch !== "main"/u);
  assert.match(resolver.run, /workflowRun\.head_sha !== sha/u);
  assert.match(resolver.run, /artifactAttempt > attempt/u);
  assert.match(resolver.run, /\^sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(resolver.run, /候选 Artifact 列表被截断/u);
  assert.equal(downloads[0].with["artifact-ids"], "${{ steps.candidates.outputs.macos-id }}");
  assert.equal(downloads[1].with["artifact-ids"], "${{ steps.candidates.outputs.windows-id }}");
  for (const step of downloads) {
    assert.equal(step.with["github-token"], "${{ github.token }}");
    assert.equal(step.with.repository, "${{ github.repository }}");
    assert.equal(step.with["run-id"], "${{ github.run_id }}");
    assert.equal(step.with["merge-multiple"], true);
    assert.equal(step.with.name, undefined);
  }

  const selector = inlineStdinNodeContaining(resolver.run, "候选 Artifact 列表被截断");
  const root = mkdtempSync(join(tmpdir(), "workloom-artifact-selector-"));
  const jsonPath = join(root, "artifacts.json");
  const sha = "a".repeat(40);
  const repositoryId = 456;
  const artifact = (id, platform, attempt, overrides = {}) => ({
    id,
    name: `desktop-${platform}-candidate-123-${attempt}`,
    size_in_bytes: 10,
    digest: `sha256:${"b".repeat(64)}`,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: {
      id: 123,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_branch: "main",
      head_sha: sha,
    },
    ...overrides,
  });
  try {
    writeFileSync(jsonPath, JSON.stringify([{
      total_count: 2,
      artifacts: [artifact(11, "macos", 1), artifact(12, "windows", 1)],
    }]));
    let result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "macos-id=11\nmacos-attempt=1\nwindows-id=12\nwindows-attempt=1\n");

    writeFileSync(jsonPath, JSON.stringify([
      { total_count: 4, artifacts: [artifact(11, "macos", 1), artifact(12, "windows", 1)] },
      { total_count: 4, artifacts: [artifact(21, "macos", 2, { expired: true, expires_at: "2020-01-01T00:00:00Z" }), artifact(22, "windows", 2)] },
    ]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "macos-id=11\nmacos-attempt=1\nwindows-id=22\nwindows-attempt=2\n");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 3, artifacts: [artifact(11, "macos", 1), artifact(13, "macos", 1), artifact(12, "windows", 1)] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "duplicate newest candidates must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 4, artifacts: [artifact(11, "macos", 1), artifact(12, "windows", 1)] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "truncated artifact inventory must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [artifact(11, "macos", 3), artifact(12, "windows", 1)] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "future attempt must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [artifact(11, "macos", 1, { digest: "" }), artifact(12, "windows", 1)] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "missing API digest must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [
      artifact(11, "macos", 1, { workflow_run: { id: 123, repository_id: 999, head_repository_id: 999, head_branch: "main", head_sha: sha } }),
      artifact(12, "windows", 1),
    ] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "cross-repository candidate must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [
      artifact(11, "macos", 1, { workflow_run: { id: 123, repository_id: repositoryId, head_repository_id: repositoryId, head_branch: "feature", head_sha: sha } }),
      artifact(12, "windows", 1),
    ] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "non-main candidate must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [artifact(11, "macos", 1), artifact(11, "windows", 1)] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "duplicate artifact IDs must fail closed");

    writeFileSync(jsonPath, JSON.stringify([{ total_count: 2, artifacts: [
      artifact(11, "macos", 1, { expired: true, expires_at: "2020-01-01T00:00:00Z" }),
      artifact(12, "windows", 1),
    ] }]));
    result = executeStdinNode(selector, [jsonPath, "123", "2", sha, String(repositoryId)]);
    assert.notEqual(result.status, 0, "platform with only expired candidates must fail closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(JSON.stringify(job("macos")), /diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(JSON.stringify(job("windows")), /diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
});

test("the actual inline writer state machine survives rollback and immutability mutations", () => {
  const publish = stepByName("publish-desktop-release", "原子组装、发布并回读核验桌面端 Release").run;
  const selectRestore = inlineNodeContaining(publish, "stable=rs.filter");
  const selectImmutableRestore = inlineNodeContaining(publish, "targetReproven");
  const quarantine = inlineNodeContaining(publish, "隔离后目标必须是非 latest 草稿");
  const publicProof = inlineNodeContaining(publish, "公开 Release 未进入 GitHub 不可变状态");
  const root = mkdtempSync(join(tmpdir(), "workloom-inline-release-policy-"));
  const jsonPath = join(root, "state.json");
  const expected = ["a.dmg", "b.dmg", "c.exe", "sums.txt", "manifest.json"];
  const row = (tagName, overrides = {}) => ({
    tagName,
    name: `WorkLoom Desktop ${tagName}`,
    isDraft: false,
    isPrerelease: false,
    isImmutable: true,
    isLatest: false,
    assets: expected.map((name) => ({ name, state: "uploaded", size: 1 })),
    ...overrides,
  });
  try {
    writeFileSync(jsonPath, JSON.stringify([
      row("v3.0.0", { isDraft: true }),
      row("v2.9.0"),
      row("ui-v9.9.9", { isLatest: true }),
    ]));
    let result = executeInline(selectRestore, [jsonPath, "v3.0.0", "ui-v9.9.9"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "v2.9.0");

    writeFileSync(jsonPath, JSON.stringify([
      row("v3.0.0", { isLatest: true }),
      row("v2.9.0"),
    ]));
    result = executeInline(selectImmutableRestore, [jsonPath, "v3.0.0", "false"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "v2.9.0", "unreproven immutable target must be excluded");
    result = executeInline(selectImmutableRestore, [jsonPath, "v3.0.0", "true"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\n"), ["v3.0.0", "v2.9.0"], "reproven target leads ordered recovery candidates");

    writeFileSync(jsonPath, JSON.stringify([
      row("v3.0.0", { isDraft: true }),
      row("v2.9.0", { isLatest: true }),
    ]));
    result = executeInline(quarantine, [jsonPath, "v3.0.0", "v2.9.0"]);
    assert.equal(result.status, 0, result.stderr);
    result = executeInline(quarantine, [jsonPath, "v3.0.0", "ui-v9.9.9"]);
    assert.notEqual(result.status, 0, "wrong rollback latest must fail");

    writeFileSync(jsonPath, JSON.stringify(Array.from({ length: 1000 }, (_, index) => row(`v1.0.${index}`))));
    result = executeInline(quarantine, [jsonPath, "v3.0.0", ""]);
    assert.notEqual(result.status, 0, "truncated release list must fail closed");

    writeFileSync(jsonPath, JSON.stringify(row("v3.0.0")));
    result = executeInline(publicProof, [jsonPath, "v3.0.0", ...expected]);
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(jsonPath, JSON.stringify(row("v3.0.0", { isImmutable: false })));
    result = executeInline(publicProof, [jsonPath, "v3.0.0", ...expected]);
    assert.notEqual(result.status, 0, "mutable public release must fail closed");

    assert.match(publish, /gh release edit "\$restore_tag"[^\n]+\|\| restore_status=\$\?/u);
    assert.match(publish, /gh release edit "\$RELEASE_TAG"[^\n]+\|\| QUARANTINE_STATUS=\$\?/u);
    assert.match(publish, /服务端最终状态已回读证明/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
