import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 800 }, locale: "zh-CN" });
const page = await ctx.newPage();
const out = {};
for (const path of ["/agents", "/events", "/approvals"]) {
  await page.goto("http://127.0.0.1:5274" + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3500);
  out[path] = await page.evaluate(async () => {
    const nav = document.querySelector("nav.wl-side-navigation") ?? document.querySelector("nav");
    if (!nav) return { found: false };
    const before = nav.getBoundingClientRect().toJSON();
    const docHeight = document.documentElement.scrollHeight;
    window.scrollTo(0, Math.min(1500, docHeight - window.innerHeight));
    await new Promise((r) => setTimeout(r, 300));
    const after = nav.getBoundingClientRect().toJSON();
    const cs = getComputedStyle(nav);
    const res = {
      found: true, docHeight, scrolled: window.scrollY,
      beforeTop: Math.round(before.top), afterTop: Math.round(after.top),
      navVisible: after.bottom > 0 && after.top < window.innerHeight,
      position: cs.position, height: Math.round(after.height),
    };
    window.scrollTo(0, 0);
    return res;
  });
  out[path].text = (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(0, 160);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
