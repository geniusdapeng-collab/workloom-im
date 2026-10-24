import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { splitForkContractAdvisories, validateChildInventory } from './ui-upgrade-pr.mjs';
import { loadRegistry, repository } from './repository-registry.mjs';

const inventory = JSON.parse(readFileSync(new URL('./child-repos.json', import.meta.url)));
const hotel = inventory.children.find(child => child.repo === 'workloom-ai/workloom-hotel');
const blockers = [
  { code: 'UI_CONSUMER_CONTRACT_FAILED', path: 'apps/web/src/pages/p2/P2.tsx', phase: 'phase-2', message: 'actual consumer contract failure' },
  { code: 'MANAGED_FILE_MODIFIED', path: 'apps/webb/src/main.tsx', phase: 'phase-2', message: 'unrelated managed entry changed' },
];
test('Hotel exact ownership exception retains its whole UI consumer contract as a hard blocker', () => {
  const result = splitForkContractAdvisories(hotel, blockers);
  assert.deepEqual(result.blockers, blockers); assert.deepEqual(result.advisories, []);
  assert.equal(hotel.strictUiConsumerContract, true);
});
test('pre-existing experimental/fork advisory behavior remains unchanged without strict opt-in', () => {
  for (const child of [{ lane: 'experiment' }, { tolerateExtensionSnapshotOverlap: true }]) {
    const result = splitForkContractAdvisories(child, blockers);
    assert.deepEqual(result.blockers, [blockers[1]]); assert.equal(result.advisories.length, 1);
    const strict = splitForkContractAdvisories({ ...child, strictUiConsumerContract: true }, blockers);
    assert.deepEqual(strict.blockers, blockers); assert.equal(strict.advisories.length, 0);
  }
  assert.deepEqual(splitForkContractAdvisories({}, blockers), { blockers, advisories: [] });
});
test('canonical inventory and address registry carry identical six exact owned paths and no required entry', () => {
  assert.equal(validateChildInventory(inventory.children, inventory.uiRolloutWaveOrder), true);
  assert.equal(hotel.industryExtensionPaths.length, 6);
  assert.ok(hotel.clientForkReason.length >= 20);
  assert.ok(hotel.industryExtensionPaths.every(path => path.startsWith('apps/web/') && !path.includes('*') && !path.endsWith('package.json') && !path.endsWith('src/main.tsx')));
  const registered = repository(loadRegistry(), 'workloom-hotel').baseSync;
  for (const key of ['industryExtensionPaths', 'clientForkReason', 'tolerateExtensionSnapshotOverlap', 'strictUiConsumerContract']) assert.deepEqual(registered[key], hotel[key]);
});
test('invalid strict contract declaration is rejected rather than silently reverting to advisories', () => {
  const invalid = structuredClone(inventory.children);
  invalid.find(child => child.repo === hotel.repo).strictUiConsumerContract = 'true';
  assert.throws(() => validateChildInventory(invalid, inventory.uiRolloutWaveOrder), /strictUiConsumerContract/);
});
