/**
 * R2-F6 / EXP-04 断言（fix_f_r2）：紧急制动的完整可执行链
 *   入口可达（顶栏/页内都在）→ 无运行班次时可「出征」→ 制动可用 → 二次确认 → 撤回 → 确认制动 → 服务端 paused。
 * 用法：cd /Users/mac/WorkLoom-fleet/.wt-mcd-m6 && node <this>
 * 依赖：PC 前端 :5395（serve-web-ff.sh）、server :8995（serve-ff.sh）、库 wl_mcd_ff。
 */
import {
  loadProfile,
  urlsOf,
} from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/profile.mjs";
import { loadChromium } from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/playwright.mjs";
import { loginAsMember, productIdOf } from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/session.mjs";
import pg from "pg";

const REPO = "/Users/mac/WorkLoom-fleet/.wt-mcd-m6";
const WORK = "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m6";
const DB = process.env.M6_DB ?? "postgres://postgres:<redacted>@127.0.0.1:5432/wl_mcd_ff";
const WS = "ws-aipm-demo";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: DB });
await db.connect();
const latestRun = async () => (await db.query(
  `SELECT id, status FROM night_runs WHERE workspace_id=$1 ORDER BY run_date DESC, started_at DESC NULLS LAST LIMIT 1`, [WS],
)).rows[0] ?? null;
const pauseEvents = async () => Number((await db.query(
  `SELECT count(*)::int AS c FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('night.pause_all','night.pause_timeout')`, [WS],
)).rows[0]?.c ?? -1);

const before = await latestRun();
const pauseBefore = await pauseEvents();
check("① 前置：记录出征前班次状态", true, before ? `${before.id}=${before.status}` : "无班次（未配置）");

const { profile } = loadProfile(REPO, `${WORK}/profile-p5ui.json`);
const URLs = urlsOf(profile);
const chromium = loadChromium(REPO);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await ctx.newPage();
await loginAsMember(page, { urls: URLs, workspaceSlug: profile.identity?.workspaceSlug ?? "ai-pm-demo", memberNo: "MEM-001", productId: productIdOf(REPO) });
await page.goto(`${URLs.pc}/night`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// 复位（可重复执行）：上一轮若已制动，先恢复再断言
const resumeBtn = page.getByRole("button", { name: /恢复夜班/ }).first();
if (await resumeBtn.isVisible().catch(() => false)) {
  await resumeBtn.click();
  await page.waitForTimeout(4000);
}

const brakes = page.getByRole("button", { name: /紧急制动/ });
const setOut = page.getByRole("button", { name: /出征（开启夜班）/ }).first();
const brakeCount = await brakes.count();
check("② 入口可达：顶栏制动在场（与页内制动同组件）", brakeCount >= 1, `紧急制动按钮数=${brakeCount}`);

const topBrake = brakes.first();
if (await topBrake.isDisabled()) {
  check("③ 无运行班次时制动禁用且给出原因（不静默）",
    (await topBrake.getAttribute("title"))?.includes("没有运行中的夜班") === true
    || (await topBrake.getAttribute("title"))?.includes("权限") === true,
    `title=${await topBrake.getAttribute("title")}`);
  check("④ 出征入口可达（夜班中心）", await setOut.isVisible(), `visible=${await setOut.isVisible()}`);
  await setOut.click();
  await page.waitForTimeout(4500);
  const afterSetOut = await latestRun();
  check("⑤ 出征后服务端班次为 running", afterSetOut?.status === "running", afterSetOut ? `${afterSetOut.id}=${afterSetOut.status}` : "无班次");
}
check("⑥ 顶栏制动在班次 running 时可执行", (await topBrake.isDisabled()) === false,
  `disabled=${await topBrake.isDisabled()} title=${await topBrake.getAttribute("title")}`);

await topBrake.click();
const confirmBtn = page.getByRole("button", { name: /确认制动/ }).first();
const withdrawBtn = page.getByRole("button", { name: /撤回/ }).first();
check("⑦ 二次确认态：确认制动 + 撤回同时在场", await confirmBtn.isVisible() && await withdrawBtn.isVisible(),
  `confirm=${await confirmBtn.isVisible()} withdraw=${await withdrawBtn.isVisible()}`);
await withdrawBtn.click();
await sleep(400);
check("⑧ 撤回关闭二次确认（未触发制动）", !(await confirmBtn.isVisible().catch(() => false)));

await topBrake.click();
await confirmBtn.click();
await page.waitForTimeout(4500);
const note = await page.locator('[role="status"]').filter({ hasText: /已制动|请复核/ }).first().textContent().catch(() => null);
check("⑨ 制动结果就地回执（用时/挂起任务数）", !!note, note?.trim() ?? "未见回执");
const afterBrake = await latestRun();
check("⑩ 服务端班次置 paused", afterBrake?.status === "paused", afterBrake ? `${afterBrake.id}=${afterBrake.status}` : "无班次");
check("⑪ 制动留痕：新增 night.run.pause 事件", (await pauseEvents()) > pauseBefore,
  `events ${pauseBefore} → ${await pauseEvents()}`);
await page.screenshot({ path: `${WORK}/brake-after.png`, fullPage: false });
await browser.close();
await db.end();

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0
  ? `\n结论：PASS（${results.length}/${results.length} 断言通过）`
  : `\n结论：FAIL（${results.length - failed.length}/${results.length} 通过，失败：${failed.map((f) => f.name).join("；")}）`);
process.exit(failed.length === 0 ? 0 : 1);
