/** Actual loopback HTTP and private PostgreSQL; no mocked fetch, queries or commit. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { closeAllPools } from "@workloom/db";
import { competitorScan } from "./aipm.js";
import { serviceTx } from "./events.js";
import { runWithServiceScope, type ServiceScope } from "./scope.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1";
const tag = randomBytes(8).toString("hex");
const schema = "workloom.aipm/competitor-snapshot@1";
const a = { tenantId: `snapshot-test-a-${tag}`, workspaceId: `snapshot-test-wa-${tag}` };
const b = { tenantId: `snapshot-test-b-${tag}`, workspaceId: `snapshot-test-wb-${tag}` };
const a2 = { tenantId: a.tenantId, workspaceId: `snapshot-test-wa2-${tag}` };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (scope: ServiceScope, url: string) =>
  "mem-comp-v1-" + hash(JSON.stringify([schema, scope.tenantId, scope.workspaceId, url]));
type Page = { html?: string; text?: string; status?: number; reset?: boolean };
type Saved = { memory_id: string; tenant_id: string; workspace_id: string; kind: string; scope: string;
  status: string; content: string; source_events: string[]; [key: string]: unknown };

describe.runIf(RUN_DB)("competitor snapshots require a committed isolated baseline", () => {
  let owner: pg.Pool | undefined;
  let server: http.Server | undefined;
  let origin = "";
  const pages = new Map<string, Page>();
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let existingMemory: Saved[] = [];
  let existingEvents: Record<string, unknown>[] = [];
  let existingCredentials: Record<string, unknown>[] = [];

  const route = (path: string, page: Page = {}) => {
    const url = origin + "/snapshot/" + path;
    setPage(url, page);
    return url;
  };
  const setPage = (url: string, page: Page) => {
    const parsed = new URL(url);
    pages.set(parsed.pathname + parsed.search, page);
  };
  const invoke = (scope: ServiceScope, url: string, name = "Synthetic competitor") =>
    runWithServiceScope(scope, () => competitorScan(scope.workspaceId, [{ name, url }]));
  const rows = async (scope: ServiceScope, url: string) => (await owner!.query<Saved>(
    "SELECT * FROM org_memory WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3",
    [identity(scope, url), scope.tenantId, scope.workspaceId],
  )).rows;
  const saved = async (scope: ServiceScope, url: string, text: string) => {
    const result = await rows(scope, url);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
      kind: "pattern", scope: "workspace", status: "active" });
    expect(JSON.parse(result[0]!.content)).toEqual({ schema, tenantId: scope.tenantId,
      workspaceId: scope.workspaceId, url, hash: hash(text) });
    return result[0]!;
  };
  const success = (result: Awaited<ReturnType<typeof competitorScan>>, changed = false) => {
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ mock: false, changed });
    expect(result.reports[0]).not.toHaveProperty("error");
  };
  const failure = (result: Awaited<ReturnType<typeof competitorScan>>, stage: string) => {
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ mock: true, changed: false, error: stage });
    expect(result.reports[0]!.snippet).not.toContain("Synthetic upstream secret marker");
  };
  const inject = async (scope: ServiceScope, url: string, attributes: Partial<Saved> = {}) => {
    const row = { memory_id: identity(scope, url), tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
      kind: "pattern", scope: "workspace", status: "active", source_events: ["E-SEED-snapshot-test-kept"],
      content: JSON.stringify({ schema, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        url, hash: hash("Synthetic old page") }), ...attributes };
    await owner!.query(`INSERT INTO org_memory(memory_id,tenant_id,workspace_id,scope,kind,status,content,source_events,confidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0.72)`, [row.memory_id, row.tenant_id, row.workspace_id,
      row.scope, row.kind, row.status, row.content, row.source_events]);
  };
  const unchangedFailure = async (url: string, stage: string) => {
    const before = await rows(a, url);
    failure(await invoke(a, url), stage);
    expect(await rows(a, url)).toEqual(before);
  };

  beforeAll(async () => {
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const value = process.env[key];
      if (!value) throw new Error("Snapshot PG contract requires explicit private fixture URLs");
      const url = new URL(value);
      if (url.hostname !== "localhost" || !url.pathname.startsWith("/aipm_proof_")
          || !url.searchParams.get("host")?.startsWith("/tmp/wl-aipm-proof-")) {
        throw new Error("Snapshot PG contract refuses any database outside its private Unix fixture");
      }
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    expect((await owner.query("SHOW listen_addresses")).rows[0]).toEqual({ listen_addresses: "" });
    const roles = (await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway')")).rows;
    expect(roles).toHaveLength(2);
    expect(roles.every(row => !row.rolsuper && !row.rolbypassrls)).toBe(true);
    existingMemory = (await owner.query<Saved>("SELECT * FROM org_memory ORDER BY memory_id")).rows;
    existingEvents = (await owner.query("SELECT * FROM biz_events ORDER BY seq")).rows;
    existingCredentials = (await owner.query("SELECT * FROM credentials ORDER BY id")).rows;
    for (const scope of [a, b]) await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic snapshot test tenant')", [scope.tenantId]);
    for (const scope of [a, b, a2]) await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'Synthetic snapshot test workspace',$1,'ai-pm')",
      [scope.workspaceId, scope.tenantId]);
    server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      const page = pages.get(request.url ?? "");
      if (request.method !== "GET" || !page) { response.writeHead(404); response.end(); return; }
      if (page.reset) { request.socket.destroy(); return; }
      response.writeHead(page.status ?? 200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page.html ?? `<body>${page.text ?? "Synthetic page"}<script>excluded</script><style>excluded</style></body>`);
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it("commits a legal first baseline, replays it and compares a changed page after reconnect", async () => {
    const url = route("durable", { text: "Synthetic first page" });
    success(await invoke(a, url)); await saved(a, url, "Synthetic first page");
    success(await invoke(a, url));
    await closeAllPools();
    setPage(url, { text: "Synthetic changed page" });
    success(await invoke(a, url), true); await saved(a, url, "Synthetic changed page");
  });

  it.each([b, a2])("keeps the same URL independent in scope %j", async scope => {
    const url = route("independent", { text: "Synthetic independent baseline" });
    success(await invoke(a, url)); const before = await rows(a, url);
    success(await invoke(scope, url)); await saved(scope, url, "Synthetic independent baseline");
    expect(await rows(a, url)).toEqual(before);
  });

  it("hashes changes beyond character 4000 while retaining the 300 character response bound", async () => {
    const url = route("long", { text: "X".repeat(4500) + " old" });
    success(await invoke(a, url)); setPage(url, { text: "X".repeat(4500) + " new" });
    const result = await invoke(a, url); success(result, true);
    expect(result.reports[0]!.snippet).toBe("X".repeat(300));
    await saved(a, url, "X".repeat(4500) + " new");
  });

  it("normalizes visible whitespace and mixed case script/style tags without using display names", async () => {
    const url = route("normalization", { html: "<body> 酒店  🧵 <SCRIPT>hidden</SCRIPT><Style>css</Style></body>" });
    success(await invoke(a, url, ""));
    setPage(url, { html: "<body>\n酒店\t🧵<script>changed script</script><STYLE>changed css</STYLE></body>" });
    const result = await invoke(a, url, "Renamed competitor"); success(result);
    expect(result.reports[0]!.name).toBe("Renamed competitor"); await saved(a, url, "酒店 🧵");
  });

  it("distinguishes exact URL strings containing wildcards, Unicode and substring variants", async () => {
    const urls = [origin + "/snapshot/exact?x=%25&y=_", origin + "/snapshot/exact?x=aaa&y=Z",
      origin + "/snapshot/exact-long", origin + "/snapshot/竞品#片段"];
    for (const url of urls) { setPage(url, { text: "Synthetic exact URL" }); success(await invoke(a, url)); await saved(a, url, "Synthetic exact URL"); }
    expect(new Set(urls.map(url => identity(a, url))).size).toBe(4);
  });

  it.each(["not-a-url", "file:///synthetic-page", "", "http://synthetic-user@127.0.0.1/"])(
    "rejects invalid or credential-bearing URL before HTTP: %s", async url => {
      const count = requests.length; failure(await invoke(a, url), "fetch");
      expect(requests).toHaveLength(count); expect(await rows(a, url)).toEqual([]);
    });

  it.each([
    { scope: { tenantId: b.tenantId, workspaceId: a.workspaceId }, workspace: a.workspaceId },
    { scope: a, workspace: b.workspaceId },
    { scope: { tenantId: a.tenantId, workspaceId: `snapshot-ownerless-${tag}` }, workspace: `snapshot-ownerless-${tag}` },
  ])("rejects mismatched or unregistered scope before HTTP: %j", async item => {
    const url = route("denied-" + item.workspace); const count = requests.length;
    const result = await runWithServiceScope(item.scope,
      () => competitorScan(item.workspace, [{ name: "Synthetic scope denial", url }]));
    failure(result, "scope"); expect(requests).toHaveLength(count);
  });

  it("rejects an unscoped call before HTTP", async () => {
    const url = route("unscoped"); const count = requests.length;
    failure(await competitorScan(a.workspaceId, [{ name: "Synthetic no scope", url }]), "scope");
    expect(requests).toHaveLength(count);
  });

  it.each<Page>([{ status: 404 }, { status: 502 }, { status: 204 }, { html: " \t\n" },
    { html: "<SCRIPT>hidden</SCRIPT><STYLE>css</STYLE>" }, { reset: true }])(
    "preserves the full baseline for failed or empty HTTP: %j", async page => {
      const url = route("failed-" + requests.length, { text: "Synthetic old page" }); await inject(a, url);
      setPage(url, { text: "Synthetic upstream secret marker", ...page }); await unchangedFailure(url, "fetch");
    });

  it.each(["SELECT", "INSERT", "UPDATE"])("reports a real %s privilege failure and retries after restoration", async privilege => {
    const url = route("revoke-" + privilege, { text: "Synthetic new page" }); await inject(a, url);
    await owner!.query(`REVOKE ${privilege} ON org_memory FROM workloom_app`);
    try { await unchangedFailure(url, "snapshot"); }
    finally { await owner!.query(`GRANT ${privilege} ON org_memory TO workloom_app`); }
    success(await invoke(a, url), true); await saved(a, url, "Synthetic new page");
  });

  it.each([false, true])("rolls back actual %s deferred write failure before returning success", async deferred => {
    const url = route("trigger-" + deferred, { text: "Synthetic new page" }); await inject(a, url);
    const trigger = `snapshot_test_failure_${tag}`;
    await owner!.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic snapshot test write failure'; END $$`);
    try {
      await owner!.query(deferred
        ? `CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT OR UPDATE ON org_memory DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`
        : `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON org_memory FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      try { await unchangedFailure(url, "snapshot"); }
      finally { await owner!.query(`DROP TRIGGER ${trigger} ON org_memory`); }
    } finally { await owner!.query(`DROP FUNCTION ${trigger}()`); }
    success(await invoke(a, url), true); await saved(a, url, "Synthetic new page");
  });

  it.each<Partial<Saved>>([{ content: "{invalid-json" }, { kind: "sop" }, { status: "recalled" },
    { content: JSON.stringify({ schema, tenantId: a.tenantId, workspaceId: a.workspaceId, url: "wrong-url", hash: hash("old") }) }])(
    "fails closed without overwriting an incompatible baseline: %j", async attributes => {
      const url = route("incompatible-" + requests.length, { text: "Synthetic new page" });
      await inject(a, url, attributes); await unchangedFailure(url, "snapshot");
    });

  it("keeps a foreign tenant row at a colliding ID unchanged", async () => {
    const url = route("foreign-collision", { text: "Synthetic own page" });
    await inject(b, url, { memory_id: identity(a, url) });
    const before = (await owner!.query<Saved>("SELECT * FROM org_memory WHERE memory_id=$1", [identity(a, url)])).rows;
    failure(await invoke(a, url), "snapshot");
    expect((await owner!.query("SELECT * FROM org_memory WHERE memory_id=$1", [identity(a, url)])).rows).toEqual(before);
  });

  it("changes only content and preserves historical metadata", async () => {
    const url = route("metadata", { text: "Synthetic new page" }); await inject(a, url);
    const before = (await rows(a, url))[0]!; success(await invoke(a, url), true);
    const after = await saved(a, url, "Synthetic new page");
    expect({ ...after, content: before.content }).toEqual(before);
  });

  it("serializes concurrent first, unchanged and changed pages into one committed transition", async () => {
    const url = route("concurrent", { text: "Synthetic parallel first" });
    const many = () => Promise.all(Array.from({ length: 12 }, () => invoke(a, url)));
    for (const result of await many()) success(result);
    for (const result of await many()) success(result);
    setPage(url, { text: "Synthetic parallel change" }); const results = await many();
    expect(results.every(result => result.reports[0]?.mock === false)).toBe(true);
    expect(results.filter(result => result.reports[0]?.changed)).toHaveLength(1);
    await saved(a, url, "Synthetic parallel change");
  });

  it("retains target order, the six target cap, and independent success in a mixed batch", async () => {
    const urls = Array.from({ length: 7 }, (_, i) => route("cap-" + i, i === 0 ? { status: 502 } : { text: "Synthetic cap " + i }));
    const count = requests.length;
    const result = await runWithServiceScope(a, () => competitorScan(a.workspaceId,
      urls.map((url, i) => ({ name: String(i), url }))));
    expect(result.reports).toHaveLength(6); expect(requests.length - count).toBe(6);
    expect(result.reports.map(row => row.url)).toEqual(urls.slice(0, 6));
    expect(result.reports[0]).toMatchObject({ mock: true, error: "fetch", changed: false });
    expect(result.reports.slice(1).every(row => !row.mock && !row.changed)).toBe(true);
    expect(await rows(a, urls[6]!)).toEqual([]);
  });

  it("retains RLS and legal-kind constraints and prevents direct event writes", async () => {
    await runWithServiceScope(a, async () => {
      expect(await serviceTx(a.workspaceId, async client => (await client.query(
        "SELECT memory_id FROM org_memory WHERE tenant_id=$1 OR workspace_id=$2", [b.tenantId, a2.workspaceId],
      )).rows)).toEqual([]);
      await expect(serviceTx(a.workspaceId, client => client.query(
        "INSERT INTO org_memory(memory_id,tenant_id,workspace_id,scope,kind,content) VALUES($1,$2,$3,'workspace','competitor-snapshot','Synthetic illegal kind')",
        [`snapshot-illegal-${tag}`, a.tenantId, a.workspaceId],
      ))).rejects.toMatchObject({ code: "23514" });
      await expect(serviceTx(a.workspaceId, client => client.query(
        "INSERT INTO biz_events(event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES($1,$2,$3,'{}','GENESIS','denied')",
        [`E-SEED-snapshot-denied-${tag}`, a.tenantId, a.workspaceId],
      ))).rejects.toMatchObject({ code: "42501" });
    });
    expect((await owner!.query("SELECT * FROM org_memory WHERE memory_id=ANY($1::text[]) ORDER BY memory_id",
      [existingMemory.map(row => row.memory_id)])).rows).toEqual(existingMemory);
    expect((await owner!.query("SELECT * FROM biz_events ORDER BY seq")).rows).toEqual(existingEvents);
    expect((await owner!.query("SELECT * FROM credentials ORDER BY id")).rows).toEqual(existingCredentials);
    expect((await owner!.query("SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND a.datname=current_database() AND a.usename='workloom_app'")).rows).toEqual([{ count: 0 }]);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      try { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
      catch (error) { failures.push(error); }
    }
    try { await closeAllPools(); } catch (error) { failures.push(error); }
    if (owner) {
      try {
        await owner.query("DELETE FROM org_memory WHERE tenant_id=ANY($1::text[])", [[a.tenantId, b.tenantId]]);
        await owner.query("DELETE FROM workspaces WHERE id=ANY($1::text[])", [[a.workspaceId, b.workspaceId, a2.workspaceId]]);
        await owner.query("DELETE FROM tenants WHERE id=ANY($1::text[])", [[a.tenantId, b.tenantId]]);
      } catch (error) { failures.push(error); }
      try { await owner.end(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Synthetic snapshot fixture cleanup failed");
  });
});
