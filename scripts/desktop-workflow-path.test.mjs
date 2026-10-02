import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDesktopWorkflowPath, CURRENT_WORKFLOW, LEGACY_WORKFLOW } from "./desktop-workflow-path.mjs";

const product = { productId: "fixture-industry", repository: "fixture/industry", release: { workflow: ".cnb.yml" } };
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "workloom-workflow-owner-"));
  const governance = join(parent, "governance");
  mkdirSync(governance);
  mkdirSync(join(parent, ".git"));
  writeFileSync(join(parent, ".cnb.yml"), "main: {}\n");
  writeFileSync(join(parent, "product.manifest.json"), JSON.stringify(product));
  return { parent, governance, close: () => rmSync(parent, { recursive: true, force: true }) };
}

test("configured repository-local CNB workflow takes precedence", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.governance, ".cnb.yml"), "main: {push: []}\n");
    assert.deepEqual(resolveDesktopWorkflowPath(item.governance, product), {
      relative: ".cnb.yml", absolute: join(item.governance, ".cnb.yml"), configured: true,
    });
  } finally { item.close(); }
});

test("governance may resolve its exact product's immediate Git-root CNB workflow", () => {
  const item = fixture();
  try { assert.equal(resolveDesktopWorkflowPath(item.governance, product).absolute, join(item.parent, ".cnb.yml")); }
  finally { item.close(); }
});

for (const [name, changed] of [
  ["different product", { ...product, productId: "other-industry" }],
  ["different repository", { ...product, repository: "fixture/other" }],
  ["different configured owner workflow", { ...product, release: { workflow: CURRENT_WORKFLOW } }],
  ["missing product identity", { release: { workflow: ".cnb.yml" } }],
]) {
  test(`parent fallback refuses ${name}`, () => {
    const item = fixture();
    try {
      writeFileSync(join(item.parent, "product.manifest.json"), JSON.stringify(changed));
      assert.equal(resolveDesktopWorkflowPath(item.governance, product).absolute, join(item.governance, ".cnb.yml"));
    } finally { item.close(); }
  });
}

test("parent fallback requires an immediate Git root and does not scan ancestors", () => {
  const item = fixture();
  try {
    const nested = join(item.governance, "nested");
    mkdirSync(nested);
    assert.equal(resolveDesktopWorkflowPath(nested, product).absolute, join(nested, ".cnb.yml"));
    rmSync(join(item.parent, ".git"), { recursive: true });
    assert.equal(resolveDesktopWorkflowPath(item.governance, product).absolute, join(item.governance, ".cnb.yml"));
  } finally { item.close(); }
});

test("malformed parent identity fails with a useful error", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.parent, "product.manifest.json"), "{");
    assert.throws(() => resolveDesktopWorkflowPath(item.governance, product), /不是合法 JSON/u);
  } finally { item.close(); }
});

test("configured paths reject traversal, absolute paths and arbitrary script files", () => {
  for (const workflow of ["../.cnb.yml", "/tmp/release.yml", ".github/workflows/../other.yml", "scripts/release.sh", "\\.cnb.yml"]) {
    assert.throws(() => resolveDesktopWorkflowPath("/fixture", { release: { workflow } }), /不得越界/u);
  }
});

test("existing Github default and legacy paths remain supported", () => {
  const item = fixture();
  try {
    mkdirSync(join(item.governance, ".github", "workflows"), { recursive: true });
    writeFileSync(join(item.governance, LEGACY_WORKFLOW), "name: legacy\n");
    assert.equal(resolveDesktopWorkflowPath(item.governance).relative, LEGACY_WORKFLOW);
    writeFileSync(join(item.governance, CURRENT_WORKFLOW), "name: current\n");
    assert.equal(resolveDesktopWorkflowPath(item.governance).relative, CURRENT_WORKFLOW);
    assert.equal(resolveDesktopWorkflowPath(item.governance, { release: { workflow: LEGACY_WORKFLOW } }).relative, LEGACY_WORKFLOW);
  } finally { item.close(); }
});
