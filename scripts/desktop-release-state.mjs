import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

export function parseStableTag(tag) {
  const match = STABLE_TAG.exec(String(tag ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function assertCompleteReleaseList(releases, limit = 1000) {
  if (!Array.isArray(releases) || releases.length >= limit) {
    throw new Error("Release 列表可能被截断，无法证明全局状态");
  }
  return releases;
}

function isPublicStable(release) {
  return release?.isDraft === false
    && release?.isPrerelease === false
    && parseStableTag(release?.tagName) !== null;
}

export function highestPublicStableTag(releases, excludedTag = "") {
  assertCompleteReleaseList(releases);
  const candidates = releases.filter((release) => release?.tagName !== excludedTag && isPublicStable(release));
  if (candidates.length === 0) return "";
  return candidates.reduce((highest, candidate) => (
    compareVersions(parseStableTag(highest.tagName), parseStableTag(candidate.tagName)) >= 0
      ? highest
      : candidate
  )).tagName;
}

export function selectRestoreLatestTag(releases, targetTag) {
  const stableFallback = highestPublicStableTag(releases, targetTag);
  return stableFallback || "";
}

export function assertQuarantinedState(releases, targetTag, expectedLatestTag = "") {
  assertCompleteReleaseList(releases);
  const target = releases.filter((release) => release?.tagName === targetTag);
  const latest = releases.filter((release) => release?.isLatest === true);
  if (target.length !== 1 || target[0].isDraft !== true || target[0].isLatest === true) {
    throw new Error("隔离后目标必须是非 latest 草稿");
  }
  if (latest.length > 1) throw new Error("隔离后 latest 不唯一");
  if (expectedLatestTag && (latest.length !== 1 || latest[0].tagName !== expectedLatestTag)) {
    throw new Error("隔离后未恢复最高健康桌面稳定版");
  }
  if (!expectedLatestTag && latest.some((release) => release.tagName === targetTag)) {
    throw new Error("隔离后目标仍是 latest");
  }
}

export function classifyReleaseAssets(release, tag, expectedNames) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const names = assets.map((asset) => asset?.name);
  const managed = release?.name === `WorkLoom Desktop ${tag}`
    || names.includes("WorkLoom-release-manifest.json");
  const invalid = names.length !== expectedNames.length
    || expectedNames.some((name) => names.filter((candidate) => candidate === name).length !== 1)
    || assets.some((asset) => asset?.state !== "uploaded" || !(Number(asset?.size) > 0));
  if (!invalid) return "healthy";
  return managed ? "managed-corrupt" : "legacy-incompatible";
}

export function assertImmutablePublicRelease(release, tag, expectedNames) {
  if (release?.tagName !== tag || release?.isDraft !== false || release?.isPrerelease !== false) {
    throw new Error("公开 Release 状态不正确");
  }
  if (release?.isImmutable !== true) {
    throw new Error("公开 Release 未进入 GitHub 不可变状态");
  }
  if (classifyReleaseAssets(release, tag, expectedNames) !== "healthy") {
    throw new Error("公开 Release 资产集、状态或大小不正确");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const [command, jsonPath, ...args] = argv;
  const json = readJson(jsonPath);
  if (command === "assert-list") {
    assertCompleteReleaseList(json);
    return;
  }
  if (command === "select-restore") {
    process.stdout.write(selectRestoreLatestTag(json, args[0]));
    return;
  }
  if (command === "assert-quarantine") {
    assertQuarantinedState(json, args[0], args[1] ?? "");
    return;
  }
  if (command === "classify-assets") {
    process.stdout.write(classifyReleaseAssets(json, args[0], args.slice(1)));
    return;
  }
  if (command === "assert-public") {
    assertImmutablePublicRelease(json, args[0], args.slice(1));
    return;
  }
  throw new Error(`未知 desktop release state 命令：${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
