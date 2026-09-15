import { defineConfig } from "@playwright/test";

const reuseExistingServer = !process.env.CI;

// Playwright 的 webServer 探活遵循 HTTP(S)_PROXY。部分 CI runner 会注入代理却
// 没有完整的 NO_PROXY，导致已在回环地址启动的服务被误判为 120 秒超时。
// 合并而非覆盖 runner 既有白名单，并同时写入大小写键以兼容不同代理实现。
const noProxy = Array.from(new Set(
  [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost"]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean),
)).join(",");
process.env.NO_PROXY = noProxy;
process.env.no_proxy = noProxy;

export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "test-results/ui",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "line",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    locale: "zh-CN",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "SERVER_PORT=8877 SERVICE_C_WORKSPACE_ID=ws-aipm-demo SERVICE_C_DEMO_AUTH=true pnpm -C apps/server start",
      url: "http://127.0.0.1:8877/health",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: "VITE_ENABLE_UI_DIAGNOSTICS=true WEB_PORT=3100 SERVER_PORT=8877 pnpm -C apps/web dev -- --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:3100",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: "WEBB_PORT=3101 SERVER_PORT=8877 pnpm -C apps/webb dev -- --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:3101",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: "WEBC_PORT=3102 SERVER_PORT=8877 pnpm -C apps/webc dev -- --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:3102",
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
});
