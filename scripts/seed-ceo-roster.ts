/**
 * seed-ceo-roster · 数字 CEO 岗位事实（MC-040 / MC-121）
 *
 * CEO Loop 的每一次 ceo.* 写动作都在同一事务内按 `preset_key='company-ceo'`
 * 从 agents 名册解析 actor（`packages/base/captain/loop.ts#ceoActor`）。名册缺行、
 * 停用、无效或重复在编时解析出空 fence_bindings，gateway 段①按 F2.10 正确拒写——
 * 所以种子必须真的把这一行写进去。
 *
 * 两个种子（seed.ts 酒店示例 / seed-aipm.ts AI 产品经理示例）都要在同一库里落这一行，
 * 而 `agents.id` 是**全局**主键：两处硬编码同一个裸 id 时，后写的那个会命中
 * `ON CONFLICT (id) DO NOTHING` 静默丢行（实测：酒店工作区永远解析不到 CEO，
 * 而日志照样打印"岗位入册"）。因此这里：
 *   ① id 按工作区派生，跨工作区不撞号；
 *   ② 写入后回读，行不在就抛错——不允许再出现"报告成功、实际没写"。
 */

/** 两个种子共用的调用形态：`(text, params) => Promise<{ rowCount }>`（pg.Client.query 的绑定形式）。 */
export type CeoRosterQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rowCount: number | null }>;

/** CEO 岗位标识：与 `loop.ceoActor` 的 CEO_PRESET_KEY 同一取值。 */
export const CEO_PRESET_KEY = "company-ceo";

/** 名册主键按工作区派生；`who.id` 仍归因为 preset_key（见 captain/board.ts、scorecard.ts）。 */
export function ceoRosterId(workspaceId: string): string {
  if (!workspaceId.trim()) throw new Error("CEO 名册需要非空 workspace_id");
  return `agt-${workspaceId}-${CEO_PRESET_KEY}`;
}

/**
 * 幂等写入 CEO 岗位事实，并回读确认。
 * 只补齐 CEO 自己的岗位事实，不放宽 gateway：绑定基线围栏 R1/R2，与其它岗位同一套规则。
 */
export async function ensureCeoRosterRow(
  q: CeoRosterQuery,
  workspaceId: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const id = ceoRosterId(workspaceId);
  await q(
    `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
     VALUES ($1,$2,$3,'顾云峥','v1.0','commander',false,'["R1","R2"]','[]','ready',$4)
     ON CONFLICT (id) DO NOTHING`,
    [id, workspaceId, CEO_PRESET_KEY, JSON.stringify(meta)],
  );
  const readBack = await q(
    `SELECT 1 FROM agents WHERE id=$1 AND workspace_id=$2 AND preset_key=$3 AND status='ready'`,
    [id, workspaceId, CEO_PRESET_KEY],
  );
  if (readBack.rowCount !== 1) {
    throw new Error(
      `CEO 岗位入册后回读失败（id=${id} / workspace=${workspaceId}）——` +
      "agents.id 可能与其它工作区撞号，或该行被并发改写；拒绝以「已入册」收尾",
    );
  }
  return id;
}
