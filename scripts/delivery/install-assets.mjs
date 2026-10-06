/** The installer copies only the execution closure, never product or fleet membership assets. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { git } from './git-state.mjs';
import { hash, SHA_RE, validRepoSlug } from './queue-model.mjs';
import { injectDeliveryConfig } from './install-config.mjs';
import { parser, resolvePipelineConfig } from './queue-policy.mjs';
import { preserveBoundProtocol, PROTOCOL_ADDITIONAL_ASSETS } from './install-protocol.mjs';
import { INVENTORY_DOCUMENT, refreshTargetInventory, verifyInventoryCheckout } from './install-inventory.mjs';
import { CORE_ASSETS, INSTALL_MARKER, packageDigest, TIGER_ALIASES } from './install-manifest.mjs';
export { CORE_ASSETS, INSTALL_MARKER } from './install-manifest.mjs';
const BEGIN = '<!-- WORKLOOM-RD-DELIVERY:BEGIN -->';
const END = '<!-- WORKLOOM-RD-DELIVERY:END -->';
export const AGENT_RULE = `${BEGIN}
## 普通研发自动交付（产品所有者 2026-10-06 现行授权）

普通研发由当前 Codex 会话完成代码审查与实测，再由原仓必需 CI 和持久化交付器完成；不要求用户逐 PR 点击 Approve。普通重叠只提示；敏感开发使用有期限的 owner/generation 租约，交接后释放。采用本仓 docs/AUTOMATIC-RD-DELIVERY.md 的现行研发规则，替代旧协议中按 open PR 编号永久占锁、普通研发必须人工放行与治理代码不可自动交付的条款。

当前 Codex 的实际审查/测试回执、现行机器门禁与 source/main/policy/完整文件覆盖证据均须成立；禁止调用 CNB、GitHub 等平台的 AI 审核、模型或 NPC 自动修复服务；禁止伪造批准、强制合并或直推 main。每个已验证修复及时独立提交推送，交付器持续完成集成和声明的发布，不等后续功能凑批。真实资金/实盘、生产秘密、客户数据、群发及不可逆经营动作仍按业务围栏另行授权。

此本仓安装只涉及研发机制，不改变行业身份、隔离登记、冻结上游认知或业务同步。两个隔离副本独立使用本机制，继续双向不同步。原仓其他指令、必需测试、产品边界与秘密不落盘纪律保留。
${END}`;

export const DELIVERY_DOC = `# 普通研发自动交付

产品所有者于 2026-10-06 现行授权十二仓及账户新增项目安装同一研发交付机制，并于 2026-10-06 撤销平台付费 AI 审核，要求当前 Codex 自带模型在提交/发布前完成 review 和测试。这个补充只调整普通研发的并发、审核与交付规则；它优先于旧开发协议中相应的人工批准和永久 open PR 互斥条款。其他产品、安全、隔离与经营规则继续适用。

1. 开发者每项任务使用独立分支/PR，声明准确路径和验收。普通文件重叠只提示；敏感模块的开发租约有 owner、generation 和默认 15 分钟期限，等待 CI/审查前须用 lease --action release 显式释放准确 owner/generation。任务号或 ready 描述不能自行释放租约。main 接纳执行器自动取得并释放敏感源码的短期 fenced generation；此接纳回执与合并前集成租约均为硬门禁。
2. 每次验证一个修复后及时提交推送。用 queue-runner handoff --review-receipt <实际审查记录.json> 声明 ready 和真实 depends_on；没有准确回执的遗留 PR 保持等待。WIP、risk/block 与真实业务动作不会被研发授权放行。
3. 原仓必需 CI 必须针对准确 source/main 全绿。当前 Codex 精读所有变化文件及直接依赖、运行必要测试并填写完整结构化回执；每个 CI 实现变化须有准确 id 的迁移依据。不可修改候选分支再跑原仓 CI，准确会话回执与完整 CI 共同成立，才能普通 merge；source/main 漂移即重做。
4. main 原生执行器每 5 分钟恢复，仓级原生锁只串行实际集成。敏感候选合并前强制取得并核验 fenced 集成租约。失败任务单独保留；语义冲突、权限不足、未知写入不会伪装成功或重复外部动作。
5. automation/delivery-state 通过普通 fast-forward CAS 保存只增事件、租约、尝试、Codex 审查/测试与集成证明。丢失响应先回读 transaction id。UI/桌面声明的发布使用独立执行器与固定 SHA/版本，核验构建、tag、manifest 与实际字节；没有发布回执不关完成任务。
6. 首装由具备设置权限的安装端创建并回读强保护账本、准备准确安装 source/main，随后运行准确安装资产/账本的 bootstrap 检查和原有门禁。完成 Codex 会话审查实测后普通合入，在当前 main activate 回读会话证明、真实测试和候选/主干保护，并取消额外管理员点击批准要求。源 PR 原生令牌实测只读，原生 main 运行；会话凭据不写进 CI 或文件。
7. 账户安装器只位于来源仓 workloom-ai/workloom-im，不复制到行业仓或隔离副本。先在已激活的基座主干目录执行 node scripts/delivery/install-account.mjs --source-root <该基座主干目录> --directory <本任务专用安装目录> --concurrency 2；本仓日常使用下列 queue-runner 命令。安装器调用 install-config 为目标追加 include，并在完整目标检出中离线刷新目标自身开源清单。平台原生令牌没有设置写权限，初次保护安装使用当前任务授权的短期会话权限，只在进程内注入。安装运行需要凭据仍有效；发现权限/平台不兼容即明确告警并保留可恢复任务，不能声称已启用。未有 main/可验证产品 CI 的仓先保留准备状态，不能把交付机制自测当成产品已验收。未来自动发现需要另行启用账户安装调度；本机制不自行创建 Codex chat 定时任务，用户取消的任务保持取消。

安装清单保存在 .workloom-delivery-install.json，列出来源提交和每个准确资产摘要。安装器不会替换 product.manifest、WORKLOOM_PRODUCT_CONTEXT、冻结同步摘要、行业业务或标签；隔离仓不会加入 children，也不会开启业务 fanout。

命令：node scripts/delivery/queue-runner.mjs status|lease|handoff|verify-review|prepare-install|verify-install|activate|reconcile|releases --repo <org/repo>。本仓执行器 CLI 和原生 CI 是行为事实源；会话审查回执不代表平台 AI 批准，也不调用外部模型；本地测试或安装标记不能替代云端通过、合并及 activation 回执。
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

/** A sparse installer checkout may omit a valid existing include outside its cone. */
async function localInclude(root, path) {
  const content = await optionalFile(root, path);
  if (content !== null) return content;
  const entry = await git(['ls-tree', 'HEAD', '--', path], { cwd: root });
  if (!entry) return null;
  if (!entry.startsWith('100644 ') && !entry.startsWith('100755 ')) throw new Error('CI include is not a regular tracked file');
  return git(['show', `HEAD:${path}`], { cwd: root, raw: true });
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
  if (!SHA_RE.test(sourceSha ?? '') || !validRepoSlug(sourceRepo) || !validRepoSlug(repo)) throw new Error('Invalid installation identity');
  if (CORE_ASSETS.some(path => typeof assets[path] !== 'string' || !assets[path])) throw new Error('Incomplete execution asset closure');
  const original = await optionalFile(root, '.cnb.yml');
  if (!original?.trim()) throw new Error('Repository needs an existing, verifiable main PR CI before automatic installation');
  const parsed = await resolvePipelineConfig(original, { readLocal: path => localInclude(root, path) });
  const selector = parsed.main?.pull_request ? 'main' : parsed['**']?.pull_request ? '**' : parsed.$?.pull_request ? '$' : null;
  const existingPr = selector ? parsed[selector].pull_request : null;
  if (!Array.isArray(existingPr) || !existingPr.some(p => p.allowFailure !== true && p.name && p.stages?.length)) throw new Error('Existing product PR checks are missing');
  const YAML = await parser();
  const protocol = await preserveBoundProtocol({ ...assets }, path => optionalFile(root, path));
  const executionAssets = protocol.assets;
  if (repo.endsWith('/workroom-tiger')) {
    for (const path of TIGER_ALIASES) {
      const name = path.split('/').at(-1);
      // This specifier belongs to the generated governance file, not this installer.
      const canonicalProtocol = JSON.stringify('../../../scripts/ci/' + name);
      if (name === 'protocol-rules.mjs') executionAssets[path] = `// Canonical root delivery protocol; governance must not resurrect the superseded open-PR lock.\nexport * from ${canonicalProtocol};\n`;
      else if (name === 'protocol-rules.test.mjs') executionAssets[path] = `// Run the same canonical assertions from either legacy or root entry point.\nimport ${canonicalProtocol};\n`;
      else executionAssets[path] = `// Legacy CLI delegates to the canonical root and preserves its real exit status.\nimport { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nconst result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/ci/${name}', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });\nif (result.error || result.signal || result.status === null) { console.error('Canonical protocol CLI could not complete'); process.exitCode = 1; }\nelse process.exitCode = result.status;\n`;
    }
  }
  // CNB selects the matching branch key. Put the added PR gates on the same
  // selector as the product instead of hiding them behind a fallback selector.
  for (const path of ['scripts/delivery/bootstrap-cnb.yml', 'scripts/delivery/install-cnb.yml']) {
    const gate = YAML.parseDocument(executionAssets[path], { maxAliasCount: 1000 });
    if (gate.errors.length || !gate.has('**')) throw new Error('Invalid installation PR gate asset');
    if (path.endsWith('bootstrap-cnb.yml')) {
      const pipeline = gate.getIn(['**', 'pull_request', 0]); pipeline.set('name', 'delivery-bootstrap-checks');
      const stages = pipeline.get('stages');
      stages.get(2).set('name', 'Verify exact installation source, ledger and assets');
      stages.get(3).set('name', 'Validate tracked installation verifier');
      stages.get(4).set('name', 'Validate disabled legacy platform entry');
      stages.get(5).set('name', 'Verify session record when applicable');
    }
    if (selector !== '**') { const value = gate.get('**'); gate.delete('**'); gate.set(selector, value); }
    executionAssets[path] = gate.toString({ lineWidth: 0 });
  }
  const changes = new Map();
  for (const [path, content] of Object.entries(executionAssets)) {
    if (!CORE_ASSETS.includes(path) && !['docs/AUTOMATIC-RD-DELIVERY.md', 'scripts/delivery/install-cnb.yml', ...(protocol.preserved ? PROTOCOL_ADDITIONAL_ASSETS : []), ...(repo.endsWith('/workroom-tiger') ? TIGER_ALIASES : [])].includes(path)) throw new Error('Installation asset outside permitted closure');
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
  const resolved = await resolvePipelineConfig(ci, { readLocal: path => executionAssets[path] ?? localInclude(root, path) });
  const names = (resolved[selector].pull_request).filter(p => p.allowFailure !== true).map(p => p.name);
  for (const p of existingPr.filter(p => p.allowFailure !== true)) if (!names.includes(p.name)) throw new Error('Installation lost an existing required product check');
  if (!names.includes('delivery-bootstrap-checks') || !names.includes('delivery-regression')) throw new Error('Installation missed required bootstrap checks or regression');
  if (ci !== original) changes.set('.cnb.yml', ci);
  const agents = await optionalFile(root, 'AGENTS.md') ?? ''; const updated = appendAgentRule(agents);
  if (updated !== agents) changes.set('AGENTS.md', updated);
  const digests = Object.fromEntries(Object.entries(executionAssets).map(([path, text]) => [path, hash(text)]));
  let marker = { schemaVersion: 2, repo, sourceRepo, sourceSha, assets: digests, packageHash: packageDigest(digests), isolationChanged: false };
  const oldMarker = await optionalFile(root, INSTALL_MARKER);
  if (oldMarker !== null) {
    const prior = JSON.parse(oldMarker);
    // Unrelated base commits must not generate empty metadata-only installation waves.
    if (prior.schemaVersion === 2 && prior.repo === repo && prior.sourceRepo === sourceRepo && SHA_RE.test(prior.sourceSha ?? '') && prior.packageHash === marker.packageHash && packageDigest(prior.assets) === packageDigest(digests) && prior.isolationChanged === false) marker = prior;
  }
  const markerText = JSON.stringify(marker, null, 2) + '\n';
  if (oldMarker !== markerText) changes.set(INSTALL_MARKER, markerText);
  for (const path of changes.keys()) await safeFile(root, path);
  const generatedPaths = changes.size && await optionalFile(root, 'scripts/oss-inventory.mjs') !== null ? [INVENTORY_DOCUMENT] : [];
  if (generatedPaths.length) await verifyInventoryCheckout(root);
  for (const path of generatedPaths) await safeFile(root, path);
  return { changes, marker, requiredNames: names, generatedPaths };
}

export async function applyInstallation(plan, root) {
  const inventoryBefore = plan.generatedPaths?.length ? await optionalFile(root, INVENTORY_DOCUMENT) : null;
  for (const [path, content] of plan.changes) {
    const target = await safeFile(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
  }
  if (plan.generatedPaths?.length) {
    const content = await refreshTargetInventory(root);
    if (content !== inventoryBefore) plan.changes.set(INVENTORY_DOCUMENT, content);
  }
  return [...plan.changes.keys()];
}
