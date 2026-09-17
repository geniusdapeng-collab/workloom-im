import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  beginAdoptionTransaction,
  commitAdoptionTransaction,
  rollbackAdoptionTransaction,
} from "./adoption-transaction.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "workloom-adoption-transaction-test-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  write(join(root, "package.json"), "{\"name\":\"industry\"}\n");
  write(join(root, "pnpm-lock.yaml"), "before-lock\n");
  write(join(root, "governance/kept.txt"), "before\n");
  git(root, "add", "--all");
  git(root, "commit", "-m", "base");
  return root;
}

test("失败回滚精确恢复接入前 staged、unstaged、untracked 与全部接入 state", () => {
  const root = repo();
  try {
    write(join(root, "governance/kept.txt"), "staged-user-change\n");
    git(root, "add", "governance/kept.txt");
    write(join(root, "governance/kept.txt"), "staged-and-unstaged-user-change\n");
    write(join(root, "user-draft.txt"), "user draft\n");
    const beforeStatus = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    const beforeUser = readFileSync(join(root, "governance/kept.txt"));
    const transaction = beginAdoptionTransaction(root, join(root, "governance"));

    write(join(root, "governance/kept.txt"), "adoption overwrite\n");
    write(join(root, "package.json"), "{\"name\":\"half-adopted\"}\n");
    write(join(root, "pnpm-lock.yaml"), "half-lock\n");
    write(join(root, ".workloom-base-sync.json"), "{}\n");
    write(join(root, "governance/.workloom-ui.json"), "{}\n");
    write(join(root, "governance/.workloom-client-foundation.json"), "{}\n");
    write(join(root, "governance/.workloom-ui-governance.json"), "{}\n");
    write(join(root, ".github/workflows/workloom-ui-contract.yml"), "name: half\n");
    write(join(root, "governance/node_modules/generated.txt"), "ignored install\n");
    git(root, "add", "package.json");

    rollbackAdoptionTransaction(transaction);
    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.deepEqual(readFileSync(join(root, "governance/kept.txt")), beforeUser);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), "{\"name\":\"industry\"}\n");
    assert.equal(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), "before-lock\n");
    for (const path of [
      ".workloom-base-sync.json",
      "governance/.workloom-ui.json",
      "governance/.workloom-client-foundation.json",
      "governance/.workloom-ui-governance.json",
      ".github/workflows/workloom-ui-contract.yml",
      "governance/node_modules",
    ]) assert.equal(existsSync(join(root, path)), false, `${path} 应回滚`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktree 根与 pathPrefix 可恢复，叶 symlink 不被跟随", () => {
  const primary = repo();
  const linked = `${primary}-linked`;
  try {
    git(primary, "worktree", "add", "-b", "linked-test", linked);
    write(join(linked, "governance/dirty.txt"), "dirty\n");
    const external = `${primary}-external`;
    write(external, "external\n");
    symlinkSync(external, join(linked, "governance/link.txt"));
    const beforeStatus = git(linked, "status", "--porcelain=v1", "--untracked-files=all");
    const transaction = beginAdoptionTransaction(linked, join(linked, "governance"));
    rmSync(join(linked, "governance/link.txt"));
    write(join(linked, "governance/new.txt"), "half\n");
    write(join(linked, "pnpm-lock.yaml"), "changed\n");
    rollbackAdoptionTransaction(transaction);
    assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.equal(readFileSync(join(linked, "governance/link.txt"), "utf8"), "external\n");
    assert.equal(readFileSync(external, "utf8"), "external\n");
    assert.equal(existsSync(join(linked, "governance/new.txt")), false);
  } finally {
    try { git(primary, "worktree", "remove", "--force", linked); } catch {}
    rmSync(primary, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
    rmSync(`${primary}-external`, { force: true });
  }
});

test("成功提交事务只清理快照，不回滚接入结果", () => {
  const root = repo();
  try {
    const transaction = beginAdoptionTransaction(root);
    write(join(root, ".workloom-ui.json"), "{}\n");
    commitAdoptionTransaction(transaction);
    assert.equal(existsSync(transaction), false);
    assert.equal(existsSync(join(root, ".workloom-ui.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("既有任意层级 node_modules 时拒绝开始事务，避免 pnpm 改写用户依赖树", () => {
  const root = repo();
  try {
    write(join(root, "governance/apps/web/node_modules/kept.txt"), "user dependency\n");
    const beforeStatus = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    assert.throws(
      () => beginAdoptionTransaction(root, join(root, "governance")),
      /要求无既有 node_modules.*apps\/web\/node_modules/u,
    );
    assert.equal(readFileSync(join(root, "governance/apps/web/node_modules/kept.txt"), "utf8"), "user dependency\n");
    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回滚清理本次 pnpm 创建的根级与 workspace 级依赖树", () => {
  const root = repo();
  try {
    const transaction = beginAdoptionTransaction(root, join(root, "governance"));
    write(join(root, "governance/node_modules/root.txt"), "generated\n");
    write(join(root, "governance/apps/web/node_modules/client.txt"), "generated\n");
    rollbackAdoptionTransaction(transaction);
    assert.equal(existsSync(join(root, "governance/node_modules")), false);
    assert.equal(existsSync(join(root, "governance/apps/web/node_modules")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("失败回滚恢复被 ignore 的既有受控文件，并移除新增 ignored state", () => {
  const root = repo();
  try {
    write(join(root, ".gitignore"), ".workloom-ui.json\n.workloom-client-foundation.json\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-m", "ignore generated adoption state");
    write(join(root, ".workloom-ui.json"), "{\"version\":\"user-old\"}\n");
    const beforeStatus = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    const transaction = beginAdoptionTransaction(root, root, [
      ".workloom-ui.json",
      ".workloom-client-foundation.json",
    ]);

    write(join(root, ".workloom-ui.json"), "{\"version\":\"half-adopted\"}\n");
    write(join(root, ".workloom-client-foundation.json"), "{\"half\":true}\n");
    rollbackAdoptionTransaction(transaction);

    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.equal(readFileSync(join(root, ".workloom-ui.json"), "utf8"), "{\"version\":\"user-old\"}\n");
    assert.equal(existsSync(join(root, ".workloom-client-foundation.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
