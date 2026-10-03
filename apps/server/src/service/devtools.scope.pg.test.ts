/** Real PG writes; only the external session emitter is replaced with a controlled boundary. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHooks, SessionResult } from "@workloom/base/dev-bridge";
import { requireServiceScope, runWithServiceScope } from "./scope.js";

const boundary = vi.hoisted(() => ({
  hooks: null as SessionHooks | null,
  finish: null as ((value: SessionResult) => void) | null,
}));
vi.mock("@workloom/base/dev-bridge", async (original) => ({
  ...await original<typeof import("@workloom/base/dev-bridge")>(),
  startSession: (_adapter: unknown, _bin: string, task: { taskId: string }, hooks: SessionHooks) => {
    boundary.hooks = hooks;
    const result = new Promise<SessionResult>((resolve) => { boundary.finish = resolve; });
    return { sessionId: "synthetic-external-emitter", taskId: task.taskId, result, cancel: () => {
      boundary.finish?.({ exitCode: null, exitReason: "canceled", lastMessage: "Synthetic fixture cancel" });
    } };
  },
}));
import { CodexAdapter } from "@workloom/base/dev-bridge";
import { closeAllPools } from "@workloom/db";
import { confirmTask, createTask, dispatchTask, registerRepo, setDevToolAdapters } from "./devtools.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1";
const tag = randomUUID().replaceAll("-", "");
const scope = { tenantId: `scope-detached-tenant-${tag}`, workspaceId: `scope-detached-ws-${tag}` };
const actor = { id: "synthetic-scope-operator", type: "human" as const };

describe.runIf(RUN_DB)("DevFabric captured trusted scope across external callback boundaries", () => {
  let owner: pg.Pool;
  let fixtureRepo: string | undefined;
  let taskId = "";
  let sessionId = "";

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.DATABASE_APP_URL) {
      throw new Error("Detached scope PG contract requires explicit owner/app fixture URLs");
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic detached callback tenant')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'Synthetic detached callback',$1,'synthetic')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO dev_tool_installs(id,workspace_id,tool_key,bin_path,version,capabilities) VALUES($1,$2,'codex',$3,'synthetic-scope-emitter','{}')",
      [`scope-tool-${tag}`, scope.workspaceId, process.execPath]);
    setDevToolAdapters([new CodexAdapter()]);
    fixtureRepo = mkdtempSync(join(tmpdir(), "raw-scope-detached-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureRepo, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: fixtureRepo });
    execFileSync("git", ["config", "user.name", "Synthetic raw scope test"], { cwd: fixtureRepo });
    writeFileSync(join(fixtureRepo, "README.md"), "# Synthetic callback boundary fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: fixtureRepo });
    execFileSync("git", ["commit", "-m", "synthetic fixture"], { cwd: fixtureRepo, stdio: "pipe" });
    await runWithServiceScope(scope, async () => {
      const { repo } = await registerRepo(scope.workspaceId, { name: "Synthetic boundary", path: fixtureRepo! }, actor);
      const { task } = await createTask(scope.workspaceId, { repoId: repo.id, title: "Synthetic callback scope",
        prdSummary: "Exercise stored callbacks from an unrelated asynchronous caller", acceptance: ["Stored rows belong to the captured fixture scope"], assignedTool: "codex" }, actor);
      taskId = task.id;
      await confirmTask(scope.workspaceId, taskId, actor);
      // A terminal cancellation must finish once; this fixture does not exercise retries or a real provider.
      await owner.query("UPDATE dev_tasks SET repair_round=2 WHERE id=$1 AND workspace_id=$2", [taskId, scope.workspaceId]);
      sessionId = (await dispatchTask(scope.workspaceId, taskId, actor)).sessionId;
    });
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
    expect(boundary.hooks).not.toBeNull();
  }, 60_000);

  it("persists started/progress when an unscoped external emitter invokes onEvent", async () => {
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
    await boundary.hooks!.onEvent!({ type: "started", pid: 1, threadId: `synthetic-thread-${tag}` });
    await boundary.hooks!.onEvent!({ type: "progress", text: "Synthetic detached continuation" });
    const rows = (await owner.query("SELECT workspace_id,type FROM dev_events WHERE session_id=$1 ORDER BY seq", [sessionId])).rows;
    expect(rows).toEqual([{ workspace_id: scope.workspaceId, type: "started" }, { workspace_id: scope.workspaceId, type: "progress" }]);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });

  it("persists the started thread identity from the external emitter", async () => {
    const session = (await owner.query("SELECT thread_id FROM dev_sessions WHERE id=$1 AND workspace_id=$2", [sessionId, scope.workspaceId])).rows;
    expect(session).toEqual([{ thread_id: `synthetic-thread-${tag}` }]);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });

  it("persists fence audit and normalized event when onFenceVerdict is called outside the request ancestry", async () => {
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
    await boundary.hooks!.onFenceVerdict!("synthetic rejected command", "deny", "synthetic-scope-rule", "Synthetic scope boundary");
    const audit = (await owner.query("SELECT workspace_id,cmd,verdict,rule_id FROM dev_fences_audit WHERE session_id=$1", [sessionId])).rows;
    const events = (await owner.query("SELECT workspace_id,type FROM dev_events WHERE session_id=$1 AND type='fence_verdict'", [sessionId])).rows;
    expect(audit).toEqual([{ workspace_id: scope.workspaceId, cmd: "synthetic rejected command", verdict: "deny", rule_id: "synthetic-scope-rule" }]);
    expect(events).toEqual([{ workspace_id: scope.workspaceId, type: "fence_verdict" }]);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  });

  it("completes detached result continuation with persisted end event and no leaked outer scope", async () => {
    boundary.finish!({ exitCode: 0, exitReason: "canceled", lastMessage: "Synthetic result continuation", usage: { inputTokens: 1, outputTokens: 1 } });
    const deadline = Date.now() + 10_000;
    let task;
    do {
      task = (await owner.query("SELECT status FROM dev_tasks WHERE id=$1 AND workspace_id=$2", [taskId, scope.workspaceId])).rows[0];
      if (task?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    expect(task).toEqual({ status: "failed" });
    const ended = (await owner.query("SELECT exit_reason,last_message,ended_at IS NOT NULL AS ended FROM dev_sessions WHERE id=$1", [sessionId])).rows;
    const events = (await owner.query("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='dev.session.end'", [scope.tenantId, scope.workspaceId])).rows;
    expect(ended).toEqual([{ exit_reason: "canceled", last_message: "Synthetic result continuation", ended: true }]);
    expect(events).toEqual([{ action: "dev.session.end" }]);
    expect(() => requireServiceScope(scope.workspaceId)).toThrow(/scope/);
  }, 15_000);

  afterAll(async () => {
    boundary.finish?.({ exitCode: null, exitReason: "canceled", lastMessage: "Synthetic cleanup" });
    const failures: unknown[] = [];
    try { await closeAllPools(); } catch (error) { failures.push(error); }
    if (owner) {
      try {
        for (const table of ["dev_fences_audit", "dev_events", "dev_changesets", "releases", "dev_sessions", "dev_tasks", "dev_tool_installs", "dev_repos"]) {
          await owner.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [scope.workspaceId]);
        }
      } catch (error) { failures.push(error); }
      try { await owner.end(); } catch (error) { failures.push(error); }
    }
    if (fixtureRepo) {
      try { rmSync(fixtureRepo, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Synthetic detached scope fixture cleanup failed");
  });
});
