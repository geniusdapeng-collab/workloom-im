import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { loadCnbReleaseChannelConfig, verifyCnbReleaseChannel } from "./verify-product-content.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * 夹具一律从**真实的 .cnb.yml / product.manifest.json** 派生，并且必须走生产
 * 门禁自己的解析入口：若测试自行解析，include 的展开口径一变，测试就会在一个
 * 生产从未见到的结构上判绿（既有缺陷：测试递归展开 include，生产只解析原文）。
 * 这里只调用 loadCnbReleaseChannelConfig，保证“测试绿 = 生产绿”是同一份代码。
 */
async function realConfig() {
  const text = await readFile(path.join(repoRoot, ".cnb.yml"), "utf8");
  return loadCnbReleaseChannelConfig({ desktopWorkflow: text, repositoryRoot: repoRoot, root: repoRoot, fs, path });
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

test("测试与生产必须用同一份解析入口，include 展开口径不得分叉", async () => {
  const text = await readFile(path.join(repoRoot, ".cnb.yml"), "utf8");
  // 生产门禁的构建路径与被测的夹具路径必须是同一个函数：此前夹具自行
  // resolvePipelineConfig（展开 include），生产直接 YAML.parse 原文（不展开），
  // 同一个门禁在“被 include 的作业/阶段”上给出两套结论。
  const configured = await realConfig();
  const raw = YAML.parse(text);
  const declared = (await manifest()).desktop.sourceGates;
  // 真实结构下二者的可见作业集合本就不同（bootstrap review 只存在于 include 中）；
  // 断言的是“生产读到的就是展开后的生效结构”，并保留这条差异作为可复核证据。
  const includeOnly = ["delivery-bootstrap-review"];
  for (const name of includeOnly) {
    assert.ok(!(raw["**"]?.pull_request ?? []).some((job) => job?.name === name), `原文不应直接看到 ${name}`);
    assert.ok((configured["**"]?.pull_request ?? []).some((job) => job?.name === name), `生效配置必须看到 ${name}`);
  }
  for (const name of declared) {
    assert.ok((configured["**"]?.pull_request ?? []).some((job) => job?.name === name && Array.isArray(job.stages) && job.stages.length), `生效配置必须看到门禁 ${name}`);
  }
});

test("门禁必须在 include 展开后的生效结构上判定，而不是只看 .cnb.yml 原文", async () => {
  const text = await readFile(path.join(repoRoot, ".cnb.yml"), "utf8");
  const raw = YAML.parse(text);
  const effective = await realConfig();

  // 分叉的可复核证据：delivery-* 与 delivery-bootstrap-review 都由 include 提供，
  // 只解析原文看不到它们。此前生产门禁用 YAML.parse(原文)，测试用展开 include，
  // 同一个门禁因此在“被 include 的作业/阶段”上给出两套结论。
  // delivery-source-admission / delivery-ai-review 挂在 pull_request.target（merge 事件），
  // 不在 **/pull_request 上；**/pull_request 里由 include 新增的只有 bootstrap review。
  const includeOnly = ["delivery-bootstrap-review"];
  const rawPr = (raw["**"]?.pull_request ?? []).map((job) => job?.name);
  const effectivePr = (effective["**"]?.pull_request ?? []).map((job) => job?.name);
  for (const name of includeOnly) {
    assert.ok(!rawPr.includes(name), `原文不应直接看到 ${name}，实际：${JSON.stringify(rawPr)}`);
    assert.ok(effectivePr.includes(name), `生效配置必须看到 ${name}，实际：${JSON.stringify(effectivePr)}`);
  }

  // 生效结构上的判定必须与真实结构一致：清单声明的门禁齐全且各恰好一个可执行实例。
  const product = await manifest();
  assert.deepEqual(await run(effective), [], "真实生效结构不得报出门禁错误");
  for (const name of product.desktop.sourceGates) {
    const matches = (effective["**"]?.pull_request ?? []).filter((job) => job?.name === name && Array.isArray(job.stages) && job.stages.length);
    assert.equal(matches.length, 1, `生效配置必须恰好看到一个可执行的 ${name}`);
  }

  // 反向自证：把生效结构里被 include 提供的 PR 门禁删掉，门禁必须点名单个缺失项，
  // 证明它确实读到了 include 提供的内容（而不是在原文上空跑）。
  const broken = structuredClone(effective);
  broken["**"].pull_request = broken["**"].pull_request.filter((job) => job?.name !== "delivery-bootstrap-review");
  const errors = await run(broken);
  assert.equal(errors.some((error) => error.includes("delivery-bootstrap-review")), false,
    "delivery-* 不是清单声明的产品源码门禁，删除它不应被误报为源码门禁缺失");

  // 删掉一个由 include 提供的候选作业后，门禁必须点名缺失 —— 证明它读的确实是
  // 展开后的结构，而不是在原文上空跑出“通过”。
  const missingJob = structuredClone(effective);
  missingJob["$"].api_trigger_desktop_release = missingJob["$"].api_trigger_desktop_release
    .filter((job) => job?.name !== "desktop-release-macos");
  const jobErrors = await run(missingJob);
  assert.ok(jobErrors.some((error) => error.includes("macOS 签名/公证")), jobErrors.join("\n"));
});

test("解析入口拒绝越出仓库/不存在的 include，且解析失败时不放行", async () => {
  await assert.rejects(
    loadCnbReleaseChannelConfig({
      desktopWorkflow: 'include: ../outside.yml\nmain:\n  push: []\n',
      repositoryRoot: repoRoot, root: repoRoot, fs, path,
    }),
    /越出|include|安全/u,
  );
  await assert.rejects(
    loadCnbReleaseChannelConfig({
      desktopWorkflow: 'include: scripts/delivery/does-not-exist.yml\nmain:\n  push: []\n',
      repositoryRoot: repoRoot, root: repoRoot, fs, path,
    }),
    /ENOENT|include|无法读取/u,
  );
  await assert.rejects(
    loadCnbReleaseChannelConfig({ desktopWorkflow: "- just\n- a\n- list\n", repositoryRoot: repoRoot, root: repoRoot, fs, path }),
    /映射|mapping|CI/u,
  );
  await assert.rejects(
    loadCnbReleaseChannelConfig({ desktopWorkflow: "   \n", repositoryRoot: repoRoot, root: repoRoot, fs, path }),
    /为空/u,
  );
});
