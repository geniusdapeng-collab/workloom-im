#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { resolveDesktopWorkflowPath } from "./desktop-workflow-path.mjs";

const root = process.cwd();
let repositoryRoot = root;
try {
  repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  // 非 Git 制品校验继续以当前目录为根；缺失清单会给出明确错误。
}
const bundlesRoot = path.join(root, "bundles");
const errors = [];
const envExample = path.join(root, ".env.example");
const envText = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";
const activeSeedScripts = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m)?.[1] ?? "";
const productManifestPath = path.join(repositoryRoot, "product.manifest.json");

function requiredJson(file, label) {
  if (!fs.existsSync(file)) {
    errors.push(`缺少${label}：${path.relative(root, file)}`);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { errors.push(`${label}不是合法 JSON：${path.relative(root, file)}`); return null; }
}

const product = requiredJson(productManifestPath, "产品清单");
if (product) {
  if (product.schemaVersion !== "workloom.product/v1") errors.push("产品清单 schemaVersion 必须为 workloom.product/v1");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(product.productId ?? "")) errors.push("产品标识格式不正确");
  if (!/^[\w.-]+\/[\w.-]+$/.test(product.repository ?? "")) errors.push("产品清单 repository 格式不正确");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(product.demoWorkspaceSlug ?? "")) errors.push("演示工作区标识格式不正确");
  if (!/^[A-Z][A-Z0-9-]{1,31}$/.test(product.demoMemberNo ?? "")) errors.push("演示成员编号格式不正确");
  if (!Number.isInteger(product.desktop?.portOffset) || product.desktop.portOffset < 0 || product.desktop.portOffset > 900) {
    errors.push("桌面端口偏移必须为 0 到 900 的整数");
  }
  for (const [client, spec] of Object.entries(product.clients ?? {})) {
    if (spec?.enabled !== true) errors.push(`${client} 未启用；正式产品必须明确提供三端`);
    const clientDir = path.resolve(root, spec?.entry ?? "");
    if (!spec?.entry || !clientDir.startsWith(`${root}${path.sep}`) || !fs.existsSync(path.join(clientDir, "package.json"))) {
      errors.push(`${client} 入口不存在或越出仓库：${spec?.entry ?? "未配置"}`);
    }
  }
  for (const requiredClient of ["bPc", "bMobile", "cMobile"]) {
    if (!product.clients?.[requiredClient]) errors.push(`产品清单缺少三端入口：${requiredClient}`);
  }
  const packageJson = requiredJson(path.join(root, "package.json"), "根 package.json");
  if (packageJson && packageJson.name !== product.packageName) errors.push("产品清单 packageName 与根 package.json 不一致");
  const defaultBundle = path.join(bundlesRoot, product.defaultBundle ?? "", "bundle.json");
  if (!fs.existsSync(defaultBundle)) errors.push(`默认行业包不存在：${product.defaultBundle ?? "未配置"}`);

  const builderPath = path.join(root, "electron-builder.yml");
  const builder = fs.existsSync(builderPath) ? fs.readFileSync(builderPath, "utf8") : "";
  if (!builder.includes(`appId: ${product.release?.appId}`)) errors.push("electron-builder appId 与产品清单不一致");
  if (!builder.includes(`productName: ${product.displayName}`)) errors.push("electron-builder productName 与产品清单不一致");
  if (!builder.includes(`workloomPortOffset: ${product.desktop?.portOffset}`)) errors.push("electron-builder 端口偏移与产品清单不一致");
  for (const marker of [
    "notarize: true",
    "hardenedRuntime: true",
    "entitlements: build/entitlements.mac.plist",
    "from: build/bundle-trust.json",
  ]) {
    if (!builder.includes(marker)) errors.push(`桌面生产构建缺少安全配置：${marker}`);
  }

  let desktopWorkflowPath;
  try {
    desktopWorkflowPath = resolveDesktopWorkflowPath(repositoryRoot, product).absolute;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    desktopWorkflowPath = path.join(repositoryRoot, ".github/workflows/desktop-production-release.yml");
  }
  const desktopWorkflow = fs.existsSync(desktopWorkflowPath) ? fs.readFileSync(desktopWorkflowPath, "utf8") : "";
  if (product.release?.workflow === ".cnb.yml") {
    // 必须与 CNB 实际生效的结构一致：.cnb.yml 的 include 会追加/合并进顶层键，
    // 只 YAML.parse 原始文本看不到被 include 的作业与阶段，门禁会在真实运行前
    // 给出与平台不同的（通常更宽的）结论。这里走同一个受控解析入口，
    // 由 loadCnbReleaseChannelConfig 负责把 include 展开成生效配置。
    let configured = null;
    try { configured = await loadCnbReleaseChannelConfig({ desktopWorkflow, repositoryRoot, root, fs, path }); }
    catch (error) { errors.push(`CNB 桌面发布工作流无法解析：${error instanceof Error ? error.message : String(error)}`); }
    if (configured) {
      for (const error of verifyCnbReleaseChannel({ product, configured, root, repositoryRoot, fs, path })) errors.push(error);
    }
  } else {
    for (const marker of ["MAC_CSC_LINK", "APPLE_APP_SPECIFIC_PASSWORD", "codesign --verify --deep --strict",
      "xcrun stapler validate", "WIN_CSC_LINK", "Get-AuthenticodeSignature", "pnpm bundle:release"]) {
      if (!desktopWorkflow.includes(marker)) errors.push(`桌面发布工作流缺少安全门禁：${marker}`);
    }
  }

  const releaseScript = path.join(root, "scripts/release.sh");
  if (fs.existsSync(releaseScript)) {
    const releaseSource = fs.readFileSync(releaseScript, "utf8");
    if (!releaseSource.includes("本地/长期令牌 Release 通道已封禁") || !/^exit 1$/mu.test(releaseSource)) {
      errors.push("release.sh 必须保持 fail-closed，正式发行只允许受保护 workflow 单一发布者");
    }
    if (/GH_TOKEN|api\.github\.com|uploads\.github\.com|\bcurl\b|\bgh\s+release\b/u.test(releaseSource)) {
      errors.push("release.sh 不得保留任何令牌或 GitHub Release 网络写入通道");
    }
  }
  const siteRoot = path.resolve(root, product.release?.website ?? "");
  for (const file of ["index.html", "en.html"]) {
    const siteFile = path.join(siteRoot, file);
    if (fs.existsSync(siteFile) && !fs.readFileSync(siteFile, "utf8").includes(`github.com/${product.repository}`)) {
      errors.push(`${path.relative(root, siteFile)} 下载/仓库地址与产品清单不一致`);
    }
  }
}

/**
 * CNB 发布通道生效配置的唯一入口：生产门禁与它的测试必须走同一条解析路径。
 *
 * CNB 对 include 的语义是“数组追加、对象合并”（见官方语法手册），因此
 * `.cnb.yml` 真正生效的结构不等于 `YAML.parse` 原文得到的结构：只解析原文会
 * 看不到被 include 的作业与阶段，于是门禁可能在一个平台上并不存在的结构上判绿，
 * 测试却因为展开 include 而全绿——同一个门禁给出两套口径。
 *
 * 这里统一用受控的 resolvePipelineConfig 递归展开 include（相对路径限于仓库内、
 * 拒绝越界/网络/循环），生产与测试都只能通过它拿到 configured。
 */
export async function loadCnbReleaseChannelConfig({ desktopWorkflow, repositoryRoot, root = repositoryRoot, fs, path }) {
  if (typeof desktopWorkflow !== "string" || !desktopWorkflow.trim()) throw new Error("CNB 桌面发布工作流为空");
  // 动态 import 保持本文件顶层语句的既有同步执行序（门禁脚本按顺序累积 errors，
  // 引入顶层 await 会把上方的顶层检查推到异步之后，改变门禁语义）。
  const { resolvePipelineConfig } = await import("./delivery/queue-policy.mjs");
  const readLocal = (relative) => {
    const absolute = path.resolve(root, relative);
    const delta = path.relative(root, absolute);
    if (delta === ".." || delta.startsWith(`..${path.sep}`)) throw new Error(`CNB include 越出仓库：${relative}`);
    return fs.readFileSync(absolute, "utf8");
  };
  return resolvePipelineConfig(desktopWorkflow, { readLocal });
}

/**
 * CNB 发布通道门禁校验：清单声明 release.workflow === ".cnb.yml" 时才生效。
 *
 * 契约必须与实际承载结构一致，否则「切到 .cnb.yml」会以大量错位的
 * 「缺少安全门禁」fail-closed（方向安全、契约错误），且没有真实证据可复核：
 *   - 源码门禁与原生候选触发名一律取自 product.desktop.sourceGates /
 *     nativeCandidateTrigger，不写死任何仓的栈名；
 *   - 原生候选作业位于顶层 `$` 键下（CNB 的 API 触发事件不是分支键），
 *     作业标签按桌面发布实际语义判定（mac 自托管节点 / windows 自托管节点）；
 *   - 签名、公证、Authenticode、PG 运行时、载荷装配与首启冒烟标记位于
 *     作业 stage 脚本内（该发布通道不用 pack-mac.sh / pack-windows.sh），
 *     判定的是「受控作业确实执行这些命令」，而不是「某个脚本文件写着这些词」。
 * 进入该分支前必须补齐清单字段；字段缺失或与工作流不一致都点名拒绝。
 */
const SAFE_NODE_SCRIPT = /^scripts\/[A-Za-z0-9._-]+\.mjs$/u;

/** 只把可执行行当命令：注释与字符串里的同名标记不能冒充门禁。 */
function scriptStatements(script) {
  return String(script ?? "").split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
}

function runnerTags(job) {
  const tags = job?.runner?.tags;
  return Array.isArray(tags) ? tags.map((tag) => String(tag)) : [];
}

/** CNB 的 `$` 事件键：事件值必须是（可带条件包装的）非空作业数组。 */
function eventJobs(configured, event) {
  const value = configured?.["$"]?.[event];
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function statementsOf(job) {
  if (!job || !Array.isArray(job.stages)) return null;
  // 结构化阶段（await/resolve/trigger 等）没有脚本：只收集有脚本的阶段，
  // 但作业至少要有一个真实脚本阶段，否则“作业存在”不等于“门禁被执行”。
  const scripts = job.stages.filter((stage) => stage && typeof stage.script === "string" && stage.script.trim());
  if (!scripts.length) return null;
  return scripts.flatMap((stage) => scriptStatements(stage.script));
}

function exactJob(jobs, predicate) {
  const matches = Array.isArray(jobs) ? jobs.filter(predicate) : [];
  return matches.length === 1 ? matches[0] : null;
}

export function verifyCnbReleaseChannel({ product, configured, root, repositoryRoot, fs, path }) {
  const errors = [];
  const sourceNames = product.desktop?.sourceGates;
  const candidateTrigger = product.desktop?.nativeCandidateTrigger;

  // 1) PR 源码门禁：清单声明的每个门禁都必须恰好有一个可执行实例。
  //    PR 通道还承载交付器的只读审查作业（delivery-*-review），它们不是产品源码门禁，
  //    因此这里校验“声明的门禁齐全且不重复”，而不是“通道里只有这三个”。
  const sourceJobs = configured?.["**"]?.pull_request;
  if (!Array.isArray(sourceNames) || !sourceNames.length || sourceNames.some((name) => typeof name !== "string" || !name)) {
    errors.push("产品清单缺少受控 CNB 源码门禁名（product.desktop.sourceGates）");
  } else if (!Array.isArray(sourceJobs)) {
    errors.push(`CNB **/pull_request 缺少必需源码门禁：${sourceNames.join("、")}`);
  } else {
    for (const name of sourceNames) {
      const matches = sourceJobs.filter((job) => job?.name === name && Array.isArray(job.stages) && job.stages.length > 0);
      if (matches.length !== 1) {
        errors.push(`CNB **/pull_request 缺少可执行的清单声明源码门禁：${name}（实际 ${matches.length} 个）`);
      }
    }
  }

  // 2) 原生候选触发必须是顶层 `$` 下的确切实例；main 推送不得伪装成候选通道。
  if (typeof candidateTrigger !== "string" || !candidateTrigger) {
    errors.push("产品清单缺少受控 CNB 原生候选触发名（product.desktop.nativeCandidateTrigger）");
  } else if (!eventJobs(configured, candidateTrigger)) {
    errors.push(`CNB $/${candidateTrigger} 必须是非空的原生候选作业列表（清单声明的候选触发）`);
  }
  const mainPush = configured?.main?.push;
  for (const name of ["desktop-release-macos", "desktop-release-windows", "desktop-release-finalize"]) {
    if (Array.isArray(mainPush) && mainPush.some((job) => job?.name === name)) {
      errors.push(`CNB main/push 不得承载桌面候选作业：${name}（候选发布只走 ${candidateTrigger ?? "候选触发"}）`);
    }
  }

  // 3) 原生候选作业必须真实执行签名/公证/Authenticode/载荷装配与首启冒烟。
  const smokePath = product.desktop?.smokeRunner;
  if (typeof smokePath !== "string" || !SAFE_NODE_SCRIPT.test(smokePath)) {
    errors.push("产品清单缺少受控原生桌面冒烟入口（product.desktop.smokeRunner）");
  }
  const requires = [
    { platform: "mac", job: "desktop-release-macos", label: "macOS 签名/公证", tags: ["mac", "arm64"],
      markers: ["MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
        "pack-electron-payload.sh", "--frozen-lockfile", "codesign --verify --deep --strict", "xcrun stapler validate"] },
    { platform: "win", job: "desktop-release-windows", label: "Windows 签名/Authenticode", tags: ["windows"],
      markers: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "build-pgvector-win.ps1", "pack-electron-payload.sh",
        "--frozen-lockfile", "Get-AuthenticodeSignature"] },
  ];
  for (const spec of requires) {
    const markerList = [...spec.markers, ...(SAFE_NODE_SCRIPT.test(smokePath ?? "") ? [path.basename(smokePath)] : [])];
    const job = typeof candidateTrigger === "string" && candidateTrigger
      ? exactJob(eventJobs(configured, candidateTrigger), (entry) => entry?.name === spec.job
          && spec.tags.every((tag) => runnerTags(entry).includes(tag)))
      : null;
    const statements = statementsOf(job);
    if (!job || !statements) {
      errors.push(`CNB $/${candidateTrigger ?? "候选触发"} 缺少受控的 ${spec.label} 作业（tags 需含 ${spec.tags.join("/")}）`);
      continue;
    }
    for (const marker of markerList) {
      if (!statements.some((statement) => statement.includes(marker))) {
        errors.push(`CNB ${spec.label} 作业缺少安全门禁：${marker}`);
      }
    }
  }
  return errors;
}

function requireSource(relativePath, checks) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`基座文件不存在：${relativePath}`);
    return;
  }
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const { includes, excludes, message } of checks) {
    if (includes && !source.includes(includes)) errors.push(`${relativePath}: ${message}`);
    if (excludes && source.includes(excludes)) errors.push(`${relativePath}: ${message}`);
  }
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, result));
  return result;
}

for (const entry of fs.readdirSync(bundlesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const bundleDir = path.join(bundlesRoot, entry.name);
  const manifestPath = path.join(bundleDir, "bundle.json");
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const provided = collectStrings(manifest.workloom?.provides ?? {});
  for (const relativePath of provided) {
    const absolutePath = path.resolve(bundleDir, relativePath);
    if (!absolutePath.startsWith(`${bundleDir}${path.sep}`) || !fs.existsSync(absolutePath)) {
      errors.push(`${entry.name}: bundle.json 声明的资产不存在：${relativePath}`);
    }
  }

  if (entry.name === "ai-pm" && activeSeedScripts.includes("seed-aipm")) {
    const presets = manifest.workloom?.provides?.presets ?? [];
    const skills = manifest.workloom?.provides?.skills ?? [];
    if (presets.length !== 14) errors.push(`ai-pm: 数字员工应为 14，实际为 ${presets.length}`);
    if (skills.length !== 20) errors.push(`ai-pm: 技能应为 20，实际为 ${skills.length}`);
  }
}

if (fs.existsSync(envExample)) {
  const match = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m);
  for (const seed of (match?.[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!fs.existsSync(path.join(root, seed))) errors.push(`桌面种子脚本不存在：${seed}`);
  }
  const primarySeed = (match?.[1] ?? "").split(",")[0]?.trim();
  if (primarySeed && fs.existsSync(path.join(root, primarySeed))) {
    const seedSource = fs.readFileSync(path.join(root, primarySeed), "utf8");
    if (!seedSource.includes("bundle_id") || !seedSource.includes("is_example")) {
      errors.push(`桌面主种子必须同时写入 bundle_id 与 is_example：${primarySeed}`);
    }
  }
}

// 跨行业统一的语音/人物/命名交付契约。把截图中出现过的回归模式固化成发布门禁，
// 避免某个行业仓同步基座时又带回长文案、随机换声或“人名+岗位”叠层。
requireSource("apps/web/src/components/welcomeScripts.ts", [
  { includes: "老板您好，我是织伴，您的 AI 小秘书", message: "欢迎开场必须使用精简版文案" },
  { excludes: "接下来给我一分钟", message: "欢迎开场不得恢复一分钟长介绍" },
]);
requireSource("apps/web/src/voice/VoiceEngine.ts", [
  { includes: "voiceCache", message: "同一角色必须锁定 voice" },
  { includes: "AudioEngine.setSpeechActive(true)", message: "TTS 开始时必须 duck 环境声" },
  { includes: "preferredNames", message: "角色音色必须支持确定性首选列表" },
]);
for (const scene of ["apps/web/src/components/Floor3D.tsx", "apps/web/src/components/Stage3D.tsx"]) {
  requireSource(scene, [
    { includes: "BusinessAvatar3D", message: "正式 3D 职场必须使用现代商务人物" },
    { includes: "displayNameOf", message: "3D 名牌必须遵循岗位名/用户别名规则" },
    { excludes: "personaOf(", message: "3D 名牌不得显示系统生成的人名" },
  ]);
}
requireSource("apps/web/src/components/Floor3D.tsx", [
  { includes: "!dimmed && hovered", message: "职场空闲态只能悬停显示名牌，避免 3D 人群标签重叠" },
]);
requireSource("apps/web/src/components/Stage3D.tsx", [
  { includes: "hovered || spotlight", message: "舞台只应在悬停或点名时显示成员名牌" },
]);
requireSource("apps/web/src/components/CeremonyStage.tsx", [
  { includes: "data-ceremony-ready={ready ? \"true\" : \"false\"}", message: "团队舞台必须等全员首帧后才报告 ready" },
]);

if (errors.length) {
  console.error(["产品内容完整性检查失败：", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log("产品内容完整性检查通过：产品身份、三端入口、发布目标、Bundle 资产、数字员工、技能、桌面种子、语音与场景命名契约一致。");
