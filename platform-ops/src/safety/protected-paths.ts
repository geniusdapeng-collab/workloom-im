/**
 * safety/protected-paths —— 保护清单闸（对焦方案 §2.3）
 *
 * 单一事实源 safety/protected-paths.json，仓库侧 CI 与运行时共用：
 * diff 命中保护清单即按条目策略执行——拒绝（append-only 违例/删除）或升级审批（级别+人数+冷静期）。
 * 运行时侧：保护文件带外变更（绕过 CI）触发 safety.protected_touched 事件 + P1 告警。
 */
import { readFileSync } from "node:fs";
import type { ChangedFile, ChangeLevel } from "./change-classifier.js";

export interface ProtectedEntry {
  id: string;
  label: string;
  paths: string[];
  minLevel: ChangeLevel;
  rules: string[];
  approvers: number;
  note?: string;
}

export interface ProtectedPathsDoc {
  version: string;
  entries: ProtectedEntry[];
}

/** glob 简版匹配：**=任意路径，*=段内任意，其余字面（占位符用 \u0001 避免与字面字符冲突） */
export function matchGlob(pattern: string, path: string): boolean {
  const PLACEHOLDER = "\u0001";
  const re = new RegExp(
    "^" + pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, PLACEHOLDER)
      .replace(/\*/g, "[^/]*")
      .replace(new RegExp(PLACEHOLDER, "g"), ".*") + "$",
  );
  return re.test(path);
}

export function loadProtectedPaths(file: string): ProtectedPathsDoc {
  return JSON.parse(readFileSync(file, "utf-8")) as ProtectedPathsDoc;
}

export type GuardVerdict =
  | { action: "allow" }
  | { action: "deny"; entry: string; reason: string }
  | { action: "require"; entry: string; minLevel: ChangeLevel; approvers: number; coolingHours?: number; note?: string };

/** 逐文件判定：任一文件 deny 即整体 deny；否则聚合最高的 require */
export function guardDiff(doc: ProtectedPathsDoc, files: ChangedFile[]): GuardVerdict[] {
  const verdicts: GuardVerdict[] = [];
  for (const f of files) {
    for (const e of doc.entries) {
      if (!e.paths.some((p) => matchGlob(p, f.path))) continue;
      // 规则① append-only：已有文件只允许存在，修改/删除即拒
      if (e.rules.includes("append-only") && f.kind !== "added") {
        verdicts.push({ action: "deny", entry: e.id, reason: `${e.label} append-only 纪律：${f.kind === "deleted" ? "删除" : "改写"}已有文件 ${f.path}` });
        continue;
      }
      // 规则② no-delete：删除即拒
      if (e.rules.includes("no-delete") && f.kind === "deleted") {
        verdicts.push({ action: "deny", entry: e.id, reason: `${e.label}禁止删除：${f.path}` });
        continue;
      }
      // 规则③ 围栏放宽冷静期：净删除视为放宽方向（就高不就低）
      const loosenSuspect = e.rules.includes("loosen-needs-cooling") && (f.deletedLines ?? 0) > (f.addedLines ?? 0);
      verdicts.push({
        action: "require", entry: e.id, minLevel: e.minLevel, approvers: e.approvers,
        coolingHours: loosenSuspect ? 24 : 0,
        note: loosenSuspect ? `${e.note ?? ""}（净删除疑似放宽方向，触发 24h 冷静期）` : e.note,
      });
    }
  }
  return verdicts;
}

/** 聚合：deny 优先；否则取最高级别 require */
export function aggregateVerdicts(verdicts: GuardVerdict[]): GuardVerdict {
  const deny = verdicts.find((v) => v.action === "deny");
  if (deny) return deny;
  const rank: Record<ChangeLevel, number> = { C0: 0, C1: 1, C2: 2, C3: 3 };
  const requires = verdicts.filter((v): v is Extract<GuardVerdict, { action: "require" }> => v.action === "require");
  if (requires.length === 0) return { action: "allow" };
  return requires.reduce((a, b) =>
    rank[b.minLevel] > rank[a.minLevel] || (b.coolingHours ?? 0) > (a.coolingHours ?? 0) ? b : a);
}

/** 运行时带外变更检测（绕过 CI 的修改 → P1 告警事件） */
export function detectOutOfBandTouch(doc: ProtectedPathsDoc, touchedPaths: string[]): Array<{ entry: string; path: string; level: "P1" }> {
  const out: Array<{ entry: string; path: string; level: "P1" }> = [];
  for (const p of touchedPaths) {
    for (const e of doc.entries) {
      if (e.paths.some((g) => matchGlob(g, p))) out.push({ entry: e.id, path: p, level: "P1" });
    }
  }
  return out;
}
