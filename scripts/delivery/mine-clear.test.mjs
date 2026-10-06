#!/usr/bin/env node
/**
 * 排雷式交付执行器自测（node --test）。
 * 覆盖：基线登记 / 不变量提取 / 卡片校验（断言前置、不可验收措辞、修复者不自验）/
 *       P0 未闭环闸门 / 四批计划与冲突面 / 基线漂移识别 / RDAS 交接单。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { bindArtifact, hashBytes } from "./evidence.mjs";

const CLI = fileURLToPath(new URL("./mine-clear.mjs", import.meta.url));
const TASK = "T-2026-0929-0001";
const repos = [];
after(() => repos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function run(args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo({ withAgents = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mine-clear-"));
  repos.push(dir);
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@workloom.local"]);
  git(dir, ["config", "user.name", "Mine Clear Test"]);
  writeFileSync(join(dir, "README.md"), "# 测试仓\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), "outputs/\n", "utf8");
  if (withAgents) {
    writeFileSync(
      join(dir, "AGENTS.md"),
      [
        "# WorkLoom 仓库开发指引",
        "",
        "## 4. 系统不变量",
        "",
        "1. 租户边界覆盖数据库 RLS、运行时上下文、事件、缓存和外部连接器。",
        "2. 没有真实回执就不能标记完成。",
        "",
        "## 5. Base-sync 与子仓规则",
        "",
        "- 共享基线只在 workloom-im 修改。",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", `chore(base): 初始化测试仓 [${TASK}]`]);
  return dir;
}

function initLedger(dir, { task = TASK, extra = [] } = {}) {
  const result = run(["init", "--repo", dir, "--task", task, "--no-fetch", ...extra], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return join(dir, "outputs", "mine-clear", task, "ledger.json");
}

function problemCard(dir, overrides = {}) {
  const commit = git(dir, ["rev-parse", "HEAD"]);
  return {
    id: "MC-001",
    kind: "problem",
    level: "L1",
    severity: "P1",
    batch: 2,
    state: "open",
    title: "高危审批只按序号映射，内容从不比对",
    evidence: [{ type: "code", ref: `README.md:1@${commit}`, sha256: hashBytes(readFileSync(join(dir, "README.md"))), note: "真实隔离仓中的提交 blob" }],
    root_cause: { file: "README.md", line: 1, commit, symbol: "fixture" },
    trigger_path: "任意来源的高危审批批量提交时",
    assertions: [
      { kind: "sample", given: "隔离仓的实际进程", expect: "进程断言通过并返回 0", command: "node -e fixture-sample", exec: { file: process.execPath, args: ["-e", "console.log('fixture sample passed')"] }, last_result: "not-run" },
      { kind: "property", given: "任意 fixture 值", expect: "实际属性断言通过并返回 0", command: "node -e fixture-property", exec: { file: process.execPath, args: ["-e", "require('node:assert/strict').equal(1+1,2);console.log('fixture property passed')"] }, last_result: "not-run" },
    ],
    regression: { command: "node --test scripts/delivery/mine-clear.test.mjs" },
    notes: "",
    ...overrides,
  };
}

function writeCard(dir, name, card) {
  const path = join(dir, "outputs", "cards", name);
  mkdirSync(join(dir, "outputs", "cards"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, "utf8");
  return path;
}

function alignLedger(dir, ledgerPath) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")); const commit = git(dir, ["rev-parse", "HEAD"]);
  ledger.baseline.repair.commit = commit; ledger.baseline.acceptance.commit = commit;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

function closeCard(dir, ledgerPath, id) {
  const common = ["run-assertions", "--ledger", ledgerPath, "--card", id, "--repo", dir];
  for (const [actor, role] of [["session-fix-1", "repair"], ["session-verify-2", "acceptance"]]) {
    const result = run([...common, "--actor", actor, "--role", role], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
  }
  return JSON.parse(readFileSync(ledgerPath, "utf8")).cards.find((card) => card.id === id);
}

test("help 暴露触发关键词与子命令", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  for (const keyword of ["mine-clear", "排雷", "init", "handoff", "verify-baseline"]) {
    assert.ok(result.stdout.includes(keyword), `帮助缺少 ${keyword}`);
  }
});

test("init 记录审计基线并生成台账骨架", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const baseline = JSON.parse(readFileSync(join(dir, "outputs", "mine-clear", TASK, "baseline.json"), "utf8"));
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(baseline.audit.commit, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(ledger.schema, "workloom.mine-clear/ledger@1");
  assert.equal(ledger.task_id, TASK);
  assert.equal(ledger.cards.length, 0);
  assert.equal(run(["init", "--repo", dir, "--task", TASK, "--no-fetch"]).status, 2, "重复 init 未加 --force 应当拒绝");
});

test("invariants 从 AGENTS.md §4 提取不变量", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const result = run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.invariants.length, 2);
  assert.equal(ledger.invariants[0].id, "INV-1");
  assert.match(ledger.invariants[0].source, /AGENTS\.md#4\.1/);
});

test("card-template 输出可直接使用的模板", () => {
  for (const kind of ["problem", "fix"]) {
    const result = run(["card-template", "--kind", kind]);
    assert.equal(result.status, 0);
    const card = JSON.parse(result.stdout);
    assert.equal(card.kind, kind);
    assert.ok(card.assertions.length >= 2, "模板必须含样例与属性断言位");
  }
});

test("add 拒绝没有可运行断言的卡", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const card = problemCard(dir, { assertions: [{ kind: "sample", given: "输入", expect: "结果", command: "" }] });
  const path = writeCard(dir, "bad-card.json", card);
  const result = run(["add", "--ledger", ledgerPath, "--card", path], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /assertions/);
});

test("add 拒绝不可验收措辞（优化/提升/加强）", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const card = problemCard(dir, {
    assertions: [{ kind: "sample", given: "输入", expect: "提升安全性", command: "npm test" }],
  });
  const path = writeCard(dir, "vague-card.json", card);
  const result = run(["add", "--ledger", ledgerPath, "--card", path], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不可验收措辞/);
});

test("add 拒绝代码类证据缺少 @commit", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const card = problemCard(dir, { evidence: [{ type: "code", ref: "README.md:1", sha256: hashBytes(readFileSync(join(dir, "README.md"))), note: "没有基线" }] });
  const path = writeCard(dir, "no-commit.json", card);
  const result = run(["add", "--ledger", ledgerPath, "--card", path], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@<commit>/);
});

test("gate 对 P0 未闭环判红，对完全闭环放行", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const card = problemCard(dir, { severity: "P0" });
  const path = writeCard(dir, "p0.json", card);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", path], { cwd: dir }).status, 0);
  const red = run(["gate", "--ledger", ledgerPath, "--json"], { cwd: dir });
  assert.equal(red.status, 1);
  assert.match(red.stdout, /P0 未闭环/);

  closeCard(dir, ledgerPath, card.id);
  const green = run(["gate", "--ledger", ledgerPath], { cwd: dir });
  assert.equal(green.status, 0, green.stderr);
});

test("gate 阻止修复者自验，只有完整独立批准来源才可豁免", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const open = problemCard(dir);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "open.json", open)], { cwd: dir }).status, 0);
  const card = closeCard(dir, ledgerPath, open.id);
  card.fixed_by = card.verified_by;
  const path = writeCard(dir, "self-verify.json", card);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", path, "--replace"], { cwd: dir }).status, 1);

  const reasonOnly = { ...card, waiver: { reason: "仓内只有一名执行者，产品所有者批准", approved_by: "product-owner" } };
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "reason-only.json", reasonOnly), "--replace"], { cwd: dir }).status, 1);
  const root = join(dir, "outputs", "mine-clear", TASK); const sourcePath = "approvals/owner.json"; mkdirSync(join(root, "approvals"), { recursive: true });
  const source = { schema: "workloom.evidence-approval/v1", decision: "approved", reason: "Owner reviewed a single-executor fixture", approved_by: "product-owner", approved_at: new Date().toISOString(), commit: git(dir, ["rev-parse", "HEAD"]), scope: "role-separation", subjects: [card.id] };
  writeFileSync(join(root, sourcePath), `${JSON.stringify(source)}\n`);
  const waived = { ...card, waiver: { reason: source.reason, approved_by: source.approved_by, approved_at: source.approved_at, source: bindArtifact(root, sourcePath, source.commit) } };
  const waivedPath = writeCard(dir, "self-verify-waived.json", waived);
  const result = run(["add", "--ledger", ledgerPath, "--card", waivedPath, "--replace"], { cwd: dir }); assert.equal(result.status, 0, result.stderr);
  assert.equal(run(["gate", "--ledger", ledgerPath], { cwd: dir }).status, 0);
});

test("plan 输出四批计划与冲突面", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const p1 = problemCard(dir, { id: "MC-001", batch: 0, severity: "P0" });
  const p2 = problemCard(dir, {
    id: "MC-002",
    batch: 3,
    root_cause: { file: "README.md", line: 1, commit: git(dir, ["rev-parse", "HEAD"]) },
  });
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "c1.json", p1)], { cwd: dir }).status, 0);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "c2.json", p2)], { cwd: dir }).status, 0);
  const result = run(["plan", "--ledger", ledgerPath, "--json"], { cwd: dir });
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.batches[0].cards.length, 1);
  assert.equal(plan.batches[3].cards.length, 1);
  assert.deepEqual(plan.conflicts.find((item) => item.path === "README.md").cards, ["MC-001", "MC-002"]);
});

test("verify-baseline 识别本地不存在的提交与在线基线", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const head = git(dir, ["rev-parse", "HEAD"]);
  const stale = problemCard(dir, { root_cause: { file: "README.md", line: 1, commit: "0123456" } });
  const invalid = JSON.parse(readFileSync(ledgerPath)); invalid.cards = [stale]; writeFileSync(ledgerPath, JSON.stringify(invalid));
  const staleRun = run(["verify-baseline", "--ledger", ledgerPath, "--repo", dir, "--no-fetch", "--json"], { cwd: dir });
  assert.equal(staleRun.status, 1);
  assert.equal(JSON.parse(staleRun.stdout).stale, 1);

  const current = problemCard(dir, { root_cause: { file: "README.md", line: 1, commit: head } });
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "current.json", current), "--replace"], { cwd: dir }).status, 0);
  assert.equal(run(["verify-baseline", "--ledger", ledgerPath, "--repo", dir, "--no-fetch", "--json"], { cwd: dir }).status, 0);
});

test("handoff 拒绝无回归路径的未闭环项，通过后生成 RDAS 交接单", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const open = problemCard(dir, {
    id: "MC-009",
    state: "open",
    severity: "P2",
    regression: undefined,
    assertions: [{ kind: "sample", given: "输入", expect: "结果", command: "" }],
  });
  // 断言 command 为空会被 add 拦下，这里直接写台账验证 handoff 的独立检查
  const ledger = alignLedger(dir, ledgerPath);
  ledger.cards.push({ ...open, assertions: [{ kind: "sample", given: "输入", expect: "结果", command: "npm test" }] });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const refused = run(["handoff", "--ledger", ledgerPath], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /回归路径/);

  ledger.cards[0].regression = { command: "node --test fixture-regression.mjs" };
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const done = run(["handoff", "--ledger", ledgerPath, "--env", "client-runtime"], { cwd: dir });
  assert.equal(done.status, 0, done.stderr);
  const handoff = JSON.parse(readFileSync(join(dir, "outputs", "mine-clear", TASK, "handoff.json"), "utf8"));
  assert.equal(handoff.environment_claim, "client-runtime");
  assert.equal(handoff.open_problems.length, 1);
  assert.match(handoff.acceptance_commands[1], /fleet-run\.mjs/);
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).handoff.open_problem_ids[0], "MC-009");
});

test("台账缺不变量时 gate 判红（不变量是断言骨架）", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const result = run(["gate", "--ledger", ledgerPath], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不变量/);
  assert.ok(existsSync(ledgerPath));
});

test("本地预览档位在交接单里给出生产口径警示", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir, { extra: ["--env", "local-preview"] });
  run(["invariants", "--ledger", ledgerPath], { cwd: dir });
  const card = problemCard(dir);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "v.json", card)], { cwd: dir }).status, 0);
  closeCard(dir, ledgerPath, card.id);
  assert.equal(run(["handoff", "--ledger", ledgerPath], { cwd: dir }).status, 0);
  const handoff = JSON.parse(readFileSync(join(dir, "outputs", "mine-clear", TASK, "handoff.json"), "utf8"));
  assert.match(handoff.notes, /不得写『生产实测通过』/);
});

test("report 目录结构约定可写（evidence 目录）", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  mkdirSync(join(dir, "outputs", "mine-clear", TASK, "evidence"), { recursive: true });
  assert.ok(existsSync(ledgerPath));
  assert.ok(existsSync(join(dir, "outputs", "mine-clear", TASK, "evidence")));
});

const REBIND = fileURLToPath(new URL("./rebind-ledger-evidence.mjs", import.meta.url));

function runRebind(args, { cwd } = {}) {
  return spawnSync(process.execPath, [REBIND, ...args], { cwd, encoding: "utf8" });
}

/**
 * Reproduces the 5e0044f regression: one commit lands the receipt entities, but the
 * ledger/index still point at the earlier "repair" commit whose tree does not contain
 * them. The gate reads receipts back through git at the declared commit, so a fresh
 * clone cannot verify a single one of them.
 *
 * The fixture keeps the receipts tracked by committing them with `git add -f`, exactly
 * like the repo's real `outputs/` tree (which is ignored but force-added).
 */
function landReceipts(dir, ledgerPath, { id, card }) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.baseline.repair.commit = git(dir, ["rev-parse", "HEAD"]);
  ledger.cards = ledger.cards.map((item) => (item.id === id ? card : item));
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  git(dir, ["add", "-f", "-A", "outputs"]);
  git(dir, ["commit", "--quiet", "-m", `chore(base): 回执随分支入库 [${TASK}]`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

test("回执绑定：声明提交必须真的包含该产物，并可在其上回读", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const root = join(dir, "outputs", "mine-clear", TASK);
  const card = problemCard(dir);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "rebind.json", card)], { cwd: dir }).status, 0);
  const repaired = closeCard(dir, ledgerPath, card.id);

  // 5e0044f 的真实形态：runs/evidence 实体已随提交入库，台账/索引仍指向前一个提交。
  landReceipts(dir, ledgerPath, { id: card.id, card: repaired });
  const declared = JSON.parse(readFileSync(ledgerPath, "utf8")).cards.find((item) => item.id === card.id).assertions[0].run.commit;
  assert.notEqual(declared, git(dir, ["rev-parse", "HEAD"]), "夹具必须让声明提交落后于实体所在的提交");
  const aligned = runRebind(["--ledger", ledgerPath, "--repo", dir], { cwd: dir });
  assert.equal(aligned.status, 1, "实体与声明提交脱钩时必须判红");
  assert.match(aligned.stderr, /回执绑定/);

  // 真实流程：重绑到已承载实体的提交 → 重绑结果随提交入库 → 逐份回读通过。
  assert.equal(runRebind(["--ledger", ledgerPath, "--repo", dir, "--write"], { cwd: dir }).status, 0);
  git(dir, ["add", "-f", "-A", "outputs"]);
  git(dir, ["commit", "--quiet", "-m", `chore(base): 回执重绑到承载实体的提交 [${TASK}]`]);
  const rebound = runRebind(["--ledger", ledgerPath, "--repo", dir], { cwd: dir });
  assert.equal(rebound.status, 0, `逐份回读失败：${rebound.stderr}`);

  const assertions = JSON.parse(readFileSync(ledgerPath, "utf8")).cards.find((item) => item.id === card.id).assertions;
  assert.ok(assertions.length > 0);
  for (const assertion of assertions) {
    for (const field of ["run", "evidence"]) {
      const ref = assertion[field];
      // 声明提交必须真的包含该产物：逐个 blob 回读并核对散列。
      const blob = execFileSync("git", ["show", `${ref.commit}:outputs/mine-clear/${TASK}/${ref.path}`], { cwd: dir });
      assert.equal(hashBytes(blob), ref.sha256);
    }
  }
  const index = JSON.parse(readFileSync(join(root, "evidence-index.json"), "utf8"));
  for (const ref of [...index.runs, ...index.artifacts]) {
    const blob = execFileSync("git", ["show", `${ref.commit}:outputs/mine-clear/${TASK}/${ref.path}`], { cwd: dir });
    assert.equal(hashBytes(blob), ref.sha256);
  }
});

test("回执绑定：工作树不干净时拒绝重绑（不能把回执绑到尚未包含它的提交）", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  writeFileSync(join(dir, "AGENTS.md"), "# 未提交改动\n", "utf8");
  assert.notEqual(git(dir, ["status", "--porcelain"]), "", "夹具必须先弄脏工作树");
  const result = runRebind(["--ledger", ledgerPath, "--repo", dir, "--write"], { cwd: dir });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /工作树必须干净/);
});

test("回执绑定：sha256 与提交内字节不一致时判红", () => {
  const dir = makeRepo();
  const ledgerPath = initLedger(dir);
  const card = problemCard(dir);
  assert.equal(run(["add", "--ledger", ledgerPath, "--card", writeCard(dir, "sha.json", card)], { cwd: dir }).status, 0);
  const closed = closeCard(dir, ledgerPath, card.id);
  landReceipts(dir, ledgerPath, { id: card.id, card: closed });
  assert.equal(runRebind(["--ledger", ledgerPath, "--repo", dir, "--write"], { cwd: dir }).status, 0);
  git(dir, ["add", "-f", "-A", "outputs"]);
  git(dir, ["commit", "--quiet", "-m", `chore(base): 绑定到落地提交 [${TASK}]`]);

  const tampered = JSON.parse(readFileSync(ledgerPath, "utf8"));
  tampered.cards.find((item) => item.id === card.id).assertions[0].run.sha256 = "0".repeat(64);
  writeFileSync(ledgerPath, `${JSON.stringify(tampered, null, 2)}\n`);
  git(dir, ["add", "-f", "-A", "outputs"]);
  git(dir, ["commit", "--quiet", "-m", `chore(base): 篡改回执散列 [${TASK}]`]);
  const result = runRebind(["--ledger", ledgerPath, "--repo", dir], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sha256 不一致/);
});
