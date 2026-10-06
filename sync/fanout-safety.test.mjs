import test from 'node:test';
import assert from 'node:assert/strict';
import { main, redactFanout, deliveryRolloutReady } from './fanout-cnb.mjs';
import { gitAuthenticationEnvironment } from '../scripts/tools/cnb-api.mjs';
import * as provision from '../scripts/tools/provision-protocol.mjs';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { GitStateStore, git } from '../scripts/delivery/git-state.mjs';
import { prepareInstallation } from '../scripts/delivery/queue-runner.mjs';
import { applyInstallation, CORE_ASSETS, DELIVERY_DOC, REGRESSION_CNB, installationPlan } from '../scripts/delivery/install-assets.mjs';

test('fanout rejects a foreign, insecure or credential-bearing origin before requesting credentials', async () => {
  const beforeArgv = process.argv;
  const beforeToken = process.env.CNB_TOKEN;
  try {
    delete process.env.CNB_TOKEN;
    for (const url of ['https://foreign.example', 'http://cnb.cool', 'https://person:fixture@cnb.cool', 'https://cnb.cool/other', 'https://cnb.cool?redirect=other']) {
      process.argv = [process.execPath, 'fanout-cnb.mjs', '--base-url', url];
      await assert.rejects(main(), /base-url.*https:\/\/cnb\.cool/u);
    }
  } finally {
    process.argv = beforeArgv;
    if (beforeToken === undefined) delete process.env.CNB_TOKEN; else process.env.CNB_TOKEN = beforeToken;
  }
});

test('fanout error logs remove the actual Basic credential as well as the original token', () => {
  const token = 'test-only-fanout-private-fixture';
  const header = Buffer.from('cnb:' + token).toString('base64');
  const encodedToken = encodeURIComponent(token);
  const result = redactFanout(`${token} ${encodedToken} Authorization: Basic ${header}`, token);
  assert.equal(result.includes(token), false);
  assert.equal(result.includes(header), false);
});

test('CNB Git authentication is scoped to the canonical HTTPS origin and disables persistent helpers', () => {
  const env = gitAuthenticationEnvironment('fanout-private-fixture', {});
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://cnb.cool/.extraHeader');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(Object.values(env).includes('http.extraHeader'), false);
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
  for (const path of provision.PROTOCOL_ASSETS) { const content = await readFile(new URL(`../${path}`, import.meta.url), 'utf8'); assert.ok(content.trim(), path); await mkdir(dirname(join(checkout, path)), { recursive: true }); await writeFile(join(checkout, path), content); }
  for (const path of ['runtime/package.json', 'runtime/package-lock.json', 'cnb.yml', 'bootstrap-cnb.yml', 'queue-runner.mjs']) assert.ok((await readFile(join(checkout, 'scripts/delivery', path), 'utf8')).trim());
  assert.equal((await store.read()).revision, 0); // Assets already exist although fanout is still unavailable.
  await writeFile(join(checkout, '.cnb.yml'), provision.injectGate(original).content);
  const assets = Object.fromEntries(await Promise.all(CORE_ASSETS.map(async path => [path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')])));
  assets['docs/AUTOMATIC-RD-DELIVERY.md'] = DELIVERY_DOC; assets['scripts/delivery/install-cnb.yml'] = REGRESSION_CNB;
  await applyInstallation(await installationPlan({ root: checkout, repo, sourceRepo: 'workloom-ai/workloom-im', sourceSha: mainSha, assets }), checkout);
  await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'complete first installation'], { cwd: checkout });
  const headSha = await git(['rev-parse', 'HEAD'], { cwd: checkout }); let rules = [];
  const platform = { repo, main: async () => ({ commit: { sha: mainSha } }), protections: async () => rules, call: async (_path, options) => { rules = [{ ...options.body, id: 'prepared-state' }]; return {}; } };
  await prepareInstallation({ platform, store, root: checkout, installer: { number: 1, state: 'open', is_wip: false, head: { sha: headSha }, base: { ref: 'main', sha: mainSha } } });
  const state = await store.read(); assert.ok(state.events.some(event => event.kind === 'installation_prepared' && event.data.headSha === headSha && event.data.mainSha === mainSha));
  assert.equal((await deliveryRolloutReady(repo, async () => state)).ready, true);
  assert.equal(state.events.some(event => event.kind === 'activated'), false);
});
