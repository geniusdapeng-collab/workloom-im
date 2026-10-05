import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRelease } from './cnb-release-publish.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parser } from './delivery/queue-policy.mjs';
const sha = 'a'.repeat(40); const repo = 'workloom-ai/test'; const tag = 'v1.2.3';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'delivery-release-publish-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'WorkLoom-test.exe'); await writeFile(file, 'actual bytes'); return { root, file, bytes: Buffer.from('actual bytes') }; }
test('standalone publisher CLI rejects missing explicit SHA before Git or release APIs, even with a branch SHA', async t => {
  const f = await fixture(t); const env = { ...process.env, CNB_BRANCH_SHA: sha, CNB_TOKEN: randomUUID() }; delete env.RELEASE_EXPECTED_SHA;
  const script = fileURLToPath(new URL('./cnb-release-publish.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--tag', tag, '--create', f.file], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /requires explicit RELEASE_EXPECTED_SHA/);
  assert.doesNotMatch(result.stderr, /not a git repository|CNB \d{3}/);
});
test('actual finalize manifest code requires the same explicit frozen SHA and never stamps current branch identity', async t => {
  const f = await fixture(t); const YAML = await parser(); const config = YAML.parse(await readFile(new URL('../.cnb.yml', import.meta.url), 'utf8'), { maxAliasCount: 1000 });
  const stage = config['.desktop-release-finalize'].stages.find(stage => stage.script?.includes('WorkLoom-release-manifest.json'));
  const code = /node -e '([\s\S]*?)'\n/.exec(stage.script)?.[1]; assert.ok(code);
  const names = ['WorkLoom-mac-arm64.dmg', 'WorkLoom-mac-x64.dmg', 'WorkLoom-win-x64.exe'];
  const assets = [];
  for (const name of names) { const bytes = Buffer.from(name); await writeFile(join(f.root, name), bytes); assets.push({ name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') }); }
  for (const [name, items] of [['desktop-macos-manifest.json', assets.slice(0, 2)], ['desktop-windows-manifest.json', assets.slice(2)]]) await writeFile(join(f.root, name), JSON.stringify({ schemaVersion: 1, tag, assets: items }));
  const env = { ...process.env, VERSION: tag, CNB_BRANCH_SHA: 'b'.repeat(40) }; delete env.RELEASE_EXPECTED_SHA;
  const missing = spawnSync(process.execPath, ['-e', code], { cwd: f.root, env, encoding: 'utf8' }); assert.equal(missing.status, 1); assert.match(missing.stderr, /显式 RELEASE_EXPECTED_SHA/);
  await assert.rejects(access(join(f.root, 'WorkLoom-release-manifest.json')));
  const result = spawnSync(process.execPath, ['-e', code], { cwd: f.root, env: { ...env, RELEASE_EXPECTED_SHA: sha }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(f.root, 'WorkLoom-release-manifest.json'), 'utf8')); assert.equal(manifest.sourceSha, sha); assert.deepEqual(manifest.assets, assets);
});
test('only known release 404 permits creation, bound to exact source instead of live main', async t => {
  const f = await fixture(t); const writes = []; let exists = false;
  const request = async (_repo, path, options) => {
    if (path.includes('/git/commits/')) return { sha };
    if (path.includes('/releases/tags/')) { if (!exists) throw Object.assign(new Error('missing'), { status: 404 }); return { id: 'r', assets: [] }; }
    writes.push({ path, options });
    if (path === '/-/releases') { exists = true; return { id: 'r', assets: [] }; }
    if (path.includes('asset-upload-url')) return { upload_url: 'https://storage.example/upload', verify_url: 'https://api.cnb.cool/workloom-ai/test/-/verify' };
    return {};
  };
  const transport = async (_url, options) => options?.method === 'PUT' ? new Response('', { status: 200 }) : new Response(f.bytes);
  const result = await publishRelease({ repo, tag, sha, files: [f.file], create: true, request, transport });
  assert.equal(result.sha, sha); assert.equal(writes[0].options.body.target_commitish, sha);
  assert.equal(writes[1].options.body.overwrite, false); assert.equal(result.assets[0].size, f.bytes.length);
});
test('permission, timeout and rate limit never create or overwrite a release', async t => {
  const f = await fixture(t);
  for (const status of [403, 429, 500, undefined]) {
    let writes = 0; const request = async (_repo, _path, options) => { if (options.method !== 'GET' && options.method) writes++; throw Object.assign(new Error('unavailable'), { status }); };
    await assert.rejects(publishRelease({ repo, tag, sha, files: [f.file], create: true, request }), /unavailable/); assert.equal(writes, 0);
  }
});
test('existing public bytes are read-only; mismatched tag or downloaded bytes cannot be clobbered', async t => {
  const f = await fixture(t); let writes = 0;
  const request = async (_repo, path, options) => { if (options.method) writes++; return path.includes('/git/commits/') ? { sha } : { id: 'r', assets: [{ name: 'WorkLoom-test.exe' }] }; };
  await publishRelease({ repo, tag, sha, files: [f.file], request, transport: async () => new Response(f.bytes) }); assert.equal(writes, 0);
  await publishRelease({ repo, tag: 'ui-v1.2.3', sha, files: [f.file], request, transport: async () => new Response(f.bytes) }); assert.equal(writes, 0);
  await assert.rejects(publishRelease({ repo, tag, sha, files: [f.file], request, transport: async () => new Response('wrong') }), /differ/); assert.equal(writes, 0);
  await assert.rejects(publishRelease({ repo, tag, sha: 'b'.repeat(40), files: [f.file], request }), /frozen/); assert.equal(writes, 0);
});
test('failed object upload or failed final readback remains failed', async t => {
  const f = await fixture(t); let verifyWrites = 0;
  const request = async (_repo, path, options) => path.includes('/git/commits/') ? { sha } : path.includes('/releases/tags/') ? { id: 'r', assets: [] } : path.includes('asset-upload-url') ? { upload_url: 'https://storage.example/upload', verify_url: 'https://api.cnb.cool/workloom-ai/test/-/verify' } : (++verifyWrites, {});
  await assert.rejects(publishRelease({ repo, tag, sha, files: [f.file], request, transport: async () => new Response('failed', { status: 500 }) }), /upload/); assert.equal(verifyWrites, 0);
  await assert.rejects(publishRelease({ repo, tag, sha, files: [f.file], request, transport: async (_url, options) => options?.method === 'PUT' ? new Response('') : new Response('failed', { status: 404 }) }), /readback/);
});
