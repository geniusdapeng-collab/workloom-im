/** Retain the independently hardened target PR/Git contract while migrating its occupation rule. */
import { hash } from './queue-model.mjs';

const PREFIX = 'scripts/ci/';
const ADMISSION = PREFIX + 'verify-delivery-admission.mjs';
const MARKER = '// WORKLOOM_DELIVERY_BOUND_PROTOCOL_V1';
// These are migration inputs, not upstream assets. The isolated target retains its own code.
const INPUTS = Object.freeze({
  'protocol-rules.mjs': '9d8d032cb65d6b21a5c154582598ff1694ecf31ecd1461a781d840faeb8f7053',
  'protocol-rules.test.mjs': 'bd175ad3d994210809c9a2375ae8d36a9cde23d65ac5bb54d287521230b9fcc9',
  'verify-commit-msg.mjs': 'fa5935f6147b6beec99acb7f2f4f69269b3ca5ce38e9c038b130e03b8f16e122',
  'verify-commit-msg.test.mjs': '2b7d5758285ad787f91a8d774fbd9c96c1c46a4439dcbf746c41d43566b54054',
  'verify-lock-conflict.mjs': '23e505efb698e6311e193ddb08fc6bee87b8684752834581a2690e4a8335138e',
  'verify-lock-conflict.test.mjs': 'efeec5d81bd0d8f6d083a8b92713f57ad499d80743ccc1c7a13989043a06b61a',
});

function lines(...rows) { return rows.join('\n'); }
const LOCK_EDITS = [
  ['const API = "https://api.cnb.cool";', lines(MARKER, 'import { verifyPrFreshness, verifyPrLeases } from "./verify-delivery-admission.mjs";', 'const API = "https://api.cnb.cool";')],
  ['async api(path, { repoSlug = this.repoSlug } = {})', 'async api(path, { repoSlug = this.repoSlug, raw = false } = {})'],
  ['function fail(code, message) {', 'function fail(code, message, status) {'],
  ['  error.code = code;', '  error.code = code;\n  if (status !== undefined) error.status = status;'],
  ['fail("API_INCOMPLETE", `CNB GET 返回 HTTP ${response.status}`);', 'fail("API_INCOMPLETE", `CNB GET 返回 HTTP ${response.status}`, response.status);'],
  ['try { return JSON.parse(text); } catch', 'if (raw) return text;\n          try { return JSON.parse(text); } catch'],
  ['blocking: context.policies.modules === "fail" && later', 'blocking: context.policies.modules === "fail" && later && (context.strict || !context.deliveryLeaseInstalled)'],
  ['fetchImpl = globalThis.fetch, apiOptions = {} } = {})', 'fetchImpl = globalThis.fetch, apiOptions = {}, admissionOptions = { waitMs: 180000 } } = {})'],
  ['new LockApiClient({ ...apiOptions, repoSlug:', 'new LockApiClient({ budgetMs: 240000, ...apiOptions, repoSlug:'],
  ['  const collection = await collectBoundPulls(client, context);', lines(
    '  if (context.isPr) {',
    '    const request = (url, options) => {',
    '      const prefix = API + "/" + context.repoSlug + "/-/";',
    '      if (!url.startsWith(prefix)) fail("IDENTITY_UNVERIFIED", "Admission request escaped target repository");',
    '      return client.api(url.slice(prefix.length), options);',
    '    };',
    '    const snapshot = await verifyPrFreshness({ repoSlug: context.repoSlug, number: context.iid, branch: context.sourceBranch,',
    '      eventSourceSha: context.sourceSha, eventTargetSha: context.targetSha, request });',
    '    const comparison = await client.api("git/compare/" + snapshot.mainSha + "..." + snapshot.headSha);',
    '    const bound = pathsFromCompare(comparison, { baseSha: snapshot.mainSha, headSha: snapshot.headSha });',
    '    if (JSON.stringify(bound.paths) !== JSON.stringify([...scope.files].sort())) fail("PATH_UNVERIFIED", "Actual Git paths differ from bound platform compare");',
    '    const leases = await verifyPrLeases(context.repoSlug, scope.files, request, Date.now(),',
    '      { number: Number(context.iid), headSha: snapshot.headSha, mainSha: snapshot.mainSha }, admissionOptions);',
    '    context.deliveryLeaseInstalled = leases.installed === true;',
    '  }',
    '  const collection = await collectBoundPulls(client, context);',
  )],
];

const READY_FIXTURE = lines(
  'function readyFixture() {',
  '  const f = gitFixture();',
  '  f.git("checkout", "task/current");',
  '  f.git("merge", "--no-ff", "-m", "Merge latest target into source fixture", f.target);',
  '  f.source = f.git("rev-parse", "HEAD");',
  '  f.merge = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-p", f.target, "-p", f.source, "-m", "Canonical current merge");',
  '  f.env = { ...f.env, CNB_PULL_REQUEST_SHA: f.source, CNB_COMMIT: f.source, CNB_PULL_REQUEST_MERGE_SHA: f.merge };',
  '  return f;',
  '}',
  'function admissionFixture(installed = true) {',
  '  const f = readyFixture(); const fake = new PullFixture([pull(105, { targetSha: f.target }),',
  '    pull(106, { sourceSha: f.source, targetSha: f.target, sourceBranch: "task/current" })]);',
  '  const state = emptyState(REPO); const paths = changedFiles({ context: resolveLockContext([], f.env), env: f.env, cwd: f.root }).files;',
  '  admitSource(state, { number: 106, headSha: f.source, mainSha: f.target, files: paths });',
  '  const comparison = { ...compareFor(fake.rows[1]), files: paths.map(path => ({ path, status: "modified" })) };',
  '  fake.override = path => {',
  '    if (path === "git/branches/main") return Response.json({ commit: { sha: f.target } });',
  '    if (path === "git/compare/" + f.target + "..." + f.source) return Response.json(comparison);',
  '    if (path === "git/raw/automation%2Fdelivery-state/state.json") return installed ? Response.json(state) : Response.json({}, { status: 404 });',
  '    if (path === "git/branches/automation%2Fdelivery-state") return Response.json({}, { status: 404 });',
  '    if (path === "git/raw/main/.cnb.yml") return new Response("main: {}");',
  '  };',
  '  const run = () => runLockGate({ env: f.env, cwd: f.root, fetchImpl: fake.fetch, apiOptions: { pageSize: 2 }, admissionOptions: { waitMs: 0 } });',
  '  return { f, fake, state, paths, run };',
  '}',
);
const TEST_EDITS = [
  ['const directories = [];', lines(MARKER, 'import { admitSource, emptyState, leaseOperation } from "../delivery/queue-model.mjs";', 'const directories = [];')],
  ['test("actual gate uses real PR Git source and API observation for advisory and module decisions", async () => {\n  const f = gitFixture(); const fake = new PullFixture([pull(105, { targetSha: f.target }), pull(106, { sourceSha: f.source, targetSha: f.target, sourceBranch: "task/current" })]);',
    lines(READY_FIXTURE, 'test("actual gate uses real PR Git source and API observation for advisory and module decisions", async () => {',
      '  const { f, fake } = admissionFixture(false);')],
];
const ADMISSION_TESTS = lines(
  '',
  'test("installed admission releases old PR-number occupation without dropping bound Git/API proof", async () => {',
  '  const fixture = admissionFixture(); fixture.fake.compares.set("105", compareFor(fixture.fake.rows[0], ["sync/old-open.mjs"]));',
  '  const result = await fixture.run(); assert.equal(result.decision, "pass"); assert.equal(result.verified, true);',
  '  assert.ok(result.conflicts.some(row => row.kind === "modules" && !row.blocking));',
  '});',
  'test("a live fenced development lease still blocks an installed PR even with ordinary warn", async () => {',
  '  const fixture = admissionFixture(); leaseOperation(fixture.state, { action: "acquire", owner: "actual-other-developer", scopes: ["sync"] });',
  '  await assert.rejects(fixture.run(), /有效开发租约/);',
  '});',
  'test("an expired occupation stops blocking while exact admission remains required", async () => {',
  '  const fixture = admissionFixture(); leaseOperation(fixture.state, { action: "acquire", owner: "expired-developer", scopes: ["sync"] }, Date.now() - 1800000);',
  '  assert.equal((await fixture.run()).decision, "pass");',
  '});',
  'test("missing sensitive admission and a receipt for another exact source both fail", async () => {',
  '  for (const mismatch of [false, true]) { const fixture = admissionFixture();',
  '    const replacement = emptyState(REPO); if (mismatch) admitSource(replacement, { number: 106, headSha: OTHER, mainSha: fixture.f.target, files: fixture.paths });',
  '    Object.assign(fixture.state, replacement); await assert.rejects(fixture.run(), /接纳回执/);',
  '  }',
  '});',
  'test("the installed PR cannot use a stale main or a shortened platform file set", async () => {',
  '  for (const drift of ["main", "files"]) { const fixture = admissionFixture(); const previous = fixture.fake.override;',
  '    fixture.fake.override = path => {',
  '      if (drift === "main" && path === "git/branches/main") return Response.json({ commit: { sha: OTHER } });',
  '      if (drift === "files" && path === "git/compare/" + fixture.f.target + "..." + fixture.f.source) return Response.json(compareFor(fixture.fake.rows[1], ["normal.txt"]));',
  '      return previous(path);',
  '    }; await assert.rejects(fixture.run());',
  '  }',
  '});',
  'test("an unreadable installed ledger is an error rather than old-number fallback", async () => {',
  '  const fixture = admissionFixture(); const previous = fixture.fake.override;',
  '  fixture.fake.override = path => path === "git/raw/automation%2Fdelivery-state/state.json" ? Response.json({}, { status: 403 }) : previous(path);',
  '  await assert.rejects(fixture.run(), /API_INCOMPLETE/);',
  '});',
  '',
);

function replaceExactly(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Bound protocol migration anchor changed');
  return text.replace(before, after);
}
function original(text, edits) {
  if (!text?.includes(MARKER)) return text;
  if (edits === TEST_EDITS) {
    if (!text.endsWith(ADMISSION_TESTS)) throw new Error('Bound protocol admission regressions changed');
    text = text.slice(0, -ADMISSION_TESTS.length);
  }
  for (const [before, after] of [...edits].reverse()) text = replaceExactly(text, after, before);
  return text;
}

export const PROTOCOL_ADDITIONAL_ASSETS = Object.freeze([ADMISSION, PREFIX + 'verify-commit-msg.test.mjs', PREFIX + 'verify-lock-conflict.test.mjs']);

/** Reject unknown hardened variants rather than silently downgrading their Git/identity proof. */
export async function preserveBoundProtocol(assets, readTarget) {
  const lock = await readTarget(PREFIX + 'verify-lock-conflict.mjs');
  if (!lock?.includes('export async function runLockGate')) return { assets, preserved: false };
  const current = {};
  for (const [name, digest] of Object.entries(INPUTS)) {
    let content = await readTarget(PREFIX + name);
    if (name === 'verify-lock-conflict.mjs') content = original(content, LOCK_EDITS);
    if (name === 'verify-lock-conflict.test.mjs') content = original(content, TEST_EDITS);
    if (typeof content !== 'string' || hash(content) !== digest) throw new Error('Hardened target protocol needs an explicit reviewed migration: ' + name);
    current[name] = content;
  }
  let adaptedLock = current['verify-lock-conflict.mjs'];
  for (const [before, after] of LOCK_EDITS) adaptedLock = replaceExactly(adaptedLock, before, after);
  let adaptedTest = current['verify-lock-conflict.test.mjs'];
  for (const [before, after] of TEST_EDITS) adaptedTest = replaceExactly(adaptedTest, before, after);
  adaptedTest += ADMISSION_TESTS;
  const result = { ...assets, [ADMISSION]: assets[PREFIX + 'verify-lock-conflict.mjs'] };
  for (const [name, content] of Object.entries(current)) result[PREFIX + name] = content;
  result[PREFIX + 'verify-lock-conflict.mjs'] = adaptedLock;
  result[PREFIX + 'verify-lock-conflict.test.mjs'] = adaptedTest;
  return { assets: result, preserved: true };
}
