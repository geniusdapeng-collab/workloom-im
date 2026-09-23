import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 950 }, locale: "zh-CN" });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:5274/agents", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3500);
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/task2-agents-scrolled.png" });
// 技能中心
await page.goto("http://127.0.0.1:5274/skills", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: "/tmp/task2-skills.png" });
// 行业方案
await page.goto("http://127.0.0.1:5274/assembly", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: "/tmp/task2-assembly.png" });
console.log("ok");
await browser.close();
