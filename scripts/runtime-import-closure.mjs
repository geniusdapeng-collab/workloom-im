#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const EMITTED_EXTENSION_SOURCES = Object.freeze({
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
});

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function withoutComments(source) {
  let output = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (value === "\n") { state = "code"; output += value; } else output += " ";
      continue;
    }
    if (state === "block-comment") {
      if (value === "*" && next === "/") { output += "  "; index += 1; state = "code"; }
      else output += value === "\n" ? value : " ";
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      output += value;
      if (value === "\\" && next !== undefined) { output += next; index += 1; continue; }
      if ((state === "single" && value === "'") || (state === "double" && value === '"') || (state === "template" && value === "`")) state = "code";
      continue;
    }
    if (value === "/" && next === "/") { output += "  "; index += 1; state = "line-comment"; continue; }
    if (value === "/" && next === "*") { output += "  "; index += 1; state = "block-comment"; continue; }
    if (value === "'") state = "single";
    else if (value === '"') state = "double";
    else if (value === "`") state = "template";
    output += value;
  }
  return output;
}

export function relativeModuleSpecifiers(source) {
  const code = withoutComments(source);
  const found = new Set();
  const patterns = [
    /\bimport\s*["']([^"'\r\n]+)["']/gu,
    /\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*["']([^"'\r\n]+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"'\r\n]+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1].startsWith(".")) found.add(match[1]);
    }
  }
  return [...found];
}

function moduleCandidates(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const extension = extname(target);
  if (EMITTED_EXTENSION_SOURCES[extension]) {
    return [target, ...EMITTED_EXTENSION_SOURCES[extension].map((sourceExtension) => (
      `${target.slice(0, -extension.length)}${sourceExtension}`
    ))];
  }
  if (extension) return [target];
  return [
    target,
    ...SOURCE_EXTENSIONS.map((sourceExtension) => `${target}${sourceExtension}`),
    ...SOURCE_EXTENSIONS.map((sourceExtension) => resolve(target, `index${sourceExtension}`)),
  ];
}

function existingFile(candidates) {
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

export function verifyRuntimeImportClosure(runtimeRoot, entries = ["apps/server/src/index.ts"]) {
  const root = realpathSync(resolve(runtimeRoot));
  const pending = [];
  for (const entry of entries) {
    const candidate = resolve(root, entry);
    if (!isWithin(root, candidate) || !existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error(`运行时依赖闭包入口缺失或越界：${entry}`);
    }
    pending.push(realpathSync(candidate));
  }

  const visited = new Set();
  const missing = [];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);
    const source = readFileSync(importer, "utf8");
    for (const specifier of relativeModuleSpecifiers(source, importer)) {
      const candidates = moduleCandidates(importer, specifier);
      const resolvedFile = existingFile(candidates);
      if (!resolvedFile) {
        missing.push(`${relative(root, importer)} -> ${specifier}`);
        continue;
      }
      const physicalFile = realpathSync(resolvedFile);
      if (!isWithin(root, physicalFile)) {
        missing.push(`${relative(root, importer)} -> ${specifier}（越出运行时载荷）`);
        continue;
      }
      if (SOURCE_EXTENSIONS.includes(extname(physicalFile))) pending.push(physicalFile);
    }
  }
  if (missing.length > 0) {
    throw new Error(`运行时相对导入依赖闭包不完整：\n${missing.sort().map((item) => `- ${item}`).join("\n")}`);
  }
  return Object.freeze({ files: Object.freeze([...visited].map((file) => relative(root, file)).sort()) });
}

async function main() {
  const [runtimeRoot, ...entries] = process.argv.slice(2);
  if (!runtimeRoot) throw new Error("用法：runtime-import-closure.mjs <runtime-root> [entry ...]");
  const result = verifyRuntimeImportClosure(runtimeRoot, entries.length > 0 ? entries : undefined);
  process.stdout.write(`✓ 运行时相对导入依赖闭包完整（${result.files.length} 个模块）\n`);
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
