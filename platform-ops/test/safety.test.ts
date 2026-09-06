/**
 * 运维安全保障机制专项测试（对焦方案 V1.0 P1-P5 落地验证）
 *
 * P1 变更分级（就高不就低）/ 保护清单闸（deny/冷静期/带外检测）/ 闸门流水线（fail-fast/hotfix）
 * P2 影响范围分析（依赖反索引/schema 兼容/扇出预估）
 * P3 熔断（SLO 冻结/准入/资产熔断/围栏异动 3σ）
 * P4 主备（fencing 抢约/探针全断/三条件自动切/带病禁切/回切规划）
 * P5 沙箱（S-1 闸门在位 / S-2 分级纪律 / fail-fast）
 */
import { describe, expect, it } from "vitest";
import { classifyChange, validateApprovalCard, APPROVAL_MATRIX, type ChangedFile } from "../src/safety/change-classifier.js";
import { aggregateVerdicts, detectOutOfBandTouch, guardDiff, matchGlob, type ProtectedPathsDoc } from "../src/safety/protected-paths.js";
import { ChangeGate, type GateExecutors } from "../src/safety/change-gate.js";
import { buildBlastRadiusReport, buildReverseIndex, checkSchemaCompat, estimateFanout, parseImports } from "../src/safety/blast-radius.js";
import { admitChange, detectFenceAnomaly, evaluateAssetCircuit, evaluateChangeFreeze } from "../src/safety/change-freeze.js";
import { MemoryFenceTokenStore, ProbeTracker, decideSwitch, planFailback, standbyHealthy, writeTargetFor } from "../src/safety/standby.js";
import { runSandboxGate, runScenario, scenarioS1, scenarioS2, type SandboxEnv } from "../src/safety/sandbox.js";
import { PLATFORM_SLOS } from "../src/runtime/slo.js";

/* ---------------- 共用桩 ---------------- */

const DOC: ProtectedPathsDoc = {
  version: "t", entries: [
    { id: "fence-engine", label: "围栏引擎", paths: ["packages/base/fence-engine/**", "bundles/*/fences/**"], minLevel: "C3", rules: ["no-delete", "loosen-needs-cooling"], approvers: 2 },
    { id: "migrations", label: "迁移", paths: ["packages/db/migrations/**"], minLevel: "C3", rules: ["append-only"], approvers: 2 },
    { id: "sync", label: "同步机制", paths: ["sync/**"], minLevel: "C3", rules: ["no-delete"], approvers: 2 },
    { id: "safety-self", label: "安全自身", paths: ["safety/**", "platform-ops/src/safety/**"], minLevel: "C3", rules: ["no-delete", "sandbox-required"], approvers: 2 },
  ],
};

const pass = (gate: "G1" | "G2" | "G3" | "G4" | "G5", summary = "ok") => ({ gate, pass: true, summary });
const execsOk: GateExecutors = {
  staticChecks: async () => pass("G1", "tsc 0 errors"),
  tests: async () => pass("G2", "70/70"),
  exam: async () => pass("G3", "硬轨全过"),
  blastRadius: async () => pass("G4", "无扇出"),
  sandbox: async () => pass("G5", "S-1/S-2 全过"),
};

/* ---------------- P1 变更分级 ---------------- */

describe("P1 变更分级（C0-C3，就高不就低）", () => {
  const f = (path: string, kind: ChangedFile["kind"] = "modified", over: Partial<ChangedFile> = {}): ChangedFile => ({ path, kind, ...over });

  it("删除工程文件直接 C3（误删底层代码威胁面）", () => {
    const c = classifyChange([f("packages/base/fence-engine/judge.ts", "deleted")]);
    expect(c.level).toBe("C3");
    expect(c.requiresRollbackPlan).toBe(true);
  });
  it("触碰 sync/ 即 C3（扇出型）；改写已有迁移 C3；新增迁移降级", () => {
    expect(classifyChange([f("sync/base-scope.json")]).level).toBe("C3");
    expect(classifyChange([f("packages/db/migrations/0021_x.sql")]).level).toBe("C3");
    expect(classifyChange([f("packages/db/migrations/0099_new.sql", "added")]).level).not.toBe("C3");
  });
  it("扣费链路 C2 且强制灰度；bundle 资产 C1；文档/测试 C0", () => {
    expect(classifyChange([f("packages/base/model-router/router.ts")]).requiresCanary).toBe(true);
    expect(classifyChange([f("bundles/platform/presets/fae-chief.yml")]).level).toBe("C1");
    expect(classifyChange([f("docs/x.md"), f("platform-ops/test/safety.test.ts")]).level).toBe("C0");
  });
  it("混合变更取最高（就高不就低）", () => {
    const c = classifyChange([f("docs/x.md"), f("sync/child-repos.json")]);
    expect(c.level).toBe("C3");
  });
  it("审批卡完整性：C3 缺回滚方案直接拒；闸门未过直接拒", () => {
    const bad = validateApprovalCard({ level: "C3", reasons: [], gateEvidence: [{ gate: "G1", pass: false, summary: "x" }], impactSelfAssessment: "y" });
    expect(bad.ok).toBe(false);
    expect(bad.missing.join()).toContain("回滚方案");
    const noGates = validateApprovalCard({ level: "C1", reasons: [], gateEvidence: [], impactSelfAssessment: "y" });
    expect(noGates.ok).toBe(false);
  });
  it("审批矩阵：C3 需 2 人审 + 全闸门", () => {
    expect(APPROVAL_MATRIX.C3.approvers).toBe(2);
    expect(APPROVAL_MATRIX.C3.gates).toContain("G5");
    expect(APPROVAL_MATRIX.C0.approvers).toBe(0);
  });
});

/* ---------------- P1 保护清单闸 ---------------- */

describe("P1 保护清单闸", () => {
  it("glob 匹配：** 跨段 / * 段内", () => {
    expect(matchGlob("packages/base/fence-engine/**", "packages/base/fence-engine/judge.ts")).toBe(true);
    expect(matchGlob("bundles/*/fences/**", "bundles/platform/fences/platform-baseline.yml")).toBe(true);
    expect(matchGlob("bundles/*/fences/**", "bundles/platform/presets/x.yml")).toBe(false);
  });
  it("删除围栏引擎文件 → deny；改写已有迁移 → deny（append-only）", () => {
    const v1 = guardDiff(DOC, [{ path: "packages/base/fence-engine/judge.ts", kind: "deleted" }]);
    expect(aggregateVerdicts(v1).action).toBe("deny");
    const v2 = guardDiff(DOC, [{ path: "packages/db/migrations/0021_x.sql", kind: "modified" }]);
    expect(aggregateVerdicts(v2).action).toBe("deny");
  });
  it("新增迁移文件放行；围栏净删除触发 24h 冷静期", () => {
    const v1 = guardDiff(DOC, [{ path: "packages/db/migrations/0099_new.sql", kind: "added" }]);
    expect(aggregateVerdicts(v1).action).toBe("require");
    const v2 = guardDiff(DOC, [{ path: "bundles/platform/fences/platform-baseline.yml", kind: "modified", addedLines: 3, deletedLines: 40 }]);
    const agg = aggregateVerdicts(v2);
    expect(agg.action).toBe("require");
    expect((agg as { coolingHours?: number }).coolingHours).toBe(24);
  });
  it("带外修改检测：绕过 CI 触碰保护文件 → P1 告警", () => {
    const hits = detectOutOfBandTouch(DOC, ["sync/base-scope.json", "packages/base/fence-engine/judge.ts", "docs/x.md"]);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.level === "P1")).toBe(true);
  });
});

/* ---------------- P1 闸门流水线 ---------------- */

describe("P1 变更闸门流水线（G1-G6）", () => {
  const gate = new ChangeGate(DOC, execsOk);
  const baseReq = { title: "x", author: "ai-dev" as const, impactSelfAssessment: "自评", rollbackPlan: "revert" };

  it("保护清单 deny 先于一切执行闸", async () => {
    const d = await gate.evaluate({ ...baseReq, files: [{ path: "packages/base/fence-engine/judge.ts", kind: "deleted" }] });
    expect(d.decision).toBe("reject");
    expect((d as { stage: string }).stage).toBe("guard");
  });
  it("C1 正常流：过 G1-G3 → needs-approval 1 人", async () => {
    const d = await gate.evaluate({ ...baseReq, files: [{ path: "bundles/platform/skills/kb-fresh/SKILL.md", kind: "modified" }] });
    expect(d.decision).toBe("needs-approval");
    expect((d as { approvers: number }).approvers).toBe(1);
  });
  it("C3 正常流：全闸门 + 2 人审；任一闸失败即终止（fail-fast）", async () => {
    const failG3: GateExecutors = { ...execsOk, exam: async () => ({ gate: "G3", pass: false, summary: "红线题失败" }) };
    const g = new ChangeGate(DOC, failG3);
    const d = await g.evaluate({ ...baseReq, files: [{ path: "sync/base-scope.json", kind: "modified" }] });
    expect(d.decision).toBe("reject");
    expect((d as { stage: string }).stage).toBe("G3");
  });
  it("hotfix 快轨：不跳考试院；C3 禁走快轨（改保险丝没有捷径）", async () => {
    let examCalled = false;
    const execs: GateExecutors = { ...execsOk, exam: async () => { examCalled = true; return pass("G3"); } };
    const g = new ChangeGate(DOC, execs);
    const d1 = await g.evaluate({ ...baseReq, hotfix: true, files: [{ path: "packages/base/model-router/router.ts", kind: "modified" }] });
    expect(d1.decision).toBe("hotfix-fasttrack");
    expect(examCalled).toBe(true);
    const d2 = await g.evaluate({ ...baseReq, hotfix: true, files: [{ path: "sync/base-scope.json", kind: "modified" }] });
    expect(d2.decision).toBe("reject");
  });
});

/* ---------------- P2 影响范围分析 ---------------- */

describe("P2 影响范围分析（G4）", () => {
  it("依赖反向索引：下游 BFS + 跨包检测", () => {
    const edges = [
      { from: "packages/base/service-ticket/tickets", to: "packages/base/workdata/gateway" },
      { from: "apps/server/src/service/ticket", to: "packages/base/service-ticket/tickets" },
    ];
    const rev = buildReverseIndex(edges);
    const report = buildBlastRadiusReport({
      files: [{ path: "packages/base/workdata/gateway.ts", kind: "modified" }],
      reverseIndex: rev,
    });
    expect(report.dependents.map((d) => d.path)).toContain("packages/base/service-ticket/tickets");
    expect(report.crossPackage).toBe(true);
    expect(report.escalateToC2).toBe(true);
  });
  it("import 解析", () => {
    const edges = parseImports('import { a } from "../bus/stream.js";\nimport { b } from "./x.js";', "src/streams/p.ts");
    expect(edges.map((e) => e.to)).toEqual(["src/bus/stream", "src/streams/x"]);
  });
  it("schema 兼容：删枚举=破坏性；纯新增放行", () => {
    const before = { objects: [{ type: "ticket" }, { type: "strategy" }] };
    const removed = checkSchemaCompat("objects.json", before, { objects: [{ type: "ticket" }] });
    expect(removed).toHaveLength(1);
    expect(removed[0]!.severity).toBe("dual-version-required");
    const added = checkSchemaCompat("objects.json", before, { objects: [{ type: "ticket" }, { type: "strategy" }, { type: "incident" }] });
    expect(added).toHaveLength(0);
  });
  it("扇出预估：命中 base-sync include → 列出受影响子仓", () => {
    const fan = estimateFanout(
      [{ path: "packages/base/fence-engine/judge.ts", kind: "modified" }, { path: "bundles/platform/bundle.json", kind: "modified" }],
      { include: ["packages/base/**", "apps/server/src/**"] },
      [{ repo: "a/fox" }, { repo: "a/hotel" }],
    );
    expect(fan.inScope).toEqual(["packages/base/fence-engine/judge.ts"]);
    expect(fan.affectedChildren).toEqual(["a/fox", "a/hotel"]);
  });
});

/* ---------------- P3 熔断体系 ---------------- */

describe("P3 熔断体系", () => {
  it("SLO 燃烧率驱动全局变更冻结；对账越界冻结资金流", () => {
    const ingest = PLATFORM_SLOS.find((s) => s.name === "ingest-ack")!;
    const reconcile = PLATFORM_SLOS.find((s) => s.name === "reconcile")!;
    const orders = evaluateChangeFreeze([
      { def: ingest, total: 100_000, bad: 60 },   // 预算耗尽
      { def: reconcile, total: 10_000, bad: 1 },  // 硬指标
    ], 1000);
    expect(orders.some((o) => o.scope === "global-changes" && o.level === "P0")).toBe(true);
    expect(orders.some((o) => o.scope === "funds")).toBe(true);
  });
  it("冻结下准入：全局冻结只放行 hotfix；资金冻结拒账务变更", () => {
    const freezes = evaluateChangeFreeze([{ def: PLATFORM_SLOS.find((s) => s.name === "ingest-ack")!, total: 100, bad: 1 }], 0);
    // 1% 错误 vs 0.05% 预算 → 耗尽
    expect(admitChange(freezes, { hotfix: false, level: "C1" }).admit).toBe(false);
    expect(admitChange(freezes, { hotfix: true, level: "C1" }).admit).toBe(true);
    const fundsFreeze = [{ scope: "funds", reason: "x", triggeredAt: 0, level: "P1", hotfixExempt: false } as const];
    expect(admitChange([...fundsFreeze], { touchesFunds: true, level: "C2" }).admit).toBe(false);
  });
  it("资产熔断：考题回归失败 1 次即下架；围栏异常 >3 下架", () => {
    const orders = evaluateAssetCircuit([
      { assetId: "platform@1.1.0", fenceAnomalies: 0, examRegressionFailures: 1 },
      { assetId: "hotel@1.4.0", fenceAnomalies: 5, examRegressionFailures: 0 },
      { assetId: "ok@1.0.0", fenceAnomalies: 1, examRegressionFailures: 0 },
    ], 0);
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.target).sort()).toEqual(["hotel@1.4.0", "platform@1.1.0"]);
  });
  it("围栏异动 3σ：突降突升都抓；基线恒定突变也抓", () => {
    const calm = detectFenceAnomaly({ ruleId: "R-PL1", dailyCounts: [10, 11, 9, 10, 10, 11, 9, 10] }, { now: 0 });
    expect(calm).toBeNull();
    const spike = detectFenceAnomaly({ ruleId: "R-PL4", dailyCounts: [10, 11, 9, 10, 10, 11, 9, 500] }, { now: 0 });
    expect(spike?.reason).toContain("突升");
    const dead = detectFenceAnomaly({ ruleId: "R-PL4", dailyCounts: [10, 10, 10, 10, 10, 10, 10, 0] }, { now: 0 });
    expect(dead?.reason).toContain("突变");
  });
});

/* ---------------- P4 主备切换 ---------------- */

describe("P4 主备切换", () => {
  it("fencing token：租约未过期他人抢不到（脑裂防护）；过期可抢", () => {
    const store = new MemoryFenceTokenStore();
    expect(store.acquire("primary", 60_000, 0).acquired).toBe(true);
    expect(store.acquire("standby", 60_000, 30_000).acquired).toBe(false);
    expect(store.acquire("standby", 60_000, 61_000).acquired).toBe(true);
    expect(writeTargetFor(store.currentHolder(), "standby")).toBe("accept");
    expect(writeTargetFor(store.currentHolder(), "primary")).toBe("reject-readonly");
  });
  it("三条件齐备 → 自动切换（已对焦授权）；缺租约 → 人工裁决", () => {
    const healthy = { replicationLagSec: 3, chainVerifyOk: true, eventMirrorLagMs: 1000 };
    expect(decideSwitch({ primaryBlackout: true, primaryDegraded: false, standby: healthy, fenceAcquired: true, now: 0 }).action).toBe("auto-switch");
    expect(decideSwitch({ primaryBlackout: true, primaryDegraded: false, standby: healthy, fenceAcquired: false, now: 0 }).action).toBe("manual-review");
  });
  it("备库带病禁止切换（带病切换比不切更危险）", () => {
    const sick = { replicationLagSec: 120, chainVerifyOk: false, eventMirrorLagMs: 1000 };
    const d = decideSwitch({ primaryBlackout: true, primaryDegraded: false, standby: sick, fenceAcquired: true, now: 0 });
    expect(d.action).toBe("forbid");
    expect(standbyHealthy(sick).ok).toBe(false);
  });
  it("探针全断判定：窗口内连续失败 ≥3 次", () => {
    const t = new ProbeTracker(180_000);
    t.record({ ts: 0, ok: false }); t.record({ ts: 30_000, ok: false }); t.record({ ts: 60_000, ok: false });
    expect(t.isTotalBlackout(90_000)).toBe(true);
    t.record({ ts: 95_000, ok: true });
    expect(t.isTotalBlackout(100_000)).toBe(false);
  });
  it("回切规划：观察期→数据校验→5% 灰度→全量；校验不过 blocked", () => {
    const t0 = 0, day = 24 * 3_600_000;
    expect(planFailback({ repairedAt: t0, chainVerifyOk: true, balanceDiffOk: true, now: t0 + 1000 }).phase).toBe("role-reversed-observation");
    expect(planFailback({ repairedAt: t0, chainVerifyOk: false, balanceDiffOk: true, now: t0 + day + 1 }).phase).toBe("blocked");
    const canary = planFailback({ repairedAt: t0, chainVerifyOk: true, balanceDiffOk: true, now: t0 + day + 1 });
    expect(canary).toEqual({ phase: "canary-failback", percent: 5 });
    expect(planFailback({ repairedAt: t0, chainVerifyOk: true, balanceDiffOk: true, canaryPercent: 100, now: t0 + day + 1 }).phase).toBe("full-failback");
  });
});

/* ---------------- P5 沙箱验证 ---------------- */

describe("P5 沙箱验证（S-1/S-2 剧本）", () => {
  /** 内存假环境：按剧本预期应答的确定性桩 */
  function fakeEnv(behavior: Record<string, Record<string, unknown>>): SandboxEnv {
    return {
      async reset() {},
      async call(service: string, action: string, payload: Record<string, unknown>) {
        const key = `${service}.${action}`;
        if (key === "aipm.inject") {
          if (!payload.confirmed) return { injected: false, reason: "customer-not-confirmed" };
          if (!payload.pmApproved) return { fenceVerdict: "review" };
          return { linked: true, callbackSent: true };
        }
        return behavior[key] ?? {};
      },
    };
  }

  it("S-1 全闭环剧本：闸门全部在位时通过", async () => {
    const env = fakeEnv({
      "ticket.create": { ticket_id: "tk1", intent: "feature_request" },
      "requirement.confirm": { bound: true },
    });
    const report = await runScenario(env, scenarioS1());
    expect(report.pass).toBe(true);
    expect(report.steps).toHaveLength(5);
  });

  it("S-1 闸门缺失被抓住：未确认也放行注入 → G5 不过", async () => {
    const env: SandboxEnv = {
      async reset() {},
      async call(service, action) {
        if (`${service}.${action}` === "aipm.inject") return { injected: true }; // 失控环境：无闸门
        if (`${service}.${action}` === "ticket.create") return { ticket_id: "tk1", intent: "feature_request" };
        return { bound: true };
      },
    };
    const report = await runScenario(env, scenarioS1());
    expect(report.pass).toBe(false);
    expect(report.steps[1]!.failures.join()).toContain("唯一闸门");
  });

  it("S-2 分级纪律：P2 不叫醒 / P0 三通道 / 复盘回流知识库", async () => {
    const env = fakeEnv({
      "ticket.create": { routed: "incident-responder", slaDeadlineMs: 300_000 },
      "incident.classify": { level: "P0", channels: ["phone", "sms", "ws"] },
      "kb.harvest": { draftCreated: true, pendingReview: true },
    });
    // 第一组 classify（切换成功场景）需要 P2——用条件桩
    const env2: SandboxEnv = {
      async reset() {},
      async call(service, action, payload) {
        if (`${service}.${action}` === "incident.classify") {
          return payload.failoverOk ? { level: "P2", pageOncall: false } : { level: "P0", channels: ["phone", "sms", "ws"] };
        }
        return (await fakeEnv({ "ticket.create": { routed: "incident-responder", slaDeadlineMs: 300_000 }, "kb.harvest": { draftCreated: true, pendingReview: true } }).call(service, action, payload));
      },
    };
    const report = await runScenario(env2, scenarioS2());
    expect(report.pass).toBe(true);
  });

  it("沙箱闸汇总：双剧本全过才放行；fail-fast 不刷无效红灯", async () => {
    const okEnv: SandboxEnv = {
      async reset() {},
      async call(service, action, payload) {
        const key = `${service}.${action}`;
        if (key === "aipm.inject") {
          if (!payload.confirmed) return { injected: false, reason: "customer-not-confirmed" };
          if (!payload.pmApproved) return { fenceVerdict: "review" };
          return { linked: true, callbackSent: true };
        }
        if (key === "incident.classify") return payload.failoverOk ? { level: "P2", pageOncall: false } : { level: "P0", channels: ["a", "b", "c"] };
        if (key === "ticket.create" && payload.intent === "feature_request") return { ticket_id: "t", intent: "feature_request" };
        if (key === "ticket.create") return { routed: "incident-responder", slaDeadlineMs: 300_000 };
        if (key === "requirement.confirm") return { bound: true };
        if (key === "kb.harvest") return { draftCreated: true, pendingReview: true };
        return {};
      },
    };
    const gate = await runSandboxGate(okEnv);
    expect(gate.pass).toBe(true);
    // 异常环境：第一步即异常 → fail-fast 只报一步
    const badEnv: SandboxEnv = {
      async reset() {},
      async call() { throw new Error("env down"); },
    };
    const bad = await runSandboxGate(badEnv);
    expect(bad.pass).toBe(false);
    expect(bad.reports[0]!.steps).toHaveLength(1);
  });
});
