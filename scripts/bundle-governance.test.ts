import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixtureRoots: string[] = [];

function draftHotelFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wl-bundle-governance-"));
  fixtureRoots.push(root);
  cpSync(join(REPO_ROOT, "bundles/hotel"), join(root, "hotel"), { recursive: true });
  const manifestPath = join(root, "hotel/bundle.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workloom.status = "draft";
  delete manifest.integrity;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function emptyFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wl-bundle-composition-"));
  fixtureRoots.push(root);
  return root;
}

function addDraftBundle(
  root: string,
  bundleId: string,
  options: {
    dependencies?: Array<{ bundleId: string; version: string }>;
    route?: string;
    terminology?: Record<string, string>;
    version?: string;
  } = {},
): void {
  const directory = join(root, bundleId);
  cpSync(join(REPO_ROOT, "bundles/hotel"), directory, { recursive: true });
  const manifestPath = join(directory, "bundle.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = `@workloom/${bundleId}`;
  manifest.version = options.version ?? "1.0.0";
  manifest.workloom.industry = bundleId;
  manifest.workloom.displayName = `测试行业包${bundleId}`;
  manifest.workloom.status = "draft";
  manifest.workloom.dependencies = options.dependencies ?? [];
  manifest.workloom.ui.terminology = options.terminology ?? {};
  manifest.workloom.ui.permissions = options.route ? [`${bundleId}.dashboard.read`] : [];
  manifest.workloom.ui.navigation.slots = options.route ? [{
    capabilityId: `${bundleId}.dashboard`,
    title: "行业看板",
    route: options.route,
    group: "operations",
    icon: "executive",
    clients: ["pc"],
    permissions: [`${bundleId}.dashboard.read`],
  }] : [];
  delete manifest.integrity;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function editPreset(root: string, name: string, edit: (preset: Record<string, unknown>) => void): void {
  const path = join(root, "hotel/presets", name);
  const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(preset);
  writeFileSync(path, YAML.stringify(preset));
}

function runGovernance(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/bundle-governance.mts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, BUNDLES_ROOT: root },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("行业包治理岗位契约", () => {
  it("治理器只依赖可随 base-sync 下发的行业契约，不读取共享 UI 源码", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/bundle-governance.mts"), "utf8");
    expect(source).toContain("packages/industry-contract/src/index.ts");
    expect(source).not.toContain("packages/ui/src");
  });

  it.each([
    {
      label: "缺少 coverage",
      mutate: (root: string) => editPreset(root, "pricing-agent.yml", (preset) => { delete preset.coverage; }),
      expected: /pricing-agent\.yml.*coverage/s,
    },
    {
      label: "缺少 night_shift",
      mutate: (root: string) => editPreset(root, "pricing-agent.yml", (preset) => { delete preset.night_shift; }),
      expected: /pricing-agent\.yml.*night_shift/s,
    },
    {
      label: "重复事件前缀",
      mutate: (root: string) => editPreset(root, "review-agent.yml", (preset) => {
        preset.coverage = [{ eventPrefix: "price.", label: "重复覆盖" }];
      }),
      expected: /事件前缀 price\. 已由岗位 pricing-agent 认领/,
    },
  ])("$label 时治理门禁失败关闭", ({ mutate, expected }) => {
    const root = draftHotelFixture();
    mutate(root);
    const result = runGovernance(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(expected);
  });

  it("发布前阻断缺失依赖、精确版本漂移与循环依赖", () => {
    const missingRoot = emptyFixtureRoot();
    addDraftBundle(missingRoot, "primary", { dependencies: [{ bundleId: "missing", version: "1.0.0" }] });
    expect(runGovernance(missingRoot).output).toMatch(/依赖行业包 missing@1\.0\.0 不存在/);

    const driftRoot = emptyFixtureRoot();
    addDraftBundle(driftRoot, "dependency", { version: "2.0.0" });
    addDraftBundle(driftRoot, "primary", { dependencies: [{ bundleId: "dependency", version: "1.0.0" }] });
    expect(runGovernance(driftRoot).output).toMatch(/依赖 dependency 要求 1\.0\.0，实际为 2\.0\.0/);

    const cycleRoot = emptyFixtureRoot();
    addDraftBundle(cycleRoot, "alpha", { dependencies: [{ bundleId: "beta", version: "1.0.0" }] });
    addDraftBundle(cycleRoot, "beta", { dependencies: [{ bundleId: "alpha", version: "1.0.0" }] });
    expect(runGovernance(cycleRoot).output).toMatch(/组合依赖形成循环/);
  });

  it("发布前阻断组合导航、术语与依赖首页槽位冲突", () => {
    const root = emptyFixtureRoot();
    addDraftBundle(root, "hotel-core", { route: "/industry-dashboard", terminology: { customer: "住客" } });
    addDraftBundle(root, "video-core", { route: "/industry-dashboard", terminology: { customer: "观众" } });
    addDraftBundle(root, "primary", {
      dependencies: [
        { bundleId: "hotel-core", version: "1.0.0" },
        { bundleId: "video-core", version: "1.0.0" },
      ],
    });
    const output = runGovernance(root).output;
    expect(output).toMatch(/导航路由 \/industry-dashboard/);
    expect(output).toMatch(/组合术语 customer/);
    expect(output).toMatch(/依赖首页槽位 home\.quick-tasks:pc/);
  });
});
