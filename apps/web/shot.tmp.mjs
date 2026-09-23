import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 950 }, locale: "zh-CN" });
const page = await ctx.newPage();
for (const [name, path] of [["agents", "/agents"], ["approvals", "/approvals"], ["assembly", "/assembly"], ["agent-detail", "/agents/agt-competitor-agent"]]) {
  await page.goto("http://127.0.0.1:5274" + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/task2-${name}.png` });
}
console.log("ok");
await browser.close();
