import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bundledNpmCliCandidates,
  runtimeInputSha256,
  verifyInstalledRuntimeTarget,
  verifyRuntimeDepsLock,
  verifyRuntimePackageLock,
} from "./runtime-deps-lock.mjs";
import { loadProductRuntime } from "./product-runtime.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function registryEntry(version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, Number(version[0]) || 1).toString("base64")}`,
    ...extra,
  };
}

function manifest() {
  return {
    name: "workloom-runtime-payload",
    private: true,
    version: "0.0.0",
    dependencies: { esbuild: "0.28.2" },
  };
}

function packageLock() {
  return {
    name: "workloom-runtime-payload",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "workloom-runtime-payload", version: "0.0.0", dependencies: { esbuild: "0.28.2" } },
      "node_modules/esbuild": registryEntry("0.28.2"),
      "node_modules/@esbuild/darwin-arm64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["arm64"] }),
      "node_modules/@esbuild/darwin-x64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["x64"] }),
      "node_modules/@esbuild/win32-x64": registryEntry("0.28.2", { os: ["win32"], cpu: ["x64"] }),
    },
  };
}

function writePackage(root, path, value) {
  const directory = join(root, "node_modules", ...path.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(value)}\n`);
}

test("运行依赖锁输入摘要忽略 Git 工作树 LF/CRLF 差异", () => {
  const lf = "lockfileVersion: '9.0'\nimporters:\n";
  assert.equal(runtimeInputSha256(lf), runtimeInputSha256(lf.replaceAll("\n", "\r\n")));
  assert.notEqual(runtimeInputSha256(lf), runtimeInputSha256(lf.replace("\n", "\r")));
});

test("正式装配跨平台直接调用 Node 随附 npm CLI", () => {
  assert.ok(bundledNpmCliCandidates("/opt/node/bin/node", posix).includes("/opt/node/lib/node_modules/npm/bin/npm-cli.js"));
  assert.ok(bundledNpmCliCandidates("C:\\node\\node.exe", win32).includes("C:\\node\\node_modules\\npm\\bin\\npm-cli.js"));
  const source = readFileSync(join(REPOSITORY_ROOT, "scripts/runtime-deps-lock.mjs"), "utf8");
  assert.doesNotMatch(source, /execFileSync\(["']npm["']/u);
});

test("仓库提交的每产品 runtime lock 与当前依赖输入完全一致", () => {
  const expected = loadProductRuntime(REPOSITORY_ROOT);
  const verified = verifyRuntimeDepsLock(REPOSITORY_ROOT);
  assert.deepEqual(
    {
      productId: verified.product.productId,
      role: verified.product.role,
      repository: verified.product.repository,
    },
    {
      productId: expected.productId,
      role: expected.role,
      repository: expected.repository,
    },
  );
});

test("package-lock 必须锁定完整三目标原生包与 registry integrity", () => {
  assert.doesNotThrow(() => verifyRuntimePackageLock(manifest(), packageLock()));

  const missingTarget = packageLock();
  delete missingTarget.packages["node_modules/@esbuild/win32-x64"];
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingTarget), /win32-x64 原生包/u);

  const missingIntegrity = packageLock();
  delete missingIntegrity.packages["node_modules/esbuild"].integrity;
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingIntegrity), /SHA-512/u);

  const mirror = packageLock();
  mirror.packages["node_modules/esbuild"].resolved = "https://mirror.invalid/esbuild.tgz";
  assert.throws(() => verifyRuntimePackageLock(manifest(), mirror), /官方 registry/u);

  const rootDrift = packageLock();
  rootDrift.packages[""].dependencies.esbuild = "0.27.0";
  assert.throws(() => verifyRuntimePackageLock(manifest(), rootDrift), /根依赖/u);
});

test("安装后目标校验拒绝宿主架构原生包并生成稳定 inventory 摘要", () => {
  const stage = mkdtempSync(join(tmpdir(), "workloom-runtime-stage-"));
  const verified = { manifest: manifest(), packageLock: packageLock() };
  try {
    writePackage(stage, "esbuild", { name: "esbuild", version: "0.28.2" });
    writePackage(stage, "@esbuild/darwin-x64", {
      name: "@esbuild/darwin-x64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["x64"],
    });
    const first = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    const second = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    assert.equal(first.packages, 2);
    assert.equal(first.inventorySha256, second.inventorySha256);

    writePackage(stage, "@esbuild/darwin-arm64", {
      name: "@esbuild/darwin-arm64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    assert.throws(
      () => verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified),
      /混入非目标原生包/u,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("正式与应急装配线统一使用每产品 lock、目标 OS/CPU 和身份闭包", () => {
  const electron = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-electron-payload.sh"), "utf8");
  const windows = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-windows.sh"), "utf8");
  const macos = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-macos.sh"), "utf8");
  for (const source of [electron, windows, macos]) {
    assert.match(source, /runtime-deps-lock\.mjs stage/u);
    assert.match(source, /product-runtime\.mjs --manifest-path/u);
    assert.match(source, /PRODUCT_MANIFEST_PATH/u);
    assert.match(source, /product\.manifest\.json/u);
    assert.match(source, /scripts\/product-runtime\.mjs/u);
    assert.match(source, /scripts\/vite-product\.mjs/u);
    assert.match(source, /payload-policy\.mjs assert-runtime/u);
    assert.doesNotMatch(source, /\bnpm install --no-audit --no-fund --legacy-peer-deps/u);
  }
  assert.match(electron, /--os "\$TARGET_OS" --cpu "\$TARGET_CPU"/u);
  assert.match(windows, /--os win32 --cpu x64/u);
  assert.match(macos, /--os darwin --cpu "\$NODE_ARCH"/u);
  assert.match(macos, /x86_64\|x64\) NATS_ARCH="amd64"/u);
  assert.doesNotMatch(windows, /\bcopy_nm\b/u);
  const product = loadProductRuntime(REPOSITORY_ROOT);
  if (product.repository === "workloom-ai/workloom-im") {
    const workflow = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/desktop-production-release.yml"), "utf8");
    assert.doesNotMatch(workflow, /node-version:\s*24(?:\s|,|$)/u);
    assert.match(workflow, /node-version:\s*24\.19\.0/u);
  }
});

async function verifyProductionPreview({ legacy, withVitest = legacy, rejectMissingVitest = false }) {
  const [{ spawnSync }, { copyFileSync, existsSync, realpathSync, symlinkSync }, { dirname }, { createRequire }] = await Promise.all([
    import("node:child_process"), import("node:fs"), import("node:path"), import("node:module"),
  ]);
  const verified = verifyRuntimeDepsLock(REPOSITORY_ROOT);
  assert.match(verified.manifest.dependencies.vitest, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  const resolvers = [
    createRequire(join(REPOSITORY_ROOT, "apps/web/package.json")),
    createRequire(join(REPOSITORY_ROOT, "node_modules/.pnpm/node_modules/package.json")),
  ];
  const runtimePackage = (name) => {
    for (const resolver of resolvers) {
      let entry;
      try { entry = resolver.resolve(name); }
      catch (error) {
        if (error.code === "MODULE_NOT_FOUND") continue;
        throw error;
      }
      let directory = dirname(realpathSync(entry));
      while (true) {
        const manifestPath = join(directory, "package.json");
        if (existsSync(manifestPath)) {
          const value = JSON.parse(readFileSync(manifestPath, "utf8"));
          if (value.name === name) {
            assert.equal(value.version, verified.manifest.dependencies[name], `${name} 必须使用当前生产锁版本`);
            return directory;
          }
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    throw new Error(`缺少已安装的生产预览依赖：${name}`);
  };
  const product = loadProductRuntime(REPOSITORY_ROOT);
  const fixture = mkdtempSync(join(tmpdir(), "workloom-runtime-preview-"));
  try {
    // 实体 node_modules 留给 Vite 写自己的配置缓存；依赖目录只读链接到真实包。
    // 不链接整个开发 node_modules，避免 Vitest 恰好存在而掩盖发行版故障。
    for (const name of ["vite", "@vitejs/plugin-react", "@tailwindcss/vite", ...(withVitest ? ["vitest"] : [])]) {
      assert.ok(Object.hasOwn(verified.manifest.dependencies, name));
      const target = join(fixture, "node_modules", ...name.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(runtimePackage(name), target, process.platform === "win32" ? "junction" : "dir");
    }
    writeFileSync(join(fixture, "package.json"), '{"private":true,"type":"module"}\n');
    for (const path of ["product.manifest.json", "scripts/product-runtime.mjs", "scripts/vite-product.mjs", "apps/web/vite.config.ts"]) {
      const target = join(fixture, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(REPOSITORY_ROOT, path), target);
    }
    const configPath = join(fixture, "apps/web/vite.config.ts");
    const sourceConfig = readFileSync(configPath, "utf8");
    const defineConfigImports = [...sourceConfig.matchAll(/import \{ defineConfig \} from "(vite|vitest\/config)";/gu)];
    assert.equal(defineConfigImports.length, 1, "当前产品配置必须包含唯一受支持的 defineConfig 导入");
    const sourceUsesVitest = defineConfigImports[0][1] === "vitest/config";
    // 普通公共同步不能覆盖行业仓的管理客户端。两种导入都从本产品实际配置派生，
    // 只切换该导入与类型引用；身份、插件、端口、代理和 test.inline 保持原字段。
    const variant = sourceConfig.replace(defineConfigImports[0][0], `import { defineConfig } from "${legacy ? "vitest/config" : "vite"}";`);
    const fixtureConfig = !legacy && !variant.includes('/// <reference types="vitest/config" />')
      ? `/// <reference types="vitest/config" />\n${variant}`
      : variant;
    if (legacy && sourceUsesVitest) assert.equal(fixtureConfig, sourceConfig, "当前稳定配置必须逐字节保留");
    writeFileSync(configPath, fixtureConfig);
    mkdirSync(join(fixture, "apps/web/dist"), { recursive: true });
    const html = "<!doctype html><title data-workloom-product-title>生产预览回归</title><p>runtime-preview-regression</p>";
    writeFileSync(join(fixture, "apps/web/dist/index.html"), html);
    const probe = join(fixture, "preview-probe.mjs");
    writeFileSync(probe, `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadConfigFromFile, preview } from "vite";

const expected = JSON.parse(process.argv[2]);
const resolver = createRequire(import.meta.url);
if (expected.withVitest) assert.ok(resolver.resolve("vitest/config"));
else assert.throws(() => resolver.resolve("vitest/config"), { code: "MODULE_NOT_FOUND" });
const root = join(import.meta.dirname, "apps/web");
const configFile = join(root, "vite.config.ts");
if (expected.rejectMissingVitest) {
  assert.equal(expected.legacy, true);
  assert.equal(expected.withVitest, false);
  await assert.rejects(
    loadConfigFromFile({ command: "serve", mode: "production" }, configFile, root, "error"),
    (error) => error.code === "ERR_MODULE_NOT_FOUND" && /vitest/u.test(error.message),
    "Legacy runtime import must fail before serving when its controlled production dependency is absent",
  );
  console.log(JSON.stringify({ vitestResolvable: false, rejectedMissingVitest: true, errorCode: "ERR_MODULE_NOT_FOUND", webPort: expected.webPort, serverPort: expected.serverPort }));
  process.exit(0);
}
const loaded = await loadConfigFromFile({ command: "serve", mode: "production" }, configFile, root, "error");
assert.ok(loaded, "Vite must load the actual copied source config");
const config = loaded.config;
assert.deepEqual(config.test.server.deps.inline, ["@workloom/ui"]);
assert.deepEqual(config.define, expected.define);
assert.equal(config.server.port, expected.webPort);
assert.equal(config.preview.port, expected.webPort);
const proxy = { target: "http://localhost:" + expected.serverPort, changeOrigin: true };
for (const mode of ["server", "preview"]) {
  assert.deepEqual(config[mode].proxy, { "/trpc": proxy, "/health": proxy, "/api": proxy });
}
const plugins = config.plugins.flat(Infinity).map((plugin) => plugin.name);
assert.ok(plugins.includes("workloom-product-identity"));
assert.ok(plugins.some((name) => name.startsWith("vite:react")));
assert.ok(plugins.some((name) => name.startsWith("@tailwindcss/vite")));
let server;
try {
  server = await preview({ root, configFile, envDir: false, logLevel: "error", preview: { host: "127.0.0.1", strictPort: true } });
  assert.deepEqual(server.config.test.server.deps.inline, ["@workloom/ui"]);
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.port, expected.webPort);
  const response = await fetch("http://127.0.0.1:" + address.port + "/", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-workloom-product-id"), expected.productId);
  assert.equal(response.headers.get("x-workloom-instance-id"), "runtime-preview-regression");
  assert.equal(await response.text(), expected.html);
  console.log(JSON.stringify({ vitestResolvable: expected.withVitest, httpStatus: response.status, productId: expected.productId, webPort: config.preview.port, serverPort: expected.serverPort, plugins }));
} finally {
  if (server) await server.close();
}
`);
    const platformEnvironment = Object.fromEntries(["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    for (const setting of [
      { name: "默认端口", env: {}, webPort: 5173, serverPort: 8787 },
      { name: "自定义端口", env: { WEB_PORT: "6193", SERVER_PORT: "8897" }, webPort: 6193, serverPort: 8897 },
    ]) {
      const expected = {
        ...setting, legacy, withVitest, rejectMissingVitest, html, productId: product.productId,
        define: {
          __WORKLOOM_PRODUCT_NAME__: JSON.stringify(product.displayName),
          __WORKLOOM_PRODUCT_ID__: JSON.stringify(product.productId),
          __WORKLOOM_DEMO_WORKSPACE__: JSON.stringify(product.demoWorkspaceSlug),
          __WORKLOOM_DEMO_MEMBER__: JSON.stringify(product.demoMemberNo),
        },
      };
      const result = spawnSync(process.execPath, [probe, JSON.stringify(expected)], {
        cwd: fixture, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
        env: { ...platformEnvironment, PATH: dirname(process.execPath), WORKLOOM_INSTANCE_ID: "runtime-preview-regression", ...setting.env },
      });
      assert.equal(result.error, undefined, `${setting.name}: ${result.error?.message}`);
      assert.equal(result.signal, null, `${setting.name}: 子进程被信号终止`);
      assert.equal(result.status, 0, `${setting.name}: ${result.stdout}\n${result.stderr}`);
      const observed = JSON.parse(result.stdout.trim());
      assert.equal(observed.vitestResolvable, withVitest);
      if (rejectMissingVitest) {
        assert.equal(observed.rejectedMissingVitest, true);
        assert.equal(observed.errorCode, "ERR_MODULE_NOT_FOUND");
      } else {
        assert.equal(observed.httpStatus, 200);
        assert.equal(observed.productId, product.productId);
      }
      assert.equal(observed.webPort, setting.webPort);
      assert.equal(observed.serverPort, setting.serverPort);
      console.log(JSON.stringify({ config: legacy ? "legacy-vitest-runtime" : "canonical-type-only", sourceUsesVitest, sourceConfigUnchanged: fixtureConfig === sourceConfig, setting: setting.name, ...observed }));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("当前产品配置派生的纯类型 Vitest 导入在无 Vitest 的隔离目录中启动真实 preview", { timeout: 75_000 }, async () => {
  await verifyProductionPreview({ legacy: false });
});

test("当前产品配置的稳定客户端 vitest/config 变体使用精确生产兼容依赖启动真实 preview", { timeout: 75_000 }, async () => {
  await verifyProductionPreview({ legacy: true });
});

test("Vitest 兼容闭包拒绝非法 pin，稳定配置缺 Vitest 时真实加载失败", { timeout: 75_000 }, async () => {
  const { buildRuntimeDepsManifest } = await import("./runtime-deps-lock.mjs");
  const root = mkdtempSync(join(tmpdir(), "workloom-runtime-vitest-pin-"));
  const policy = { includePlatformOps: false };
  const version = "5.0.1";
  const source = { private: true, devDependencies: { vitest: "^5.0.1" } };
  const lock = { lockfileVersion: "9.0", importers: { ".": { devDependencies: { vitest: { specifier: "^5.0.1", version: `${version}(vite@8.3.0)` } } } } };
  const write = (pkg, locked) => {
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg)}\n`);
    writeFileSync(join(root, "pnpm-lock.yaml"), `${JSON.stringify(locked)}\n`);
  };
  try {
    mkdirSync(join(root, "packages"));
    for (const app of ["server", "web"]) {
      mkdirSync(join(root, "apps", app), { recursive: true });
      writeFileSync(join(root, "apps", app, "package.json"), '{"private":true}\n');
    }
    write(source, lock);
    assert.deepEqual(buildRuntimeDepsManifest(root, policy).dependencies, { vitest: version });

    const missingDeclaration = structuredClone(source);
    delete missingDeclaration.devDependencies.vitest;
    write(missingDeclaration, lock);
    assert.throws(() => buildRuntimeDepsManifest(root, policy), /Vitest.*缺失.*specifier/u);

    const missingLock = structuredClone(lock);
    delete missingLock.importers["."].devDependencies.vitest;
    write(source, missingLock);
    assert.throws(() => buildRuntimeDepsManifest(root, policy), /Vitest.*缺失.*specifier/u);

    const drift = structuredClone(lock);
    drift.importers["."].devDependencies.vitest.specifier = "^5.0.2";
    write(source, drift);
    assert.throws(() => buildRuntimeDepsManifest(root, policy), /Vitest.*specifier 漂移/u);

    for (const invalid of ["", "^5.0.1", "workspace:*", "link:../vitest", "npm:other@5.0.1", null]) {
      const nonExact = structuredClone(lock);
      nonExact.importers["."].devDependencies.vitest.version = invalid;
      write(source, nonExact);
      assert.throws(() => buildRuntimeDepsManifest(root, policy), /Vitest.*精确版本/u, `拒绝 ${String(invalid)}`);
    }

    for (const compatible of [true, false]) {
      const dependencyVersion = compatible ? version : "5.0.2";
      const duplicate = { ...source, dependencies: { vitest: dependencyVersion } };
      const duplicateLock = structuredClone(lock);
      duplicateLock.importers["."].dependencies = { vitest: { specifier: dependencyVersion, version: dependencyVersion } };
      write(duplicate, duplicateLock);
      if (compatible) assert.deepEqual(buildRuntimeDepsManifest(root, policy).dependencies, { vitest: version });
      else assert.throws(() => buildRuntimeDepsManifest(root, policy), /Vitest.*版本冲突/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await verifyProductionPreview({ legacy: true, withVitest: false, rejectMissingVitest: true });
});
