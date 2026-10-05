import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git-state.mjs';
import { randomUUID } from 'node:crypto';
import { runAccount, managedCheckout, withAccountLock } from './install-account.mjs';
import { appendEvent, emptyState, hash } from './queue-model.mjs';

const sourceRepo = 'workloom-ai/workloom-im'; const sha = 'a'.repeat(40); const token = randomUUID();
async function temporary(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-account-test-'))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function setup(repos) {
  const source = emptyState(sourceRepo); appendEvent(source, 'activated', { mainSha: sha });
  const state = emptyState('org/ready'); appendEvent(state, 'installation_prepared', { installer: 7 });
  const calls = [];
  const services = {
    platform: repo => ({ repo, main: async () => ({ commit: { sha } }) }),
    store: repo => ({ read: async () => repo === sourceRepo ? source : state }),
    readAssets: async (_root, exactSha) => { assert.equal(exactSha, sha); return { exactSha }; },
    discover: async () => repos,
    checkout: async ({ repo }) => { calls.push(`checkout:${repo}`); return `/owned/${repo}`; },
    prepare: async ({ repo, sourceSha, assets }) => { assert.equal(sourceSha, sha); assert.equal(assets.exactSha, sha); calls.push(`prepare:${repo}`); return { repo, status: 'waiting_checks', number: 7 }; },
    finish: async ({ repo, number }) => { assert.equal(number, 7); calls.push(`finish:${repo}`); return { repo, status: 'active', mainSha: sha, number }; },
  };
  return { source, state, calls, services };
}

test('complete account scan bounds concurrent installations, isolates errors and preserves frozen and missing-main repos', async t => {
  const directory = await temporary(t);
  const repos = [sourceRepo, 'org/good-1', 'org/bad', 'org/good-2', 'org/frozen', 'org/empty'].map(repo => ({ repo, frozen: repo.endsWith('/frozen') }));
  const data = setup(repos); let active = 0; let maximum = 0;
  data.services.platform = repo => ({ repo, main: async () => ({ commit: { sha: repo === 'org/empty' ? null : sha } }) });
  const prepare = data.services.prepare;
  data.services.prepare = async options => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--;
    if (options.repo === 'org/bad') throw new Error(`permission denied ${token}`);
    return prepare(options);
  };
  const report = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(maximum, 2); assert.equal(report.results.length, 6); assert.equal(report.active, 3); assert.equal(report.pending, 3);
  assert.equal(report.results.find(result => result.repo === 'org/frozen').status, 'frozen');
  assert.equal(report.results.find(result => result.repo === 'org/empty').status, 'pending_main');
  const failure = report.results.find(result => result.repo === 'org/bad'); assert.equal(failure.status, 'failed'); assert.ok(!failure.error.includes(token));
  assert.ok(data.calls.includes('finish:org/good-2')); assert.ok(!data.calls.some(call => call.includes('org/frozen') || call.includes('org/empty')));
});
test('repeat discovery audits active repos and installs a newly owned project in a later run', async t => {
  const directory = await temporary(t); const repos = [{ repo: sourceRepo }, { repo: 'org/old' }]; const data = setup(repos);
  const prepare = data.services.prepare;
  data.services.prepare = async options => options.repo === 'org/old' ? { repo: options.repo, status: 'active', mainSha: sha } : prepare(options);
  const first = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(first.active, 2); assert.equal(data.calls.filter(call => call.startsWith('finish:')).length, 0);
  repos.push({ repo: 'org/new' });
  const second = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(second.active, 3); assert.ok(data.calls.includes('finish:org/new'));
});
test('post-merge prepared repository recovers its exact installer instead of being reported as active', async t => {
  const directory = await temporary(t); const data = setup([{ repo: sourceRepo }, { repo: 'org/ready' }]);
  data.services.prepare = async ({ repo }) => ({ repo, status: 'prepared' });
  data.services.finish = async ({ repo, number }) => { assert.equal(number, 7); return { repo, status: 'waiting_checks', number, reasons: ['Actual review still pending'] }; };
  const report = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(report.active, 1); assert.equal(report.pending, 1); assert.equal(report.results.find(item => item.repo === 'org/ready').status, 'waiting_checks');
});
test('source activation, exact main identity and concurrency are verified before any account writes', async t => {
  const directory = await temporary(t); const data = setup([{ repo: 'org/ready' }]);
  const options = { token, sourceRoot: directory, directory, services: data.services, notify: () => {} };
  await assert.rejects(runAccount({ ...options, sourceSha: 'b'.repeat(40) }), /current verified/);
  for (const concurrency of [0, 4, 1.5]) await assert.rejects(runAccount({ ...options, concurrency }), /concurrency/);
  data.source.events = []; await assert.rejects(runAccount(options), /activation receipt/);
  assert.deepEqual(data.calls, []);
});
test('main advances during account installation are reported without pretending the old package is newest', async t => {
  const directory = await temporary(t); const data = setup([]); let reads = 0;
  data.services.platform = repo => ({ repo, main: async () => ({ commit: { sha: ++reads === 1 ? sha : 'b'.repeat(40) } }) });
  const report = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(report.sourceSha, sha); assert.equal(report.sourceAdvancedTo, 'b'.repeat(40));
});
test('a final source read failure preserves completed repository receipts and redacts its error', async t => {
  const directory = await temporary(t); const data = setup([{ repo: sourceRepo }, { repo: 'org/ready' }]); let reads = 0;
  data.services.platform = repo => ({ repo, main: async () => {
    if (repo === sourceRepo && ++reads > 1) throw new Error(`source unavailable ${token}`);
    return { commit: { sha } };
  } });
  const report = await runAccount({ token, sourceRoot: directory, directory, services: data.services, notify: () => {} });
  assert.equal(report.active, 2); assert.equal(report.results.find(item => item.repo === 'org/ready').status, 'active');
  assert.match(report.sourceVerificationError, /source unavailable/); assert.ok(!report.sourceVerificationError.includes(token));
});
test('live installer claims exclude another run; an exception removes only the current claim', async t => {
  const directory = await temporary(t); let executed = 0;
  const result = await withAccountLock(directory, async () => {
    const second = await withAccountLock(directory, async () => { executed++; });
    assert.equal(second.status, 'busy'); return 'first';
  });
  assert.equal(result, 'first'); assert.equal(executed, 0); assert.deepEqual(await readdir(directory), []);
  await assert.rejects(withAccountLock(directory, async () => { throw new Error('interrupted'); }), /interrupted/);
  assert.deepEqual(await readdir(directory), []);
});
test('dead unique installer claims are reclaimed and a live claim is never removed, including simultaneous starts', async t => {
  const directory = await temporary(t); const stale = `.account-installer-lock-99999999-${randomUUID()}.json`;
  await writeFile(join(directory, stale), '{}');
  assert.equal(await withAccountLock(directory, async () => 'recovered'), 'recovered'); assert.deepEqual(await readdir(directory), []);
  let active = 0; let maximum = 0;
  const results = await Promise.all(Array.from({ length: 8 }, () => withAccountLock(directory, async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return 'owned'; })));
  assert.ok(maximum <= 1); assert.ok(results.some(result => result?.status === 'busy')); assert.deepEqual(await readdir(directory), []);
});
test('checkout and account directory symlinks, unowned clones and unknown remotes are preserved', async t => {
  const directory = await temporary(t); const outside = await temporary(t); const linked = join(directory, 'linked'); await symlink(outside, linked);
  await assert.rejects(withAccountLock(linked, async () => {}), /symlink/);
  const repo = 'org/project'; const target = join(directory, `project-${hash(repo).slice(0, 16)}`);
  const { mkdir } = await import('node:fs/promises'); await mkdir(target); await writeFile(join(target, 'owner.json'), '{"owner":"another task"}');
  await assert.rejects(managedCheckout({ repo, token, directory }), /ownership/);
  assert.equal(await readFile(join(target, 'owner.json'), 'utf8'), '{"owner":"another task"}');
  const remote = `https://cnb.cool/${repo}.git`;
  await writeFile(join(target, 'owner.json'), JSON.stringify({ owner: 'workloom-delivery-account/v1', repo, remote }));
  const root = join(target, 'repo'); await mkdir(root); await git(['init', '--quiet'], { cwd: root });
  await git(['remote', 'add', 'origin', 'https://example.invalid/unrelated.git'], { cwd: root });
  await assert.rejects(managedCheckout({ repo, token, directory }), /remote differs/);
  assert.equal(await git(['config', '--get', 'remote.origin.url'], { cwd: root }), 'https://example.invalid/unrelated.git');
});
