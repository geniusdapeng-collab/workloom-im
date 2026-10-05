import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './cnb-api.mjs';
import * as provision from './provision-protocol.mjs';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { GitStateStore, git } from '../delivery/git-state.mjs';
import { prepareInstallation } from '../delivery/queue-runner.mjs';
import { injectDeliveryConfig } from '../delivery/install-config.mjs';
import { deliveryRolloutReady } from '../../sync/fanout-cnb.mjs';
import { resolvePipelineConfig } from '../delivery/queue-policy.mjs';

test('bare fleet-scan container installs the locked parser before provisioning', async () => {
  const root = new URL('../../', import.meta.url);
  const config = await resolvePipelineConfig(await readFile(new URL('.cnb.yml', root), 'utf8'), {
    readLocal: path => readFile(new URL(path, root), 'utf8'),
  });
  const scan = config.$['crontab: 0 9 * * *'].find(p => p.name === 'fleet-scan');
  assert.ok(scan);
  const provisionIndex = scan.stages.findIndex(s => s.script?.includes('fleet-scan.mjs --org'));
  const installIndex = scan.stages.findIndex(s => /npm ci --prefix scripts\/delivery\/runtime --ignore-scripts --no-audit --no-fund/.test(s.script ?? ''));
  assert.ok(installIndex >= 0 && installIndex < provisionIndex);
  assert.equal(scan.stages[installIndex].allowFailure, undefined);
  assert.match(scan.stages[installIndex].script, /set -eu/);
});

test('new branch policy requires review and removes admin push/force/deletion exceptions', () => {
  const p = api.branchProtectionPayload();
  assert.equal(p.required_pull_request_reviews, true);
  assert.equal(p.required_master_approve, false);
  assert.equal(p.forbid_approve_pull_created_by_own_npc, true);
  assert.equal(p.allow_master_pushes, false);
  assert.equal(p.allow_master_force_pushes, false);
  assert.equal(p.allow_master_deletions, false);
});
test('a named main rule is insufficient: weak controls fail closed', () => {
  assert.equal(typeof api.validateBranchProtection, 'function');
  assert.ok(api.validateBranchProtection({ rule: 'main' }).length > 0);
  assert.deepEqual(api.validateBranchProtection(api.branchProtectionPayload()), []);
  assert.ok(api.validateBranchProtection({ ...api.branchProtectionPayload(), allow_master_force_pushes: true }).length > 0);
  assert.ok(api.validateBranchProtection({ ...api.branchProtectionPayload(), forbid_approve_pull_created_by_own_npc: false }).length > 0);
});
test('git credentials are transient process environment, scoped to CNB, without command-line credentials', () => {
  assert.equal(typeof provision.gitAuthenticationEnvironment, 'function');
  const secret = ['transient', 'test', 'value'].join('-');
  const env = provision.gitAuthenticationEnvironment(secret, { PATH: '/test', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'test.setting', GIT_CONFIG_VALUE_0: 'retained' });
  assert.equal(env.GIT_CONFIG_KEY_0, 'test.setting');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://cnb.cool/.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_2, 'Authorization: Basic ' + Buffer.from('cnb:' + secret).toString('base64'));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

function stubFetch(t, handler) {
  const before = globalThis.fetch; const previous = process.env.CNB_TOKEN;
  process.env.CNB_TOKEN = 'fixture-transient-cnb-token'; globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = before; if (previous === undefined) delete process.env.CNB_TOKEN; else process.env.CNB_TOKEN = previous; });
}
test('invalid repository names fail before every external call or mutation', async t => {
  let calls = 0; stubFetch(t, async () => { calls += 1; throw new Error('unexpected request'); });
  await assert.rejects(provision.provisionProtocol('workloom-ai/../../escape'), /slug/);
  assert.equal(calls, 0);
});
test('missing isolation registry prevents provisioning, with no platform mutation', async t => {
  const methods = []; stubFetch(t, async (_url, options) => { methods.push(options.method ?? 'GET'); return new Response('', { status: 404 }); });
  await assert.rejects(provision.provisionProtocol('workloom-ai/demo'), /隔离仓登记表/);
  assert.deepEqual(methods, ['GET']);
});
test('weak existing main protection blocks; a weak creation readback also blocks', async t => {
  stubFetch(t, async () => Response.json([{ rule: 'main' }]));
  await assert.rejects(provision.ensureBranchProtection('workloom-ai/demo', { log: () => {} }), /保护不足/);
  let stage = 0; globalThis.fetch = async (_url, options) => {
    stage += 1;
    return Response.json((options.method ?? 'GET') === 'POST' ? {} : stage === 1 ? [] : [{ rule: 'main' }]);
  };
  await assert.rejects(provision.ensureBranchProtection('workloom-ai/demo', { log: () => {} }), /回读/);
});
test('unreadable, unsupported or invalid product CI fails before label and protection mutations', async t => {
  let ci = ''; const methods = [];
  stubFetch(t, async (url, options) => {
    methods.push(options.method ?? 'GET');
    return new Response(String(url).endsWith('sync/child-repos.json') ? JSON.stringify({ children: [], isolatedRepos: [] }) : ci, { status: 200 });
  });
  for (const source of ['', 'arbitrary: data\n', 'main:\n  push:\n    - *missing\n']) {
    ci = source; await assert.rejects(provision.provisionProtocol('workloom-ai/demo', { log: () => {} }), /cnb|结构|预检/i);
  }
  assert.ok(methods.length > 0); assert.equal(methods.every(method => method === 'GET'), true);
});
test('Git/API errors redact raw and Basic credentials; cross-host API calls and force merge fail before fetch', async t => {
  const token = ['transient', 'boundary', 'token'].join('-');
  const encoded = Buffer.from(`cnb:${token}`).toString('base64');
  const redacted = api.redactCredentials(`failure ${token} ${encoded}`, token);
  assert.equal(redacted.includes(token), false); assert.equal(redacted.includes(encoded), false);
  let calls = 0; stubFetch(t, async () => { calls += 1; return new Response('bad', { status: 400 }); });
  await assert.rejects(api.api('workloom-ai/demo', 'https://example.com/', { token }), /其他来源/);
  assert.throws(() => api.mergePull('workloom-ai/demo', 1, { commitTitle: 'test', force: true }), /强制合并/);
  assert.equal(calls, 0);
});
test('unknown CI shape cannot be provisioned as a green protocol gate', () => {
  assert.equal(provision.injectGate('arbitrary: data\n').mode, 'unsupported');
  assert.ok(api.validateBranchProtection({ ...api.branchProtectionPayload(), rule: 'other' }).length > 0);
});
test('raw asset reads are bounded, never follow redirects and distinguish known absence from unreadable source', async t => {
  const calls = []; let status = 200;
  stubFetch(t, async (_url, options) => { calls.push(options); return new Response(status === 200 ? 'exact source bytes' : 'unreadable', { status }); });
  assert.equal(await api.rawFile('workloom-ai/demo', 'main', '.cnb.yml'), 'exact source bytes');
  assert.equal(calls[0].redirect, 'error'); assert.ok(calls[0].signal instanceof AbortSignal); assert.equal(calls[0].signal.aborted, false);
  status = 404; assert.equal(await api.rawFile('workloom-ai/demo', 'main', '.cnb.yml'), null);
  for (const code of [301, 403, 429, 500]) {
    status = code; await assert.rejects(api.rawFile('workloom-ai/demo', 'main', '.cnb.yml'), error => error.status === code);
  }
  globalThis.fetch = async () => { throw new Error('network interrupted'); };
  await assert.rejects(api.rawFile('workloom-ai/demo', 'main', '.cnb.yml'), /network interrupted/);
});
test('first-install execution closure is delivered before a ledger exists, then exact preparation enables fanout without claiming activation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-onboarding-order-')); t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'repo'); const remote = join(root, 'state.git'); await mkdir(checkout); await git(['init', '--bare', '--quiet', remote]);
  const repo = 'workloom-ai/first-install'; const store = new GitStateStore({ repo, remote });
  const absent = async () => { throw Object.assign(new Error('ledger absent'), { status: 404 }); };
  assert.equal((await deliveryRolloutReady(repo, absent)).ready, false);
  const original = 'main:\n  push:\n    - name: product\n      stages: [{name: product-check, script: product-check}]\n"**":\n  pull_request:\n    - name: product\n      stages: [{name: product-check, script: product-check}]\n';
  await writeFile(join(checkout, '.cnb.yml'), original); await git(['init', '--quiet'], { cwd: checkout }); await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'initial main'], { cwd: checkout });
  const mainSha = await git(['rev-parse', 'HEAD'], { cwd: checkout });
  for (const path of provision.PROTOCOL_ASSETS) { const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'); assert.ok(content.trim(), path); await mkdir(dirname(join(checkout, path)), { recursive: true }); await writeFile(join(checkout, path), content); }
  for (const path of ['runtime/package.json', 'runtime/package-lock.json', 'cnb.yml', 'bootstrap-cnb.yml', 'queue-runner.mjs']) assert.ok((await readFile(join(checkout, 'scripts/delivery', path), 'utf8')).trim());
  assert.equal((await store.read()).revision, 0); // Assets already exist although fanout is still unavailable.
  await writeFile(join(checkout, '.cnb.yml'), (await injectDeliveryConfig(provision.injectGate(original).content, { bootstrap: true })).content);
  await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'complete first installation'], { cwd: checkout });
  const headSha = await git(['rev-parse', 'HEAD'], { cwd: checkout }); let rules = [];
  const platform = { repo, main: async () => ({ commit: { sha: mainSha } }), protections: async () => rules, call: async (_path, options) => { rules = [{ ...options.body, id: 'prepared-state' }]; return {}; } };
  await prepareInstallation({ platform, store, root: checkout, installer: { number: 1, state: 'open', is_wip: false, head: { sha: headSha }, base: { ref: 'main', sha: mainSha } } });
  const state = await store.read(); assert.ok(state.events.some(event => event.kind === 'installation_prepared' && event.data.headSha === headSha && event.data.mainSha === mainSha));
  assert.equal((await deliveryRolloutReady(repo, async () => state)).ready, true);
  assert.equal(state.events.some(event => event.kind === 'activated'), false);
});
