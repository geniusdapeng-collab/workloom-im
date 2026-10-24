#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryConfiguration, loadRegistry, repository, repositoryConfiguration, repositoryFromRemote } from './repository-registry.mjs';

const text = value => `${JSON.stringify(value, null, 2)}\n`;
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
export function planRepositoryConfig(root, doc, identity, { manifestRepository = true } = {}) {
  root = realpathSync(resolve(root));
  const entry = repository(doc, identity);
  if (git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('Config target must be a Git repository root');
  const remote = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status === 0 && repositoryFromRemote(doc, remote.stdout)?.logicalId !== entry.logicalId) throw new Error('Target origin does not match the selected registry identity');
  const manifestPath = join(root, 'product.manifest.json');
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw new Error('Product manifest must be a regular file');
  const original = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  if (manifest.schemaVersion !== 'workloom.product/v1' || manifest.productId !== entry.productId) throw new Error(`Manifest identity does not match ${identity}`);
  const proposed = {
    '.workloom-repository.json': text(repositoryConfiguration(doc, identity)),
    '.workloom-delivery.json': text(deliveryConfiguration()),
  };
  if (manifestRepository && manifest.repository !== entry.github.repository) {
    // Only repository is changed. Every other product/deployment field is preserved.
    proposed['product.manifest.json'] = text({ ...manifest, repository: entry.github.repository });
  }
  const operations = [];
  for (const [path, content] of Object.entries(proposed)) {
    const full = join(root, path);
    const info = stat(full);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Config path is not a regular file: ${path}`);
    const before = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (before !== content) operations.push({ path, before, content, mode: info ? info.mode & 0o777 : 0o644 });
  }
  return { logicalId: entry.logicalId, lane: entry.lane, frozenProductContent: entry.baseSync.receive === 'none', operations };
}
export function applyRepositoryConfig(root, plan) {
  root = realpathSync(resolve(root));
  if (git(root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Refusing config update on a dirty worktree');
  const completed = [];
  try {
    for (const operation of plan.operations) {
      if (!['.workloom-repository.json', '.workloom-delivery.json', 'product.manifest.json'].includes(operation.path)) throw new Error(`Path is outside the config-only allowlist: ${operation.path}`);
      const full = join(root, operation.path);
      const info = stat(full);
      if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Unsafe config path: ${operation.path}`);
      const current = existsSync(full) ? readFileSync(full, 'utf8') : null;
      if (current !== operation.before) throw new Error(`Config changed since planning: ${operation.path}`);
      if (operation.path === 'product.manifest.json') {
        const before = JSON.parse(current); const after = JSON.parse(operation.content);
        delete before.repository; delete after.repository;
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Config-only channel cannot change product manifest fields other than repository');
      }
      const temporary = `${full}.workloom-config-${process.pid}`;
      try { writeFileSync(temporary, operation.content, { flag: 'wx', mode: operation.mode ?? 0o644 }); renameSync(temporary, full); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      completed.push(operation);
    }
    return { logicalId: plan.logicalId, mode: 'repository-config', changedPaths: completed.map(o => o.path), productContentFrozen: plan.frozenProductContent };
  } catch (error) {
    for (const operation of completed.reverse()) {
      const full = join(root, operation.path);
      if (operation.before === null) unlinkSync(full); else writeFileSync(full, operation.before);
    }
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const opt = key => args[args.indexOf(key) + 1];
    if (!args.includes('--repo-dir') || !args.includes('--logical-id')) throw new Error('Usage: repository-config.mjs --repo-dir DIR --logical-id ID [--write] [--no-manifest-repository]');
    const root = resolve(opt('--repo-dir'));
    const plan = planRepositoryConfig(root, loadRegistry(), opt('--logical-id'), { manifestRepository: !args.includes('--no-manifest-repository') });
    console.log(text(args.includes('--write') ? applyRepositoryConfig(root, plan) : { ...plan, operations: plan.operations.map(o => ({ path: o.path })) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
