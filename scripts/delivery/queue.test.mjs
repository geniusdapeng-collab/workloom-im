import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, checksVerdict, dependencyState, eligibility, emptyState, hash, leaseOperation, parseIntent, releaseKey, updateTask, validateReview, validateState } from './queue-model.mjs';
import { GitStateStore, git } from './git-state.mjs';
import { alignBranch, independentCodeBuddyApproval } from './queue-work.mjs';
import { Platform } from './queue-platform.mjs';
import { BASE_POLICY, REVIEW_IMAGE, ciImplementationChanges, loadPolicy, parser, prPipelines, resolvePipelineConfig, sourcePipelineReport, validateSourcePipeline } from './queue-policy.mjs';
import { dependencies, integratedDependency, mergeCandidate, reconcile, requestReview, reviewSlotBusy, writeTaskReceipts } from './queue-controller.mjs';
import { enqueueReleases, reconcileReleases, verifyRelease } from './queue-release.mjs';
import { injectDeliveryConfig } from './install-config.mjs';
import { batchEnvironment, batchSnapshot, botApiEndpoint, combineBatchResults, reviewBatches, reviewEnvironment, runReview, validateIssueSchema } from './review-plugin.mjs';
import { configureAutomaticReviewPolicy, ensureStateProtection, prepareInstallation, requireTrustedRunner, verifyInstallerChecks, verifyPreparedInstallation } from './queue-runner.mjs';
import { verifyReleaseSource } from './release-source.mjs';
import { modelGateway } from './model-gateway.mjs';
import { randomUUID } from 'node:crypto';
const repo = 'workloom-ai/test'; const head = 'a'.repeat(40); const main = 'b'.repeat(40); const mergedSha = 'c'.repeat(40); const testedSha = 'd'.repeat(40); const now = 10_000_000;
const policy = { ...BASE_POLICY, hash: 'policy-1', requiredNames: ['static-gate'] };
const intent = { ready: true, dependsOn: [], releases: [], taskId: null };
test('genuine AI endpoint configuration has a clear closed failure for absent, malformed and foreign values', () => {
  assert.equal(botApiEndpoint({ CNB_API_ENDPOINT: 'https://api.cnb.cool' }), 'https://api.cnb.cool');
  for (const value of [undefined, '', 'invalid', 'http://api.cnb.cool', 'https://example.com']) assert.throws(() => botApiEndpoint({ CNB_API_ENDPOINT: value }), /requires CNB_API_ENDPOINT/);
});
function snapshot(number = 1, patch = {}) {
  return { number, headSha: head, mainSha: main, headTime: 0, mergeBase: main, files: ['apps/example.ts'], checkErrors: [], checkSha: testedSha, intent,
    pull: { number, title: 'fix(base): useful change', body: '', state: 'open', is_wip: false, mergeable_state: 'mergeable', labels: [], head: { sha: head, ref: `task/test-${number}`, repo: { path: repo } }, base: { sha: main, ref: 'main' } }, ...patch };
}
function review(s = snapshot()) { return { passed: true, headSha: s.headSha, mainSha: s.mainSha, policyHash: policy.hash, filesHash: hash([...s.files].sort()), dependsOn: [] }; }
function memoryStore(initial = emptyState(repo)) {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), mutate: async operation => { const next = structuredClone(value); const result = operation(next); validateState(next, repo); value = next; return { state: structuredClone(value), result }; } };
}
function activate(state) { appendEvent(state, 'activated', { policyHash: policy.hash }, now); return state; }
async function temporary(t, prefix) { const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('lease acquisition is atomic across scopes; TTL reclaim fences stale renewal and release', () => {
  const state = emptyState(repo); const generation = leaseOperation(state, { action: 'acquire', owner: 'a', scopes: ['protocol', 'sync'], ttlMs: 60000 }, 0);
  assert.throws(() => leaseOperation(state, { action: 'acquire', owner: 'b', scopes: ['migrations', 'sync'] }, 1), /busy/);
  assert.equal(state.leases.migrations, undefined);
  const next = leaseOperation(state, { action: 'acquire', owner: 'b', scopes: ['sync'], ttlMs: 60000 }, 60000);
  assert.equal(next.sync, generation.sync + 1);
  for (const action of ['release', 'renew']) assert.throws(() => leaseOperation(state, { action, owner: 'a', scopes: ['sync'], generation }, 60001), /expired/);
  leaseOperation(state, { action: 'release', owner: 'b', scopes: ['sync'], generation: next }, 60001);
  assert.equal(state.leases.sync.owner, null); validateState(state, repo);
});
test('lease empty/oversized TTL and mismatched scope generation cannot silently succeed', () => {
  for (const spec of [{ scopes: [] }, { ttlMs: 59999 }, { ttlMs: 1800001 }, { owner: '' }, { scopes: [''] }]) assert.throws(() => leaseOperation(emptyState(repo), { action: 'acquire', owner: 'a', scopes: ['protocol'], ...spec }, 0));
});
test('state hash chain detects history tampering and incomplete/foreign snapshots', () => {
  const state = emptyState(repo); updateTask(state, 1, { status: 'waiting_ci' }, now); validateState(state, repo);
  const bad = structuredClone(state); bad.events[0].data.patch.status = 'delivered'; assert.throws(() => validateState(bad, repo), /chain/);
  for (const invalid of [{ ...state, repo: 'foreign/repo' }, { ...state, revision: 5 }, { ...state, tasks: { 1: { status: 'invented' } } }]) assert.throws(() => validateState(invalid, repo));
});
test('explicit intent preserves native prerequisites and rejects duplicates/self dependency/ambiguous releases', () => {
  const pull = { number: 4, title: 'task T-2026-1005-1001', blocked_on: [{ number: 2 }], body: '<!-- workloom-delivery\n{"ready":true,"depends_on":[1],"releases":[{"kind":"ui","version":"1.2.3"}]}\n-->' };
  assert.deepEqual(parseIntent(pull).dependsOn, [1, 2]); assert.equal(parseIntent(pull).taskId, 'T-2026-1005-1001');
  for (const body of [pull.body + pull.body, '<!-- workloom-delivery\n{"depends_on":[4]}\n-->', '<!-- workloom-delivery\n{"releases":[{"kind":"ui","version":"latest"}]}\n-->', '<!-- workloom-delivery\n{"ready":"yes"}\n-->', '<!-- workloom-delivery\n{"bypass":true}\n-->']) assert.throws(() => parseIntent({ ...pull, body }));
});
test('dependency DAG reports cycles and closed unmerged prerequisites remain pending', async () => {
  assert.throws(() => dependencyState(1, new Map([[1, [2]], [2, [1]]]), new Set()), /cycle/);
  const pulls = [{ ...snapshot().pull, body: '<!-- workloom-delivery\n{"depends_on":[2]}\n-->' }];
  const result = await dependencies({ pull: async () => ({ state: 'closed', is_merged: false }) }, pulls, emptyState(repo));
  assert.deepEqual(result.get(1).pending, [2]);
  const advanced = { head: { sha: head }, is_merged: false };
  assert.equal(integratedDependency(advanced, { status: 'waiting_ci', merge: { sourceSha: head } }), false);
  assert.equal(integratedDependency(advanced, { status: 'integrated', merge: { sourceSha: main } }), false);
  assert.equal(integratedDependency(advanced, { status: 'integrated', merge: { sourceSha: head } }), true);
});
test('malformed contract isolates one PR instead of breaking unrelated dependency analysis', async () => {
  const list = [{ ...snapshot(1).pull, body: '<!-- workloom-delivery\nBAD\n-->' }, snapshot(2).pull];
  const map = await dependencies({}, list, emptyState(repo)); assert.ok(map.get(1).error); assert.deepEqual(map.get(2), { pending: [], error: null });
});
test('unreadable dependency blocks its dependents while unrelated PRs keep progressing', async () => {
  const list = [{ ...snapshot(1).pull, body: '<!-- workloom-delivery\n{"depends_on":[3]}\n-->' }, snapshot(2).pull];
  const map = await dependencies({ pull: async () => { throw new Error('denied'); } }, list, emptyState(repo));
  assert.match(map.get(1).error, /Prerequisite #3 is unreadable/); assert.deepEqual(map.get(1).pending, [3]);
  assert.deepEqual(map.get(2), { pending: [], error: null });
});
test('AI build watchdog counts terminal failures once and respects backoff, budget and pending runs', async () => {
  const state = emptyState(repo); updateTask(state, 1, { status: 'waiting_review', headSha: head, mainSha: main,
    reviewBuild: { sn: 'run-1', headSha: head, mainSha: main, at: now - 600000 } }, now - 600000);
  const store = memoryStore(state); let writes = 0; let status = 'pending';
  const platform = { call: async (_path, options) => { if (options?.method === 'POST') writes++; return { status }; }, builds: async () => [] };
  assert.equal((await requestReview(platform, store, snapshot(), null, now)).waiting, 'running');
  status = 'error'; await requestReview(platform, store, snapshot(), null, now);
  assert.equal((await store.read()).tasks['1'].reviewFailures.count, 1);
  assert.equal((await requestReview(platform, store, snapshot(), null, now + 1)).waiting, 'backoff');
  await store.mutate(current => updateTask(current, 1, { reviewBuild: { sn: 'run-2', headSha: head, mainSha: main, at: now } }, now));
  await requestReview(platform, store, snapshot(), null, now + 600001);
  assert.equal((await requestReview(platform, store, snapshot(), null, now + 1800000)).waiting, 'budget'); assert.equal(writes, 0);
});
test('lost AI launch acknowledgement is recovered by unique title without a duplicate request', async () => {
  const state = emptyState(repo); updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main }, now - 600000);
  const store = memoryStore(state); let writes = 0; let history = [];
  const platform = { builds: async () => history, call: async () => { writes++; throw new Error('lost ack'); } };
  await assert.rejects(requestReview(platform, store, snapshot(), null, now), /lost ack/);
  assert.equal((await requestReview(platform, store, snapshot(), null, now + 60000)).waiting, 'unknown-launch');
  const dispatch = (await store.read()).tasks['1'].reviewDispatch;
  history = [{ sn: 'recovered', title: dispatch.title, sha: main, event: 'api_trigger_delivery_review' }];
  assert.equal((await requestReview(platform, store, snapshot(), null, now + 120000)).waiting, 'recovered-launch');
  assert.equal((await store.read()).tasks['1'].reviewBuild.sn, 'recovered'); assert.equal(writes, 1);
});
test('AI receipt requires exact identity, complete unique scope, no unresolved issues and valid prerequisites', () => {
  const s = snapshot(); const good = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.equal(validateReview(good, s, policy.hash).passed, true);
  for (const patch of [{ status: 'critical' }, { issues: [{ problem: 'bug' }] }, { reviewed_files: [] }, { reviewed_files: [...s.files, ...s.files] }, { head_sha: main }, { base_sha: head }, { policy_hash: 'old' }, { depends_on: [1] }]) assert.throws(() => validateReview({ ...good, ...patch }, s, policy.hash));
});
test('real platform approval requires an independent known creator, actual NPC identity and a fresh decision', () => {
  const pull = { author: { username: 'creator' } }; const approval = { id: 'review-1', state: 'approved', author: { username: 'CodeBuddy', is_npc: true }, created_at: new Date(now).toISOString() };
  assert.equal(independentCodeBuddyApproval([approval], pull, now).creator, 'creator');
  for (const change of [{ state: 'changes_requested' }, { created_at: new Date(now - 1).toISOString() }, { author: { username: 'CodeBuddy', is_npc: false } }, { author: { username: 'another-bot', is_npc: true } }]) assert.throws(() => independentCodeBuddyApproval([{ ...approval, ...change }], pull, now), /independent/);
  assert.throws(() => independentCodeBuddyApproval([approval], { author: { username: 'codebuddy' } }, now), /independent/);
  assert.throws(() => independentCodeBuddyApproval([approval], {}, now), /known/);
  assert.throws(() => independentCodeBuddyApproval([approval], pull, NaN), /freshness/);
});
test('CI must test exact main/source parents and each trusted required pipeline, never a loose green commit', () => {
  const payload = { sha: testedSha, statuses: [{ context: 'cnb/pull_request/pipeline-1(static-gate)', state: 'success' }, { context: 'cnb/pull_request/pipeline-2(debt-gate)', state: 'error' }] };
  const commit = { sha: testedSha, parents: [{ sha: main }, { sha: head }] };
  assert.deepEqual(checksVerdict(payload, commit, { headSha: head, mainSha: main }, ['static-gate']), []);
  assert.ok(checksVerdict(payload, { ...commit, parents: [{ sha: head }, { sha: main }] }, { headSha: head, mainSha: main }, ['static-gate']).length);
  for (const statuses of [[], [payload.statuses[0], payload.statuses[0]], [{ ...payload.statuses[0], state: 'pending' }], [{ ...payload.statuses[0], context: 'cnb/push/pipeline-1(static-gate)' }]]) assert.ok(checksVerdict({ ...payload, statuses }, commit, { headSha: head, mainSha: main }, ['static-gate']).length);
});
test('installer activation binds tested main to the independent preparation receipt, not a tested parent to itself', () => {
  const state = emptyState(repo); const installer = { number: 234, head: { sha: head } };
  appendEvent(state, 'installation_prepared', { installer: 234, headSha: head, mainSha: main });
  const statuses = { sha: testedSha, statuses: ['static-gate', 'delivery-bootstrap-review'].map(name => ({ context: `cnb/pull_request/pipeline-1(${name})`, state: 'success' })) };
  const tested = { sha: testedSha, parents: [{ sha: main }, { sha: head }] };
  const input = { state, installer, statuses, tested, requiredNames: ['static-gate'] };
  assert.equal(verifyInstallerChecks(input).mainSha, main);
  assert.throws(() => verifyInstallerChecks({ ...input, tested: { ...tested, parents: [{ sha: mergedSha }, { sha: head }] } }), /source\/main pair/);
  assert.throws(() => verifyInstallerChecks({ ...input, state: emptyState(repo) }), /prepared/);
  assert.throws(() => verifyInstallerChecks({ ...input, installer: { ...installer, head: { sha: main } } }), /prepared/);
});
test('genuine exact AI replaces the human review counter while preserving all other main restrictions, including lost acknowledgement recovery', async () => {
  const { branchProtectionPayload } = await import('../tools/cnb-api.mjs');
  let rule = { ...branchProtectionPayload(), id: 'main-rule', required_master_approve: true }; let writes = 0;
  const platform = { protections: async () => [rule], call: async (_path, options) => { writes++; rule = { ...options.body, id: rule.id }; throw new Error('lost acknowledgement'); } };
  const proof = { independentApproval: { id: 'genuine-npc-review', author: 'CodeBuddy', creator: 'developer', isNpc: true }, preparation: { headSha: head, mainSha: main } };
  await assert.rejects(configureAutomaticReviewPolicy(platform), /proof/); assert.equal(writes, 0);
  await assert.rejects(configureAutomaticReviewPolicy(platform, { ...proof, independentApproval: { ...proof.independentApproval, creator: 'codebuddy' } }), /proof/); assert.equal(writes, 0);
  const before = { ...rule }; const after = await configureAutomaticReviewPolicy(platform, proof);
  assert.equal(after.required_pull_request_reviews, false); assert.equal(after.required_master_approve, false);
  for (const [key, value] of Object.entries(before)) if (!['required_pull_request_reviews', 'required_master_approve'].includes(key)) assert.equal(after[key], value);
  await configureAutomaticReviewPolicy(platform, proof); assert.equal(writes, 1);
  rule.allow_master_pushes = true; await assert.rejects(configureAutomaticReviewPolicy(platform, proof), /allow_master_pushes/); assert.equal(writes, 1);
});
test('eligibility rejects draft/block/expired review/wrong main/unhanded head even with green CI', () => {
  const s = snapshot(); assert.deepEqual(eligibility(s, { review: review(s) }, policy, now), []);
  for (const patch of [{ pull: { ...s.pull, is_wip: true } }, { pull: { ...s.pull, labels: ['risk/block'] } }, { mainSha: head }, { intent: { ...intent, ready: false } }, { pendingDependencies: [2] }, { files: ['secrets/real'] }]) assert.ok(eligibility({ ...s, ...patch }, { review: review(s) }, policy, now).length);
  assert.ok(eligibility(s, { review: { ...review(s), policyHash: 'old' } }, policy, now).includes('No current complete AI review'));
});
test('source CI preserves required identities; implementation changes require exact AI migration evidence', async () => {
  const YAML = await parser(); const baseline = { name: 'static-gate', stages: [{ name: 'compile', script: 'compile' }, { name: 'test', script: 'test' }] };
  const p = { requiredPipelines: [baseline] };
  const text = pipeline => YAML.stringify({ '**': { pull_request: [pipeline] } });
  assert.deepEqual(await validateSourcePipeline(text({ ...baseline, stages: [...baseline.stages, { name: 'more', script: 'more' }] }), p), []);
  for (const changed of [{ ...baseline, allowFailure: true }, { ...baseline, name: 'pretend' }, { ...baseline, stages: [baseline.stages[1]] }, { ...baseline, stages: [...baseline.stages].reverse() }]) assert.ok((await validateSourcePipeline(text(changed), p)).length);
  const report = await sourcePipelineReport(text({ ...baseline, stages: [{ ...baseline.stages[0], script: 'upgraded-compile' }, baseline.stages[1]] }), p);
  assert.deepEqual(report.errors, []); assert.equal(report.changes.length, 1);
  const s = snapshot(1, { ciPolicyChanges: report.changes });
  const output = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.throws(() => validateReview(output, s, policy.hash), /migration/);
  for (const ci_policy_changes of [[{ id: 'wrong', rationale: 'tested' }], [{ id: report.changes[0].id, rationale: '' }]]) assert.throws(() => validateReview({ ...output, ci_policy_changes }, s, policy.hash), /migration/);
  const receipt = validateReview({ ...output, ci_policy_changes: [{ id: report.changes[0].id, rationale: 'The replacement runs the same compile with updated tooling; compile regression remains required.' }] }, s, policy.hash);
  assert.deepEqual(eligibility(s, { review: receipt }, policy, now), []);
  assert.ok(eligibility(s, { review: review(s) }, policy, now).includes('No exact AI CI migration receipt'));
});
test('unchanged YAML cannot hide edits to required check implementations and dependency policy', () => {
  const files = [{ path: 'scripts/ci/verify-lock-conflict.mjs', status: 'modify' }, { path: 'governance/scripts/ci/verify.py', status: 'delete' }, { path: 'pnpm-lock.yaml', status: 'modify' }, { path: 'scripts/delivery/cnb.yml', status: 'add' }, { path: 'apps/product.ts', status: 'modify' }];
  const changes = ciImplementationChanges(files, main, head);
  assert.equal(changes.length, 4);
  assert.deepEqual(changes[0].before, { ref: main, path: files[0].path, absent: false });
  assert.equal(changes[1].after.absent, true); assert.equal(changes[3].before.absent, true);
  assert.notEqual(changes[0].id, ciImplementationChanges(files, head, main)[0].id);
  const s = snapshot(1, { files: files.map(file => file.path), ciPolicyChanges: changes });
  const output = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.throws(() => validateReview(output, s, policy.hash), /migration/);
  assert.equal(validateReview({ ...output, ci_policy_changes: changes.map(change => ({ id: change.id, rationale: 'Read exact old/new Git source and verified retained assertions.' })) }, s, policy.hash).passed, true);
});
test('local include graph preserves product arrays and structurally pins delivery events and stage order', async t => {
  const root = await temporary(t, 'delivery-policy-'); const YAML = await parser();
  const gate = { name: 'static-gate', stages: [{ name: 'check', script: 'check' }] };
  const delivery = { name: 'delivery-ai-review', stages: [{ name: 'snapshot', script: 'snapshot' }, { name: 'review', script: 'review' }] };
  const source = YAML.stringify({ include: 'local.yml', main: { pull_request: [gate] } });
  const included = YAML.stringify({ main: { pull_request: [{ name: 'included-gate', stages: [{ name: 'extra', script: 'extra' }] }], 'pull_request.target': [delivery] } });
  await writeFile(join(root, '.cnb.yml'), source); await writeFile(join(root, 'local.yml'), included);
  const p = await loadPolicy(root); assert.deepEqual(p.requiredNames, ['included-gate', 'static-gate']);
  assert.deepEqual((await sourcePipelineReport(source, p, { readLocal: async () => included })).errors, []);
  for (const stages of [delivery.stages.slice(1), [...delivery.stages].reverse()]) {
    const changed = YAML.stringify({ main: { pull_request: [{ name: 'included-gate', stages: [{ name: 'extra', script: 'extra' }] }], 'pull_request.target': [{ ...delivery, stages }] } });
    assert.ok((await sourcePipelineReport(source, p, { readLocal: async () => changed })).errors.length);
  }
  assert.ok((await sourcePipelineReport(YAML.stringify({ main: { pull_request: [gate] } }), p)).errors.length);
  await assert.rejects(resolvePipelineConfig('include: ../escape.yml\n', { readLocal: async () => included }), /safe local/);
  await assert.rejects(resolvePipelineConfig('include: local.yml\n', { readLocal: async () => 'include: local.yml\n' }), /cycle/);
  await assert.rejects(resolvePipelineConfig(source, { readLocal: async () => { throw new Error('denied'); } }), /denied/);
});
test('CI installation is idempotent and preserves every existing product event/stage', async () => {
  const input = '# existing\nmain:\n  push:\n    - name: product\n      stages: [keep]\ninclude: old.yml\n'; const YAML = await parser();
  const installed = await injectDeliveryConfig(input); assert.equal(installed.changed, true);
  assert.deepEqual(YAML.parse(installed.content).main, YAML.parse(input).main);
  assert.deepEqual(YAML.parse(installed.content).include, ['old.yml', 'scripts/delivery/cnb.yml']);
  assert.equal((await injectDeliveryConfig(installed.content)).changed, false);
  await assert.rejects(injectDeliveryConfig('not: [valid'), /valid/);
});
test('review child receives trusted identity and paths; inherited plugin overrides cannot weaken the gate', async t => {
  const root = await temporary(t, 'delivery-review-env-'); const directory = join(root, '.delivery-review/snapshot-x'); await mkdir(directory, { recursive: true });
  const manifest = { snapshot: snapshot(), directory, source: join(directory, 'source'), rules: join(directory, 'rules'), coverage: join(directory, 'coverage'), output: join(directory, 'output') };
  await writeFile(join(root, '.delivery-review/manifest.json'), JSON.stringify(manifest));
  const result = await reviewEnvironment(root, { PLUGIN_REVIEW_EVENT: 'comment', PLUGIN_MAX_FILES: '1', CNB_PULL_REQUEST_SHA: 'wrong' });
  assert.equal(result.CNB_PULL_REQUEST_SHA, head); assert.equal(result.PLUGIN_REVIEW_EVENT, 'auto'); assert.equal(result.PLUGIN_EXCLUDE_CATEGORIES, '');
  manifest.output = '/tmp/escape.json'; await writeFile(join(root, '.delivery-review/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(reviewEnvironment(root, {}), /escapes/);
});
test('AI batch coverage cannot truncate, duplicate or reuse another source/main result', () => {
  const s = snapshot(1, { files: Array.from({ length: 61 }, (_, index) => `source/${index}.ts`) });
  const manifest = { snapshot: s, policyHash: policy.hash };
  const batches = reviewBatches(s.files); assert.deepEqual(batches.map(files => files.length), [30, 30, 1]);
  const outputs = batches.map(files => ({ status: 'passed', issues: [], reviewed_files: files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] }));
  assert.equal(combineBatchResults(manifest, outputs).reviewed_files.length, 61);
  assert.throws(() => combineBatchResults(manifest, outputs.slice(1)), /missing/);
  for (const patch of [{ reviewed_files: batches[1] }, { reviewed_files: batches[0].slice(1) }, { head_sha: main }]) assert.throws(() => combineBatchResults(manifest, [{ ...outputs[0], ...patch }, ...outputs.slice(1)]));
  const rejected = combineBatchResults(manifest, [{ ...outputs[0], status: 'critical', issues: [{ severity: 'critical', file: s.files[0], start_line: 1, end_line: 1, problem: 'real regression', suggestion: 'fix the regression' }] }, ...outputs.slice(1)]);
  assert.equal(rejected.status, 'critical'); assert.equal(rejected.issues.length, 1);
});
test('model tool subprocess excludes approval and unrelated secrets without mutating the publisher environment', () => {
  const env = { CNB_TOKEN: 'gateway', CNB_TOKEN_FOR_CODEBUDDY: 'approve', CNB_TOKEN_FOR_AI: 'approve2', NPM_TOKEN: 'npm', DATABASE_PASSWORD: 'db', PATH: '/bin', CNB_REPO_SLUG: repo };
  assert.deepEqual(batchEnvironment(env), { PATH: '/bin', CNB_REPO_SLUG: repo });
  assert.equal(env.CNB_TOKEN_FOR_CODEBUDDY, 'approve'); assert.equal(env.CNB_TOKEN_FOR_AI, 'approve2');
});
test('model broker streams only allowed AI routes and never reflects credentials or backend error bodies', async t => {
  const calls = []; let fail = false; const fixtureToken = `test-only-${randomUUID()}`;
  const broker = await modelGateway({ repo, token: fixtureToken, request: async (url, options) => {
    calls.push({ url, options });
    return fail ? new Response(`backend exposes ${fixtureToken}`, { status: 401 }) : new Response('data: model-output\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }); t.after(() => broker.close());
  const ask = path => fetch(broker.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer model-input' }, body: '{}' });
  assert.equal(await (await ask('/v1/messages?beta=true')).text(), 'data: model-output\n\n');
  assert.equal(calls[0].url, `https://api.cnb.cool/${repo}/-/ai/v1/messages?beta=true`);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${fixtureToken}`);
  assert.equal(calls[0].options.redirect, 'error');
  for (const path of ['/pulls/1/merge', '/git/branches', '/v1/messages%2f..%2fmerge']) assert.equal((await ask(path)).status, 403);
  assert.equal((await fetch(broker.url + '/v1/messages')).status, 403);
  assert.equal(calls.length, 1);
  fail = true; const denied = await ask('/chat/completions'); assert.equal(denied.status, 401); const errorBody = await denied.text(); assert.ok(!errorBody.includes(fixtureToken)); assert.doesNotMatch(errorBody, /backend exposes/);
  await assert.rejects(modelGateway({ repo, token: 'test-only', endpoint: 'https://elsewhere.example' }), /identity/);
});
test('CI review receipts are assigned to the responsible batch and collected without omission or duplication', () => {
  const files = Array.from({ length: 61 }, (_, index) => `source/${String(index).padStart(2, '0')}.ts`);
  const ciPolicyChanges = [{ id: 'first', file: files[0] }, { id: 'last', file: files[60] }, { id: 'config' }];
  const s = snapshot(1, { files, ciPolicyChanges });
  const manifest = { snapshot: s, policyHash: policy.hash };
  const results = reviewBatches(files).map((paths, index) => ({ status: 'passed', issues: [], reviewed_files: paths, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [], ci_policy_changes: batchSnapshot(s, index).ciPolicyChanges.map(change => ({ id: change.id, rationale: 'Exact old/new check remains required and has regression coverage.' })) }));
  assert.deepEqual(combineBatchResults(manifest, results).ci_policy_changes.map(change => change.id).sort(), ['config', 'first', 'last']);
  const missing = structuredClone(results); missing[2].ci_policy_changes = []; assert.throws(() => combineBatchResults(manifest, missing), /migration/);
  const duplicate = structuredClone(results); duplicate[1].ci_policy_changes = [results[0].ci_policy_changes[0]]; assert.throws(() => combineBatchResults(manifest, duplicate), /migration/);
});
test('AI issue schema rejects incompatible severity/category/line data without dropping findings', () => {
  const issue = { severity: 'warning', category: 'bug', confidence: 'high', file: '.cnb.yml', start_line: 126, end_line: 126, problem: 'missing test file', suggestion: 'use the actual test file' };
  assert.equal(validateIssueSchema({ status: 'needs_modification', issues: [issue] }).issues.length, 1);
  for (const patch of [{ severity: 'high' }, { category: 'concurrency' }, { start_line: 0 }, { end_line: 1 }, { suggestion: '' }, { file: null }]) assert.throws(() => validateIssueSchema({ status: 'critical', issues: [{ ...issue, ...patch }] }), /schema/);
});
test('required native node-test stages refer to existing repository files', async () => {
  const root = new URL('../../', import.meta.url); const YAML = await parser();
  const config = YAML.parse(await readFile(new URL('.cnb.yml', root), 'utf8'), { maxAliasCount: 1000 });
  let verified = 0;
  for (const pipeline of (prPipelines(config) ?? []).filter(value => value.allowFailure !== true)) {
    for (const stage of pipeline.stages) {
      for (const line of String(stage.script ?? '').split('\n').filter(value => /node --test /.test(value))) {
        for (const path of line.trim().split(/\s+/).slice(2).filter(value => value.endsWith('.mjs'))) {
          const matches = (await git(['ls-files', '-z', '--', path], { cwd: fileURLToPath(root), raw: true })).split('\0').filter(Boolean);
          assert.ok(matches.length, `Missing native test: ${pipeline.name}/${path}`);
          for (const match of matches) assert.ok((await readFile(new URL(match, root), 'utf8')).length); verified++;
        }
      }
    }
  }
  assert.ok(verified > 0);
});
test('bootstrap and trusted-main AI image digests stay bound to the single policy constant', async () => {
  const YAML = await parser();
  const trusted = YAML.parse(await readFile(new URL('./cnb.yml', import.meta.url), 'utf8'));
  const bootstrap = YAML.parse(await readFile(new URL('./bootstrap-cnb.yml', import.meta.url), 'utf8'));
  const images = [trusted.main['pull_request.target'][0], prPipelines(bootstrap)[0]].flatMap(pipeline => pipeline.stages.filter(stage => stage.image).map(stage => stage.image));
  assert.deepEqual(images, [REVIEW_IMAGE, REVIEW_IMAGE]);
});
test('installer updates cancel only their own obsolete bootstrap review and do not share the ordinary review lock', async () => {
  const YAML = await parser();
  const bootstrap = prPipelines(YAML.parse(await readFile(new URL('./bootstrap-cnb.yml', import.meta.url), 'utf8')))[0];
  const ordinary = YAML.parse(await readFile(new URL('./cnb.yml', import.meta.url), 'utf8'))['.delivery-review'];
  assert.equal(bootstrap.lock.key, 'workloom-delivery-bootstrap-$CNB_PULL_REQUEST_IID'); assert.equal(bootstrap.lock['cancel-in-progress'], true);
  assert.notEqual(bootstrap.lock.key, ordinary.lock.key); assert.notEqual(ordinary.lock['cancel-in-progress'], true);
  const names = bootstrap.stages.map(stage => stage.name);
  assert.ok(names.indexOf('Verify protected ledger before installer approval') > names.indexOf('Snapshot exact source and main'));
  assert.ok(names.indexOf('Verify protected ledger before installer approval') < names.indexOf('Genuine independent CodeBuddy review'));
});
test('real review orchestration caps concurrent batches and withholds decisions on incomplete coverage or drift', async t => {
  const root = await temporary(t, 'delivery-batch-'); const directory = join(root, '.delivery-review/snapshot-x'); await mkdir(directory, { recursive: true });
  const s = snapshot(1, { files: Array.from({ length: 91 }, (_, index) => `source/${index}.ts`) });
  const manifest = { snapshot: s, policyHash: policy.hash, directory, source: join(directory, 'source'), rules: join(directory, 'rules'), coverage: join(directory, 'coverage'), output: join(directory, 'output') };
  await writeFile(join(root, '.delivery-review/manifest.json'), JSON.stringify(manifest));
  let active = 0; let maximum = 0; let published = 0;
  const runBatch = async (_index, files) => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; return { status: 'passed', issues: [], reviewed_files: files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] }; };
  const options = { env: {}, platform: { snapshot: async () => s }, runBatch, publish: async output => { published++; assert.equal(output.reviewed_files.length, 91); } };
  await runReview(root, options); assert.equal(maximum, 2); assert.equal(published, 1);
  await assert.rejects(runReview(root, { ...options, runBatch: async (index, files) => ({ ...await runBatch(index, files), reviewed_files: [] }) }), /omitted/);
  await assert.rejects(runReview(root, { ...options, platform: { snapshot: async () => ({ ...s, mainSha: head }) } }), /expired/);
  assert.equal(published, 1);
  let started = 0;
  await assert.rejects(runReview(root, { ...options, runBatch: async () => { started++; throw new Error('SDK interrupted'); } }), /interrupted/);
  assert.ok(started <= 2); assert.equal(published, 1);
});
test('mutation rejects local/PR-source runners, absent native lock and checkout main drift', async t => {
  const root = await temporary(t, 'delivery-runner-'); await git(['init', '--quiet'], { cwd: root }); await git(['commit', '--allow-empty', '-m', 'init'], { cwd: root });
  const sha = await git(['rev-parse', 'HEAD'], { cwd: root }); const platform = { main: async () => ({ commit: { sha } }) };
  const env = { CNB_BUILD_ID: 'build', CNB_EVENT: 'api_trigger_delivery_reconcile', DELIVERY_NATIVE_LOCK: 'workloom-delivery-merge' };
  await requireTrustedRunner(platform, root, env);
  for (const patch of [{ CNB_BUILD_ID: '' }, { CNB_EVENT: 'pull_request' }, { DELIVERY_NATIVE_LOCK: '' }]) await assert.rejects(requireTrustedRunner(platform, root, { ...env, ...patch }));
  await assert.rejects(requireTrustedRunner({ main: async () => ({ commit: { sha: head } }) }, root, env), /trusted main/);
});
test('state preparation initializes a protected ledger before merge without activating it; lost settings ack is read back', async t => {
  const root = await temporary(t, 'delivery-install-state-'); await git(['init', '--quiet'], { cwd: root }); await git(['commit', '--allow-empty', '-m', 'installer'], { cwd: root });
  const tip = await git(['rev-parse', 'HEAD'], { cwd: root }); let rules = []; let writes = 0;
  const platform = { repo, main: async () => ({ commit: { sha: main } }), protections: async () => rules, call: async (_path, options) => { writes++; rules = [{ ...options.body, id: 'state-rule' }]; throw new Error('lost acknowledgement'); } };
  const installer = { number: 234, state: 'open', is_wip: false, head: { sha: tip }, base: { ref: 'main', sha: main } }; const store = memoryStore();
  const prepared = await prepareInstallation({ platform, store, root, installer }); assert.equal(prepared.activated, false); assert.equal(writes, 1);
  assert.ok((await store.read()).events.some(event => event.kind === 'installation_prepared')); assert.equal((await store.read()).events.some(event => event.kind === 'activated'), false);
  await ensureStateProtection(platform); assert.equal(writes, 1);
  assert.equal((await verifyPreparedInstallation({ platform, store, root, installer })).verified, true); assert.equal(writes, 1);
  await assert.rejects(verifyPreparedInstallation({ platform, store: memoryStore(), root, installer }), /exact source/);
  const waiting = memoryStore(); let clock = 0; let sleeps = 0;
  await verifyPreparedInstallation({ platform, store: waiting, root, installer, waitMs: 10000, elapsedClock: () => clock, sleep: async ms => {
    clock += ms; sleeps++; await waiting.mutate(current => appendEvent(current, 'installation_prepared', { installer: installer.number, headSha: tip, mainSha: main }));
  } });
  assert.equal(sleeps, 1); assert.equal(writes, 1);
  await assert.rejects(verifyPreparedInstallation({ platform, store: memoryStore(), root, installer, waitMs: 10000, elapsedClock: () => clock, sleep: async ms => { clock += ms; } }), /exact source/);
  rules[0].allow_master_force_pushes = true; await assert.rejects(ensureStateProtection(platform), /protection/);
  await assert.rejects(prepareInstallation({ platform, store, root, installer: { ...installer, head: { sha: head } } }), /checkout/);
});
test('frozen release requires exact checkout and positive main ancestry, without updating its source', async () => {
  const calls = []; const env = { CNB_TOKEN: 'test-only', CNB_REPO_SLUG: repo, RELEASE_EXPECTED_SHA: head };
  const run = async argv => { calls.push(argv); return argv[0] === 'rev-parse' ? head : ''; };
  assert.equal((await verifyReleaseSource({ env, run })).sha, head); assert.deepEqual(calls.at(-1), ['merge-base', '--is-ancestor', head, 'FETCH_HEAD']);
  await assert.rejects(verifyReleaseSource({ env: { ...env, RELEASE_EXPECTED_SHA: main }, run }), /checkout/);
});

test('actual bare Git CAS preserves simultaneous updates and append-only history', async t => {
  const root = await temporary(t, 'delivery-git-cas-'); const remote = join(root, 'remote.git'); await git(['init', '--bare', '--quiet', remote]);
  const stores = Array.from({ length: 6 }, () => new GitStateStore({ repo, remote, retries: 12 }));
  await Promise.all(stores.map((store, index) => store.mutate(state => updateTask(state, index + 1, { status: 'waiting_ci' }), { id: `write-${index}` })));
  const state = await stores[0].read(); assert.equal(Object.keys(state.tasks).length, 6); assert.equal(state.events.filter(event => event.kind === 'transaction').length, 6); validateState(state, repo);
  const count = await git(['--git-dir', remote, 'rev-list', '--count', 'automation/delivery-state']); assert.equal(Number(count), 6);
});
test('actual lost Git push acknowledgement recovers the committed transaction once', async t => {
  const root = await temporary(t, 'delivery-git-lostack-'); const remote = join(root, 'remote.git'); await git(['init', '--bare', '--quiet', remote]);
  class LostAckStore extends GitStateStore { async withRepository(operation) { return super.withRepository(run => operation(async (args, options) => { const result = await run(args, options); if (args[0] === 'push' && !this.lost) { this.lost = true; throw new Error('lost acknowledgement'); } return result; })); } }
  const store = new LostAckStore({ repo, remote }); let mutations = 0;
  const result = await store.mutate(state => { mutations++; updateTask(state, 1, { status: 'waiting_ci' }); }, { id: 'same-transaction' });
  assert.equal(result.recovered, true); await store.mutate(() => { mutations++; }, { id: 'same-transaction' }); assert.equal(mutations, 1);
});
test('actual branch alignment uses ordinary merge/push; semantic conflicts preserve source', async t => {
  const root = await temporary(t, 'delivery-align-'); const remote = join(root, 'remote.git'); const source = join(root, 'source'); await mkdir(source); await git(['init', '--bare', '--quiet', remote]);
  const run = args => git(args, { cwd: source }); await run(['init', '--quiet', '--initial-branch=main']); await writeFile(join(source, 'shared'), 'start\n'); await run(['add', 'shared']); await run(['commit', '-m', 'initial']);
  const common = await run(['rev-parse', 'HEAD']); await run(['checkout', 'main']); await writeFile(join(source, 'mainfile'), 'main\n'); await run(['add', 'mainfile']); await run(['commit', '-m', 'main']); const target = await run(['rev-parse', 'HEAD']);
  await run(['checkout', '-b', 'task/test', common]); await writeFile(join(source, 'taskfile'), 'task\n'); await run(['add', 'taskfile']); await run(['commit', '-m', 'task']); const tip = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'main', 'task/test']);
  const pull = { state: 'open', is_wip: false, head: { sha: tip, ref: 'task/test' } }; const platform = { repo, pull: async () => pull, main: async () => ({ commit: { sha: target } }) };
  const aligned = await alignBranch(platform, { number: 1, headSha: tip, mainSha: target, pull }, { remote });
  await run(['fetch', remote, 'task/test']); const parents = (await run(['rev-list', '--parents', '-n', '1', 'FETCH_HEAD'])).split(' '); assert.deepEqual(parents.slice(1), [tip, target]); assert.equal(parents[0], aligned.sha);
  await run(['checkout', 'main']); await writeFile(join(source, 'shared'), 'main conflict\n'); await run(['add', 'shared']); await run(['commit', '-m', 'main conflict']); const conflictMain = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'main']);
  await run(['checkout', '-b', 'task/conflict', common]); await writeFile(join(source, 'shared'), 'task conflict\n'); await run(['add', 'shared']); await run(['commit', '-m', 'task conflict']); const conflictHead = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'task/conflict']);
  const conflictPull = { ...pull, head: { sha: conflictHead, ref: 'task/conflict' } }; await assert.rejects(alignBranch({ ...platform, pull: async () => conflictPull, main: async () => ({ commit: { sha: conflictMain } }) }, { number: 2, headSha: conflictHead, mainSha: conflictMain, pull: conflictPull }, { remote }), /git merge/);
  assert.equal((await git(['ls-remote', remote, 'refs/heads/task/conflict'])).split(/\s/)[0], conflictHead);
});

test('immutable candidate creation reuses exact protected refs/PRs and rejects source replacement', async () => {
  let created = false; let posts = 0; const s = snapshot(); const marker = `delivery-origin:1:${head}:${main}`;
  const platform = new Platform(repo, undefined, async (_repo, path, options) => {
    if (path.includes('branch-protections')) return [{ id: 'candidate-rule', rule: 'delivery/candidate/**', allow_creation: true, allow_master_creation: true, allow_pushes: false, allow_master_pushes: false, allow_force_pushes: false, allow_master_force_pushes: false, allow_deletions: false, allow_master_deletions: false }];
    if (path === '/-/git/branches' && options.method === 'POST') { posts++; if (created) throw new Error('already exists'); created = true; return {}; }
    if (path.includes('/git/branches/')) return { commit: { sha: head }, protected: true };
    if (path.includes('/pulls?')) return [];
    if (path === '/-/pulls') return { number: '11', state: 'open' };
    if (path === '/-/pulls/11') return { number: '11', head: { sha: head }, body: `<!-- ${marker} -->` };
    throw new Error(`Unexpected ${path}`);
  });
  assert.equal((await platform.ensureCandidate(s)).number, 11); assert.equal((await platform.ensureCandidate(s)).headSha, head); assert.equal(posts, 2);
  platform.request = async (_repo, path) => path.includes('branch-protections') ? [{ id: 'candidate-rule', rule: 'delivery/candidate/**', allow_creation: true, allow_master_creation: true, allow_pushes: false, allow_master_pushes: false, allow_force_pushes: false, allow_master_force_pushes: false, allow_deletions: false, allow_master_deletions: false }] : path === '/-/git/branches' ? Promise.reject(new Error('already exists')) : { commit: { sha: main }, protected: true };
  await assert.rejects(platform.ensureCandidate(s), /already exists/);
});
test('positive merge readback requires actual is_merged and exact tested parent order', async () => {
  const platform = new Platform(repo); platform.pull = async () => ({ is_merged: true, head: { sha: head }, merged_by: { username: 'npc' } }); platform.commit = async () => ({ parents: [{ sha: main }, { sha: head }] });
  assert.equal((await platform.verifyMerge(snapshot(), { sha: mergedSha })).sha, mergedSha);
  platform.commit = async () => ({ parents: [{ sha: head }, { sha: main }] }); await assert.rejects(platform.verifyMerge(snapshot(), { sha: mergedSha }), /parents/);
  platform.pull = async () => ({ state: 'closed', is_merged: false, head: { sha: head } }); await assert.rejects(platform.verifyMerge(snapshot(), { sha: mergedSha }), /receipt/);
});
test('snapshot accepts label reordering but rejects actual label changes and unreadable sets', async () => {
  const initial = { ...snapshot().pull, labels: [{ name: 'protocol' }, { name: 'src/auto' }] };
  let finalLabels = [{ name: 'src/auto' }, { name: 'protocol' }]; let reads = 0;
  const platform = new Platform(repo, undefined, async (_repo, path) => {
    if (path === '/-/pulls/1') return { ...initial, labels: ++reads % 2 ? initial.labels : finalLabels };
    if (path === '/-/git/branches/main') return { commit: { sha: main } };
    if (path.includes('/git/compare/')) return { base_commit: { sha: main }, head_commit: { sha: head }, merge_base_commit: { sha: main }, files: [{ path: 'apps/example.ts' }] };
    if (path.includes('/git/commits/')) return { sha: head, commit: { committer: { date: new Date(now).toISOString() } } };
    throw new Error(`Unexpected ${path}`);
  });
  assert.equal((await platform.snapshot(1, {}, { checks: false })).headSha, head);
  finalLabels = [{ name: 'risk/block' }, { name: 'protocol' }];
  await assert.rejects(platform.snapshot(1, {}, { checks: false }), /snapshot changed/);
  finalLabels = undefined;
  await assert.rejects(platform.snapshot(1, {}, { checks: false }), /unreadable/);
});
test('unknown merge acknowledgement pauses later integration; never repeats the write', async () => {
  const s = snapshot(11); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test';
  const state = activate(emptyState(repo)); updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, review: review(s) }, now); const store = memoryStore(state); let writes = 0;
  const platform = { repo, assertCandidateProtection: async () => {}, snapshot: async () => s, pull: async number => number === 1 ? snapshot().pull : s.pull, merge: async () => { writes++; throw new Error('network lost response'); }, error: e => e.message };
  await assert.rejects(mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map([[1, { pending: [] }]]), now }), /lost/); assert.equal(writes, 1); assert.equal((await store.read()).tasks['1'].status, 'merging');
  const report = await reconcile({ platform, store, policy, now, services: { reconcileReleases: async () => [] } }); assert.equal(report.failed[0].stage, 'recover-merge'); assert.equal(writes, 1);
});
test('sensitive integration always acquires a fenced lease, even when developers did not opt in', async () => {
  const s = snapshot(11, { files: ['scripts/ci/protocol-rules.mjs'] }); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test';
  const original = snapshot(1, { files: s.files }); const state = activate(emptyState(repo));
  updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, review: review(s) }, now);
  const store = memoryStore(state); let writes = 0; let phase = 'open';
  const platform = { repo, error: e => e.message, assertCandidateProtection: async () => {}, snapshot: async () => s,
    pull: async number => number === 1 ? { ...original.pull, state: phase } : s.pull, list: async () => [], comment: async () => {},
    call: async (_path, options) => { if (options?.method === 'PATCH') phase = 'closed'; },
    merge: async () => { writes++; const current = await store.read(); assert.equal(current.leases.protocol.owner, 'integration/pr-1'); assert.ok(current.leases.protocol.generation > 0); return { sha: mergedSha }; },
    verifyMerge: async () => ({ sha: mergedSha, sourceSha: head, mainSha: main }) };
  await store.mutate(current => leaseOperation(current, { action: 'acquire', owner: 'other', scopes: ['protocol'] }, now));
  await assert.rejects(mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map(), now }), /busy/); assert.equal(writes, 0);
  await store.mutate(current => leaseOperation(current, { action: 'release', owner: 'other', scopes: ['protocol'], generation: { protocol: 1 } }, now));
  await mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map(), now });
  assert.equal(writes, 1); assert.equal((await store.read()).leases.protocol.owner, null);
  assert.ok((await store.read()).events.some(event => event.kind === 'lease_acquire' && event.data.owner === 'integration/pr-1'));
});
test('red oldest PR and failed release do not stop a later healthy PR candidate', async () => {
  const state = activate(emptyState(repo)); const good = snapshot(2); const candidate = snapshot(22); candidate.pull.head.ref = 'delivery/candidate/22'; candidate.originNumber = 2;
  updateTask(state, 22, { status: 'waiting_ci', review: review(candidate) }, now); const store = memoryStore(state); let candidateCreated = 0; let originalClosed = false;
  const platform = { repo, error: e => e.message, pulls: async () => [snapshot(1).pull, good.pull], snapshot: async number => number === 1 ? snapshot(1, { checkErrors: ['Required check static-gate failed'] }) : number === 22 ? candidate : good,
    pull: async number => number === 2 ? { ...good.pull, state: originalClosed ? 'closed' : 'open' } : number === 22 ? candidate.pull : snapshot(number).pull,
    ensureCandidate: async () => { candidateCreated++; return { number: 22 }; }, assertCandidateProtection: async () => {}, list: async () => [], comment: async () => {},
    merge: async () => ({ sha: mergedSha }), verifyMerge: async () => ({ sha: mergedSha, sourceSha: head, mainSha: main }),
    call: async (_path, options) => { if (options?.method === 'PATCH') originalClosed = true; return {}; } };
  let releaseCalls = 0;
  const report = await reconcile({ platform, store, policy, now, services: { reconcileReleases: async () => { releaseCalls++; throw new Error('release failed'); } } });
  assert.equal(candidateCreated, 1); assert.equal(report.integrated[0].number, 2); assert.ok(report.waiting.some(item => item.number === 1)); assert.equal(report.failed.length, 0); assert.equal(originalClosed, true); assert.equal(releaseCalls, 0);
});
test('task receipt cannot close an unmerged task or a task with declared unverified release', async () => {
  const state = emptyState(repo); const taskIntent = { ...intent, taskId: 'T-2026-1005-1001', releases: [{ kind: 'desktop', version: 'v1.2.3' }] };
  updateTask(state, 1, { status: 'waiting_ci', intent: taskIntent }, now); updateTask(state, 2, { status: 'release_pending', intent: taskIntent, merge: { sha: mergedSha, sourceSha: head, mainSha: main } }, now);
  let writes = 0; await writeTaskReceipts({ store: memoryStore(state), platform: { list: async () => { writes++; return []; } }, now }); assert.equal(writes, 0);
});
test('a lease acquired by another developer during snapshot reading blocks candidate creation', async () => {
  const store = memoryStore(activate(emptyState(repo))); let candidates = 0;
  const s = snapshot(2, { files: ['AGENTS.md'] });
  const platform = { repo, error: e => e.message, pulls: async () => [s.pull],
    snapshot: async () => { await store.mutate(current => leaseOperation(current, { action: 'acquire', owner: 'other', scopes: ['protocol'] }, now)); return s; },
    ensureCandidate: async () => { candidates++; }, list: async () => [] };
  const report = await reconcile({ platform, store, policy, now });
  assert.equal(candidates, 0); assert.equal(report.waiting[0].reason, 'Active developer lease protocol');
  assert.equal((await store.read()).leases.protocol.owner, 'other');
});
test('runner deadline uses elapsed time independently of injected lease/calendar time and preserves the exact boundary', async () => {
  const clocks = [0, 240000, 240001]; const scanned = [];
  const platform = { repo, error: e => e.message, pulls: async () => [snapshot(1).pull, snapshot(2).pull], snapshot: async number => { scanned.push(number); return snapshot(number, { checkErrors: ['still pending'] }); } };
  const report = await reconcile({ platform, store: memoryStore(), policy, now: 1, dryRun: true, elapsedClock: () => clocks.shift(), deadlineMs: 240000 });
  assert.deepEqual(scanned, [1]); assert.equal(report.waiting.find(item => item.number === 2).reason, 'Bounded runner time; next reconcile continues');
});
test('new candidates reserve actual AI parent capacity; failed, stale and completed reviews do not block unrelated PRs', async () => {
  const state = emptyState(repo); updateTask(state, 1, { status: 'waiting_ci', headSha: head, candidate: { number: 11, headSha: head, mainSha: main, at: now } }, now); const store = memoryStore(state);
  let status = 'pending'; const platform = { call: async () => ({ status }) };
  assert.equal(await reviewSlotBusy(platform, store, 2, main, now), true); assert.equal(await reviewSlotBusy(platform, store, 1, main, now), false);
  await store.mutate(current => updateTask(current, 11, { status: 'waiting_review', reviewBuild: { sn: 'real-build', at: now } }, now));
  assert.equal(await reviewSlotBusy(platform, store, 2, main, now), true);
  status = 'error'; assert.equal(await reviewSlotBusy(platform, store, 2, main, now), false);
  status = 'unknown'; await assert.rejects(reviewSlotBusy(platform, store, 2, main, now), /unreadable/);
  assert.equal(await reviewSlotBusy(platform, store, 2, main, now + 45 * 60000), false);
  status = 'pending'; await store.mutate(current => updateTask(current, 11, { review: review(snapshot(11)) }, now));
  assert.equal(await reviewSlotBusy(platform, store, 2, main, now), false);
});
test('release enqueue is idempotent by frozen source/kind/version and keeps integration separate', () => {
  const state = emptyState(repo); const task = { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: 'v1.2.3' }] } };
  enqueueReleases(state, repo, task, now); enqueueReleases(state, repo, task, now); assert.equal(Object.keys(state.releases).length, 1); assert.equal(Object.values(state.releases)[0].version, '1.2.3');
});
test('release launch intent survives lost acknowledgement and forbids duplicate publication', async () => {
  const state = emptyState(repo); const task = { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: '1.2.3' }] } }; enqueueReleases(state, repo, task, now); const store = memoryStore(state); let launches = 0;
  const platform = { repo, error: e => e.message, call: async (path, options) => { if (path.includes('/build/logs')) return { total: 0, data: [] }; if (options?.method === 'POST') { launches++; throw new Error('lost ack'); } throw new Error('unexpected call'); } };
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'unknown'); await reconcileReleases({ platform, store, now: now + 60000 }); assert.equal(launches, 1);
});
test('lost release launch cannot adopt a different manual build with the same source/event', async () => {
  const state = emptyState(repo); enqueueReleases(state, repo, { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: '1.2.3' }] } }, now);
  const item = Object.values(state.releases)[0]; item.status = 'unknown'; item.knownBuilds = [];
  const store = memoryStore(state); let writes = 0;
  const history = [{ sn: 'manual', sha: mergedSha, event: 'api_trigger_ui_release', title: 'Manual UI build' }];
  const platform = { repo, error: e => e.message, call: async (path, options) => { if (options?.method === 'POST') writes++; return path.includes('/build/logs') ? { total: history.length, data: history } : { status: 'pending' }; } };
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'unknown');
  assert.equal((await store.read()).releases[item.key].build, undefined);
  history.push({ sn: 'exact', sha: mergedSha, event: 'api_trigger_ui_release', title: `WorkLoom release ${item.key}` });
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'running');
  assert.equal((await store.read()).releases[item.key].build.sn, 'exact'); assert.equal(writes, 0);
});
test('release verifies actual tag source, manifest identity and every downloaded digest', async () => {
  const hex = 'a'.repeat(128); const names = ['WorkLoom-mac-arm64.dmg', 'WorkLoom-mac-x64.dmg', 'WorkLoom-win-x64.exe']; const release = { sha: mergedSha, kind: 'desktop', version: 'v1.2.3', build: { sn: 'run' } };
  const manifest = { schemaVersion: 1, tag: release.version, sourceSha: mergedSha, assets: names.map(name => ({ name, size: 5, sha512: hex })) };
  const key = releaseKey({ repo, sha: mergedSha, kind: 'desktop', version: release.version });
  const build = { sn: 'run', sha: mergedSha, event: 'api_trigger_desktop_release', title: `WorkLoom release ${key}` };
  const platform = { repo, call: async path => path.includes('/build/logs') ? { total: 1, data: [build] } : path.includes('/releases/') ? { id: 'r', draft: false } : { sha: mergedSha } }; let downloads = 0;
  const download = async (_repo, _tag, name) => { downloads++; return name.endsWith('.json') ? { data: manifest } : { name, size: 5, sha512: hex }; };
  assert.equal((await verifyRelease(platform, release, download)).assets.length, 3); assert.equal(downloads, 4);
  manifest.sourceSha = head; await assert.rejects(verifyRelease(platform, release, download), /manifest/); manifest.sourceSha = mergedSha;
  await assert.rejects(verifyRelease(platform, release, async () => ({ data: manifest, size: 6, sha512: hex })), /byte/);
  build.sha = head; await assert.rejects(verifyRelease(platform, release, download), /build source/);
});
