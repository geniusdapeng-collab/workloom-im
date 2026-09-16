import YAML from "yaml";

function environmentName(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" ? value.name : "";
}

function needsJob(job, name) {
  const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs].filter(Boolean);
  return needs.includes(name);
}

function executableLines(runValue) {
  return String(runValue ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function hasExecutableRolloutCommand(runValue) {
  const run = executableLines(runValue).join("\n");
  if (/^\s*node\s+sync\/ui-upgrade-pr\.mjs\b[^\n]*\s--rollout(?:\s|$)/mu.test(run)) return true;
  const args = /^\s*ARGS=\(\s*--rollout(?:\s+[^)\n]*)?\)\s*$/mu.exec(run);
  const invocation = /^\s*node\s+sync\/ui-upgrade-pr\.mjs\s+"\$\{ARGS\[@\]\}"\s*$/mu.exec(run);
  return Boolean(args && invocation && (args.index ?? -1) < (invocation.index ?? -1));
}

function hasExactArtifactVerificationCommand(runValue) {
  const lines = executableLines(runValue);
  return lines.length === 1
    && /^node\s+sync\/ui-upgrade-pr\.mjs\s+--verify-artifact\s+--version\s+"\$STABLE_VERSION"$/u.test(lines[0]);
}

function pinsArtifactNpmCli(step) {
  return /^npm\s+install\s+--global\s+--ignore-scripts\s+npm@11\.6\.2$/u.test(
    executableLines(step?.run).join("\n"),
  );
}

function exactContentsPermission(job, value) {
  const permissions = job?.permissions;
  return Boolean(
    permissions
    && typeof permissions === "object"
    && !Array.isArray(permissions)
    && permissions.contents === value
    && Object.keys(permissions).every((key) => key === "contents"),
  );
}

function fixedReleaseCheckout(steps) {
  return steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
}

function validateRolloutCheckout(checkout, jobName, risks) {
  if (
    !checkout
    || checkout.with?.ref !== "${{ needs.verify-and-preflight.outputs.release-sha }}"
    || checkout.with?.["fetch-tags"] !== true
    || checkout.with?.["persist-credentials"] !== false
  ) {
    risks.push(`${jobName} 必须取回稳定标签并无持久凭据地 checkout 已固定 release-sha`);
  }
}

/**
 * 用 YAML 语义树验证 GitHub Release 稳定制品发布边界。错误 job、注释、
 * 浮动权限或仅写在字符串里的命令都不能替真正的 production 发布 job 代打勾。
 */
export function findUiReleaseWorkflowRisks(source) {
  let workflow;
  try {
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) return document.errors.map((error) => `UI 发布 workflow YAML 无效：${error.message}`);
    workflow = document.toJS();
  } catch (error) {
    return [`UI 发布 workflow YAML 无效：${String(error?.message ?? error)}`];
  }

  const risks = [];
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return ["UI 发布 workflow 缺少 jobs 映射"];
  if (workflow?.concurrency?.group !== "shared-ui-release-${{ github.ref }}"
    || workflow?.concurrency?.["cancel-in-progress"] !== false) {
    risks.push("UI 发布 workflow 必须按 ref 串行且不得取消正在进行的稳定发布");
  }

  const verify = jobs["verify-and-preflight"];
  if (!verify || typeof verify !== "object") risks.push("UI 发布 workflow 缺少 verify-and-preflight job");
  const publisher = jobs["publish-github-release"];
  if (!publisher || typeof publisher !== "object") risks.push("UI 发布 workflow 缺少独立 publish-github-release job");
  if (jobs["publish-ui"] !== undefined) risks.push("UI 发布 workflow 不得保留 npm publish-ui 旁路 job");

  for (const [jobName, job] of Object.entries(jobs)) {
    if (job?.permissions?.["id-token"] !== undefined) {
      risks.push(`${jobName} 不得申请 npm OIDC id-token 权限`);
    }
    if (job?.env?.SYNC_TOKEN !== undefined) risks.push(`${jobName} 不得在 job scope 注入 SYNC_TOKEN`);
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (step?.env?.SYNC_TOKEN === undefined) continue;
      if (!hasExecutableRolloutCommand(step.run)) {
        risks.push(`${jobName} 只能在实际写 rollout 的 step 注入 SYNC_TOKEN`);
      }
    }
  }

  const semanticText = JSON.stringify(workflow);
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/u.test(semanticText)) {
    risks.push("GitHub Release 发布不得配置 npm 长期令牌或 NODE_AUTH_TOKEN 通道");
  }
  if (/npm\s+(?:publish|view)\b/u.test(semanticText)) {
    risks.push("GitHub Release 发布闭环不得调用 npm publish/view registry 通道");
  }

  if (publisher && typeof publisher === "object") {
    if (!needsJob(publisher, "verify-and-preflight")) {
      risks.push("publish-github-release 必须等待 verify-and-preflight");
    }
    const condition = String(publisher.if ?? "");
    if (!condition.includes("github.event_name == 'push'") || !condition.includes("refs/tags/ui-v")) {
      risks.push("publish-github-release 只能由 ui-v* tag push 触发");
    }
    if (environmentName(publisher.environment) !== "production") {
      risks.push("publish-github-release 必须绑定 production environment");
    }
    if (!exactContentsPermission(publisher, "write")) {
      risks.push("publish-github-release 必须且只能拥有 contents: write");
    }

    const publishText = JSON.stringify(publisher);
    if (/\bSYNC_TOKEN\b/u.test(publishText)) risks.push("publish-github-release 不得接触跨仓写入 token");
    if (/\bsecrets\./u.test(publishText)) risks.push("publish-github-release 不得读取长期仓库 secret");

    const steps = Array.isArray(publisher.steps) ? publisher.steps : [];
    if (steps.some((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"))) {
      risks.push("publish-github-release 只消费已验制品，不得 checkout 仓库代码");
    }
    if (steps.some((step) => /\b(?:pnpm|npm)\s+install\b/u.test(String(step?.run ?? "")))) {
      risks.push("publish-github-release 不得在 contents: write 权限下安装依赖");
    }
    const downloads = steps.filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@"));
    if (downloads.length !== 1 || downloads[0]?.with?.name !== "workloom-ui-package") {
      risks.push("publish-github-release 必须且只能下载 verify job 的 workloom-ui-package 制品");
    }

    const releaseStep = steps.find((step) => step?.name === "发布或逐字节核验 GitHub Release 稳定制品");
    if (!releaseStep) {
      risks.push("publish-github-release 缺少受控 GitHub Release 发布步骤");
    } else {
      if (releaseStep.env?.GH_TOKEN !== "${{ github.token }}") {
        risks.push("publish-github-release 必须只使用当前 run 的短期 github.token");
      }
      if (releaseStep.env?.VERSION !== "${{ needs.verify-and-preflight.outputs.release-version }}"
        || releaseStep.env?.RELEASE_TAG !== "${{ needs.verify-and-preflight.outputs.release-tag }}"
        || releaseStep.env?.RELEASE_SHA !== "${{ needs.verify-and-preflight.outputs.release-sha }}") {
        risks.push("publish-github-release 必须消费 verify-and-preflight 固定的版本、标签与提交");
      }
      const command = executableLines(releaseStep.run).join("\n");
      const requiredFragments = [
        'EXPECTED_ASSET="workloom-ui-${VERSION}.tgz"',
        'test "${#TARBALLS[@]}" -eq 1',
        'test "$LOCAL_INTEGRITY" = "$PACK_INTEGRITY"',
        'gh release view "$RELEASE_TAG"',
        'gh release create "$RELEASE_TAG"',
        "--verify-tag",
        '--target "$RELEASE_SHA"',
        "--raw-field make_latest=false",
        'test "$LATEST_TAG" != "$RELEASE_TAG"',
        'gh release upload "$RELEASE_TAG" "$TARBALL"',
        'gh release download "$RELEASE_TAG"',
        'test "$REMOTE_INTEGRITY" = "$LOCAL_INTEGRITY"',
        'cmp -s "$TARBALL" "$REMOTE_DIR/$EXPECTED_ASSET"',
      ];
      for (const fragment of requiredFragments) {
        if (!command.includes(fragment)) risks.push(`GitHub Release 幂等发布缺少受控动作：${fragment}`);
      }
      if (!command.includes("createHash(\"sha512\")") || !command.includes("pack-metadata.json")) {
        risks.push("GitHub Release 发布必须以 tarball 实算 sha512 并核对 pack metadata");
      }
      if (!command.includes('if(tgz.length>1) throw new Error("Release 不得包含多个 tgz 制品")')) {
        risks.push("GitHub Release 必须拒绝同一稳定版出现多个 tgz 制品");
      }
    }
  }

  const verifySteps = Array.isArray(verify?.steps) ? verify.steps : [];
  const releaseMetadataGate = verifySteps.find((step) => step?.name === "校验 UI 标签、稳定版本登记与 GitHub Release 分发契约");
  const releaseMetadataCommand = String(releaseMetadataGate?.run ?? "");
  for (const fragment of [
    'p.private!==true||p.publishConfig!==undefined',
    'd?.type!=="github-release-tarball"',
    "releases/download/ui-v{version}/workloom-ui-{version}.tgz",
    'd?.assetNameTemplate!=="workloom-ui-{version}.tgz"',
    "d?.integrityByVersion?.[v]",
  ]) {
    if (!releaseMetadataCommand.includes(fragment)) {
      risks.push("verify-and-preflight 必须关闭 npm publish 并从固定标签校验 GitHub Release 分发模板与 sha512 登记");
      break;
    }
  }
  const verifyCliIndex = verifySteps.findIndex(pinsArtifactNpmCli);
  const packIndex = verifySteps.findIndex((step) => step?.name === "生成待发布的不可变 UI 制品");
  if (verifyCliIndex < 0 || packIndex < 0 || verifyCliIndex >= packIndex) {
    risks.push("verify-and-preflight 必须先固定 npm 11.6.2，再生成待发布 npm pack");
  } else {
    const packCommand = String(verifySteps[packIndex]?.run ?? "");
    const explicitPrepackIndex = packCommand.indexOf("pnpm -C packages/ui run prepack");
    const inertPackIndex = packCommand.indexOf("npm pack --ignore-scripts --json");
    const metadataVerificationIndex = packCommand.indexOf("meta[0]?.integrity!==registered");
    if (explicitPrepackIndex < 0 || inertPackIndex <= explicitPrepackIndex || metadataVerificationIndex <= inertPackIndex) {
      risks.push("verify-and-preflight 必须先显式运行 UI prepack，再用 --ignore-scripts 生成纯净 JSON metadata，最后校验 manifest");
    }
    if (!packCommand.includes("meta[0]?.integrity!==registered") || !packCommand.includes("integrityByVersion")) {
      risks.push("verify-and-preflight 必须在上传前核对 pack metadata 与受控 manifest sha512");
    }
  }

  const automatic = jobs["rollout-after-release"];
  if (!automatic || typeof automatic !== "object") {
    risks.push("UI 发布 workflow 缺少 rollout-after-release job");
  } else {
    if (!needsJob(automatic, "verify-and-preflight") || !needsJob(automatic, "publish-github-release")) {
      risks.push("rollout-after-release 必须等待验证与 GitHub Release 发布完成");
    }
    if (environmentName(automatic.environment) !== "production") {
      risks.push("rollout-after-release 必须绑定 production environment");
    }
    if (!exactContentsPermission(automatic, "read")) {
      risks.push("rollout-after-release 必须保持 contents: read 的 job 级最小权限");
    }
    const steps = Array.isArray(automatic.steps) ? automatic.steps : [];
    validateRolloutCheckout(fixedReleaseCheckout(steps), "rollout-after-release", risks);
    if (JSON.stringify(automatic).includes("SYNC_TOKEN") || steps.some((step) => hasExecutableRolloutCommand(step?.run))) {
      risks.push("自动 tag rollout 不得保存跨仓 token 或直接写入八仓");
    }
    const integrityIndexes = steps.map((step, index) => hasExactArtifactVerificationCommand(step?.run) ? index : -1).filter((index) => index >= 0);
    const npmCliIndex = steps.findIndex(pinsArtifactNpmCli);
    if (integrityIndexes.length !== 1) {
      risks.push("rollout-after-release 必须且只能执行一次 GitHub Release sha512 预校验");
    } else if (npmCliIndex < 0 || npmCliIndex >= integrityIndexes[0]) {
      risks.push("rollout-after-release 必须先固定 npm 11.6.2，再复算稳定制品完整性");
    }
  }

  const continueRollout = jobs["continue-rollout"];
  if (!continueRollout || typeof continueRollout !== "object") {
    risks.push("UI 发布 workflow 缺少受控 continue-rollout job");
  } else {
    if (!needsJob(continueRollout, "verify-and-preflight")) {
      risks.push("continue-rollout 必须等待 verify-and-preflight 固定稳定标签");
    }
    const condition = String(continueRollout.if ?? "");
    if (!condition.includes("github.event_name == 'workflow_dispatch'") || !condition.includes("inputs.action == 'rollout'")) {
      risks.push("continue-rollout 只能由手动 rollout 请求触发");
    }
    if (environmentName(continueRollout.environment) !== "production") {
      risks.push("continue-rollout 必须绑定 production environment");
    }
    if (!exactContentsPermission(continueRollout, "read")) {
      risks.push("continue-rollout 必须保持 contents: read 的 job 级最小权限");
    }

    const steps = Array.isArray(continueRollout.steps) ? continueRollout.steps : [];
    validateRolloutCheckout(fixedReleaseCheckout(steps), "continue-rollout", risks);
    const integrityIndexes = steps.map((step, index) => hasExactArtifactVerificationCommand(step?.run) ? index : -1).filter((index) => index >= 0);
    const writeIndex = steps.findIndex((step) => step?.env?.SYNC_TOKEN !== undefined && hasExecutableRolloutCommand(step?.run));
    const npmCliIndex = steps.findIndex(pinsArtifactNpmCli);
    if (integrityIndexes.length !== 1) {
      risks.push("continue-rollout 必须且只能执行一次 GitHub Release sha512 预校验");
    } else {
      const integrityStep = steps[integrityIndexes[0]];
      if (integrityStep.env?.STABLE_VERSION !== "${{ needs.verify-and-preflight.outputs.release-version }}") {
        risks.push("continue-rollout 完整性预校验必须消费已固定 release-version");
      }
      if (integrityStep.env?.SYNC_TOKEN !== undefined) {
        risks.push("continue-rollout 完整性预校验不得接触跨仓写入 token");
      }
      if (writeIndex < 0 || integrityIndexes[0] >= writeIndex) {
        risks.push("continue-rollout 必须先通过 GitHub Release sha512 预校验，再允许跨仓写入");
      }
      if (npmCliIndex < 0 || npmCliIndex >= integrityIndexes[0]) {
        risks.push("continue-rollout 必须先固定 npm 11.6.2，再复算稳定制品完整性");
      }
    }
  }

  return [...new Set(risks)];
}
