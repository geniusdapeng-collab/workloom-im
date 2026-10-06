import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { verifyCnbReleaseChannel } from "./verify-product-content.mjs";

/** 受控入口夹具：模拟一个小仓声明 .cnb.yml 发布通道时的清单与工作流。 */
function fixture({ sourceGates = ["static-gate", "db-gate", "ui-gate"], candidateTrigger = "api_trigger_native_candidate", nativePath = { mac: "scripts/pack-mac.sh", win: "scripts/pack-windows.sh" } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-product-verify-"));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const smoke = "scripts/native-smoke.mjs";
  fs.writeFileSync(path.join(root, smoke), "// fixture smoke runner\n");
  const markerLines = ["CSC_LINK", "APPLE_APP_SPECIFIC_PASSWORD", "codesign --verify --deep --strict", "xcrun stapler validate", "Get-AuthenticodeSignature", "build-pgvector-win.ps1", "--frozen-lockfile", "pack-electron-payload.sh", smoke, "--render"];
  for (const file of [nativePath.mac, nativePath.win]) fs.writeFileSync(path.join(root, file), markerLines.join("\n") + "\n");

  const sourceJobs = sourceGates.map((name) => ({ name, stages: [{ script: `node --test ${name}.test.mjs` }] }));
  const nativeJob = (token) => ({ runner: { namespace: "group", tags: token === "mac" ? ["mac", "arm64"] : ["windows"] }, stages: [{ script: token === "mac" ? `bash ${nativePath.mac}` : `& ${nativePath.win}` }] });
  const nativeJobCandidate = (token) => ({ ...nativeJob(token), stages: [{ script: token === "mac" ? `bash ${nativePath.mac} --candidate` : `& ${nativePath.win} -Candidate` }] });
  const configured = {
    "**": { pull_request: sourceJobs, [candidateTrigger]: [nativeJobCandidate("mac"), nativeJobCandidate("win")] },
    main: { push: [nativeJob("mac"), nativeJob("win")] },
  };
  const product = { desktop: { sourceGates, nativeCandidateTrigger: candidateTrigger, nativeBuilders: nativePath, smokeRunner: smoke } };
  return { root, repositoryRoot: root, product, configured };
}

const run = (ctx) => verifyCnbReleaseChannel({ ...ctx, fs, path });

test("清单声明的源码门禁与原生候选触发齐全时通过", () => {
  const ctx = fixture();
  try { assert.deepEqual(run(ctx), []); } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test("硬编码栈名不再决定判定：任意清单声明集合都能通过", () => {
  // 本仓实际门禁名；若实现仍写死 py-gate/oss-gate/protocol-gate，这里必然报错。
  const ctx = fixture({ sourceGates: ["static-gate", "db-gate", "ui-gate"] });
  try { assert.deepEqual(run(ctx), []); } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test("源码门禁与清单声明不一致时给出名单而非错位报错", () => {
  const ctx = fixture();
  ctx.configured["**"].pull_request = [{ name: "static-gate", stages: [{ script: "x" }] }];
  try {
    const errors = run(ctx);
    assert.ok(errors.some((error) => error.includes("清单声明的必需源码门禁")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("static-gate")), errors.join("\n"));
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test("清单缺少 sourceGates / nativeCandidateTrigger 时 fail-closed 并点名", () => {
  const ctx = fixture();
  ctx.product.desktop.sourceGates = undefined;
  ctx.product.desktop.nativeCandidateTrigger = undefined;
  try {
    const errors = run(ctx);
    assert.ok(errors.some((error) => error.includes("product.desktop.sourceGates")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("product.desktop.nativeCandidateTrigger")), errors.join("\n"));
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test("原生候选缺少受控开关时拒绝，并在错误里带出受控入口", () => {
  const ctx = fixture();
  const entry = ctx.product.desktop.nativeBuilders.mac;
  ctx.configured["**"][ctx.product.desktop.nativeCandidateTrigger] = [
    { runner: { namespace: "group", tags: ["mac", "arm64"] }, stages: [{ script: `bash ${entry}` }] },
    { runner: { namespace: "group", tags: ["windows"] }, stages: [{ script: `& ${ctx.product.desktop.nativeBuilders.win} -Candidate` }] },
  ];
  try {
    const errors = run(ctx);
    assert.ok(errors.some((error) => error.includes(entry)), errors.join("\n"));
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test("YAML include 后的真实配置能被解析为结构（fixture 自证可用）", () => {
  const ctx = fixture();
  try {
    const parsed = YAML.parse(YAML.stringify(ctx.configured));
    assert.equal(parsed["**"].pull_request.length, ctx.product.desktop.sourceGates.length);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});
