import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolvePipelineConfig } from "./delivery/queue-policy.mjs";
import { verifyCnbReleaseChannel } from "./verify-product-content.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * 夹具一律从**真实的 .cnb.yml / product.manifest.json** 派生（include 递归解析），
 * 不再手写一份与实现同源的结构：否则门禁与真实工作流脱节也照绿。
 */
async function realConfig() {
  const text = await readFile(path.join(repoRoot, ".cnb.yml"), "utf8");
  const configured = await resolvePipelineConfig(text, {
    readLocal: (relative) => readFile(path.join(repoRoot, relative), "utf8"),
  });
  return configured;
}

async function manifest() {
  return JSON.parse(await readFile(path.join(repoRoot, "product.manifest.json"), "utf8"));
}

async function run(configured) {
  return verifyCnbReleaseChannel({
    product: await manifest(), configured, root: repoRoot, repositoryRoot: repoRoot, fs, path,
  });
}

test("本仓真实 .cnb.yml 结构在清单切到 .cnb.yml 后可通过 CNB 发布通道门禁", async () => {
  // 直接读真实工作流：门禁必须能在真实承载结构上被证明会通过，
  // 而不是只对一份手写夹具成立（此前该分支的契约与本仓结构完全脱节）。
  const errors = await run(await realConfig());
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("清单声明的源码门禁与 PR 通道不一致时点名拒绝", async () => {
  const configured = await realConfig();
  configured["**"].pull_request = configured["**"].pull_request.filter((job) => job.name !== "db-gate");
  const product = await manifest();
  const errors = verifyCnbReleaseChannel({ product, configured, root: repoRoot, repositoryRoot: repoRoot, fs, path });
  assert.ok(errors.some((error) => error.includes("清单声明源码门禁：db-gate")), errors.join("\n"));
});

test("候选触发必须真实位于顶层 $ 键，main 推送不得承载候选作业", async () => {
  const missing = await realConfig();
  delete missing["$"].api_trigger_desktop_release;
  const errors = await run(missing);
  assert.ok(errors.some((error) => error.includes("$:api_trigger_desktop_release") || error.includes("$/\u0061pi_trigger_desktop_release")), errors.join("\n"));

  const misplaced = await realConfig();
  const jobs = misplaced["$"].api_trigger_desktop_release;
  delete misplaced["$"].api_trigger_desktop_release;
  misplaced.main.push = [...misplaced.main.push, ...jobs];
  const misplacedErrors = await run(misplaced);
  assert.ok(misplacedErrors.some((error) => error.includes("main/push 不得承载桌面候选作业")), misplacedErrors.join("\n"));
});

test("签名/公证/冒烟标记必须位于候选作业的 stage 脚本内，注释里的标记不算数", async () => {
  const configured = await realConfig();
  for (const [jobName, marker] of [["desktop-release-macos", "xcrun stapler validate"], ["desktop-release-windows", "Get-AuthenticodeSignature"]]) {
    const clone = await realConfig();
    const job = clone["$"].api_trigger_desktop_release.find((entry) => entry.name === jobName);
    // 把标记行改成注释：门禁读取的是可执行行，注释里的同名标记不算证据。
    job.stages = job.stages.map((stage) => (typeof stage.script === "string"
      ? { ...stage, script: stage.script.split("\n").map((line) => (line.includes(marker) ? `# ${line.trim()}` : line)).join("\n") }
      : stage));
    const errors = await run(clone);
    assert.ok(errors.some((error) => error.includes(marker)), `${jobName}: ${errors.join("\n")}`);
  }
  // 反向自证：未改动的真实配置不含这些错位报错。
  assert.equal((await run(configured)).some((error) => error.includes("xcrun stapler validate")), false);
});

test("清单缺少 sourceGates / nativeCandidateTrigger / smokeRunner 时 fail-closed 并点名", async () => {
  const product = await manifest();
  const configured = await realConfig();
  for (const [field, expected] of [["sourceGates", "product.desktop.sourceGates"], ["nativeCandidateTrigger", "product.desktop.nativeCandidateTrigger"], ["smokeRunner", "product.desktop.smokeRunner"]]) {
    const mutated = structuredClone(product);
    delete mutated.desktop[field];
    const errors = verifyCnbReleaseChannel({ product: mutated, configured, root: repoRoot, repositoryRoot: repoRoot, fs, path });
    assert.ok(errors.some((error) => error.includes(expected)), `${field}: ${errors.join("\n")}`);
  }
});

test("冒烟入口不受控时拒绝，且不把任意路径拼进判定", async () => {
  const product = await manifest();
  const configured = await realConfig();
  for (const value of ["../escape.mjs", "/usr/bin/node", "scripts/../smoke.mjs", "scripts/smoke.sh", 42]) {
    const mutated = structuredClone(product);
    mutated.desktop.smokeRunner = value;
    const errors = verifyCnbReleaseChannel({ product: mutated, configured, root: repoRoot, repositoryRoot: repoRoot, fs, path });
    assert.ok(errors.some((error) => error.includes("product.desktop.smokeRunner")), `${String(value)}: ${errors.join("\n")}`);
  }
});
