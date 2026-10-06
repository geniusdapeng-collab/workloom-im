import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AGENT_RULE, appendAgentRule, applyInstallation, CORE_ASSETS, DELIVERY_DOC, REGRESSION_CNB, INSTALL_MARKER, installationPlan, readAssets } from './install-assets.mjs';
import { createOnce, discoverAccount, ensureInstallationMainProtection, ensureInstallationPolicy, finishInstallation, freezeInstallerSource, installationIssues, installationPulls, pendingInstallerMerge, preparePropagated, refreshInstallerPolicy, traceInstallerMerge, verifyInstallationReview } from './install-repository.mjs';
import { appendEvent, emptyState, hash, parseIntent, validRepoSlug, validateDeveloperReview } from './queue-model.mjs';
import { packageDigest, TIGER_ALIASES, validateInstallationManifest, verifyInstallationManifest } from './install-manifest.mjs';
import { branchProtectionPayload } from '../tools/cnb-api.mjs';
import { git, GitStateStore } from './git-state.mjs';
import { modelGateway } from './model-gateway.mjs';
import { parser, resolvePipelineConfig } from './queue-policy.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceSha = await git(['rev-parse', 'HEAD'], { cwd: sourceRoot });
// Exercise all package bytes under review before Git publication; readAssets is verified separately at the final exact commit.
const assets = Object.fromEntries(await Promise.all(CORE_ASSETS.map(async path => [path, await readFile(join(sourceRoot, path), 'utf8')])));
assets['docs/AUTOMATIC-RD-DELIVERY.md'] = DELIVERY_DOC;
assets['scripts/delivery/install-cnb.yml'] = REGRESSION_CNB;
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
function reviewFixture(pull = { number: 7, state: 'open', is_wip: false, body: '<!-- delivery-install:exact -->\n<!-- workloom-delivery\n{"ready":true,"depends_on":[],"releases":[]}\n-->', head: { sha: head, ref: 'chore/protocol-onboarding-old' } }) {
  const policy = { hash: 'd'.repeat(64) };
  const reviewedAt = new Date().toISOString();
  const snapshot = { repo, number: pull.number, pull, headSha: head, mainSha: main, headTime: Date.now() - 5000, files: ['.cnb.yml'], ciPolicyChanges: [], checkErrors: [], intent: parseIntent(pull) };
  const developerReview = validateDeveloperReview({ schemaVersion: 1, provider: 'codex', repo, number: pull.number, headSha: head, mainSha: main, policyHash: policy.hash,
    reviewedFiles: snapshot.files, dependsOn: [], ciPolicyChanges: [], reviewedAt, summary: 'Fixture verifies source identity and exact CI closure.', tests: [{ command: 'node --test fixture', exitCode: 0, result: 'passed', finishedAt: reviewedAt }] }, snapshot, policy);
  return { policy, reviewSnapshot: snapshot, developerReview, pull, preparation: { headSha: head, mainSha: main } };
}

test('install execution closure preserves product CI, industry identity, isolation and frozen agent text; a repeated exact package has no writes', async t => {
  const root = await fixture(t); const beforeAgents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  const beforeProduct = await readFile(join(root, 'product.manifest.json'), 'utf8'); const beforeIsolation = await readFile(join(root, '.workloom-base-sync.json'), 'utf8');
  const result = await plan(root);
  assert.equal(CORE_ASSETS.length, 24); assert.ok(result.requiredNames.includes('product-gate')); assert.ok(result.requiredNames.includes('delivery-bootstrap-checks')); assert.ok(result.requiredNames.includes('delivery-regression'));
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
test('real target offline inventory includes product facts and newly installed runtime/CI assets without replacing the target generator', async t => {
  const root = await fixture(t); await mkdir(join(root, 'scripts')); await mkdir(join(root, 'docs')); await mkdir(join(root, 'product'));
  const generator = await readFile(join(sourceRoot, 'scripts/oss-inventory.mjs'), 'utf8');
  await writeFile(join(root, 'scripts/oss-inventory.mjs'), generator);
  await writeFile(join(root, 'oss-components.json'), JSON.stringify({ components: [{ name: 'yaml', channel: 'npm', package: 'yaml' }] }));
  await writeFile(join(root, 'product/package.json'), JSON.stringify({ dependencies: { 'actual-product-dependency': '1.2.3' } }));
  await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'actual product inventory fixture'], { cwd: root });
  const result = await plan(root); assert.deepEqual(result.generatedPaths, ['docs/OPEN_SOURCE_COMPONENTS.md']);
  const written = await applyInstallation(result, root); assert.ok(written.includes('docs/OPEN_SOURCE_COMPONENTS.md'));
  const inventory = await readFile(join(root, 'docs/OPEN_SOURCE_COMPONENTS.md'), 'utf8');
  assert.match(inventory, /actual-product-dependency/); assert.match(inventory, /scripts\/delivery\/runtime\/package.json/); assert.match(inventory, /node:24\.19\.0-bookworm/);
  assert.equal(await readFile(join(root, 'scripts/oss-inventory.mjs'), 'utf8'), generator);
  assert.equal((await plan(root)).changes.size, 0);
});
test('sparse product facts fail inventory preflight before installation writes and generator failure never returns a successful package', async t => {
  const root = await fixture(t); await mkdir(join(root, 'scripts')); await mkdir(join(root, 'docs')); await mkdir(join(root, 'product'));
  await cp(join(sourceRoot, 'scripts/oss-inventory.mjs'), join(root, 'scripts/oss-inventory.mjs'));
  await writeFile(join(root, 'oss-components.json'), '{"components":[]}'); await writeFile(join(root, 'product/package.json'), '{}');
  await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'sparse inventory fixture'], { cwd: root });
  await git(['sparse-checkout', 'set', '--cone', 'scripts', 'docs'], { cwd: root });
  await assert.rejects(plan(root), /complete tracked checkout/); assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), original);
  await assert.rejects(readFile(join(root, INSTALL_MARKER)), { code: 'ENOENT' });
  await git(['sparse-checkout', 'disable'], { cwd: root });
  await assert.rejects(applyInstallation(await plan(root), root), /Target OSS generation failed/);
  await assert.rejects(readFile(join(root, 'docs/OPEN_SOURCE_COMPONENTS.md')), { code: 'ENOENT' });
});
test('an unknown hardened Git/PR gate is preserved and rejected before target writes', async t => {
  const root = await fixture(t); await mkdir(join(root, 'scripts/ci'), { recursive: true });
  const hardened = 'export async function runLockGate() { throw new Error("Target-specific source binding"); }\n';
  await writeFile(join(root, 'scripts/ci/verify-lock-conflict.mjs'), hardened);
  await assert.rejects(plan(root), /explicit reviewed migration/);
  assert.equal(await readFile(join(root, 'scripts/ci/verify-lock-conflict.mjs'), 'utf8'), hardened);
  assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), original);
  await assert.rejects(readFile(join(root, INSTALL_MARKER)), { code: 'ENOENT' });
});
test('a partial or changed already-adapted hardened gate cannot fall back to overwriting the target', async t => {
  const root = await fixture(t); await mkdir(join(root, 'scripts/ci'), { recursive: true });
  const partial = '// WORKLOOM_DELIVERY_BOUND_PROTOCOL_V1\nexport async function runLockGate() { throw new Error("Incomplete migration"); }\n';
  await writeFile(join(root, 'scripts/ci/verify-lock-conflict.mjs'), partial);
  await assert.rejects(plan(root), /migration/);
  assert.equal(await readFile(join(root, 'scripts/ci/verify-lock-conflict.mjs'), 'utf8'), partial);
  assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), original);
  await assert.rejects(readFile(join(root, INSTALL_MARKER)), { code: 'ENOENT' });
});
test('actual installed main-selector Python product runs the copied delivery regression with resolved include gates and the normalized bootstrap selector', async t => {
  const root = await fixture(t);
  // Verify the complete package under review before committing; production readAssets remains exact-Git only.
  const currentAssets = { ...assets, ...Object.fromEntries(await Promise.all(CORE_ASSETS.map(async path => [path, await readFile(join(sourceRoot, path), 'utf8')]))) };
  await applyInstallation(await plan(root, { assets: currentAssets }), root);
  const yamlDirectory = dirname(createRequire(new URL('./runtime/package.json', import.meta.url)).resolve('yaml/package.json'));
  await cp(yamlDirectory, join(root, 'scripts/delivery/runtime/node_modules/yaml'), { recursive: true });
  await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'installation fixture'], { cwd: root });
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.CNB_TOKEN; delete env.CNB_TOKEN_FOR_AI; delete env.CNB_TOKEN_FOR_CODEBUDDY;
  const result = spawnSync(process.execPath, ['--test', 'scripts/delivery/queue.test.mjs', 'scripts/ci/protocol-rules.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); assert.ok(Number(/tests (\d+)/.exec(result.stdout)?.[1]) >= 80, result.stdout);
});
test('installation rejects a symlink in any asset path before performing any migration', async t => {
  const root = await fixture(t); const outside = await temp(t);
  await mkdir(join(root, 'scripts')); await symlink(outside, join(root, 'scripts', 'delivery'));
  await assert.rejects(plan(root), /symlink/);
  assert.equal(await readFile(join(root, '.cnb.yml'), 'utf8'), original);
  await assert.rejects(readFile(join(outside, 'queue-model.mjs')), { code: 'ENOENT' });
});
test('sparse installation reads an existing product include from its exact tracked HEAD without losing checks', async t => {
  const root = await fixture(t, 'include: product/ci.yml\n');
  await mkdir(join(root, 'product')); await writeFile(join(root, 'product/ci.yml'), original);
  await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  await rm(join(root, 'product'), { recursive: true });
  const result = await plan(root);
  assert.ok(result.requiredNames.includes('product-gate')); assert.ok(!result.changes.has('product/ci.yml'));
});
test('instruction append is idempotent and rejects duplicate, reversed or incomplete markers', () => {
  const before = 'frozen original instructions\n'; const once = appendAgentRule(before);
  assert.equal(appendAgentRule(once), once); assert.ok(once.includes(AGENT_RULE));
  for (const text of ['<!-- WORKLOOM-RD-DELIVERY:BEGIN -->', AGENT_RULE + AGENT_RULE, '<!-- WORKLOOM-RD-DELIVERY:END --><!-- WORKLOOM-RD-DELIVERY:BEGIN -->']) assert.throws(() => appendAgentRule(text), /markers/);
});
test('Tiger migration preserves Python product checks and delegates every legacy governance entry to the canonical root', async t => {
  const ci = original.replace('python3 product_test.py', 'python3 governance/product_test.py\n            node governance/scripts/ci/protocol-rules.test.mjs\n            node governance/scripts/ci/verify-commit-msg.mjs\n            node governance/scripts/ci/verify-lock-conflict.mjs');
  const root = await fixture(t, ci); const result = await plan(root, { repo: 'workloom-ai/workroom-tiger' });
  const next = result.changes.get('.cnb.yml');
  assert.ok(next.includes('python3 governance/product_test.py')); assert.ok(next.includes('node scripts/ci/verify-lock-conflict.mjs'));
  assert.ok(!next.includes('node governance/scripts/ci/verify-lock-conflict.mjs'));
  assert.deepEqual([...result.changes.keys()].filter(path => path.startsWith('governance/')).sort(), [...TIGER_ALIASES].sort());
  assert.match(result.changes.get('governance/scripts/ci/protocol-rules.mjs'), /export \* from/);
  assert.match(result.changes.get('governance/scripts/ci/verify-lock-conflict.mjs'), /process.exitCode = result.status/);
});
test('account discovery paginates all owned active repos and fails on ambiguous or unreadable identity', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), path: `org/repo-${i}` })); let calls = 0;
  const result = await discoverAccount('ephemeral', async (_repo, path) => { calls++; assert.ok(path.includes('role=Owner&status=active')); return calls === 1 ? first : [{ id: '101', path: 'other/new', freeze: true }]; });
  assert.equal(calls, 2); assert.equal(result.length, 101); assert.equal(result.at(-1).frozen, true);
  await assert.rejects(discoverAccount('ephemeral', async () => [{ id: '1', path: 'org/one' }, { id: '1', path: 'org/two' }]), /ambiguous/);
  await assert.rejects(discoverAccount('ephemeral', async () => [{ id: '1', path: 'org/one' }, { id: '2', path: 'org/one' }]), /ambiguous/);
  await assert.rejects(discoverAccount('ephemeral', async () => ({})), /unreadable/);
});
test('nested CNB groups use their exact state destination; disabled platform model exits before network I/O', async () => {
  const nested = 'owner/group/subgroup/project';
  assert.ok(validRepoSlug(nested)); assert.equal(new GitStateStore({ repo: nested }).repo, nested);
  const discovered = await discoverAccount(fixtureCredential, async () => [{ id: 'nested', path: nested }]); assert.equal(discovered[0].repo, nested);
  for (const bad of ['owner/../other', 'owner//other', '/owner/repo', 'owner/repo?x=y', 'https://foreign/repo']) {
    assert.equal(validRepoSlug(bad), false); assert.throws(() => new GitStateStore({ repo: bad }), /slug/);
  }
  assert.throws(() => new GitStateStore({ repo: nested, token: fixtureCredential, remote: 'https://example.com/repo.git' }), /destination/);
  let calls = 0;
  await assert.rejects(modelGateway({ repo: nested, token: fixtureCredential, request: async () => { calls++; } }), /disabled/);
  assert.equal(calls, 0);
});
test('object creation recovers a single actual lost acknowledgement without blind retry or accepting a collision', async () => {
  let objects = []; let writes = 0;
  const options = { list: async () => objects, match: object => object.marker === 'fixed', create: async () => { writes++; objects.push({ number: 1, marker: 'fixed' }); throw new Error('lost acknowledgement'); } };
  assert.equal((await createOnce(options)).number, 1); assert.equal((await createOnce(options)).number, 1); assert.equal(writes, 1);
  objects.push({ number: 2, marker: 'fixed' }); await assert.rejects(createOnce(options), /ambiguous/); assert.equal(writes, 1);
  await assert.rejects(createOnce({ list: async () => [], match: () => true, create: async () => { throw new Error('denied'); } }), /denied/);
});
test('actual CNB issue summaries without bodies recover the exact task and a lost create acknowledgement once', async () => {
  const taskId = 'T-2026-1006-1002'; const marker = '<!-- delivery-install:exact -->';
  let rows = []; let detail; let writes = 0;
  const platform = { list: async path => {
    assert.ok(!path.includes('keyword='));
    return path.includes('state=open') ? rows : [];
  }, call: async path => { assert.equal(path, '/-/issues/9'); return detail; } };
  const options = { list: () => installationIssues(platform, taskId), match: item => item.body.includes(marker), create: async () => {
    writes++; rows = [{ number: '9', title: `[${taskId}] 安装普通研发自动交付` }];
    detail = { ...rows[0], body: marker }; throw new Error('lost create acknowledgement');
  } };
  assert.equal((await createOnce(options)).number, 9); assert.equal((await createOnce(options)).number, 9); assert.equal(writes, 1);
  detail = { ...detail, body: undefined }; await assert.rejects(installationIssues(platform, taskId), /unreadable/);
  detail = { ...detail, body: marker, number: 10 }; await assert.rejects(installationIssues(platform, taskId), /identity/);
  await assert.rejects(installationIssues(platform, 'invalid'), /identity/); assert.equal(writes, 1);
});
test('full issue-title coverage catches a colliding task even when keyword indexing would omit it', async () => {
  const taskId = 'T-2026-1006-1002'; let hydrated = 0;
  const platform = { list: async path => path.includes('state=open') ? [{ number: 20, title: `[${taskId}] Another task` }, { number: 21, title: 'Unrelated task' }] : [],
    call: async path => { assert.equal(path, '/-/issues/20'); hydrated++; return { number: 20, title: `[${taskId}] Another task`, body: 'Different ownership marker' }; } };
  const issues = await installationIssues(platform, taskId);
  assert.equal(issues.length, 1); assert.equal(hydrated, 1); assert.ok(!issues[0].body.includes('delivery-install:expected'));
});
test('empty CNB PR summary bodies recover only the exact installer branch; failures never become absent objects', async () => {
  const branch = 'chore/protocol-onboarding-exact'; const marker = '<!-- delivery-install:exact -->';
  let rows = [{ number: 3, head: { ref: 'task/unrelated' }, body: '' }]; let detail; let writes = 0; let reads = 0;
  const platform = { list: async () => rows, pull: async number => { reads++; assert.equal(number, 8); return detail; } };
  const options = { list: () => installationPulls(platform, branch), match: item => item.body.includes(marker), create: async () => {
    writes++; rows.push({ number: 8, head: { ref: `refs/heads/${branch}` }, body: '' });
    detail = { ...rows[1], body: marker }; throw new Error('lost acknowledgement');
  } };
  assert.equal((await createOnce(options)).number, 8); assert.equal((await createOnce(options)).number, 8); assert.equal(writes, 1); assert.equal(reads, 2);
  detail = { ...detail, head: { ref: 'task/changed' } }; await assert.rejects(installationPulls(platform, branch), /changed branch/);
  platform.pull = async () => { throw Object.assign(new Error('Permission denied'), { status: 403 }); };
  await assert.rejects(createOnce(options), /Permission denied/); assert.equal(writes, 1);
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
test('an activated package update preserves verified Codex/CI main policy without restoring the human approval counter', async () => {
  const state = emptyState(repo); appendEvent(state, 'activated', { mainSha: main });
  let rule = { ...branchProtectionPayload({ requireReview: false }), allow_master_manual_merge: false, id: 'main-rule' }; let writes = 0; let candidates = 0;
  const platform = { protections: async () => [rule], call: async () => { writes++; }, assertCandidateProtection: async () => { candidates++; } };
  assert.equal((await ensureInstallationPolicy(platform, state)).required_pull_request_reviews, false);
  assert.equal(writes, 0); assert.equal(candidates, 1);
  for (const patch of [{ required_pull_request_reviews: true }, { allow_master_pushes: true }, { required_master_approve: true }, { allow_master_manual_merge: true }]) {
    const before = rule; rule = { ...rule, ...patch }; await assert.rejects(ensureInstallationPolicy(platform, state), /drifted/); rule = before;
  }
  assert.equal(writes, 0);
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
test('only a later exact positive merge rejection resolves the persisted installation request', () => {
  const state = emptyState(repo); appendEvent(state, 'installer_merge_requested', { number: 7, snapshot: { headSha: head } });
  assert.ok(pendingInstallerMerge(state, 7));
  appendEvent(state, 'installer_merge_rejected', { number: 7, headSha: main, verifiedUnmerged: true }); assert.ok(pendingInstallerMerge(state, 7));
  appendEvent(state, 'installer_merge_rejected', { number: 7, headSha: head, verifiedUnmerged: false }); assert.ok(pendingInstallerMerge(state, 7));
  appendEvent(state, 'installer_merge_rejected', { number: 7, headSha: head, verifiedUnmerged: true }); assert.equal(pendingInstallerMerge(state, 7), null);
});
test('verified installation policy refresh creates one frozen same-source PR, prepares it immediately and preserves the original', async () => {
  let rules = [{ ...branchProtectionPayload(), id: 'main' }]; let ref; let pulls = []; let writes = 0; let prepared = 0;
  const review = reviewFixture(); const original = { ...review.pull, title: 'feat(base): install', is_merged: false };
  const platform = { repo, protections: async () => rules, pull: async number => number === 7 ? original : pulls.find(pull => pull.number === number), main: async () => ({ commit: { sha: main } }), list: async () => pulls,
    call: async (path, options) => {
      if (options?.method === 'PATCH') { const rule = rules.find(rule => path.endsWith(rule.id)); Object.assign(rule, options.body); return {}; }
      if (path.includes('branch-protections') && options?.method === 'POST') { rules.push({ ...options.body, id: `rule-${rules.length}` }); return {}; }
      if (path === '/-/git/branches' && options?.method === 'POST') { ref = { commit: { sha: options.body.start_point }, protected: true }; return {}; }
      if (path.startsWith('/-/git/branches/')) { if (path.endsWith('chore%2Fprotocol-onboarding-old')) return { protected: true, commit: { sha: head } }; if (!ref) throw Object.assign(new Error('absent'), { status: 404 }); return ref; }
      if (path === '/-/pulls' && options?.method === 'POST') { writes++; const value = { number: 8, state: 'open', is_wip: false, body: options.body.body, head: { sha: head, ref: options.body.head } }; pulls = [value]; return value; }
      throw new Error(`Unexpected ${path}`);
    } };
  const store = memoryStore(); const proof = { platform, store, root: '/owned', ...review, pull: original,
    prepare: async value => { assert.equal(value.number, 8); assert.equal(value.expected, head); prepared++; } };
  const first = await refreshInstallerPolicy(proof); assert.equal(first.status, 'waiting_checks'); assert.equal(first.supersededNumber, 7);
  assert.equal(rules[0].required_pull_request_reviews, false); assert.equal(writes, 1); assert.equal(prepared, 1); assert.equal(original.is_merged, false);
  await refreshInstallerPolicy(proof); assert.equal(writes, 1); assert.equal(prepared, 2);
  assert.equal((await store.read()).events.filter(event => event.kind === 'installer_replacement').length, 2);
  await assert.rejects(refreshInstallerPolicy({ ...proof, developerReview: null }), /review/);
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

test('first-install merge rejects changed body, readiness, source, main, scope, dependencies and CI after review', () => {
  const proof = reviewFixture();
  const state = emptyState(repo); state.tasks['7'] = { reviewSnapshot: proof.reviewSnapshot, developerReview: proof.developerReview };
  const options = { ...proof, state, snapshot: structuredClone(proof.reviewSnapshot) };
  assert.equal(verifyInstallationReview(options).id, proof.developerReview.id);
  for (const change of [
    value => { value.pull.body += '\nchanged release intent'; },
    value => { value.snapshot.pull.is_wip = true; },
    value => { value.snapshot.pull.state = 'closed'; },
    value => { value.snapshot.headSha = main; },
    value => { value.snapshot.mainSha = head; },
    value => { value.snapshot.intent.ready = false; },
    value => { value.snapshot.intent.dependsOn = [6]; },
    value => { value.snapshot.files.push('new-file.mjs'); },
    value => { value.snapshot.checkErrors = ['Product CI failed']; },
  ]) {
    const changed = structuredClone(options); change(changed);
    assert.throws(() => verifyInstallationReview(changed), /review|prerequisite|cover/);
  }
});

test('manifest rejects partial execution, foreign targets, unknown assets, incomplete adapters and altered digests', async t => {
  const root = await fixture(t); await applyInstallation(await plan(root), root);
  const manifest = JSON.parse(await readFile(join(root, INSTALL_MARKER), 'utf8'));
  assert.equal(validateInstallationManifest(manifest, repo), manifest);
  for (const change of [
    value => { value.repo = 'other/repo'; },
    value => { delete value.assets['scripts/delivery/install-manifest.mjs']; value.packageHash = packageDigest(value.assets); },
    value => { value.assets['scripts/ci/verify-delivery-admission.mjs'] = hash('adapter'); value.packageHash = packageDigest(value.assets); },
    value => { value.assets['../outside'] = hash('outside'); value.packageHash = packageDigest(value.assets); },
    value => { value.assets['scripts/delivery/queue-runner.mjs'] = 'invalid'; },
    value => { value.packageHash = '0'.repeat(64); },
  ]) { const changed = structuredClone(manifest); change(changed); assert.throws(() => validateInstallationManifest(changed, repo)); }
  const tiger = { ...manifest, repo: 'workloom-ai/workroom-tiger' };
  assert.throws(() => validateInstallationManifest(tiger, tiger.repo), /closure/);
});

test('actual Git manifest binds committed bytes and upstream provenance separately from the target installer SHA', async t => {
  const root = await fixture(t); await applyInstallation(await plan(root), root);
  await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'complete reviewed package'], { cwd: root });
  const sha = await git(['rev-parse', 'HEAD'], { cwd: root });
  assert.notEqual(sha, sourceSha);
  const verified = await verifyInstallationManifest({ root, repo, sha });
  assert.equal(verified.upstreamSourceSha, sourceSha); assert.equal(verified.installerSourceSha, sha);
  const file = join(root, 'scripts/delivery/queue-runner.mjs'); const originalBytes = await readFile(file, 'utf8');
  await writeFile(file, originalBytes + '\n// uncommitted drift\n');
  await assert.rejects(verifyInstallationManifest({ root, repo, sha }), /differs/); await writeFile(file, originalBytes);
  const outside = join(await temp(t), 'outside.mjs'); await writeFile(outside, originalBytes); await rm(file); await symlink(outside, file);
  await assert.rejects(verifyInstallationManifest({ root, repo, sha }), /symlink/);
  await rm(file); await writeFile(file, originalBytes);
  const manifestPath = join(root, INSTALL_MARKER); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets['scripts/delivery/queue-runner.mjs'] = hash('wrong bytes'); manifest.packageHash = packageDigest(manifest.assets);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); await git(['add', INSTALL_MARKER], { cwd: root }); await git(['commit', '--quiet', '-m', 'altered package digest'], { cwd: root });
  await assert.rejects(verifyInstallationManifest({ root, repo, sha: await git(['rev-parse', 'HEAD'], { cwd: root }) }), /digest mismatch/);
});

test('missing target manifest cannot prepare an installed execution closure or claim complete provenance', async t => {
  const root = await fixture(t); await git(['init', '--quiet'], { cwd: root }); await git(['add', '.'], { cwd: root }); await git(['commit', '--quiet', '-m', 'no installation manifest'], { cwd: root });
  await assert.rejects(verifyInstallationManifest({ root, repo, sha: await git(['rev-parse', 'HEAD'], { cwd: root }) }), { code: 'ENOENT' });
});
