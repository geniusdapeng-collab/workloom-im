#!/usr/bin/env node
/**
 * 正式桌面载荷的产品边界策略。
 *
 * platform-ops 是仙女座的平台运营运维源码，不是 WorkLoom IM 公共基座能力。
 * 目录是否碰巧存在不能成为装包依据；只有受保护产品身份精确匹配仙女座时
 * 才允许进入载荷，其他产品（包括基座、行业与试验田）一律排除并在装包后复核。
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductRuntime } from "./product-runtime.mjs";

const ANDROMEDA_IDENTITY = Object.freeze({
  productId: "workroom-andromeda",
  role: "platform",
  repository: "geniusdapeng-collab/workroom-andromeda",
});

const PLATFORM_OPS_RUNTIME_PATHS = Object.freeze([
  "platform-ops",
  "node_modules/@workloom/platform-ops",
]);

function exactIdentity(product, expected) {
  return Object.entries(expected).every(([field, value]) => product[field] === value);
}

export function payloadPolicyFor(product) {
  if (!product || typeof product !== "object") throw new Error("缺少已校验的产品身份");
  const includePlatformOps = exactIdentity(product, ANDROMEDA_IDENTITY);
  return Object.freeze({
    productId: product.productId,
    role: product.role,
    repository: product.repository,
    includePlatformOps,
    forbiddenRuntimePaths: Object.freeze(includePlatformOps ? [] : [...PLATFORM_OPS_RUNTIME_PATHS]),
  });
}

export function loadPayloadPolicy(start) {
  return payloadPolicyFor(loadProductRuntime(start));
}

function normalizeArchivePath(value) {
  const parts = String(value)
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  const normalized = [];
  for (const part of parts) {
    if (part === "..") {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join("/").toLowerCase();
}

function isForbiddenArchiveEntry(entry, forbiddenRuntimePath) {
  const normalized = normalizeArchivePath(entry);
  const forbidden = normalizeArchivePath(`runtime/${forbiddenRuntimePath}`);
  return normalized === forbidden || normalized.startsWith(`${forbidden}/`);
}

export function findForbiddenArchiveEntries(entries, policy) {
  return entries.filter((entry) => policy.forbiddenRuntimePaths.some(
    (forbidden) => isForbiddenArchiveEntry(entry, forbidden),
  ));
}

export function assertRuntimePayloadBoundary(runtimeRoot, policy) {
  const resolvedRoot = resolve(runtimeRoot);
  const leaks = policy.forbiddenRuntimePaths.filter((relativePath) => {
    const candidate = resolve(resolvedRoot, ...relativePath.split("/"));
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`非法载荷边界路径：${relativePath}`);
    }
    return existsSync(candidate);
  });
  if (leaks.length > 0) {
    throw new Error(`平台工程边界违规：${leaks.join("、")} 不得进入 ${policy.productId} 正式载荷`);
  }
}

export function assertArchivePayloadBoundary(entries, policy) {
  const leaks = findForbiddenArchiveEntries(entries, policy);
  if (leaks.length > 0) {
    throw new Error(`平台工程边界违规：归档包含 ${leaks.join("、")}`);
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const [command, value] = process.argv.slice(2);
  const policy = loadPayloadPolicy();
  switch (command) {
    case "platform-ops-mode":
      process.stdout.write(`${policy.includePlatformOps ? "include" : "exclude"}\n`);
      break;
    case "assert-runtime":
      if (!value) throw new Error("用法：payload-policy.mjs assert-runtime <runtime 目录>");
      assertRuntimePayloadBoundary(value, policy);
      break;
    case "assert-archive-list": {
      const entries = (await readStdin()).split(/\r?\n/u).filter(Boolean);
      assertArchivePayloadBoundary(entries, policy);
      break;
    }
    default:
      throw new Error("用法：payload-policy.mjs platform-ops-mode | assert-runtime <目录> | assert-archive-list");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
