/** MC034: cancellation authorization and commit ordering on an owned real PostgreSQL/Git/Node child. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingToolAdapter, DevTaskSpec, RunningSession, SessionHooks } from "@workloom/base/dev-bridge";

const boundary = vi.hoisted(() => ({
  entries: new Map<string, { task: DevTaskSpec; session: RunningSession; cancelCalls: number }>(),
  discards: [] as Array<{ repo: string; worktree: string; branch: string }>,
}));
vi.mock("@workloom/base/dev-bridge", async (original) => {
  const actual = await original<typeof import("@workloom/base/dev-bridge")>();
  return {
    ...actual,
    startSession: (adapter: CodingToolAdapter, bin: string, task: DevTaskSpec, hooks: SessionHooks) => {
      const session = actual.startSession(adapter, bin, task, hooks);
      const entry = { task, session, cancelCalls: 0 };
      const cancel = session.cancel;
      session.cancel = () => { entry.cancelCalls += 1; cancel(); };
      boundary.entries.set(task.taskId, entry);
      return session;
    },
    worktreeDiscard: async (repo: string, worktree: string, branch: string) => {
      boundary.discards.push({ repo, worktree, branch });
      return actual.worktreeDiscard(repo, worktree, branch);
    },
  };
});
import { closeAllPools } from "@workloom/db";
import { runWithServiceScope, requireServiceScope } from "./scope.js";
import { cancelTask, confirmTask, createTask, dispatchTask, registerRepo, setDevToolAdapters, taskDetail } from "./devtools.js";

const nonce = randomUUID().replaceAll("-", "");
const a = { tenantId: `mc034-tenant-a-${nonce}`, workspaceId: `mc034-ws-a-${nonce}` };
const b = { tenantId: `mc034-tenant-b-${nonce}`, workspaceId: `mc034-ws-b-${nonce}` };
const actor = { id: "mc034-synthetic-operator", type: "human" as const };
const adapter: CodingToolAdapter = {
  toolKey: "mc034-synthetic", displayName: "MC034 actual local Node child", binName: () => "node",
  capabilities: () => ({ headless: true, streamEvents: "jsonl", sessionResume: true, sandboxFlag: false }),
  detect: async () => null,
  buildArgs: (task) => ["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(task.worktreePath, ".mc034-child-online"))}, String(process.pid)); setInterval(() => {}, 1000);`],
  parseLine: () => null,
};

describe.runIf(process.env.RUN_DB_TESTS === "1")("MC034 cancel scope/state/transaction ordering", () => {
  let owner: pg.Pool;
  let fixtureRepo: string;
  let repoId: string;
  let otherRepoId: string;
  const created: string[] = [];
  const inA = <T>(fn: () => T) => runWithServiceScope(a, fn);
  const entry = (id: string) => boundary.entries.get(id)!;
  const alive = (id: string) => entry(id).session.proc.exitCode === null && entry(id).session.proc.signalCode === null;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixtureRepo, encoding: "utf8", stdio: "pipe" });
  const report = (name: string, value: unknown) => {
    const root = process.env.DEVTOOLS_CANCEL_REPORT_DIR;
    if (!root) throw new Error("MC034 requires its owned observation directory");
    writeFileSync(join(root, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  async function waitFor(test: () => Promise<boolean>, description: string) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await test()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("MC034 timeout: " + description);
  }
  async function create(label: string, scope = a, registeredRepo = repoId) {
    const result = await runWithServiceScope(scope, () => createTask(scope.workspaceId, {
      repoId: registeredRepo, title: `MC034 ${label}`, prdSummary: label,
      acceptance: ["Reject invalid cancellation before native child, Git or business mutations"], assignedTool: adapter.toolKey,
    }, actor));
    created.push(result.task.id);
    return result.task.id as string;
  }
  async function spawn(label: string, repairRound = 2) {
    const taskId = await create(label);
    await inA(() => confirmTask(a.workspaceId, taskId, actor));
    await owner.query("UPDATE dev_tasks SET repair_round=$2 WHERE id=$1", [taskId, repairRound]);
    await inA(() => dispatchTask(a.workspaceId, taskId, actor));
    await waitFor(async () => {
      if (!alive(taskId)) throw new Error("Owned native child exited before startup");
      const marker = join(entry(taskId).task.worktreePath, ".mc034-child-online");
      return existsSync(marker) && Number(readFileSync(marker, "utf8")) === entry(taskId).session.proc.pid;
    }, "actual native child startup");
    expect(Number(readFileSync(join(entry(taskId).task.worktreePath, ".mc034-child-online"), "utf8"))).toBe(entry(taskId).session.proc.pid);
    return taskId;
  }
  async function view(taskId: string, connection: Pick<pg.Pool, "query"> | pg.PoolClient = owner) {
    const task = (await connection.query("SELECT to_jsonb(t) AS value FROM dev_tasks t WHERE id=$1", [taskId])).rows[0]?.value ?? null;
    const sessions = (await connection.query("SELECT to_jsonb(s) AS value FROM dev_sessions s WHERE task_id=$1 ORDER BY id", [taskId])).rows.map((r) => r.value);
    const events = (await connection.query("SELECT to_jsonb(e) AS value FROM dev_events e JOIN dev_sessions s ON s.id=e.session_id WHERE s.task_id=$1 ORDER BY e.seq", [taskId])).rows.map((r) => r.value);
    const business = (await connection.query("SELECT to_jsonb(e) AS value FROM biz_events e WHERE e.payload->'object'->>'id'=$1 ORDER BY seq", [taskId])).rows.map((r) => r.value);
    return { task, sessions, events, business };
  }
  function files(taskId: string) {
    const e = entry(taskId);
    const online = join(e.task.worktreePath, ".mc034-child-online");
    return {
      worktrees: git("worktree", "list", "--porcelain"), branches: git("show-ref", "--heads"),
      baseline: git("rev-parse", "main"),
      worktreeExists: existsSync(e.task.worktreePath), online: existsSync(online) ? readFileSync(online, "utf8") : null,
    };
  }
  async function observe(taskId: string, before: Awaited<ReturnType<typeof view>>, beforeFiles: ReturnType<typeof files>, discardOffset: number, error: unknown) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as Error & { code?: string }).code } : null,
      pid: entry(taskId).session.proc.pid, nativeChildStillRunning: alive(taskId), cancelCalls: entry(taskId).cancelCalls,
      discardCalls: boundary.discards.length - discardOffset, before, after: await view(taskId), beforeFiles, afterFiles: files(taskId),
    };
  }
  async function denied(name: string, taskId: string, call: () => Promise<unknown> = () => inA(() => cancelTask(a.workspaceId, taskId, actor)), code?: string) {
    const before = await view(taskId), beforeFiles = files(taskId), offset = boundary.discards.length;
    let error: unknown;
    try { await call(); } catch (caught) { error = caught; }
    const fact = await observe(taskId, before, beforeFiles, offset, error);
    report(name, fact);
    expect(fact.error).not.toBeNull();
    if (code) expect(fact.error?.code).toBe(code);
    expect(fact).toMatchObject({ nativeChildStillRunning: true, cancelCalls: 0, discardCalls: 0 });
    expect(fact.after).toEqual(fact.before);
    expect(fact.afterFiles).toEqual(fact.beforeFiles);
  }
  async function fault(taskId: string, kind: "update" | "event" | "commit" | "zero-update") {
    const id = taskId.replaceAll("'", "''");
    const table = kind === "event" ? "biz_events" : "dev_tasks";
    const condition = kind === "event"
      ? `NEW.payload->'object'->>'id'='${id}' AND NEW.payload->'decision'->>'action'='dev.task.cancel'`
      : `NEW.id='${id}' AND NEW.status='canceled'`;
    const action = kind === "zero-update" ? "RETURN NULL;" : "RAISE EXCEPTION 'MC034 owned cancellation fault' USING ERRCODE='23514';";
    await owner.query(`CREATE OR REPLACE FUNCTION mc034_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${action} END IF; RETURN NEW; END $$`);
    await owner.query(kind === "commit"
      ? "CREATE CONSTRAINT TRIGGER mc034_fault AFTER UPDATE ON dev_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mc034_fault()"
      : `CREATE TRIGGER mc034_fault BEFORE ${kind === "event" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION mc034_fault()`);
    return async () => owner.query(`DROP TRIGGER mc034_fault ON ${table}`);
  }

  beforeAll(async () => {
    if (process.env.DEVTOOLS_THREAD_TASK_OWNED !== "1" || !process.env.DATABASE_URL?.includes("host=/tmp/wl-raw-scope-")) {
      throw new Error("MC034 requires a fresh task-owned private Unix PostgreSQL");
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    expect((await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('workloom_app','workloom_gateway') ORDER BY rolname")).rows)
      .toEqual([{ rolname: "workloom_app", rolsuper: false, rolbypassrls: false }, { rolname: "workloom_gateway", rolsuper: false, rolbypassrls: false }]);
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic MC034 A'),($2,'Synthetic MC034 B')", [a.tenantId, b.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'MC034 A',$1,'synthetic'),($3,$4,'MC034 B',$3,'synthetic')", [a.workspaceId, a.tenantId, b.workspaceId, b.tenantId]);
    await owner.query("INSERT INTO dev_tool_installs(id,workspace_id,tool_key,bin_path,version,capabilities) VALUES($1,$2,$3,$4,'synthetic','{}')", [`mc034-tool-${nonce}`, a.workspaceId, adapter.toolKey, process.execPath]);
    setDevToolAdapters([adapter]);
    fixtureRepo = mkdtempSync(join(tmpdir(), "mc034-synthetic-git-"));
    for (const args of [["init", "-b", "main"], ["config", "user.email", "synthetic@example.invalid"], ["config", "user.name", "MC034 synthetic fixture"]]) git(...args);
    writeFileSync(join(fixtureRepo, "README.md"), "# MC034 synthetic fixture\n");
    git("add", "README.md"); git("commit", "-m", "synthetic MC034 fixture");
    repoId = (await inA(() => registerRepo(a.workspaceId, { name: "MC034 synthetic repo", path: fixtureRepo }, actor))).repo.id;
    otherRepoId = (await runWithServiceScope(b, () => registerRepo(b.workspaceId, { name: "MC034 other scoped repo", path: fixtureRepo }, actor))).repo.id;
  }, 60_000);

  for (const scenario of ["missing-scope", "foreign-workspace", "foreign-tenant", "scope-mismatch"] as const) {
    it(`permission: ${scenario} has zero actual native/Git/database effects`, async () => {
      const taskId = await spawn(scenario);
      await denied(scenario, taskId, () => {
        if (scenario === "missing-scope") return cancelTask(a.workspaceId, taskId, actor);
        if (scenario === "foreign-workspace") return runWithServiceScope(b, () => cancelTask(b.workspaceId, taskId, actor));
        if (scenario === "foreign-tenant") return runWithServiceScope({ tenantId: b.tenantId, workspaceId: a.workspaceId }, () => cancelTask(a.workspaceId, taskId, actor));
        return runWithServiceScope(b, () => cancelTask(a.workspaceId, taskId, actor));
      });
    });
  }
  for (const status of ["pending_approval", "released", "canceled"]) {
    it(`state: ${status} rejects before touching its actual live session`, async () => {
      const taskId = await spawn(status);
      await owner.query("UPDATE dev_tasks SET status=$2 WHERE id=$1", [taskId, status]);
      await denied("state-" + status, taskId);
    });
  }
  it("permission: a task referencing another workspace repository fails closed before cleanup", async () => {
    const taskId = await spawn("invisible related repository");
    await owner.query("UPDATE dev_tasks SET repo_id=$2 WHERE id=$1", [taskId, otherRepoId]);
    await denied("invisible-repository", taskId);
  });
  for (const [permission, table] of [["SELECT", "dev_tasks"], ["UPDATE", "dev_tasks"], ["SELECT", "dev_sessions"], ["SELECT", "dev_repos"], ["SELECT", "biz_events"]] as const) {
    it(`error: real ${permission} denial on ${table} leaves the child and all effects unchanged`, async () => {
      const taskId = await spawn(`denied ${table} ${permission}`);
      try {
        await owner.query(`REVOKE ${permission} ON ${table} FROM workloom_app`);
        await denied(`acl-${table}-${permission.toLowerCase()}`, taskId, undefined, "42501");
      } finally { await owner.query(`GRANT ${permission} ON ${table} TO workloom_app`); }
    });
  }
  for (const kind of ["update", "event", "commit", "zero-update"] as const) {
    it(`error: ${kind} failure rolls back task/event before cancel or worktree effects`, async () => {
      const taskId = await spawn(`fault ${kind}`), drop = await fault(taskId, kind);
      try { await denied("fault-" + kind, taskId, undefined, kind === "zero-update" ? undefined : "23514"); }
      finally { await drop(); }
    });
  }
  it("boundary: blank unknown quoted Unicode and long IDs cannot change the actual owner's session", async () => {
    const taskId = await spawn("unknown identifiers");
    for (const [index, invalid] of ["", "unknown-task", "外部 ' ; $1 🧵", "x".repeat(4096)].entries()) {
      await denied("unknown-id-" + index, taskId, () => inA(() => cancelTask(a.workspaceId, invalid, actor)));
    }
  });
  it("race: locked task changing to pending approval is re-read before any native side effect", async () => {
    const taskId = await spawn("locked state race"), locked = await owner.connect();
    let pending: Promise<{ error?: unknown; value?: unknown }> | undefined;
    let committed = false;
    try {
      await locked.query("BEGIN"); await locked.query("SELECT id FROM dev_tasks WHERE id=$1 FOR UPDATE", [taskId]);
      await locked.query("UPDATE dev_tasks SET status='pending_approval' WHERE id=$1", [taskId]);
      const before = await view(taskId, locked), beforeFiles = files(taskId), offset = boundary.discards.length;
      pending = inA(() => cancelTask(a.workspaceId, taskId, actor)).then((value) => ({ value }), (error: unknown) => ({ error }));
      await waitFor(async () => (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='workloom_app' AND wait_event_type='Lock' AND query LIKE '%dev_tasks%'")).rows[0].n > 0, "actual application row lock");
      await locked.query("COMMIT"); committed = true;
      const result = await pending, fact = await observe(taskId, before, beforeFiles, offset, result.error);
      report("locked-state-race", fact);
      expect(fact.error).not.toBeNull(); expect(fact).toMatchObject({ nativeChildStillRunning: true, cancelCalls: 0, discardCalls: 0 });
      expect(fact.after).toEqual(fact.before); expect(fact.afterFiles).toEqual(fact.beforeFiles);
    } finally {
      if (!committed) await locked.query("ROLLBACK");
      locked.release(); if (pending) await pending;
    }
  });
  for (const status of ["draft", "confirmed", "running", "auditing", "rejected", "failed"]) {
    it(`normal: existing allowed state ${status} without a live session still cancels with one committed event`, async () => {
      const taskId = await create(`allowed ${status}`);
      await owner.query("UPDATE dev_tasks SET status=$2 WHERE id=$1", [taskId, status]);
      const offset = boundary.discards.length;
      expect(await inA(() => cancelTask(a.workspaceId, taskId, actor))).toEqual({ ok: true, status: "canceled" });
      const fact = await view(taskId); report("allowed-" + status, fact);
      expect(fact.task.status).toBe("canceled"); expect(boundary.discards.length).toBe(offset);
      expect(fact.business.filter((row) => row.payload.decision.action === "dev.task.cancel")).toHaveLength(1);
    });
  }
  it("regression: an owning idle task can still be canceled after its repository is disabled", async () => {
    const taskId = await create("disabled registered repository");
    try {
      await owner.query("UPDATE dev_repos SET status='disabled' WHERE id=$1", [repoId]);
      expect(await inA(() => cancelTask(a.workspaceId, taskId, actor))).toEqual({ ok: true, status: "canceled" });
      const fact = await view(taskId); report("disabled-repository", fact);
      expect(fact.task.status).toBe("canceled");
      expect(fact.business.filter((row) => row.payload.decision.action === "dev.task.cancel")).toHaveLength(1);
    } finally { await owner.query("UPDATE dev_repos SET status='active' WHERE id=$1", [repoId]); }
  });
  it("normal: owning scope actually stops its native child and discards only its own isolated tree", async () => {
    const taskId = await spawn("owning native control"), offset = boundary.discards.length, beforeMain = git("rev-parse", "main");
    expect(await inA(() => cancelTask(a.workspaceId, taskId, actor))).toEqual({ ok: true, status: "canceled" });
    expect((await entry(taskId).session.result).exitReason).toBe("canceled");
    expect(entry(taskId).cancelCalls).toBe(1); expect(alive(taskId)).toBe(false);
    expect(boundary.discards.slice(offset)).toEqual([{ repo: fixtureRepo, worktree: entry(taskId).task.worktreePath, branch: `dev/${taskId}` }]);
    expect(existsSync(entry(taskId).task.worktreePath)).toBe(false); expect(git("rev-parse", "main")).toBe(beforeMain);
    const fact = await view(taskId); report("owning-native-control", fact);
    expect(fact.business.filter((row) => row.payload.decision.action === "dev.task.cancel")).toHaveLength(1);
  });
  it("concurrency: twenty simultaneous cancel requests to one idle task commit exactly one transition/event", async () => {
    const taskId = await create("twenty concurrent cancels"), offset = boundary.discards.length;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => inA(() => cancelTask(a.workspaceId, taskId, actor))));
    const fact = await view(taskId); report("concurrent-single-task", { fulfilled: results.filter((r) => r.status === "fulfilled").length, rejected: results.filter((r) => r.status === "rejected").length, fact });
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(results.filter((r) => r.status === "rejected")).toHaveLength(19);
    expect(fact.task.status).toBe("canceled"); expect(fact.business.filter((row) => row.payload.decision.action === "dev.task.cancel")).toHaveLength(1);
    expect(boundary.discards.length).toBe(offset);
  });
  it("concurrency: unrelated outer scope is restored and another task remains byte-for-byte unchanged", async () => {
    const taskId = await create("scoped target"), otherTask = await create("other scoped task", b, otherRepoId), before = await view(otherTask);
    await runWithServiceScope(b, async () => {
      expect(await inA(() => cancelTask(a.workspaceId, taskId, actor))).toEqual({ ok: true, status: "canceled" });
      expect(requireServiceScope(b.workspaceId)).toEqual(b);
    });
    expect(() => requireServiceScope(a.workspaceId)).toThrow(/scope/); expect(await view(otherTask)).toEqual(before);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const [taskId, e] of boundary.entries) {
      try { if (alive(taskId)) e.session.cancel(); await e.session.result; } catch (error) { failures.push(error); }
    }
    for (const [taskId] of boundary.entries) {
      try { await waitFor(async () => {
        const row = (await owner.query("SELECT ended_at FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1", [taskId])).rows[0];
        const detail = await inA(() => taskDetail(a.workspaceId, taskId));
        return !detail.live && row?.ended_at != null;
      }, "owned terminal cleanup"); } catch (error) { failures.push(error); }
    }
    try { await closeAllPools(); } catch (error) { failures.push(error); }
    if (owner) { try { await owner.end(); } catch (error) { failures.push(error); } }
    if (fixtureRepo) { try { rmSync(fixtureRepo, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "MC034 owned fixture cleanup failed");
  }, 60_000);
});
