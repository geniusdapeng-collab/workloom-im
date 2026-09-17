import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GOVERNANCE_FILES,
  GOVERNANCE_STATE,
  GOVERNANCE_TYPESCRIPT,
  GOVERNANCE_YAML,
  installUiGovernance,
  sanitizedLocalGitEnvironment,
} from "./install-ui-governance.mjs";

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "-c", "user.name=UI Governance Test", "-c", "user.email=ui-governance@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-ui-governance-install-"));
  const source = join(root, "base");
  const target = join(root, "industry");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  write(join(target, "package.json"), `${JSON.stringify({ name: "industry", devDependencies: {} }, null, 2)}\n`);
  for (const path of GOVERNANCE_FILES) write(join(source, path), `// base ${path}\n`);
  return { root, source, target };
}

function legacyFixture({ pathPrefix = "", legacyExcludes = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workloom-ui-governance-legacy-"));
  const source = join(root, "base");
  const repositoryRoot = join(root, "industry");
  const target = pathPrefix ? join(repositoryRoot, pathPrefix) : repositoryRoot;
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  git(source, "init", "--quiet");
  git(repositoryRoot, "init", "--quiet");

  const oldContents = new Map();
  for (const path of GOVERNANCE_FILES) {
    const content = `// legacy base-sync v8 ${path}\n`;
    oldContents.set(path, content);
    write(join(source, path), content);
  }
  write(join(source, "sync/base-scope.json"), `${JSON.stringify({
    version: 8,
    include: ["scripts/**"],
    exclude: legacyExcludes,
  }, null, 2)}\n`);
  const legacyCommit = commitAll(source, "legacy v8 managed verifier");

  const currentContents = new Map();
  for (const path of GOVERNANCE_FILES) {
    const content = `// stable governance unit ${path}\n`;
    currentContents.set(path, content);
    write(join(source, path), content);
  }
  write(join(source, "sync/base-scope.json"), `${JSON.stringify({
    version: 9,
    include: ["scripts/**"],
    exclude: GOVERNANCE_FILES,
  }, null, 2)}\n`);
  commitAll(source, "move UI governance to stable installer");

  write(join(target, "package.json"), `${JSON.stringify({ name: "industry", devDependencies: {} }, null, 2)}\n`);
  for (const [path, content] of oldContents) write(join(target, path), content);
  write(join(repositoryRoot, ".workloom-base-sync.json"), `${JSON.stringify({
    baseRepo: "workloom-ai/workloom-im",
    lastSyncedBaseSha: legacyCommit,
    lastSyncMode: "required-only",
    pathPrefix: pathPrefix || ".",
  }, null, 2)}\n`);
  commitAll(repositoryRoot, "record legacy base sync");
  return { root, source, repositoryRoot, target, legacyCommit, oldContents, currentContents };
}

test("legacy 证明的本地 git 子进程不继承 rollout 与认证 header 凭据", () => {
  const secretKeys = [
    "SYNC_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "AUTHORIZATION", "HTTP_AUTHORIZATION", "GIT_HTTP_EXTRA_HEADER", "NPM_CONFIG_USERCONFIG",
  ];
  const ambient = { ...process.env };
  for (const key of secretKeys) ambient[key] = `sentinel-${key}`;
  const child = execFileSync(process.execPath, [
    "-e",
    "const keys=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]??null]))));",
    JSON.stringify(secretKeys),
  ], {
    encoding: "utf8",
    env: sanitizedLocalGitEnvironment(ambient),
  });
  const observed = JSON.parse(child);
  for (const key of secretKeys) assert.equal(observed[key], null, `${key} 泄漏到本地 git 子进程环境`);
});

test("新行业把 verifier、规则、固定解析器和指纹作为同一治理单元安装", () => {
  const fx = fixture();
  try {
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    const packageJson = JSON.parse(readFileSync(join(fx.target, "package.json"), "utf8"));
    assert.equal(packageJson.devDependencies["typescript-governance"], GOVERNANCE_TYPESCRIPT);
    assert.equal(packageJson.devDependencies["yaml-governance"], GOVERNANCE_YAML);
    const state = JSON.parse(readFileSync(join(fx.target, GOVERNANCE_STATE), "utf8"));
    assert.equal(state.dependency, GOVERNANCE_TYPESCRIPT);
    assert.equal(state.yamlDependency, GOVERNANCE_YAML);
    for (const path of GOVERNANCE_FILES) {
      assert.equal(readFileSync(join(fx.target, path), "utf8"), `// base ${path}\n`);
      assert.match(state.files[path].sha256, /^[0-9a-f]{64}$/u);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("既有 v1 治理 state 可在文件指纹不变时补入固定 YAML 解析器", () => {
  const fx = fixture();
  try {
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    const packagePath = join(fx.target, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    delete packageJson.devDependencies["yaml-governance"];
    write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const statePath = join(fx.target, GOVERNANCE_STATE);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state.yamlDependency;
    write(statePath, `${JSON.stringify(state, null, 2)}\n`);

    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    const migratedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
    const migratedState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(migratedPackage.devDependencies["yaml-governance"], GOVERNANCE_YAML);
    assert.equal(migratedState.yamlDependency, GOVERNANCE_YAML);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("dry-run 只预检，不创建任何治理资产或依赖", () => {
  const fx = fixture();
  try {
    const before = readFileSync(join(fx.target, "package.json"), "utf8");
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source, dryRun: true });
    assert.equal(readFileSync(join(fx.target, "package.json"), "utf8"), before);
    assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
    for (const path of GOVERNANCE_FILES) assert.equal(existsSync(join(fx.target, path)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("首次接入拒绝覆盖行业已有 verifier，且不产生半套安装", () => {
  const fx = fixture();
  try {
    write(join(fx.target, GOVERNANCE_FILES[0]), "// industry custom\n");
    const beforePackage = readFileSync(join(fx.target, "package.json"), "utf8");
    assert.throws(
      () => installUiGovernance({ repo: fx.target, sourceRoot: fx.source }),
      /已被行业仓定制；拒绝静默覆盖/u,
    );
    assert.equal(readFileSync(join(fx.target, GOVERNANCE_FILES[0]), "utf8"), "// industry custom\n");
    assert.equal(existsSync(join(fx.target, GOVERNANCE_FILES[1])), false);
    assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
    assert.equal(readFileSync(join(fx.target, "package.json"), "utf8"), beforePackage);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("v8 普通 base-sync 的可信旧字节可由稳定治理单元原子接管（含 Tiger pathPrefix）", () => {
  const fx = legacyFixture({ pathPrefix: "governance" });
  try {
    const result = installUiGovernance({
      repo: fx.target,
      repositoryRoot: fx.repositoryRoot,
      sourceRoot: fx.source,
    });
    assert.equal(result.legacyTakeover, true);
    for (const [path, content] of fx.currentContents) {
      assert.equal(readFileSync(join(fx.target, path), "utf8"), content);
    }
    const state = JSON.parse(readFileSync(join(fx.target, GOVERNANCE_STATE), "utf8"));
    assert.equal(state.legacyTakeover.sourceCommit, fx.legacyCommit);
    assert.equal(state.legacyTakeover.scopeVersion, 8);
    assert.match(state.legacyTakeover.scopeSha256, /^[0-9a-f]{64}$/u);
    for (const path of GOVERNANCE_FILES) {
      assert.match(state.legacyTakeover.files[path].sha256, /^[0-9a-f]{64}$/u);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("v8 state 不能给行业自定义 verifier 授权覆盖", () => {
  const fx = legacyFixture();
  try {
    const customPath = join(fx.target, GOVERNANCE_FILES[0]);
    write(customPath, "// industry custom verifier\n");
    const beforePackage = readFileSync(join(fx.target, "package.json"));
    assert.throws(
      () => installUiGovernance({
        repo: fx.target,
        repositoryRoot: fx.repositoryRoot,
        sourceRoot: fx.source,
      }),
      /已被行业仓定制；拒绝静默覆盖/u,
    );
    assert.equal(readFileSync(customPath, "utf8"), "// industry custom verifier\n");
    assert.deepEqual(readFileSync(join(fx.target, "package.json")), beforePackage);
    assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("伪造 v8 state 指向非基座祖先提交也不能取得接管授权", () => {
  const fx = legacyFixture();
  try {
    const forgedCommit = git(fx.repositoryRoot, "rev-parse", "HEAD");
    write(join(fx.repositoryRoot, ".workloom-base-sync.json"), `${JSON.stringify({
      baseRepo: "workloom-ai/workloom-im",
      lastSyncedBaseSha: forgedCommit,
      lastSyncMode: "required-only",
      pathPrefix: ".",
    }, null, 2)}\n`);
    const before = new Map([
      ["package.json", readFileSync(join(fx.target, "package.json"))],
      ...GOVERNANCE_FILES.map((path) => [path, readFileSync(join(fx.target, path))]),
    ]);

    assert.throws(
      () => installUiGovernance({
        repo: fx.target,
        repositoryRoot: fx.repositoryRoot,
        sourceRoot: fx.source,
      }),
      /已被行业仓定制；拒绝静默覆盖/u,
    );
    for (const [path, content] of before) {
      assert.deepEqual(readFileSync(join(fx.target, path)), content);
    }
    assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("legacy 接管任一写入失败都恢复旧 verifier、规则、package 且不留新 state", () => {
  const fx = legacyFixture();
  try {
    const before = new Map([
      ["package.json", readFileSync(join(fx.target, "package.json"))],
      ...GOVERNANCE_FILES.map((path) => [path, readFileSync(join(fx.target, path))]),
    ]);
    let writes = 0;
    assert.throws(
      () => installUiGovernance({
        repo: fx.target,
        repositoryRoot: fx.repositoryRoot,
        sourceRoot: fx.source,
        onWrite: () => { if (++writes === 3) throw new Error("injected legacy takeover failure"); },
      }),
      /injected legacy takeover failure/u,
    );
    for (const [path, content] of before) {
      assert.deepEqual(readFileSync(join(fx.target, path)), content);
    }
    assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("旧 scope 已排除治理脚本时拒绝仅凭 state 路径接管", () => {
  const fx = legacyFixture({ legacyExcludes: [GOVERNANCE_FILES[0]] });
  try {
    // 即使目标字节与可信祖先提交完全一致，被 scope 排除的路径也从未属于
    // 旧 base-sync 受管资产，不能进入迁移通道。
    assert.throws(
      () => installUiGovernance({
        repo: fx.target,
        repositoryRoot: fx.repositoryRoot,
        sourceRoot: fx.source,
      }),
      /已被行业仓定制；拒绝静默覆盖/u,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("既有行业只有文件仍匹配旧指纹时才允许稳定 rollout 更新", () => {
  const fx = fixture();
  try {
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    write(join(fx.source, GOVERNANCE_FILES[0]), "// base verifier v2\n");
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    assert.equal(readFileSync(join(fx.target, GOVERNANCE_FILES[0]), "utf8"), "// base verifier v2\n");

    write(join(fx.target, GOVERNANCE_FILES[1]), "// industry changed after install\n");
    write(join(fx.source, GOVERNANCE_FILES[0]), "// base verifier v3\n");
    assert.throws(
      () => installUiGovernance({ repo: fx.target, sourceRoot: fx.source }),
      /已被行业仓定制；拒绝静默覆盖/u,
    );
    assert.equal(readFileSync(join(fx.target, GOVERNANCE_FILES[0]), "utf8"), "// base verifier v2\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("既有行业固定了不同解析器版本时拒绝静默改写", () => {
  for (const devDependencies of [
    { "typescript-governance": "^5.8.0" },
    { "yaml-governance": "^2.8.0" },
  ]) {
    const fx = fixture();
    try {
      write(join(fx.target, "package.json"), `${JSON.stringify({ name: "industry", devDependencies }, null, 2)}\n`);
      assert.throws(
        () => installUiGovernance({ repo: fx.target, sourceRoot: fx.source }),
        /拒绝静默覆盖/u,
      );
      assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("任一多文件写入阶段失败都恢复 package、治理文件与 state", () => {
  for (let failAfter = 1; failAfter <= GOVERNANCE_FILES.length + 2; failAfter += 1) {
    const fx = fixture();
    try {
      const beforePackage = readFileSync(join(fx.target, "package.json"));
      let writes = 0;
      assert.throws(
        () => installUiGovernance({
          repo: fx.target,
          sourceRoot: fx.source,
          onWrite: () => {
            writes += 1;
            if (writes === failAfter) throw new Error(`injected failure ${failAfter}`);
          },
        }),
        /injected failure/u,
      );
      assert.deepEqual(readFileSync(join(fx.target, "package.json")), beforePackage);
      assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
      for (const path of GOVERNANCE_FILES) assert.equal(existsSync(join(fx.target, path)), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("稳定更新中途失败恢复上一版完整治理单元", () => {
  const fx = fixture();
  try {
    installUiGovernance({ repo: fx.target, sourceRoot: fx.source });
    const before = new Map([
      ["package.json", readFileSync(join(fx.target, "package.json"))],
      [GOVERNANCE_STATE, readFileSync(join(fx.target, GOVERNANCE_STATE))],
      ...GOVERNANCE_FILES.map((path) => [path, readFileSync(join(fx.target, path))]),
    ]);
    for (const path of GOVERNANCE_FILES) write(join(fx.source, path), `// updated ${path}\n`);
    let writes = 0;
    assert.throws(
      () => installUiGovernance({
        repo: fx.target,
        sourceRoot: fx.source,
        onWrite: () => { if (++writes === 3) throw new Error("injected update failure"); },
      }),
      /injected update failure/u,
    );
    for (const [path, content] of before) assert.deepEqual(readFileSync(join(fx.target, path)), content);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("治理 verifier 叶 symlink（含 dangling）fail closed 且不写仓外", () => {
  for (const dangling of [false, true]) {
    const fx = fixture();
    const external = join(fx.root, `external-${dangling}.mjs`);
    try {
      if (!dangling) write(external, "outside-safe\n");
      const target = join(fx.target, GOVERNANCE_FILES[0]);
      mkdirSync(join(fx.target, "scripts"), { recursive: true });
      symlinkSync(external, target);
      const beforePackage = readFileSync(join(fx.target, "package.json"));
      assert.throws(
        () => installUiGovernance({ repo: fx.target, sourceRoot: fx.source }),
        /不允许 symlink/u,
      );
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      if (!dangling) assert.equal(readFileSync(external, "utf8"), "outside-safe\n");
      else assert.equal(existsSync(external), false);
      assert.deepEqual(readFileSync(join(fx.target, "package.json")), beforePackage);
      assert.equal(existsSync(join(fx.target, GOVERNANCE_STATE)), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("治理脚本父目录 symlink fail closed 且不创建外部文件", () => {
  const fx = fixture();
  const external = join(fx.root, "outside-scripts");
  try {
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(fx.target, "scripts"));
    assert.throws(
      () => installUiGovernance({ repo: fx.target, sourceRoot: fx.source }),
      /不允许 symlink/u,
    );
    for (const path of GOVERNANCE_FILES) assert.equal(existsSync(join(external, path.split("/").at(-1))), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
