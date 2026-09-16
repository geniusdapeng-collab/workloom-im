import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflowsUrl = new URL("../.github/workflows/", import.meta.url);

function workflowSteps(workflow) {
  return Object.values(workflow?.jobs ?? {}).flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
}

function executableRun(runValue) {
  return String(runValue ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function releaseWriteSignals(workflow) {
  const steps = workflowSteps(workflow);
  return steps.flatMap((step) => {
    const uses = String(step?.uses ?? "");
    const usesLower = uses.toLowerCase();
    const run = executableRun(step?.run);
    const stepText = JSON.stringify(step);
    const signals = [];
    if (usesLower.startsWith("softprops/action-gh-release@")) signals.push(usesLower);
    else if (usesLower.includes("actions/github-script@")
      && (/(?:create|update|delete)release|uploadreleaseasset/iu.test(stepText)
        || /github\.request\s*\(\s*["'`](?:POST|PATCH|PUT|DELETE)\s+\/repos\/[^"'`]*\/releases(?:\/[^"'`]*)?["'`]/iu.test(stepText))) {
      signals.push("github-script-release-write");
    } else if (uses && /(?:^|[/_-])(?:release|publish)(?:[/_@-]|$)/iu.test(usesLower)) {
      signals.push("external-release-action");
    }
    if (/\bgh\s+release\s+(?:create|upload|edit|delete)\b/u.test(run)) signals.push("gh-release-write");
    const releaseEndpoint = /(?:api|uploads)\.github\.com[^\n]*\/releases(?:\/|\b)|\brepos\/[^\s"']+\/releases(?:\/|\b)/iu.test(run);
    const writeMethod = /(?:^|\s)(?:-X|--method)(?:=|\s+)(?:POST|PATCH|PUT|DELETE)\b/iu.test(run);
    const implicitGhWrite = /\bgh\s+api\b/iu.test(run)
      && /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s+)/mu.test(run);
    const curlWrite = /\bcurl\b/iu.test(run)
      && (/(?:^|\s)-X\s*(?:POST|PATCH|PUT|DELETE)\b/iu.test(run)
        || /(?:^|\s)(?:-d|--data|--data-raw|--data-binary|--data-urlencode|--json|--form)(?:=|\s+)/mu.test(run));
    if (releaseEndpoint && (writeMethod || implicitGhWrite || curlWrite)) signals.push("release-api-write");
    if (/\b(?:create|update|delete)Release\s*\(|\buploadReleaseAsset\s*\(/u.test(run)) {
      signals.push("release-client-write");
    }
    return signals;
  });
}

function contentsWriteScopes(name, workflow) {
  const scopes = [];
  if (workflow?.permissions?.contents === "write") scopes.push(`${name}:<workflow>`);
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job?.permissions?.contents === "write") scopes.push(`${name}:${jobName}`);
  }
  return scopes;
}

test("only the two reviewed product publishers may write GitHub Releases", () => {
  const publishers = new Map();
  const writeScopes = [];
  for (const name of readdirSync(workflowsUrl).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
    const source = readFileSync(new URL(name, workflowsUrl), "utf8");
    const workflow = YAML.parse(source);
    const signals = releaseWriteSignals(workflow);
    if (signals.length) publishers.set(name, signals);
    writeScopes.push(...contentsWriteScopes(name, workflow));
  }
  assert.deepEqual([...publishers.keys()].sort(), ["build-desktop.yml", "ui-release.yml"]);
  assert.deepEqual(publishers.get("build-desktop.yml"), [
    "softprops/action-gh-release@v2",
    "softprops/action-gh-release@v2",
  ]);
  assert.deepEqual(publishers.get("ui-release.yml"), ["gh-release-write"]);
  assert.deepEqual(writeScopes.sort(), [
    "build-desktop.yml:<workflow>",
    "ui-release.yml:publish-github-release",
  ]);
});

test("release writer detector rejects common alternate and newly introduced bypasses", () => {
  const ghApi = {
    jobs: { publish: { steps: [{ run: 'gh api --method POST "repos/$GITHUB_REPOSITORY/releases" --input payload.json' }] } },
  };
  assert.deepEqual(releaseWriteSignals(ghApi), ["release-api-write"]);

  const githubScript = {
    jobs: { publish: { steps: [{ uses: "actions/github-script@v7", with: { script: "github.rest.repos.createRelease({ owner, repo })" } }] } },
  };
  assert.deepEqual(releaseWriteSignals(githubScript), ["github-script-release-write"]);

  const githubRequest = {
    jobs: { publish: { steps: [{ uses: "actions/github-script@v7", with: { script: "github.request('POST /repos/{owner}/{repo}/releases', payload)" } }] } },
  };
  assert.deepEqual(releaseWriteSignals(githubRequest), ["github-script-release-write"]);

  const externalAction = {
    jobs: { publish: { steps: [{ uses: "somevendor/release-action@v1", with: { token: "secret" } }] } },
  };
  assert.deepEqual(releaseWriteSignals(externalAction), ["external-release-action"]);

  const archivedOfficialActions = {
    jobs: { publish: { steps: [
      { uses: "actions/create-release@v1" },
      { uses: "actions/upload-release-asset@v1" },
    ] } },
  };
  assert.deepEqual(releaseWriteSignals(archivedOfficialActions), [
    "external-release-action",
    "external-release-action",
  ]);

  const curlDefaultPost = {
    jobs: { publish: { steps: [{ run: "curl --data @payload.json https://api.github.com/repos/acme/app/releases" }] } },
  };
  assert.deepEqual(releaseWriteSignals(curlDefaultPost), ["release-api-write"]);

  const unexpectedWriter = {
    permissions: { contents: "write" },
    jobs: { publish: { steps: [{ run: "echo hidden publisher" }] } },
  };
  assert.deepEqual(contentsWriteScopes("shadow.yml", unexpectedWriter), ["shadow.yml:<workflow>"]);
});

test("legacy packers and platform evidence keep read-only repository permissions", () => {
  for (const name of ["release.yml", "pack-self-contained.yml"]) {
    const source = readFileSync(new URL(name, workflowsUrl), "utf8");
    const workflow = YAML.parse(source);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.deepEqual(releaseWriteSignals(workflow), []);
    assert.match(source, /actions\/upload-artifact@v4/u);
  }
  const safety = readFileSync(new URL("safety-gate.yml", workflowsUrl), "utf8");
  const safetyWorkflow = YAML.parse(safety);
  assert.deepEqual(safetyWorkflow.permissions, { contents: "read" });
  assert.deepEqual(releaseWriteSignals(safetyWorkflow), []);
  assert.match(safety, /actions\/upload-artifact@v4/u);
});

test("local PAT publisher fails before reading credentials or touching the network", () => {
  const source = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
  assert.match(source, /本地\/长期令牌 Release 通道已封禁/u);
  assert.match(source, /exit 1/u);
  assert.doesNotMatch(source, /GH_TOKEN|api\.github\.com|uploads\.github\.com|\bcurl\b|\bgh\s+release\b/u);
});

test("UI release is assembled as non-latest draft and published only after byte verification", () => {
  const workflow = YAML.parse(readFileSync(new URL("ui-release.yml", workflowsUrl), "utf8"));
  const publisher = workflow.jobs["publish-github-release"];
  assert.deepEqual(publisher.permissions, { contents: "write" });
  const releaseStep = publisher.steps.find((step) => step.name === "发布或逐字节核验 GitHub Release 稳定制品");
  assert.ok(releaseStep);
  const run = releaseStep.run;
  const create = run.indexOf("--draft --latest=false");
  const upload = run.indexOf('gh release upload "$RELEASE_TAG"');
  const byteCheck = run.indexOf('cmp -s "$TARBALL"');
  const publish = run.indexOf('--draft=false --latest=false');
  assert.ok(create >= 0 && upload > create && byteCheck > upload && publish > byteCheck);
  assert.match(run, /--draft=true --latest=false/u);
  assert.match(run, /Release 最终状态必须公开且非预发布/u);
});
