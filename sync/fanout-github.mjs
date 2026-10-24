#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitAuthEnv, redact } from './base-sync.mjs';
import { loadRegistry, fanoutTargets, addressFor } from './repository-registry.mjs';
import { applyRepositoryConfig, planRepositoryConfig } from './repository-config.mjs';
import { createGithubClient } from '../scripts/delivery/github.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
function gitCommand(cwd, args, { network = false } = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', env: network ? gitAuthEnv(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) : { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
  catch (error) { throw new Error(redact(String(error.stderr || error.message), process.env.GH_TOKEN || process.env.GITHUB_TOKEN).slice(0, 2000)); }
}
export async function fanoutGithub({ baseDir = ROOT, mode = 'repository-config', only, dryRun = false, request = createGithubClient(), git = gitCommand } = {}) {
  baseDir = resolve(baseDir);
  const doc = loadRegistry(join(baseDir, 'sync/repository-registry.json'));
  const targets = fanoutTargets(doc, { mode, only });
  const baseSha = git(baseDir, ['rev-parse', 'HEAD']);
  if (git(baseDir, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Fanout source must be a clean committed worktree');
  if (dryRun) return { mode, dryRun: true, baseSha, targets: targets.map(e => ({ logicalId: e.logicalId, repository: e.github.repository, lane: e.lane })), remoteWrites: 0 };
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('An explicit current-operation GH_TOKEN is required; no identity fallback is performed');
  const source = addressFor(doc, doc.baseLogicalId);
  const results = [];
  for (const entry of targets) {
    const address = entry.github; const prefix = `/repos/${address.repository}`;
    const branch = `workloom/${mode === 'repository-config' ? 'repository-config' : 'base-sync'}/${mode}/${baseSha.slice(0, 12)}`;
    const pulls = await request('GET', `${prefix}/pulls?state=open&head=${encodeURIComponent(`${address.repository.split('/')[0]}:${branch}`)}&base=${address.branch}&per_page=100`);
    if (!Array.isArray(pulls)) throw new Error('Invalid GitHub pull list');
    if (pulls.length) { results.push({ logicalId: entry.logicalId, state: 'pull-open', existing: true, pullNumber: pulls[0].number, headSha: pulls[0].head.sha, baseSha: pulls[0].base?.sha, sourceBaseSha: baseSha, url: pulls[0].html_url }); continue; }
    const temporary = mkdtempSync(join(tmpdir(), 'workloom-github-fanout-'));
    try {
      const child = join(temporary, 'repo');
      git(temporary, ['clone', '--single-branch', '--branch', address.branch, `${address.url}.git`, child], { network: true });
      const childBaseSha = git(child, ['rev-parse', 'HEAD']);
      git(child, ['checkout', '-b', branch]);
      if (mode === 'repository-config') applyRepositoryConfig(child, planRepositoryConfig(child, doc, entry.logicalId));
      else {
        const args = [join(baseDir, 'sync/base-sync.mjs'), 'pull', '--repo', join(child, entry.baseSync.pathPrefix || ''), '--base-dir', baseDir, '--no-commit', '--json'];
        if (mode === 'required-only') args.push('--required-only');
        if (entry.baseSync.extraExclude?.length) args.push('--extra-exclude', entry.baseSync.extraExclude.join(','));
        try { execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { throw new Error(redact(String(error.stderr || error.stdout || error.message)).slice(0, 2000)); }
      }
      const changes = git(child, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (!changes) { results.push({ logicalId: entry.logicalId, state: 'current', baseSha }); continue; }
      const paths = [...new Set([
        ...git(child, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
        ...git(child, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
      ].filter(Boolean))];
      if (mode === 'repository-config' && paths.some(p => !doc.configOnlyPaths.includes(p))) throw new Error('Config-only fanout attempted a product file change');
      git(child, ['add', '--', ...paths]);
      git(child, ['-c', 'user.name=WorkLoom Delivery', '-c', 'user.email=delivery@workloom.invalid', 'commit', '-m', `chore(governance): ${mode} from ${baseSha.slice(0, 12)}`]);
      let headSha = git(child, ['rev-parse', 'HEAD']);
      const existing = git(child, ['ls-remote', '--heads', `${address.url}.git`, `refs/heads/${branch}`], { network: true });
      if (existing) {
        const remoteSha = existing.split(/\s+/)[0];
        if (!/^[a-f0-9]{40}$/.test(remoteSha)) throw new Error('Invalid existing candidate branch response');
        git(child, ['fetch', '--no-tags', `${address.url}.git`, `refs/heads/${branch}:refs/remotes/workloom/existing`], { network: true });
        if (git(child, ['rev-parse', 'refs/remotes/workloom/existing^{tree}']) !== git(child, ['rev-parse', 'HEAD^{tree}'])) throw new Error(`Existing candidate branch ${branch} has different bytes; refusing to overwrite it`);
        headSha = remoteSha;
      } else git(child, ['push', `${address.url}.git`, `HEAD:refs/heads/${branch}`], { network: true });
      const pull = await request('POST', `${prefix}/pulls`, {
        title: `chore(governance): ${mode} · ${baseSha.slice(0, 12)}`, head: branch, base: address.branch,
        body: `Source: ${source.url}/commit/${baseSha}\n\nMode: ${mode}.\n\nChanged paths:\n${paths.map(p => `- ${p}`).join('\n')}\n\n${mode === 'repository-config' ? 'Only repository addresses, delivery policy and manifest.repository are changed. Product content and isolation remain governed by the registry.' : 'Existing base-sync byte, scope, transaction and pollution gates were applied.'}\n\nDelivery requires exact-head Codex review, passing tests and existing checks, then a verified main integration receipt from scripts/delivery/github.mjs. CNB product mirroring is deferred.`,
      });
      results.push({ logicalId: entry.logicalId, state: 'pull-open', pullNumber: pull.number, headSha, baseSha: childBaseSha, sourceBaseSha: baseSha, changedPaths: paths, url: pull.html_url });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return { mode, baseSha, results, deliveryComplete: false, note: 'Open PRs are candidates; only verified main integration receipts complete delivery.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const opt = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    for (const key of ['--base-dir', '--mode', '--only']) if (args.includes(key) && (!opt(key) || opt(key).startsWith('--'))) throw new Error(`${key} requires a value`);
    console.log(JSON.stringify(await fanoutGithub({ baseDir: opt('--base-dir', ROOT), mode: opt('--mode', 'repository-config'), only: opt('--only'), dryRun: args.includes('--dry-run') }), null, 2));
  }
  catch (error) { console.error(redact(error.message, process.env.GH_TOKEN || process.env.GITHUB_TOKEN)); process.exitCode = 1; }
}
