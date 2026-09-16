import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const repoRoot = new URL("../", import.meta.url);
const workflowsUrl = new URL("../.github/workflows/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("./action-pins.json", import.meta.url), "utf8"));

function collectUses(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectUses(entry, found);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "uses" && typeof entry === "string") found.push(entry);
      collectUses(entry, found);
    }
  }
  return found;
}

function policyFiles() {
  const workflows = readdirSync(workflowsUrl)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [`.github/workflows/${name}`, new URL(name, workflowsUrl)]);
  return [
    ...workflows,
    ["sync/heartbeat-template.yml", new URL("../sync/heartbeat-template.yml", import.meta.url)],
    ["sync/ui-consumer-template.yml", new URL("../sync/ui-consumer-template.yml", import.meta.url)],
  ];
}

function assertTrustedAction(use, location) {
  if (use.startsWith("./")) return;
  if (use.startsWith("docker://")) {
    assert.match(use, /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/u, `${location}: container Action must use an immutable sha256 digest`);
    return;
  }
  const match = /^([^@\s]+)@([0-9a-f]{40})$/u.exec(use);
  assert.ok(match, `${location}: remote Action must use a full 40-character commit SHA: ${use}`);
  const [, action, sha] = match;
  assert.ok(manifest.actions[action], `${location}: ${action} is absent from scripts/action-pins.json`);
  assert.equal(sha, manifest.actions[action].sha, `${location}: ${action} does not match the reviewed pin`);
  assert.match(manifest.actions[action].version, /^v\d+\.\d+\.\d+$/u);
}

test("every workflow and propagated template uses only reviewed immutable Action commits", () => {
  const seen = new Set();
  for (const [name, url] of policyFiles()) {
    const workflow = YAML.parse(readFileSync(url, "utf8"));
    for (const use of collectUses(workflow)) {
      assertTrustedAction(use, name);
      if (!use.startsWith("./") && !use.startsWith("docker://")) seen.add(use.split("@")[0]);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(manifest.actions).sort());
});

test("checkout never persists the workflow token into repository Git config", () => {
  for (const [name, url] of policyFiles()) {
    const workflow = YAML.parse(readFileSync(url, "utf8"));
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (String(value.uses ?? "").startsWith("actions/checkout@")) {
        assert.equal(value.with?.["persist-credentials"], false, `${name}: checkout must disable credential persistence`);
      }
      Object.values(value).forEach(visit);
    };
    visit(workflow);
  }
});

test("mutable tags, branches, abbreviated SHAs and unreviewed Actions fail closed", () => {
  for (const use of [
    "actions/checkout@v4",
    "actions/checkout@main",
    "actions/checkout@11d5960",
    "unknown/publisher@1111111111111111111111111111111111111111",
    "docker://alpine:latest",
    "docker://alpine@sha256:1234",
  ]) {
    assert.throws(() => assertTrustedAction(use, "mutation.yml"));
  }
});

test("pin manifest is repository data, not a generated or external trust input", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(readFileSync(new URL("./scripts/action-pins.json", repoRoot), "utf8").endsWith("\n"));
});
