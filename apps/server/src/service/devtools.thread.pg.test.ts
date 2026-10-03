/** MC031: real Unix PostgreSQL and Git; only explicit synthetic coding emitters are used. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingToolAdapter, DevEvent, DevTaskSpec, RunningSession, SessionHooks, SessionResult } from "@workloom/base/dev-bridge";
import { requireServiceScope, runWithServiceScope } from "./scope.js";

const boundary = vi.hoisted(() => ({
  native: false,
  entries: new Map<string, { hooks: SessionHooks; task: DevTaskSpec; finish?: (result: SessionResult) => void;
    cancelCount: number; session: RunningSession }>(),
}));
vi.mock("@workloom/base/dev-bridge", async (original) => {
  const actual = await original<typeof import("@workloom/base/dev-bridge")>();
  return { ...actual, startSession: (adapter: CodingToolAdapter, bin: string, task: DevTaskSpec, hooks: SessionHooks) => {
    let finish: ((result: SessionResult) => void) | undefined;
    const session = boundary.native ? actual.startSession(adapter, bin, task, hooks) : {
      sessionId: "mc031-synthetic-emitter", taskId: task.taskId, toolKey: adapter.toolKey,
      proc: undefined as unknown as RunningSession["proc"], startedAt: new Date(),
      result: new Promise<SessionResult>((resolve) => { finish = resolve; }),
      cancel: () => { boundary.entries.get(task.taskId)!.cancelCount += 1; },
    };
    const cancel = session.cancel;
    const entry = { hooks, task, finish, cancelCount: 0, session };
    if (boundary.native) session.cancel = () => { entry.cancelCount += 1; cancel(); };
    boundary.entries.set(task.taskId, entry);
    return session;
  } };
});
import { closeAllPools } from "@workloom/db";
import { worktreeDiscard } from "@workloom/base/dev-bridge";
import { serviceTx, svcQuery } from "./events.js";
import { confirmTask, createTask, dispatchTask, registerRepo, setDevToolAdapters, taskDetail } from "./devtools.js";

const nonce = randomUUID().replaceAll("-", "");
const a = { tenantId: `mc031-tenant-a-${nonce}`, workspaceId: `mc031-ws-a-${nonce}` };
const b = { tenantId: `mc031-tenant-b-${nonce}`, workspaceId: `mc031-ws-b-${nonce}` };
const actor = { id: "mc031-synthetic-operator", type: "human" as const };
const adapter: CodingToolAdapter = {
  toolKey: "mc031-synthetic", displayName: "MC031 synthetic local emitter", binName: () => "node",
  capabilities: () => ({ headless: true, streamEvents: "jsonl", sessionResume: true, sandboxFlag: false }),
  detect: async () => null,
  buildArgs: (task) => ["-e", `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(task.worktreePath, ".mc031-emitter-online"))}, 'synthetic online'); const ready = ${JSON.stringify(join(task.worktreePath, ".mc031-emitter-ready"))}; const wait = setInterval(() => { if (!fs.existsSync(ready)) return; clearInterval(wait); process.stdout.write(JSON.stringify({type:'started',pid:process.pid,threadId:'mc031-native-${nonce}'})+'\\n', () => { ${task.prompt.includes("native-fast-close") ? "process.exit(0);" : "setInterval(() => {}, 1000);"} }); }, 20);`],
  parseLine: (line) => JSON.parse(line) as DevEvent,
};

describe.runIf(process.env.RUN_DB_TESTS === "1")("MC031 started identity and truthful failure on real PostgreSQL", () => {
  let owner: pg.Pool;
  let fixtureRepo: string;
  let repoId: string;
  let extractedSQL: string;
  const created: Array<{ taskId: string; sessionId: string }> = [];
  const inA = <T>(fn: () => T) => runWithServiceScope(a, fn);
  const entry = (id: string) => boundary.entries.get(id)!;
  const sessionRow = async (id: string) => (await owner.query("SELECT thread_id,exit_reason,last_message,ended_at IS NOT NULL AS ended FROM dev_sessions WHERE id=$1", [id])).rows[0];
  const emit = (id: string, threadId?: string) => entry(id).hooks.onEvent!({ type: "started", pid: 1, ...(threadId === undefined ? {} : { threadId }) });
  async function releaseNative(taskId: string) {
    const e = entry(taskId);
    const online = join(e.task.worktreePath, ".mc031-emitter-online");
    const started = Date.now();
    const deadline = started + 20_000;
    while (!existsSync(online) && Date.now() < deadline) {
      if (e.session.proc.exitCode !== null || e.session.proc.signalCode !== null) {
        const result = await e.session.result;
        throw new Error(`Synthetic child exited before its startup receipt: ${result.exitReason}; ${result.lastMessage}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(online)) throw new Error(`Synthetic child did not acknowledge startup within 20000ms: ${taskId}`);
    console.info(`MC031 synthetic child startup receipt in ${Date.now() - started}ms`);
    writeFileSync(join(e.task.worktreePath, ".mc031-emitter-ready"), "synthetic ready\n");
  }
  async function spawn(label: string, repairRound = 2) {
    return inA(async () => {
      const { task } = await createTask(a.workspaceId, { repoId, title: `MC031 ${label}`, prdSummary: label,
        acceptance: ["Persist the actual external identity or explicitly fail"], assignedTool: adapter.toolKey }, actor);
      await confirmTask(a.workspaceId, task.id, actor);
      await owner.query("UPDATE dev_tasks SET repair_round=$2 WHERE id=$1", [task.id, repairRound]);
      const result = { taskId: task.id, sessionId: (await dispatchTask(a.workspaceId, task.id, actor)).sessionId };
      created.push(result); return result;
    });
  }
  async function settled(taskId: string) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const detail = await inA(() => taskDetail(a.workspaceId, taskId));
      if (!detail.live && detail.task?.status !== "running" && detail.sessions[0]?.ended_at != null) return detail;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`Synthetic terminal did not settle: ${taskId}`);
  }
  async function finish(taskId: string, threadId?: string, exitReason: SessionResult["exitReason"] = "canceled") {
    entry(taskId).finish!({ exitCode: 0, exitReason, lastMessage: "MC031 synthetic terminal", ...(threadId === undefined ? {} : { threadId }) });
    return settled(taskId);
  }
  async function errorRows(sessionId: string) {
    return (await owner.query("SELECT type,payload FROM dev_events WHERE session_id=$1 ORDER BY seq", [sessionId])).rows;
  }
  async function trigger(sessionId: string, code: string, delay = 0) {
    await owner.query(`CREATE OR REPLACE FUNCTION mc031_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${sessionId.replaceAll("'", "''")}' AND NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN PERFORM pg_sleep(${delay}); RAISE EXCEPTION 'MC031 synthetic thread persistence fault' USING ERRCODE = '${code}'; END IF; RETURN NEW; END $$`);
    await owner.query("CREATE TRIGGER mc031_fault BEFORE UPDATE ON dev_sessions FOR EACH ROW EXECUTE FUNCTION mc031_fault()");
  }
  async function dropTrigger() { await owner.query("DROP TRIGGER IF EXISTS mc031_fault ON dev_sessions"); }

  beforeAll(async () => {
    if (process.env.DEVTOOLS_THREAD_TASK_OWNED !== "1" || !process.env.DATABASE_URL?.includes("host=%2Ftmp%2Fwl-raw-scope-") && !process.env.DATABASE_URL?.includes("host=/tmp/wl-raw-scope-")) {
      throw new Error("MC031 requires its fresh private Unix PG sentinel");
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const roles = (await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows;
    expect(roles).toEqual([{ rolname: "workloom_app", rolsuper: false, rolbypassrls: false }, { rolname: "workloom_gateway", rolsuper: false, rolbypassrls: false }]);
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic MC031 A'),($2,'Synthetic MC031 B')", [a.tenantId, b.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'MC031 A',$1,'synthetic'),($3,$4,'MC031 B',$3,'synthetic')", [a.workspaceId, a.tenantId, b.workspaceId, b.tenantId]);
    await owner.query("INSERT INTO dev_tool_installs(id,workspace_id,tool_key,bin_path,version,capabilities) VALUES($1,$2,$3,$4,'synthetic','{}')", [`mc031-tool-${nonce}`, a.workspaceId, adapter.toolKey, process.execPath]);
    setDevToolAdapters([adapter]);
    fixtureRepo = mkdtempSync(join(tmpdir(), "mc031-synthetic-git-"));
    for (const args of [["init", "-b", "main"], ["config", "user.email", "synthetic@example.invalid"], ["config", "user.name", "MC031 synthetic fixture"]]) execFileSync("git", args, { cwd: fixtureRepo, stdio: "pipe" });
    writeFileSync(join(fixtureRepo, "README.md"), "# MC031 synthetic fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: fixtureRepo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "synthetic MC031 fixture"], { cwd: fixtureRepo, stdio: "pipe" });
    repoId = (await inA(() => registerRepo(a.workspaceId, { name: "MC031 synthetic repo", path: fixtureRepo }, actor))).repo.id;
    const source = readFileSync(new URL("./devtools.ts", import.meta.url), "utf8");
    extractedSQL = source.match(/`(UPDATE dev_sessions SET thread_id=[^`]+)`/)?.[1] ?? "";
    expect(extractedSQL).toMatch(/UPDATE dev_sessions/);
  }, 60_000);

  it("normal: exposes committed external identity while session is still live", async () => {
    const s = await spawn("live identity");
    await emit(s.taskId, `mc031-live-${nonce}`);
    expect((await sessionRow(s.sessionId)).thread_id).toBe(`mc031-live-${nonce}`);
    expect((await inA(() => taskDetail(a.workspaceId, s.taskId))).live).toBe(true);
    expect((await errorRows(s.sessionId)).map((row) => row.type)).toEqual(["started"]);
    await finish(s.taskId);
  });
  it("boundary: absent thread ID leaves null unchanged and still records started", async () => {
    const s = await spawn("absent identity"); await emit(s.taskId);
    expect((await sessionRow(s.sessionId)).thread_id).toBeNull();
    expect((await errorRows(s.sessionId)).map((row) => row.type)).toEqual(["started"]); await finish(s.taskId);
  });
  it("boundary: absent thread ID preserves the known external identity", async () => {
    const s = await spawn("preserve known identity");
    await owner.query("UPDATE dev_sessions SET thread_id='mc031-known' WHERE id=$1", [s.sessionId]);
    await emit(s.taskId); expect((await sessionRow(s.sessionId)).thread_id).toBe("mc031-known"); await finish(s.taskId);
  });
  it("boundary: an explicitly supplied empty text ID retains the existing value contract", async () => {
    const s = await spawn("empty text identity"); await emit(s.taskId, "");
    expect((await sessionRow(s.sessionId)).thread_id).toBe(""); await finish(s.taskId);
  });
  it("boundary: parameterized Unicode quotes whitespace and a long external ID round trip exactly", async () => {
    const s = await spawn("special identity"); const id = `外部线程 🧵 ' \" ; $3 \\ \n\t${"長".repeat(4096)}`;
    await emit(s.taskId, id); expect((await sessionRow(s.sessionId)).thread_id).toBe(id); await finish(s.taskId);
  });
  it("boundary: twenty repeated started writes retain one external identity", async () => {
    const s = await spawn("repeat identity");
    for (let i = 0; i < 20; i += 1) await emit(s.taskId, "mc031-repeated");
    expect((await sessionRow(s.sessionId)).thread_id).toBe("mc031-repeated");
    expect((await errorRows(s.sessionId)).filter((row) => row.type === "started")).toHaveLength(20); await finish(s.taskId);
  });
  it("boundary: twenty concurrent callbacks persist and restore the unrelated outer scope", async () => {
    const s = await spawn("concurrent identity");
    await runWithServiceScope(b, async () => {
      await Promise.all(Array.from({ length: 20 }, () => emit(s.taskId, "mc031-concurrent")));
      expect(requireServiceScope(b.workspaceId)).toEqual(b);
    });
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/);
    expect((await sessionRow(s.sessionId)).thread_id).toBe("mc031-concurrent");
    expect((await errorRows(s.sessionId)).filter((row) => row.type === "started")).toHaveLength(20); await finish(s.taskId);
  });
  it("permission: dispatch rejects missing authenticated scope before side effects", async () => {
    const count = (await owner.query("SELECT count(*)::int AS n FROM dev_sessions WHERE workspace_id=$1", [a.workspaceId])).rows[0].n;
    await expect(dispatchTask(a.workspaceId, "mc031-unknown", actor)).rejects.toThrow(/scope/);
    expect((await owner.query("SELECT count(*)::int AS n FROM dev_sessions WHERE workspace_id=$1", [a.workspaceId])).rows[0].n).toBe(count);
  });
  it("permission: foreign workspace and foreign tenant cannot dispatch a real confirmed task", async () => {
    const { task } = await inA(() => createTask(a.workspaceId, { repoId, title: "MC031 forbidden dispatch", prdSummary: "forbidden", acceptance: ["deny"], assignedTool: adapter.toolKey }, actor));
    await inA(() => confirmTask(a.workspaceId, task.id, actor));
    await expect(runWithServiceScope(b, () => dispatchTask(b.workspaceId, task.id, actor))).rejects.toThrow(/不存在/);
    await expect(runWithServiceScope({ tenantId: b.tenantId, workspaceId: a.workspaceId }, () => dispatchTask(a.workspaceId, task.id, actor))).rejects.toThrow(/不存在/);
    expect((await owner.query("SELECT count(*)::int AS n FROM dev_sessions WHERE task_id=$1", [task.id])).rows[0].n).toBe(0);
  });
  it("permission: exact extracted product SQL cannot change a foreign tenant or workspace row", async () => {
    const s = await spawn("SQL isolation");
    for (const scope of [b, { tenantId: b.tenantId, workspaceId: a.workspaceId }]) {
      await runWithServiceScope(scope, () => svcQuery(scope.workspaceId, extractedSQL, [a.workspaceId, s.sessionId, "mc031-forbidden"]));
      expect((await sessionRow(s.sessionId)).thread_id).toBeNull();
    }
    await finish(s.taskId);
  });
  it("regression: exact product SQL executes with non-null and null typed parameters on the actual application role", async () => {
    const s = await spawn("SQL types");
    await inA(() => serviceTx(a.workspaceId, (client) => client.query(extractedSQL, [a.workspaceId, s.sessionId, "mc031-direct"])));
    await inA(() => serviceTx(a.workspaceId, (client) => client.query(extractedSQL, [a.workspaceId, s.sessionId, null])));
    expect((await sessionRow(s.sessionId)).thread_id).toBe("mc031-direct"); await finish(s.taskId);
  });
  it("regression: canceled terminal without a result identity preserves the earlier started identity", async () => {
    const s = await spawn("terminal preserve"); await emit(s.taskId, "mc031-started-terminal"); await finish(s.taskId);
    expect(await sessionRow(s.sessionId)).toMatchObject({ thread_id: "mc031-started-terminal", exit_reason: "canceled", ended: true });
  });
  it("regression: a distinct external result identity retains the existing terminal override contract", async () => {
    const s = await spawn("terminal override"); await emit(s.taskId, "mc031-started-first"); await finish(s.taskId, "mc031-result-second");
    expect((await sessionRow(s.sessionId)).thread_id).toBe("mc031-result-second");
  });
  it("regression: later repair dispatch receives the committed external resume identity", async () => {
    const s = await spawn("resume identity", 2); await emit(s.taskId, "mc031-resume-known"); await finish(s.taskId);
    // Terminal manual-review worktrees are retained by contract; remove this test-owned one before redispatch.
    const previous = (await owner.query("SELECT worktree_path,branch FROM dev_sessions WHERE id=$1", [s.sessionId])).rows[0];
    await worktreeDiscard(fixtureRepo, previous.worktree_path, previous.branch);
    await owner.query("UPDATE dev_tasks SET status='confirmed' WHERE id=$1", [s.taskId]);
    const next = await inA(() => dispatchTask(a.workspaceId, s.taskId, actor));
    created.push({ taskId: s.taskId, sessionId: next.sessionId });
    expect(entry(s.taskId).task.resumeId).toBe("mc031-resume-known"); await finish(s.taskId);
  });
  it("error: real 42501 rejects started persistence, records the original SQLSTATE, cancels and prevents terminal success", async () => {
    const s = await spawn("permission failure"); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await owner.query("REVOKE UPDATE ON dev_sessions FROM workloom_app");
      await expect(Promise.resolve(emit(s.taskId, "mc031-denied"))).resolves.toBeUndefined();
      expect(entry(s.taskId).cancelCount).toBe(1);
      const rows = await errorRows(s.sessionId); expect(rows.map((row) => row.type)).toEqual(["error"]);
      expect(JSON.stringify(rows[0].payload)).toContain("42501"); expect(JSON.stringify(log.mock.calls)).toContain("42501");
    } finally { await owner.query("GRANT UPDATE ON dev_sessions TO workloom_app"); log.mockRestore(); }
    const detail = await finish(s.taskId, "mc031-failed-result", "done");
    expect(detail.task?.status).toBe("failed"); expect(detail.changesets).toHaveLength(0);
    expect(await sessionRow(s.sessionId)).toMatchObject({ thread_id: null, exit_reason: "error", ended: true });
  });
  it("error: real 23514 trigger failure survives null terminal identity without an automatic retry", async () => {
    const s = await spawn("constraint failure", 0); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await trigger(s.sessionId, "23514"); await emit(s.taskId, "mc031-trigger-denied");
      expect(entry(s.taskId).cancelCount).toBe(1);
      expect((await errorRows(s.sessionId)).map((row) => row.type)).toEqual(["error"]);
      expect(JSON.stringify(log.mock.calls)).toContain("23514");
    } finally { await dropTrigger(); log.mockRestore(); }
    const detail = await finish(s.taskId, undefined, "done"); expect(detail.task?.status).toBe("failed");
    expect(detail.task?.repair_round).toBe(0); expect(detail.sessions).toHaveLength(1); expect(detail.changesets).toHaveLength(0);
  });
  it("error: started event INSERT failure rolls back the identity and cannot announce a successful start", async () => {
    const s = await spawn("atomic started event failure"); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await owner.query("REVOKE INSERT ON dev_events FROM workloom_app");
      await expect(Promise.resolve(emit(s.taskId, "mc031-event-denied"))).resolves.toBeUndefined();
      expect(entry(s.taskId).cancelCount).toBe(1); expect((await sessionRow(s.sessionId)).thread_id).toBeNull();
      expect(await errorRows(s.sessionId)).toEqual([]); expect(JSON.stringify(log.mock.calls)).toContain("42501");
    } finally { await owner.query("GRANT INSERT ON dev_events TO workloom_app"); log.mockRestore(); }
    const detail = await finish(s.taskId, undefined, "done"); expect(detail.task?.status).toBe("failed"); expect(detail.changesets).toHaveLength(0);
    expect(await sessionRow(s.sessionId)).toMatchObject({ thread_id: null, exit_reason: "error", ended: true });
  });
  it("error: failed error-event and failed task-report writes remain observable without callback rejection", async () => {
    const s = await spawn("fallback report failure"); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await owner.query("REVOKE UPDATE ON dev_sessions, dev_tasks FROM workloom_app"); await owner.query("REVOKE INSERT ON dev_events FROM workloom_app");
      await expect(Promise.resolve(emit(s.taskId, "mc031-report-denied"))).resolves.toBeUndefined();
      expect(entry(s.taskId).cancelCount).toBe(1); expect((await errorRows(s.sessionId))).toEqual([]);
      expect(log.mock.calls.length).toBeGreaterThanOrEqual(3); expect(JSON.stringify(log.mock.calls)).toContain("42501");
    } finally {
      await owner.query("GRANT UPDATE ON dev_sessions, dev_tasks TO workloom_app"); await owner.query("GRANT INSERT ON dev_events TO workloom_app"); log.mockRestore();
    }
    expect((await finish(s.taskId, undefined, "done")).task?.status).toBe("failed");
  });
  it("error: native stdout failure has no unhandled rejection, cancels the real process and clears live resources", async () => {
    boundary.native = true; const log = vi.spyOn(console, "error").mockImplementation(() => undefined); const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", listener);
    const s = await spawn("native-held-open");
    try {
      await trigger(s.sessionId, "23514");
      await releaseNative(s.taskId);
      const deadline = Date.now() + 5_000;
      while (!entry(s.taskId).cancelCount && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(entry(s.taskId).cancelCount).toBe(1);
      const result = await entry(s.taskId).session.result; expect(result.exitReason).toBe("canceled");
      const detail = await settled(s.taskId); expect(detail.live).toBe(false); expect(detail.task?.status).toBe("failed");
      expect(detail.changesets).toHaveLength(0); expect(entry(s.taskId).session.proc.exitCode !== null || entry(s.taskId).session.proc.signalCode !== null).toBe(true);
      expect(unhandled).toEqual([]); expect((await errorRows(s.sessionId)).map((row) => row.type)).toEqual(["error"]);
    } finally { await dropTrigger(); entry(s.taskId).session.cancel(); await entry(s.taskId).session.result; process.off("unhandledRejection", listener); log.mockRestore(); boundary.native = false; }
  }, 45_000);
  it("error: native fast-close done waits for the actual failed started write and never harvests", async () => {
    boundary.native = true; const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await spawn("native-fast-close");
    try {
      await trigger(s.sessionId, "23514", 0.3);
      await releaseNative(s.taskId);
      expect((await entry(s.taskId).session.result).exitReason).toBe("done");
      const detail = await settled(s.taskId); expect(detail.task?.status).toBe("failed"); expect(detail.changesets).toHaveLength(0);
      expect(await sessionRow(s.sessionId)).toMatchObject({ thread_id: null, exit_reason: "error", ended: true });
      expect((await errorRows(s.sessionId)).map((row) => row.type)).toEqual(["error"]);
    } finally { await dropTrigger(); entry(s.taskId).session.cancel(); await entry(s.taskId).session.result; log.mockRestore(); boundary.native = false; }
  }, 45_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const { taskId } of created) {
      try { const e = entry(taskId); e.session.cancel(); e.finish?.({ exitCode: null, exitReason: "canceled", lastMessage: "MC031 synthetic cleanup" }); await e.session.result; } catch (error) { failures.push(error); }
    }
    for (const { taskId } of created) { try { await settled(taskId); } catch (error) { failures.push(error); } }
    try { await closeAllPools(); } catch (error) { failures.push(error); }
    if (owner) { try { await owner.end(); } catch (error) { failures.push(error); } }
    if (fixtureRepo) { try { rmSync(fixtureRepo, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "MC031 synthetic fixture cleanup failed");
  }, 60_000);
});
