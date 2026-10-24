import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveUiReleaseArtifact } from './set-ui-version.mjs';
import { bindUiLockfileIntegrity, canonicalUiArtifact, uiStateLockContractErrors } from './ui-lockfile-integrity.mjs';
import { uiLockfileIntegrityErrors } from '../scripts/verify-ui-consumer.mjs';

const version = '0.1.19';
const integrity = 'sha512-kplOLAtovega6BLpBwtFM1DfBS3q4ZjLp9yA942o+v9QlbREm/VsYNK/Jz7f/9ytDWSFXCvmh10C3ZHrPHkcSA==';
const clients = ['apps/web/package.json', 'apps/webb/package.json', 'apps/webc/package.json'];
function state(platform, source = 'workloom-ai/workloom-im') {
  const artifact = canonicalUiArtifact(version, platform);
  return { schemaVersion: 'workloom.ui-consumer-state/v1', package: '@workloom/ui', version,
    contractVersion: '2.0.0', source, releaseChannel: 'stable', updatePolicy: 'upgrade-pr-only',
    requiredClientPackages: clients, connectedClientPackages: clients,
    artifact: { type: artifact.type, platform, assetName: artifact.assetName, url: artifact.url, sha512: integrity } };
}
function lock(state, sri = integrity) {
  const url = state.artifact.url;
  return ["lockfileVersion: '9.0'", 'overrides:', `  '@workloom/ui@${version}': ${url}`, 'importers:',
    ...clients.flatMap(path => [`  ${path.replace('/package.json', '')}:`, '    dependencies:', "      '@workloom/ui':", `        specifier: ${url}`, `        version: ${url}`]),
    'packages:', `  '@workloom/ui@${url}':`, `    resolution: {${sri ? `integrity: ${sri}, ` : ''}tarball: ${url}}`, `    version: ${version}`, 'snapshots:', `  '@workloom/ui@${url}': {}`, ''].join('\n');
}
function fixture(consumer, sri) {
  const root = mkdtempSync(join(tmpdir(), 'workloom-ui-host-'));
  writeFileSync(join(root, '.workloom-ui.json'), JSON.stringify(consumer));
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock(consumer, sri));
  return root;
}
test('GitHub is the canonical default URL while legacy transport stays explicit', () => {
  assert.equal(canonicalUiArtifact(version).url, 'https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v0.1.19/workloom-ui-0.1.19.tgz');
  for (const platform of ['github', 'cnb']) assert.deepEqual(uiStateLockContractErrors(state(platform)), []);
  const legacy = state('cnb'); delete legacy.artifact.platform;
  assert.deepEqual(uiStateLockContractErrors(legacy), []);
  const ambiguous = state('github'); delete ambiguous.artifact.platform;
  assert.ok(uiStateLockContractErrors(ambiguous).some(e => e.includes('artifact.url')));
});
test('same measured SRI is required for a registered GitHub mirror', () => {
  const manifest = { baseRepository: 'workloom-ai/workloom-im', ui: { package: '@workloom/ui', distribution: {
    type: 'github-release-tarball', platform: 'github', assetNameTemplate: 'workloom-ui-{version}.tgz',
    urlTemplate: 'https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v{version}/workloom-ui-{version}.tgz', integrityByVersion: { [version]: integrity },
  } } };
  const artifact = resolveUiReleaseArtifact(manifest, version);
  assert.equal(artifact.platform, 'github'); assert.equal(artifact.sha512, integrity);
  for (const url of ['https://github.com/attacker/workloom-im/releases/download/ui-v{version}/workloom-ui-{version}.tgz', 'https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v{version}/workloom-ui-{version}.tgz']) {
    const bad = structuredClone(manifest); bad.ui.distribution.urlTemplate = url;
    assert.throws(() => resolveUiReleaseArtifact(bad, version), /urlTemplate/);
  }
});
test('GitHub lock bind and installed YAML verifier agree and preserve existing integrity', () => {
  for (const platform of ['github', 'cnb']) {
    const consumer = state(platform); const root = fixture(consumer, '');
    try {
      assert.equal(bindUiLockfileIntegrity(root).changed, true);
      assert.deepEqual(uiLockfileIntegrityErrors(root, consumer), []);
      assert.equal(bindUiLockfileIntegrity(root).changed, false);
      assert.ok(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').includes(integrity));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('wrong SRI, mixed URL, credentials, foreign source and invalid host declaration fail closed', () => {
  for (const mutation of [
    s => { s.artifact.platform = 'other'; },
    s => { s.source = 'attacker/workloom-im'; },
    s => { s.artifact.url = s.artifact.url.replace('https://', 'https://user:fake@'); },
    s => { s.artifact.url = s.artifact.url.replace('ui-v0.1.19', 'ui-v0.1.20'); },
    s => { s.artifact.url = s.artifact.url.replace('geniusdapeng-collab', 'someone'); },
  ]) {
    const consumer = state('github'); mutation(consumer);
    assert.ok(uiStateLockContractErrors(consumer).length > 0);
    assert.ok(uiLockfileIntegrityErrors('.', consumer).length > 0);
  }
  const consumer = state('github'); const wrong = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const root = fixture(consumer, wrong);
  try {
    const before = readFileSync(join(root, 'pnpm-lock.yaml'));
    assert.throws(() => bindUiLockfileIntegrity(root), /integrity/);
    assert.ok(before.equals(readFileSync(join(root, 'pnpm-lock.yaml'))));
    assert.ok(uiLockfileIntegrityErrors(root, consumer).some(e => e.includes('integrity')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
