import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ADOPTION_SCRIPTS, ADOPTION_WORKFLOW, installAdoptionAssets } from "./install-adoption-assets.mjs";

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(prefix = "governance") {
  const root = mkdtempSync(join(tmpdir(), "workloom-adoption-assets-test-"));
  const repo = join(root, "industry");
  const workdir = prefix === "." ? repo : join(repo, prefix);
  const source = join(root, "base");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(source, { recursive: true });
  for (const path of ADOPTION_SCRIPTS) write(join(source, path), `// ${path}\n`);
  const template = join(source, "sync/ui-consumer-template.yml");
  write(template, "name: contract\ndefaults:\n  run:\n    working-directory: __REPO_DIR__\n");
  return { root, repo, workdir, source, template, prefix };
}

test("接入资产一次安装两个 verifier 与 pathPrefix 工作流", () => {
  const fx = fixture("governance");
  try {
    const result = installAdoptionAssets({ repoRoot: fx.repo, workdir: fx.workdir, sourceRoot: fx.source, templatePath: fx.template });
    assert.equal(result.prefix, "governance");
    for (const path of ADOPTION_SCRIPTS) {
      assert.deepEqual(readFileSync(join(fx.workdir, path)), readFileSync(join(fx.source, path)));
    }
    assert.match(readFileSync(join(fx.repo, ADOPTION_WORKFLOW), "utf8"), /working-directory: governance/u);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("dry-run 不创建任何接入资产", () => {
  const fx = fixture(".");
  try {
    const result = installAdoptionAssets({
      repoRoot: fx.repo, workdir: fx.workdir, sourceRoot: fx.source, templatePath: fx.template, dryRun: true,
    });
    assert.equal(result.written, false);
    for (const path of [...ADOPTION_SCRIPTS, ADOPTION_WORKFLOW]) assert.equal(existsSync(join(fx.repo, path)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("任一多文件写入阶段故障都回滚为零半安装", () => {
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const fx = fixture("governance");
    try {
      let count = 0;
      assert.throws(() => installAdoptionAssets({
        repoRoot: fx.repo,
        workdir: fx.workdir,
        sourceRoot: fx.source,
        templatePath: fx.template,
        onWrite() {
          count += 1;
          if (count === failAt) throw new Error(`fault-${failAt}`);
        },
      }), new RegExp(`fault-${failAt}`));
      for (const path of ADOPTION_SCRIPTS) assert.equal(existsSync(join(fx.workdir, path)), false, `${path} 不得半安装`);
      assert.equal(existsSync(join(fx.repo, ADOPTION_WORKFLOW)), false, "workflow 不得半安装");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("verifier 目标叶 symlink fail closed 且不写仓外", () => {
  const fx = fixture("governance");
  const external = join(fx.root, "external-verifier.mjs");
  try {
    write(external, "outside-safe\n");
    const target = join(fx.workdir, ADOPTION_SCRIPTS[0]);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(external, target);
    assert.throws(() => installAdoptionAssets({
      repoRoot: fx.repo, workdir: fx.workdir, sourceRoot: fx.source, templatePath: fx.template,
    }), /不允许 symlink/u);
    assert.equal(readFileSync(external, "utf8"), "outside-safe\n");
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(existsSync(join(fx.repo, ADOPTION_WORKFLOW)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workflow 父目录 symlink fail closed 且不写仓外", () => {
  const fx = fixture("governance");
  const external = join(fx.root, "outside-workflows");
  try {
    mkdirSync(join(fx.repo, ".github"), { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(fx.repo, ".github/workflows"));
    assert.throws(() => installAdoptionAssets({
      repoRoot: fx.repo, workdir: fx.workdir, sourceRoot: fx.source, templatePath: fx.template,
    }), /不允许 symlink/u);
    assert.equal(existsSync(join(external, "workloom-ui-contract.yml")), false);
    for (const path of ADOPTION_SCRIPTS) assert.equal(existsSync(join(fx.workdir, path)), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("模板叶 symlink 被拒绝", () => {
  const fx = fixture("governance");
  try {
    const external = join(fx.root, "outside-template.yml");
    write(external, "name: outside\n");
    rmSync(fx.template);
    symlinkSync(external, fx.template);
    assert.throws(() => installAdoptionAssets({
      repoRoot: fx.repo, workdir: fx.workdir, sourceRoot: fx.source, templatePath: fx.template,
    }), /模板.*symlink/u);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
