#!/usr/bin/env node
/**
 * WorkLoom 共享 UI + 三端客户端基座的下游发布门禁与升级 PR 编排。
 *
 * 发布严格分成两个阶段：
 * 1. --preflight：只读克隆全部八个下游仓，确认清单与访问能力，同时把迁移缺口
 *    结构化输出。存量仓未迁移不反向锁死基座稳定制品，只有清单/访问失败才阻断发布。
 * 2. --rollout：确认 registry 中已存在目标稳定制品，并从同一 ui-v* 不可变标签
 *    读取三端应用壳，再按 child-repos.json 的波次处理。受管文件经旧版 SHA-256
 *    验真；行业修改冲突会 fail closed。只创建独立 PR，不直推 main。
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUiConsumerRepo } from "../scripts/verify-ui-consumer.mjs";
import {
  applyClientFoundation,
  inspectClientFoundationState,
  loadStableFoundationSnapshot,
  resolveStableFoundationVersion,
} from "./client-foundation.mjs";
import { resolveUiVersion, setUiVersion } from "./set-ui-version.mjs";

const syncDir = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(syncDir, "..");
const EXPECTED_DOWNSTREAM_COUNT = 8;
const PRODUCT_CLIENTS = Object.freeze({
  bPc: "apps/web",
  bMobile: "apps/webb",
  cMobile: "apps/webc",
});

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const legacyValidate = argv.includes("--validate-only");
  const repositories = (value("--repos") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    mode: argv.includes("--rollout") ? "rollout" : "preflight",
    requestedVersion: value("--version"),
    reportPath: value("--report"),
    wave: value("--wave")?.trim() || undefined,
    repositories,
    dryRun: argv.includes("--dry-run") || legacyValidate,
  };
}

function run(command, commandArgs, cwd, env = {}) {
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

function githubGitEnvironment(token) {
  const environment = { GIT_TERMINAL_PROMPT: "0" };
  if (!token) return environment;
  // 凭据只经子进程环境传递，绝不写入 remote URL、日志或仓库配置。
  return {
    ...environment,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

function repositoryUrl(repo) {
  return `https://github.com/${repo}.git`;
}

function prefixedPath(child, path) {
  const prefix = child.pathPrefix?.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${path}` : path;
}

function blocker(code, path, message, remediation, phase = "phase-2") {
  return { code, phase, path, message, remediation };
}

const PHASE_ONE_CODES = new Set([
  "MISSING_PATH_PREFIX",
  "MISSING_CLIENT_PACKAGE",
  "INVALID_CLIENT_PACKAGE",
  "MISSING_CLIENT_ENTRY",
  "MISSING_PRODUCT_MANIFEST",
  "INVALID_PRODUCT_MANIFEST",
  "INVALID_PRODUCT_ROLE",
  "PRODUCT_REPOSITORY_MISMATCH",
  "INCOMPLETE_PRODUCT_IDENTITY",
  "PRODUCT_CLIENT_NOT_ENABLED",
  "DEFAULT_BRANCH_NOT_MAIN",
]);

function readJson(path, label, blockers, child, code, publicPath) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    blockers.push(blocker(
      code,
      publicPath ?? prefixedPath(child, relative(child.__workdir, path)),
      `${label} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`,
      `修复 ${label} 后重新运行发布前预检。`,
    ));
    return undefined;
  }
}

export function validateChildInventory(children, waveOrder) {
  if (!Array.isArray(children) || children.length !== EXPECTED_DOWNSTREAM_COUNT) {
    throw new Error(`下游清单必须且只能包含 ${EXPECTED_DOWNSTREAM_COUNT} 个仓库，当前为 ${Array.isArray(children) ? children.length : 0}`);
  }
  const names = children.map((child) => child?.repo).filter(Boolean);
  if (names.length !== children.length || new Set(names).size !== names.length) {
    throw new Error("下游清单存在空仓库名或重复仓库；拒绝发布");
  }
  if (!Array.isArray(waveOrder) || waveOrder.length === 0 || new Set(waveOrder).size !== waveOrder.length) {
    throw new Error("child-repos.json 必须提供无重复的 uiRolloutWaveOrder");
  }
  for (const child of children) {
    if (!waveOrder.includes(child.uiRolloutWave)) {
      throw new Error(`${child.repo} 未登记有效 uiRolloutWave；拒绝无序 rollout`);
    }
  }
  return true;
}

export function validateRelease(manifest, packageJson, version) {
  if (!manifest.ui.latestStableVersion) throw new Error("base-capabilities.json 尚未登记 latestStableVersion");
  if (manifest.releasePolicy !== "base-first-stable-only") throw new Error("releasePolicy 必须为 base-first-stable-only");
  if (manifest.ui.latestStableVersion !== version) throw new Error(`稳定清单版本 ${manifest.ui.latestStableVersion} 与目标版本 ${version} 不一致`);
  if (packageJson.version !== version) throw new Error(`@workloom/ui 包版本 ${packageJson.version} 与目标版本 ${version} 不一致`);
  resolveStableFoundationVersion(manifest, version);
  return true;
}

/**
 * 只读盘点可以在首个稳定版尚未发布时针对当前候选版运行；它不授予发布或 rollout
 * 权限。rollout 仍只接受 latestStableVersion，并继续校验 registry 不可变制品。
 */
export function resolvePreflightTarget(manifest, packageJson, requestedVersion) {
  const version = requestedVersion
    ?? manifest.ui.candidateVersion
    ?? manifest.ui.latestStableVersion
    ?? packageJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`盘点目标必须是精确 semver，当前为 ${version ?? "未登记"}`);
  const allowed = new Set([manifest.ui.candidateVersion, manifest.ui.latestStableVersion, packageJson.version].filter(Boolean));
  if (!allowed.has(version)) throw new Error(`盘点目标 ${version} 未登记为候选版、稳定版或当前 UI 包版本`);
  const foundationAllowed = new Set([
    manifest.clientFoundation?.candidateVersion,
    manifest.clientFoundation?.latestStableVersion,
  ].filter(Boolean));
  if (!foundationAllowed.has(version)) throw new Error(`盘点目标 ${version} 未登记为三端客户端基座候选版或稳定版`);
  if (manifest.releasePolicy !== "base-first-stable-only") throw new Error("releasePolicy 必须为 base-first-stable-only");
  return {
    version,
    channel: version === manifest.ui.latestStableVersion ? "stable" : "candidate",
  };
}

/**
 * 检查一个已克隆行业仓是否完成发布前存量迁移。
 * 该函数只读；所有问题均保留机器可读 code/path，供 CI 和迁移台账消费。
 */
export function inspectMigratedConsumer(repoRoot, child, manifest) {
  const prefix = child.pathPrefix?.replace(/^\/+|\/+$/g, "") ?? "";
  const workdir = prefix ? join(repoRoot, prefix) : repoRoot;
  const context = { ...child, __workdir: workdir };
  const blockers = [];

  if (!existsSync(workdir)) {
    blockers.push(blocker(
      "MISSING_PATH_PREFIX",
      prefix || ".",
      `行业基座目录不存在：${prefix || "."}`,
      "先完成基座目录接入或修正 child-repos.json 的 pathPrefix。",
      "phase-1",
    ));
    return blockers;
  }

  for (const packagePath of manifest.ui.requiredClientPackages) {
    const absolutePackagePath = join(workdir, packagePath);
    if (!existsSync(absolutePackagePath)) {
      const clientName = packagePath.includes("apps/webb/") ? "B 端移动客户端" : packagePath.includes("apps/webc/") ? "C 端移动客户端" : "B 端 PC 客户端";
      blockers.push(blocker(
        "MISSING_CLIENT_PACKAGE",
        prefixedPath(child, packagePath),
        `缺少 ${clientName}：${packagePath}`,
        `先从基座迁移 ${packagePath.replace(/\/package\.json$/, "")} 生产客户端，再进入对应升级波次。`,
      ));
      continue;
    }
    readJson(absolutePackagePath, packagePath, blockers, context, "INVALID_CLIENT_PACKAGE");
    const entryPath = packagePath.replace(/package\.json$/, "src/main.tsx");
    if (!existsSync(join(workdir, entryPath))) {
      blockers.push(blocker(
        "MISSING_CLIENT_ENTRY",
        prefixedPath(child, entryPath),
        `客户端只有目录声明但缺少生产入口：${entryPath}`,
        "完成真实生产客户端迁移，禁止用空 package.json 占位绕过阶段一。",
      ));
    }
  }

  // 产品身份是 Git 仓根级受保护资产；即使 Tiger 的基座代码位于 governance/，
  // 也绝不能把安装包身份埋进 pathPrefix 或被基座同步覆盖。
  const productPath = join(repoRoot, "product.manifest.json");
  let product;
  if (!existsSync(productPath)) {
    blockers.push(blocker(
      "MISSING_PRODUCT_MANIFEST",
      "product.manifest.json",
      "缺少产品身份清单 product.manifest.json",
      "先登记独立 productId、release.appId、desktop.portOffset 与三端入口，禁止由基座覆盖行业身份。",
    ));
  } else {
    product = readJson(productPath, "product.manifest.json", blockers, context, "INVALID_PRODUCT_MANIFEST", "product.manifest.json");
  }
  if (product) {
    if (typeof product.role !== "string" || !product.role || product.role === "base") {
      blockers.push(blocker(
        "INVALID_PRODUCT_ROLE",
        "product.manifest.json",
        "行业仓 product.manifest.json 必须登记非 base 的产品角色",
        "按行业经营体、运营中枢或试验田角色登记产品身份。",
      ));
    }
    if (product.repository !== child.repo) {
      blockers.push(blocker(
        "PRODUCT_REPOSITORY_MISMATCH",
        "product.manifest.json",
        `产品清单 repository 应为 ${child.repo}，当前为 ${product.repository ?? "未登记"}`,
        "修正产品仓库身份，避免安装包和发布证据串仓。",
      ));
    }
    if (
      typeof product.productId !== "string"
      || !product.productId.trim()
      || typeof product.release?.appId !== "string"
      || !product.release.appId.trim()
      || product.release.appId === "com.workloom.im"
      || !Number.isInteger(product.desktop?.portOffset)
      || product.desktop.portOffset <= 0
    ) {
      blockers.push(blocker(
        "INCOMPLETE_PRODUCT_IDENTITY",
        "product.manifest.json",
        "行业仓必须登记独立 productId、非基座 release.appId 与正整数 desktop.portOffset",
        "完成安装包身份和本地端口隔离后再进入该仓 rollout 波次。",
      ));
    }
    for (const [key, entry] of Object.entries(PRODUCT_CLIENTS)) {
      const declared = product.clients?.[key];
      if (declared?.enabled !== true || declared?.entry !== entry) {
        blockers.push(blocker(
          "PRODUCT_CLIENT_NOT_ENABLED",
          "product.manifest.json",
          `产品清单必须启用 ${key} 并将入口登记为 ${entry}`,
          "补齐三个生产客户端的 enabled 与 entry，行业差异只通过 Bundle/投影表达。",
        ));
      }
    }
  }

  const statePath = join(workdir, ".workloom-ui.json");
  let state;
  if (!existsSync(statePath)) {
    blockers.push(blocker(
      "MISSING_UI_STATE",
      prefixedPath(child, ".workloom-ui.json"),
      "缺少共享 UI 消费状态 .workloom-ui.json",
      "先完成存量三端接入并登记精确稳定版本、三端清单与 upgrade-pr-only 策略。",
    ));
  } else {
    state = readJson(statePath, ".workloom-ui.json", blockers, context, "INVALID_UI_STATE");
  }
  if (state) {
    if (state.package !== manifest.ui.package) {
      blockers.push(blocker(
        "UI_PACKAGE_MISMATCH",
        prefixedPath(child, ".workloom-ui.json"),
        `共享 UI 包必须为 ${manifest.ui.package}，当前为 ${state.package ?? "未登记"}`,
        "改为消费基座发布的唯一共享 UI 包。",
      ));
    }
    if (state.updatePolicy !== "upgrade-pr-only") {
      blockers.push(blocker(
        "INVALID_UPDATE_POLICY",
        prefixedPath(child, ".workloom-ui.json"),
        `更新策略必须为 upgrade-pr-only，当前为 ${state.updatePolicy ?? "未登记"}`,
        "禁止自动直推 main；所有稳定升级必须经独立 PR。",
      ));
    }
    if (!/^\d+\.\d+\.\d+$/.test(state.version ?? "")) {
      blockers.push(blocker(
        "NON_STABLE_UI_VERSION",
        prefixedPath(child, ".workloom-ui.json"),
        `存量消费版本必须为精确稳定 semver，当前为 ${state.version ?? "未登记"}`,
        "先锁定已发布稳定版本，禁止 latest、范围、workspace 或候选版本。",
      ));
    }
    const required = new Set(state.requiredClientPackages ?? []);
    const connected = new Set(state.connectedClientPackages ?? []);
    for (const packagePath of manifest.ui.requiredClientPackages) {
      if (!required.has(packagePath) || !connected.has(packagePath)) {
        blockers.push(blocker(
          "UI_STATE_MISSING_CLIENT",
          prefixedPath(child, ".workloom-ui.json"),
          `共享 UI 状态未完整登记生产客户端 ${packagePath}`,
          "完成 B 端 PC、B 端移动、C 端移动三端迁移，并同时写入 requiredClientPackages 与 connectedClientPackages。",
        ));
      }
    }
  }

  // 结构齐备后再执行完整消费契约，避免只放空壳文件绕过发布门禁。
  if (state && manifest.ui.requiredClientPackages.every((path) => existsSync(join(workdir, path)))) {
    for (const message of verifyUiConsumerRepo(workdir)) {
      blockers.push(blocker(
        "UI_CONSUMER_CONTRACT_FAILED",
        prefix || ".",
        message,
        "按 @workloom/ui 三端消费契约完成迁移；禁止复制公共组件、令牌或视觉体系。",
      ));
    }
  }

  if (manifest.clientFoundation && existsSync(workdir)) {
    const foundation = inspectClientFoundationState({ repoRoot, targetRoot: workdir, manifest });
    for (const issue of foundation.issues.filter((item) => item.code !== "INVALID_PRODUCT_IDENTITY")) {
      blockers.push(blocker(
        issue.code,
        prefixedPath(child, issue.path),
        issue.message,
        issue.code === "MANAGED_FILE_MODIFIED"
          ? "把行业差异迁入 Bundle/theme/projection/config/extension 白名单路径，恢复旧基座文件后重试；禁止静默覆盖。"
          : "通过三端客户端基座稳定升级 PR 建立或修复逐文件指纹；不得手工标记完成。",
      ));
    }
  }

  const seen = new Set();
  return blockers.map((item) => ({
    ...item,
    phase: PHASE_ONE_CODES.has(item.code) ? "phase-1" : item.phase,
  })).filter((item) => {
    const key = `${item.code}\0${item.path}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneChildReadOnly(child, target, token) {
  run("git", ["clone", "--depth", "1", "--no-tags", repositoryUrl(child.repo), target], baseDir, githubGitEnvironment(token));
}

export function preflightChildren({ children, waveOrder, manifest, version, targetChannel = "stable", token = "", cloneChild = cloneChildReadOnly }) {
  validateChildInventory(children, waveOrder);
  const repositories = [];
  for (const child of children) {
    const temp = mkdtempSync(join(tmpdir(), "workloom-ui-preflight-"));
    try {
      cloneChild(child, temp, token);
      const defaultBranch = run("git", ["branch", "--show-current"], temp);
      const headSha = run("git", ["rev-parse", "HEAD"], temp);
      const blockers = inspectMigratedConsumer(temp, child, manifest);
      if (defaultBranch !== "main") {
        blockers.push(blocker(
          "DEFAULT_BRANCH_NOT_MAIN",
          ".git/HEAD",
          `默认分支为 ${defaultBranch || "未知"}，升级 PR 的受保护基线要求 main`,
          "统一默认分支或在发布治理中显式迁移后再重试。",
          "phase-1",
        ));
      }
      const stageOneBlockers = blockers.filter((item) => item.phase === "phase-1");
      const phaseTwoBlockers = blockers.filter((item) => item.phase === "phase-2");
      const workdir = child.pathPrefix ? join(temp, child.pathPrefix.replace(/\/$/, "")) : temp;
      let currentVersion = null;
      let currentFoundationVersion = null;
      try {
        currentVersion = JSON.parse(readFileSync(join(workdir, ".workloom-ui.json"), "utf8")).version ?? null;
      } catch {
        // 缺失/损坏已由 inspectMigratedConsumer 给出结构化 blocker。
      }
      try {
        currentFoundationVersion = JSON.parse(readFileSync(join(workdir, manifest.clientFoundation.stateFile), "utf8")).version ?? null;
      } catch {
        // 缺失/损坏已由 inspectMigratedConsumer 给出结构化 blocker。
      }
      const stageOneReady = stageOneBlockers.length === 0;
      const targetVersionApplied = stageOneReady
        && phaseTwoBlockers.length === 0
        && currentVersion === version
        && currentFoundationVersion === version;
      repositories.push({
        repo: child.repo,
        pathPrefix: child.pathPrefix || ".",
        wave: child.uiRolloutWave,
        headSha,
        accessStatus: "accessible",
        migrationStatus: targetVersionApplied ? "current" : stageOneReady ? "phase-2-upgrade-required" : "phase-1-blocked",
        stageOneReady,
        targetVersionApplied,
        currentVersion,
        currentFoundationVersion,
        status: targetVersionApplied ? "current" : stageOneReady ? "upgrade-ready" : "migration-blocked",
        blockers,
      });
    } catch (error) {
      repositories.push({
        repo: child.repo,
        pathPrefix: child.pathPrefix || ".",
        wave: child.uiRolloutWave,
        accessStatus: "unreachable",
        migrationStatus: "unknown",
        stageOneReady: false,
        targetVersionApplied: false,
        currentVersion: null,
        currentFoundationVersion: null,
        status: "unreachable",
        blockers: [blocker(
          "CLONE_FAILED",
          ".",
          `只读克隆失败：${String(error?.message ?? error).split("\n")[0].slice(0, 500)}`,
          "检查仓库可访问性和 SYNC_TOKEN 只读权限后重试；不得跳过该仓发布。",
          "access",
        )],
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const accessibleCount = repositories.filter((item) => item.accessStatus === "accessible").length;
  const stageOneReadyCount = repositories.filter((item) => item.stageOneReady).length;
  const currentCount = repositories.filter((item) => item.targetVersionApplied).length;
  const unreachableCount = repositories.length - accessibleCount;
  return {
    schemaVersion: "workloom.ui-downstream-preflight/v1",
    phase: "pre-publish",
    generatedAt: new Date().toISOString(),
    baseRepository: manifest.baseRepository,
    targetVersion: version,
    targetChannel,
    targetArtifacts: {
      sharedUi: `${manifest.ui.package}@${version}`,
      clientFoundation: `ui-v${version}`,
      clientFoundationDistribution: manifest.clientFoundation.distribution,
    },
    requiredRepositoryCount: EXPECTED_DOWNSTREAM_COUNT,
    waveOrder,
    // ready/baseReleaseReady 只表达“基座可发布”，绝不把存量迁移完成度混进稳定制品门禁。
    ready: accessibleCount === EXPECTED_DOWNSTREAM_COUNT,
    baseReleaseReady: accessibleCount === EXPECTED_DOWNSTREAM_COUNT,
    allMigrationsCurrent: currentCount === EXPECTED_DOWNSTREAM_COUNT,
    summary: {
      accessible: accessibleCount,
      unreachable: unreachableCount,
      stageOneReady: stageOneReadyCount,
      phaseOneBlocked: EXPECTED_DOWNSTREAM_COUNT - stageOneReadyCount - unreachableCount,
      current: currentCount,
    },
    repositories,
  };
}

function waveIndex(waveOrder, wave) {
  return waveOrder.indexOf(wave);
}

/**
 * 选择本次 rollout 波次。默认只选择最早尚未完成的波次；显式 wave/仓白名单
 * 也不能越过未完成的更早波次，因此优先级顺序是可执行约束，而不是文档建议。
 */
export function selectRolloutBatch({ children, waveOrder, repositories, wave, repositoryWhitelist = [] }) {
  const states = new Map(repositories.map((item) => [item.repo, item]));
  const incompleteWaves = waveOrder.filter((candidate) => children
    .filter((child) => child.uiRolloutWave === candidate)
    .some((child) => !states.get(child.repo)?.targetVersionApplied));
  const earliestIncomplete = incompleteWaves[0] ?? null;

  let selectedWave = wave;
  let mode = "explicit-wave";
  if (repositoryWhitelist.length) {
    const unknown = repositoryWhitelist.filter((repo) => !children.some((child) => child.repo === repo));
    if (unknown.length) throw new Error(`仓白名单包含未知仓库：${unknown.join("、")}`);
    const waves = [...new Set(children.filter((child) => repositoryWhitelist.includes(child.repo)).map((child) => child.uiRolloutWave))];
    if (waves.length !== 1) throw new Error("单次仓白名单只能属于同一 rollout 波次");
    if (wave && wave !== waves[0]) throw new Error(`--wave ${wave} 与仓白名单所属波次 ${waves[0]} 不一致`);
    selectedWave = waves[0];
    mode = "repository-whitelist";
  } else if (!selectedWave) {
    selectedWave = earliestIncomplete;
    mode = "next-in-order";
  }

  if (selectedWave && !waveOrder.includes(selectedWave)) throw new Error(`未知 rollout 波次：${selectedWave}`);
  const blockedByEarlierWave = Boolean(
    selectedWave
    && earliestIncomplete
    && waveIndex(waveOrder, selectedWave) > waveIndex(waveOrder, earliestIncomplete),
  );
  const selected = selectedWave
    ? children.filter((child) => child.uiRolloutWave === selectedWave && (!repositoryWhitelist.length || repositoryWhitelist.includes(child.repo)))
    : [];
  return { mode, selectedWave, earliestIncomplete, blockedByEarlierWave, selected };
}

export function canCreateUpgradePr(repositoryState) {
  return repositoryState?.accessStatus === "accessible"
    && repositoryState.stageOneReady === true
    && repositoryState.targetVersionApplied !== true;
}

const ROLLOUT_FAILURE_STATUSES = new Set(["failed", "blocked-phase-1", "blocked-by-earlier-wave"]);

export function rolloutHasFailure(results) {
  return results.some((result) => ROLLOUT_FAILURE_STATUSES.has(result.status));
}

export function assertIndependentUpgradeBranch(branch) {
  if (!/^chore\/workloom-ui-v\d+\.\d+\.\d+$/.test(branch) || branch === "main") {
    throw new Error(`非法升级分支 ${branch}；rollout 只能写入独立 chore/workloom-ui-v* 分支`);
  }
  return true;
}

export function buildUpgradePullRequestBody(version) {
  return [
    "此 PR 由 WorkLoom IM 基座稳定版本发布流程创建。",
    "",
    `- 共享 UI：\`@workloom/ui@${version}\`（精确稳定版本）`,
    `- 客户端基座：\`ui-v${version}\`（同一不可变稳定标签）`,
    "- 更新范围：B 端 PC、B 端移动、C 端移动的应用壳、导航、布局、状态与 API 接线（缺一不可）",
    "- 冲突保护：逐文件比对上一稳定版 SHA-256，行业改动不静默覆盖",
    "- 行业差异：仅保留 Bundle、主题白名单、投影、配置和 extension 路径",
    "",
    "合并前必须由 `workloom-ui-contract` 工作流实际通过：",
    "- 共享 UI 消费契约与三端客户端基座指纹门禁",
    "- 三端逐一 typecheck 与生产 build",
    "- 仓库现有 pnpm 测试；仓根存在 Python 测试时同时运行 pytest",
    "- Playwright 对三端生产预览的基础主入口、首帧及稳定帧横向溢出冒烟",
    "",
    "本流程从不直推 main，也禁止复制公共组件或在受管客户端文件中硬编码行业差异。",
  ].join("\n");
}

export function renderConsumerWorkflow(pathPrefix = "") {
  if (typeof pathPrefix !== "string" || pathPrefix.includes("\\") || pathPrefix.startsWith("/")) {
    throw new Error(`非法消费仓 pathPrefix：${String(pathPrefix)}`);
  }
  const parts = pathPrefix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || !/^[-A-Za-z0-9_.]+$/.test(part))) {
    throw new Error(`非法消费仓 pathPrefix：${pathPrefix}`);
  }
  const repoDir = parts.join("/") || ".";
  return readFileSync(join(syncDir, "ui-consumer-template.yml"), "utf8").replaceAll("__REPO_DIR__", repoDir);
}

async function createPullRequest({ repo, token, branch, version }) {
  assertIndependentUpgradeBranch(branch);
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `chore(base): 升级 WorkLoom 三端客户端基座至 ${version}`,
      head: branch,
      base: "main",
      body: buildUpgradePullRequestBody(version),
    }),
  });
  if (response.ok) return response.json();
  const detail = await response.text();
  // 422 通常代表相同 head/base 的 PR 已存在；保持幂等并交给现有 PR 继续验证。
  if (response.status === 422 && detail.includes("already exists")) return { html_url: "已存在" };
  throw new Error(`创建 PR 失败 ${response.status}: ${detail.slice(0, 500)}`);
}

function verifyPublishedArtifact(manifest, version) {
  const published = JSON.parse(run("npm", ["view", `${manifest.ui.package}@${version}`, "version", "--json"], baseDir));
  if (published !== version) throw new Error(`registry 尚未确认 ${manifest.ui.package}@${version}，拒绝提前 rollout`);
}

async function upgradeChild(child, manifest, version, token, dryRun, foundationSnapshot) {
  const temp = mkdtempSync(join(tmpdir(), "workloom-ui-upgrade-"));
  const branch = `chore/workloom-ui-v${version}`;
  assertIndependentUpgradeBranch(branch);
  try {
    cloneChildReadOnly(child, temp, token);
    run("git", ["switch", "-c", branch], temp);
    const workdir = child.pathPrefix ? join(temp, child.pathPrefix.replace(/\/$/, "")) : temp;
    const foundation = applyClientFoundation({
      repoRoot: temp,
      targetRoot: workdir,
      manifest,
      snapshot: foundationSnapshot,
      mode: existsSync(join(workdir, manifest.clientFoundation.stateFile)) ? "upgrade" : "scaffold",
      // 即使 rollout 本身是 dry-run，也只在即将销毁的临时 clone 中应用，借此运行
      // 后续真实 lockfile/消费门禁；远端仓和分支始终零写入。
      dryRun: false,
    });
    const touched = setUiVersion({
      repo: temp,
      prefix: child.pathPrefix?.replace(/\/$/, "") ?? "",
      version,
      manifest,
      requireAll: true,
    });
    mkdirSync(join(temp, ".github/workflows"), { recursive: true });
    mkdirSync(join(workdir, "scripts"), { recursive: true });
    const workflow = renderConsumerWorkflow(child.pathPrefix);
    writeFileSync(join(temp, ".github/workflows/workloom-ui-contract.yml"), workflow);
    // 门禁脚本属于消费契约，不是可分叉的 UI 源码；随升级 PR 一并落到行业仓。
    copyFileSync(join(baseDir, "scripts/verify-ui-consumer.mjs"), join(workdir, "scripts/verify-ui-consumer.mjs"));
    copyFileSync(
      join(baseDir, "scripts/verify-client-foundation-consumer.mjs"),
      join(workdir, "scripts/verify-client-foundation-consumer.mjs"),
    );
    // apps/web 的生产 build 会执行这道文案边界；升级 PR 必须自带与稳定
    // 客户端壳同源的验证器，不能假设某次独立 base-sync 已经先落地。
    copyFileSync(
      join(baseDir, "scripts/verify-production-client-boundary.mjs"),
      join(workdir, "scripts/verify-production-client-boundary.mjs"),
    );
    run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], workdir);
    run("node", [join(workdir, "scripts/verify-ui-consumer.mjs"), "--repo", workdir], workdir);
    run("node", [join(workdir, "scripts/verify-client-foundation-consumer.mjs"), "--repo", workdir], workdir);
    const status = run("git", ["status", "--porcelain"], temp);
    const foundationTouched = foundation.filesTouched ?? [];
    if (!status) return { repo: child.repo, status: "already-current", touched, foundationTouched };
    if (dryRun) return { repo: child.repo, status: "planned", touched, foundationTouched };
    run("git", ["add", "-A"], temp);
    run("git", ["-c", "user.name=WorkLoom Base Release", "-c", "user.email=base-release@workloom.im", "commit", "-m", `chore(base): 升级三端客户端基座至 ${version}`], temp);
    const remoteHead = run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], temp, githubGitEnvironment(token)).split(/\s+/)[0] || "";
    const lease = remoteHead ? `--force-with-lease=refs/heads/${branch}:${remoteHead}` : "--force-with-lease";
    run("git", ["push", lease, "origin", `HEAD:refs/heads/${branch}`], temp, githubGitEnvironment(token));
    const pull = await createPullRequest({ repo: child.repo, token, branch, version });
    return { repo: child.repo, status: "pr-opened", url: pull.html_url, touched, foundationTouched };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function emitReport(report, reportPath) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), output);
  process.stdout.write(output);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(syncDir, "base-capabilities.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(baseDir, "packages/ui/package.json"), "utf8"));
  const childManifest = JSON.parse(readFileSync(join(syncDir, "child-repos.json"), "utf8"));
  const children = childManifest.children;
  const waveOrder = childManifest.uiRolloutWaveOrder;
  validateChildInventory(children, waveOrder);
  const token = process.env.SYNC_TOKEN || process.env.GH_TOKEN || "";

  const target = options.mode === "preflight"
    ? resolvePreflightTarget(manifest, packageJson, options.requestedVersion)
    : { version: resolveUiVersion(manifest, options.requestedVersion), channel: "stable" };
  const version = target.version;
  if (options.mode === "rollout") validateRelease(manifest, packageJson, version);

  const preflight = preflightChildren({ children, waveOrder, manifest, version, targetChannel: target.channel, token });
  if (options.mode === "preflight") {
    emitReport(preflight, options.reportPath);
    if (!preflight.baseReleaseReady) process.exitCode = 1;
    return;
  }

  if (!preflight.baseReleaseReady) {
    emitReport({ ...preflight, phase: "rollout-precheck" }, options.reportPath);
    process.exitCode = 1;
    return;
  }
  if (!options.dryRun && !token) throw new Error("缺少 SYNC_TOKEN/GH_TOKEN；拒绝创建无法审计的半成品分支");
  if (!options.dryRun) verifyPublishedArtifact(manifest, version);
  const foundationSnapshot = loadStableFoundationSnapshot(baseDir, manifest, version);

  const batch = selectRolloutBatch({
    children,
    waveOrder,
    repositories: preflight.repositories,
    wave: options.wave,
    repositoryWhitelist: options.repositories,
  });
  const results = [];
  if (batch.blockedByEarlierWave) {
    results.push({
      status: "blocked-by-earlier-wave",
      wave: batch.selectedWave,
      blockers: [blocker(
        "EARLIER_WAVE_INCOMPLETE",
        "sync/child-repos.json",
        `波次 ${batch.selectedWave} 不能越过尚未完成的 ${batch.earliestIncomplete}`,
        `先完成并合并 ${batch.earliestIncomplete} 的全部升级 PR，再启动 ${batch.selectedWave}。`,
        "wave-order",
      )],
    });
  }
  for (const child of batch.blockedByEarlierWave ? [] : batch.selected) {
    const state = preflight.repositories.find((item) => item.repo === child.repo);
    if (state?.targetVersionApplied) {
      results.push({ repo: child.repo, wave: child.uiRolloutWave, status: "already-current", touched: [] });
      continue;
    }
    if (!canCreateUpgradePr(state)) {
      results.push({
        repo: child.repo,
        wave: child.uiRolloutWave,
        status: "blocked-phase-1",
        blockers: state?.blockers.filter((item) => item.phase === "phase-1") ?? [],
      });
      continue;
    }
    try {
      results.push({
        ...(await upgradeChild(child, manifest, version, token, options.dryRun, foundationSnapshot)),
        wave: child.uiRolloutWave,
      });
    } catch (error) {
      results.push({
        repo: child.repo,
        wave: child.uiRolloutWave,
        status: "failed",
        blockers: [blocker(
          "UPGRADE_PR_FAILED",
          child.pathPrefix || ".",
          String(error?.message ?? error).split("\n")[0].slice(0, 500),
          "修复该仓第二阶段消费契约或远端 PR 权限后，在同一波次幂等重试。",
          "phase-2",
        )],
      });
    }
  }
  const selectedNames = new Set((batch.blockedByEarlierWave ? [] : batch.selected).map((child) => child.repo));
  for (const child of children.filter((item) => !selectedNames.has(item.repo))) {
    const state = preflight.repositories.find((item) => item.repo === child.repo);
    results.push({
      repo: child.repo,
      wave: child.uiRolloutWave,
      status: state?.targetVersionApplied ? "already-current" : "deferred-wave",
      blockers: state?.targetVersionApplied ? [] : [blocker(
        "DEFERRED_BY_WAVE",
        "sync/child-repos.json",
        `本次只处理 ${batch.selectedWave ?? "无待处理波次"}，${child.repo} 保留在 ${child.uiRolloutWave}`,
        "按 uiRolloutWaveOrder 完成前序波次后再运行；不得标记为已同步。",
        "wave-order",
      )],
    });
  }
  const report = {
    schemaVersion: "workloom.ui-rollout/v1",
    phase: options.dryRun ? "rollout-dry-run" : "post-publish-rollout",
    generatedAt: new Date().toISOString(),
    baseRepository: manifest.baseRepository,
    targetVersion: version,
    targetArtifacts: {
      sharedUi: `${manifest.ui.package}@${version}`,
      clientFoundation: `ui-v${version}`,
    },
    directMainPush: false,
    selection: {
      mode: batch.mode,
      selectedWave: batch.selectedWave,
      earliestIncompleteWave: batch.earliestIncomplete,
      requestedRepositories: options.repositories,
      blockedByEarlierWave: batch.blockedByEarlierWave,
    },
    actionRequired: results.some((result) => ["blocked-phase-1", "failed", "blocked-by-earlier-wave", "deferred-wave"].includes(result.status)),
    results,
  };
  emitReport(report, options.reportPath);
  if (rolloutHasFailure(results)) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
