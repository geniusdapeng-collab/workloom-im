import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadProfile } from "../profile.mjs";
import { resolveEnvironment } from "../target.mjs";
import { resolveLiveModels } from "./providers.mjs";
import { LIVE_BUDGET_CAPS } from "./budget.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const temporaryProfile = (t, raw) => {
  const dir = mkdtempSync(join(tmpdir(), "rdas-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify(raw));
  return { dir, path };
};

describe("profile and provider closure without any network or credential store", () => {
  it("loads this physical repository's complete profile without modifying contracts", (t) => {
    t.mock.method(globalThis, "fetch", () => assert.fail("pure profile closure must not call a network"));
    const path = join(repo, "acceptance/profile.json");
    const before = readFileSync(path);
    const raw = JSON.parse(before);
    const { profile } = loadProfile(repo);
    assert.deepEqual(profile.identity, { human: "MEM-001", workspaceSlug: null, guest: "demo-direct", ...raw.identity });
    assert.deepEqual(profile.surfaces.pcRoutes, raw.surfaces.pcRoutes);
    assert.equal(profile.primaryBundle, raw.primaryBundle);
    if (raw.live?.tasks) assert.deepEqual(profile.live.tasks, raw.live.tasks);
    if (raw.live?.models) assert.deepEqual(profile.live.models, raw.live.models);
    for (const [key, cap] of Object.entries(LIVE_BUDGET_CAPS)) {
      assert.equal(profile.live.budgets[key], raw.live?.budgets?.[key] ?? cap);
    }
    const target = resolveEnvironment(profile);
    assert.equal(target.kind, "local-preview");
    assert.equal(target.allowWrites, false);
    const models = resolveLiveModels(profile.live.models, {});
    assert.equal(models.filter((m) => m.adapter !== "product-dispatch").every((m) => !m.ready), true);
    assert.ok(readFileSync(path).equals(before));
    t.diagnostic(JSON.stringify({ repo, schema: profile.schemaVersion, bundle: profile.primaryBundle, liveTasks: profile.live.tasks.length, profileUnchanged: true, networkCalls: 0, realCredentials: false }));
  });

  it("legacy v1 profiles retain compatibility and stricter budget declarations", (t) => {
    const { dir, path } = temporaryProfile(t, { schemaVersion: "workloom.acceptance-profile/v1", primaryBundle: "fixture", identity: { workspaceSlug: "local" }, live: { budgets: { maxLlmTokens: 5 } } });
    const { profile, warnings } = loadProfile(dir, path);
    assert.equal(profile.live.budgets.maxLlmTokens, 5);
    assert.equal(profile.identity.workspaceSlug, "local");
    assert.ok(warnings.some((w) => w.includes("v1")));
    assert.equal(profile.live.enabled, false);
    assert.equal(profile.live.tasks.length, 0);
  });

  it("an invalid on-disk limit fails before any paid action can start", (t) => {
    const { dir, path } = temporaryProfile(t, { schemaVersion: "workloom.acceptance-profile/v2", live: { budgets: { maxLlmTokens: -1 } } });
    assert.throws(() => loadProfile(dir, path), /live\.budgets\.maxLlmTokens/);
  });

  it("environment write permission and dialects remain explicit", (t) => {
    const { dir } = temporaryProfile(t, {});
    const profile = { environment: { kind: "deployed", supportDir: dir, target: { apiUrl: "http://127.0.0.1:1" } } };
    assert.equal(resolveEnvironment(profile).allowWrites, false);
    assert.equal(resolveEnvironment(profile, { allowProdWrites: true }).allowWrites, true);
    assert.equal(resolveEnvironment(profile).isProduction, true);
    const models = resolveLiveModels([
      { id: "dsh", kind: "llm", adapter: "dsh-harness", baseUrlEnv: "DEEPSEEK_BASE_URL" },
      { id: "gateway", kind: "llm", adapter: "model-gateway", baseUrlEnv: "DEEPSEEK_BASE_URL" },
    ], { DEEPSEEK_API_KEY: "stub-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/anthropic", LLM_BASE_URL: "http://127.0.0.1:1" });
    assert.equal(models[0].baseUrlDialect, "anthropic");
    assert.equal(models[0].baseUrl, "http://127.0.0.1:1/anthropic");
    assert.equal(models[1].baseUrlDialect, "openai");
    assert.equal(models[1].baseUrl, "http://127.0.0.1:1");
  });
});
