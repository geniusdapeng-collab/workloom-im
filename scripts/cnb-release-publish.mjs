#!/usr/bin/env node
/** CNB release publisher: exact frozen source, immutable existing bytes and positive readbacks. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { api, redactCredentials, requireToken } from './tools/cnb-api.mjs';

const digest = buffer => `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
export async function publishRelease({ repo, tag, sha, files, create = false, name = tag, body = '', token, request = api, transport = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^(?:ui-)?v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag ?? '') || !/^[a-f0-9]{40,64}$/.test(sha ?? '')) throw new Error('Release repository/tag/frozen SHA is invalid');
  if (!Array.isArray(files) || !files.length || new Set(files.map(file => basename(file))).size !== files.length) throw new Error('Unique release files required');
  const assets = files.map(file => {
    if (!statSync(file).isFile()) throw new Error(`Release asset is not a file: ${file}`);
    const bytes = readFileSync(file);
    if (!bytes.length) throw new Error(`Release asset is empty: ${file}`);
    return { name: basename(file), bytes, sha512: digest(bytes) };
  });
  const call = (path, options = {}) => request(repo, path, { token, ...options, retries: options.method && options.method !== 'GET' ? 0 : 2 });
  const readTag = () => call(`/-/git/commits/${encodeURIComponent(tag)}`);
  let release;
  try { release = await call(`/-/releases/tags/${encodeURIComponent(tag)}`); }
  catch (error) {
    if (error.status !== 404 || !create) throw error;
    // Only a known 404 permits creation; permission/timeouts never become a new publication.
    release = await call('/-/releases', { method: 'POST', body: { tag_name: tag, name, body, target_commitish: sha, draft: false, prerelease: false, make_latest: 'false' } });
  }
  if (!release?.id || (await readTag()).sha !== sha) throw new Error('Release tag does not point to the frozen reviewed source');
  const download = async asset => {
    const response = await transport(`https://cnb.cool/${repo}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Release readback ${asset.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes.length || digest(bytes) !== asset.sha512) throw new Error(`Release bytes differ: ${asset.name}`);
  };
  for (const asset of assets) {
    const existing = (release.assets ?? []).filter(item => item.name === asset.name);
    if (existing.length > 1) throw new Error('Ambiguous existing release asset');
    if (existing.length) { await download(asset); continue; }
    const upload = await call(`/-/releases/${release.id}/asset-upload-url`, { method: 'POST', body: { asset_name: asset.name, size: asset.bytes.length, overwrite: false } });
    if (!upload?.upload_url || !upload?.verify_url || new URL(upload.upload_url).protocol !== 'https:') throw new Error('Upload receipt is incomplete');
    // Signed object-store upload carries no CNB Authorization header.
    const response = await transport(upload.upload_url, { method: 'PUT', body: asset.bytes, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(180000), redirect: 'error' });
    if (!response.ok) throw new Error(`Release upload ${asset.name}: HTTP ${response.status}`);
    await call(upload.verify_url, { method: 'POST', body: {} });
    await download(asset);
  }
  if ((await readTag()).sha !== sha) throw new Error('Release tag changed during publication');
  return { repo, tag, sha, assets: assets.map(({ name, bytes, sha512 }) => ({ name, size: bytes.length, sha512 })) };
}
export async function main(argv = process.argv.slice(2)) {
  const values = {}; const files = []; let create = false;
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--create') create = true;
    else if (['--tag', '--body', '--name'].includes(item)) { if (!argv[index + 1]) throw new Error(`Missing value: ${item}`); values[item.slice(2)] = argv[++index]; }
    else if (item.startsWith('--')) throw new Error(`Unknown option: ${item}`);
    else files.push(item);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).trim();
  const expected = process.env.RELEASE_EXPECTED_SHA ?? process.env.CNB_BRANCH_SHA ?? head;
  if (head !== expected) throw new Error('Publisher checkout differs from frozen release source');
  console.log(JSON.stringify(await publishRelease({ repo: process.env.CNB_REPO ?? process.env.CNB_REPO_SLUG ?? 'workloom-ai/workloom-im', ...values, sha: expected, files, create, token: requireToken() })));
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
