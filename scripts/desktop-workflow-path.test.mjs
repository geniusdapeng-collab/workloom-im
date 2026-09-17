import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveDesktopWorkflowPath } from "./desktop-workflow-path.mjs";

test("base pins the new publisher while existing industry repositories retain a safe migration path", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-desktop-workflow-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/build-desktop.yml"), "name: legacy\n");
    assert.equal(resolveDesktopWorkflowPath(root, {}).relative, ".github/workflows/build-desktop.yml");
    assert.equal(
      resolveDesktopWorkflowPath(root, { release: { workflow: ".github/workflows/desktop-production-release.yml" } }).relative,
      ".github/workflows/desktop-production-release.yml",
    );
    assert.throws(
      () => resolveDesktopWorkflowPath(root, { release: { workflow: "../../outside.yml" } }),
      /不得越界/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
