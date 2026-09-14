import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const clients = [
  { name: "B 端 PC", url: "http://127.0.0.1:3100/login", width: 1024, height: 640 },
  { name: "B 端移动", url: "http://127.0.0.1:3101", width: 360, height: 800 },
  { name: "C 端移动", url: "http://127.0.0.1:3102", width: 360, height: 800 },
] as const;

async function waitForStableUi(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#root").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
}

async function assertNoPageOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") return false;
        if (element.closest(".wl-visually-hidden, [aria-hidden='true']")) return false;
        if (["auto", "scroll"].includes(style.overflowX)) return false;
        return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2;
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className.toString().slice(0, 100),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        text: (element.textContent ?? "").trim().slice(0, 60),
      }));
    return {
      viewport: innerWidth,
      documentWidth: root.scrollWidth,
      offenders,
    };
  });
  expect(report.documentWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.viewport + 2);
  expect(report.offenders, JSON.stringify(report, null, 2)).toEqual([]);
}

for (const client of clients) {
  test(`${client.name}：WCAG 严重问题、窄屏与 200% 文字缩放门禁`, async ({ page }) => {
    await page.setViewportSize({ width: client.width, height: client.height });
    await page.goto(client.url);
    await waitForStableUi(page);

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = accessibility.violations.filter((item) => item.impact === "critical" || item.impact === "serious");
    expect(blocking.map((item) => ({ id: item.id, impact: item.impact, help: item.help, targets: item.nodes.map((node) => node.target) }))).toEqual([]);

    await assertNoPageOverflow(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await assertNoPageOverflow(page);
  });
}

test("共享按钮长中文可换行且不会溢出", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("http://127.0.0.1:3101");
  await waitForStableUi(page);
  const result = await page.evaluate(() => {
    const host = document.createElement("div");
    host.style.width = "180px";
    host.style.padding = "8px";
    const button = document.createElement("button");
    button.className = "wl-button wl-button--primary";
    button.textContent = "这是一段需要完整显示且不能溢出按钮边界的超长中文主操作文案";
    host.append(button);
    document.body.append(host);
    const value = {
      hostWidth: host.clientWidth,
      buttonWidth: button.getBoundingClientRect().width,
      buttonScrollWidth: button.scrollWidth,
      buttonClientWidth: button.clientWidth,
      whiteSpace: getComputedStyle(button).whiteSpace,
    };
    host.remove();
    return value;
  });
  expect(result.buttonWidth).toBeLessThanOrEqual(result.hostWidth);
  expect(result.buttonScrollWidth).toBeLessThanOrEqual(result.buttonClientWidth + 2);
  expect(result.whiteSpace).toBe("normal");
});

test("PC 只有左侧页面导航，布局控制可由键盘关闭", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("http://127.0.0.1:3100");
  await waitForStableUi(page);
  const skipWelcome = page.getByRole("button", { name: /跳过开场/ });
  if (await skipWelcome.isVisible()) {
    await skipWelcome.click();
    await expect(skipWelcome).toHaveCount(0);
  }
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(1);
  await expect(page.locator("header a[href]")).toHaveCount(0);
  await expect(page.getByPlaceholder("搜索页面")).toBeVisible();
  await page.getByRole("button", { name: "打开视图与布局" }).click();
  await expect(page.getByRole("dialog", { name: "视图与布局" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "视图与布局" })).toHaveCount(0);
});

test("B 端移动主导航与触控入口真实可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:3101");
  await waitForStableUi(page);
  const guest = page.getByRole("button", { name: "体验只读示例" });
  if (await guest.isVisible()) {
    await guest.click();
    await expect(page.getByRole("button", { name: "打开主导航" })).toBeVisible({ timeout: 15_000 });
  }
  await page.getByRole("button", { name: "打开主导航" }).click();
  await expect(page.getByRole("dialog", { name: "主导航" })).toBeVisible();
  await page.getByRole("button", { name: "关闭主导航" }).last().click();
  await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
});

test("C 端底部导航写入历史并支持浏览器返回", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:3102/#chat");
  await waitForStableUi(page);
  await page.getByRole("button", { name: /^服务/ }).click();
  await expect(page).toHaveURL(/#service$/);
  await page.goBack();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.getByRole("button", { name: /^对话/ })).toHaveAttribute("aria-current", "page");
});

test("三端静态视觉基线", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("http://127.0.0.1:3100/dev");
  await waitForStableUi(page);
  await expect(page).toHaveScreenshot("b-pc-reference.png", { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:3101");
  await waitForStableUi(page);
  await expect(page).toHaveScreenshot("b-mobile-auth.png", { fullPage: true });

  await page.route("**/c/**", (route) => route.abort());
  await page.goto("http://127.0.0.1:3102/#service");
  await waitForStableUi(page);
  await expect(page).toHaveScreenshot("c-mobile-reference.png", { fullPage: true });
});
