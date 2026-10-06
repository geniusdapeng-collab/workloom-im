/**
 * MC-040 / F2.10 复现：名册缺 company-ceo 时，ceo.* 写动作必须被正确拒写；
 * 种子补齐岗位事实后必须能真实写入。两个方向都在真实私有 PG 上执行。
 *
 *   node --import tsx scripts/repair-mc040-f210.ts <before|after> <DATABASE_URL>
 *
 * before：名册无 company-ceo → 期待 gateway 段① 以「未声明 fence_bindings」拒绝；
 *         此时若无拒绝（即 F2.10 放行），脚本以非零退出——红。
 * after ：种子写入名册行 → 期待 ceo.briefing 真实落库、事件可读回、链完整。
 */
import pg from "pg";
import { withPrivatePg } from "./private-pg.mts";
import { ceoActor, runBriefingBeat } from "@workloom/base/captain";
import { ensureCeoRosterRow } from "./seed-ceo-roster.mjs";

const mode = process.argv[2];
if (!["before", "after"].includes(mode ?? "")) {
  console.error("usage: repair-mc040-f210.ts <before|after>");
  process.exit(2);
}

const exitCode = await withPrivatePg(async ({ databaseUrl: url }) => {
const scope = { tenantId: `mc040-probe-${mode}`, workspaceId: `mc040-probe-ws-${mode}` };
const client = new pg.Client({ connectionString: url });
await client.connect();
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

try {
  // 私有集群所有权：listen_addresses 必须为空，且必须是 runner 自己的 /tmp/wl- 前缀。
  const listener = (await client.query("SELECT current_setting('listen_addresses') AS l")).rows[0].l;
  check(listener === "", `私有集群未监听 TCP（listen_addresses=${JSON.stringify(listener)}）`);
  check(url.includes("/tmp/wl-") || url.includes("%2Ftmp%2Fwl-"), "DATABASE_URL 指向 runner 私有 Unix socket");
  const roles = (await client.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
  check(roles.length === 2 && roles.every((r) => !r.rolsuper && !r.rolbypassrls), "app/gateway 角色均为 NOSUPERUSER/NOBYPASSRLS");

  await client.query("INSERT INTO tenants(id,name) VALUES($1,'MC-040 probe') ON CONFLICT (id) DO NOTHING", [scope.tenantId]);
  await client.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'MC-040 probe',$1,'synthetic') ON CONFLICT (id) DO NOTHING", [scope.workspaceId, scope.tenantId]);
  // 宪章必须是 trial/active：disabled 时节拍按 §12 全静默，根本走不到 gateway 段①。
  const charter = JSON.stringify({ charter: {
    version: 1,
    mode: "trial",
    identity: { name: "MC040 probe", persona: "probe" },
    autonomy: {
      ranges: { "price-change-ratio": { label: "price", lower: 0.85, upper: 1.15, anchor: 1 } },
      caps: { procurement: { label: "procurement", limit: 5000 }, campaign: { label: "campaign", limit: 2000 } },
    },
    escalate: ["probe"],
    briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
    circuit_breaker: { window_days: 14, kpi_floor: { occ: 0.7 }, tightened: false },
    grant: {
      event_id: "E-PROBE-GRANT-01", granted_by: "MEM-001",
      granted_at: new Date(Date.now() - 9 * 86400e3).toISOString(),
      disclosure_version: "risk-v1",
      clauses: ["probe"],
      shadow_days: 3, trial_days: 7,
      trial_ends_at: new Date(Date.now() + 5 * 86400e3).toISOString(),
    },
  } });
  await client.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'synthetic',$3::jsonb) ON CONFLICT (workspace_id) DO UPDATE SET archive=EXCLUDED.archive", [scope.workspaceId, scope.tenantId, charter]);

  if (mode === "after") await ensureCeoRosterRow((t, p) => client.query(t, p), scope.workspaceId, { description: "MC-040 probe CEO" });

  const actor = await ceoActor(client as unknown as pg.PoolClient, scope);
  console.log(`actor=${JSON.stringify(actor)}`);

  if (mode === "before") {
    check(actor.fenceBindings.length === 0, "缺岗时解析出空 fence_bindings（不给任何围栏授权）");
    // runBriefingBeat 内部经 gatewayAppend（自带事务）抛出的拒绝必须被调用方看见；
    // 这里同时接受同步抛错与 reject，取真实消息。
    let rejected: unknown = null;
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await runBriefingBeat(pool, scope, "daily");
    } catch (error) { rejected = error; } finally {
      // 集群在 withPrivatePg 退出时会被停止；连接池必须先关闭，否则 idle 连接会被终止。
      await pool.end();
    }
    const message = rejected instanceof Error ? `${rejected.name}: ${rejected.message}` : String(rejected ?? "");
    console.log(`rejection=${message}`);
    check(rejected !== null, "缺岗时 ceo.briefing 被拒绝（没有静默放行）");
    check(/fence_bindings|F2\.10/.test(message), "拒绝原因是 gateway 段① 的 F2.10 未声明 fence_bindings");
    const events = await client.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId]);
    check(events.rows[0].n === 0, "被拒写动作没有留下任何事件（fail closed 且无副作用）");
  } else {
    check(actor.fenceBindings.length > 0, "补齐名册后 actor 取得声明的 fence_bindings");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const beat = await runBriefingBeat(pool, scope, "daily");
    console.log(`beat=${JSON.stringify(beat)}`);
    check(Boolean(beat.eventId), "ceo.briefing 真实落库并返回 eventId");
    const row = (await client.query("SELECT event_id,payload->'decision'->>'action' AS action FROM biz_events WHERE workspace_id=$1 AND event_id=$2", [scope.workspaceId, beat.eventId])).rows[0];
    check(row?.action === "ceo.briefing", "事件可回读且 action 为 ceo.briefing");
    const who = (await client.query("SELECT payload->'who'->>'id' AS id FROM biz_events WHERE workspace_id=$1 AND event_id=$2", [scope.workspaceId, beat.eventId])).rows[0];
    check(who?.id === "company-ceo", "事件 who.id 归因为 company-ceo");
    await pool.end();
  }
} finally {
  await client.end();
}
return failures.length;
});
console.log(JSON.stringify({ mode, failures: exitCode, result: exitCode ? "fail" : "pass" }));
process.exitCode = exitCode ? 1 : 0;
