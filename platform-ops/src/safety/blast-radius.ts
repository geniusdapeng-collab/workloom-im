/**
 * safety/blast-radius —— 影响范围分析（对焦方案 §2.4 G4 闸）
 *
 * 三件事：
 * ① 依赖反向索引：改动模块被谁引用（跨包引用=自动升 C2）；
 * ② 事件 schema 兼容检查：只允许新增字段/枚举值（向后兼容），破坏性变更拒或要求双版本并行；
 * ③ 扇出预估：命中 base-sync include → 列出将被同步的子仓清单，人审确认（T6 级联放大的总闸）。
 */
import type { ChangedFile } from "./change-classifier.js";
import { matchGlob } from "./protected-paths.js";

/* ---------------- ① 依赖反向索引 ---------------- */

export interface ImportEdge { from: string; to: string }

/** 从源码 import 语句提取依赖边（CI 时全仓扫描注入；测试用小图） */
export function buildReverseIndex(edges: ImportEdge[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to)!.push(e.from);
  }
  return rev;
}

/** 改动文件的下游受影响方（BFS，深度上限防爆炸） */
export function dependentsOf(rev: Map<string, string[]>, changed: string[], maxDepth = 3): Map<string, number> {
  const out = new Map<string, number>();
  let frontier = changed.map((c) => stripExt(c));
  const seen = new Set(frontier);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const dep of rev.get(node) ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        out.set(dep, depth);
        next.push(dep);
      }
    }
    frontier = next;
  }
  return out;
}

function stripExt(p: string): string { return p.replace(/\.(ts|tsx|js|mts)$/, ""); }

export function parseImports(source: string, fromPath: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    if (spec.startsWith(".")) {
      const resolved = resolveRelative(fromPath, spec);
      edges.push({ from: stripExt(fromPath), to: stripExt(resolved) });
    }
  }
  return edges;
}

function resolveRelative(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/* ---------------- ② 事件 schema 兼容检查 ---------------- */

export interface SchemaCompatIssue { path: string; issue: string; severity: "reject" | "dual-version-required" }

/** additive-only：只允许新增字段/枚举值。输入为新旧对象/枚举数组（JSON 解析后）。 */
export function checkSchemaCompat(
  path: string,
  before: { objects?: Array<{ type: string }> | string[]; stages?: Array<{ id: string }> | string[] },
  after: { objects?: Array<{ type: string }> | string[]; stages?: Array<{ id: string }> | string[] },
): SchemaCompatIssue[] {
  const issues: SchemaCompatIssue[] = [];
  const names = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String((x as { type?: string; id?: string }).type ?? (x as { id?: string }).id))) : [];
  for (const [key, label] of [["objects", "对象枚举"], ["stages", "阶段枚举"]] as const) {
    const b = new Set(names(before[key as keyof typeof before]));
    const a = new Set(names(after[key as keyof typeof after]));
    for (const removed of b) {
      if (!a.has(removed)) {
        issues.push({ path, issue: `${label}「${removed}」被删除/改名（破坏性变更）`, severity: "dual-version-required" });
      }
    }
  }
  return issues;
}

/* ---------------- ③ 扇出预估 ---------------- */

export interface SyncScope { include: string[] }
export interface ChildRepo { repo: string; pathPrefix?: string; extraExclude?: string[] }

/** 改动命中 base-sync include → 将被同步的子仓清单（人审确认点） */
export function estimateFanout(
  files: ChangedFile[],
  scope: SyncScope,
  children: ChildRepo[],
): { inScope: string[]; affectedChildren: string[] } {
  const inScope = files
    .filter((f) => scope.include.some((g) => matchGlob(g, f.path)))
    .map((f) => f.path);
  const affectedChildren = inScope.length === 0 ? [] : children.map((c) => c.repo);
  return { inScope, affectedChildren };
}

/* ---------------- G4 汇总 ---------------- */

export interface BlastRadiusReport {
  dependents: Array<{ path: string; depth: number }>;
  crossPackage: boolean;
  schemaIssues: SchemaCompatIssue[];
  fanout: { inScope: string[]; affectedChildren: string[] };
  escalateToC2: boolean;
  summary: string;
}

export function buildBlastRadiusReport(input: {
  files: ChangedFile[];
  reverseIndex: Map<string, string[]>;
  schemaPairs?: Array<{ path: string; before: never; after: never }>;
  scope?: SyncScope;
  children?: ChildRepo[];
}): BlastRadiusReport {
  const deps = dependentsOf(input.reverseIndex, input.files.map((f) => f.path));
  const depList = [...deps.entries()].map(([path, depth]) => ({ path, depth }));
  const changedRoots = new Set(input.files.map((f) => f.path.split("/").slice(0, 2).join("/")));
  const crossPackage = depList.some((d) => !changedRoots.has(d.path.split("/").slice(0, 2).join("/")));
  const schemaIssues = (input.schemaPairs ?? []).flatMap((p) => checkSchemaCompat(p.path, p.before, p.after));
  const fanout = input.scope ? estimateFanout(input.files, input.scope, input.children ?? []) : { inScope: [], affectedChildren: [] };
  const escalateToC2 = crossPackage || schemaIssues.length > 0 || fanout.affectedChildren.length > 0;
  const summary = [
    `下游受影响 ${depList.length} 个模块${crossPackage ? "（含跨包引用）" : ""}`,
    schemaIssues.length > 0 ? `schema 破坏性变更 ${schemaIssues.length} 处` : "schema 兼容",
    fanout.affectedChildren.length > 0 ? `扇出 ${fanout.affectedChildren.length} 个子仓` : "无同步扇出",
  ].join("；");
  return { dependents: depList, crossPackage, schemaIssues, fanout, escalateToC2, summary };
}
