#!/usr/bin/env node
/**
 * 载荷版本标记一致性断言（打包期早失败）。
 *
 * 三个装配脚本都会在载荷根写 VERSION / PAYLOAD_VERSION，并在 runtime/VERSION 里
 * 保留产品载荷自己的版本；payload-integrity 要求三者逐字节一致，否则在完整性步骤
 * 报一个笼统的“版本标记不一致”。等到那一步才发现，装配步骤已经跑完，问题容易被
 * 误判成载荷损坏而不是标记漂移。这里在写标记后立即核对，并把是哪一步对不上说清楚。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKERS = ["VERSION", "PAYLOAD_VERSION", "runtime/VERSION"];

function readMarker(root, file) {
  try { return readFileSync(resolve(root, file), "utf8").trim(); }
  catch (error) { throw new Error(`载荷版本标记缺失：${file}（${error.code ?? error.message}）`); }
}

export function assertPayloadMarkers(root, { expectedVersion } = {}) {
  const values = MARKERS.map((file) => [file, readMarker(root, file)]);
  for (const [file, value] of values) if (!value || value === "unknown" || /[\0\r\n]/u.test(value)) throw new Error(`载荷版本标记无效：${file}=${JSON.stringify(value)}`);
  const [[reference, expected], ...rest] = values;
  for (const [file, value] of rest) if (value !== expected) throw new Error(`载荷版本标记不一致：${reference}=${expected} 与 ${file}=${value} 不同`);
  if (expectedVersion !== undefined && expected !== expectedVersion) throw new Error(`载荷版本标记与本次装配版本不一致：${expected} != ${expectedVersion}`);
  return { version: expected, markers: Object.fromEntries(values) };
}

export function main(args = process.argv.slice(2)) {
  const [directory, ...extra] = args;
  if (!directory || extra.length) throw new Error("用法：payload-markers.mjs <payload-dir>");
  console.log(JSON.stringify(assertPayloadMarkers(resolve(directory)), null, 1));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}
