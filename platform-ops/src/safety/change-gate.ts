/**
 * safety/change-gate —— 变更闸门流水线（对焦方案 §2.4，G1→G6）
 *
 * 编排器为纯逻辑：各闸门的执行器以函数注入（CI 里接真实执行，测试里接确定性桩）。
 * 关键纪律：任何一闸失败即终止，失败原因进审批卡；不允许"先合再说"。
 * hotfix 快轨：G1+G2 快检 + 1 人审 + 30min 时限（回滚类变更专用，不跳过考试院硬轨）。
 */
import { APPROVAL_MATRIX, classifyChange, validateApprovalCard, type ApprovalCard, type ChangeLevel, type ChangedFile } from "./change-classifier.js";
import { aggregateVerdicts, guardDiff, type ProtectedPathsDoc } from "./protected-paths.js";

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

export interface GateResult {
  gate: GateId;
  pass: boolean;
  summary: string;
  durationMs?: number;
}

/** 各闸门执行器（注入式） */
export interface GateExecutors {
  /** G1 静态闸：typecheck/lint/机密扫描 */
  staticChecks: () => Promise<GateResult>;
  /** G2 测试闸：全量单测 + 审计加固 + 覆盖率 */
  tests: () => Promise<GateResult>;
  /** G3 考试院闸：硬轨全过（fence 正反题 + 红线 0 失败 + 金标准回归） */
  exam: () => Promise<GateResult>;
  /** G4 影响范围分析（blast-radius 输出摘要） */
  blastRadius: (files: ChangedFile[]) => Promise<GateResult>;
  /** G5 沙箱验证（S-1/S-2 场景剧本） */
  sandbox: () => Promise<GateResult>;
}

export interface ChangeRequest {
  title: string;
  author: "ai-dev" | "human" | "bot";
  files: ChangedFile[];
  rollbackPlan?: string;
  impactSelfAssessment?: string;
  /** hotfix 快轨申请（仅限回滚/止损类变更） */
  hotfix?: boolean;
}

export type GateDecision =
  | { decision: "reject"; stage: GateId | "guard"; reasons: string[] }
  | { decision: "approve-for-merge"; level: ChangeLevel; card: ApprovalCard }
  | { decision: "needs-approval"; level: ChangeLevel; approvers: number; coolingHours: number; card: ApprovalCard }
  | { decision: "hotfix-fasttrack"; card: ApprovalCard };

export class ChangeGate {
  constructor(private protectedDoc: ProtectedPathsDoc, private execs: GateExecutors) {}

  async evaluate(req: ChangeRequest): Promise<GateDecision> {
    // ① 保护清单闸（最高优先级，先于一切执行闸——碰红线直接拒/升级）
    const verdicts = guardDiff(this.protectedDoc, req.files);
    const guard = aggregateVerdicts(verdicts);
    if (guard.action === "deny") {
      return { decision: "reject", stage: "guard", reasons: [guard.reason] };
    }
    // ② 变更分级（就高不就低：分类器级别 vs 保护清单级别取高）
    const cls = classifyChange(req.files);
    const rank: Record<ChangeLevel, number> = { C0: 0, C1: 1, C2: 2, C3: 3 };
    let level = cls.level;
    if (guard.action === "require" && rank[guard.minLevel] > rank[level]) level = guard.minLevel;
    const coolingHours = guard.action === "require" ? (guard.coolingHours ?? 0) : 0;

    // ③ hotfix 快轨：仅限明确声明回滚/止损的变更，且不得触碰 C3 保护项
    if (req.hotfix) {
      if (level === "C3") return { decision: "reject", stage: "guard", reasons: ["hotfix 快轨不适用于 C3 级变更（改保险丝没有捷径）"] };
      const g1 = await this.execs.staticChecks();
      if (!g1.pass) return { decision: "reject", stage: "G1", reasons: [g1.summary] };
      const g3 = await this.execs.exam(); // 快轨不跳考试院硬轨
      if (!g3.pass) return { decision: "reject", stage: "G3", reasons: [g3.summary] };
      const card = this.buildCard(level, cls.reasons, [g1, { gate: "G2", pass: true, summary: "hotfix 快轨：合入后补全量" }, g3], req);
      return { decision: "hotfix-fasttrack", card };
    }

    // ④ 按审批矩阵依次过闸（fail-fast）
    const matrix = APPROVAL_MATRIX[level];
    const evidence: GateResult[] = [];
    const runners: Array<[GateId, () => Promise<GateResult>]> = [
      ["G1", this.execs.staticChecks],
      ["G2", this.execs.tests],
      ["G3", this.execs.exam],
      ["G4", () => this.execs.blastRadius(req.files)],
      ["G5", this.execs.sandbox],
    ];
    for (const [gate, run] of runners) {
      if (!matrix.gates.includes(gate)) continue;
      const result = await run();
      evidence.push(result);
      if (!result.pass) {
        return { decision: "reject", stage: gate, reasons: [`${gate} 未通过：${result.summary}`] };
      }
    }

    // ⑤ 审批卡
    const card = this.buildCard(level, cls.reasons, evidence, req);
    const check = validateApprovalCard(card);
    if (!check.ok) {
      return { decision: "reject", stage: "G6", reasons: check.missing };
    }
    if (matrix.approvers === 0) return { decision: "approve-for-merge", level, card };
    return { decision: "needs-approval", level, approvers: matrix.approvers, coolingHours, card };
  }

  private buildCard(level: ChangeLevel, reasons: string[], evidence: GateResult[], req: ChangeRequest): ApprovalCard {
    return {
      level,
      reasons,
      gateEvidence: evidence.map((e) => ({ gate: e.gate, pass: e.pass, summary: e.summary })),
      rollbackPlan: req.rollbackPlan,
      impactSelfAssessment: req.impactSelfAssessment,
    };
  }
}
