import { defineConfig } from "@playwright/test";

const reuseExistingServer = !process.env.CI;

// 浏览器及应用请求仍可能遵循 HTTP(S)_PROXY：合并而非覆盖 runner 既有白名单，
// 并同时写入大小写键以兼容不同代理实现。webServer 自身使用 port（原始 TCP）
// 探活，避免 URL 探针被代理、健康接口内容或重定向影响。
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
      name: "base-api",
      command: "pnpm -C apps/server start",
      env: {
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: "8877",
        SERVICE_C_WORKSPACE_ID: "ws-aipm-demo",
        SERVICE_C_DEMO_AUTH: "true",
      },
      port: 8877,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "b-pc",
      command: "pnpm -C apps/web dev --host 127.0.0.1 --strictPort",
      env: {
        VITE_ENABLE_UI_DIAGNOSTICS: "true",
        WEB_PORT: "3100",
        SERVER_PORT: "8877",
      },
      port: 3100,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "b-mobile",
      command: "pnpm -C apps/webb dev --host 127.0.0.1 --strictPort",
      env: {
        WEBB_PORT: "3101",
        SERVER_PORT: "8877",
      },
      port: 3101,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "c-mobile",
      command: "pnpm -C apps/webc dev --host 127.0.0.1 --strictPort",
      env: {
        WEBC_PORT: "3102",
        SERVER_PORT: "8877",
      },
      port: 3102,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
});
