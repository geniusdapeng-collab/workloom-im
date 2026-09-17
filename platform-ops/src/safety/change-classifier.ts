/**
 * safety/change-classifier —— 变更风险分级器（对焦方案 §2.2，C0–C3）
 *
 * 机器初判（改动路径 + diff 特征）+ 人审确认，机器初判**就高不就低**：
 * 任何一条规则命中更高级别即升级，绝不降级。AI 提交的自评级别只能作为下限参考。
 */

export type ChangeLevel = "C0" | "C1" | "C2" | "C3";

export interface ChangedFile {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  addedLines?: number;
  deletedLines?: number;
}

export interface Classification {
  level: ChangeLevel;
  reasons: string[];
  /** 是否强制灰度（C2/C3 默认强制） */
  requiresCanary: boolean;
  /** 必须附带回滚方案（C3 无回滚方案直接拒） */
  requiresRollbackPlan: boolean;
}

const LEVEL_RANK: Record<ChangeLevel, number> = { C0: 0, C1: 1, C2: 2, C3: 3 };

interface Rule {
  level: ChangeLevel;
  test: (f: ChangedFile) => boolean;
  reason: (f: ChangedFile) => string;
}

/** 分级规则表（顺序无关，取最高命中；就高不就低） */
const RULES: Rule[] = [
  // —— C3：不可逆/破坏性/扇出型 ——
  { level: "C3", test: (f) => f.kind === "deleted" && /^(packages|apps|sync|safety|platform-ops)\//.test(f.path),
    reason: (f) => `删除工程文件 ${f.path}（疑似误删底层代码，T2 威胁面）` },
  { level: "C3", test: (f) => /^sync\//.test(f.path),
    reason: (f) => `触碰同步机制 ${f.path}（扇出型变更，影响全部子仓）` },
  { level: "C3", test: (f) => /^packages\/db\/migrations\//.test(f.path) && f.kind !== "added",
    reason: (f) => `改写已有迁移 ${f.path}（append-only 纪律）` },
  { level: "C3", test: (f) => /fence/.test(f.path) && (f.deletedLines ?? 0) > (f.addedLines ?? 0),
    reason: (f) => `围栏相关文件净删除 ${f.path}（疑似放宽/削弱防线）` },
  { level: "C3", test: (f) => /^(safety\/|platform-ops\/src\/(safety|stability)\/)/.test(f.path),
    reason: (f) => `触碰安全机制自身 ${f.path}（改保险丝）` },
  // —— C2：核心链路/大爆炸半径 ——
  { level: "C2", test: (f) => /(model-router|credit|billing)/.test(f.path),
    reason: (f) => `扣费/账务链路 ${f.path}` },
  { level: "C2", test: (f) => /(ticket|gateway|workdata)/.test(f.path) && f.kind !== "added",
    reason: (f) => `核心链路修改 ${f.path}（工单/网关/事件库）` },
  { level: "C2", test: (f) => /schema\.(ts|json)$/.test(f.path) || /objects\.json$|stages\.json$/.test(f.path),
    reason: (f) => `事件 schema 变更 ${f.path}（需 additive-only 校验）` },
  { level: "C2", test: (f) => /^platform-ops\/src\//.test(f.path) && f.kind !== "added",
    reason: (f) => `平台工程底座修改 ${f.path}` },
  // —— C1：可逆的行为变化 ——
  { level: "C1", test: (f) => /^bundles\/[^/]+\/(presets|skills|seeds|service-front|eval)\//.test(f.path),
    reason: (f) => `业务资产变更 ${f.path}（班组/技能/种子/考题）` },
  { level: "C1", test: (f) => /^apps\/(web|webc|desktop)\//.test(f.path),
    reason: (f) => `客户端变更 ${f.path}` },
  // —— C0：无行为变化 ——
  { level: "C0", test: (f) => /\.(md|mdx)$/.test(f.path) || /^docs\//.test(f.path),
    reason: () => "文档类变更" },
  { level: "C0", test: (f) => /\.(test|spec)\.(ts|tsx|js)$/.test(f.path),
    reason: () => "测试用例变更" },
];

export function classifyChange(files: ChangedFile[]): Classification {
  let level: ChangeLevel = "C0";
  const reasons: string[] = [];
  for (const f of files) {
    for (const r of RULES) {
      if (r.test(f) && LEVEL_RANK[r.level] >= LEVEL_RANK[level]) {
        if (LEVEL_RANK[r.level] > LEVEL_RANK[level]) level = r.level;
        const reason = r.reason(f);
        if (!reasons.includes(reason)) reasons.push(reason);
        break; // 每文件只记最高优先级命中（RULES 内按级别降序排列）
      }
    }
  }
  return {
    level,
    reasons,
    requiresCanary: LEVEL_RANK[level] >= LEVEL_RANK.C2,
    requiresRollbackPlan: level === "C3",
  };
}

/** 审批矩阵（对焦方案 §2.2）：各级别所需闸门与人数 */
export const APPROVAL_MATRIX: Record<ChangeLevel, { gates: string[]; approvers: number; coolingHours?: number }> = {
  C0: { gates: ["G1", "G2"], approvers: 0 },
  C1: { gates: ["G1", "G2", "G3"], approvers: 1 },
  C2: { gates: ["G1", "G2", "G3", "G4", "G6"], approvers: 2 },
  C3: { gates: ["G1", "G2", "G3", "G4", "G5", "G6"], approvers: 2, coolingHours: 0 }, // 围栏放宽另加 24h（protected-paths.loosen-needs-cooling）
};

/** 审批卡（G6：3 分钟可裁决的证据卡） */
export interface ApprovalCard {
  level: ChangeLevel;
  reasons: string[];
  gateEvidence: Array<{ gate: string; pass: boolean; summary: string }>;
  rollbackPlan?: string;
  impactSelfAssessment?: string;
  fanoutEstimate?: string[];
}

/** 审批卡完整性校验：缺项直接拒（对焦方案 §2.4 关键纪律） */
export function validateApprovalCard(card: ApprovalCard): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (card.gateEvidence.length === 0) missing.push("G1-G5 证据缺失");
  if (card.gateEvidence.some((g) => !g.pass)) missing.push("存在未通过闸门（先合再说被禁止）");
  if (!card.impactSelfAssessment) missing.push("AI 影响面自评缺失");
  if (card.level === "C3" && !card.rollbackPlan) missing.push("C3 变更必须预置回滚方案");
  return { ok: missing.length === 0, missing };
}
