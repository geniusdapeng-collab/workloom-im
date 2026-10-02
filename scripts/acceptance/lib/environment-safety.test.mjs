import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadProfile, urlsOf } from './profile.mjs';
import { resolveEnvironment, probeEnvironment } from './target.mjs';

test('MC150: foreign service, missing service and non-boolean ready health are never accepted', async () => {
  const previous = globalThis.fetch;
  const env = { kind: 'deployed', urls: { api: 'https://synthetic.invalid' }, supportDir: null };
  try {
    for (const health of [{ ok: true }, { ok: true, service: 'foreign-service' }, { ok: 'true', service: 'workloom-im-server' }, { ok: false, service: 'workloom-im-server' }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(health));
      assert.equal((await probeEnvironment({ env })).ok, false);
    }
  } finally { globalThis.fetch = previous; }
});

test('MC150: public health evidence and network diagnostics never reflect unknown bodies', async () => {
  const previous = globalThis.fetch;
  const privateDetail = ['SYNTHETIC', 'foreign-private-detail'].join('_');
  const env = { kind: 'deployed', urls: { api: 'https://synthetic.invalid' }, supportDir: null };
  try {
    for (const fetcher of [async () => new Response(JSON.stringify({ ok: true, service: 'workloom-im-server', body: privateDetail })), async () => { throw new Error(privateDetail); }]) {
      globalThis.fetch = fetcher;
      assert.equal(JSON.stringify(await probeEnvironment({ env })).includes(privateDetail), false);
    }
  } finally { globalThis.fetch = previous; }
});

test('MC150: client-runtime rejects service health when ordinary installed identity is missing', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, service: 'workloom-im-server', instanceId: '11111111-1111-4111-8111-111111111111' }));
    const result = await probeEnvironment({ env: { kind: 'client-runtime', urls: { api: 'https://synthetic.invalid' }, supportDir: null } });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((row) => row.name === 'client.identity' && row.ok === false));
  } finally { globalThis.fetch = previous; }
});

const profile = (kind, target = {}) => ({ environment: { kind, target }, startup: { ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } } });

test('G07: explicit CLI/profile environment conflicts fail closed', () => {
  assert.throws(() => resolveEnvironment(profile('deployed', { apiUrl: 'https://example.test' }), { flag: 'local-preview' }), /冲突|conflict/);
});
test('G07: deployed requires an explicit API target', () => {
  assert.throws(() => resolveEnvironment(profile('deployed')), /apiUrl|目标/);
  assert.throws(() => resolveEnvironment(profile('deployed', { pcUrl: 'https://example.test' })), /apiUrl|目标/);
});
test('G07: production surface omissions never fall back to preview localhost', () => {
  const urls = urlsOf(profile('deployed', { apiUrl: 'https://example.test' }));
  assert.equal(urls.api, 'https://example.test');
  assert.equal(urls.pc, null);
  assert.equal(urls.bMobile, null);
  assert.equal(urls.cMobile, null);
});
test('G07: invalid URL schemes and embedded credentials are rejected without echoing secrets', () => {
  assert.throws(() => resolveEnvironment(profile('deployed', { apiUrl: 'file:///etc/hosts' })), /apiUrl|URL/);
  const secret = ['mock', 'private'].join('-');
  const credentialed = new URL('https://example.test'); credentialed.username = 'user'; credentialed.password = secret;
  assert.throws(() => resolveEnvironment(profile('deployed', { apiUrl: credentialed.href })), (error) => !error.message.includes(secret));
});
test('G07: an invalid declared environment is not normalized into local-preview', () => {
  const root = mkdtempSync(join(tmpdir(), 'rdas-invalid-env-'));
  try {
    mkdirSync(join(root, 'acceptance'));
    writeFileSync(join(root, 'acceptance', 'profile.json'), JSON.stringify({ schemaVersion: 'workloom.acceptance-profile/v2', environment: { kind: 'deployd' } }));
    assert.throws(() => loadProfile(root), /environment|环境/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('G07: client-runtime uses its documented desktop targets, never preview mobile ports', () => {
  const env = resolveEnvironment(profile('client-runtime'));
  assert.equal(env.urls.pc, 'http://localhost:5173');
  assert.equal(env.urls.api, 'http://127.0.0.1:8787');
  assert.equal(env.urls.bMobile, null);
  assert.equal(env.gateLocalSteps, false);
});
test('G07: valid JSON health bodies cannot turn HTTP denial or server errors into a ready target', async (t) => {
  let responseStatus = 200; let responseBody = '{"ok":true,"service":"workloom-im-server"}';
  const server = createServer((req, res) => { res.statusCode = responseStatus; res.setHeader('content-type', 'application/json'); res.end(responseBody); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const env = resolveEnvironment(profile('deployed', { apiUrl: `http://127.0.0.1:${server.address().port}` }));
  for (const [status, body, expected] of [[200, '{"ok":true,"service":"workloom-im-server"}', true], [403, '{"error":"denied"}', false], [500, '{"error":"unavailable"}', false], [200, 'invalid-json', false]]) {
    responseStatus = status; responseBody = body;
    const result = await probeEnvironment({ env, timeoutMs: 8000 });
    assert.equal(result.ok, expected, `HTTP ${status}: ${JSON.stringify(result.checks)}`); assert.equal(result.checks[0].status, status);
  }
});
