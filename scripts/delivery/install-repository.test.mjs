import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AGENT_RULE, appendAgentRule, applyInstallation, CORE_ASSETS, INSTALL_MARKER, installationPlan, readAssets } from './install-assets.mjs';
import { createOnce, discoverAccount, ensureInstallationMainProtection, finishInstallation, freezeInstallerSource, preparePropagated, traceInstallerMerge } from './install-repository.mjs';
import { appendEvent, emptyState, validRepoSlug } from './queue-model.mjs';
import { branchProtectionPayload } from '../tools/cnb-api.mjs';
import { git, GitStateStore } from './git-state.mjs';
import { modelGateway } from './model-gateway.mjs';
import { parser, resolvePipelineConfig } from './queue-policy.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceSha = await git(['rev-parse', 'HEAD'], { cwd: sourceRoot });
const assets = await readAssets(sourceRoot, sourceSha);
const fixtureCredential = randomUUID();
const repo = 'workloom-ai/fixture';
const main = 'a'.repeat(40); const head = 'b'.repeat(40); const merge = 'c'.repeat(40);
const original = 'main:\n  pull_request:\n    - name: product-gate\n      stages:\n        - name: Product assertions\n          script: python3 product_test.py\n';
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'delivery-installer-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function fixture(t, ci = original) {
  const root = await temp(t);
  await writeFile(join(root, '.cnb.yml'), ci);
  await writeFile(join(root, 'product.manifest.json'), '{"industry":"unchanged"}\n');
  await writeFile(join(root, '.workloom-base-sync.json'), '{"syncPolicy":"none-in-none-out"}\n');
  await writeFile(join(root, 'AGENTS.md'), 'Original instructions\n<!-- WORKLOOM-CONTEXT:BEGIN -->\nFrozen upstream body\n<!-- WORKLOOM-CONTEXT:END -->\n');
  return root;
}
function plan(root, overrides = {}) { return installationPlan({ root, assets, sourceRepo: 'workloom-ai/workloom-im', sourceSha, repo, ...overrides }); }
function memoryStore(initial = emptyState(repo)) {
  let state = structuredClone(initial);
  return { read: async () => structuredClone(state), mutate: async operation => { const copy = structuredClone(state); const result = operation(copy); state = copy; return { state: structuredClone(copy), result }; } };
}

test('install execution closure preserves product CI, industry identity, isolation and frozen agent text; a repeated exact package has no writes', async t => {
  const root = await fixture(t); const beforeAgents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  const beforeProduct = await readFile(join(root, 'product.manifest.json'), 'utf8'); const beforeIsolation = await readFile(join(root, '.workloom-base-sync.json'), 'utf8');
  const result = await plan(root);
  assert.equal(CORE_ASSETS.length, 23); assert.ok(result.requiredNames.includes('product-gate')); assert.ok(result.requiredNames.includes('delivery-bootstrap-review')); assert.ok(result.requiredNames.includes('delivery-regression'));
  await applyInstallation(result, root);
  const resolved = await resolvePipelineConfig(await readFile(join(root, '.cnb.yml'), 'utf8'), { readLocal: path => readFile(join(root, path), 'utf8') });
  const YAML = await parser(); const baseline = YAML.parse(original);
  assert.deepEqual(resolved.main.pull_request.find(p => p.name === 'product-gate'), baseline.main.pull_request[0]);
  assert.equal(await readFile(join(root, 'product.manifest.json'), 'utf8'), beforeProduct);
  assert.equal(await readFile(join(root, '.workloom-base-sync.json'), 'utf8'), beforeIsolation);
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith(beforeAgents.trimEnd()));
  assert.equal(JSON.parse(await readFile(join(root, INSTALL_MARKER), 'utf8')).isolationChanged, false);
  assert.equal((await plan(root, { sourceSha: head })).changes.size, 0);
});
test('installation preflight rejects incomplete assets, invalid or missing product checks and unsafe local includes without modifying files', async t => {
  for (const ci of ['invalid: [', 'main:\n  pull_request: []\n', 'include: https://example.com/ci.yml\n' + original]) {
    const root = await fixture(t, ci); await assert.rejects(plan(root));
    assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), ci);
    await assert.rejects(readFile(join(root, INSTALL_MARKER)), { code: 'ENOENT' });
  }
  const root = await fixture(t); const incomplete = { ...assets }; delete incomplete[CORE_ASSETS[0]];
  await assert.rejects(plan(root, { assets: incomplete }), /closure/);
});
test('installation rejects a symlink in any asset path before performing any migration', async t => {
  const root = await fixture(t); const outside = await temp(t);
  await mkdir(join(root, 'scripts')); await symlink(outside, join(root, 'scripts', 'delivery'));
  await assert.rejects(plan(root), /symlink/);
  assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), original);
  await assert.rejects(readFile(join(outside, 'queue-model.mjs')), { code: 'ENOENT' });
});
test('instruction append is idempotent and rejects duplicate, reversed or incomplete markers', () => {
  const before = 'frozen original instructions\n'; const once = appendAgentRule(before);
  assert.equal(appendAgentRule(once), once); assert.ok(once.includes(AGENT_RULE));
  for (const text of ['<!-- WORKLOOM-RD-DELIVERY:BEGIN -->', AGENT_RULE + AGENT_RULE, '<!-- WORKLOOM-RD-DELIVERY:END --><!-- WORKLOOM-RD-DELIVERY:BEGIN -->']) assert.throws(() => appendAgentRule(text), /markers/);
});
test('Tiger migration preserves Python/governance product checks and only reroutes the three protocol commands', async t => {
  const ci = original.replace('python3 product_test.py', 'python3 governance/product_test.py\n            node governance/scripts/ci/protocol-rules.test.mjs\n            node governance/scripts/ci/verify-commit-msg.mjs\n            node governance/scripts/ci/verify-lock-conflict.mjs');
  const root = await fixture(t, ci); const result = await plan(root, { repo: 'workloom-ai/workroom-tiger' });
  const next = result.changes.get('.cnb.yml');
  assert.ok(next.includes('python3 governance/product_test.py')); assert.ok(next.includes('node scripts/ci/verify-lock-conflict.mjs'));
  assert.ok(!next.includes('node governance/scripts/ci/verify-lock-conflict.mjs'));
  assert.ok(![...result.changes.keys()].some(path => path.startsWith('governance/')));
});
test('account discovery paginates all owned active repos and fails on ambiguous or unreadable identity', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), path: `org/repo-${i}` })); let calls = 0;
  const result = await discoverAccount('ephemeral', async (_repo, path) => { calls++; assert.ok(path.includes('role=Owner&status=active')); return calls === 1 ? first : [{ id: '101', path: 'other/new', freeze: true }]; });
  assert.equal(calls, 2); assert.equal(result.length, 101); assert.equal(result.at(-1).frozen, true);
  await assert.rejects(discoverAccount('ephemeral', async () => [{ id: '1', path: 'org/one' }, { id: '1', path: 'org/two' }]), /ambiguous/);
  await assert.rejects(discoverAccount('ephemeral', async () => [{ id: '1', path: 'org/one' }, { id: '2', path: 'org/one' }]), /ambiguous/);
  await assert.rejects(discoverAccount('ephemeral', async () => ({})), /unreadable/);
});
test('nested CNB groups use the exact model and state destination; traversal and foreign origins are rejected', async () => {
  const nested = 'owner/group/subgroup/project';
  assert.ok(validRepoSlug(nested)); assert.equal(new GitStateStore({ repo: nested }).repo, nested);
  const discovered = await discoverAccount(fixtureCredential, async () => [{ id: 'nested', path: nested }]); assert.equal(discovered[0].repo, nested);
  for (const bad of ['owner/../other', 'owner//other', '/owner/repo', 'owner/repo?x=y', 'https://foreign/repo']) {
    assert.equal(validRepoSlug(bad), false); assert.throws(() => new GitStateStore({ repo: bad }), /slug/);
  }
  assert.throws(() => new GitStateStore({ repo: nested, token: fixtureCredential, remote: 'https://example.com/repo.git' }), /destination/);
  let calls = 0;
  const broker = await modelGateway({ repo: nested, token: fixtureCredential, request: async (url, options) => { calls++; assert.equal(url, `https://api.cnb.cool/${nested}/-/ai/v1/messages`); assert.equal(options.headers.authorization, `Bearer ${fixtureCredential}`); return new Response('{}'); } });
  try {
    assert.equal((await fetch(`${broker.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal(calls, 1);
  } finally { await broker.close(); }
});
test('object creation recovers a single actual lost acknowledgement without blind retry or accepting a collision', async () => {
  let objects = []; let writes = 0;
  const options = { list: async () => objects, match: object => object.marker === 'fixed', create: async () => { writes++; objects.push({ number: 1, marker: 'fixed' }); throw new Error('lost acknowledgement'); } };
  assert.equal((await createOnce(options)).number, 1); assert.equal((await createOnce(options)).number, 1); assert.equal(writes, 1);
  objects.push({ number: 2, marker: 'fixed' }); await assert.rejects(createOnce(options), /ambiguous/); assert.equal(writes, 1);
  await assert.rejects(createOnce({ list: async () => [], match: () => true, create: async () => { throw new Error('denied'); } }), /denied/);
});
test('weak installation main protection is tightened with exact readback and preserves extra signature restrictions', async () => {
  let rule = { ...branchProtectionPayload(), id: 'main-rule', required_commit_signatures: true, allow_master_pushes: true };
  const platform = { protections: async () => [rule], call: async (_path, options) => { rule = { ...options.body, id: rule.id }; throw new Error('lost settings acknowledgement'); } };
  const after = await ensureInstallationMainProtection(platform);
  assert.equal(after.allow_master_pushes, false); assert.equal(after.required_commit_signatures, true);
});
test('exact protected installation source must read back before a merge; a weak existing rule or replaced ref is rejected', async () => {
  let rules = []; let actualHead = head; let writes = 0;
  const pull = { head: { sha: head, ref: 'refs/heads/chore/protocol-onboarding-exact' } };
  const platform = { protections: async () => rules, call: async (_path, options) => {
    if (options?.method === 'POST') { writes++; rules = [{ ...options.body, id: 'source-rule' }]; throw new Error('lost acknowledgement'); }
    return { protected: true, commit: { sha: actualHead } };
  } };
  await freezeInstallerSource(platform, pull); assert.equal(writes, 1);
  actualHead = main; await assert.rejects(freezeInstallerSource(platform, pull), /changed/);
  actualHead = head; rules[0].allow_master_pushes = true; await assert.rejects(freezeInstallerSource(platform, pull), /immutable/);
});
test('merge recovery traces actual first-parent ancestry and exact tested parents, never a fabricated Pull merge field', async () => {
  const snapshot = { number: 7, headSha: head, mainSha: main };
  const platform = { pull: async () => ({ is_merged: true, head: { sha: head } }), main: async () => ({ commit: { sha: merge } }),
    commit: async () => ({ parents: [{ sha: main }, { sha: head }] }), verifyMerge: async (_snapshot, result) => ({ sha: result.sha }) };
  assert.equal((await traceInstallerMerge(platform, snapshot)).sha, merge);
  platform.commit = async () => ({ parents: [{ sha: head }, { sha: main }] }); await assert.rejects(traceInstallerMerge(platform, snapshot), /exact tested parents/);
  platform.pull = async () => ({ is_merged: false, head: { sha: head } }); await assert.rejects(traceInstallerMerge(platform, snapshot), /no duplicate/);
});
test('an unknown installation merge survives restart and never sends a second merge', async t => {
  const root = await fixture(t); const state = emptyState(repo);
  appendEvent(state, 'installer_merge_requested', { number: 7, snapshot: { number: 7, headSha: head, mainSha: main } });
  const store = memoryStore(state); let writes = 0;
  const platform = { pull: async () => ({ number: 7, is_merged: false, head: { sha: head } }), merge: async () => { writes++; } };
  await assert.rejects(finishInstallation({ repo, token: fixtureCredential, number: 7, root, platform, store }), /no duplicate/);
  assert.equal(writes, 0); assert.equal((await store.read()).events.length, state.events.length);
});
test('an active repository update uses its native immutable delivery instead of the privileged first-install merger', async t => {
  const root = await fixture(t); const state = emptyState(repo); appendEvent(state, 'activated', { mainSha: main }); let writes = 0;
  const result = await finishInstallation({ repo, token: fixtureCredential, number: 7, root, store: memoryStore(state), platform: { pull: async () => ({ number: 7, head: { sha: head }, state: 'open' }), merge: async () => { writes++; } } });
  assert.equal(result.status, 'waiting_native_delivery'); assert.equal(writes, 0);
});
test('source propagation times out without protection writes or false preparation', async () => {
  let clock = 0; let reads = 0;
  await assert.rejects(preparePropagated({ platform: { pull: async () => { reads++; return { head: { sha: main } }; } }, expected: head, elapsedClock: () => clock, wait: async ms => { clock += ms; } }), /timed out/);
  assert.equal(clock, 30000); assert.equal(reads, 31);
});
