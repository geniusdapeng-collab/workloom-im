const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readIndustryContract, requiredIndustryParts, runtimeReference, resolveIndustryRuntime } = require("./industry-runtime.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-industry-runtime-"));
  const runtime = path.join(root, "runtime");
  const support = path.join(root, "support");
  fs.mkdirSync(path.join(runtime, "industry"), { recursive: true });
  fs.mkdirSync(path.join(support, "python", "bin"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "product.manifest.json"), JSON.stringify({ productId: "fixture-industry" }));
  fs.writeFileSync(path.join(runtime, "industry", "main.py"), "print('offline-fixture-ok')\n");
  fs.writeFileSync(path.join(support, "python", "bin", "python3"), "fixture executable\n");
  const contract = { schemaVersion: "workloom.industry-runtime/v1", productId: "fixture-industry", target: "mac-arm64",
    requiredParts: ["python"], requiredFiles: [{ root: "runtime", path: "industry/main.py" }, { root: "support", path: "python/bin/python3" }],
    environment: { INDUSTRY_ROOT: { root: "runtime", path: "industry", required: true }, INDUSTRY_PYTHON: { root: "support", path: "python/bin/python3", required: true }, INDUSTRY_MODE: "offline" },
    selftests: [{ name: "offline_import", executable: { root: "support", path: "python/bin/python3" }, args: ["-c", "print('offline-fixture-ok')"], expectedStdout: "offline-fixture-ok" }] };
  const save = (value = contract) => fs.writeFileSync(path.join(runtime, "industry-runtime.json"), JSON.stringify(value));
  save();
  return { root, runtime, support, contract, save, resolve: () => resolveIndustryRuntime({ runtimeRoot: runtime, supportDir: support, platform: "darwin", arch: "arm64" }),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("products without an industry extension preserve the base runtime", () => {
  const item = fixture();
  try {
    fs.unlinkSync(path.join(item.runtime, "industry-runtime.json"));
    assert.equal(readIndustryContract(item.runtime), null);
    assert.deepEqual(requiredIndustryParts(item.root), []);
    assert.deepEqual(item.resolve(), { environment: {}, selftests: [] });
  } finally { item.close(); }
});

test("a generic fixture product resolves payload paths and an offline self-test", () => {
  const item = fixture();
  try {
    assert.deepEqual(requiredIndustryParts(item.root), ["python"]);
    const result = item.resolve();
    assert.deepEqual(result.environment, { INDUSTRY_ROOT: path.join(item.runtime, "industry"), INDUSTRY_PYTHON: path.join(item.support, "python", "bin", "python3"), INDUSTRY_MODE: "offline" });
    assert.deepEqual(result.selftests, [{ name: "offline_import", executable: path.join(item.support, "python", "bin", "python3"), args: ["-c", "print('offline-fixture-ok')"], expectedStdout: "offline-fixture-ok" }]);
  } finally { item.close(); }
});

for (const [name, change, error] of [
  ["schema", (c) => { c.schemaVersion = "untrusted/v1"; }, /格式/u],
  ["unknown component", (c) => { c.requiredParts = ["host-node"]; }, /组件/u],
  ["duplicate component", (c) => { c.requiredParts = ["python", "python"]; }, /组件/u],
  ["product identity", (c) => { c.productId = "other-industry"; }, /身份/u],
  ["missing product identity", (c) => { delete c.productId; }, /身份/u],
  ["target platform", (c) => { c.target = "win-x64"; }, /平台/u],
  ["entry list", (c) => { c.requiredFiles = []; }, /入口/u],
  ["missing environment", (c) => { c.environment = null; }, /环境/u],
  ["missing self-tests", (c) => { c.selftests = []; }, /自检/u],
  ["excessive self-tests", (c) => { c.selftests = Array(9).fill(c.selftests[0]); }, /自检/u],
  ["invalid self-test arguments", (c) => { c.selftests[0].args = [123]; }, /自检/u],
]) {
  test(`industry contract refuses invalid ${name}`, () => {
    const item = fixture();
    try { change(item.contract); item.save(); assert.throws(item.resolve, error); }
    finally { item.close(); }
  });
}

test("contract JSON must be a bounded regular file", () => {
  const item = fixture();
  try {
    const file = path.join(item.runtime, "industry-runtime.json");
    fs.writeFileSync(file, "{");
    assert.throws(item.resolve, /合法 JSON/u);
    fs.writeFileSync(file, " ".repeat(100001));
    assert.throws(item.resolve, /普通 JSON/u);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(item.resolve, /普通 JSON/u);
  } finally { item.close(); }
});

test("required executable paths cannot be missing or directories", () => {
  const item = fixture();
  try {
    fs.unlinkSync(path.join(item.support, "python", "bin", "python3"));
    assert.throws(item.resolve, /入口缺失/u);
    fs.mkdirSync(path.join(item.support, "python", "bin", "python3"));
    assert.throws(item.resolve, /不是普通文件/u);
  } finally { item.close(); }
});

test("runtime references reject lexical traversal and unexpected roots", () => {
  const item = fixture();
  try {
    const roots = { runtime: item.runtime, support: item.support };
    for (const value of [null, [], { root: "host", path: "python3" }, { root: "runtime", path: "../outside" },
      { root: "runtime", path: "industry/../../outside" }, { root: "runtime", path: "industry\\..\\outside" },
      { root: "runtime", path: "/bin/sh" }, { root: "runtime", path: "industry//main.py" },
      { root: "runtime", path: "industry/./main.py" }, { root: "runtime", path: "industry/main.py\0" }]) {
      assert.throws(() => runtimeReference(value, roots), /路径/u);
    }
  } finally { item.close(); }
});

test("runtime references refuse symlinks to files and missing descendants outside the payload", { skip: process.platform === "win32" }, () => {
  const item = fixture();
  try {
    const outside = path.join(item.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "outside.py"), "outside\n");
    fs.symlinkSync(outside, path.join(item.runtime, "escape"));
    for (const entry of ["escape/outside.py", "escape/not-yet-created.py"]) {
      assert.throws(() => runtimeReference({ root: "runtime", path: entry }, { runtime: item.runtime }), /链接越出/u);
    }
    const contract = path.join(item.runtime, "industry-runtime.json");
    fs.unlinkSync(contract);
    fs.symlinkSync(path.join(outside, "outside.py"), contract);
    assert.throws(item.resolve, /普通 JSON/u);
  } finally { item.close(); }
});

test("industry extension cannot overwrite host environment or inject NUL values", () => {
  const item = fixture();
  try {
    for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "Home", "not-a-key"]) {
      item.contract.environment = { [key]: "alter-host" };
      item.save();
      assert.throws(item.resolve, /宿主系统环境/u);
    }
    item.contract.environment = { INDUSTRY_MODE: "offline\0unsafe" };
    item.save();
    assert.throws(item.resolve, /环境值/u);
  } finally { item.close(); }
});

test("an environment's required directory cannot silently point at missing payload data", () => {
  const item = fixture();
  try {
    item.contract.environment.INDUSTRY_ROOT.path = "missing-industry";
    item.save();
    assert.throws(item.resolve, /入口缺失/u);
  } finally { item.close(); }
});
