import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addressFor, fanoutTargets, loadRegistry, repository, repositoryFromRemote, validateRegistry } from './repository-registry.mjs';
import { baseSource, gitAuthEnv } from './base-sync.mjs';
import { applyRepositoryConfig, planRepositoryConfig } from './repository-config.mjs';
import { createGithubClient, deliveryPolicySha256, inspectGithubPull, mergeGithubPull, mirrorPlan } from '../scripts/delivery/github.mjs';
import { sensitiveScopes } from '../scripts/delivery/queue-model.mjs';

const doc = loadRegistry();
const SHA = { head: 'a'.repeat(40), base: 'b'.repeat(40), merge: 'c'.repeat(40), tree: 'd'.repeat(40), headTree: 'e'.repeat(40), githubTree: '1'.repeat(40), workflowsTree: '2'.repeat(40) };
const hash = data => createHash('sha256').update(data).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function fixture(identity = 'workloom-growthtest') {
  const root = mkdtempSync(join(tmpdir(), 'workloom-repository-config-'));
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'product.manifest.json'), JSON.stringify({ schemaVersion: 'workloom.product/v1', productId: repository(doc, identity).productId, repository: 'historical/source', release: { appId: 'com.test.original' }, business: { frozen: true } }));
  writeFileSync(join(root, 'business.txt'), 'frozen product body\n');
  git(root, 'add', '--', 'product.manifest.json', 'business.txt');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@invalid.example', 'commit', '-m', 'fixture');
  return root;
}
function review() {
  return { schemaVersion: 'workloom.codex-review/v1', repository: 'geniusdapeng-collab/workloom-hotel', headSha: SHA.head, baseSha: SHA.base,
    files: ['.workloom-repository.json'], policySha256: deliveryPolicySha256(),
    review: { actor: 'codex', status: 'passed', evidenceSha256: hash('review evidence') }, tests: [{ command: 'node --test', status: 'passed', evidenceSha256: hash('test evidence') }],
    ciApplicability: { status: 'applicable', headSha: SHA.head, baseSha: SHA.base, policySha256: deliveryPolicySha256(),
      reason: 'The complete exact-head workflow and PR event were independently inspected.', evidenceSha256: hash('workflow applicability evidence'),
      completeWorkflowFiles: ['.github/workflows/ci.yml'], expectedCheckNames: ['original-ci'] } };
}
function apiFixture(mutate = () => {}) {
  const address = addressFor(doc, 'workloom-hotel'); const prefix = `/repos/${address.repository}`; const calls = [];
  const data = {
    pull: { state: 'open', draft: false, changed_files: 1, head: { sha: SHA.head, repo: { full_name: address.repository } }, base: { sha: SHA.base, ref: 'main', repo: { full_name: address.repository } } },
    files: [{ filename: '.workloom-repository.json' }],
    branch: { commit: { sha: SHA.base }, protected: false }, status: { state: 'success' }, statuses: [], checks: [{ name: 'original-ci', status: 'completed', conclusion: 'success' }], protection: null,
    headCommit: { sha: SHA.head, tree: { sha: SHA.headTree } },
    rootTree: { sha: SHA.headTree, truncated: false, tree: [{ path: '.github', mode: '040000', type: 'tree', sha: SHA.githubTree }] },
    githubTree: { sha: SHA.githubTree, truncated: false, tree: [{ path: 'workflows', mode: '040000', type: 'tree', sha: SHA.workflowsTree }] },
    workflowsTree: { sha: SHA.workflowsTree, truncated: false, tree: [{ path: 'ci.yml', mode: '100644', type: 'blob', sha: '3'.repeat(40) }] },
    merge: { merged: true, sha: SHA.merge }, commit: { parents: [{ sha: SHA.base }, { sha: SHA.head }], commit: { tree: { sha: SHA.tree } } },
    main: { commit: { sha: SHA.merge } },
  };
  mutate(data);
  let merged = false;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `${prefix}/pulls/1`) return structuredClone(data.pull);
    if (path.startsWith(`${prefix}/pulls/1/files?`)) return structuredClone(data.files);
    if (path === `${prefix}/branches/main`) return structuredClone(merged ? data.main : data.branch);
    if (path === `${prefix}/branches/main/protection`) {
      if (data.protection) return structuredClone(data.protection);
      const error = new Error('HTTP 404'); error.status = 404; throw error;
    }
    if (path === `${prefix}/commits/${SHA.head}/status?per_page=100`) return structuredClone(data.status);
    if (path.includes(`/commits/${SHA.head}/statuses?`)) return structuredClone(data.statuses);
    if (path.includes(`/commits/${SHA.head}/check-runs?`)) return { check_runs: structuredClone(data.checks) };
    if (path === `${prefix}/git/commits/${SHA.head}`) return structuredClone(data.headCommit);
    if (path === `${prefix}/git/trees/${SHA.headTree}`) return structuredClone(data.rootTree);
    if (path === `${prefix}/git/trees/${SHA.githubTree}`) return structuredClone(data.githubTree);
    if (path === `${prefix}/git/trees/${SHA.workflowsTree}`) return structuredClone(data.workflowsTree);
    if (method === 'PUT' && path === `${prefix}/pulls/1/merge`) { merged = true; return structuredClone(data.merge); }
    if (path === `${prefix}/commits/${SHA.merge}`) return structuredClone(data.commit);
    throw new Error(`Unexpected fixture API call: ${method} ${path}`);
  };
  return { options: { request, address, pullNumber: 1, headSha: SHA.head, baseSha: SHA.base, reviewReceipt: review() }, calls };
}
test('registry keeps all observed addresses and subscription boundaries', () => {
  assert.equal(doc.repositories.length, 15); assert.equal(doc.repositories.filter(e => e.cnb).length, 14);
  assert.equal(repository(doc, 'geo-evidence-studio').cnb, null);
  assert.equal(addressFor(doc, 'workloom-ai/workloom-hotel').repository, 'geniusdapeng-collab/workloom-hotel');
  assert.equal(fanoutTargets(doc, { mode: 'repository-config' }).length, 15);
  assert.equal(doc.repositories.filter(e => e.baseSync.receive === 'subscribed').length, 9);
  assert.ok(fanoutTargets(doc, { mode: 'full' }).every(e => e.baseSync.uiRolloutWave !== 'paused'));
  for (const identity of ['workloom-growthtest', 'workloom-growthmatrix', 'geo-evidence-studio', 'WorkLoom-video-edit', 'workloom-BusinessManagementSystem']) {
    assert.throws(() => fanoutTargets(doc, { mode: 'full', only: identity }), /forbidden/);
    assert.throws(() => fanoutTargets(doc, { mode: 'required-only', only: identity }), /forbidden/);
  }
});
test('registry rejects duplicate addresses, credential destinations and isolation changes', () => {
  assert.throws(() => repository(doc, undefined), /identity/);
  for (const mutate of [
    d => { d.repositories[1].github = d.repositories[0].github; },
    d => { d.repositories[0].github.url = 'https://user:fake@github.com/owner/repo'; },
    d => { repository(d, 'workloom-growthtest').baseSync.receive = 'subscribed'; },
    d => { repository(d, 'workroom-fox').baseSync.reflux = 'proposal-only'; },
    d => { d.mirrorPolicy.automaticProductSync = true; },
  ]) { const bad = structuredClone(doc); mutate(bad); assert.throws(() => validateRegistry(bad)); }
});
test('default and explicit platform operations resolve historical aliases without changing identity', () => {
  assert.deepEqual(baseSource({ baseRepo: 'workloom-ai/workloom-im' }, {}), { repo: 'geniusdapeng-collab/workloom-im', url: 'https://github.com' });
  assert.deepEqual(baseSource({ baseRepo: 'workloom-ai/workloom-im' }, { explicitBaseUrl: true, baseUrl: 'https://github.com' }), { repo: 'geniusdapeng-collab/workloom-im', url: 'https://github.com' });
  assert.deepEqual(baseSource({ baseRepo: 'geniusdapeng-collab/workloom-im' }, { explicitBaseUrl: true, baseUrl: 'https://cnb.cool' }), { repo: 'workloom-ai/workloom-im', url: 'https://cnb.cool' });
  assert.throws(() => baseSource({ baseRepo: 'someone/other' }, {}), /not registered/);
  const env = gitAuthEnv('test-only-operation-token');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper'); assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraHeader');
  assert.equal(gitAuthEnv('').GIT_CONFIG_COUNT, '1');
});
test('observed origin disambiguates duplicate product IDs and recognizes SSH isolated aliases', () => {
  for (const remote of ['https://github.com/geniusdapeng-collab/workloom-growthtest.git', 'git@github.com:geniusdapeng-collab/workloom-growthtest.git', 'ssh://git@cnb.cool/workloom-ai/workloom-growthtest.git']) assert.equal(repositoryFromRemote(doc, remote).logicalId, 'workloom-growthtest');
  const root = fixture('geo-evidence-studio');
  try {
    git(root, 'remote', 'add', 'origin', 'https://github.com/geniusdapeng-collab/geo-evidence-studio.git');
    assert.throws(() => planRepositoryConfig(root, doc, 'workloom'), /origin.*identity/);
    assert.equal(planRepositoryConfig(root, doc, 'geo-evidence-studio').logicalId, 'geo-evidence-studio');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('direct base-sync cannot bypass frozen/config-only product boundaries', () => {
  for (const identity of ['workloom-growthtest', 'workloom-growthmatrix', 'geo-evidence-studio', 'WorkLoom-video-edit', 'workloom-BusinessManagementSystem']) {
    const root = fixture(identity);
    try {
      git(root, 'remote', 'add', 'origin', `${repository(doc, identity).github.url}.git`);
      const result = spawnSync(process.execPath, [new URL('./base-sync.mjs', import.meta.url).pathname, 'pull', '--repo', root, '--base-dir', '/deliberately-missing-base', '--no-commit'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Product base-sync is forbidden/);
      assert.equal(git(root, 'status', '--porcelain'), '');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('a forged local policy cannot override a registered frozen origin', () => {
  const root = fixture('workloom-growthtest');
  try {
    git(root, 'remote', 'add', 'origin', 'git@github.com:geniusdapeng-collab/workloom-growthtest.git');
    writeFileSync(join(root, '.workloom-repository.json'), JSON.stringify({ logicalId: 'workloom-hotel' }));
    const result = spawnSync(process.execPath, [new URL('./base-sync.mjs', import.meta.url).pathname, 'pull', '--repo', root, '--base-dir', '/deliberately-missing-base', '--no-commit'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /identity differs/);
    assert.equal(readFileSync(join(root, 'business.txt'), 'utf8'), 'frozen product body\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('config-only migration preserves complete product bytes and every non-repository manifest field', () => {
  const root = fixture();
  try {
    const business = hash(readFileSync(join(root, 'business.txt')));
    const before = JSON.parse(readFileSync(join(root, 'product.manifest.json')));
    const plan = planRepositoryConfig(root, doc, 'workloom-growthtest');
    const receipt = applyRepositoryConfig(root, plan);
    assert.deepEqual(receipt.changedPaths.sort(), ['.workloom-delivery.json', '.workloom-repository.json', 'product.manifest.json']);
    assert.equal(receipt.productContentFrozen, true);
    const after = JSON.parse(readFileSync(join(root, 'product.manifest.json')));
    assert.equal(after.repository, 'geniusdapeng-collab/workloom-growthtest');
    delete before.repository; delete after.repository; assert.deepEqual(after, before);
    assert.equal(hash(readFileSync(join(root, 'business.txt'))), business);
    assert.equal(planRepositoryConfig(root, doc, 'workloom-growthtest').operations.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('config channel rejects foreign manifest identity, dirty source and symlink', () => {
  const root = fixture();
  try {
    assert.throws(() => planRepositoryConfig(root, doc, 'workloom-hotel'), /identity/);
    const plan = planRepositoryConfig(root, doc, 'workloom-growthtest');
    writeFileSync(join(root, 'business.txt'), 'changed');
    assert.throws(() => applyRepositoryConfig(root, plan), /dirty/);
    git(root, 'checkout', '--', 'business.txt');
    symlinkSync('business.txt', join(root, '.workloom-repository.json'));
    assert.throws(() => planRepositoryConfig(root, doc, 'workloom-growthtest'), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('config transaction rolls back an earlier write when later operation is invalid', () => {
  const root = fixture();
  try {
    const plan = planRepositoryConfig(root, doc, 'workloom-growthtest');
    plan.operations[1].path = 'business.txt';
    assert.throws(() => applyRepositoryConfig(root, plan), /allowlist/);
    assert.equal(existsSync(join(root, '.workloom-repository.json')), false);
    assert.equal(git(root, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('manifest governance cannot edit business identity via a crafted plan', () => {
  const root = fixture();
  try {
    const plan = planRepositoryConfig(root, doc, 'workloom-growthtest');
    const manifest = plan.operations.find(o => o.path === 'product.manifest.json');
    const after = JSON.parse(manifest.content); after.release.appId = 'replacement'; manifest.content = JSON.stringify(after);
    assert.throws(() => applyRepositoryConfig(root, plan), /other than repository/);
    assert.equal(git(root, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('verified merge binds exact reviewed parents, existing checks and current main', async () => {
  const { options, calls } = apiFixture();
  const receipt = await mergeGithubPull(options);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.mainSha, SHA.merge); assert.equal(receipt.treeSha, SHA.tree);
  assert.equal(receipt.existingCheckCount, 1);
  assert.deepEqual(calls.find(c => c.method === 'PUT').body, { sha: SHA.head, merge_method: 'merge' });
  assert.equal(mirrorPlan(doc, 'workloom-hotel', receipt).state, 'deferred');
});
for (const [label, mutate] of [
  ['changed head', d => { d.pull.head.sha = 'e'.repeat(40); }],
  ['changed main', d => { d.branch.commit.sha = 'e'.repeat(40); }],
  ['draft', d => { d.pull.draft = true; }],
  ['fork', d => { d.pull.head.repo.full_name = 'other/fork'; }],
  ['blocked risk label', d => { d.pull.labels = [{ name: 'risk/block' }]; }],
  ['partial file list', d => { d.pull.changed_files = 2; }],
  ['unreviewed file', d => { d.files[0].filename = 'business.ts'; }],
  ['pending status', d => { d.statuses.push({ context: 'original-ci', state: 'pending' }); }],
  ['failed check', d => { d.checks.push({ name: 'original-ci', status: 'completed', conclusion: 'failure' }); }],
  ['missing required check', d => { d.protection = { required_status_checks: { contexts: ['original-required'] } }; }],
]) test(`GitHub merge rejects ${label} before remote mutation`, async () => {
  const { options, calls } = apiFixture(mutate);
  await assert.rejects(mergeGithubPull(options)); assert.equal(calls.some(c => c.method !== 'GET'), false);
});
test('passing check from wrong app cannot satisfy required app identity', async () => {
  const { options } = apiFixture(d => { d.checks.push({ name: 'ci', status: 'completed', conclusion: 'success', app: { id: 1 } }); d.protection = { required_status_checks: { checks: [{ context: 'ci', app_id: 2 }] } }; });
  await assert.rejects(inspectGithubPull(options), /Required GitHub check/);
});
test('missing/failed review or tests cannot become a merge', async () => {
  for (const mutate of [r => { r.headSha = SHA.base; }, r => { r.review.actor = 'platform-ai'; }, r => { r.review.evidenceSha256 = ''; }, r => { r.tests = []; }, r => { r.tests[0].status = 'failed'; }]) {
    const { options, calls } = apiFixture(); mutate(options.reviewReceipt);
    await assert.rejects(mergeGithubPull(options)); assert.equal(calls.length, 0);
  }
});
test('a completed remote merge with changed base parents or moving main remains unverified', async () => {
  for (const mutate of [d => { d.commit.parents[0].sha = 'e'.repeat(40); }, d => { d.main.commit.sha = 'e'.repeat(40); }]) {
    const { options } = apiFixture(mutate);
    await assert.rejects(mergeGithubPull(options), /occurred.*not verified/);
  }
});
test('CNB absence is explicit and never creates a repository or blocks GitHub delivery', () => {
  const receipt = { schemaVersion: 'workloom.main-integration/v1', status: 'verified', repository: 'geniusdapeng-collab/geo-evidence-studio', mainSha: SHA.merge, treeSha: SHA.tree };
  const plan = mirrorPlan(doc, 'geo-evidence-studio', receipt);
  assert.equal(plan.destination, null); assert.equal(plan.state, 'not-configured'); assert.equal(plan.blocksGithubDelivery, false);
});
test('API adapter scopes tokens to fixed GitHub host and redacts all response errors', async () => {
  const requests = []; const fakeToken = ['fixture', 'authorization'].join('-');
  const request = createGithubClient({ token: fakeToken, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: false, status: 403, json: async () => ({ message: fakeToken }) }; } });
  await assert.rejects(request('GET', '/repos/owner/repo/pulls/1'), error => error.status === 403 && !error.message.includes(fakeToken));
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/pulls/1');
  assert.equal(requests[0].options.redirect, 'error');
  await assert.rejects(request('GET', 'https://other.invalid/'), /boundary/);
  assert.equal(requests.length, 1);
});
test('GitHub workflows receive the same sensitive governance classification as CNB CI', () => {
  assert.deepEqual(sensitiveScopes(['.github/workflows/ci.yml']), ['protocol']);
});
test('CI registration gap rejects zero observed checks before any merge', async () => {
  const { options, calls } = apiFixture(d => { d.status.state = 'pending'; d.checks = []; });
  await assert.rejects(mergeGithubPull(options), /CI|check/i);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});
test('CI registration gap rejects the first passing check when another expected job is absent', async () => {
  const { options, calls } = apiFixture();
  options.reviewReceipt.ciApplicability.expectedCheckNames.push('late-job');
  await assert.rejects(mergeGithubPull(options), /late-job/);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});
test('CI registration requires success rather than skipped or neutral for every expected job', async () => {
  for (const conclusion of ['skipped', 'neutral']) {
    const { options, calls } = apiFixture(d => { d.checks[0].conclusion = conclusion; });
    await assert.rejects(mergeGithubPull(options), /original-ci/);
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
});
test('CI applicability rejects a missing, stale, unproven or incomplete declaration before network', async () => {
  for (const mutate of [
    r => { delete r.ciApplicability; }, r => { r.ciApplicability.headSha = SHA.base; },
    r => { r.ciApplicability.baseSha = SHA.head; }, r => { r.ciApplicability.policySha256 = '0'.repeat(64); },
    r => { r.ciApplicability.evidenceSha256 = ''; }, r => { r.ciApplicability.reason = 'assumed'; },
    r => { r.ciApplicability.expectedCheckNames = []; }, r => { r.ciApplicability.completeWorkflowFiles = undefined; },
    r => { r.ciApplicability.completeWorkflowFiles = ['.github/workflows/../outside.yml']; },
  ]) {
    const { options, calls } = apiFixture(); mutate(options.reviewReceipt);
    await assert.rejects(mergeGithubPull(options), /CI|workflow/i);
    assert.equal(calls.length, 0);
  }
});
test('CI applicability must name every exact-head workflow file', async () => {
  const { options, calls } = apiFixture();
  options.reviewReceipt.ciApplicability.completeWorkflowFiles = [];
  await assert.rejects(mergeGithubPull(options), /workflow.*complete|complete.*workflow/i);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});
test('CI applicability rejects truncated or wrong-identity workflow source trees', async () => {
  for (const mutate of [d => { d.workflowsTree.truncated = true; }, d => { d.headCommit.sha = SHA.base; }, d => { d.rootTree.sha = SHA.tree; }]) {
    const { options, calls } = apiFixture(mutate);
    await assert.rejects(mergeGithubPull(options), /workflow|commit|tree/i);
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
});
test('CI zero-check exception needs explicit exact-head evidence that no workflow applies', async () => {
  const { options, calls } = apiFixture(d => { d.status.state = 'pending'; d.checks = []; d.rootTree.tree = []; });
  Object.assign(options.reviewReceipt.ciApplicability, { status: 'not-applicable', expectedCheckNames: [], completeWorkflowFiles: [],
    reason: 'The complete exact-head tree contains no GitHub workflow files, and no external check is configured.' });
  const receipt = await mergeGithubPull(options);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.existingCheckCount, 0);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 1);
});
test('CI no-applicable declaration cannot override an observed check or required protection', async () => {
  for (const protectedBranch of [false, true]) {
    const { options, calls } = apiFixture(d => {
      d.rootTree.tree = [];
      if (protectedBranch) { d.checks = []; d.protection = { required_status_checks: { contexts: ['required-ci'] } }; }
    });
    Object.assign(options.reviewReceipt.ciApplicability, { status: 'not-applicable', expectedCheckNames: [], completeWorkflowFiles: [] });
    await assert.rejects(mergeGithubPull(options), /CI|Required GitHub check/i);
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
});
test('CI exact expected status context can satisfy a job without a check-run', async () => {
  const { options } = apiFixture(d => { d.checks = []; d.statuses = [{ context: 'original-ci', state: 'success' }]; });
  const receipt = await mergeGithubPull(options);
  assert.equal(receipt.existingCheckCount, 1);
  assert.deepEqual(receipt.ciVerification.expectedCheckNames, ['original-ci']);
  assert.deepEqual(receipt.ciVerification.workflowFiles, ['.github/workflows/ci.yml']);
});
test('CI no-applicable evidence can cover present workflows filtered out for the reviewed event', async () => {
  const { options } = apiFixture(d => { d.checks = []; d.status.state = 'pending'; });
  Object.assign(options.reviewReceipt.ciApplicability, { status: 'not-applicable', expectedCheckNames: [],
    reason: 'Every exact-head workflow is dispatch-only for this isolated fixture; the reviewed pull event has no applicable job.' });
  const receipt = await mergeGithubPull(options);
  assert.equal(receipt.existingCheckCount, 0);
  assert.deepEqual(receipt.ciVerification.workflowFiles, ['.github/workflows/ci.yml']);
});
test('CI source inspection rejects symlinked, malformed or duplicate workflow entries', async () => {
  for (const mutate of [
    d => { d.workflowsTree.tree[0].mode = '120000'; },
    d => { d.workflowsTree.tree[0].sha = 'invalid'; },
    d => { d.workflowsTree.tree.push({ ...d.workflowsTree.tree[0] }); },
  ]) {
    const { options, calls } = apiFixture(mutate);
    await assert.rejects(mergeGithubPull(options), /workflow|tree/i);
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
});
