#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const syncDir = dirname(fileURLToPath(import.meta.url));
const CANONICAL_BASE_REPOSITORY = "workloom-ai/workloom-im";
const UI_PACKAGE = "@workloom/ui";
// 兼容字段：本枚举名沿用历史值（含各仓 state 与 capabilities），按显式 platform 绑定 GitHub 主制品或 legacy CNB 制品。
const DISTRIBUTION_TYPE = "github-release-tarball";
const GITHUB_BASE_REPOSITORY = "geniusdapeng-collab/workloom-im";
const RELEASES = Object.freeze({
  github: { host: "github.com", repository: GITHUB_BASE_REPOSITORY, prefix: "releases/download" },
  cnb: { host: "cnb.cool", repository: CANONICAL_BASE_REPOSITORY, prefix: "-/releases/download" },
});
const RELEASE_ASSET_NAME_TEMPLATE = "workloom-ui-{version}.tgz";
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    repo: resolve(value("--repo") ?? "."),
    prefix: value("--path-prefix")?.replace(/^\/+|\/+$/g, "") ?? "",
    version: value("--version"),
    allowCandidate: argv.includes("--allow-candidate"),
    // 新行业接入默认必须一次具备三端。存量仓的分步迁移由发布前迁移流程负责，
    // 不能通过普通接入命令把缺端状态标记为已完成。
    requireAll: true,
  };
}

export function resolveUiVersion(manifest, explicitVersion, allowCandidate = false) {
  const stable = manifest.ui.latestStableVersion;
  if (stable) {
    if (!explicitVersion || explicitVersion === stable) return stable;
    if (allowCandidate && explicitVersion === manifest.ui.candidateVersion) return explicitVersion;
    throw new Error(`新行业默认只能接入 latestStableVersion=${stable}；目标 ${explicitVersion} 不是当前稳定版`);
  }
  if (allowCandidate && (!explicitVersion || explicitVersion === manifest.ui.candidateVersion) && manifest.ui.candidateVersion) {
    return manifest.ui.candidateVersion;
  }
  throw new Error("基座尚未发布稳定 UI 版本；新行业接入已被阻断。请先完成 WorkLoom IM 基座门禁并发布 ui-v* 稳定版本。");
}

function validSha512(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

/**
 * 把受控 manifest 解析为唯一、公开且不可凭配置改指向其他仓库的 GitHub Release
 * 制品。下游 package 仍声明精确 semver，pnpm override 只负责把该版本解析到此 URL。
 */
export function resolveUiReleaseArtifact(manifest, version) {
  if (!EXACT_SEMVER.test(version ?? "")) {
    throw new Error(`UI Release 制品版本必须是精确稳定 semver，当前为 ${version ?? "未登记"}`);
  }
  if (![CANONICAL_BASE_REPOSITORY, GITHUB_BASE_REPOSITORY].includes(manifest?.baseRepository)) {
    throw new Error(`UI Release 制品仓库必须为 ${CANONICAL_BASE_REPOSITORY}`);
  }
  if (manifest?.ui?.package !== UI_PACKAGE) {
    throw new Error(`UI Release 制品包名必须为 ${UI_PACKAGE}`);
  }
  const distribution = manifest.ui.distribution;
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
    throw new Error("ui.distribution 必须是受控 GitHub Release tarball 契约");
  }
  if (distribution.type !== DISTRIBUTION_TYPE) {
    throw new Error(`ui.distribution.type 必须为 ${DISTRIBUTION_TYPE}`);
  }
  const platform = distribution.platform ?? (manifest.baseRepository === CANONICAL_BASE_REPOSITORY ? "cnb" : "github");
  const release = RELEASES[platform];
  const expectedTemplate = release && `https://${release.host}/${release.repository}/${release.prefix}/ui-v{version}/workloom-ui-{version}.tgz`;
  if (!release || distribution.urlTemplate !== expectedTemplate) {
    throw new Error("ui.distribution.urlTemplate 必须固定到 WorkLoom IM 官方 GitHub Release");
  }
  if (distribution.assetNameTemplate !== RELEASE_ASSET_NAME_TEMPLATE) {
    throw new Error(`ui.distribution.assetNameTemplate 必须为 ${RELEASE_ASSET_NAME_TEMPLATE}`);
  }
  const integrityByVersion = distribution.integrityByVersion;
  if (!integrityByVersion || typeof integrityByVersion !== "object" || Array.isArray(integrityByVersion)) {
    throw new Error("ui.distribution.integrityByVersion 必须按稳定版本登记 SHA-512");
  }
  for (const [registeredVersion, integrity] of Object.entries(integrityByVersion)) {
    if (!EXACT_SEMVER.test(registeredVersion) || !validSha512(integrity)) {
      throw new Error(`ui.distribution.integrityByVersion 含无效登记：${registeredVersion}`);
    }
  }
  const sha512 = integrityByVersion[version];
  if (!validSha512(sha512)) {
    throw new Error(`UI Release 制品 ${version} 缺少有效 SHA-512 登记`);
  }
  const assetName = distribution.assetNameTemplate.replaceAll("{version}", version);
  const url = distribution.urlTemplate.replaceAll("{version}", version);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`UI Release 制品 URL 无效：${url}`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== release.host
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== `/${release.repository}/${release.prefix}/ui-v${version}/${assetName}`
    || url !== parsed.href
  ) {
    throw new Error("UI Release 制品 URL 必须是官方仓库、HTTPS、同版本标签与同版本 tarball");
  }
  return {
    type: DISTRIBUTION_TYPE,
    ...(distribution.platform ? { platform } : {}),
    assetName,
    url,
    sha512,
    overrideSelector: `${UI_PACKAGE}@${version}`,
  };
}

function parseJsonObject(path, label) {
  if (!existsSync(path)) throw new Error(`缺少 ${label}：${path}`);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 顶层必须是 JSON 对象`);
  return value;
}

function isUiOverrideSelector(selector, packageName) {
  const leaf = String(selector).split(">").at(-1);
  return leaf === packageName || leaf.startsWith(`${packageName}@`);
}

export function setUiVersion({ repo, prefix = "", version, manifest, requireAll = true }) {
  const workdir = prefix ? join(repo, prefix) : repo;
  const artifact = resolveUiReleaseArtifact(manifest, version);
  const existing = manifest.ui.requiredClientPackages.filter((relativePath) => existsSync(join(workdir, relativePath)));
  if (existing.length === 0) {
    throw new Error(`未在 ${workdir} 找到任何三端 package.json；不得创建缺少生产客户端的行业版本。`);
  }
  if (requireAll && existing.length !== manifest.ui.requiredClientPackages.length) {
    const missing = manifest.ui.requiredClientPackages.filter((item) => !existing.includes(item));
    throw new Error(`新行业必须具备 B端PC、B端移动、C端移动三个生产客户端；缺少：${missing.join("、")}`);
  }
  const pendingWrites = new Map();
  const touched = [];
  for (const relativePath of existing) {
    const packagePath = join(workdir, relativePath);
    const packageJson = parseJsonObject(packagePath, relativePath);
    if (packageJson.dependencies !== undefined && (!packageJson.dependencies || typeof packageJson.dependencies !== "object" || Array.isArray(packageJson.dependencies))) {
      throw new Error(`${relativePath} dependencies 必须是 JSON 对象`);
    }
    packageJson.dependencies ??= {};
    packageJson.dependencies[manifest.ui.package] = version;
    pendingWrites.set(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    touched.push(relativePath);
  }

  const rootPackagePath = join(workdir, "package.json");
  const rootPackage = parseJsonObject(rootPackagePath, "行业基座根 package.json");
  if (rootPackage.pnpm !== undefined && (!rootPackage.pnpm || typeof rootPackage.pnpm !== "object" || Array.isArray(rootPackage.pnpm))) {
    throw new Error("行业基座根 package.json 的 pnpm 必须是 JSON 对象");
  }
  rootPackage.pnpm ??= {};
  if (rootPackage.pnpm.overrides !== undefined && (!rootPackage.pnpm.overrides || typeof rootPackage.pnpm.overrides !== "object" || Array.isArray(rootPackage.pnpm.overrides))) {
    throw new Error("行业基座根 package.json 的 pnpm.overrides 必须是 JSON 对象");
  }
  rootPackage.pnpm.overrides ??= {};
  for (const selector of Object.keys(rootPackage.pnpm.overrides)) {
    if (isUiOverrideSelector(selector, manifest.ui.package)) delete rootPackage.pnpm.overrides[selector];
  }
  rootPackage.pnpm.overrides[artifact.overrideSelector] = artifact.url;
  pendingWrites.set(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

  pendingWrites.set(join(workdir, ".workloom-ui.json"), `${JSON.stringify({
    schemaVersion: "workloom.ui-consumer-state/v1",
    package: manifest.ui.package,
    version,
    contractVersion: manifest.ui.contractVersion,
    source: manifest.baseRepository,
    updatePolicy: "upgrade-pr-only",
    releaseChannel: "stable",
    allowedIndustryOverrides: manifest.ui.allowedIndustryOverrides,
    requiredClientPackages: manifest.ui.requiredClientPackages,
    connectedClientPackages: touched,
    artifact: {
      type: artifact.type,
      ...(artifact.platform ? { platform: artifact.platform } : {}),
      assetName: artifact.assetName,
      url: artifact.url,
      sha512: artifact.sha512,
    },
  }, null, 2)}\n`);
  for (const [path, content] of pendingWrites) writeFileSync(path, content);
  return touched;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(syncDir, "base-capabilities.json"), "utf8"));
  const version = resolveUiVersion(manifest, options.version, options.allowCandidate);
  const touched = setUiVersion({ ...options, version, manifest });
  console.log(`✅ 已锁定 ${manifest.ui.package}@${version}：${touched.join("、")}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
