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

/**
 * 用 YAML 语义树验证 npm Trusted Publisher 的权限边界。这里刻意不对整份文本
 * 做正则：错误 job、注释或不可达字符串都不能替真正的 publish job“代打勾”。
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
  const publish = jobs["publish-ui"];
  if (!publish || typeof publish !== "object") return ["UI 发布 workflow 缺少独立 publish-ui job"];
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
    const rolloutPermissions = continueRollout.permissions;
    if (
      !rolloutPermissions
      || typeof rolloutPermissions !== "object"
      || Array.isArray(rolloutPermissions)
      || rolloutPermissions.contents !== "read"
      || Object.keys(rolloutPermissions).some((key) => key !== "contents")
    ) {
      risks.push("continue-rollout 必须保持 contents: read 的 job 级最小权限");
    }

    const rolloutSteps = Array.isArray(continueRollout.steps) ? continueRollout.steps : [];
    const checkout = rolloutSteps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
    if (
      !checkout
      || checkout.with?.ref !== "${{ needs.verify-and-preflight.outputs.release-sha }}"
      || checkout.with?.["fetch-tags"] !== true
      || checkout.with?.["persist-credentials"] !== false
    ) {
      risks.push("continue-rollout 必须取回稳定标签并无持久凭据地 checkout 已固定 release-sha");
    }
    const integrityIndexes = rolloutSteps
      .map((step, index) => hasExactArtifactVerificationCommand(step?.run) ? index : -1)
      .filter((index) => index >= 0);
    const writeIndex = rolloutSteps.findIndex((step) => step?.env?.SYNC_TOKEN !== undefined && hasExecutableRolloutCommand(step?.run));
    const npmCliIndex = rolloutSteps.findIndex(pinsArtifactNpmCli);
    if (integrityIndexes.length !== 1) {
      risks.push("continue-rollout 必须且只能执行一次固定标签 dist.integrity 预校验");
    } else {
      const integrityStep = rolloutSteps[integrityIndexes[0]];
      if (integrityStep.env?.STABLE_VERSION !== "${{ needs.verify-and-preflight.outputs.release-version }}") {
        risks.push("continue-rollout 完整性预校验必须消费已固定 release-version");
      }
      if (integrityStep.env?.SYNC_TOKEN !== undefined) {
        risks.push("continue-rollout 完整性预校验不得接触跨仓写入 token");
      }
      if (writeIndex < 0 || integrityIndexes[0] >= writeIndex) {
        risks.push("continue-rollout 必须先通过 dist.integrity 预校验，再允许跨仓写入");
      }
      if (npmCliIndex < 0 || npmCliIndex >= integrityIndexes[0]) {
        risks.push("continue-rollout 必须先固定 npm 11.6.2，再复算稳定制品完整性");
      }
    }
  }

  if (!needsJob(publish, "verify-and-preflight")) risks.push("publish-ui 必须等待 verify-and-preflight");
  const publishCondition = String(publish.if ?? "");
  if (!publishCondition.includes("github.event_name == 'push'") || !publishCondition.includes("refs/tags/ui-v")) {
    risks.push("publish-ui 只能由 ui-v* tag push 触发");
  }
  if (environmentName(publish.environment) !== "production") risks.push("publish-ui 必须绑定 production environment");
  const permissions = publish.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    risks.push("publish-ui 必须声明 job 级最小权限");
  } else {
    if (permissions.contents !== "read") risks.push("publish-ui 只能读取仓库内容");
    if (permissions["id-token"] !== "write") risks.push("publish-ui 缺少 Trusted Publisher 所需 id-token: write");
    const extras = Object.keys(permissions).filter((key) => !["contents", "id-token"].includes(key));
    if (extras.length) risks.push(`publish-ui 存在非发布所需权限：${extras.join("、")}`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    if (jobName !== "publish-ui" && job?.permissions?.["id-token"] === "write") {
      risks.push(`id-token: write 只能授予 publish-ui，当前还授予 ${jobName}`);
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
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/u.test(semanticText)) risks.push("UI 发布不得配置长期 npm token 或空 NODE_AUTH_TOKEN 通道");
  const publishText = JSON.stringify(publish);
  if (/\bSYNC_TOKEN\b/u.test(publishText)) risks.push("publish-ui 不得接触跨仓写入 token");

  const steps = Array.isArray(publish.steps) ? publish.steps : [];
  const setupNode = steps.filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"));
  if (setupNode.length !== 1) risks.push("publish-ui 必须且只能初始化一次 Node.js");
  else if (setupNode[0].with?.["registry-url"] !== undefined || setupNode[0].with?.["always-auth"] !== undefined) {
    risks.push("publish-ui 的 setup-node 不得生成依赖 NODE_AUTH_TOKEN 的 npmrc");
  }
  if (steps.some((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"))) {
    risks.push("publish-ui 只消费已验制品，不得 checkout 仓库代码");
  }
  if (steps.some((step) => /\bpnpm\s+install\b/u.test(String(step?.run ?? "")))) {
    risks.push("publish-ui 不得在 OIDC 权限下安装仓库依赖");
  }

  const cliIndex = steps.findIndex(pinsArtifactNpmCli);
  const publishIndex = steps.findIndex((step) => step?.name === "发布或核验完全相同的稳定 UI 制品");
  if (cliIndex < 0) risks.push("publish-ui 必须以 --ignore-scripts 固定 npm 11.6.2");
  if (publishIndex < 0) risks.push("publish-ui 缺少受控稳定制品发布步骤");
  else {
    const command = String(steps[publishIndex]?.run ?? "");
    if (steps[publishIndex]?.env?.VERSION !== "${{ needs.verify-and-preflight.outputs.release-version }}") {
      risks.push("publish-ui 必须消费 verify-and-preflight 固定的版本输出");
    }
    if (!/npm\s+publish\s+"\$\{TARBALLS\[0\]\}"\s+--access\s+public\s+--provenance\b/u.test(command)) {
      risks.push("publish-ui 必须对唯一 tarball 执行 public OIDC provenance 发布");
    }
    const registryCommands = command.match(/npm\s+(?:view|publish)\b[^\n]*/gu) ?? [];
    if (registryCommands.length !== 3
      || registryCommands.some((line) => !line.includes("--registry=https://registry.npmjs.org"))) {
      risks.push("publish-ui 的查询、发布与确认必须全部显式固定官方 npmjs registry");
    }
    if (cliIndex >= publishIndex) risks.push("publish-ui 必须先固定 npm CLI，再执行发布");
  }

  const verify = jobs["verify-and-preflight"];
  const verifySteps = Array.isArray(verify?.steps) ? verify.steps : [];
  const releaseMetadataGate = verifySteps.find((step) => step?.name === "校验 UI 标签、稳定版本登记与包版本一致");
  const releaseMetadataCommand = String(releaseMetadataGate?.run ?? "");
  if (!releaseMetadataCommand.includes('p.publishConfig?.registry!=="https://registry.npmjs.org"')
    || !releaseMetadataCommand.includes('p.publishConfig?.access!=="public"')) {
    risks.push("verify-and-preflight 必须从标签固定 @workloom/ui 的 npmjs/public publishConfig");
  }
  const verifyCliIndex = verifySteps.findIndex(pinsArtifactNpmCli);
  const packIndex = verifySteps.findIndex((step) => step?.name === "生成待发布的不可变 UI 制品");
  if (verifyCliIndex < 0 || packIndex < 0 || verifyCliIndex >= packIndex) {
    risks.push("verify-and-preflight 必须先固定 npm 11.6.2，再生成待发布 npm pack");
  }

  const automatic = jobs["rollout-after-publish"];
  const automaticSteps = Array.isArray(automatic?.steps) ? automatic.steps : [];
  const automaticCliIndex = automaticSteps.findIndex(pinsArtifactNpmCli);
  const automaticWriteIndex = automaticSteps.findIndex((step) => step?.env?.SYNC_TOKEN !== undefined && hasExecutableRolloutCommand(step?.run));
  if (automaticCliIndex < 0 || automaticWriteIndex < 0 || automaticCliIndex >= automaticWriteIndex) {
    risks.push("rollout-after-publish 必须固定 npm 11.6.2 后再执行带完整性门禁的 rollout");
  }
  return [...new Set(risks)];
}
