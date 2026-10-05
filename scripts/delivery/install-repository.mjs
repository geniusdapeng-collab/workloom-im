#!/usr/bin/env node
/** Privileged first-install coordinator. Native main execution never receives this writer's session credential. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, branchProtectionPayload, redactCredentials, requireToken, validateBranchProtection } from '../tools/cnb-api.mjs';
import { GitStateStore, git } from './git-state.mjs';
import { appendEvent, branchName, hash, parseIntent, SHA_RE, updateTask, validRepoSlug } from './queue-model.mjs';
import { Platform } from './queue-platform.mjs';
import { activate, configureAutomaticReviewPolicy, prepareInstallation, verifyInstallerChecks } from './queue-runner.mjs';
import { independentCodeBuddyApproval } from './queue-work.mjs';
import { loadPolicy } from './queue-policy.mjs';
import { applyInstallation, installationPlan, INSTALL_MARKER, readAssets } from './install-assets.mjs';

const SOURCE_REPO = 'workloom-ai/workloom-im';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Official /user/repos API, all owned active repositories across groups, with explicit pagination. */
export async function discoverAccount(token, request = api) {
  const repos = []; const seen = new Set(); const seenPaths = new Set();
  for (let page = 1; page <= 100; page++) {
    const result = await request('', `https://api.cnb.cool/user/repos?role=Owner&status=active&page_size=100&page=${page}&order_by=slug_path&desc=false`, { token });
    if (!Array.isArray(result)) throw new Error('Account repository discovery is unreadable');
    for (const repo of result) {
      if (!validRepoSlug(repo.path) || !repo.id || seen.has(String(repo.id)) || seenPaths.has(repo.path.toLowerCase())) throw new Error('Account repository discovery identity is ambiguous');
      seen.add(String(repo.id)); seenPaths.add(repo.path.toLowerCase()); repos.push({ id: String(repo.id), repo: repo.path, frozen: repo.freeze === true });
    }
    if (result.length < 100) return repos;
  }
  throw new Error('Account repository discovery exceeds pagination limit');
}

export async function ensureInstallationMainProtection(platform) {
  const rules = await platform.protections(); const existing = rules.find(rule => rule.rule === 'main');
  if (existing && !validateBranchProtection(existing).length) return existing;
  // Tighten existing weak controls; keep its other restrictions and extra human requirement until activation proves AI.
  const { id, ...prior } = existing ?? {};
  const expected = { ...branchProtectionPayload(), ...prior, rule: 'main', allow_deletions: false, allow_force_pushes: false, allow_pushes: false,
    allow_master_deletions: false, allow_master_force_pushes: false, allow_master_pushes: false,
    required_must_push_via_pull_request: true, required_status_checks: true, required_pull_request_reviews: true,
    forbid_approve_pull_created_by_own_npc: true, required_approved_review_count: Math.max(1, Number(prior.required_approved_review_count) || 1) };
  const path = id ? `/-/settings/branch-protections/${encodeURIComponent(id)}` : '/-/settings/branch-protections';
  let failure;
  try { await platform.call(path, { method: id ? 'PATCH' : 'POST', body: expected }); } catch (error) { failure = error; }
  const after = (await platform.protections()).find(rule => rule.rule === 'main');
  if (!after || validateBranchProtection(after).length || Object.entries(expected).some(([key, value]) => after[key] !== value)) throw failure ?? new Error('Installation main protection did not read back');
  return after;
}

function taskCard(taskId, repo, marker, files) {
  return `<!-- delivery-install:${marker.packageHash} -->\n\n任务号：${taskId}\n\n## four_questions\n1. 公共研发交付机制，在 ${repo} 独立安装。\n2. 只变更研发 CI、租约和真实 AI 审查，业务围栏/账户/客户数据不变。\n3. 不改变行业身份、隔离登记或业务同步。\n4. 原仓必需 CI、独立 CodeBuddy、准确 merge 双亲与 activation 回读；失败保留任务，回滚通过独立 revert PR。\n\n## scope\n${files.map(path => `- ${path}`).join('\n')}\n\n## acceptance\n- 保留原仓机器检查与业务文件。\n- 普通研发不等待用户点 Approve。\n- 首装准备账本 → 真实 AI/检查 → 普通 merge → 当前 main 激活回读。\n\n## risk\n治理代码接受完整独立 AI 审查。缺权限/未知操作保持未启用，凭据只在进程内。`;
}

/** Recover a single successful-but-unacknowledged object by its immutable marker; no blind write retry. */
export async function createOnce({ list, match, create }) {
  const before = (await list()).filter(match);
  if (before.length > 1) throw new Error('Installation object identity is ambiguous');
  if (before.length) return before[0];
  try { return await create(); }
  catch (error) {
    const recovered = (await list()).filter(match);
    if (recovered.length !== 1) throw error;
    return recovered[0];
  }
}

export async function preparePropagated({ platform, store, root, number, expected, wait = sleep, elapsedClock = Date.now }) {
  const start = elapsedClock(); let pull;
  for (;;) {
    pull = await platform.pull(number);
    if (pull.head?.sha === expected) return prepareInstallation({ platform, store, root, installer: pull });
    if (elapsedClock() - start >= 30_000) throw new Error('Installation PR source propagation timed out');
    await wait(1000);
  }
}

export async function freezeInstallerSource(platform, pull) {
  const branch = branchName(pull.head?.ref);
  if (!branch.startsWith('chore/protocol-onboarding-') || !SHA_RE.test(pull.head?.sha ?? '')) throw new Error('Only an exact installation source can be frozen');
  const expected = { ...branchProtectionPayload({ rule: branch, requireReview: false }), required_status_checks: false };
  let actual = (await platform.protections()).find(rule => rule.rule === branch);
  if (!actual) {
    let failure;
    try { await platform.call('/-/settings/branch-protections', { method: 'POST', body: expected }); } catch (error) { failure = error; }
    actual = (await platform.protections()).find(rule => rule.rule === branch);
    if (!actual) throw failure ?? new Error('Frozen installation source protection is absent');
  }
  if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) throw new Error('Installation source protection differs from the immutable rule');
  const ref = await platform.call(`/-/git/branches/${encodeURIComponent(branch)}`);
  if (ref.protected !== true || ref.commit?.sha !== pull.head.sha) throw new Error('Installation source changed or was not frozen');
  return actual;
}

/** The Pull API has no merged-commit field. Recover only from actual first-parent ancestry. */
export async function traceInstallerMerge(platform, snapshot) {
  const pull = await platform.pull(snapshot.number);
  if (pull.is_merged !== true || pull.head?.sha !== snapshot.headSha) throw new Error('Installation merge is still unknown; no duplicate request is allowed');
  let sha = (await platform.main()).commit?.sha;
  for (let depth = 0; depth < 200 && SHA_RE.test(sha ?? ''); depth++) {
    const commit = await platform.commit(sha); const parents = commit.parents?.map(parent => parent.sha) ?? [];
    if (parents.length === 2 && parents[0] === snapshot.mainSha && parents[1] === snapshot.headSha) return platform.verifyMerge(snapshot, { sha });
    if (!parents.length || sha === snapshot.mainSha) break;
    sha = parents[0];
  }
  throw new Error('Installation merge cannot be traced to its exact tested parents');
}

export async function prepareRepository({ repo, token, sourceRoot, sourceSha, sourceRepo = SOURCE_REPO, checkout, platform = new Platform(repo, token), store = new GitStateStore({ repo, token }), assets, now = new Date() }) {
  if (!validRepoSlug(repo) || !SHA_RE.test(sourceSha ?? '') || !token) throw new Error('Invalid privileged installation identity');
  const remote = `https://cnb.cool/${repo}.git`;
  const directory = checkout ? resolve(checkout) : await mkdtemp(join(tmpdir(), 'delivery-install-'));
  const root = checkout ? directory : join(directory, 'repo');
  try {
    const mainSha = (await platform.main()).commit?.sha;
    if (!SHA_RE.test(mainSha ?? '')) throw new Error('Repository has no verifiable main branch');
    if (!checkout) {
      await git(['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--branch', 'main', remote, root], { token, remote });
      await git(['sparse-checkout', 'init', '--cone'], { cwd: root });
      await git(['sparse-checkout', 'set', 'scripts/ci', 'scripts/delivery', 'scripts/tools', 'docs', '.cnb'], { cwd: root });
      await git(['checkout', '--quiet', 'main'], { cwd: root });
    }
    if (await git(['status', '--porcelain'], { cwd: root })) throw new Error('Installation checkout has uncommitted changes');
    // Supplied managed checkout must already be the exact current main; never reset a user's branch.
    if (await git(['rev-parse', 'HEAD'], { cwd: root }) !== mainSha) throw new Error('Installation checkout is not at current main');
    const packageAssets = assets ?? await readAssets(sourceRoot, sourceSha);
    const plan = await installationPlan({ root, assets: packageAssets, sourceRepo, sourceSha, repo });
    if (!plan.changes.size) {
      const state = await store.read();
      return { repo, status: state.events.some(event => event.kind === 'activated') ? 'active' : 'prepared', mainSha, packageHash: plan.marker.packageHash };
    }
    const branch = `chore/protocol-onboarding-delivery-${plan.marker.packageHash.slice(0, 16)}`;
    const marker = `delivery-install:${plan.marker.packageHash}`;
    const existingPulls = [...await platform.list('/-/pulls?state=open&base_ref=main'), ...await platform.list('/-/pulls?state=closed&base_ref=main')];
    const prior = existingPulls.filter(p => branchName(p.head?.ref) === branch && String(p.body).includes(marker));
    if (prior.length > 1) throw new Error('Installation PR identity is ambiguous');
    if (prior.length) {
      const pull = await platform.pull(Number(prior[0].number));
      if (pull.state === 'open') {
        await git(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`], { cwd: root, token, remote });
        await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
        const actualMarker = JSON.parse(await git(['show', `HEAD:${INSTALL_MARKER}`], { cwd: root }));
        if (actualMarker.packageHash !== plan.marker.packageHash || actualMarker.repo !== repo) throw new Error('Existing installation source belongs to another repository/package');
        await preparePropagated({ platform, store, root, number: pull.number, expected: await git(['rev-parse', 'HEAD'], { cwd: root }) });
      }
      return { repo, status: pull.is_merged ? 'merged_pending_activation' : pull.state === 'open' ? 'waiting_checks' : 'closed_unmerged', number: pull.number, branch, packageHash: plan.marker.packageHash };
    }
    await ensureInstallationMainProtection(platform);
    const issues = [...await platform.list('/-/issues?state=open'), ...await platform.list('/-/issues?state=closed')];
    const date = now.toISOString().slice(0, 10).replaceAll('-', '');
    const prefix = `T-${date.slice(0, 4)}-${date.slice(4)}`;
    const suffix = 1000 + parseInt(hash(`${repo}:${plan.marker.packageHash}`).slice(0, 8), 16) % 9000;
    const taskId = `${prefix}-${suffix}`;
    if (issues.some(issue => String(issue.title).includes(taskId) && !String(issue.body).includes(marker))) throw new Error('Installation task number collides with another task');
    const issue = await createOnce({ list: async () => [...await platform.list('/-/issues?state=open'), ...await platform.list('/-/issues?state=closed')],
      match: item => String(item.body).includes(`<!-- ${marker} -->`),
      create: () => platform.call('/-/issues', { method: 'POST', body: { title: `[${taskId}] 安装普通研发自动交付`, body: taskCard(taskId, repo, plan.marker, [...plan.changes.keys()]) } }) });
    if (!Number.isSafeInteger(Number(issue.number)) || Number(issue.number) <= 0) throw new Error('Installation issue receipt is invalid');
    const refs = await git(['ls-remote', remote, `refs/heads/${branch}`], { cwd: root, token, remote });
    if (refs) {
      await git(['fetch', '--quiet', remote, `refs/heads/${branch}`], { cwd: root, token, remote });
      await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
      const expectedMarker = JSON.stringify(plan.marker);
      const actualMarker = JSON.stringify(JSON.parse(await git(['show', `HEAD:${INSTALL_MARKER}`], { cwd: root })));
      if (actualMarker !== expectedMarker) throw new Error('Existing installation branch belongs to another package');
      for (const [path, content] of plan.changes) if (await git(['show', `HEAD:${path}`], { cwd: root, raw: true }) !== content) throw new Error('Existing installation branch bytes drifted');
    } else {
      await git(['checkout', '--quiet', '-b', branch], { cwd: root });
      const files = await applyInstallation(plan, root);
      await git(['diff', '--check'], { cwd: root });
      await git(['add', '--', ...files], { cwd: root });
      await git(['commit', '--quiet', '-m', `feat(base): 安装普通研发自动交付 [${taskId}]`], { cwd: root });
      const expected = await git(['rev-parse', 'HEAD'], { cwd: root });
      try { await git(['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`], { cwd: root, token, remote }); }
      catch (error) {
        const actual = await git(['ls-remote', remote, `refs/heads/${branch}`], { cwd: root, token, remote });
        if (actual.split(/\s/)[0] !== expected) throw error;
      }
    }
    if ((await platform.main()).commit?.sha !== mainSha) throw new Error('Main advanced during installation; align branch and retry checks before activation');
    const body = `原仓必需检查保留，新增完整 CodeBuddy 和交付回归。安装范围及四问见 Issue #${issue.number} [${taskId}]。\n\n<!-- ${marker} -->\n\n<!-- workloom-delivery\n${JSON.stringify({ task_id: taskId, ready: true, depends_on: [], releases: [] })}\n-->`;
    const pull = await createOnce({ list: () => platform.list('/-/pulls?state=open&base_ref=main'), match: p => branchName(p.head?.ref) === branch && String(p.body).includes(marker),
      create: () => platform.call('/-/pulls', { method: 'POST', body: { head: branch, base: 'main', title: `feat(base): 安装普通研发自动交付 [${taskId}]`, body } }) });
    const number = Number(pull.number); const expected = await git(['rev-parse', 'HEAD'], { cwd: root });
    await preparePropagated({ platform, store, root, number, expected });
    return { repo, status: 'waiting_checks', number, issue: Number(issue.number), branch, headSha: expected, mainSha, packageHash: plan.marker.packageHash, requiredNames: plan.requiredNames };
  } finally { if (!checkout) await rm(directory, { recursive: true, force: true }); }
}

/** A first install uses genuine bootstrap CI/AI; a native candidate handles every later development merge. */
export async function finishInstallation({ repo, token, number, root, platform = new Platform(repo, token), store = new GitStateStore({ repo, token }) }) {
  let pull = await platform.pull(number);
  const state = await store.read();
  if (state.events.some(event => event.kind === 'activated')) {
    const task = state.tasks[String(number)];
    if (!task?.merge || task.merge.sourceSha !== pull.head?.sha || !task.mergeSnapshot) return { repo, number, status: 'waiting_native_delivery' };
    const receipt = await platform.verifyMerge(task.mergeSnapshot, task.merge);
    const remote = `https://cnb.cool/${repo}.git`;
    await git(['fetch', '--quiet', '--no-tags', remote, 'refs/heads/main'], { cwd: root, token, remote });
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
    const mainSha = (await platform.main()).commit?.sha;
    await git(['merge-base', '--is-ancestor', receipt.sha, mainSha], { cwd: root });
    await platform.assertCandidateProtection();
    await store.mutate(s => appendEvent(s, 'installation_updated', { installer: number, merge: receipt, mainSha }), { id: `install-updated:${number}:${receipt.sha}` });
    return { repo, number, status: 'active', mainSha, nativeHandled: true, integration: receipt };
  }
  const pending = state.events.findLast(event => event.kind === 'installer_merge_requested' && event.data.number === number);
  if (pending && !state.tasks[String(number)]?.merge) {
    const receipt = await traceInstallerMerge(platform, pending.data.snapshot);
    await store.mutate(s => updateTask(s, number, { status: 'integrated', headSha: receipt.sourceSha, intent: parseIntent(pull), merge: receipt, mergeSnapshot: pending.data.snapshot }));
  }
  const policy = await loadPolicy(root);
  const statuses = await platform.call(`/-/pulls/${number}/commit-statuses`);
  if (!SHA_RE.test(statuses.sha ?? '')) return { repo, number, status: 'waiting_checks', reasons: ['Missing tested commit'] };
  const tested = await platform.commit(statuses.sha);
  let preparation;
  try { preparation = verifyInstallerChecks({ state, installer: pull, statuses, tested, requiredNames: policy.requiredNames }); }
  catch (error) { return { repo, number, status: 'waiting_checks', reasons: [platform.error(error)] }; }
  const commit = await platform.commit(pull.head?.sha);
  const approval = independentCodeBuddyApproval(await platform.list(`/-/pulls/${number}/reviews`), pull, Date.parse(commit.commit?.committer?.date ?? commit.commit?.author?.date));
  if (!pull.is_merged) {
    if (pull.state !== 'open' || pull.is_wip !== false || branchName(pull.head?.ref).startsWith('chore/protocol-onboarding-') !== true || !String(pull.body).includes('<!-- delivery-install:')) throw new Error('Not a current exact installation PR');
    const mainSha = (await platform.main()).commit?.sha;
    if (mainSha !== tested.parents[0].sha || pull.base?.sha !== mainSha || pull.mergeable_state !== 'mergeable') return { repo, number, status: 'waiting_alignment' };
    if (await git(['rev-parse', 'HEAD'], { cwd: root }) !== pull.head.sha) throw new Error('Installation merge checkout differs from the exact reviewed source');
    if ((await store.read()).events.some(event => event.kind === 'activated')) throw new Error('An active repository must route subsequent updates through its native immutable candidate');
    await configureAutomaticReviewPolicy(platform, { independentApproval: approval, preparation });
    await freezeInstallerSource(platform, pull);
    const snapshot = { number, pull, headSha: pull.head.sha, mainSha, checkSha: statuses.sha };
    await store.mutate(s => appendEvent(s, 'installer_merge_requested', { number, snapshot, approval }), { id: `installer-merge:${number}:${pull.head.sha}` });
    const current = await platform.pull(number);
    if (current.head?.sha !== snapshot.headSha || current.body !== pull.body || (await platform.main()).commit?.sha !== mainSha) throw new Error('Installation changed before merge');
    let result;
    try { result = await platform.merge(snapshot); }
    catch (error) {
      pull = await platform.pull(number);
      if (!pull.is_merged) throw error;
      const recovered = await traceInstallerMerge(platform, snapshot); result = { sha: recovered.sha };
    }
    const receipt = await platform.verifyMerge(snapshot, result);
    await store.mutate(s => updateTask(s, number, { status: 'integrated', headSha: snapshot.headSha, intent: parseIntent(pull), merge: receipt, mergeSnapshot: snapshot }));
  }
  const completed = (await store.read()).tasks[String(number)];
  if (!completed?.merge || completed.merge.sourceSha !== pull.head?.sha) throw new Error('Installation has no verified durable integration receipt');
  pull = await platform.pull(number);
  await git(['fetch', '--quiet', '--no-tags', `https://cnb.cool/${repo}.git`, 'refs/heads/main'], { cwd: root, token, remote: `https://cnb.cool/${repo}.git` });
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  const activation = await activate({ platform, store, root, installer: pull });
  const after = await store.read();
  if (!after.events.some(event => event.kind === 'activated' && event.data.installer === number && event.data.mainSha === activation.mainSha)) throw new Error('Installation activation did not read back');
  return { ...activation, number, status: 'active' };
}

async function main() {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const token = requireToken(); const command = process.argv[2];
  if (command === 'discover') { console.log(JSON.stringify(await discoverAccount(token), null, 2)); return; }
  const repo = arg('--repo');
  if (command === 'prepare') console.log(JSON.stringify(await prepareRepository({ repo, token, sourceRoot: resolve(arg('--source-root') ?? '.'), sourceSha: arg('--source-sha'), checkout: arg('--root') }), null, 2));
  else if (command === 'finish') console.log(JSON.stringify(await finishInstallation({ repo, token, root: resolve(arg('--root') ?? '.'), number: Number(arg('--pr')) }), null, 2));
  else throw new Error('Usage: install-repository.mjs discover|prepare|finish --repo org/name --root checkout --source-root exact-base --source-sha SHA --pr number');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
