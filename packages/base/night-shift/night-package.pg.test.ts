/**
 * MC-015/115 · 首次清晨决策包快照契约。
 * 真实 PG/RLS/网关/只增账本；仅 task-owned Unix fixture 运行，普通单测明确 skip。
 * 独立复跑：python3 <项目工作目录>/work/night-package-verify.py pg independent-night-package base hotel。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { BusinessEvent } from "@workloom/shared";
import { deliverPackage, projectNightPackage, type NightPackage } from "./package.js";
import { gatewayAppend } from "../workdata/gateway.js";
import { eventHash, GENESIS_HASH } from "../workdata/events.js";

const nonce = process.env.NIGHT_PACKAGE_NONCE ?? "disabled";
const socket = process.env.NIGHT_PACKAGE_SOCKET ?? "/tmp/wl-night-package-disabled";
const database = process.env.NIGHT_PACKAGE_DATABASE ?? "night_package_disabled";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && process.env.NIGHT_PACKAGE_TASK_OWNED === "1"
  && socket.startsWith("/tmp/wl-night-package-") && /^night_package_(base|hotel)_[a-f0-9]+$/.test(database)
  && /^[a-f0-9]{10}$/.test(nonce);
const d = RUN_DB ? describe : describe.skip;
type Scope = { tenantId: string; workspaceId: string };
type Observation = { name: string; given: string; steps: string; expected: string; actual?: unknown; result: string; error?: string };

d("MC-015 · 首次夜班决策包真实 PG 契约", () => {
  const config = { host: socket, port: Number(process.env.NIGHT_PACKAGE_PORT ?? "65440"), database,
    connectionTimeoutMillis: 5000, statement_timeout: 8000 };
  const owner = new pg.Pool({ ...config, user: "postgres", max: 2 });
  const app = new pg.Pool({ ...config, user: "workloom_app", max: 16 });
  const gateway = new pg.Pool({ ...config, user: "workloom_gateway", max: 2 });
  const tenantId = `night-package-contract-tenant-${nonce}`;
  const foreignTenantId = `night-package-contract-foreign-${nonce}`;
  const wide = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };
  const eventTime = "2030-07-02T00:00:00.000Z";
  const emptyPackage = (): NightPackage => ({ done: [], pending: [], needHuman: [], truncated: 0,
    stats: { done: 0, pending: 0, need_human: 0, credits_used: 0 } });
  const observations: Observation[] = [];
  let serial = 0;

  async function makeScope(tenant = tenantId): Promise<Scope> {
    const workspaceId = `night-package-${nonce}-${++serial}`;
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES ($1,$2,'合成夜班契约工作区',$1,'synthetic')", [workspaceId, tenant]);
    return { tenantId: tenant, workspaceId };
  }

  async function makeRun(scope: Scope, status = "running", id?: string): Promise<string> {
    const runId = id ?? `night-package-run-${nonce}-${++serial}`;
    await owner.query("INSERT INTO night_runs(id,workspace_id,run_date,status) VALUES ($1,$2,$3,$4)",
      [runId, scope.workspaceId, `synthetic-date-${serial}`, status]);
    return runId;
  }

  async function emit(scope: Scope, kind: "done" | "pending" | "blocked" | "unverified" = "done", credits = 1, at = eventTime): Promise<BusinessEvent> {
    const result = await gatewayAppend(gateway, { ...scope, actor: { id: "system", type: "system" } }, {
      who: { id: "system", type: "system" }, context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at },
      object: { type: "synthetic-record", id: `record-${++serial}` },
      decision: { action: `synthetic.${kind}`, before: { value: "before" }, after: { value: "after", special: "中文 & ' \" \\" } },
      rule_impact: kind === "done" ? [] : [
        { rule_id: "TEST-NIGHT", version: "v1", result: kind === "pending" ? "review" : kind === "blocked" ? "blocked" : "pass" },
        { rule_id: "TEST-NIGHT", version: "v1", result: kind === "pending" ? "review" : kind === "blocked" ? "blocked" : "pass" },
      ],
      model_trace: { model_id: "synthetic-no-model-call", credits },
      receipt: kind === "unverified" ? undefined : { synced: true, mode: "simulated", snapshot_uri: "synthetic://night/package" },
    });
    return (await owner.query<{ payload: BusinessEvent }>("SELECT payload FROM biz_events WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, result.eventId])).rows[0]!.payload;
  }

  async function state(scope: Scope, runId: string) {
    const rows = (await owner.query("SELECT * FROM night_runs WHERE id=$1 AND workspace_id=$2", [runId, scope.workspaceId])).rows;
    const deliveries = (await owner.query("SELECT seq::text,event_id,payload,prev_hash,hash,created_at::text FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='night.package.deliver' AND payload->'decision'->'after'->>'runId'=$3 ORDER BY seq", [scope.tenantId, scope.workspaceId, runId])).rows;
    const writes = (await owner.query("SELECT run_id,before_status,after_status FROM night_package_probe_writes WHERE run_id=$1 ORDER BY id", [runId])).rows;
    return { rows, deliveries, writes };
  }

  async function historical(scope: Scope, runId: string, after: unknown, actorId = "night-shift", object = { type: "store", id: scope.workspaceId }) {
    return gatewayAppend(gateway, { ...scope, actor: { id: actorId, type: "system" } }, {
      who: { id: actorId, type: "system" }, context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: eventTime },
      object, decision: { action: "night.package.deliver", after }, rule_impact: [],
    });
  }

  function instrument(pool: pg.Pool, query: (client: pg.PoolClient, text: string, values?: unknown[]) => Promise<pg.QueryResult>, release?: (error?: Error | boolean) => void): pg.Pool {
    return { connect: async () => {
      const client = await pool.connect();
      return { query: (text: string, values?: unknown[]) => query(client, text, values),
        release: (error?: Error | boolean) => { release?.(error); client.release(error); } } as unknown as pg.PoolClient;
    } } as unknown as pg.Pool;
  }

  function check(name: string, given: string, expected: string, run: (entry: Observation) => Promise<void>) {
    it(name, async () => {
      const entry: Observation = { name, given, expected, steps: "准备独占合成夹具；调用实际 deliverPackage/网关；owner 直查状态、事件、探针和哈希链", result: "not-run" };
      observations.push(entry);
      try { await run(entry); entry.result = "pass"; }
      catch (error) { entry.result = "fail"; entry.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { vi.useRealTimers(); }
    });
  }

  beforeAll(async () => {
    expect((await app.query("SELECT current_user AS role")).rows[0]!.role).toBe("workloom_app");
    expect((await gateway.query("SELECT current_user AS role")).rows[0]!.role).toBe("workloom_gateway");
    const roles = (await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway')")).rows;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }, { rolsuper: false, rolbypassrls: false }]);
    expect((await app.query("SHOW transaction_isolation")).rows[0]!.transaction_isolation).toBe("read committed");
    await owner.query("INSERT INTO tenants(id,name) VALUES ($1,'合成夜班契约租户'),($2,'合成外租户')", [tenantId, foreignTenantId]);
    await owner.query("CREATE TABLE night_package_probe_writes(id BIGSERIAL PRIMARY KEY,run_id TEXT,before_status TEXT,after_status TEXT)");
    await owner.query("CREATE FUNCTION night_package_probe_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN INSERT INTO night_package_probe_writes(run_id,before_status,after_status) VALUES (NEW.id,OLD.status,NEW.status); RETURN NEW; END $$");
    await owner.query("CREATE TRIGGER night_package_probe AFTER UPDATE ON night_runs FOR EACH ROW EXECUTE FUNCTION night_package_probe_update()");
  });

  afterAll(async () => {
    try {
      const events = (await owner.query("SELECT tenant_id,workspace_id,payload,prev_hash,hash FROM biz_events ORDER BY seq")).rows;
      const tails = new Map<string, string>();
      for (const row of events) {
        const key = `${row.tenant_id}:${row.workspace_id}`;
        expect(row.prev_hash).toBe(tails.get(key) ?? GENESIS_HASH);
        expect(row.hash).toBe(eventHash(row.prev_hash, row.payload));
        tails.set(key, row.hash);
      }
      const report = process.env.NIGHT_PACKAGE_REPORT_DIR;
      if (report) await writeFile(join(report, `${process.env.NIGHT_PACKAGE_REPO}-observations.json`), `${JSON.stringify({
        environment_claim: "local-preview; task-owned Unix-only PG; synthetic data", observations,
        hash_chain: { events: events.length, workspace_chains: tails.size, result: "pass" },
      }, null, 2)}\n`, { flag: "wx" });
    } finally { await Promise.all([app.end(), gateway.end(), owner.end()]); }
  });

  check("空窗口首次交付与重试都是同一份空包", "running 班次，无事件", "空三段、零统计；单次更新与单个交付事件；重试完全相同", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope);
    const first = await deliverPackage(app, gateway, scope, id, wide);
    const again = await deliverPackage(app, gateway, scope, id, wide);
    const actual = await state(scope, id); entry.actual = actual;
    expect(first).toStrictEqual(emptyPackage()); expect(again).toStrictEqual(first);
    expect(actual.rows[0]!.stats).toEqual(first.stats); expect(actual.writes).toHaveLength(1); expect(actual.deliveries).toHaveLength(1);
    expect(first).toStrictEqual(actual.deliveries[0]!.payload.decision.after.package);
  });

  check("正常四类事件保留三段、前后值、证据、版本与全部积分", "done/pending/blocked/unverified 各一条，积分 1.25/2.5/3.75/4", "三段 1/1/2、积分 11.5；首返与存储 JSON 完全相同", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); const events: BusinessEvent[] = [];
    for (const [index, kind] of (["done", "pending", "blocked", "unverified"] as const).entries()) events.push(await emit(scope, kind, [1.25, 2.5, 3.75, 4][index]!));
    const result = await deliverPackage(app, gateway, scope, id, wide);
    const actual = await state(scope, id); entry.actual = { result, database: actual };
    expect(result.stats).toEqual({ done: 1, pending: 1, need_human: 2, credits_used: 11.5 });
    expect(result).toStrictEqual(JSON.parse(JSON.stringify(projectNightPackage(events))));
    expect(result).toStrictEqual(actual.deliveries[0]!.payload.decision.after.package);
    expect(result.needHuman[1]!.summary).toContain("未核实"); expect(result.pending[0]!.fenceVersions).toEqual(["TEST-NIGHT@v1"]);
  });

  check("超过20条按严重度截断且积分覆盖被截断事件", "三类各12条，每条1积分", "保留12需介入+8待审批，截断16，积分36；重试一致", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope);
    for (const kind of ["done", "pending", "blocked"] as const) for (let i = 0; i < 12; i++) await emit(scope, kind);
    const result = await deliverPackage(app, gateway, scope, id, wide);
    expect(result.stats).toEqual({ done: 0, pending: 8, need_human: 12, credits_used: 36 }); expect(result.truncated).toBe(16);
    expect(await deliverPackage(app, gateway, scope, id, wide)).toStrictEqual(result); entry.actual = result;
  });

  check("同毫秒闭区间包含首次交付事件时重试不漂移", "Date 固定，仅模拟同毫秒；原窗口闭区间和真实 PG 写入逻辑均保留", "首次含一条业务事件，重试仍逐字段相同；单个交付事件", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(eventTime));
    const window = { from: eventTime, to: eventTime };
    const first = await deliverPackage(app, gateway, scope, id, window);
    const again = await deliverPackage(app, gateway, scope, id, window);
    entry.actual = { first, again, database: await state(scope, id) };
    expect(first.stats.done).toBe(1); expect(again).toStrictEqual(first);
    expect((await state(scope, id)).deliveries).toHaveLength(1);
  });

  check("追加事件和改变重试窗口均复用首次快照", "首次已交付；追加blocked事件，改宽/窄/未来/无效字符串窗口", "任何重试只返回第一次快照，不再次投影或写库", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope);
    const first = await deliverPackage(app, gateway, scope, id, wide); const before = await state(scope, id);
    await emit(scope, "blocked", 500);
    const returned = [];
    for (const window of [wide, { from: eventTime, to: eventTime }, { from: "2090-01-01", to: "2091-01-01" }, { from: "unused-invalid", to: "unused-invalid" }]) {
      const result = await deliverPackage(app, gateway, scope, id, window); returned.push(result); expect(result).toStrictEqual(first);
    }
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = { first, returned };
  });

  check("12路不同窗口并发首次交付只有一份快照和一次状态写", "同一running班次；owner暂持行锁；12个非super app请求同时争夺交付权", "12个成功返回值完全等于胜者存储快照；恰好一个状态更新和一个交付事件", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope); await emit(scope, "blocked", 7);
    const holder = await owner.connect(); await holder.query("BEGIN"); await holder.query("SELECT id FROM night_runs WHERE id=$1 FOR UPDATE", [id]);
    let readyCount = 0; let readyResolve!: () => void;
    const allReady = new Promise<void>((resolve) => { readyResolve = resolve; });
    const tracked = instrument(app, async (client, text, values) => {
      if (/FOR UPDATE|UPDATE night_runs/.test(text)) { if (++readyCount === 12) readyResolve(); }
      return client.query(text, values);
    });
    const jobs = Array.from({ length: 12 }, (_, i) => deliverPackage(tracked, gateway, scope, id,
      i % 2 ? { from: "2090-01-01T00:00:00Z", to: "2091-01-01T00:00:00Z" } : wide));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([allReady, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("12-way barrier timed out")), 4000); })]);
      await holder.query("COMMIT");
      const returned = await Promise.all(jobs); const actual = await state(scope, id);
      entry.actual = { readyCount, returned, database: actual };
      expect(actual.deliveries).toHaveLength(1); expect(actual.writes).toHaveLength(1);
      const stored = actual.deliveries[0]!.payload.decision.after.package;
      for (const result of returned) expect(result).toStrictEqual(stored);
    } finally {
      clearTimeout(timer); await holder.query("ROLLBACK"); holder.release(); await Promise.allSettled(jobs);
    }
  });

  check("同一工作区不同班次互不串包", "两个running班次，第二班交付前新增blocked事件", "各run的首份快照独立；两次重复各自稳定；每run一个事件", async (entry) => {
    const scope = await makeScope(); const a = await makeRun(scope); const b = await makeRun(scope); await emit(scope);
    const first = await deliverPackage(app, gateway, scope, a, wide); await emit(scope, "blocked", 9);
    const second = await deliverPackage(app, gateway, scope, b, wide);
    expect(second.stats.need_human).toBe(1); expect(second).not.toEqual(first);
    expect(await deliverPackage(app, gateway, scope, a, wide)).toStrictEqual(first);
    expect(await deliverPackage(app, gateway, scope, b, wide)).toStrictEqual(second);
    entry.actual = { first, second, a: await state(scope, a), b: await state(scope, b) };
  });

  for (const status of ["ready", "paused"] as const) check(`既有${status}状态交付兼容性保留`, `${status} 班次`, "沿用原公开API允许交付的状态集合，一次更新与事件，重试稳定", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, status); await emit(scope);
    const result = await deliverPackage(app, gateway, scope, id, wide); expect(await deliverPackage(app, gateway, scope, id, wide)).toStrictEqual(result);
    const actual = await state(scope, id); expect(actual.rows[0]!.status).toBe("package_generated"); expect(actual.deliveries).toHaveLength(1); entry.actual = actual;
  });

  check("缺失、跨工作区和跨租户班次安全拒绝", "已有首次快照；用不存在id、其他workspace与错tenant调用", "不返回他人包，不新写事件或状态", async (entry) => {
    const scope = await makeScope(); const other = await makeScope(foreignTenantId); const id = await makeRun(scope); await emit(scope);
    await deliverPackage(app, gateway, scope, id, wide); const before = await state(scope, id);
    await expect(deliverPackage(app, gateway, scope, `missing-${nonce}`, wide)).rejects.toThrow();
    await expect(deliverPackage(app, gateway, other, id, wide)).rejects.toThrow();
    await expect(deliverPackage(app, gateway, { ...scope, tenantId: foreignTenantId }, id, wide)).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("旧快照不复活已删除失效班次", "首次已交付；owner在合成夹具删除run，保留只增事件", "失效run明确拒绝，历史事件保持且不追加假交付", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await deliverPackage(app, gateway, scope, id, wide);
    const before = await state(scope, id); await owner.query("DELETE FROM night_runs WHERE id=$1", [id]);
    await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow();
    const actual = await state(scope, id); expect(actual.rows).toHaveLength(0); expect(actual.deliveries).toEqual(before.deliveries); entry.actual = actual;
  });

  check("首次未生成班次的错误租户上下文拒绝", "running班次存在于租户A；使用原workspace但租户B双GUC", "不生成空包，不改A班次，不创建任何交付事件", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope); const before = await state(scope, id);
    await expect(deliverPackage(app, gateway, { ...scope, tenantId: foreignTenantId }, id, wide)).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  for (const status of ["ready", "running", "paused"] as const) check(`已有快照与${status}状态矛盾时拒绝`, `有效交付事件存在但班次仍为${status}`, "不重投影，不二次交付或修写历史状态", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, status); const pkg = emptyPackage();
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(pkg.stats)]);
    await historical(scope, id, { runId: id, stats: pkg.stats, truncated: pkg.truncated, package: pkg });
    const before = await state(scope, id); await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("非法状态明确拒绝且不写假成功包", "仅独占夹具临时移除CHECK模拟损坏的expired状态", "不存在的状态安全拒绝，恢复原CHECK，状态/事件无副作用", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope);
    const constraints = (await owner.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='night_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%'")).rows;
    expect(constraints).toHaveLength(1); const c = constraints[0]!;
    await owner.query(`ALTER TABLE night_runs DROP CONSTRAINT "${String(c.conname).replaceAll('"', '""')}"`);
    try {
      await owner.query("UPDATE night_runs SET status='expired' WHERE id=$1", [id]); const before = await state(scope, id);
      await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
    } finally {
      await owner.query("UPDATE night_runs SET status='running' WHERE id=$1", [id]);
      await owner.query(`ALTER TABLE night_runs ADD CONSTRAINT "${String(c.conname).replaceAll('"', '""')}" ${c.definition}`);
    }
  });

  const brokenSnapshots: Array<[string, (runId: string) => unknown, string?]> = [
    ["缺少交付事件", () => null],
    ["旧事件缺少package", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0 })],
    ["package为null", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0, package: null })],
    ["缺少三段数组", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0, package: { ...emptyPackage(), needHuman: undefined } })],
    ["条目严重度与分组不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", summary: "synthetic", severity: 3, fenceVersions: [] }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["条目字段缺失", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", severity: 1, fenceVersions: [] }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["统计和条目数量不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), stats: { ...emptyPackage().stats, done: 1 } } })],
    ["负截断数量", (runId) => ({ runId, stats: emptyPackage().stats, truncated: -1, package: { ...emptyPackage(), truncated: -1 } })],
    ["非法积分", (runId) => ({ runId, stats: { ...emptyPackage().stats, credits_used: "wrong" }, truncated: 0,
      package: { ...emptyPackage(), stats: { ...emptyPackage().stats, credits_used: "wrong" } } })],
    ["外层stats与package不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, credits_used: 7 }, truncated: 0, package: emptyPackage() })],
    ["外层truncated与package不符", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 7, package: emptyPackage() })],
    ["伪装交付主体", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0, package: emptyPackage() }), "system"],
    ["三段数组为字符串", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0, package: { ...emptyPackage(), pending: "wrong" } })],
    ["条目为null", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [null], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["条目eventId类型不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: 1, summary: "synthetic", severity: 1, fenceVersions: [] }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["条目summary类型不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", summary: {}, severity: 1, fenceVersions: [] }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["fenceVersions非数组", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", summary: "synthetic", severity: 1, fenceVersions: "TEST@v1" }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["fenceVersions含非字符串", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", summary: "synthetic", severity: 1, fenceVersions: [1] }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["snapshotUri类型不符", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 1 }, truncated: 0,
      package: { ...emptyPackage(), done: [{ eventId: "E-1", summary: "synthetic", severity: 1, fenceVersions: [], snapshotUri: {} }], stats: { ...emptyPackage().stats, done: 1 } } })],
    ["非整数截断", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0.5, package: { ...emptyPackage(), truncated: 0.5 } })],
    ["package统计缺失", (runId) => ({ runId, stats: emptyPackage().stats, truncated: 0, package: { ...emptyPackage(), stats: undefined } })],
    ["积分为null", (runId) => ({ runId, stats: { ...emptyPackage().stats, credits_used: null }, truncated: 0,
      package: { ...emptyPackage(), stats: { ...emptyPackage().stats, credits_used: null } } })],
    ["超过20条历史包", (runId) => ({ runId, stats: { ...emptyPackage().stats, done: 21 }, truncated: 0,
      package: { ...emptyPackage(), done: Array.from({ length: 21 }, (_, i) => ({ eventId: `E-${i}`, summary: "synthetic", severity: 1, fenceVersions: [] })), stats: { ...emptyPackage().stats, done: 21 } } })],
  ];
  for (const [name, create, actor] of brokenSnapshots) check(`损坏历史快照：${name}`, "package_generated 的既有run；历史payload通过实际网关只增写入", "明确失败；不重投影，不修改存量状态或事件", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated"); const after = create(id);
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(emptyPackage().stats)]);
    if (after) await historical(scope, id, after, actor);
    const before = await state(scope, id);
    await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  for (const object of [{ type: "ticket", id: "unrelated" }, { type: "store", id: "foreign-workspace" }]) check(`交付事件错误对象：${object.type}/${object.id}`, "package_generated且完整历史快照，但事件object与本工作区不符", "拒绝冒充包，旧事件不改，零二次写入", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated"); const pkg = emptyPackage();
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(pkg.stats)]);
    await historical(scope, id, { runId: id, stats: pkg.stats, truncated: 0, package: pkg }, "night-shift", object);
    const before = await state(scope, id); await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("他租户同runId交付不能补齐本租户缺失快照", "A生成状态缺少事件；B事件after.runId等于A的runId", "A明确拒绝，不暴露或返回B快照；双方事件和状态保持", async (entry) => {
    const scope = await makeScope(); const other = await makeScope(foreignTenantId); const id = await makeRun(scope, "package_generated"); const pkg = emptyPackage();
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(pkg.stats)]);
    await historical(other, id, { runId: id, stats: pkg.stats, truncated: 0, package: pkg });
    const before = await state(scope, id); const foreign = await state(other, id);
    await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); expect(await state(other, id)).toStrictEqual(foreign); entry.actual = { before, foreign };
  });

  check("首份损坏快照不被第二份有效快照掩盖", "同run先旧缺包事件，再完整有效事件", "拒绝首份损坏证据，不选择后来的包冒充首次包", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated");
    await historical(scope, id, { runId: id, stats: emptyPackage().stats, truncated: 0 });
    await historical(scope, id, { runId: id, stats: emptyPackage().stats, truncated: 0, package: emptyPackage() });
    const before = await state(scope, id); await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("生成状态与存量stats不一致明确拒绝", "完整快照存在，但night_runs.stats与包不符", "失败不静默修写旧统计，不伪造成功", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated"); await historical(scope, id, { runId: id, stats: emptyPackage().stats, truncated: 0, package: emptyPackage() });
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify({ ...emptyPackage().stats, credits_used: 1 })]);
    const before = await state(scope, id); await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("首份已生成快照对旧班次完整兼容", "旧run与有效只增快照，原row.stats相同；无package_event_id", "不要求新增字段或迁移；返回原完整包且无写入", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated"); const pkg = emptyPackage();
    await owner.query("UPDATE night_runs SET run_date='2001-01-01',stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(pkg.stats)]);
    await historical(scope, id, { runId: id, stats: pkg.stats, truncated: pkg.truncated, package: pkg }); const before = await state(scope, id);
    expect(await deliverPackage(app, gateway, scope, id, { from: "unused", to: "unused" })).toStrictEqual(pkg);
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("合法负积分历史快照保持既有number契约", "有效旧快照credits_used=-2.5；原model_trace.credits仅要求number", "保留原值，返回首次快照且不加新限制或写入", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "package_generated"); const pkg = { ...emptyPackage(), stats: { ...emptyPackage().stats, credits_used: -2.5 } };
    await owner.query("UPDATE night_runs SET stats=$2::jsonb WHERE id=$1", [id, JSON.stringify(pkg.stats)]);
    await historical(scope, id, { runId: id, stats: pkg.stats, truncated: 0, package: pkg }); const before = await state(scope, id);
    expect(await deliverPackage(app, gateway, scope, id, wide)).toStrictEqual(pkg); expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });

  check("SQL参数特殊字符与无效首次窗口", "runId带引号/反斜杠/中文；首次窗口非法日期，之后正常重试", "非法窗口回滚；正常重试成功，参数没有SQL插入副作用", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope, "running", `night-${nonce}-'中文\\\";SELECT`); await emit(scope);
    const before = await state(scope, id); await expect(deliverPackage(app, gateway, scope, id, { from: "bad-date", to: "bad-date" })).rejects.toThrow();
    expect(await state(scope, id)).toStrictEqual(before); const pkg = await deliverPackage(app, gateway, scope, id, wide);
    expect(pkg.stats.done).toBe(1); entry.actual = { before, pkg, after: await state(scope, id) };
  });

  for (const privilege of ["SELECT", "UPDATE"] as const) check(`真实${privilege}权限拒绝后无状态或事件副作用`, `独占DB撤销app对night_runs的${privilege}，之后恢复`, "PG权限错误；事务回滚；恢复权限后重试单次成功", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope); const before = await state(scope, id);
    await owner.query(`REVOKE ${privilege} ON night_runs FROM workloom_app`);
    try { await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); }
    finally { await owner.query(`GRANT ${privilege} ON night_runs TO workloom_app`); }
    await deliverPackage(app, gateway, scope, id, wide); const actual = await state(scope, id); expect(actual.writes).toHaveLength(1); expect(actual.deliveries).toHaveLength(1); entry.actual = actual;
  });

  check("真实append权限拒绝将状态更新一起回滚", "独占DB撤销app的append_event_insert执行权限", "状态、探针、事件回滚；恢复权限后单次成功", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope); const before = await state(scope, id);
    const signature = "append_event_insert(TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TIMESTAMPTZ)";
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM workloom_app`);
    try { await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(/permission denied/); expect(await state(scope, id)).toStrictEqual(before); }
    finally { await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO workloom_app`); }
    await deliverPackage(app, gateway, scope, id, wide); const actual = await state(scope, id); expect(actual.writes).toHaveLength(1); expect(actual.deliveries).toHaveLength(1); entry.actual = actual;
  });

  for (const stage of ["state", "event", "commit"] as const) check(`真实事务${stage}故障全部回滚并可重试`, `${stage}阶段由PG触发器抛错；commit使用DEFERRABLE约束触发器`, "一次失败无状态/事件/探针残留；移除仅夹具故障后重试一次成功", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope); const before = await state(scope, id);
    const table = stage === "state" ? "night_runs" : "biz_events";
    const condition = stage === "state" ? "NEW.status='package_generated'" : "NEW.payload->'decision'->>'action'='night.package.deliver'";
    await owner.query(`CREATE FUNCTION night_package_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic night package ${stage} failure'; END IF; RETURN NEW; END $$`);
    await owner.query(stage === "commit"
      ? `CREATE CONSTRAINT TRIGGER night_package_fault AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION night_package_fault()`
      : `CREATE TRIGGER night_package_fault BEFORE ${stage === "state" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION night_package_fault()`);
    try { await expect(deliverPackage(app, gateway, scope, id, wide)).rejects.toThrow(`synthetic night package ${stage} failure`); expect(await state(scope, id)).toStrictEqual(before); }
    finally { await owner.query(`DROP TRIGGER night_package_fault ON ${table}`); await owner.query("DROP FUNCTION night_package_fault()"); }
    await deliverPackage(app, gateway, scope, id, wide); const actual = await state(scope, id); expect(actual.writes).toHaveLength(1); expect(actual.deliveries).toHaveLength(1); entry.actual = actual;
  });

  check("COMMIT已完成但回执丢失的重试复用同一快照", "真实COMMIT后连接包装器模拟确认丢失；不替换任何业务函数/SQL", "第一次向调用方报错，数据库已有唯一快照；重试返回该快照且无新写入", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await emit(scope);
    let lost = false;
    const interrupted = instrument(app, async (client, text, values) => {
      const result = await client.query(text, values);
      if (text === "COMMIT" && !lost) { lost = true; throw new Error("synthetic COMMIT acknowledgement lost"); }
      return result;
    });
    await expect(deliverPackage(interrupted, gateway, scope, id, wide)).rejects.toThrow("synthetic COMMIT acknowledgement lost");
    const before = await state(scope, id); expect(before.deliveries).toHaveLength(1);
    const result = await deliverPackage(app, gateway, scope, id, wide); expect(result).toStrictEqual(before.deliveries[0]!.payload.decision.after.package);
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = { result, database: before };
  });

  check("回滚确认失败同时保留主错误并丢弃连接", "真实UPDATE权限错误；ROLLBACK已执行后包装器模拟确认失败", "AggregateError保留原权限错误和回滚错误；连接销毁；无副作用，恢复后可重试", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); const before = await state(scope, id); const releases: Array<Error | boolean | undefined> = [];
    const interrupted = instrument(app, async (client, text, values) => {
      const result = await client.query(text, values);
      if (text === "ROLLBACK") throw new Error("synthetic rollback acknowledgement lost");
      return result;
    }, (error) => releases.push(error));
    await owner.query("REVOKE UPDATE ON night_runs FROM workloom_app");
    try {
      let caught: unknown;
      try { await deliverPackage(interrupted, gateway, scope, id, wide); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors.map((error: Error) => error.message).join("|")).toMatch(/permission denied.*synthetic rollback acknowledgement lost/);
      expect(releases).toEqual([true]); expect(await state(scope, id)).toStrictEqual(before);
    } finally { await owner.query("GRANT UPDATE ON night_runs TO workloom_app"); }
    await deliverPackage(app, gateway, scope, id, wide); entry.actual = { releases, after: await state(scope, id) };
  });

  check("连接失败不改变班次且可正常重试", "连接至本任务socket下不存在的目录", "真实ENOENT连接错误，无数据库副作用，正常app池重试成功", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); const before = await state(scope, id);
    const broken = new pg.Pool({ ...config, host: `${socket}/missing`, user: "workloom_app", max: 1, connectionTimeoutMillis: 1000 });
    try { await expect(deliverPackage(broken, gateway, scope, id, wide)).rejects.toThrow(); expect(await state(scope, id)).toStrictEqual(before); }
    finally { await broken.end(); }
    await deliverPackage(app, gateway, scope, id, wide); entry.actual = await state(scope, id);
  });

  check("状态、事件与读取快照只使用一个真实app事务", "包装器仅记录query与连接次数，所有查询仍发往PG", "一次connect、一次BEGIN/COMMIT，双GUC，走实际网关append，无第二事务", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); const queries: string[] = []; let connections = 0;
    const tracked = instrument(app, async (client, text, values) => { if (text === "BEGIN") connections++; queries.push(text); return client.query(text, values); });
    await deliverPackage(tracked, gateway, scope, id, wide);
    expect(connections).toBe(1); expect(queries.filter((text) => text === "COMMIT")).toHaveLength(1);
    expect(queries.some((text) => text.includes("app.workspace_id"))).toBe(true); expect(queries.some((text) => text.includes("app.tenant_id"))).toBe(true);
    expect(queries.some((text) => text.includes("append_event_insert"))).toBe(true); entry.actual = queries;
  });

  check("原事件只增与app禁止直接写入保持", "先实际交付，随后app直写和owner UPDATE/DELETE/TRUNCATE事件", "PG权限/append-only触发器全部拒绝；历史事件字节和哈希保持", async (entry) => {
    const scope = await makeScope(); const id = await makeRun(scope); await deliverPackage(app, gateway, scope, id, wide); const before = await state(scope, id);
    expect((await owner.query("SELECT has_table_privilege('workloom_app','biz_events','INSERT') AS permitted")).rows[0]!.permitted).toBe(false);
    await expect(app.query("INSERT INTO biz_events(event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-0',$1,$2,'{}','GENESIS','synthetic')", [scope.tenantId, scope.workspaceId])).rejects.toThrow(/permission denied/);
    await expect(owner.query("UPDATE biz_events SET payload=payload WHERE tenant_id=$1 AND workspace_id=$2", [scope.tenantId, scope.workspaceId])).rejects.toThrow(/append-only/);
    await expect(owner.query("DELETE FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2", [scope.tenantId, scope.workspaceId])).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE biz_events")).rejects.toThrow(/append-only/);
    expect(await state(scope, id)).toStrictEqual(before); entry.actual = before;
  });
});
