import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function enterOwnerDemo(page: Page, next = "/") {
  await page.goto(`http://127.0.0.1:3100/login?next=${encodeURIComponent(next)}`);
  await waitForStableUi(page);
  const demoEntry = page.getByRole("button", { name: /开发演示：直接进入演示身份/ });
  await demoEntry.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === next, { timeout: 15_000 });
  const welcome = page.locator("[data-welcome-phase]");
  if (next === "/") {
    await expect(page.locator('[data-product-ready="true"]')).toBeVisible({ timeout: 15_000 });
    // 欢迎状态与经营主页数据并行读取；等待“显示欢迎”或“可重播”之一，避免异步欢迎在检查开始后才盖住页面。
    await expect(welcome.or(page.getByRole("button", { name: "重播欢迎" })).first()).toBeVisible({ timeout: 15_000 });
  }
  if (await welcome.isVisible()) {
    const leaveWelcome = welcome.getByRole("button", { name: /跳过开场|稍后继续|进入系统/ }).first();
    if (await leaveWelcome.isVisible()) {
      await leaveWelcome.click();
      await expect(welcome).toHaveCount(0);
    }
  }
}

async function enterBMobileOwner(page: Page, next = "/") {
  await enterOwnerDemo(page);
  const token = await page.evaluate(() => localStorage.getItem("workloom:workloom-im:b-pc:access-token"));
  expect(token, "PC 开发身份应返回可供同源 B 端验证的短期访问令牌").toBeTruthy();
  await page.goto(`http://127.0.0.1:3101${next}`);
  await page.evaluate((value) => {
    sessionStorage.setItem("workloom:workloom-im:b-mobile:access-token", value ?? "");
  }, token);
  await page.reload();
  await waitForStableUi(page);
  await expect(page.getByRole("button", { name: "打开主导航" })).toBeVisible({ timeout: 15_000 });
}

async function assertNoPageOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
        if (element.matches(".wl-bottom-tabs__label") && style.overflowX === "hidden" && style.webkitLineClamp === "2") return false;
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
    const verticallyClipped = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], .wl-badge, .wl-status-chip, [class~='overflow-hidden']"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
        if (element.matches(".wl-bottom-tabs__label, .wl-text-ellipsis")) return false;
        return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 2;
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className.toString().slice(0, 100),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        text: (element.textContent ?? "").trim().slice(0, 60),
      }));
    const fixedOffenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position !== "fixed" || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
        if (element.matches(".wl-skip-link:not(:focus)")) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (
          rect.left < -2 || rect.right > innerWidth + 2 || rect.top < -2 || rect.bottom > innerHeight + 2
        );
      })
      .slice(0, 12)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className.toString().slice(0, 100),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
    return {
      viewport: innerWidth,
      viewportHeight: innerHeight,
      documentWidth: root.scrollWidth,
      offenders,
      verticallyClipped,
      fixedOffenders,
    };
  });
  expect(report.documentWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.viewport + 2);
  expect(report.offenders, JSON.stringify(report, null, 2)).toEqual([]);
  expect(report.verticallyClipped, JSON.stringify(report, null, 2)).toEqual([]);
  expect(report.fixedOffenders, JSON.stringify(report, null, 2)).toEqual([]);
}

async function injectLongChineseSamples(page: Page) {
  const samples = [
    {
      locator: page.locator("main h1:visible, main h2:visible, main h3:visible").first(),
      text: "这是来自行业投影的超长中文页面标题，需要在当前内容区域内自然换行且绝不越界",
    },
    {
      locator: page.locator("main button:visible, main [role='button']:visible").first(),
      text: "这是来自行业投影的超长中文动态操作名称，需要在当前按钮内自然换行且绝不越界",
    },
    {
      locator: page.locator("main .wl-badge:visible, main .wl-status-chip:visible, main .status-strip:visible").first(),
      text: "等待业务负责人确认后继续执行",
    },
    {
      locator: page.locator(".wl-bottom-tabs__label:visible").first(),
      text: "今日经营协作总览",
    },
  ];
  for (const sample of samples) {
    if (await sample.locator.count() === 0) continue;
    await sample.locator.evaluate((element, text) => { element.textContent = text; }, sample.text);
  }
}

async function applyAndAssert200PercentText(page: Page) {
  const sample = page.locator("main h1:visible, main h2:visible, main h3:visible, main p:visible").first();
  await expect(sample).toBeVisible();
  const normalSize = await sample.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const scaledSize = await sample.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(scaledSize, "200% 门禁必须真的放大页面文字，不能被固定 px 字号绕过").toBeGreaterThanOrEqual(normalSize * 1.8);
}

async function assertPrimaryNavigationFullyVisible(page: Page) {
  const navigation = page.locator(".wl-bottom-tabs:visible").first();
  if (await navigation.count() === 0) return;
  const report = await navigation.evaluate((element) => {
    const host = element.querySelector<HTMLElement>(".wl-bottom-tabs__items");
    const items = Array.from(element.querySelectorAll<HTMLElement>(".wl-bottom-tabs__item"));
    const labels = Array.from(element.querySelectorAll<HTMLElement>(".wl-bottom-tabs__label"));
    const hostRect = host?.getBoundingClientRect();
    return {
      hostClientWidth: host?.clientWidth ?? 0,
      hostScrollWidth: host?.scrollWidth ?? 0,
      navigationRect: (() => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })(),
      itemWidths: items.map((item) => item.getBoundingClientRect().width),
      itemsInside: items.every((item) => {
        const rect = item.getBoundingClientRect();
        return Boolean(hostRect) && rect.left >= hostRect.left - 2 && rect.right <= hostRect.right + 2;
      }),
      labels: labels.map((label) => ({
        text: label.textContent?.trim() ?? "",
        lineClamp: getComputedStyle(label).webkitLineClamp,
      })),
    };
  });
  expect(report.hostScrollWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.hostClientWidth + 2);
  expect(report.itemsInside, JSON.stringify(report, null, 2)).toBe(true);
  expect(Math.min(...report.itemWidths), JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(44);
  expect(report.navigationRect.left).toBeGreaterThanOrEqual(-2);
  expect(report.navigationRect.right).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 2);
  expect(report.navigationRect.top).toBeGreaterThanOrEqual(-2);
  expect(report.navigationRect.bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 2);
  expect(report.labels.every((label) => label.text.length > 0)).toBe(true);
}

async function expectInsideViewport(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect, "目标浮层应具有可见边界").not.toBeNull();
  const viewport = locator.page().viewportSize();
  expect(viewport, "测试必须设置固定视口").not.toBeNull();
  if (!rect || !viewport) return;
  expect(rect.x).toBeGreaterThanOrEqual(-2);
  expect(rect.y).toBeGreaterThanOrEqual(-2);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 2);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 2);
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
    await applyAndAssert200PercentText(page);
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
  await enterOwnerDemo(page);
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(1);
  await expect(page.locator("header a[href]")).toHaveCount(0);
  await expect(page.getByPlaceholder("搜索页面")).toBeVisible();
  await page.getByRole("button", { name: "打开视图与布局" }).click();
  await expect(page.getByRole("dialog", { name: "视图与布局" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "视图与布局" })).toHaveCount(0);
});

test("PC 窄屏主导航圈定焦点，Esc 关闭后恢复触发点", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await enterOwnerDemo(page);
  const trigger = page.getByRole("button", { name: "展开主导航" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "主导航" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("data-wl-managed-surface", "navigation-drawer");
  await expect(page.getByPlaceholder("搜索页面")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("PC 工作区首帧按真实容器宽度采用安全布局", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await enterOwnerDemo(page);

  // 故意延迟 ResizeObserver，证明首帧安全布局依赖同步 clientWidth 测量，
  // 而不是碰巧等到了异步 observer 回调或测试重试。
  await page.addInitScript(() => {
    type FirstShellFrame = {
      hostPaddingRight: number;
      assistantWidth: number;
      documentWidth: number;
      viewportWidth: number;
    };
    const state = window as unknown as { __workloomFirstShellFrame?: FirstShellFrame };
    document.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        const host = document.querySelector<HTMLElement>(".wl-page-host");
        if (!host || state.__workloomFirstShellFrame) return;
        const assistant = document.querySelector<HTMLElement>('[data-wl-managed-surface="assistant-rail"]');
        state.__workloomFirstShellFrame = {
          hostPaddingRight: Number.parseFloat(getComputedStyle(host).paddingRight),
          assistantWidth: assistant?.getBoundingClientRect().width ?? 0,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        };
        observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });

    const NativeResizeObserver = window.ResizeObserver;
    class DelayedResizeObserver {
      private readonly native: ResizeObserver;
      constructor(callback: ResizeObserverCallback) {
        this.native = new NativeResizeObserver((entries, observer) => {
          window.setTimeout(() => callback(entries, observer), 1_000);
        });
      }
      observe(target: Element, options?: ResizeObserverOptions) { this.native.observe(target, options); }
      unobserve(target: Element) { this.native.unobserve(target); }
      disconnect() { this.native.disconnect(); }
    }
    Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: DelayedResizeObserver });
  });

  await page.goto("http://127.0.0.1:3100/night");
  const firstShellFrame = await page.waitForFunction(() => (
    window as unknown as { __workloomFirstShellFrame?: unknown }
  ).__workloomFirstShellFrame).then((handle) => handle.jsonValue() as Promise<{
    hostPaddingRight: number;
    assistantWidth: number;
    documentWidth: number;
    viewportWidth: number;
  }>);
  expect(firstShellFrame.hostPaddingRight).toBeLessThanOrEqual(64);
  expect(firstShellFrame.assistantWidth).toBeLessThanOrEqual(64);
  expect(firstShellFrame.documentWidth).toBeLessThanOrEqual(firstShellFrame.viewportWidth + 2);

  const grid = page.locator(".wl-bridge-grid--managed");
  await grid.waitFor({ state: "visible" });

  const readLayout = () => grid.evaluate((element) => {
    const shell = element.closest<HTMLElement>(".wl-bridge-shell");
    const sides = Array.from(element.querySelectorAll<HTMLElement>(".wl-bridge-left, .wl-bridge-right"));
    return {
      shellWidth: shell?.clientWidth ?? 0,
      clientWidth: (element as HTMLElement).clientWidth,
      scrollWidth: (element as HTMLElement).scrollWidth,
      sidesHidden: sides.every((side) => side.hidden || getComputedStyle(side).display === "none"),
    };
  });
  const firstFrame = await readLayout();
  expect(firstFrame.shellWidth).toBeLessThanOrEqual(650);
  expect(firstFrame.scrollWidth, JSON.stringify(firstFrame)).toBeLessThanOrEqual(firstFrame.clientWidth + 2);
  expect(firstFrame.sidesHidden, JSON.stringify(firstFrame)).toBe(true);

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const stableFrame = await readLayout();
  expect(stableFrame.scrollWidth, JSON.stringify(stableFrame)).toBeLessThanOrEqual(stableFrame.clientWidth + 2);
  expect(stableFrame.sidesHidden, JSON.stringify(stableFrame)).toBe(true);
});

test("PC 关键公共能力在窄视口与 200% 文字下不溢出", async ({ page }) => {
  // 该门禁会串行覆盖 9 个真实路由 × 2 个视口，并分别检查正常与 200% 字号。
  // 明确标记为慢测试，避免把矩阵运行时长误判为单页面卡死。
  test.slow();
  const routes = ["/", "/approvals", "/events", "/exams", "/memory", "/night", "/models", "/members", "/partners"];
  await page.setViewportSize({ width: 1024, height: 720 });
  await enterOwnerDemo(page);

  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 720 });
    for (const route of routes) {
      await page.goto(`http://127.0.0.1:3100${route}`);
      await waitForStableUi(page);
      await assertNoPageOverflow(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await page.waitForTimeout(100);
      await assertNoPageOverflow(page);
    }
  }
});

test("PC 真实四层浮层按层级显示，Esc 后进先出", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await enterOwnerDemo(page, "/service");
  await expect(page.getByRole("heading", { name: "服务前台" })).toBeVisible();

  const ask = page.locator('[aria-label="AI 助手"]');
  await expect(ask).toBeVisible();
  const mateTrigger = page.locator('[role="button"][title*="点击聊聊"]').first();
  await mateTrigger.focus();
  const mateBeforeMove = await mateTrigger.boundingBox();
  await page.keyboard.press("Shift+ArrowLeft");
  const mateAfterMove = await mateTrigger.boundingBox();
  expect(mateBeforeMove).not.toBeNull();
  expect(mateAfterMove).not.toBeNull();
  if (mateBeforeMove && mateAfterMove) expect(mateAfterMove.x).toBeLessThan(mateBeforeMove.x);
  await page.keyboard.press("Enter");
  const mate = page.locator('[aria-label="小织助手面板"]');
  await expect(mate).toBeVisible();

  const details = page.getByRole("button", { name: "详情" }).first();
  await expect(details).toBeVisible({ timeout: 15_000 });
  await details.click();
  await expect(page.getByRole("dialog", { name: "文档详情" })).toBeVisible();
  // 顶层确认框打开时，外层抽屉应保留但会被正确标记为 inert/aria-hidden；
  // 因此后续用共享表面标记定位，而不是要求辅助技术同时暴露两个模态框。
  const drawer = page.locator('[data-wl-managed-surface="drawer"]').last();
  const statusAction = drawer.getByRole("button", { name: /停用|置为/ }).first();
  await statusAction.click();
  const confirmation = page.getByRole("alertdialog", { name: /确认(?:停用|启用)知识文档/ });
  await expect(confirmation).toBeVisible();

  const layers = await page.evaluate(() => {
    const z = (element: Element | null) => element ? (Number.parseInt(getComputedStyle(element).zIndex || "0", 10) || 0) : -1;
    const askElement = document.querySelector('[aria-label="AI 助手"]');
    const drawerPanel = document.querySelector('[role="dialog"][aria-labelledby]');
    const confirmPanel = document.querySelector('[role="alertdialog"]');
    return {
      assistant: z(askElement),
      drawer: z(drawerPanel?.parentElement ?? null),
      dialog: z(confirmPanel?.parentElement ?? null),
    };
  });
  expect(layers.drawer).toBeGreaterThan(layers.assistant);
  expect(layers.dialog).toBeGreaterThan(layers.drawer);
  await expectInsideViewport(ask);
  await expectInsideViewport(mate);
  await expectInsideViewport(drawer);
  await expectInsideViewport(confirmation);
  await expect(ask).toHaveAttribute("data-wl-managed-surface", "assistant-rail");
  await expect(mate.locator("xpath=ancestor::*[@data-wl-managed-surface][1]")).toHaveAttribute("data-wl-managed-surface", "assistant-companion");
  await expect(drawer).toHaveAttribute("data-wl-managed-surface", "drawer");
  await expect(confirmation).toHaveAttribute("data-wl-managed-surface", "dialog");
  const assistantOverlap = await Promise.all([ask.boundingBox(), mate.boundingBox()]).then(([left, right]) => {
    if (!left || !right) return -1;
    const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
    const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
    return width * height;
  });
  expect(assistantOverlap).toBe(0);

  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(mate).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(mate).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mate).toHaveCount(0);
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-wl-managed-surface="assistant-rail"]')).toHaveCount(0);
});

test("PC 键盘完成登录、定位待审、打开裁决并进入事件账本", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await enterOwnerDemo(page, "/approvals");
  await expect(page.getByRole("heading", { name: "审批中心" })).toBeVisible();

  const reject = page.getByRole("button", { name: /制动\s*驳回/ }).first();
  await expect(reject).toBeVisible({ timeout: 15_000 });
  await reject.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "选择驳回原因" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "选择驳回原因" })).toHaveCount(0);

  // 信任治理分组默认折叠（2026-09 易用性批次）：先展开分组再进入事件账本
  await page.getByRole("button", { name: "信任治理" }).click();
  const ledger = page.getByRole("button", { name: "事件账本" }).first();
  await ledger.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByText("事件账本", { exact: true }).first()).toBeVisible();
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

test("B 端移动关键公共能力在窄屏、长中文与 200% 文字下不溢出", async ({ page }) => {
  const routes = ["/", "/inbox", "/tasks", "/operations", "/events", "/exams", "/memory", "/night", "/models", "/account"];
  await page.setViewportSize({ width: 390, height: 844 });
  await enterBMobileOwner(page);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    for (const route of routes) {
      await page.goto(`http://127.0.0.1:3101${route}`);
      await waitForStableUi(page);
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      if (width === 320 && route === "/") {
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(accessibility.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
      }
      await injectLongChineseSamples(page);
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      await applyAndAssert200PercentText(page);
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
  }
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

test("C 端移动完整主流程页面在窄屏、长中文与 200% 文字下不溢出", async ({ page }) => {
  const tabs = [
    ["chat", /AI 服务前台/],
    ["service", /^服务大厅$/],
    ["tickets", /^我的工单$/],
    ["messages", /^消息通知$/],
    ["me", /^我的$/],
  ] as const;
  const successfulServiceResponses: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/c/") && response.ok()) successfulServiceResponses.push(url.pathname);
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    for (const [tab, heading] of tabs) {
      await page.goto(`http://127.0.0.1:3102/#${tab}`);
      await waitForStableUi(page);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      await injectLongChineseSamples(page);
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      await applyAndAssert200PercentText(page);
      await assertNoPageOverflow(page);
      await assertPrimaryNavigationFullyVisible(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
  }
  expect(successfulServiceResponses.length, "C 端主流程必须消费真实本地服务响应，不能以全量中断请求的错误态冒充完整页面验收").toBeGreaterThan(0);
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
