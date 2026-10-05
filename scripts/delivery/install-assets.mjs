/** The installer copies only the execution closure, never product or fleet membership assets. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { git } from './git-state.mjs';
import { hash, SHA_RE } from './queue-model.mjs';
import { injectDeliveryConfig } from './install-config.mjs';
import { parser, resolvePipelineConfig } from './queue-policy.mjs';

export const CORE_ASSETS = Object.freeze([
  ...['queue-model.mjs', 'queue-policy.mjs', 'queue-platform.mjs', 'queue-controller.mjs', 'queue-work.mjs', 'queue-release.mjs', 'queue-runner.mjs', 'git-state.mjs', 'review-plugin.mjs', 'model-gateway.mjs', 'install-config.mjs', 'release-source.mjs', 'queue.test.mjs', 'cnb.yml', 'bootstrap-cnb.yml', 'runtime/package.json', 'runtime/package-lock.json'].map(path => `scripts/delivery/${path}`),
  ...['protocol-rules.mjs', 'protocol-rules.test.mjs', 'verify-commit-msg.mjs', 'verify-lock-conflict.mjs'].map(path => `scripts/ci/${path}`),
  'scripts/tools/cnb-api.mjs', 'scripts/tools/task.mjs',
]);
export const INSTALL_MARKER = '.workloom-delivery-install.json';
const BEGIN = '<!-- WORKLOOM-RD-DELIVERY:BEGIN -->';
const END = '<!-- WORKLOOM-RD-DELIVERY:END -->';
export const AGENT_RULE = `${BEGIN}
## 普通研发自动交付（产品所有者 2026-10-05 授权）

普通研发由独立 CodeBuddy 审查、原仓必需 CI 与持久化交付器完成；不要求用户逐 PR 点击 Approve。普通重叠只提示；敏感开发使用有期限的 owner/generation 租约，交接后释放。采用本仓 docs/AUTOMATIC-RD-DELIVERY.md 的现行研发规则，替代旧协议中按 open PR 编号永久占锁、普通研发必须人工放行与治理代码不可自动交付的条款。

平台真正 AI 批准、现行机器门禁与 source/main/policy/完整文件覆盖证据均须成立；禁止伪造批准、强制合并或直推 main。每个已验证修复及时独立提交推送，交付器持续完成集成和声明的发布，不等后续功能凑批。真实资金/实盘、生产秘密、客户数据、群发及不可逆经营动作仍按业务围栏另行授权。

此本仓安装只涉及研发机制，不改变行业身份、隔离登记、冻结上游认知或业务同步。两个隔离副本独立使用本机制，继续双向不同步。原仓其他指令、必需测试、产品边界与秘密不落盘纪律保留。
${END}`;

export const DELIVERY_DOC = `# 普通研发自动交付

产品所有者于 2026-10-05 授权十二仓及账户新增项目安装同一研发交付机制，并要求 AI 自行审查批准。这个补充只调整普通研发的并发、审核与交付规则；它优先于旧开发协议中相应的人工批准和永久 open PR 互斥条款。其他产品、安全、隔离与经营规则继续适用。

1. 开发者每项任务使用独立分支/PR，声明准确路径和验收。普通文件重叠只提示；敏感模块的开发租约有 owner、generation 和默认 15 分钟期限，等待 CI/审查前交接释放。
2. 每次验证一个修复后及时提交推送。用 queue-runner handoff 声明 ready 和真实 depends_on；遗留 PR 达到 10 分钟冷却期后可入队。WIP、risk/block 与真实业务动作不会被研发授权放行。
3. 原仓必需 CI 必须针对准确 source/main 全绿。不可修改候选分支再跑原仓 CI 与独立 CodeBuddy，审查覆盖所有变化文件和直接依赖；每个 CI 实现变化须有准确 id 的迁移依据。真实 Bot 批准与完整结构化回执共同成立，才能普通 merge；source/main 漂移即重做。
4. main 原生执行器每 5 分钟恢复，仓级原生锁只串行实际集成。敏感候选合并前强制取得并核验 fenced 集成租约。失败任务单独保留；语义冲突、权限不足、未知写入不会伪装成功或重复外部动作。
5. automation/delivery-state 通过普通 fast-forward CAS 保存只增事件、租约、尝试、AI 与集成证明。丢失响应先回读 transaction id。UI/桌面声明的发布使用独立执行器与固定 SHA/版本，核验构建、tag、manifest 与实际字节；没有发布回执不关完成任务。
6. 首装由具备设置权限的安装端创建并回读强保护账本、准备准确安装 source/main，随后运行真正 bootstrap AI 和原有门禁。普通合入后在当前 main activate，回读独立 AI、真实测试和候选/主干保护，并取消额外管理员点击批准要求。源 PR 原生令牌实测只读，原生 main 运行；会话凭据不写进 CI 或文件。
7. 账户新仓由同一 Codex chat 的持续安装调度发现并处理。平台原生令牌没有设置写权限，初次保护安装使用当前任务授权的短期会话权限，只在进程内注入。调度运行需要本机 Codex 可用及凭据仍有效；发现权限/平台不兼容即明确告警并保留可恢复任务，不能声称已启用。未有 main/可验证产品 CI 的仓先保留准备状态，不能把交付机制自测当成产品已验收。

安装清单保存在 .workloom-delivery-install.json，列出来源提交和每个准确资产摘要。安装器不会替换 product.manifest、WORKLOOM_PRODUCT_CONTEXT、冻结同步摘要、行业业务或标签；隔离仓不会加入 children，也不会开启业务 fanout。

命令：node scripts/delivery/queue-runner.mjs status|lease|handoff|prepare-install|verify-install|activate|reconcile|releases --repo <org/repo>。本仓执行器 CLI 和原生 CI 是行为事实源；本地测试或安装标记不能替代云端通过、合并及 activation 回执。
`;

export const REGRESSION_CNB = `"**":
  pull_request:
    - name: delivery-regression
      docker:
        image: node:24.19.0-bookworm
      stages:
        - name: Install locked delivery parser
          timeout: 120s
          script: npm ci --prefix scripts/delivery/runtime --ignore-scripts --no-audit --no-fund
        - name: Durable delivery, permissions, races and actual Git regression
          timeout: 5m
          script: node --test scripts/delivery/queue.test.mjs scripts/ci/protocol-rules.test.mjs
`;

export function appendAgentRule(text = '') {
  const start = text.split(BEGIN).length - 1; const end = text.split(END).length - 1;
  if (start !== end || start > 1) throw new Error('Ambiguous delivery instruction markers');
  if (!start) return `${text.trimEnd()}\n\n${AGENT_RULE}\n`;
  if (text.indexOf(BEGIN) > text.indexOf(END)) throw new Error('Reversed delivery instruction markers');
  return text.slice(0, text.indexOf(BEGIN)) + AGENT_RULE + text.slice(text.indexOf(END) + END.length);
}

async function safeFile(root, path) {
  const base = await realpath(root); const target = resolve(base, path);
  if (relative(base, target).startsWith('..') || path.startsWith('/') || path.includes('\\')) throw new Error('Unsafe installation path');
  let current = base;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Installation path contains a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
async function optionalFile(root, path) {
  try { return await readFile(await safeFile(root, path), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function readAssets(sourceRoot, sourceSha) {
  if (!SHA_RE.test(sourceSha ?? '')) throw new Error('Installation source must be an exact commit');
  const assets = {};
  for (const path of CORE_ASSETS) {
    const mode = await git(['ls-tree', sourceSha, '--', path], { cwd: sourceRoot });
    if (!mode.startsWith('100644 ') && !mode.startsWith('100755 ')) throw new Error(`Missing/nonregular execution asset ${path}`);
    const content = await git(['show', `${sourceSha}:${path}`], { cwd: sourceRoot, raw: true });
    if (!content.trim()) throw new Error(`Empty execution asset ${path}`);
    assets[path] = content;
  }
  assets['docs/AUTOMATIC-RD-DELIVERY.md'] = DELIVERY_DOC;
  assets['scripts/delivery/install-cnb.yml'] = REGRESSION_CNB;
  return assets;
}

/** Preflight the complete migration before writing any target file. */
export async function installationPlan({ root, assets, sourceRepo, sourceSha, repo }) {
  if (!SHA_RE.test(sourceSha ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepo ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('Invalid installation identity');
  if (CORE_ASSETS.some(path => typeof assets[path] !== 'string' || !assets[path])) throw new Error('Incomplete execution asset closure');
  const original = await optionalFile(root, '.cnb.yml');
  if (!original?.trim()) throw new Error('Repository needs an existing, verifiable main PR CI before automatic installation');
  const parsed = await resolvePipelineConfig(original, { readLocal: path => optionalFile(root, path) });
  const selector = parsed.main?.pull_request ? 'main' : parsed['**']?.pull_request ? '**' : parsed.$?.pull_request ? '$' : null;
  const existingPr = selector ? parsed[selector].pull_request : null;
  if (!Array.isArray(existingPr) || !existingPr.some(p => p.allowFailure !== true && p.name && p.stages?.length)) throw new Error('Existing product PR checks are missing');
  const YAML = await parser(); const executionAssets = { ...assets };
  // CNB selects the matching branch key. Put the added PR gates on the same
  // selector as the product instead of hiding them behind a fallback selector.
  for (const path of ['scripts/delivery/bootstrap-cnb.yml', 'scripts/delivery/install-cnb.yml']) {
    const gate = YAML.parseDocument(executionAssets[path], { maxAliasCount: 1000 });
    if (gate.errors.length || !gate.has('**')) throw new Error('Invalid installation PR gate asset');
    if (selector !== '**') { const value = gate.get('**'); gate.delete('**'); gate.set(selector, value); executionAssets[path] = gate.toString({ lineWidth: 0 }); }
  }
  const changes = new Map();
  for (const [path, content] of Object.entries(executionAssets)) {
    if (!CORE_ASSETS.includes(path) && !['docs/AUTOMATIC-RD-DELIVERY.md', 'scripts/delivery/install-cnb.yml'].includes(path)) throw new Error('Installation asset outside permitted closure');
    if (await optionalFile(root, path) !== content) changes.set(path, content);
  }
  let ci = original;
  // Tiger's product checks stay in governance; only its old root protocol calls move to the new root mechanism.
  if (repo.endsWith('/workroom-tiger')) ci = ci.replaceAll('governance/scripts/ci/protocol-rules.test.mjs', 'scripts/ci/protocol-rules.test.mjs').replaceAll('governance/scripts/ci/verify-commit-msg.mjs', 'scripts/ci/verify-commit-msg.mjs').replaceAll('governance/scripts/ci/verify-lock-conflict.mjs', 'scripts/ci/verify-lock-conflict.mjs');
  ci = (await injectDeliveryConfig(ci, { bootstrap: true })).content;
  const doc = YAML.parseDocument(ci, { maxAliasCount: 1000 });
  const value = doc.toJS({ maxAliasCount: 1000 });
  const includes = Array.isArray(value.include) ? value.include : [value.include];
  if (!includes.some(item => (typeof item === 'string' ? item : item?.path) === 'scripts/delivery/install-cnb.yml')) { doc.set('include', [...includes, 'scripts/delivery/install-cnb.yml']); ci = doc.toString({ lineWidth: 0 }); }
  const resolved = await resolvePipelineConfig(ci, { readLocal: path => executionAssets[path] ?? optionalFile(root, path) });
  const names = (resolved[selector].pull_request).filter(p => p.allowFailure !== true).map(p => p.name);
  for (const p of existingPr.filter(p => p.allowFailure !== true)) if (!names.includes(p.name)) throw new Error('Installation lost an existing required product check');
  if (!names.includes('delivery-bootstrap-review') || !names.includes('delivery-regression')) throw new Error('Installation missed required independent AI or regression');
  if (ci !== original) changes.set('.cnb.yml', ci);
  const agents = await optionalFile(root, 'AGENTS.md') ?? ''; const updated = appendAgentRule(agents);
  if (updated !== agents) changes.set('AGENTS.md', updated);
  const digests = Object.fromEntries(Object.entries(executionAssets).map(([path, text]) => [path, hash(text)]));
  let marker = { schemaVersion: 1, repo, sourceRepo, sourceSha, assets: digests, packageHash: hash(digests), isolationChanged: false };
  const oldMarker = await optionalFile(root, INSTALL_MARKER);
  if (oldMarker !== null) {
    const prior = JSON.parse(oldMarker);
    // Unrelated base commits must not generate empty metadata-only installation waves.
    if (prior.schemaVersion === 1 && prior.repo === repo && prior.sourceRepo === sourceRepo && SHA_RE.test(prior.sourceSha ?? '') && prior.packageHash === marker.packageHash && hash(prior.assets) === hash(digests) && prior.isolationChanged === false) marker = prior;
  }
  const markerText = JSON.stringify(marker, null, 2) + '\n';
  if (oldMarker !== markerText) changes.set(INSTALL_MARKER, markerText);
  for (const path of changes.keys()) await safeFile(root, path);
  return { changes, marker, requiredNames: names };
}

export async function applyInstallation(plan, root) {
  for (const [path, content] of plan.changes) {
    const target = await safeFile(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
  }
  return [...plan.changes.keys()];
}
