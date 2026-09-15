#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const syncDir = dirname(fileURLToPath(import.meta.url));

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

export function setUiVersion({ repo, prefix = "", version, manifest, requireAll = true }) {
  const workdir = prefix ? join(repo, prefix) : repo;
  const existing = manifest.ui.requiredClientPackages.filter((relativePath) => existsSync(join(workdir, relativePath)));
  if (existing.length === 0) {
    throw new Error(`未在 ${workdir} 找到任何三端 package.json；不得创建缺少生产客户端的行业版本。`);
  }
  if (requireAll && existing.length !== manifest.ui.requiredClientPackages.length) {
    const missing = manifest.ui.requiredClientPackages.filter((item) => !existing.includes(item));
    throw new Error(`新行业必须具备 B端PC、B端移动、C端移动三个生产客户端；缺少：${missing.join("、")}`);
  }
  const touched = [];
  for (const relativePath of existing) {
    const packagePath = join(workdir, relativePath);
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.dependencies ??= {};
    packageJson.dependencies[manifest.ui.package] = version;
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    touched.push(relativePath);
  }
  writeFileSync(join(workdir, ".workloom-ui.json"), `${JSON.stringify({
    package: manifest.ui.package,
    version,
    contractVersion: manifest.ui.contractVersion,
    source: manifest.baseRepository,
    updatePolicy: "upgrade-pr-only",
    releaseChannel: "stable",
    allowedIndustryOverrides: manifest.ui.allowedIndustryOverrides,
    requiredClientPackages: manifest.ui.requiredClientPackages,
    connectedClientPackages: touched,
  }, null, 2)}\n`);
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
