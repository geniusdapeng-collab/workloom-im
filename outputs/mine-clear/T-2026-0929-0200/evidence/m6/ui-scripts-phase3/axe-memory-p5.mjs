/** R2-F5 失败详情复跑：/memory 的 select-name 违规节点级取证（ff 工作树 / :5395） */
import { findRepoRoot, loadProfile, urlsOf } from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/profile.mjs";
import { loadChromium } from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/playwright.mjs";
import { loginAsMember, productIdOf } from "/Users/mac/WorkLoom-fleet/workloom-im-mcdacc/scripts/acceptance/lib/session.mjs";
import { createRequire } from "node:module";

const REPO = "/Users/mac/WorkLoom-fleet/.wt-mcd-m6";
const require = createRequire(`${REPO}/package.json`);
const { AxeBuilder } = require("@axe-core/playwright");
const OUT = process.argv[2] ?? "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m6/evidence-phase3/axe-memory-p5";

const { profile } = loadProfile(REPO, "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m6/profile-p5ui.json");
const URLs = urlsOf(profile);
const chromium = loadChromium(REPO);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await ctx.newPage();
await loginAsMember(page, { urls: URLs, workspaceSlug: profile.identity?.workspaceSlug ?? "ai-pm-demo", memberNo: profile.identity?.human ?? "MEM-001", productId: productIdOf(REPO) });
await page.goto(`${URLs.pc}/memory`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const res = await new AxeBuilder({ page }).analyze();
const bad = res.violations.filter((v) => ["critical", "serious"].includes(v.impact));
for (const v of bad) {
  console.log(`规则: ${v.id}（${v.impact}）· ${v.help}`);
  for (const n of v.nodes) {
    console.log("  节点:", n.target.join(" "));
    console.log("  HTML:", (n.html ?? "").slice(0, 400));
    console.log("  摘要:", String(n.failureSummary ?? "").split("\n").slice(0, 3).join(" | "));
  }
}
const selectViolations = res.violations.filter((v) => v.id === "select-name").reduce((acc, v) => acc + v.nodes.length, 0);
console.log("全部规则统计:", res.violations.map((v) => `${v.id}(${v.impact})×${v.nodes.length}`).join(", ") || "无");
console.log(`critical/serious 违规数=${bad.reduce((a, v) => a + v.nodes.length, 0)}；select-name 节点数=${selectViolations}`);
await page.screenshot({ path: `${OUT}.png`, fullPage: false });
await browser.close();
process.exit(selectViolations === 0 && bad.length === 0 ? 0 : 1);
