#!/usr/bin/env node
/** Fleet compatibility entry point. Only repository-local trusted-main runners perform merges. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Platform } from '../scripts/delivery/queue-platform.mjs';
import { redactCredentials, requireToken } from '../scripts/tools/cnb-api.mjs';

export function targetsFor(fleet, { repo, only = [] } = {}) {
  const subscribed = [fleet.baseRepo, ...fleet.children.map(child => child.repo)];
  const isolated = new Set((fleet.isolatedRepos ?? []).map(item => item.repo));
  const targets = repo ? [repo] : subscribed.filter(slug => !only.length || only.includes(slug));
  if (!targets.length || targets.some(slug => isolated.has(slug) || !subscribed.includes(slug))) throw new Error('Delivery dispatch only accepts subscribed non-isolated repositories');
  return [...new Set(targets)];
}
export async function dispatchRepository(platform, { dryRun = false } = {}) {
  const main = await platform.main();
  const config = await platform.call(`/-/git/raw/${main.commit?.sha}/.cnb.yml`);
  if (typeof config !== 'string' || !config.includes('scripts/delivery/cnb.yml')) return { repo: platform.repo, status: 'not_installed', mainSha: main.commit?.sha };
  if (dryRun) return { repo: platform.repo, status: 'would_dispatch', mainSha: main.commit.sha };
  const result = await platform.call('/-/build/start', { method: 'POST', body: { branch: 'main', sha: main.commit.sha, event: 'api_trigger_delivery_reconcile', sync: 'false', title: 'WorkLoom repository delivery reconcile' } });
  if (!result?.success || !result.sn) throw new Error('Delivery dispatch lacks a real build acknowledgement');
  return { repo: platform.repo, status: 'dispatched', build: result.sn, mainSha: main.commit.sha };
}
export async function main(argv = process.argv.slice(2)) {
  const value = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  // Obsolete flags are rejected visibly. No alternate merge lane can bypass the trusted controller.
  if (argv.some(item => ['--no-code', '--legacy-doc-sync', '--merge-style', '--min-head-age-minutes'].includes(item))) throw new Error('Legacy merge-lane flags are unsupported; use repository delivery policy and explicit handoff');
  const fleet = JSON.parse(await readFile(new URL('./child-repos.json', import.meta.url), 'utf8'));
  const token = requireToken();
  const report = { dryRun: argv.includes('--dry-run'), dispatched: [], failed: [] };
  for (const repo of targetsFor(fleet, { repo: value('--repo'), only: (value('--only') ?? '').split(',').filter(Boolean) })) {
    const platform = new Platform(repo, token);
    try { report.dispatched.push(await dispatchRepository(platform, report)); }
    catch (error) { report.failed.push({ repo, error: platform.error(error) }); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length) process.exitCode = 1;
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
