import test from 'node:test';
import assert from 'node:assert/strict';
import { targetsFor, dispatchRepository } from './merge-sync-prs.mjs';
const fleet = { baseRepo: 'w/base', children: [{ repo: 'w/hotel' }], isolatedRepos: [{ repo: 'w/isolated' }] };
test('fleet dispatch never enters isolated or unsubscribed repositories', () => {
  assert.deepEqual(targetsFor(fleet), ['w/base', 'w/hotel']);
  assert.deepEqual(targetsFor(fleet, { only: ['w/hotel'] }), ['w/hotel']);
  for (const repo of ['w/isolated', 'w/foreign']) assert.throws(() => targetsFor(fleet, { repo }), /subscribed/);
  for (const only of [['w/base'], ['w/hotel']]) assert.throws(() => targetsFor(fleet, { repo: 'w/base', only }), /cannot be combined/);
});
test('old entry point dispatches trusted main and has no direct merge operation', async () => {
  const calls = []; const platform = { repo: 'w/hotel', main: async () => ({ commit: { sha: 'a'.repeat(40) } }), call: async (path, options) => { calls.push({ path, options }); return options ? { success: true, sn: 'build-1' } : 'include: [scripts/delivery/cnb.yml]'; } };
  assert.equal((await dispatchRepository(platform)).status, 'dispatched');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal(calls.at(-1).options.body.event, 'api_trigger_delivery_reconcile');
  assert.equal(calls.some(call => /pulls.*merge/.test(call.path)), false);
});
test('dry-run and absent installation cannot issue writes; missing build ack remains failed', async () => {
  let writes = 0; let installed = false;
  const platform = { repo: 'w/hotel', main: async () => ({ commit: { sha: 'a'.repeat(40) } }), call: async (_path, options) => options ? (++writes, {}) : installed ? 'scripts/delivery/cnb.yml' : 'old CI' };
  await assert.rejects(dispatchRepository(platform), /not installed/);
  await assert.rejects(dispatchRepository(platform, { dryRun: true }), /not installed/);
  installed = true; assert.equal((await dispatchRepository(platform, { dryRun: true })).status, 'would_dispatch');
  assert.equal(writes, 0);
  await assert.rejects(dispatchRepository(platform), /acknowledgement/);
  assert.equal(writes, 1);
});
