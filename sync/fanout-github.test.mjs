import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fanoutGithub } from './fanout-github.mjs';
import { loadRegistry } from './repository-registry.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
function commit(root) {
  git(root, ['add', '--', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid.example', 'commit', '-m', 'fixture']);
}
test('config fanout executes clone/commit/push/PR and safely resumes an orphaned exact-byte candidate', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'workloom-gh-fanout-fixture-'));
  const source = join(temporary, 'base'); const child = join(temporary, 'child'); const remote = join(temporary, 'child.git');
  const doc = loadRegistry(); const entry = doc.repositories.find(e => e.logicalId === 'workloom-growthtest');
  const beforeToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = ['test', 'operation', 'fixture'].join('-');
  try {
    for (const root of [source, child]) { mkdirSync(root); git(root, ['init', '-b', 'main']); }
    mkdirSync(join(source, 'sync')); writeFileSync(join(source, 'sync/repository-registry.json'), JSON.stringify(doc));
    writeFileSync(join(source, 'source.txt'), 'controlled source'); commit(source);
    writeFileSync(join(child, 'product.manifest.json'), JSON.stringify({ schemaVersion: 'workloom.product/v1', productId: entry.productId, repository: entry.cnb.repository, release: { appId: 'original.identity' } }));
    writeFileSync(join(child, 'business.txt'), 'frozen byte content'); commit(child);
    const childBase = git(child, ['rev-parse', 'HEAD']);
    git(temporary, ['clone', '--bare', child, remote]);
    const network = []; const clones = []; const requests = [];
    const localTransport = (cwd, args, options = {}) => {
      const rewritten = [...args];
      if (options.network) {
        network.push([...args]);
        const destination = `${entry.github.url}.git`;
        assert.ok(args.includes(destination), `Unexpected network destination: ${args.join(' ')}`);
        rewritten[rewritten.indexOf(destination)] = remote;
        if (args[0] === 'clone') clones.push(args.at(-1));
      }
      const output = git(cwd, rewritten);
      if (options.network && args[0] === 'clone') git(args.at(-1), ['remote', 'set-url', 'origin', `${entry.github.url}.git`]);
      return output;
    };
    const request = async (method, path, body) => {
      requests.push({ method, path, body });
      assert.ok(path.startsWith(`/repos/${entry.github.repository}/pulls`));
      return method === 'GET' ? [] : { number: 7, html_url: `${entry.github.url}/pull/7` };
    };
    const options = { baseDir: source, only: entry.logicalId, request, git: localTransport };
    const first = await fanoutGithub(options);
    assert.equal(first.results[0].state, 'pull-open'); assert.equal(first.deliveryComplete, false);
    assert.equal(first.results[0].baseSha, childBase);
    assert.deepEqual(first.results[0].changedPaths.sort(), ['.workloom-delivery.json', '.workloom-repository.json', 'product.manifest.json']);
    const pr = requests.find(r => r.method === 'POST'); const branch = pr.body.head;
    assert.equal(git(remote, ['show', `${branch}:business.txt`]), 'frozen byte content');
    const manifest = JSON.parse(git(remote, ['show', `${branch}:product.manifest.json`]));
    assert.equal(manifest.repository, entry.github.repository); assert.equal(manifest.release.appId, 'original.identity');
    const head = git(remote, ['rev-parse', `refs/heads/${branch}`]);
    assert.equal(head, first.results[0].headSha);
    const second = await fanoutGithub(options);
    assert.equal(second.results[0].headSha, head);
    assert.equal(network.filter(args => args[0] === 'push').length, 1);
    assert.equal(network.some(args => args.some(arg => /force/.test(arg))), false);
    assert.ok(clones.every(path => !existsSync(dirname(path))));
    assert.equal(git(source, ['status', '--porcelain']), '');
  } finally {
    if (beforeToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = beforeToken;
    rmSync(temporary, { recursive: true, force: true });
  }
});
test('dry-run needs no token, makes no network calls and rejects frozen product fanout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workloom-gh-plan-fixture-'));
  try {
    git(root, ['init', '-b', 'main']); mkdirSync(join(root, 'sync'));
    writeFileSync(join(root, 'sync/repository-registry.json'), JSON.stringify(loadRegistry())); commit(root);
    const noNetwork = async () => { throw new Error('Unexpected network'); };
    const result = await fanoutGithub({ baseDir: root, dryRun: true, request: noNetwork });
    assert.equal(result.targets.length, 15); assert.equal(result.remoteWrites, 0);
    await assert.rejects(fanoutGithub({ baseDir: root, dryRun: true, mode: 'full', only: 'workloom-growthmatrix', request: noNetwork }), /forbidden/);
    writeFileSync(join(root, 'local-change'), 'keep');
    await assert.rejects(fanoutGithub({ baseDir: root, dryRun: true, request: noNetwork }), /clean committed/);
    assert.equal(readFileSync(join(root, 'local-change'), 'utf8'), 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
