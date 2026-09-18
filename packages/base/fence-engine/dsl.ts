/**
 * fence-engine · 围栏包 YAML DSL 装载与单调守卫（F2.3/F2.4/L2.5）
 *
 *  - loadFencePack：YAML → zod 校验 → RuntimeRule[]（装载期校验不合法即拒，L2.5）
 *  - checkMonotonic：对 is_baseline 规则的 patch 只可加严不可放宽（F2.3 单调守卫）
 *    加严定义：level 严格度不降（auto→review→block 方向）；规则不得被删除/降级
 *    拒绝即返回留痕数据（调用方写 fence.patch_rejected 事件，H-3）
 */
import YAML from "yaml";
import { z } from "zod";
import type { FenceLevel, RuntimeRule } from "./judge.js";
import { registerWriteActions } from "../workdata/gateway.js";

/* ---------- YAML 装载（L2.5：schema 校验先行） ---------- */

const RuleSchema = z.object({
  rule_id: z.string().regex(/^R\d+$/, "rule_id 形如 R1"),
  name: z.string().min(1),
  level: z.enum(["auto", "review", "block"]),
  is_baseline: z.boolean().default(false),
  match: z.object({
    object_types: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
  }),
  when: z.string().default(""),
  note: z.string().optional(),
});

const PackSchema = z
  .object({
    version: z.string().min(1),
    default_level: z.enum(["auto", "review", "block"]),
    rules: z.array(RuleSchema).min(1),
  })
  // HP-02：rule_id 是规则身份（单调守卫、dry-run、fence_rules 行 id 都由它派生）。
  // 允许重复会让「按 rule_id 取规则」的调用点静默拿到任意一条（checkMonotonic 的 Map 只留最后一条），
  // 违反 L2.5「装载期校验不合法即拒」。
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.rules.forEach((rule, index) => {
      if (seen.has(rule.rule_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "rule_id"],
          message: `rule_id 重复：${rule.rule_id}（规则身份必须唯一，否则单调守卫与 dry-run 会作用在错误的规则上）`,
        });
      }
      seen.add(rule.rule_id);
    });
  });

export interface FencePack {
  version: string;
  defaultLevel: FenceLevel;
  rules: RuntimeRule[];
}

/** 装载围栏包：YAML 文本 → 校验 → 运行时形态（不合法抛错，装载即失败） */
export function loadFencePack(yamlText: string): FencePack {
  const raw = YAML.parse(yamlText);
  const pack = PackSchema.parse(raw);
  const rules: RuntimeRule[] = pack.rules.map((r) => ({
      rule_id: r.rule_id,
      version: pack.version,
      name: r.name,
      level: r.level,
      is_baseline: r.is_baseline,
      objectTypes: r.match.object_types,
      actions: r.match.actions,
      when: r.when,
    }));
  // HP-02：装载即登记本包声明的写类动作。gateway 段①（F2.10 未声明 fence_bindings 禁写）与
  // judge 的 default_level 兜底都以 isWriteAction 为前提；此前 registerWriteActions 只有测试调用，
  // 行业写类动作（如酒店 order.reconcile、电商 ads.budget.adjust）被当成读类 → 权限校验放行 + 判定器误判 auto。
  registerWriteActions(rules.flatMap((rule) => rule.actions));
  return { version: pack.version, defaultLevel: pack.default_level, rules };
}

/* ---------- 单调守卫（F2.3） ---------- */

const STRICTNESS: Record<FenceLevel, number> = { auto: 0, review: 1, block: 2 };

export interface MonotonicViolation {
  rule_id: string;
  reason: string;
}

export interface MonotonicResult {
  ok: boolean;
  violations: MonotonicViolation[];
}

export interface MonotonicOptions {
  /**
   * 是否允许改写基线规则的 when 条件（默认拒绝）。
   * 条件语义无法静态证明不放宽；只有调用方已持有 dry-run 回放 + 人工确认证据（L2.4）
   * 时才可显式放行，放行事实应由调用方以 fence.patch 事件留痕（H-3）。
   */
  allowWhenChange?: boolean;
}

/**
 * 校验 patch（候选规则集）相对当前生效规则集是否单调加严。
 * 口径：
 *  - 基线规则（is_baseline）在 patch 中必须保留且 is_baseline 仍为 true
 *  - 基线 level 只可加严（STRICTNESS 不降）
 *  - 基线 match 作用域只可扩大：objectTypes / actions 不得丢失既有取值（收窄=静默失效面，HP-02）
 *  - 基线 when 默认不可改写（fail-closed，须 dry-run 证据 + allowWhenChange 显式放行，HP-02）
 *  - 非基线规则自由演进（版本化由 fence_rules 表承载，F2.4）
 */
export function checkMonotonic(
  current: RuntimeRule[],
  patch: RuntimeRule[],
  opts: MonotonicOptions = {},
): MonotonicResult {
  const violations: MonotonicViolation[] = [];
  const patchById = new Map(patch.map((r) => [r.rule_id, r]));
  for (const cur of current) {
    if (!cur.is_baseline) continue;
    const next = patchById.get(cur.rule_id);
    if (!next) {
      violations.push({ rule_id: cur.rule_id, reason: `基线规则 ${cur.rule_id} 在 patch 中被删除（禁止）` });
      continue;
    }
    if (!next.is_baseline) {
      violations.push({ rule_id: cur.rule_id, reason: `基线规则 ${cur.rule_id} 被取消 is_baseline 标记（禁止）` });
    }
    if (STRICTNESS[next.level] < STRICTNESS[cur.level]) {
      violations.push({
        rule_id: cur.rule_id,
        reason: `基线规则 ${cur.rule_id} level 被放宽：${cur.level} → ${next.level}（只可加严）`,
      });
    }
    // HP-02：match 作用域只可扩大。收窄（丢掉对象类型/动作）会让基线规则在实际调用里永不命中，
    // 等价于删除规则——此前只校验 rule_id 存在与 level 不降，留下静默失效面。
    for (const field of ["objectTypes", "actions"] as const) {
      const lost = cur[field].filter((v) => !next[field].includes(v));
      if (lost.length > 0) {
        violations.push({
          rule_id: cur.rule_id,
          reason: `基线规则 ${cur.rule_id} ${field} 被收窄，丢失 ${lost.join("、")}（只可扩大匹配范围）`,
        });
      }
    }
    // HP-02：when 改写默认按放宽处理（fail-closed）。
    if (next.when !== cur.when && !opts.allowWhenChange) {
      violations.push({
        rule_id: cur.rule_id,
        reason:
          `基线规则 ${cur.rule_id} when 被改写（${cur.when || "空"} → ${next.when || "空"}）：` +
          "条件语义无法静态证明不放宽，须先 dry-run 回放 + 人工确认（L2.4）后以 allowWhenChange 显式放行",
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
