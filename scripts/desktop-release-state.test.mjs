import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCompleteReleaseList,
  assertImmutablePublicRelease,
  assertQuarantinedState,
  classifyReleaseAssets,
  selectRestoreLatestTag,
} from "./desktop-release-state.mjs";

const assetNames = [
  "WorkLoom-mac-arm64.dmg",
  "WorkLoom-mac-x64.dmg",
  "WorkLoom-win-x64.exe",
  "WorkLoom-SHA512SUMS.txt",
  "WorkLoom-release-manifest.json",
];

function release(tagName, overrides = {}) {
  return {
    tagName,
    name: `WorkLoom Desktop ${tagName}`,
    isDraft: false,
    isPrerelease: false,
    isImmutable: true,
    isLatest: false,
    assets: assetNames.map((name) => ({ name, state: "uploaded", size: 1 })),
    ...overrides,
  };
}

test("latest recovery always prefers the highest remaining desktop stable release", () => {
  const fixtures = [
    {
      name: "wrong UI latest does not beat a desktop fallback",
      rows: [release("v3.0.0", { isDraft: true }), release("v2.9.0"), release("ui-v9.9.9", { isLatest: true })],
      initial: "ui-v9.9.9",
      expected: "v2.9.0",
    },
    {
      name: "empty initial latest still restores a desktop fallback",
      rows: [release("v3.0.0", { isDraft: true }), release("v2.8.0"), release("v2.9.0")],
      initial: "",
      expected: "v2.9.0",
    },
    {
      name: "non-desktop initial latest is never selected as a desktop fallback",
      rows: [release("v3.0.0", { isDraft: true }), release("ui-v9.9.9", { isLatest: true })],
      initial: "ui-v9.9.9",
      expected: "",
    },
    {
      name: "target is never selected as its own fallback",
      rows: [release("v3.0.0", { isDraft: true, isLatest: false })],
      initial: "v3.0.0",
      expected: "",
    },
  ];
  for (const fixture of fixtures) {
    assert.equal(selectRestoreLatestTag(fixture.rows, "v3.0.0", fixture.initial), fixture.expected, fixture.name);
  }
});

test("release list truncation is fail-closed in both selection and quarantine proof", () => {
  const truncated = Array.from({ length: 1000 }, (_, index) => release(`v1.0.${index}`));
  assert.throws(() => assertCompleteReleaseList(truncated), /截断/u);
  assert.throws(() => selectRestoreLatestTag(truncated, "v3.0.0", ""), /截断/u);
  assert.throws(() => assertQuarantinedState(truncated, "v3.0.0", ""), /截断/u);
});

test("quarantine proof catches wrong latest, non-draft target and ambiguous latest", () => {
  const good = [release("v3.0.0", { isDraft: true }), release("v2.9.0", { isLatest: true })];
  assert.doesNotThrow(() => assertQuarantinedState(good, "v3.0.0", "v2.9.0"));
  assert.throws(() => assertQuarantinedState(good, "v3.0.0", "ui-v9.9.9"), /最高健康/u);
  assert.throws(() => assertQuarantinedState([
    release("v3.0.0", { isDraft: false }),
    release("v2.9.0", { isLatest: true }),
  ], "v3.0.0", "v2.9.0"), /非 latest 草稿/u);
  assert.throws(() => assertQuarantinedState([
    release("v3.0.0", { isDraft: true }),
    release("v2.9.0", { isLatest: true }),
    release("v2.8.0", { isLatest: true }),
  ], "v3.0.0", "v2.9.0"), /latest 不唯一/u);
});

test("public release state proof requires GitHub immutability", () => {
  const immutable = release("v3.0.0");
  assert.doesNotThrow(() => assertImmutablePublicRelease(immutable, "v3.0.0", assetNames));
  assert.throws(
    () => assertImmutablePublicRelease({ ...immutable, isImmutable: false }, "v3.0.0", assetNames),
    /未进入 GitHub 不可变状态/u,
  );
  assert.throws(
    () => assertImmutablePublicRelease({ ...immutable, isDraft: true }, "v3.0.0", assetNames),
    /公开 Release 状态不正确/u,
  );
});

test("only a managed corrupt release may enter automatic quarantine", () => {
  const missing = assetNames.slice(0, -1).map((name) => ({ name, state: "uploaded", size: 1 }));
  assert.equal(classifyReleaseAssets(release("v3.0.0"), "v3.0.0", assetNames), "healthy");
  assert.equal(classifyReleaseAssets(release("v3.0.0", { assets: missing }), "v3.0.0", assetNames), "managed-corrupt");
  assert.equal(classifyReleaseAssets(release("v3.0.0", {
    name: "Legacy Desktop v3.0.0",
    assets: missing.filter((asset) => asset.name !== "WorkLoom-release-manifest.json"),
  }), "v3.0.0", assetNames), "legacy-incompatible");
});
