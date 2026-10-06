#!/usr/bin/env node
/**
 * oss-watch-ci · 流水线里的开源组件周期扫描与「更新清单 PR」（CNB crontab 专用入口）
 *
 * 作用：在无人值守的定时流水线里
 *   ① 全量刷新上游最新版本（npm / PyPI / GitHub）；
 *   ② 重新生成 docs/OPEN_SOURCE_COMPONENTS.md 与 docs/oss-update-plan.md；
 *   ③ 有变化时自动开一支 `chore/oss-watch-YYYYMMDD` 分支 + 提交 + 推送 + PR。
 *      —— 计划 PR 只刷新事实；升级由 AI 按协议 §1/§9.5 执行（门禁全绿 + 串行 + 冷却期），
 *         破坏性/大版本升级按 §3 人审放行，人保留叫停与回滚权。
 *
 * 用法（CI）：node scripts/oss-watch-ci.mjs [--dry-run] [--exit-zero]
 * 前置：CNB_TOKEN（CNB 流水线自动注入，作用域限当前仓库）
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWatch } from "./oss-watch.mjs";
import { api, createPull, getPull, requireToken, gitAuthenticationEnvironment, redactCredentials } from "./tools/cnb-api.mjs";

const WATCHED_PATHS = [
  "oss-components.json",
  ".oss-watch-state.json",
  "docs/OPEN_SOURCE_COMPONENTS.md",
  "docs/oss-update-plan.md",
];

function git(args, options = {}) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
  catch (error) { throw new Error(redactCredentials(`Git 失败：${error.stderr?.toString() ?? error.code ?? 'unknown'}`)); }
}

function slugFromRemote(cwd) {
  // get-url expands insteadOf transport aliases; repository identity comes from the stored origin.
  const remote = git(["-C", cwd, "config", "--get", "remote.origin.url"]);
  const match = remote.match(/^(?:https:\/\/cnb\.cool\/|git@cnb\.cool:)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?$/);
  if (!match) throw new Error(`无法从 origin 推断仓库 slug：${remote}`);
  if (match[1].split('/').some(part => part === '.' || part === '..')) throw new Error('开源扫描仓库 slug 不能包含路径穿越');
  return match[1].replace(/\.git$/, '');
}

/**
 * 推送分支：优先用环境已有凭据的 origin；失败再用 CNB_TOKEN 走 http.extraheader。
 * 不在命令行里拼带凭据的 URL（会被增量秘密扫描判为 credential-in-url）。
 */
function pushBranch(repoDir, slug, branch, token, log) {
  const refspec = `HEAD:refs/heads/${branch}`;
  try {
    git(["-C", repoDir, "push", "origin", refspec]);
    return "origin";
  } catch (error) {
    log(`  · origin 推送失败（${String(error.message).split("\n")[0]}），改用 CNB_TOKEN 头部鉴权`);
  }
  git([
    "-C",
    repoDir,
    "push",
    `https://cnb.cool/${slug}.git`,
    refspec,
  ], { env: gitAuthenticationEnvironment(token) });
  return "token-header";
}

function changedFiles(cwd) {
  const out = git(["-C", cwd, "status", "--porcelain", "--", ...WATCHED_PATHS]);
  return out ? out.split("\n").map((line) => line.slice(3).trim()).filter(Boolean) : [];
}

function sourceBranch(pull) {
  const ref = typeof pull.head === 'string' ? pull.head : pull.head?.ref;
  const legacy = typeof pull.source_branch === 'string' ? pull.source_branch : pull.source_branch?.ref;
  const branch = ref ?? legacy;
  if (typeof branch !== 'string' || !branch) throw new Error('开源扫描 PR 源分支不可读');
  return branch.replace(/^refs\/heads\//, '');
}

async function openPulls(slug, token, request = api) {
  const result = []; const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const rows = await request(slug, `/-/pulls?state=open&page_size=100&page=${page}`, { token });
    if (!Array.isArray(rows)) throw new Error('开源扫描 PR 分页不可读');
    for (const pull of rows) {
      const number = Number(pull.number);
      if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) throw new Error('开源扫描 PR 分页身份重复或无效');
      seen.add(number); sourceBranch(pull); result.push(pull);
    }
    if (rows.length < 100) return result;
  }
  throw new Error('开源扫描 PR 分页超过上限');
}

export async function run({ cwd, dryRun = false, taskId = "", log = console.log, services = {} } = {}) {
  const root = resolve(cwd);
  const { summary, exitCode } = await (services.runWatch ?? runWatch)({ root, all: false, exitZero: true, dryRun, log });
  if (dryRun) {
    log(`--dry-run：只查询与生成计划，不写文件、不建分支、不推送；状态 ${summary.status}`);
    return { changed: false, dryRun: true, plannedFiles: summary.plannedFiles, summary, exitCode };
  }
  if (exitCode === 1) throw new Error(`上游扫描有 ${summary.failures.length} 个未核实项，拒绝提交成功清单`);
  const changed = changedFiles(root);
  if (!changed.length) {
    log("✓ 开源组件清单无变化：无需 PR");
    return { changed: false, summary };
  }
  log(`→ 检测到 ${changed.length} 个文件变化：${changed.join(", ")}`);

  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" })
    .format(new Date())
    .replace(/-/g, "");
  const branch = `chore/oss-watch-${date}`;
  const slug = slugFromRemote(root);
  const token = (services.requireToken ?? requireToken)();

  const list = () => openPulls(slug, token, services.request);
  const matches = (await list()).filter(pull => sourceBranch(pull) === branch);
  if (matches.length > 1) throw new Error('当日开源扫描 PR 身份不唯一');
  const existing = matches[0];
  if (existing) {
    log(`已有当日 PR #${existing.number}（${branch}），跳过重复创建`);
    return { changed: true, branch, pull: existing.number, summary, reused: true };
  }


  git(["-C", root, "config", "user.name", "cnb-oss-watch-bot"]);
  git(["-C", root, "config", "user.email", "oss-watch-bot@cnb.cool"]);
  git(["-C", root, "checkout", "-b", branch]);
  git(["-C", root, "add", "--", ...WATCHED_PATHS]);
  const subject = `chore(deps): 开源组件清单与更新计划周期刷新（oss-watch 自动扫描）${taskId ? ` [${taskId}]` : ""}`;
  git(["-C", root, "commit", "-m", subject]);
  const pushedVia = pushBranch(root, slug, branch, token, log);
  log(`✓ 已推送分支 ${branch}（${pushedVia}）`);

  const lines = [];
  lines.push("## oss-watch 周期扫描（自动）");
  lines.push("");
  lines.push(`- 扫描时间：${summary.scannedAt}`);
  lines.push(`- 登记组件有更新：**${summary.componentUpdates}** 个 ｜ 直接依赖有更新：**${summary.dependencyUpdates}** 个`);
  lines.push(`- npm 查询 ${summary.npmQueried} 个 ｜ PyPI 查询 ${summary.pypiQueried} 个 ｜ 查询失败 ${summary.failures.length} 个`);
  lines.push(`- 变更文件：${changed.map((file) => `\`${file}\``).join("、")}`);
  lines.push("");
  lines.push("## 升级纪律（AI 执行 · 人保留叫停）");
  lines.push("");
  lines.push("1. AI 按 `docs/oss-update-plan.md` 组批（dsh 永远单独一批；破坏性/大版本单列并在 PR 显著标注）；");
  lines.push("2. 按组件 gate 逐项升级并过门禁（smoke/standard/full/runtime-gate）；");
  lines.push("3. 门禁全绿后按协议 §1/§9.5 合并，更新 `oss-components.json` 的 current 并发布；");
  lines.push("4. 人保留随时叫停、要求回滚与例外裁决权。");
  lines.push("");
  lines.push("> 本 PR 只刷新事实与计划；升级执行与合并按协议 §1/§9.5（`risk/review` 项需人审放行）。");
  if (summary.failures.length) {
    lines.push("");
    lines.push("## 上游查询失败（AI 重试 / 人工兜底）");
    lines.push("");
    for (const failure of summary.failures.slice(0, 20)) lines.push(`- \`${failure}\``);
  }

  const marker = `oss-watch:${branch}:${git(['-C', root, 'rev-parse', 'HEAD'])}`;
  lines.push(`\n<!-- ${marker} -->`);
  const create = services.createPull ?? createPull;
  const detail = number => (services.getPull ?? getPull)(slug, number, { token });
  let pull;
  try { pull = await create(slug, {
    title: `chore(deps): 开源组件清单与更新计划周期刷新（${date}）`,
    head: branch,
    base: "main",
    body: lines.join("\n"),
  }, { token }); }
  catch (error) {
    const recovered = [];
    for (const item of (await list()).filter(item => sourceBranch(item) === branch)) {
      const actual = await detail(Number(item.number));
      if (typeof actual.body === 'string' && actual.body.includes(`<!-- ${marker} -->`)) recovered.push(actual);
    }
    if (recovered.length !== 1) throw error;
    pull = recovered[0];
  }
  const number = Number(pull?.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('开源扫描 PR 创建回执无效');
  const actual = await detail(number);
  if (Number(actual.number) !== number || actual.state !== 'open' || sourceBranch(actual) !== branch ||
    actual.head?.sha !== git(['-C', root, 'rev-parse', 'HEAD']) || typeof actual.body !== 'string' || !actual.body.includes(`<!-- ${marker} -->`)) throw new Error('开源扫描 PR 创建结果与准确源码不一致');
  log(`✓ 已创建 PR #${pull?.number ?? "?"}（${branch}）`);
  return { changed: true, branch, pull: pull?.number, summary };
}

async function main() {
  const cwd = resolve(process.env.CNB_BUILD_WORKSPACE ?? process.cwd());
  const taskId = process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : "";
  const result = await run({ cwd, dryRun: process.argv.includes("--dry-run"), taskId });
  const exitZero = process.argv.includes("--exit-zero");
  process.exit(result.exitCode === 1 ? 1 : result.changed && !exitZero ? 2 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`✗ oss-watch-ci 执行失败：${error?.stack ?? error}`);
    process.exit(1);
  });
}
