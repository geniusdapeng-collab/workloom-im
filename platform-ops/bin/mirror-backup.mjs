#!/usr/bin/env node
/**
 * mirror-backup —— 仓库异地镜像备份（对焦方案 §4 / 已对焦落点：工蜂/CNB 双托管，异构防平台级事故）
 *
 * 用法：
 *   node platform-ops/bin/mirror-backup.mjs [--config safety/mirror-targets.json] [--dry-run]
 *
 * 机制：git push --mirror 到配置的全部镜像目标（refs 全量，含分支与标签）。
 * 凭据：走环境变量（CNB_TOKEN / GONGFENG_TOKEN），绝不写入配置或命令行。
 * 纪律：镜像为只读副本——恢复时才克隆；每次镜像结果写 .safety-mirror-state.json（时间+SHA+结果）供巡检核对。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dft) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dft;
};
const DRY_RUN = args.includes("--dry-run");
const configPath = opt("--config", "safety/mirror-targets.json");

if (!existsSync(configPath)) {
  console.error(`配置缺失：${configPath}（参照 safety/mirror-targets.example.json 创建，凭据走环境变量）`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf-8"));

const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
const results = [];

for (const target of config.targets ?? []) {
  const tokenEnv = target.tokenEnv;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (target.tokenEnv && !token) {
    results.push({ name: target.name, ok: false, detail: `环境变量 ${tokenEnv} 未配置，跳过` });
    continue;
  }
  const url = target.urlTemplate.replace("${TOKEN}", token ?? "");
  const remote = `mirror-${target.name}`;
  try {
    execFileSync("git", ["remote", "remove", remote], { stdio: "ignore" });
  } catch { /* 不存在则忽略 */ }
  execFileSync("git", ["remote", "add", remote, url]);
  if (DRY_RUN) {
    results.push({ name: target.name, ok: true, detail: `dry-run：将推送 ${headSha.slice(0, 7)} → ${target.urlTemplate.replace("${TOKEN}", "***")}` });
  } else {
    try {
      execFileSync("git", ["push", "--mirror", remote], { stdio: "pipe" });
      results.push({ name: target.name, ok: true, detail: `已镜像 ${headSha.slice(0, 7)}` });
    } catch (err) {
      results.push({ name: target.name, ok: false, detail: `推送失败：${String(err).slice(0, 200)}` });
    }
  }
  execFileSync("git", ["remote", "remove", remote], { stdio: "ignore" });
}

const state = { at: new Date().toISOString(), headSha, results };
writeFileSync(".safety-mirror-state.json", JSON.stringify(state, null, 2) + "\n");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
