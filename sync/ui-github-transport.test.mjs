import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRegistry } from './repository-registry.mjs';
import { canonicalGitEnvironment, cloneChildReadOnly, createPullRequest, prepareUiChildren, uiOperationToken, verifyCanonicalReleaseTag } from './ui-upgrade-pr.mjs';

const doc = loadRegistry();
const inventory = JSON.parse(readFileSync(new URL('./child-repos.json', import.meta.url)));
const placeholder = ['test-only', 'operation', 'credential'].join('-');
const hotel = 'geniusdapeng-collab/workloom-hotel';
const branch = 'chore/workloom-ui-v1.2.3';

test('UI default GitHub token never falls back to CNB/SYNC or changes platform', () => {
  const ambient = { GH_TOKEN: 'first', GITHUB_TOKEN: 'second', CNB_TOKEN: 'third', SYNC_TOKEN: 'fourth' };
  assert.equal(uiOperationToken(undefined, ambient), 'first');
  assert.equal(uiOperationToken('github', { GITHUB_TOKEN: 'second', CNB_TOKEN: 'third' }), 'second');
  assert.equal(uiOperationToken('github', { CNB_TOKEN: 'third', SYNC_TOKEN: 'fourth' }), '');
  assert.equal(uiOperationToken('cnb', ambient), 'third');
  assert.equal(uiOperationToken('cnb', { GH_TOKEN: 'first' }), '');
  assert.throws(() => uiOperationToken('other', ambient));
});

test('UI Git credentials are ephemeral, helper-free and scoped only to the selected canonical host', () => {
  for (const platform of ['github', 'cnb']) {
    const env = canonicalGitEnvironment(placeholder, platform);
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper'); assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_KEY_1, `http.https://${platform === 'github' ? 'github.com' : 'cnb.cool'}/.extraheader`);
    assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_1.split(' ').at(-1), 'base64').toString(), `${platform === 'github' ? 'x-access-token' : 'cnb'}:${placeholder}`);
    assert.equal(canonicalGitEnvironment('', platform).GIT_CONFIG_COUNT, '1');
  }
});

test('UI inventory resolves all nine subscriptions through exact GitHub registry addresses and retains identity aliases', () => {
  const children = prepareUiChildren(doc, inventory.children);
  assert.equal(children.length, 9);
  assert.ok(children.every(child => child.platform === 'github' && child.repo.startsWith('geniusdapeng-collab/')));
  const selected = children.find(child => child.repo === hotel);
  assert.ok(selected.repositoryAliases.includes('workloom-ai/workloom-hotel'));
  assert.equal(selected.strictUiConsumerContract, true);
  for (const identity of ['workloom-growthtest', 'workloom-growthmatrix', 'geo-evidence-studio']) {
    assert.throws(() => prepareUiChildren(doc, [{ repo: identity }]), /不允许产品/);
  }
  assert.throws(() => prepareUiChildren(doc, [{ repo: 'unregistered/example' }]), /not registered/);
});

test('UI real Git clone entry point uses GitHub by default and CNB only when explicitly selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'workloom-ui-gh-clone-'));
  try {
    for (const platform of ['github', 'cnb']) {
      const expected = platform === 'github' ? `https://github.com/${hotel}.git` : 'https://cnb.cool/workloom-ai/workloom-hotel.git';
      const checkout = cloneChildReadOnly({ repo: 'workloom-ai/workloom-hotel', ...(platform === 'cnb' ? { platform } : {}) }, root, placeholder, {
        cloneRunner({ target, args, env }) {
          assert.equal(args.at(-2), expected);
          assert.equal(env.GIT_CONFIG_KEY_1, `http.https://${platform === 'github' ? 'github.com' : 'cnb.cool'}/.extraheader`);
          assert.equal(args.some(arg => arg.includes(placeholder)), false);
          mkdirSync(target); execFileSync('git', ['init', '-q'], { cwd: target });
        },
      });
      assert.equal(existsSync(join(checkout, '.git')), true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('UI GitHub PR create uses the fixed official API and expected owner/head/base', async () => {
  const calls = [];
  const result = await createPullRequest({ repo: 'workloom-ai/workloom-hotel', token: placeholder, branch, version: '1.2.3',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.ok(url.startsWith(`https://api.github.com/repos/${hotel}/pulls`));
      assert.equal(options.headers.Authorization, `Bearer ${placeholder}`);
      assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => options.method === 'GET' ? [] : { number: 19, html_url: `https://github.com/${hotel}/pull/19` } };
    },
  });
  assert.equal(result.number, 19); assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.head, branch); assert.equal(payload.base, 'main');
  assert.ok(calls[0].url.includes(encodeURIComponent(`geniusdapeng-collab:${branch}`)));
});

test('UI PR idempotence requires positive matching readback and never mutates after failed or invalid lists', async () => {
  let calls = 0;
  const existing = await createPullRequest({ repo: hotel, token: placeholder, branch, version: '1.2.3',
    fetchImpl: async () => { calls++; return { ok: true, json: async () => [{ number: 20, html_url: 'https://github.com/example/20', head: { ref: branch } }] }; },
  });
  assert.equal(existing.number, 20); assert.equal(calls, 1);
  for (const response of [{ ok: false, status: 403 }, { ok: true, json: async () => ({ malformed: true }) }]) {
    calls = 0;
    await assert.rejects(createPullRequest({ repo: hotel, token: placeholder, branch, version: '1.2.3', fetchImpl: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});

test('UI unknown write/duplicate error stays a failure without echoing provider response secrets', async () => {
  let calls = 0;
  await assert.rejects(createPullRequest({ repo: hotel, token: placeholder, branch, version: '1.2.3',
    fetchImpl: async () => { calls++; return calls === 1 ? { ok: true, json: async () => [] } : { ok: false, status: 422, text: async () => placeholder }; },
  }), error => /HTTP 422/.test(error.message) && !error.message.includes(placeholder));
  assert.equal(calls, 2);
});

test('UI default canonical source refuses a legacy CNB origin before any network access', () => {
  const root = mkdtempSync(join(tmpdir(), 'workloom-ui-gh-origin-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://cnb.cool/workloom-ai/workloom-im.git'], { cwd: root });
    assert.throws(() => verifyCanonicalReleaseTag({ root, sourceRef: 'refs/tags/ui-v1.2.3' }), /期望 github.com\/geniusdapeng-collab\/workloom-im/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
