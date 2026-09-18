/**
 * hp02-action-inventory.mts —— HP-02 围栏引擎动作清单取证（审计用，只读）
 *
 * 回答三个问题（HP-02 验收：所有写已分类 / 未知写阻断 / 规则版本可追溯）：
 *  ① 各行业包 preset 声明的 tool（access=write）是否被 gateway.isWriteAction 认定为写类动作？
 *  ② preset 的写类 tool 名是否被本行业围栏包的 rule.actions 覆盖（否则规则永不命中）？
 *  ③ 围栏包默认级别 / 规则数量 / 版本分布（可追溯性输入）。
 *
 * 用法：node --import tsx scripts/hp02-action-inventory.mts [--json]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { classifyAction, isWriteAction, registerReadActions, registerWriteActions } from "../packages/base/workdata/gateway.js";
import { actionMatches } from "../packages/base/fence-engine/judge.js";

const ROOT = process.cwd();
const BUNDLES = join(ROOT, "bundles");

interface ToolRow { bundle: string; preset: string; tool: string; access: string; isWrite: boolean; coveredBy: string[] }
interface BundleRow {
  bundle: string;
  fenceVersion: string | null;
  defaultLevel: string | null;
  ruleCount: number;
  ruleActions: string[];
  writeTools: number;
  unclassifiedWrites: string[];
  uncoveredWrites: string[];
  tools: ToolRow[];
}

function loadPresets(dir: string): Array<{ key: string; tools: Array<{ name: string; access: string }> }> {
  const presetsDir = join(dir, "presets");
  if (!existsSync(presetsDir)) return [];
  return readdirSync(presetsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort()
    .map((f) => {
      const doc = YAML.parse(readFileSync(join(presetsDir, f), "utf-8")) as
        { preset_key?: string; tools?: Array<{ name?: string; access?: string }> };
      return {
        key: String(doc.preset_key ?? f.replace(/\.ya?ml$/, "")),
        tools: (doc.tools ?? []).map((t) => ({ name: String(t.name ?? ""), access: String(t.access ?? "write") })),
      };
    });
}

interface RawRule {
  rule_id?: unknown; name?: unknown; level?: unknown; is_baseline?: unknown; when?: unknown;
  match?: { object_types?: unknown; actions?: unknown } | null;
}

/**
 * 宽容读取围栏包（与 scripts/seed-aipm.ts 同口径：`fences ?? rules`），
 * 并同时报告本文件使用的键名——这正是 HP-02 要暴露的「三套装载器」问题。
 */
function loadFenceRules(dir: string): {
  version: string; defaultLevel: string; keyName: string;
  rules: Array<{ rule_id: string; actions: string[]; level: string; is_baseline: boolean; when: string }>;
} | null {
  const fencesDir = join(dir, "fences");
  if (!existsSync(fencesDir)) return null;
  const files = readdirSync(fencesDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  const rules: Array<{ rule_id: string; actions: string[]; level: string; is_baseline: boolean; when: string }> = [];
  let version = "";
  let defaultLevel = "";
  let keyName = "";
  for (const f of files) {
    const doc = YAML.parse(readFileSync(join(fencesDir, f), "utf-8")) as
      { version?: string; default_level?: string; rules?: RawRule[]; fences?: RawRule[] };
    const raw = doc.rules ?? doc.fences ?? [];
    keyName = [keyName, doc.rules ? "rules" : "fences"].filter(Boolean).join("+");
    version = version ? `${version}+${doc.version ?? ""}` : String(doc.version ?? "");
    defaultLevel = defaultLevel ? `${defaultLevel}+${doc.default_level ?? ""}` : String(doc.default_level ?? "");
    for (const r of raw) {
      rules.push({
        rule_id: String(r.rule_id ?? ""),
        actions: Array.isArray(r.match?.actions) ? (r.match!.actions as unknown[]).map(String) : [],
        level: String(r.level ?? ""),
        is_baseline: r.is_baseline === true,
        when: typeof r.when === "string" ? r.when : "",
      });
    }
  }
  return { version, defaultLevel, keyName, rules };
}

const rows: BundleRow[] = [];
// 先按装配期口径登记所有 preset 工具动作（与 computeAssembly 同一动作），
// 再统计——这样输出与运行时分类一致（未登记 = 真·未分类，运行时按写兜底）。
const allDeclaredTools: Array<{ name: string; access: string }> = [];
for (const bundle of readdirSync(BUNDLES).sort()) {
  const dir = join(BUNDLES, bundle);
  if (!existsSync(join(dir, "bundle.json"))) continue;
  const presets = loadPresets(dir);
  for (const p of presets) allDeclaredTools.push(...p.tools);
}
registerWriteActions([...new Set(allDeclaredTools.filter((t) => t.access !== "read").map((t) => t.name))]);
registerReadActions([...new Set(allDeclaredTools.filter((t) => t.access === "read").map((t) => t.name))]);

for (const bundle of readdirSync(BUNDLES).sort()) {
  const dir = join(BUNDLES, bundle);
  if (!existsSync(join(dir, "bundle.json"))) continue;
  const presets = loadPresets(dir);
  const fences = loadFenceRules(dir);
  const ruleActions = fences ? [...new Set(fences.rules.flatMap((r) => r.actions))].sort() : [];
  const tools: ToolRow[] = [];
  for (const p of presets) {
    for (const t of p.tools) {
      if (!t.name) continue;
      tools.push({
        bundle, preset: p.key, tool: t.name, access: t.access,
        isWrite: isWriteAction(t.name),
        // 覆盖判定按判定器的动作匹配语义（精确 / 动词段 / 命名空间后缀），
        // 而不是字符串全等——否则"规则写 price.adjust、运行时用 pms.price.write"会误报未覆盖。
        coveredBy: fences
          ? fences.rules.filter((r) => r.actions.some((a) => actionMatches(a, t.name))).map((r) => r.rule_id)
          : [],
      });
    }
  }
  const writeTools = tools.filter((t) => t.access === "write");
  rows.push({
    bundle,
    fenceVersion: fences?.version ?? null,
    defaultLevel: fences?.defaultLevel ?? null,
    ruleCount: fences?.rules.length ?? 0,
    ruleActions,
    writeTools: writeTools.length,
    unclassifiedWrites: [...new Set(writeTools.filter((t) => !t.isWrite).map((t) => t.tool))],
    uncoveredWrites: [...new Set(writeTools.filter((t) => t.coveredBy.length === 0).map((t) => t.tool))],
    tools,
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(`\n===== ${r.bundle}  fence=${r.fenceVersion ?? "-"}  default_level=${r.defaultLevel ?? "-"}  rules=${r.ruleCount}`);
    console.log(`  rule.actions = ${r.ruleActions.join(", ") || "（无）"}`);
    console.log(`  写类 tool ${r.writeTools} 个；其中未**显式**登记为写（运行时按写兜底，classify=unknown）= ${r.unclassifiedWrites.length}：${r.unclassifiedWrites.join(", ") || "无"}`);
    console.log(`  写类 tool 未被任何规则覆盖（将落入 default_level）= ${r.uncoveredWrites.length}：${r.uncoveredWrites.join(", ") || "无"}`);
    for (const t of r.tools.filter((x) => x.access === "write")) {
      console.log(`    - ${t.tool}  classify=${classifyAction(t.tool)}  rules=[${t.coveredBy.join(",")}]`);
    }
  }
}
