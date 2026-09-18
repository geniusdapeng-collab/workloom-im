/**
 * hp01-repro.mts —— HP-01 租户覆盖层缺陷复现/复核脚本（审计证据用，非产品代码）
 *
 * 同一份脚本在修复前/修复后各跑一次，逐项打印 VERDICT，作为"修复前必现、修复后必消"的
 * 可复跑证据（命令与输出留档在审计工作区 work/evidence/）。
 */
import pg from "pg";
import { OverlayError, parseOverlay, type OverlayDoc, type OverlayItem } from "../packages/base/overlay/model.js";
import { mergeOverlay, type BundleAssetView } from "../packages/base/overlay/merge.js";
import { detectRebase } from "../packages/base/overlay/rebase.js";
import { saveDraft, transition } from "../packages/base/overlay/store.js";

const APP_URL = process.env.DATABASE_APP_URL;
const OWNER_URL = process.env.DATABASE_URL;
const results: Array<{ id: string; verdict: "DEFECT" | "FIXED"; detail: string }> = [];

function record(id: string, fixed: boolean, defectDetail: string, fixedDetail: string) {
  results.push({ id, verdict: fixed ? "FIXED" : "DEFECT", detail: fixed ? fixedDetail : defectDetail });
  console.log(`${fixed ? "FIXED " : "DEFECT"} ${id} :: ${fixed ? fixedDetail : defectDetail}`);
}

function view(): BundleAssetView {
  return {
    bj: { name: "hotel", workloom: { provides: { skills: ["skills/kb-fresh/SKILL.md"] } } },
    presets: [{ preset_key: "fae-chief" }],
    fencePacks: [{ fences: [{ rule_id: "R-MK2", level: "review" }] }],
    extra: { faq: [{ id: "a1", q: "q", a: "a" }] },
  };
}

const forgedDoc = (items: unknown[]): OverlayDoc => ({
  tenant_id: "t-repro", base_bundle: "hotel", base_version: "2.3.0",
  overlay_version: 1, status: "active", items: items as OverlayItem[],
});

/* ① 原型污染：__proto__ 路径 */
{
  delete (Object.prototype as Record<string, unknown>).polluted;
  const doc = forgedDoc([{ type: "persona", op: "override", path: "__proto__/polluted", value: "yes" }]);
  let rejected = false;
  try { mergeOverlay(view(), doc); } catch { rejected = true; }
  const polluted = ({} as Record<string, unknown>).polluted;
  record("HP01-01 原型污染(__proto__)", rejected && polluted === undefined,
    `merge 未拒绝且 Object.prototype.polluted=${String(polluted)}（进程级原型污染）`,
    "merge 拒绝该路径，Object.prototype 未被污染");
  delete (Object.prototype as Record<string, unknown>).polluted;
}

/* ② 写入侧不可覆盖路径 */
{
  let rejected = false;
  try {
    parseOverlay(forgedDoc([{ type: "persona", op: "override", path: "ledger/rules", value: "x" }]) as unknown);
  } catch (e) { rejected = e instanceof OverlayError; }
  record("HP01-02 写入侧红线路径(ledger/)", rejected,
    "parseOverlay 接受了账本路径（不可覆盖清单只在合并期生效，脏草稿可落库）",
    "parseOverlay 在写入侧即拒");
}

/* ③ 阈值区间自指：覆盖层自带超大 bounds */
{
  let rejected = false;
  let detail = "";
  try {
    mergeOverlay(view(), forgedDoc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 5_000_000, bounds: { min: 0, max: 10_000_000 },
    }]));
    detail = "超大区间被接受";
  } catch (e) { rejected = true; detail = (e as Error).message; }
  record("HP01-03 阈值区间自指(放宽红线)", rejected,
    `${detail}：覆盖层用自带的 bounds 给自己发许可证（退款上限可被抬到 500 万）`,
    `拒绝：${detail}`);
}

/* ④ rebase 误删阈值定制 */
{
  const doc = forgedDoc([{
    type: "threshold", op: "override", path: "approval/refund-credits",
    value: 800, bounds: { min: 0, max: 1000 },
  }]);
  const report = detectRebase(doc, view(), "2.4.0");
  record("HP01-04 rebase 静默丢弃阈值定制", report.autoFallback === 0,
    `autoFallback=${report.autoFallback}（行业包未声明阈值默认值 → 升级时定制被静默删除）`,
    "autoFallback=0（按基座允许区间裁决，定制保留）");
}

/* ⑤ 应用角色 + RLS：池直查（修复前 router 的做法）是否可用 */
if (APP_URL && OWNER_URL) {
  const appPool = new pg.Pool({ connectionString: APP_URL, connectionTimeoutMillis: 3000 });
  const ownerPool = new pg.Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 3000 });
  const scope = { workspaceId: "ws-hp01-repro", tenantId: "tn-hp01-repro" };
  const bundle = "hotel";
  try {
    await ownerPool.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [scope.workspaceId]);
    await ownerPool.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]);

    // 特征探测：修复后 store 暴露 withOverlayTx（生产接线入口）；修复前不存在，
    // 复现的正是修复前 overlay-router 的做法——直接用连接池（无事务级 GUC）。
    const store = await import("../packages/base/overlay/store.js") as unknown as {
      saveDraft: typeof saveDraft;
      withOverlayTx?: <T>(pool: pg.Pool, scope: typeof scope, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
    };
    const draftInput = {
      tenant_id: scope.tenantId, base_bundle: bundle, base_version: "2.3.0",
      items: [{ type: "persona", op: "override", path: "service-front/tone", value: "x" }] as OverlayItem[],
      note: "repro", createdBy: "MEM-REPRO",
    };
    let usable = false;
    let errText = "";
    try {
      if (store.withOverlayTx) {
        await store.withOverlayTx(appPool, scope, (c) => store.saveDraft(c, scope, draftInput));
      } else {
        await store.saveDraft(appPool, scope, draftInput);
      }
      usable = true;
    } catch (e) { errText = (e as Error).message; }
    record("HP01-05 应用角色(RLS)下覆盖层可用性", usable,
      `覆盖层在生产接线下不可用：${errText}（router 直用连接池 → 无事务级 GUC → RLS 恒 false）`,
      "生产接线走事务级 GUC（withOverlayTx）→ 应用角色下可正常读写");

    /* ⑥ 并发激活：单 active 约束 */
    const manual = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const c = await appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
      finally { c.release(); }
    };
    const mk = (n: string, ratio: number) => manual((c) => saveDraft(c, scope, {
      tenant_id: scope.tenantId, base_bundle: bundle, base_version: "2.3.0",
      canary_scope: { ratio }, note: n, createdBy: "MEM-REPRO",
      items: [{ type: "persona", op: "override", path: "service-front/tone", value: n }] as OverlayItem[],
    }));
    const b = await mk("B", 0.2);
    await manual((c) => transition(c, scope, bundle, b.overlay_version, "canary"));
    await manual((c) => transition(c, scope, bundle, b.overlay_version, "active"));
    // 旁路写入：把另一行直接置 active（模拟并发切换/运维脚本/竞态残留）
    const a = await mk("A", 0.1);
    let bypassRejected = false;
    try {
      await manual((c) => c.query(
        `UPDATE tenant_overlays SET status='active', updated_at=now()
          WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND overlay_version=$4`,
        [scope.workspaceId, scope.tenantId, bundle, a.overlay_version],
      ));
    } catch { bypassRejected = true; }
    const act = await manual((c) => c.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM tenant_overlays
        WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='active'`,
      [scope.workspaceId, scope.tenantId, bundle],
    ));
    const activeCount = act.rows[0]!.c;
    record("HP01-06 单 active 数据库兜底（旁路写第二行 active）", bypassRejected && activeCount === 1,
      `旁路写入被接受，active 行数=${activeCount}（无约束 → 双 active，生效配置随机）`,
      `旁路写入被数据库拒绝，active 行数=${activeCount}（部分唯一索引兜底）`);

    const idx = await ownerPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM pg_indexes WHERE indexname='uq_tenant_overlays_one_active'",
    );
    record("HP01-07 数据库层单 active 兜底索引", idx.rows[0]!.c === 1,
      "缺少 uq_tenant_overlays_one_active（只靠应用层自觉）",
      "部分唯一索引已存在（旁路写入无法造双 active）");

    await ownerPool.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [scope.workspaceId]);
    await ownerPool.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]);
  } finally {
    await Promise.all([appPool.end(), ownerPool.end()]);
  }
} else {
  console.log("SKIP   HP01-05/06/07（缺少 DATABASE_APP_URL / DATABASE_URL）");
}

const defects = results.filter((r) => r.verdict === "DEFECT");
console.log(`\nSUMMARY total=${results.length} defect=${defects.length} fixed=${results.length - defects.length}`);
