import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRelease } from "./ui-upgrade-pr.mjs";

describe("UI 稳定发布门禁", () => {
  it("清单、包和目标三个版本必须完全一致", () => {
    const manifest = { ui: { latestStableVersion: "1.2.3" } };
    assert.equal(validateRelease(manifest, { version: "1.2.3" }, "1.2.3"), true);
    assert.throws(() => validateRelease(manifest, { version: "1.2.2" }, "1.2.3"), /包版本/);
    assert.throws(() => validateRelease({ ui: { latestStableVersion: null } }, { version: "1.2.3" }, "1.2.3"), /尚未登记/);
  });
});
