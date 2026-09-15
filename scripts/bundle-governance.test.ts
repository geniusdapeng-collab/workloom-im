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
});
