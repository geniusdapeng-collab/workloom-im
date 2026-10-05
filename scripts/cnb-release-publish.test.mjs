import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRelease } from './cnb-release-publish.mjs';
const sha = 'a'.repeat(40); const repo = 'workloom-ai/test'; const tag = 'v1.2.3';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'delivery-release-publish-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'WorkLoom-test.exe'); await writeFile(file, 'actual bytes'); return { file, bytes: Buffer.from('actual bytes') }; }
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
