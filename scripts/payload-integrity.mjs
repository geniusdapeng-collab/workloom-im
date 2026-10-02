import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
export const { verifyPayloadIntegrity, generatePayloadIntegrity } = require("../apps/desktop/electron/payload-integrity.cjs");

export function main(args = process.argv.slice(2)) {
  const [command, flag, directory, ...extra] = args;
  if (!["generate", "verify"].includes(command) || flag !== "--payload-dir" || !directory || extra.length) {
    throw new Error("用法：payload-integrity.mjs generate|verify --payload-dir DIR");
  }
  const result = (command === "generate" ? generatePayloadIntegrity : verifyPayloadIntegrity)(resolve(directory));
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch { console.error("载荷完整性命令失败；载荷或索引不符合受控契约"); process.exitCode = 1; }
}
