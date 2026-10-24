#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressFor, deliveryConfiguration, loadRegistry, repository } from '../../sync/repository-registry.mjs';

const SHA = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
export const deliveryPolicySha256 = () => createHash('sha256').update(JSON.stringify(deliveryConfiguration())).digest('hex');
export function createGithubClient({ token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  return async function request(method, path, body) {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path) || path.includes('..') || path.includes('://')) throw new Error('GitHub API path is outside the repository boundary');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetchImpl(`https://api.github.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`GitHub ${method} ${path}: network request failed`); }
    const data = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(`GitHub ${method} ${path}: HTTP ${response.status}`); error.status = response.status; throw error; }
    return data;
  };
}
async function pages(request, path, key) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const data = await request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = key ? data?.[key] : data;
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid paginated response');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error('GitHub pagination exceeded the bounded safety limit');
}
export function validateReviewReceipt(receipt, { repository: slug, headSha, baseSha }) {
  if (receipt?.schemaVersion !== 'workloom.codex-review/v1' || receipt.repository !== slug || receipt.headSha !== headSha || receipt.baseSha !== baseSha) throw new Error('Codex review receipt does not bind this repository/head/base');
  if (receipt.policySha256 !== deliveryPolicySha256()) throw new Error('Codex review receipt does not bind the current delivery policy');
  if (!Array.isArray(receipt.files) || !receipt.files.length || new Set(receipt.files).size !== receipt.files.length || receipt.files.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'))) throw new Error('A complete unique reviewed file list is required');
  if (receipt.review?.actor !== 'codex' || receipt.review.status !== 'passed' || !digest.test(receipt.review.evidenceSha256 ?? '')) throw new Error('A passed Codex review with hashed evidence is required');
  if (!Array.isArray(receipt.tests) || !receipt.tests.length || receipt.tests.some(t => t.status !== 'passed' || !t.command || !digest.test(t.evidenceSha256 ?? ''))) throw new Error('Passed test receipts with commands and evidence hashes are required');
  return receipt;
}
export async function inspectGithubPull({ request, address, pullNumber, headSha, baseSha, reviewReceipt }) {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0 || !SHA.test(headSha) || !SHA.test(baseSha)) throw new Error('Invalid PR number or exact commit SHA');
  validateReviewReceipt(reviewReceipt, { repository: address.repository, headSha, baseSha });
  const prefix = `/repos/${address.repository}`;
  const pull = await request('GET', `${prefix}/pulls/${pullNumber}`);
  if (pull.state !== 'open' || pull.draft || pull.head?.sha !== headSha || pull.base?.sha !== baseSha || pull.base?.ref !== address.branch || pull.head?.repo?.full_name !== address.repository || pull.base?.repo?.full_name !== address.repository) throw new Error('PR state, repository, or exact head/base changed');
  if (/^\s*(?:WIP\b|\[WIP\]|Draft\b)/i.test(pull.title ?? '') || (pull.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === 'risk/block')) throw new Error('Draft/WIP or risk/block pull cannot enter automatic delivery');
  if (!Number.isSafeInteger(pull.changed_files) || pull.changed_files <= 0 || pull.changed_files > 3000) throw new Error('PR complete file count cannot be verified through the GitHub file API');
  const files = await pages(request, `${prefix}/pulls/${pullNumber}/files`);
  if (files.length !== pull.changed_files) throw new Error('GitHub PR file list is incomplete');
  const paths = [...new Set(files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))].sort();
  if (JSON.stringify(paths) !== JSON.stringify([...reviewReceipt.files].sort())) throw new Error('Codex review did not cover the complete current PR file list');
  if (paths.some(path => /^(?:platform-ops\/secrets|secrets|trading\/live|broker\/live)(?:\/|$)/.test(path))) throw new Error('Business secret or live execution paths require a separately authorized delivery channel');
  const branch = await request('GET', `${prefix}/branches/${encodeURIComponent(address.branch)}`);
  if (branch.commit?.sha !== baseSha) throw new Error('Main moved after review; rebase/review/test the new candidate');
  const status = await request('GET', `${prefix}/commits/${headSha}/status?per_page=100`);
  const statuses = await pages(request, `${prefix}/commits/${headSha}/statuses`);
  const latest = new Map();
  for (const item of statuses) if (!latest.has(item.context)) latest.set(item.context, item);
  const checks = await pages(request, `${prefix}/commits/${headSha}/check-runs?filter=latest`, 'check_runs');
  if (status.state === 'failure' || status.state === 'error' || [...latest.values()].some(s => s.state !== 'success') || checks.some(c => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion))) throw new Error('Existing GitHub checks have not passed');
  let protection = null;
  try { protection = await request('GET', `${prefix}/branches/${encodeURIComponent(address.branch)}/protection`); }
  catch (error) { if (error.status !== 404 || branch.protected) throw error; }
  const required = protection?.required_status_checks;
  const requiredChecks = required?.checks ?? (required?.contexts ?? []).map(context => ({ context }));
  for (const wanted of requiredChecks) {
    const validStatus = latest.get(wanted.context)?.state === 'success' && (wanted.app_id == null || wanted.app_id === -1);
    const validCheck = checks.some(c => c.name === wanted.context && c.status === 'completed' && c.conclusion === 'success' && (wanted.app_id == null || wanted.app_id === -1 || c.app?.id === wanted.app_id));
    if (!validStatus && !validCheck) throw new Error(`Required GitHub check is missing or unsuccessful: ${wanted.context}`);
  }
  return { pull, branch, files: paths, statuses: [...latest.values()], checks, protection };
}
export async function mergeGithubPull(options) {
  const { request, address, pullNumber, headSha, baseSha } = options;
  const snapshot = await inspectGithubPull(options);
  const prefix = `/repos/${address.repository}`;
  // The API's head comparison prevents merging a replacement candidate. Existing
  // server-side branch/ruleset checks still apply; this client never bypasses them.
  const result = await request('PUT', `${prefix}/pulls/${pullNumber}/merge`, { sha: headSha, merge_method: 'merge' });
  if (result.merged !== true || !SHA.test(result.sha)) throw new Error('GitHub did not report a completed merge');
  const merged = await request('GET', `${prefix}/commits/${result.sha}`);
  const main = await request('GET', `${prefix}/branches/${encodeURIComponent(address.branch)}`);
  if (merged.parents?.length !== 2 || merged.parents[0].sha !== baseSha || merged.parents[1].sha !== headSha || main.commit?.sha !== result.sha) throw new Error(`Merge ${result.sha} occurred, but exact reviewed parents/current main readback did not match; delivery is not verified`);
  if (!SHA.test(merged.commit?.tree?.sha ?? '')) throw new Error('Merged tree SHA is missing');
  return {
    schemaVersion: 'workloom.main-integration/v1', platform: 'github', repository: address.repository,
    branch: address.branch, pullNumber, headSha, baseSha, mainSha: result.sha, treeSha: merged.commit.tree.sha,
    parents: merged.parents.map(p => p.sha), status: 'verified', verifiedAt: new Date().toISOString(),
    existingCheckCount: snapshot.checks.length + snapshot.statuses.length,
    files: snapshot.files, policySha256: deliveryPolicySha256(),
    reviewReceipt: options.reviewReceipt,
    mirror: { platform: 'cnb', state: 'deferred', blocksDelivery: false },
  };
}
export function mirrorPlan(doc, identity, receipt) {
  const entry = repository(doc, identity);
  if (receipt?.schemaVersion !== 'workloom.main-integration/v1' || receipt.status !== 'verified' || receipt.repository !== entry.github.repository || !SHA.test(receipt.mainSha) || !SHA.test(receipt.treeSha)) throw new Error('A verified GitHub main integration receipt is required');
  return {
    schemaVersion: 'workloom.deferred-mirror/v1', logicalId: entry.logicalId,
    source: { ...entry.github, commit: receipt.mainSha, tree: receipt.treeSha }, destination: entry.cnb,
    state: entry.cnb ? 'deferred' : 'not-configured', blocksGithubDelivery: false,
    productSyncAutomatic: false, configOnlyBackupAllowed: Boolean(entry.cnb),
    branchPrefix: doc.mirrorPolicy.configBackupBranchPrefix,
    allowedPaths: ['.workloom-repository.json', '.workloom-delivery.json'],
    note: 'A config backup branch is not a CNB main integration or a product mirror receipt.',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const opt = name => args[args.indexOf(name) + 1];
    if (!['inspect', 'merge', 'mirror-plan'].includes(args[0]) || !args.includes('--logical-id')) throw new Error('Usage: github.mjs inspect|merge --logical-id ID --pr N --head SHA --base SHA --review RECEIPT [--output FILE]; mirror-plan --logical-id ID --integration RECEIPT');
    const doc = loadRegistry(); const identity = opt('--logical-id');
    let result;
    if (args[0] === 'mirror-plan') result = mirrorPlan(doc, identity, JSON.parse(readFileSync(opt('--integration'), 'utf8')));
    else {
      const options = { request: createGithubClient(), address: addressFor(doc, identity), pullNumber: Number(opt('--pr')), headSha: opt('--head'), baseSha: opt('--base'), reviewReceipt: JSON.parse(readFileSync(opt('--review'), 'utf8')) };
      result = args[0] === 'merge' ? await mergeGithubPull(options) : await inspectGithubPull(options);
    }
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.includes('--output')) writeFileSync(opt('--output'), output); else console.log(output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
