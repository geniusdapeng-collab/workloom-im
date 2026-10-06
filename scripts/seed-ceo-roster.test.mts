/**
 * MC-121 回归：CEO 名册行必须真的落库，且跨工作区不撞号。
 *
 * 背景（2026-10-06 db-gate 实测）：`agents.id` 是全局主键。两个示例种子曾硬编码
 * 同一个裸 id `agt-company-ceo`，后写的那个命中 `ON CONFLICT (id) DO NOTHING`
 * 静默丢行——日志照打"岗位入册"，酒店工作区却始终解析不到 CEO，19 条 R 域用例
 * 与 H-04 因此全红。本文件把这两个语义固化成断言。
 */
import { describe, expect, it } from "vitest";
import { CEO_PRESET_KEY, ceoRosterId, ensureCeoRosterRow, type CeoRosterQuery } from "./seed-ceo-roster.mjs";

interface Row { id: string; workspace_id: string; preset_key: string; status: string }

/** 复刻 `agents.id` 全局主键语义的最小内存实现。 */
function memoryDb() {
  const rows: Row[] = [];
  const seen: string[] = [];
  const q: CeoRosterQuery = async (text, params = []) => {
    seen.push(text.replace(/\s+/g, " ").trim());
    if (/^INSERT INTO agents/.test(text.trim())) {
      const [id, workspaceId, presetKey] = params as string[];
      if (!rows.some((r) => r.id === id)) rows.push({ id, workspace_id: workspaceId, preset_key: presetKey, status: "ready" });
      return { rowCount: 1 };
    }
    if (/^SELECT 1 FROM agents/.test(text.trim())) {
      const [id, workspaceId, presetKey] = params as string[];
      return { rowCount: rows.filter((r) => r.id === id && r.workspace_id === workspaceId && r.preset_key === presetKey && r.status === "ready").length };
    }
    throw new Error(`未预期的 SQL：${text}`);
  };
  return { q, rows, seen };
}

describe("CEO 名册（MC-121）", () => {
  it("两个工作区各自入册互不覆盖（此前裸 id 撞号静默丢行）", async () => {
    const db = memoryDb();
    const hotel = await ensureCeoRosterRow(db.q, "ws-yunqi", { description: "酒店示例" });
    const aipm = await ensureCeoRosterRow(db.q, "ws-aipm-demo", { description: "AI PM 示例" });
    expect(hotel).not.toBe(aipm);
    expect(db.rows.map((r) => r.workspace_id).sort()).toEqual(["ws-aipm-demo", "ws-yunqi"]);
    expect(db.rows.every((r) => r.preset_key === CEO_PRESET_KEY)).toBe(true);
  });

  it("同一工作区重复执行幂等，不产生第二行", async () => {
    const db = memoryDb();
    await ensureCeoRosterRow(db.q, "ws-yunqi", {});
    await ensureCeoRosterRow(db.q, "ws-yunqi", {});
    expect(db.rows).toHaveLength(1);
  });

  it("入册后回读必须命中本工作区的 CEO 行（写入静默失败即抛错）", async () => {
    const silent: CeoRosterQuery = async (text) =>
      /^INSERT/.test(text.trim()) ? { rowCount: 0 } : { rowCount: 0 };
    await expect(ensureCeoRosterRow(silent, "ws-yunqi", {})).rejects.toThrow(/回读失败/);
  });

  it("名册 id 按工作区派生，不接受空工作区", () => {
    expect(ceoRosterId("ws-yunqi")).toBe(`agt-ws-yunqi-${CEO_PRESET_KEY}`);
    expect(ceoRosterId("ws-yunqi")).not.toBe(ceoRosterId("ws-aipm-demo"));
    expect(() => ceoRosterId("   ")).toThrow(/非空/);
  });

  it("围栏绑定落在 SQL 字面量里，且不升级为高危", async () => {
    const db = memoryDb();
    await ensureCeoRosterRow(db.q, "ws-yunqi", {});
    const insert = db.seen.find((s) => s.startsWith("INSERT INTO agents")) ?? "";
    expect(insert).toContain(`'["R1","R2"]'`);
    expect(insert).not.toMatch(/true,\s*'\["R1"/);
  });
});
