#!/usr/bin/env node
import {
  createHash, createPrivateKey, createPublicKey, sign as signValue,
  timingSafeEqual, verify as verifyValue,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  assertBundleCompatibility,
  canonicalBundleArtifactPayload,
  formatContractError,
  parseBundleManifest,
  type BundleManifest,
} from "../packages/industry-contract/src/index.ts";
import { BASE_NAVIGATION, NAVIGATION_GROUP_ORDER, type IconName } from "../packages/ui/src/navigation.ts";

const root = resolve(import.meta.dirname, "..");
const bundlesRoot = resolve(process.env.BUNDLES_ROOT ?? join(root, "bundles"));
const args = new Set(process.argv.slice(2));
const refreshDigests = args.has("--refresh-digests");
const releaseMode = args.has("--release");
const baseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const uiVersion = JSON.parse(readFileSync(join(root, "packages/ui/package.json"), "utf8")).version as string;
const iconNames = new Set<IconName>([
  "home", "tasks", "report", "service", "approval", "ledger", "rules", "exam", "memory", "night",
  "model", "skills", "team", "workspace", "inbox", "account", "partner", "more", "executive", "customize",
  "configuration", "assembly", "agents", "developer", "menu", "close", "reset", "search", "notice", "chevron",
  "chat", "ticket", "star", "history",
]);
const baseCapabilityIds = new Set(BASE_NAVIGATION.map((entry) => entry.capabilityId));
const baseRoutes = new Set(BASE_NAVIGATION.flatMap((entry) => [entry.route, ...(entry.legacyRoutes ?? [])]));
const baseWidgetComponents = new Set(["QuickTaskList"]);
const errors: string[] = [];
// 公钥环是独立信任根，严禁与可替换的 bundles/ 制品同目录。
// 桌面构建把此文件作为独立、受应用签名保护的 extraResource 分发；托管部署也可直接注入公钥环。
const trustFile = resolve(process.env.BUNDLE_TRUST_OUTPUT ?? join(root, "build", "bundle-trust.json"));
const trustRelativeToBundles = relative(bundlesRoot, trustFile);
if (!trustRelativeToBundles || (!trustRelativeToBundles.startsWith("..") && !trustRelativeToBundles.startsWith(sep))) {
  throw new Error("BUNDLE_TRUST_OUTPUT 必须位于 bundles/ 目录之外");
}

function digestFor(
  manifest: BundleManifest | Record<string, unknown>,
  assets?: Record<string, string>,
): string {
  return createHash("sha256").update(canonicalBundleArtifactPayload(manifest, assets)).digest("hex");
}

function normalizedPem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function privateKeyFromEnvironment() {
  const value = process.env.BUNDLE_SIGNING_PRIVATE_KEY?.trim();
  if (!value) return null;
  const key = createPrivateKey(normalizedPem(value));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("BUNDLE_SIGNING_PRIVATE_KEY 必须是 Ed25519 私钥");
  return key;
}

function signDigest(digest: string, privateKey: ReturnType<typeof createPrivateKey>): string {
  return signValue(null, Buffer.from(digest, "hex"), privateKey).toString("base64");
}

function publicKeyPem(privateKey: ReturnType<typeof createPrivateKey>): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

interface TrustRingDocument {
  schemaVersion: "workloom.bundle.trust/v1";
  keys: Record<string, { algorithm: "ed25519"; publicKey: string }>;
  revoked: string[];
}

function readTrustRing(): TrustRingDocument {
  if (!existsSync(trustFile)) return { schemaVersion: "workloom.bundle.trust/v1", keys: {}, revoked: [] };
  const value = JSON.parse(readFileSync(trustFile, "utf8")) as TrustRingDocument;
  if (value.schemaVersion !== "workloom.bundle.trust/v1" || !value.keys || !Array.isArray(value.revoked)) {
    throw new Error("行业包公钥环格式无效");
  }
  return value;
}

function registerSigningPublicKey(keyId: string, privateKey: ReturnType<typeof createPrivateKey>): void {
  const ring = readTrustRing();
  if (ring.revoked.includes(keyId)) throw new Error(`签名密钥 ${keyId} 已撤销，不能重新用于发布`);
  ring.keys[keyId] = { algorithm: "ed25519", publicKey: publicKeyPem(privateKey) };
  mkdirSync(dirname(trustFile), { recursive: true });
  writeFileSync(trustFile, `${JSON.stringify(ring, null, 2)}\n`);
}

function releaseTrustRing(): TrustRingDocument {
  const ring = readTrustRing();
  const envValue = process.env.BUNDLE_VERIFICATION_KEYS?.trim();
  if (!envValue) return ring;
  const parsed = JSON.parse(envValue) as Record<string, unknown>;
  const source = parsed.keys && typeof parsed.keys === "object"
    ? parsed.keys as Record<string, unknown>
    : parsed;
  for (const [keyId, item] of Object.entries(source)) {
    if (["schemaVersion", "revoked"].includes(keyId)) continue;
    const publicKey = typeof item === "string" ? item
      : item && typeof item === "object" ? (item as Record<string, unknown>).publicKey
        : undefined;
    if (typeof publicKey !== "string") throw new Error(`验证公钥 ${keyId} 格式无效`);
    ring.keys[keyId] = { algorithm: "ed25519", publicKey: normalizedPem(publicKey) };
  }
  if (Array.isArray(parsed.revoked)) {
    ring.revoked = [...new Set([...ring.revoked, ...parsed.revoked.filter((item): item is string => typeof item === "string")])];
  }
  return ring;
}

function safeEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function providedPaths(manifest: BundleManifest): string[] {
  const paths: string[] = [];
  for (const value of Object.values(manifest.workloom.provides)) {
    if (typeof value === "string") paths.push(value);
    else if (Array.isArray(value)) paths.push(...value);
  }
  return paths;
}

function assetDigestsFor(directory: string, manifest: BundleManifest): Record<string, string> {
  const paths = providedPaths(manifest);
  if (new Set(paths).size !== paths.length) throw new Error("资产清单存在重复路径");
  return Object.fromEntries(paths.sort((a, b) => a.localeCompare(b)).map((assetPath) => {
    const absolute = resolve(directory, assetPath);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`声明的资产不存在、不是文件或越出行业包目录：${assetPath}`);
    }
    return [assetPath, createHash("sha256").update(readFileSync(absolute)).digest("hex")];
  }));
}

function verifyPresetAssets(directory: string, label: string, manifest: BundleManifest): void {
  const declared = manifest.workloom.provides.presets;
  const declaredSet = new Set(declared);
  if (declaredSet.size !== declared.length) errors.push(`${label}：岗位资产清单存在重复路径`);

  const presetDirectory = join(directory, "presets");
  const actual = existsSync(presetDirectory)
    ? readdirSync(presetDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => `presets/${entry.name}`)
    : [];
  for (const path of actual) {
    if (!declaredSet.has(path)) errors.push(`${label}：岗位资产未在清单声明：${path}`);
  }

  const seenKeys = new Set<string>();
  const seenCoveragePrefixes = new Map<string, string>();
  for (const assetPath of declared) {
    const absolute = resolve(directory, assetPath);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute)) continue;
    let value: unknown;
    try {
      value = YAML.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      errors.push(`${label}：岗位资产无法解析：${assetPath}（${String(error)}）`);
      continue;
    }
    if (!value || typeof value !== "object") {
      errors.push(`${label}：岗位资产必须是对象：${assetPath}`);
      continue;
    }
    const preset = value as Record<string, unknown>;
    const presetKey = typeof preset.preset_key === "string" ? preset.preset_key.trim() : "";
    const name = typeof preset.name === "string" ? preset.name.trim() : "";
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(presetKey)) errors.push(`${label}：${assetPath} 缺少合法岗位标识`);
    else if (seenKeys.has(presetKey)) errors.push(`${label}：重复岗位标识 ${presetKey}`);
    else seenKeys.add(presetKey);
    if (!name || !/\p{Script=Han}/u.test(name)) errors.push(`${label}：${assetPath} 必须声明中文岗位名`);
    if (typeof preset.readonly !== "boolean" || typeof preset.night_shift !== "boolean") {
      errors.push(`${label}：${assetPath} 必须显式声明只读属性与夜班属性`);
    }
    if (!Array.isArray(preset.fence_bindings)) errors.push(`${label}：${assetPath} 必须显式声明围栏绑定数组`);
    if (preset.readonly === false && Array.isArray(preset.fence_bindings) && preset.fence_bindings.length === 0) {
      errors.push(`${label}：${assetPath} 是可写岗位但没有围栏绑定`);
    }
    const tools = Array.isArray(preset.tools) ? preset.tools : [];
    const writeTools = tools.filter((tool) => tool && typeof tool === "object"
      && (tool as Record<string, unknown>).access === "write");
    if (preset.readonly === true && writeTools.length > 0) {
      errors.push(`${label}：${assetPath} 是只读岗位但声明了写工具`);
    }
    if (preset.readonly === false && writeTools.length === 0) {
      errors.push(`${label}：${assetPath} 是可写岗位但没有可执行写工具`);
    }
    if (!Array.isArray(preset.coverage)) {
      errors.push(`${label}：${assetPath} 必须显式声明岗位覆盖数组（只读岗位也必须写 coverage: []）`);
    } else {
      if (preset.readonly === false && preset.coverage.length === 0) {
        errors.push(`${label}：${assetPath} 是可写岗位但没有任何事件覆盖声明`);
      }
      for (const item of preset.coverage) {
        if (!item || typeof item !== "object") {
          errors.push(`${label}：${assetPath} 的岗位覆盖项必须是对象`);
          continue;
        }
        const row = item as Record<string, unknown>;
        const prefix = typeof row.eventPrefix === "string" ? row.eventPrefix.trim()
          : typeof row.event_prefix === "string" ? row.event_prefix.trim() : "";
        const coverageLabel = typeof row.label === "string" ? row.label.trim() : "";
        if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.$/.test(prefix) || !/\p{Script=Han}/u.test(coverageLabel)) {
          errors.push(`${label}：${assetPath} 的岗位覆盖声明必须包含以点结尾的事件前缀与中文名称`);
          continue;
        }
        const previous = seenCoveragePrefixes.get(prefix);
        if (previous) errors.push(`${label}：事件前缀 ${prefix} 被 ${previous} 与 ${assetPath} 重复认领`);
        else seenCoveragePrefixes.set(prefix, assetPath);
      }
    }
  }
}

function verifyOne(directory: string): void {
  const file = join(directory, "bundle.json");
  const label = relative(bundlesRoot, directory);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    errors.push(`${label}：bundle.json 不是合法 JSON（${String(error)}）`);
    return;
  }

  if (refreshDigests) {
    const workloom = raw.workloom;
    if (releaseMode && workloom && typeof workloom === "object" && !Array.isArray(workloom)
      && (workloom as Record<string, unknown>).status !== "draft") {
      (workloom as Record<string, unknown>).status = "stable";
    }
    let normalized: BundleManifest;
    try {
      normalized = parseBundleManifest(raw);
    } catch (error) {
      errors.push(...formatContractError(error).map((message) => `${label}：${message}`));
      return;
    }
    let assets: Record<string, string>;
    try {
      assets = assetDigestsFor(directory, normalized);
    } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const digest = digestFor(normalized, assets);
    let signatureKey: ReturnType<typeof createPrivateKey> | null = null;
    try { signatureKey = privateKeyFromEnvironment(); } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const keyId = process.env.BUNDLE_SIGNING_KEY_ID;
    if (releaseMode && normalized.workloom.status === "stable" && !signatureKey) {
      errors.push(`${label}：生产发布缺少 BUNDLE_SIGNING_PRIVATE_KEY`);
      return;
    }
    if (signatureKey && !keyId) {
      errors.push(`${label}：提供了 Ed25519 私钥但缺少 BUNDLE_SIGNING_KEY_ID`);
      return;
    }
    if (signatureKey && keyId) {
      try { registerSigningPublicKey(keyId, signatureKey); } catch (error) {
        errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    raw.integrity = {
      algorithm: "sha256",
      digest,
      assets,
      ...(signatureKey && keyId ? { signature: { algorithm: "ed25519", keyId, value: signDigest(digest, signatureKey) } } : {}),
    };
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  }

  let manifest: BundleManifest;
  try {
    manifest = parseBundleManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    errors.push(...formatContractError(error).map((message) => `${label}：${message}`));
    return;
  }

  try {
    assertBundleCompatibility(manifest, { base: baseVersion, ui: uiVersion });
  } catch (error) {
    errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
  }

  const allProvidedPaths = providedPaths(manifest);
  if (new Set(allProvidedPaths).size !== allProvidedPaths.length) {
    errors.push(`${label}：provides 资产清单存在重复路径`);
  }
  for (const path of allProvidedPaths) {
    const absolute = resolve(directory, path);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute)) {
      errors.push(`${label}：声明的资产不存在或越出行业包目录：${path}`);
    }
  }
  verifyPresetAssets(directory, label, manifest);

  const actualDigest = digestFor(manifest);
  if (!manifest.integrity) {
    if (manifest.workloom.status !== "draft") errors.push(`${label}：候选/稳定行业包必须有 sha256 完整性摘要`);
  } else if (!safeEqual(manifest.integrity.digest, actualDigest)) {
    errors.push(`${label}：完整性摘要与清单内容不一致，请重新封装`);
  }

  if (manifest.integrity) {
    try {
      const diskAssets = assetDigestsFor(directory, manifest);
      const declaredAssets = manifest.integrity.assets;
      const diskPaths = Object.keys(diskAssets).sort();
      const declaredPaths = Object.keys(declaredAssets).sort();
      if (diskPaths.length !== declaredPaths.length
        || diskPaths.some((path, index) => path !== declaredPaths[index])) {
        errors.push(`${label}：integrity.assets 必须与 provides 逐项一一对应，不得缺失或额外声明`);
      } else {
        for (const path of diskPaths) {
          if (!safeEqual(diskAssets[path]!, declaredAssets[path]!)) {
            errors.push(`${label}：资产内容摘要不一致：${path}`);
          }
        }
      }
    } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (manifest.workloom.status === "stable") {
    const signature = manifest.integrity?.signature;
    if (!signature) {
      errors.push(`${label}：生产发布必须有 Ed25519 签名`);
    } else {
      try {
        const ring = releaseTrustRing();
        if (ring.revoked.includes(signature.keyId)) {
          errors.push(`${label}：签名密钥 ${signature.keyId} 已撤销`);
        } else {
          const trusted = ring.keys[signature.keyId];
          if (!trusted) errors.push(`${label}：可信公钥环没有 ${signature.keyId}`);
          else {
            const key = createPublicKey(normalizedPem(trusted.publicKey));
            const valid = key.asymmetricKeyType === "ed25519" && verifyValue(
              null,
              Buffer.from(actualDigest, "hex"),
              key,
              Buffer.from(signature.value, "base64"),
            );
            if (!valid) errors.push(`${label}：Ed25519 签名验证失败`);
          }
        }
      } catch (error) {
        errors.push(`${label}：验证公钥环失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  }

  for (const entry of manifest.workloom.ui.navigation.slots) {
    if (entry.capabilityId.startsWith("workloom.") || baseCapabilityIds.has(entry.capabilityId)) {
      errors.push(`${label}：行业导航不得覆盖公共能力 ${entry.capabilityId}`);
    }
    if (baseRoutes.has(entry.route)) errors.push(`${label}：行业导航不得覆盖公共路由 ${entry.route}`);
    if (!NAVIGATION_GROUP_ORDER.includes(entry.group as never)) errors.push(`${label}：未知导航分组 ${entry.group}`);
    if (!iconNames.has(entry.icon as IconName)) errors.push(`${label}：未知共享图标 ${entry.icon}`);
  }

  for (const widget of manifest.workloom.ui.home.widgets) {
    if (!baseWidgetComponents.has(widget.component)) {
      errors.push(`${label}：首页组件 ${widget.component} 不在基座组件白名单，行业包不得自建基础组件`);
    }
    if (widget.component === "QuickTaskList") {
      const tasks = widget.props.tasks;
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8) {
        errors.push(`${label}：快捷任务必须配置 1–8 条中文任务`);
      } else {
        for (const task of tasks) {
          if (typeof task !== "string" || !/\p{Script=Han}/u.test(task) || task.length > 40) {
            errors.push(`${label}：快捷任务必须是 40 字以内的中文用户文案`);
          }
        }
      }
    }
  }

  const front = manifest.workloom.ui.serviceFront;
  if (!front.enabled && (front.identityPolicy !== "disabled" || front.tabs.length || front.services.length)) {
    errors.push(`${label}：C端关闭时身份策略、标签和服务必须同时为空`);
  }
  // C 端可以只开放已签名渠道会话、通用对话与工单，而不绑定行业业务身份。
  // identityPolicy=disabled 表示禁用会员/订单等业务身份绑定，不代表允许客户端自报身份。
}

if (!existsSync(bundlesRoot) || !statSync(bundlesRoot).isDirectory()) {
  console.error(`❌ 行业包目录不存在：${bundlesRoot}`);
  process.exit(1);
}
for (const entry of readdirSync(bundlesRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && existsSync(join(bundlesRoot, entry.name, "bundle.json"))) verifyOne(join(bundlesRoot, entry.name));
}

if (errors.length) {
  console.error(`❌ 行业包治理门禁失败（${errors.length} 项）`);
  for (const error of errors) console.error(`  · ${error}`);
  process.exit(1);
}
console.log(`✅ 行业包契约、兼容范围、资产、导航与完整性门禁通过（base ${baseVersion} / ui ${uiVersion}${releaseMode ? " / 发布验签" : ""}）`);
