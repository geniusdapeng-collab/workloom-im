#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { GitStateStore, git } from './git-state.mjs';
import { Platform } from './queue-platform.mjs';
import { loadPolicy } from './queue-policy.mjs';
import { prepareReview, finishReview, independentCodeBuddyApproval } from './queue-work.mjs';
import { reconcile, writeTaskReceipts } from './queue-controller.mjs';
import { reconcileReleases } from './queue-release.mjs';
import { appendEvent, branchName, checksVerdict, leaseOperation, parseIntent, SHA_RE, STATE_BRANCH, updateTask } from './queue-model.mjs';
import { branchProtectionPayload, redactCredentials, requireToken, validateBranchProtection } from '../tools/cnb-api.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export async function ensureStateProtection(platform) {
  // CNB retains the PR requirement flag while granting the explicit admin-only
  // push exception. Verify the actual stored rule; never grant ordinary pushes.
  const expected = { ...branchProtectionPayload({ rule: STATE_BRANCH, requireReview: false }), allow_pushes: false, allow_master_pushes: true, required_must_push_via_pull_request: true, required_status_checks: false };
  const stateRule = (await platform.protections()).find(rule => rule.rule === STATE_BRANCH);
  if (!stateRule) {
    try { await platform.call('/-/settings/branch-protections', { method: 'POST', body: expected }); }
    catch (error) {
      // A settings write may have succeeded before its acknowledgement was lost.
      const recovered = (await platform.protections()).find(rule => rule.rule === STATE_BRANCH);
      if (!recovered || Object.entries(expected).some(([key, value]) => recovered[key] !== value)) throw error;
    }
  }
  const actual = (await platform.protections()).find(rule => rule.rule === STATE_BRANCH);
  if (!actual || Object.entries(expected).some(([key, value]) => actual[key] !== value)) throw new Error('Durable state protection did not read back');
  return actual;
}

/** Initialize the protected ledger before the installer can add its lease reader to main. */
export async function prepareInstallation({ platform, store, root, installer }) {
  if (!Number.isSafeInteger(installer?.number) || installer.number <= 0 || installer.state !== 'open' || installer.is_wip !== false || branchName(installer.base?.ref) !== 'main' || !SHA_RE.test(installer.head?.sha ?? '')) throw new Error('Preparation requires a current open installer PR');
  if (await git(['rev-parse', 'HEAD'], { cwd: root }) !== installer.head.sha) throw new Error('Preparation checkout differs from installer source');
  const mainSha = (await platform.main()).commit?.sha;
  if (installer.base?.sha !== mainSha) throw new Error('Installer main changed before state preparation');
  await store.read(); // Existing malformed branches are corruption, never an empty ledger.
  await ensureStateProtection(platform);
  const result = await store.mutate(state => appendEvent(state, 'installation_prepared', { installer: installer.number, headSha: installer.head.sha, mainSha }), { id: `install-state:${installer.number}:${installer.head.sha}` });
  return { repo: platform.repo, installer: installer.number, headSha: installer.head.sha, mainSha, revision: result.state.revision, activated: false };
}

export async function requireTrustedRunner(platform, root, env = process.env, lock = 'workloom-delivery-merge') {
  const allowed = new Set(['pull_request.target', 'pull_request.mergeable', 'pull_request.merged', 'api_trigger_delivery_review', 'api_trigger_delivery_reconcile', 'api_trigger_delivery_releases']);
  const event = String(env.CNB_EVENT ?? '');
  if (!env.CNB_BUILD_ID || (!allowed.has(event) && env.CNB_IS_CRONEVENT !== 'true')) throw new Error('Delivery mutation requires a trusted CNB main pipeline');
  if (env.DELIVERY_NATIVE_LOCK !== lock) throw new Error('Delivery mutation requires its native repository lock');
  const head = await git(['rev-parse', 'HEAD'], { cwd: root });
  if (head !== (await platform.main()).commit?.sha) throw new Error('Runner is not checked out at current trusted main');
}

export async function activate({ platform, store, root, installer }) {
  const cnb = await readFile(resolve(root, '.cnb.yml'), 'utf8');
  if (!cnb.includes('scripts/delivery/cnb.yml')) throw new Error('Trusted main does not include the delivery pipelines');
  const mainSha = (await platform.main()).commit?.sha;
  if (await git(['rev-parse', 'HEAD'], { cwd: root }) !== mainSha) throw new Error('Activation requires current main');
  if (!installer || installer.is_merged !== true) throw new Error('Activation requires a real installer merge receipt');
  if (!(await store.read()).events.some(event => event.kind === 'installation_prepared' && event.data.installer === installer.number && event.data.headSha === installer.head?.sha)) throw new Error('Installer ledger was not prepared for the exact source before merge');
  const policy = await loadPolicy(root);
  const statuses = await platform.call(`/-/pulls/${installer.number}/commit-statuses`);
  const tested = await platform.commit(statuses.sha);
  const parents = tested.parents?.map(parent => parent.sha) ?? [];
  const checkErrors = checksVerdict(statuses, tested, { headSha: installer.head?.sha, mainSha: parents[0] }, [...policy.requiredNames, 'delivery-bootstrap-review']);
  if (checkErrors.length) throw new Error(`Installer CI not verified: ${checkErrors.join('; ')}`);
  const reviews = await platform.list(`/-/pulls/${installer.number}/reviews`);
  const head = await platform.commit(installer.head.sha);
  const independentApproval = independentCodeBuddyApproval(reviews, installer, Date.parse(head.commit?.committer?.date ?? head.commit?.author?.date));
  const candidateExpected = { ...branchProtectionPayload({ rule: 'delivery/candidate/**', requireReview: false }), required_status_checks: false };
  const candidateRule = (await platform.protections()).find(rule => rule.rule === candidateExpected.rule);
  if (!candidateRule) await platform.call('/-/settings/branch-protections', { method: 'POST', body: candidateExpected });
  await platform.assertCandidateProtection();
  const rules = await platform.protections();
  const main = rules.find(rule => rule.rule === 'main');
  const errors = validateBranchProtection(main, { requireReview: true });
  if (errors.length) throw new Error(errors.join('; '));
  if (main.required_master_approve !== false || main.forbid_approve_pull_created_by_own_npc !== false) {
    const { id, ...current } = main;
    await platform.call(`/-/settings/branch-protections/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...current, required_master_approve: false, forbid_approve_pull_created_by_own_npc: false } });
    const after = (await platform.protections()).find(rule => rule.id === id);
    if (!after || after.required_master_approve !== false || after.forbid_approve_pull_created_by_own_npc !== false || after.required_status_checks !== true || validateBranchProtection(after).length) throw new Error('Automatic AI approval policy did not read back');
  }
  await ensureStateProtection(platform);
  await store.mutate(state => appendEvent(state, 'activated', { mainSha, installer: installer.number, policyHash: policy.hash, independentApproval, humanClickRequired: false }));
  return { repo: platform.repo, mainSha, policyHash: policy.hash, humanClickRequired: false };
}

export async function main() {
  const command = process.argv[2];
  const repo = arg('--repo', process.env.CNB_REPO_SLUG);
  const token = requireToken();
  const root = resolve(arg('--root', ROOT));
  const platform = new Platform(repo, token);
  const store = new GitStateStore({ repo, token });
  const number = Number(arg('--pr', process.env.DELIVERY_PR || process.env.CNB_PULL_REQUEST_IID));
  if (command === 'status') { console.log(JSON.stringify(await store.read(), null, 2)); return; }
  if (command === 'lease') {
    const action = arg('--action', 'acquire');
    const owner = arg('--owner');
    const scopes = arg('--scopes', '').split(',').filter(Boolean);
    const generation = JSON.parse(arg('--generation', '{}'));
    const result = await store.mutate(state => leaseOperation(state, { action, owner, scopes, generation }));
    console.log(JSON.stringify({ owner, generation: result.result, revision: result.state.revision })); return;
  }
  if (command === 'handoff') {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('handoff requires --pr');
    const pull = await platform.pull(number);
    const intent = parseIntent(pull);
    const dependencies = arg('--depends-on', intent.dependsOn.join(',')).split(',').filter(Boolean).map(Number);
    const contract = { task_id: intent.taskId, ready: true, depends_on: dependencies, releases: intent.releases };
    if (contract.task_id === null) delete contract.task_id;
    const block = `<!-- workloom-delivery\n${JSON.stringify(contract, null, 2)}\n-->`;
    const old = String(pull.body ?? '');
    const body = /<!--\s*workloom-delivery\s*\n[\s\S]*?\n\s*-->/.test(old) ? old.replace(/<!--\s*workloom-delivery\s*\n[\s\S]*?\n\s*-->/, block) : `${old}\n\n${block}`;
    const updatedIntent = parseIntent({ ...pull, body });
    await platform.call(`/-/pulls/${number}`, { method: 'PATCH', body: { body } });
    const actual = await platform.pull(number);
    if (actual.body !== body) throw new Error('Handoff did not read back');
    await store.mutate(state => {
      for (const [scope, lease] of Object.entries(state.leases)) {
        if (lease.owner === updatedIntent.taskId && lease.expiresAt > Date.now()) leaseOperation(state, { action: 'release', owner: lease.owner, scopes: [scope], generation: { [scope]: lease.generation } });
      }
      updateTask(state, number, { status: actual.is_wip ? 'developing' : 'waiting_ci', headSha: actual.head?.sha, branch: branchName(actual.head?.ref), intent: updatedIntent });
    });
    console.log(JSON.stringify({ number, headSha: actual.head?.sha, handedOff: true, draft: actual.is_wip })); return;
  }
  const policy = await loadPolicy(root);
  if (command === 'prepare-install') {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Preparation requires installer --pr');
    console.log(JSON.stringify(await prepareInstallation({ platform, store, root, installer: await platform.pull(number) }), null, 2)); return;
  }
  if (command === 'review-prepare') {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Review requires a PR number');
    const result = await prepareReview({ platform, store, policy, root, number, stateless: process.env.DELIVERY_REVIEW_STATELESS === '1' });
    if (!result) { process.exitCode = 78; return; }
    for (const [key, value] of Object.entries(result)) console.log(`##[set-output ${key}=base64,${Buffer.from(String(value)).toString('base64')}]`);
    return;
  }
  if (command === 'review-finish') {
    console.log(JSON.stringify(await finishReview({ platform, store, policy, root, stateless: process.env.DELIVERY_REVIEW_STATELESS === '1' }), null, 2)); return;
  }
  if (command === 'activate') {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Activation requires installer --pr');
    console.log(JSON.stringify(await activate({ platform, store, root, installer: await platform.pull(number) }), null, 2)); return;
  }
  if (command === 'reconcile') {
    const dryRun = process.argv.includes('--dry-run');
    if (!dryRun) await requireTrustedRunner(platform, root);
    const report = await reconcile({ platform, store, policy, dryRun });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length) process.exitCode = 1;
    return;
  }
  if (command === 'releases') {
    await requireTrustedRunner(platform, root, process.env, 'workloom-delivery-release');
    if (!(await store.read()).events.some(event => event.kind === 'activated')) { console.log(JSON.stringify({ waiting: 'Verified activation is required' })); return; }
    const report = await reconcileReleases({ platform, store });
    await writeTaskReceipts({ platform, store });
    console.log(JSON.stringify(report, null, 2));
    if (report.some(item => ['parked', 'unknown', 'failed', 'timeout_running'].includes(item.status))) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: queue-runner.mjs status|lease|handoff|review-prepare|review-finish|prepare-install|activate|reconcile|releases [--repo org/name]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
