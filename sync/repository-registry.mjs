import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LANES = new Set(['base', 'industry', 'operations-hub', 'experiment', 'isolated', 'config-only-discovered']);
export const REGISTRY_PATH = fileURLToPath(new URL('./repository-registry.json', import.meta.url));

export function validateRegistry(doc) {
  if (doc?.schemaVersion !== 'workloom.repository-registry/v1' || doc.primaryPlatform !== 'github') throw new Error('Invalid repository registry schema or primary platform');
  if (doc.mirrorPolicy?.platform !== 'cnb' || doc.mirrorPolicy.mode !== 'deferred' || doc.mirrorPolicy.automaticProductSync !== false) throw new Error('CNB must remain a deferred mirror');
  if (!Array.isArray(doc.repositories) || !doc.repositories.length) throw new Error('Repository registry is empty');
  const ids = new Set();
  const addresses = new Set();
  for (const entry of doc.repositories) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.logicalId) || ids.has(entry.logicalId) || !LANES.has(entry.lane) || !entry.productId) throw new Error(`Invalid or duplicate repository identity: ${entry.logicalId}`);
    ids.add(entry.logicalId);
    for (const [platform, host] of [['github', 'github.com'], ['cnb', 'cnb.cool']]) {
      const address = entry[platform];
      if (!address && platform === 'cnb') continue;
      if (!address || !SLUG.test(address.repository) || address.branch !== 'main' || address.url !== `https://${host}/${address.repository}`) throw new Error(`Invalid ${platform} address for ${entry.logicalId}`);
      if (addresses.has(address.url.toLowerCase())) throw new Error(`Duplicate repository address: ${address.url}`);
      addresses.add(address.url.toLowerCase());
    }
    if (!['subscribed', 'none'].includes(entry.baseSync?.receive)) throw new Error(`Invalid base sync policy: ${entry.logicalId}`);
    const prefix = entry.baseSync.pathPrefix ?? '';
    if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').includes('..')) throw new Error(`Unsafe product path prefix: ${entry.logicalId}`);
    if (entry.baseSync.extraExclude !== undefined && (!Array.isArray(entry.baseSync.extraExclude) || entry.baseSync.extraExclude.some(path => typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')))) throw new Error(`Unsafe product exclusions: ${entry.logicalId}`);
    if (entry.baseSync.strictUiConsumerContract !== undefined && typeof entry.baseSync.strictUiConsumerContract !== 'boolean') throw new Error(`Invalid strictUiConsumerContract declaration: ${entry.logicalId}`);
    if (entry.baseSync.tolerateExtensionSnapshotOverlap === true && entry.lane !== 'experiment') {
      const reason = entry.baseSync.clientForkReason ?? entry.baseSync.rolloutResumeNote;
      if (typeof reason !== 'string' || reason.length < 20 || !entry.baseSync.industryExtensionPaths?.length || entry.baseSync.uiRolloutWave === 'paused') throw new Error(`Incomplete product client ownership declaration: ${entry.logicalId}`);
    }
    if (['isolated', 'config-only-discovered'].includes(entry.lane) && entry.baseSync.receive !== 'none') throw new Error(`Frozen/config-only repository cannot receive base fanout: ${entry.logicalId}`);
    if (['experiment', 'isolated', 'config-only-discovered'].includes(entry.lane) && entry.baseSync.reflux !== 'none') throw new Error(`Experimental semantics cannot flow back: ${entry.logicalId}`);
  }
  if (!ids.has(doc.baseLogicalId) || doc.repositories.find(e => e.logicalId === doc.baseLogicalId).lane !== 'base') throw new Error('Registry base identity is missing');
  return doc;
}

export function loadRegistry(path = REGISTRY_PATH) { return validateRegistry(JSON.parse(readFileSync(path, 'utf8'))); }
export function repository(doc, identity) {
  if (typeof identity !== 'string' || !identity) throw new Error('A repository identity is required');
  const entry = doc.repositories.find(e => e.logicalId === identity || e.github.repository === identity || e.cnb?.repository === identity);
  if (!entry) throw new Error(`Repository is not registered: ${identity}`);
  return entry;
}
export function addressFor(doc, identity, platform = doc.primaryPlatform) {
  if (!['github', 'cnb'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const entry = repository(doc, identity);
  if (!entry[platform]) throw new Error(`No ${platform} mapping for ${entry.logicalId}`);
  return entry[platform];
}
export function repositoryFromRemote(doc, remote) {
  if (typeof remote !== 'string' || !remote.trim()) return null;
  const value = remote.trim();
  if (/[\0\r\n]/.test(value)) throw new Error('Invalid repository remote');
  let host; let slug;
  const scp = /^git@(github\.com|cnb\.cool):(.+)$/.exec(value);
  if (scp) { host = scp[1]; slug = scp[2]; }
  else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['github.com', 'cnb.cool'].includes(url.hostname)) return null;
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.search || url.hash || (url.port && !(url.protocol === 'ssh:' && url.port === '22'))) throw new Error('Repository remote must use a credential-free canonical host');
    host = url.hostname; slug = url.pathname.replace(/^\//, '');
  }
  slug = slug.replace(/\.git$/, '');
  if (!SLUG.test(slug)) throw new Error('Invalid registered repository path');
  return doc.repositories.find(entry => [entry.github, entry.cnb].some(address => address && address.url.toLowerCase() === `https://${host}/${slug}`.toLowerCase())) ?? null;
}
export function fanoutTargets(doc, { mode = 'repository-config', only } = {}) {
  if (!['repository-config', 'required-only', 'full'].includes(mode)) throw new Error(`Unsupported fanout mode: ${mode}`);
  const targets = only ? [repository(doc, only)] : doc.repositories;
  if (mode === 'repository-config') return targets;
  if (only && targets.some(e => e.baseSync.receive !== 'subscribed')) throw new Error(`Product fanout is forbidden for ${only}`);
  return targets.filter(e => e.baseSync.receive === 'subscribed' && (mode !== 'full' || only || e.baseSync.uiRolloutWave !== 'paused'));
}
export function repositoryConfiguration(doc, identity) {
  const entry = repository(doc, identity);
  return {
    schemaVersion: 'workloom.repository/v1', logicalId: entry.logicalId, productId: entry.productId,
    lane: entry.lane, primaryPlatform: 'github', github: entry.github, cnb: entry.cnb,
    mirrorPolicy: doc.mirrorPolicy, baseSync: entry.baseSync,
    registry: { repository: addressFor(doc, doc.baseLogicalId).repository, path: 'sync/repository-registry.json' },
  };
}
export function deliveryConfiguration() {
  return {
    schemaVersion: 'workloom.delivery/v1', platform: 'github', branch: 'main',
    workflow: 'codex-review-and-existing-checks', mergeMethod: 'merge',
    requireExactHead: true, requireMainIntegrationReceipt: true, preserveExistingChecks: true,
    review: { actor: 'codex', bindHeadAndBase: true, requirePassedTests: true },
    mirror: { platform: 'cnb', mode: 'deferred', blocksGithubDelivery: false, automaticProductSync: false },
  };
}
