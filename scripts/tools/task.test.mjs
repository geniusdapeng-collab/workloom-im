import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTaskCompletion } from './task.mjs';
const id = 'T-2026-1005-1001'; const head = 'a'.repeat(40); const sha = 'b'.repeat(40);
const pull = { number: 1, title: `task [${id}]`, head: { sha: head }, is_merged: true, body: '' };
test('task close requires an exact corresponding real PR; arbitrary progress text is insufficient', async () => {
  await assert.rejects(verifyTaskCompletion('w/test', 1, id, { readPull: async () => pull, store: { read: async () => ({ tasks: {}, releases: {} }) } }), /receipt/);
  await assert.rejects(verifyTaskCompletion('w/test', 0, id, { readPull: async () => pull }), /exact/);
  await assert.rejects(verifyTaskCompletion('w/test', 1, 'T-2026-1005-9999', { readPull: async () => pull }), /another task/);
  await assert.rejects(verifyTaskCompletion('w/test', 1, id, { readPull: async () => ({ ...pull, is_merged: false }), store: { read: async () => ({ tasks: {}, releases: {} }) } }), /receipt/);
});
test('candidate integration cannot close a changed source or unverified declared release', async () => {
  const origin = { ...pull, is_merged: false }; let verified = 0;
  const mainSha = 'c'.repeat(40); const checkSha = 'd'.repeat(40);
  const task = { status: 'integrated', merge: { sha, sourceSha: head, mainSha, checkSha }, mergeSnapshot: { headSha: head, mainSha, checkSha }, intent: { taskId: id, releases: [] } }; const state = { tasks: { '1': task }, releases: {} };
  const services = { readPull: async () => origin, store: { read: async () => state }, platform: { verifyMerge: async () => { verified++; } } };
  assert.equal((await verifyTaskCompletion('w/test', 1, id, services)).integrated, true); assert.equal(verified, 1);
  task.merge.sourceSha = sha; await assert.rejects(verifyTaskCompletion('w/test', 1, id, services), /receipt/); task.merge.sourceSha = head;
  task.mergeSnapshot.mainSha = head; await assert.rejects(verifyTaskCompletion('w/test', 1, id, services), /receipt/); task.mergeSnapshot.mainSha = mainSha;
  const verifier = services.platform.verifyMerge; services.platform.verifyMerge = async () => { throw new Error('Merge parents differ'); };
  await assert.rejects(verifyTaskCompletion('w/test', 1, id, services), /parents/); services.platform.verifyMerge = verifier;
  task.intent.releases = [{ kind: 'desktop', version: 'v1.2.3' }]; await assert.rejects(verifyTaskCompletion('w/test', 1, id, services), /release/);
  state.releases.r = { number: 1, sha, kind: 'desktop', version: 'v1.2.3', status: 'delivered', receipt: { sha } }; assert.equal((await verifyTaskCompletion('w/test', 1, id, services)).releaseDeclared, true);
});
