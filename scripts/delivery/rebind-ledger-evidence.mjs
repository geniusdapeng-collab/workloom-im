#!/usr/bin/env node
/**
 * Rebinds an MCD ledger's evidence receipts to the commit that really contains them.
 *
 * `mine-clear.mjs gate` reads every run/artifact back **through git** at the commit the
 * ledger declares. When the receipt entities and the commit they claim are landed by the
 * same commit, that commit is the tip — not an earlier "repair" commit. Binding the
 * receipts to an ancestor whose tree lacks them makes every read-back fail on any clone.
 *
 * usage: node scripts/delivery/rebind-ledger-evidence.mjs --ledger <path> [--repo <root>] [--check|--write]
 *
 * --check (default) is read-only: it resolves every declared commit and reads each receipt
 * back through git, exiting non-zero on the first inconsistency.
 * --write moves runs/artifacts/evidence-index to HEAD and refreshes sha256 from disk. It
 * refuses to run on a dirty work tree, so a receipt can never be rebound to a commit that
 * does not yet contain it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { hashBytes, revisionOf, resolveCommit } from "./evidence.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;
const die = (message, code = 2) => { console.error(`✗ ${message}`); process.exit(code); };
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const ledgerPath = arg("--ledger");
if (!ledgerPath) die("缺少 --ledger <台账路径>", 2);
const write = process.argv.includes("--write");
const root = resolve(arg("--repo", process.env.WORKLOOM_REPO_ROOT ?? process.cwd()));
const artifactRoot = resolve(dirname(resolve(ledgerPath)));
const relArtifactRoot = () => {
  const rel = artifactRoot === root ? "" : artifactRoot.slice(root.length + 1).split(sep).join("/");
  if (rel === ".." || rel.startsWith(`../`) || rel.includes(`..${sep}`)) die(`台账目录必须位于仓库内：${artifactRoot}`, 2);
  return rel;
};
const repoPath = (artifactPath) => (relArtifactRoot() ? `${relArtifactRoot()}/${artifactPath}` : artifactPath);

const revision = (() => { try { return revisionOf(root); } catch (error) { return die(`无法读取仓库状态：${error.message}`, 2); } })();
if (write && revision.dirty) die("工作树必须干净：回执只能绑定到已经包含它的提交", 1);

let ledger; let index;
try { ledger = JSON.parse(readFileSync(resolve(ledgerPath), "utf8")); } catch (error) { die(`台账不可读：${error.message}`, 2); }
const indexPath = resolve(artifactRoot, "evidence-index.json");
try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch (error) { die(`evidence-index 不可读：${error.message}`, 2); }

/** Collect the receipts the gate reads back: card assertions first, then the index mirror. */
const receipts = [];
for (const card of ledger.cards ?? []) {
  for (const [i, assertion] of (card.assertions ?? []).entries()) {
    for (const field of ["run", "evidence"]) if (assertion[field]) receipts.push({ label: `${card.id}.assertions[${i}].${field}`, ref: assertion[field] });
  }
}
for (const ref of [...(index.runs ?? []), ...(index.artifacts ?? [])]) receipts.push({ label: `evidence-index:${ref.path}`, ref, indexed: true });
if (!receipts.length) die("台账与索引里没有任何回执", 2);

const errors = [];
const show = (path, commit) => execFileSync("git", ["show", `${commit}:${repoPath(path)}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

/** The newest commit reachable from HEAD that contains this receipt. */
function containingCommit(path) {
  try { return resolveCommit(root, execFileSync("git", ["log", "-1", "--format=%H", "HEAD", "--", repoPath(path)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()); }
  catch { return null; }
}

if (write) {
  const missing = [];
  for (const { label, ref } of receipts) {
    if (!existsSync(resolve(artifactRoot, ref.path))) { missing.push(label); continue; }
    const commit = containingCommit(ref.path);
    if (!commit) { missing.push(label); continue; }
    ref.commit = commit;
    ref.sha256 = hashBytes(readFileSync(resolve(artifactRoot, ref.path)));
  }
  if (missing.length) {
    console.error(`✗ 有 ${missing.length} 份回执没有任何提交包含它们（先提交实体再重绑）：`);
    for (const label of missing.slice(0, 5)) console.error(`  - ${label}`);
    process.exit(1);
  }
  index.commit = resolveCommit(root, execFileSync("git", ["log", "-1", "--format=%H", "HEAD", "--", repoPath("evidence-index.json")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  writeFileSync(resolve(ledgerPath), `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`✓ 已把 ${receipts.length} 份回执绑定到各自真实落地的提交（index@${index.commit.slice(0, 8)}）`);
  process.exit(0);
}

for (const { label, ref } of receipts) {
  if (!HEX64.test(String(ref.sha256 ?? ""))) { errors.push(`${label}：sha256 缺失或非法`); continue; }
  let declared; let containing;
  try { declared = resolveCommit(root, ref.commit); } catch { errors.push(`${label}：声明提交 ${String(ref.commit ?? "(空)").slice(0, 8)} 在本仓不可解析`); continue; }
  containing = containingCommit(ref.path);
  if (!containing) { errors.push(`${label}：没有任何提交包含 ${ref.path}`); continue; }
  if (declared !== containing) { errors.push(`${label}：声明提交 ${declared.slice(0, 8)} 不是最后包含该产物的提交 ${containing.slice(0, 8)}`); continue; }
  try { if (hashBytes(show(ref.path, declared)) !== ref.sha256) errors.push(`${label}：git 回读字节与 sha256 不一致（声明 ${ref.sha256.slice(0, 8)}）`); }
  catch { errors.push(`${label}：无法从声明提交 ${declared.slice(0, 8)} 回读 ${ref.path}`); }
}

if (errors.length) { console.error(`✗ 回执绑定不一致（${errors.length} 项）：`); for (const item of errors) console.error(`  - ${item}`); process.exit(1); }
console.log(`✓ ${receipts.length} 份回执可在 HEAD ${revision.commit.slice(0, 8)} 上回读，sha256 逐份一致`);
