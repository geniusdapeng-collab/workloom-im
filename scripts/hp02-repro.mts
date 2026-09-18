/**
 * hp02-repro.mts —— HP-02 围栏引擎缺陷复现/复核脚本（审计证据用，非产品代码）
 *
 * 同一份脚本在修复前/修复后各跑一次，逐项打印 VERDICT，作为"修复前必现、修复后必消"的
 * 可复跑证据（命令与输出留档在审计工作区 reports/<date>/<run_id>/）。
 *
 * 覆盖：
 *   HP02-01 写类动作注册链路缺失（registerWriteActions 无生产接线 → 网关段①放行 + judge 误判 auto）
 *   HP02-02 loadFencePack 接受重复 rule_id（装载期校验缺口，L2.5）
 *   HP02-03 checkMonotonic 允许收窄 match 作用域 → 基线规则被静默架空（F2.3）
 *   HP02-04 checkMonotonic 允许把基线 when 改写为恒假（F2.3 语义放宽）
 *   HP02-05 createDryRun/confirmDryRun 吞掉 COMMIT 失败 → 返回成功但未落库（L2.4 证据失真）
 *   HP02-06 withObjectLock 的锁等待 statement_timeout 泄漏到业务语句（E2.5 误杀+误报）
 *   HP02-07 dry-run 报告缺少与现行规则的差量 → 放宽补丁看不出影响（F2.5 证据缺口）
 *   HP02-08 展示口径（DISTINCT ON 最新行）与运行时并集口径不一致（冲突优先级/证据保真）
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type RuntimeRule } from "../packages/base/fence-engine/judge.js";
import { checkMonotonic, loadFencePack } from "../packages/base/fence-engine/dsl.js";
import { isWriteAction } from "../packages/base/workdata/gateway.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOTEL_YML_LOCAL = join(HERE, "../bundles/hotel/fences/hotel-baseline.yml");
const APP_URL = process.env.DATABASE_APP_URL;
const OWNER_URL = process.env.DATABASE_URL;

const results: Array<{ id: string; verdict: "DEFECT" | "FIXED"; detail: string }> = [];
function record(id: string, fixed: boolean, defectDetail: string, fixedDetail: string) {
  results.push({ id, verdict: fixed ? "FIXED" : "DEFECT", detail: fixed ? fixedDetail : defectDetail });
  console.log(`${fixed ? "FIXED " : "DEFECT"} ${id} :: ${fixed ? fixedDetail : defectDetail}`);
}

const pack = loadFencePack(readFileSync(HOTEL_YML_LOCAL, "utf-8"));

/* ---------------- HP02-01 写类动作注册链路 ---------------- */
{
  // 酒店基线 R5 命中 order.reconcile，但硬编码前缀表未覆盖该动作；
  // 加载围栏包后应完成动作注册（gateway.ts 注释声明的契约），否则：
  //   ① 网关段①：未声明 fence_bindings 的 Agent 可直接执行（F2.10 失守）
  //   ② judge：写类动作无命中本应 default_level=review，实际被当成读类 → auto（E2.1 失守）
  const recognized = isWriteAction("order.reconcile");
  const verdict = judge({ object: { type: "order" }, action: "order.reconcile", params: {} }, [], "review");
  const ok = recognized && verdict.level === "review";
  record(
    "HP02-01 写类动作注册链路（order.reconcile）",
    ok,
    `loadFencePack 后 isWriteAction("order.reconcile")=${recognized}；无命中写动作 judge.level=${verdict.level}（应 review）`,
    `isWriteAction("order.reconcile")=${recognized}；无命中写动作 judge.level=${verdict.level}（default_level 生效）`,
  );
}

/* ---------------- HP02-02 重复 rule_id 装载校验 ---------------- */
{
  const dup = `
version: hp02-dup/v1
default_level: review
rules:
  - rule_id: R1
    name: 真规则
    level: block
    is_baseline: true
    match: { object_types: [room_price], actions: [price.adjust] }
    when: "after.price < 380"
  - rule_id: R1
    name: 影子规则
    level: auto
    is_baseline: false
    match: { object_types: [room_price], actions: [price.adjust] }
    when: "true"
`;
  let accepted = false;
  try {
    loadFencePack(dup);
    accepted = true;
  } catch {
    accepted = false;
  }
  record(
    "HP02-02 重复 rule_id 装载校验（L2.5）",
    !accepted,
    "重复 rule_id 的围栏包被接受（checkMonotonic 的 rule_id→规则映射会被后者覆盖，规则身份不可定位）",
    "重复 rule_id 在装载期被拒绝",
  );
}

/* ---------------- HP02-03 单调守卫：收窄 match 作用域 ---------------- */
{
  const narrowed: RuntimeRule[] = pack.rules.map((r) =>
    r.rule_id === "R2" ? { ...r, actions: ["never.matches"] } : r,
  );
  const res = checkMonotonic(pack.rules, narrowed);
  record(
    "HP02-03 基线 match 作用域被收窄仍判 OK（F2.3）",
    !res.ok,
    "R2（保底价熔断）actions 被改成 never.matches，level 未降、规则未删 → 守卫判 OK，基线静默失效",
    `守卫拒绝：${res.violations.map((v) => v.reason).join("；").slice(0, 120)}`,
  );
}

/* ---------------- HP02-04 单调守卫：when 改写为恒假 ---------------- */
{
  const weakened: RuntimeRule[] = pack.rules.map((r) =>
    r.rule_id === "R2" ? { ...r, when: "1 == 2" } : r,
  );
  const res = checkMonotonic(pack.rules, weakened);
  record(
    "HP02-04 基线 when 被改写为恒假仍判 OK（F2.3）",
    !res.ok,
    'R2.when "after.price < 380" → "1 == 2"，守卫判 OK（条件语义无法静态证明不放宽，应 fail-closed）',
    `守卫拒绝：${res.violations.map((v) => v.reason).join("；").slice(0, 120)}`,
  );
}

/* ---------------- HP02-05 COMMIT 失败被吞 ---------------- */
{
  const { createDryRun } = await import("../packages/base/fence-engine/lifecycle.js");
  const failingClient = {
    query: async (sql: string) => {
      if (sql === "COMMIT") throw new Error("simulated COMMIT failure");
      if (sql.startsWith("SELECT payload")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => failingClient } as unknown as pg.Pool;
  let surfaced = false;
  try {
    await createDryRun(pool, { tenantId: "t-hp02", workspaceId: "ws-hp02" }, {
      ruleId: "R1", ruleVersion: "hp02/v1", rules: pack.rules, defaultLevel: pack.defaultLevel,
      createdBy: "MEM-AUDIT",
    });
  } catch {
    surfaced = true;
  }
  record(
    "HP02-05 COMMIT 失败被吞（L2.4 证据失真）",
    surfaced,
    "COMMIT 抛错被 .catch(() => undefined) 吞掉，createDryRun 正常返回 {dryRunId, report}——报告可能未落库却被当作已确认依据",
    "COMMIT 失败向上抛出，调用方不会拿到“成功”假象",
  );
}

/* ---------------- HP02-06 对象写锁 statement_timeout 泄漏 ---------------- */
if (APP_URL && process.env.DATABASE_GATEWAY_URL) {
  const gwPool = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const { withObjectLock, ObjectLockTimeout } = await import("../packages/base/fence-engine/lifecycle.js");
  const key = `hp02-lock-${Date.now().toString(36)}`;
  let misreported = false;
  let elapsedMs = 0;
  const t0 = Date.now();
  try {
    // 无任何锁竞争：锁即时可得。业务语句 600ms > 锁等待超时 300ms。
    await withObjectLock(gwPool, key, async (c) => { await c.query("SELECT pg_sleep(0.6)"); }, 300);
  } catch (err) {
    misreported = err instanceof ObjectLockTimeout;
  }
  elapsedMs = Date.now() - t0;
  record(
    "HP02-06 锁等待超时泄漏到业务语句（E2.5）",
    !misreported,
    `无锁竞争下 600ms 业务语句被锁等待超时误杀（${elapsedMs}ms），并误报为 ObjectLockTimeout「对象写锁超时」`,
    `业务语句不受锁等待超时约束，正常完成（${elapsedMs}ms）`,
  );
  await gwPool.end();
} else {
  console.log("SKIP   HP02-06（缺少 DATABASE_APP_URL / DATABASE_GATEWAY_URL）");
}

/* ---------------- HP02-07 dry-run 差量证据 ---------------- */
{
  const { createDryRun } = await import("../packages/base/fence-engine/lifecycle.js");
  const event = (id: string) => ({
    event_id: id, tenant_id: "t-hp02", workspace_id: "ws-hp02", session_id: null,
    who: { type: "agent", id: "revenue-manager" },
    context: { tenant_id: "t-hp02", workspace_id: "ws-hp02", time: "2026-09-18T01:00:00Z" },
    object: { type: "room_price", id: "RT-DLX-KING" },
    decision: { action: "price.adjust", params: {}, before: { price: 398 }, after: { price: 300 }, effect: "write" },
    rule_impact: [], prev_hash: "0".repeat(8), hash: "1".repeat(8), created_at: "2026-09-18T01:00:00Z",
  });
  const rows = [event("E-hp02-01"), event("E-hp02-02"), event("E-hp02-03")];
  const stubClient = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT payload")) return { rows: rows.map((payload) => ({ payload })) };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => stubClient } as unknown as pg.Pool;
  const weakenedRules: RuntimeRule[] = [
    { rule_id: "R1", version: "hp02/v2", name: "涨幅", level: "auto", is_baseline: true,
      objectTypes: ["room_price"], actions: ["price.adjust"], when: "false" },
    { rule_id: "R9", version: "hp02/v2", name: "放行", level: "auto", is_baseline: false,
      objectTypes: ["room_price"], actions: ["price.adjust"], when: "true" },
  ];
  const out = await createDryRun(pool, { tenantId: "t-hp02", workspaceId: "ws-hp02" }, {
    ruleId: "R9", ruleVersion: "hp02/v2", rules: weakenedRules, defaultLevel: "auto",
    createdBy: "MEM-AUDIT",
    baseline: { rules: pack.rules, defaultLevel: pack.defaultLevel },
  });
  const delta = (out.report as { delta?: { newlyAuto: string[]; newlyBlocked: string[]; newlyReview: string[] } }).delta;
  const ok = !!delta && delta.newlyAuto.length === 3;
  record(
    "HP02-07 dry-run 缺少与现行规则的差量（F2.5）",
    ok,
    `报告只有候选规则视角（重放 3 条 → wouldBlock ${out.report.wouldBlock.length}），看不到"原本 block、现在放行"的 3 条放宽`,
    `报告给出差量：newlyAuto=${delta?.newlyAuto.length} 条（放宽在此显式暴露）`,
  );
}

/* ---------------- HP02-08 展示口径 vs 运行时口径 ---------------- */
/**
 * 从生产源码提取"按 rule_id 取一条"的 ORDER BY 口径（工作树；可用 HP02_SQL_REV=<rev> 取历史版本）。
 * 复现脚本不内联 SQL 口径——内联会让修复前后的比较失去意义。
 */
function effectiveRuleOrderSql(rev?: string): string | null {
  const rel = "apps/server/src/trpc/router.ts";
  let src: string;
  try {
    src = rev
      ? execFileSync("git", ["show", `${rev}:${rel}`], { cwd: join(HERE, ".."), encoding: "utf-8" })
      : readFileSync(join(HERE, "..", rel), "utf-8");
  } catch {
    return null;
  }
  const m = /SELECT DISTINCT ON \(rule_id\) rule_id, name, level, version, is_baseline[\s\S]*?ORDER BY rule_id,([\s\S]*?)`/.exec(src);
  if (!m) return null;
  return (
    "SELECT DISTINCT ON (rule_id) rule_id, name, level, version, is_baseline " +
    "FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id='R2' " +
    `ORDER BY rule_id,${m[1]}`
  );
}

if (APP_URL && OWNER_URL) {
  const ownerPool = new pg.Pool({ connectionString: OWNER_URL });
  const appPool = new pg.Pool({ connectionString: APP_URL });
  const WS = `ws-hp02-probe-${Date.now().toString(36)}`;
  const displaySql = effectiveRuleOrderSql(process.env.HP02_SQL_REV || undefined);
  try {
    await ownerPool.query(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by, created_at)
       VALUES ($1,'R2','hotel-baseline/v1','*','保底价熔断','block',$2,$3,true,'active','owner', now() - interval '1 hour')`,
      [`fr-hp02-base-${WS}`, JSON.stringify({ object_types: ["room_price"], actions: ["price.adjust"], when: "after.price < 380" }),
       JSON.stringify({ result: "block" })],
    );
    await ownerPool.query(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by, created_at)
       VALUES ($1,'R2','v-next',$2,'保底价（工作区改）','auto',$3,$4,false,'active','ws-admin', now())`,
      [`fr-hp02-ws-${WS}`, WS, JSON.stringify({ object_types: ["room_price"], actions: ["price.adjust"], when: "after.price < 380" }),
       JSON.stringify({ result: "auto" })],
    );
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [WS]);
      const runtime = await client.query<{ level: string; is_baseline: boolean }>(
        `SELECT level, is_baseline FROM fence_rules
          WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id='R2'`,
        [WS],
      );
      const display = displaySql
        ? await client.query<{ level: string; is_baseline: boolean }>(displaySql, [WS])
        : { rows: [] as Array<{ level: string; is_baseline: boolean }> };
      await client.query("ROLLBACK");
      const runtimeLevels = runtime.rows.map((r) => r.level).sort().join("+");
      const displayLevel = display.rows[0]?.level ?? "none(未提取到生产口径)";
      // 运行时按 deny 优先并集求值（block 生效），展示取最新行（auto）→ 证据与事实不一致
      const ok = displayLevel === "block";
      record(
        "HP02-08 展示口径与运行时口径不一致（冲突优先级）",
        ok,
        `运行时并集含 block+auto（实际冻结），展示口径 DISTINCT ON 最新行=${displayLevel}（界面显示"自动放行"）`,
        `展示口径取实际生效严格度=${displayLevel}，与运行时不变量一致（运行时=${runtimeLevels}）`,
      );
    } finally {
      client.release();
    }
  } finally {
    await ownerPool.query("DELETE FROM fence_rules WHERE id LIKE $1", [`fr-hp02-%-${WS}`]);
    await Promise.all([ownerPool.end(), appPool.end()]);
  }
} else {
  console.log("SKIP   HP02-08（缺少 DATABASE_APP_URL / DATABASE_URL）");
}

const defects = results.filter((r) => r.verdict === "DEFECT");
console.log(`\nSUMMARY total=${results.length} defect=${defects.length} fixed=${results.length - defects.length}`);
