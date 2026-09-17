import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveHotelSeedBundle } from "./hotel-seed-preflight.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("酒店种子前置门禁", () => {
  it("缺少显式 BUNDLE_DIR 时在数据库连接前拒绝", () => {
    expect(() => resolveHotelSeedBundle(REPO_ROOT)).toThrow(/必须显式设置 BUNDLE_DIR=bundles\/hotel/);
  });

  it("脚本入口缺少显式 Bundle 时先拒绝，不尝试数据库连接", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        BUNDLE_DIR: " ",
        DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/should-not-connect",
        DATABASE_GATEWAY_URL: "postgres://invalid:invalid@127.0.0.1:1/should-not-connect",
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/必须显式设置 BUNDLE_DIR=bundles\/hotel/);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/ECONNREFUSED|connection refused/i);
  });

  it("错选 AI PM Bundle 时拒绝，不允许酒店脚本写入半成品", () => {
    expect(() => resolveHotelSeedBundle(REPO_ROOT, "bundles/ai-pm")).toThrow(/当前显式 Bundle 为 ai-pm/);
  });

  it("只接受通过清单完整性门禁的酒店 Bundle", () => {
    expect(resolveHotelSeedBundle(REPO_ROOT, "bundles/hotel")).toBe(join(REPO_ROOT, "bundles/hotel"));
  });

  it("拒绝越出 bundles 根目录", () => {
    expect(() => resolveHotelSeedBundle(REPO_ROOT, "../outside")).toThrow(/必须指向仓库 bundles/);
  });
});
