#!/usr/bin/env node
/** Account-wide first installs use ephemeral owner credentials; ordinary delivery remains native to each repo. */
import { mkdir, mkdtemp, readFile, rename, rm, lstat, open, unlink, readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GitStateStore, git } from './git-state.mjs';
import { Platform } from './queue-platform.mjs';
import { hash, SHA_RE, validRepoSlug } from './queue-model.mjs';
import { redactCredentials, requireToken } from '../tools/cnb-api.mjs';
import { readAssets } from './install-assets.mjs';
import { discoverAccount, finishInstallation, prepareRepository } from './install-repository.mjs';

const SOURCE_REPO = 'workloom-ai/workloom-im';
const OWNER = 'workloom-delivery-account/v1';

async function safeDirectory(path) {
  const target = resolve(path); let current = '/';
  for (const part of target.split('/').filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Account installation directory must not contain a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(target, { recursive: true });
  return target;
}

/** Claim before scanning. Unique filenames avoid deleting a newer owner's lock during stale recovery. */
export async function withAccountLock(directory, operation, { alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
} } = {}) {
  const root = await safeDirectory(directory);
  const identity = { owner: OWNER, pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() };
  const name = `.account-installer-lock-${identity.pid}-${identity.id}.json`;
  const path = join(root, name); const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(identity)); await handle.close();
    for (const entry of await readdir(root)) {
      if (entry === name || !entry.startsWith('.account-installer-lock-')) continue;
      const match = /^\.account-installer-lock-(\d+)-([a-f0-9-]{36})\.json$/.exec(entry);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw new Error('Account installer claim filename is invalid');
      const otherPath = join(root, entry);
      try {
        const stat = await lstat(otherPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Account installer claim is not a regular file');
        // A unique filename cannot be reused by another live owner. Only confirmed dead process claims are removed.
        if (!alive(Number(match[1]))) { await unlink(otherPath); continue; }
        return { status: 'busy', reason: 'A live account installer owns these checkouts' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return await operation(root);
  } finally {
    await handle.close();
    await unlink(path);
  }
}

/** Only dedicated, marked, clean clones are refreshed; user worktrees are never reset. */
export async function managedCheckout({ repo, token, directory }) {
  if (!validRepoSlug(repo)) throw new Error('Invalid account checkout repository');
  const parent = await safeDirectory(directory);
  const target = join(parent, `${basename(repo)}-${hash(repo).slice(0, 16)}`);
  const remote = `https://cnb.cool/${repo}.git`;
  const identity = { owner: OWNER, repo, remote };
  let exists;
  try { const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Account checkout path is unsafe'); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (!exists) {
    const staging = await mkdtemp(join(parent, '.preparing-')); const root = join(staging, 'repo');
    try {
      await git(['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--branch', 'main', remote, root], { token, remote });
      await git(['sparse-checkout', 'init', '--cone'], { cwd: root });
      await git(['sparse-checkout', 'set', 'scripts/ci', 'scripts/delivery', 'scripts/tools', 'docs', '.cnb'], { cwd: root });
      await git(['checkout', '--quiet', '--detach', 'main'], { cwd: root });
      const file = await open(join(staging, 'owner.json'), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(identity)); } finally { await file.close(); }
      await rename(staging, target);
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  const marker = JSON.parse(await readFile(join(target, 'owner.json'), 'utf8'));
  if (JSON.stringify(marker) !== JSON.stringify(identity)) throw new Error('Account checkout ownership differs');
  const root = join(target, 'repo');
  if (await git(['config', '--get', 'remote.origin.url'], { cwd: root }) !== remote) throw new Error('Account checkout remote differs');
  if (await git(['status', '--porcelain'], { cwd: root })) throw new Error('Account checkout contains uncommitted changes; preserve them');
  await git(['fetch', '--quiet', '--no-tags', remote, 'refs/heads/main'], { cwd: root, token, remote });
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  return root;
}

export async function runAccount({ token, sourceRoot, sourceRepo = SOURCE_REPO, sourceSha, directory, concurrency = 2, services = {}, notify = result => console.log(JSON.stringify(result)) }) {
  if (!token || !validRepoSlug(sourceRepo) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Invalid account installation identity/concurrency');
  const platformFor = services.platform ?? (repo => new Platform(repo, token));
  const storeFor = services.store ?? (repo => new GitStateStore({ repo, token }));
  const sourcePlatform = platformFor(sourceRepo);
  const currentMain = (await sourcePlatform.main()).commit?.sha;
  if (!SHA_RE.test(currentMain ?? '') || sourceSha && sourceSha !== currentMain) throw new Error('Account source must be current verified base main');
  sourceSha = currentMain;
  const sourceState = await storeFor(sourceRepo).read();
  const activation = sourceState.events.findLast(event => event.kind === 'activated');
  if (!activation) throw new Error('Base must have a real activation receipt before account installation');
  const assets = await (services.readAssets ?? readAssets)(sourceRoot, sourceSha);
  const repos = await (services.discover ?? discoverAccount)(token);
  const selected = repos.filter(item => item.repo !== sourceRepo);
  const report = { schemaVersion: 1, sourceRepo, sourceSha, startedAt: new Date().toISOString(), results: repos.some(item => item.repo === sourceRepo) ? [{ repo: sourceRepo, status: 'active', role: 'source', mainSha: sourceSha, activation: activation.data }] : [] };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    for (;;) {
      const item = selected[next++]; if (!item) break;
      let result;
      try {
        if (item.frozen) result = { repo: item.repo, status: 'frozen', reason: 'Repository is frozen; no installation writes' };
        else {
          const platform = platformFor(item.repo); const store = storeFor(item.repo);
          const main = (await platform.main()).commit?.sha;
          if (!SHA_RE.test(main ?? '')) result = { repo: item.repo, status: 'pending_main', reason: 'No verifiable main branch' };
          else {
            const root = await (services.checkout ?? managedCheckout)({ repo: item.repo, token, directory: join(directory, 'checkouts') });
            result = await (services.prepare ?? prepareRepository)({ repo: item.repo, token, sourceRoot, sourceSha, sourceRepo, checkout: root, platform, store, assets });
            let number = result.number;
            if (!number && result.status === 'prepared') number = (await store.read()).events.findLast(event => event.kind === 'installation_prepared')?.data.installer;
            if (number && ['waiting_checks', 'merged_pending_activation', 'prepared'].includes(result.status)) {
              const completion = await (services.finish ?? finishInstallation)({ repo: item.repo, token, number: Number(number), root, platform, store });
              result = { ...result, ...completion };
            }
          }
        }
      } catch (error) {
        result = { repo: item.repo, status: 'failed', error: redactCredentials(error.message, token).slice(0, 1200) };
      }
      report.results.push(result); notify(result);
    }
  }));
  report.results.sort((a, b) => a.repo.localeCompare(b.repo));
  report.finishedAt = new Date().toISOString();
  report.active = report.results.filter(item => item.status === 'active').length;
  report.pending = report.results.filter(item => item.status !== 'active').length;
  try {
    const actualSource = (await sourcePlatform.main()).commit?.sha;
    if (!SHA_RE.test(actualSource ?? '')) throw new Error('Final base main identity is unreadable');
    if (actualSource !== sourceSha) report.sourceAdvancedTo = actualSource;
  } catch (error) {
    // Keep completed repository receipts even if the final source read fails.
    report.sourceVerificationError = redactCredentials(error.message, token).slice(0, 1200);
  }
  return report;
}

async function main() {
  const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const directory = resolve(arg('--directory', '.delivery-account'));
  const result = await withAccountLock(directory, async root => {
    const report = await runAccount({ token: requireToken(), sourceRoot: resolve(arg('--source-root', '.')), sourceSha: arg('--source-sha'), sourceRepo: arg('--source-repo', SOURCE_REPO), directory: root, concurrency: Number(arg('--concurrency', '2')) });
    const temporary = join(root, `report-${randomUUID()}.json`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await handle.close(); }
    await rename(temporary, join(root, 'latest-report.json'));
    return report;
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.sourceVerificationError || result.results?.some(item => item.status === 'failed')) process.exitCode = 1;
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
