#!/usr/bin/env node
/**
 * 原生桌面发布通道的受控首启冒烟入口（product.desktop.smokeRunner）。
 *
 * 为什么需要这一层：mac/win 拆包验收调用的 `bootstrap.cjs --smoke` 是载荷首启事实源，
 * 但产品清单需要一条受控、可被发布门禁点名的入口，才能在切换发布通道前证明
 * 「候选作业确实跑了首启冒烟」，而不是只在工作流里出现了一串命令。
 *
 * 用法：node scripts/native-smoke.mjs --resources <resources-dir> --support <support-dir>
 * 只做参数与入口校验后转交 bootstrap；不改变 bootstrap 的验收语义。
 */
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = join(ROOT, "apps", "desktop", "electron", "bootstrap.cjs");

export function main(args = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--resources", "--support"].includes(flag)) throw new Error(`未知参数：${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少路径`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  for (const key of ["resources", "support"]) {
    if (!values[key]) throw new Error(`用法：native-smoke.mjs --resources <dir> --support <dir>（缺 --${key}）`);
  }
  const resources = resolve(values.resources);
  // 载荷目录必须是真实存在的目录，避免把「冒烟命令存在」误当「载荷能首启」。
  if (!existsSync(resources) || !statSync(resources).isDirectory()) throw new Error(`载荷资源目录不存在：${resources}`);
  if (!existsSync(BOOTSTRAP)) throw new Error(`首启入口缺失：${relative(ROOT, BOOTSTRAP)}`);
  const support = resolve(values.support);
  if (!isAbsolute(support) || support === resources) throw new Error("支持目录必须是独立的绝对路径");
  const result = spawnSync(process.execPath, [BOOTSTRAP, "--smoke", "--resources", resources, "--support", support], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`❌ 原生首启冒烟失败：${error.message}`); process.exitCode = 1; }
}

export { BOOTSTRAP, ROOT };
