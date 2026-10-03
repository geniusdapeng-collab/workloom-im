/**
 * MC-012/112：实际组合根、实时成员授权和安全网关的知识发布 PostgreSQL 回归。
 * 只有独立 Unix socket / nonce 所有权校验通过才接库；普通 test 保持显式跳过。
 * 每个故障注入都作用于真实 SQL，既检查回滚，也用同一请求解除故障后重试。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import pg from "pg";
import type { Identity } from "@workloom/base/tenancy";
import type { AppRouter, TrpcContext } from "../trpc/router.js";

type Caller = ReturnType<AppRouter["createCaller"]>;
type Fault = "document" | "event" | "approval" | "commit";
interface Case {
  id: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  actual: unknown;
  evidence_grade: "B";
}
interface DocumentFixture { documentId: string; title: string; collectionId: string; contentMd: string; version: number }
interface State {
  document: { id: string; title: string; version: number; status: string; hash: string; content_md: string } | null;
  events: Array<{ event_id: string; action: string; after: Record<string, unknown> }>;
  approvals: Array<{ approval_id: string; event_id: string; status: string; gesture: { type?: string } | null; decided_by: string | null; consumed_at: string | null; snapshot: Record<string, unknown> }>;
  gestures: Array<{ event_id: string; after: Record<string, unknown> }>;
}

const enabled = process.env.RUN_KB_PUBLISH_DB_TESTS === "1";
const scopeA = { tenantId: "tenant-kb-a", workspaceId: "ws-kb-a" };
const scopeB = { tenantId: "tenant-kb-b", workspaceId: "ws-kb-b" };
const identityA: Identity = { kind: "member", memberId: "mem-kb-a", memberNo: "MEM-981", name: "合成知识管理员甲", role: "owner", plan: "pro", ...scopeA };
const identityB: Identity = { kind: "member", memberId: "mem-kb-b", memberNo: "MEM-982", name: "合成知识管理员乙", role: "owner", plan: "pro", ...scopeB };
const context = (identity: Identity): TrpcContext => ({ session: identity, identity, partnerIdentity: null, headers: new Headers() });

describe.skipIf(!enabled)("MC-012/112 PostgreSQL：知识发布、审批和当前版本同一事务", () => {
  let owner: pg.Pool | undefined;
  let app: pg.Pool;
  let callerA: Caller;
  let callerB: Caller;
  let appRouter: AppRouter;
  let closeAllPools: () => Promise<void>;
  let eventHash: (previous: string, payload: unknown) => string;
  let serviceTx: typeof import("./events.js")["serviceTx"];
  let appendEventOn: typeof import("./events.js")["appendEventOn"];
  let fixtureNo = 0;
  const cases: Case[] = [];
  const collectionIds = new Map<string, string>();

  function record(id: string, preconditions: string[], steps: string[], expected: string[], actual: unknown): void {
    const item: Case = { id, preconditions, steps, expected, actual, evidence_grade: "B" };
    cases.push(item);
    console.log(JSON.stringify(item));
  }

  function errorInfo(error: unknown) {
    const e = error as { name?: string; code?: string; message?: string; stack?: string; cause?: { name?: string; code?: string } };
    return { name: e?.name ?? null, code: e?.code ?? null, message: e?.message ?? String(error), causeName: e?.cause?.name ?? null, causeCode: e?.cause?.code ?? null, stack: e?.stack?.split("\n").slice(0, 8) ?? [] };
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try { return { ok: true as const, value: await fn() }; }
    catch (error) { return { ok: false as const, error: errorInfo(error) }; }
  }

  async function document(label: string, caller = callerA, scope = scopeA): Promise<DocumentFixture> {
    const title = `kb-fixture-${++fixtureNo}-${label}`;
    const contentMd = `## ${title}\n\n${title} 是合成回归条目，原文须经逐条人审后才能进入客户问答。`;
    const collectionId = collectionIds.get(scope.workspaceId)!;
    const up = await caller.service.kb.upsertDocument({ collectionId, title, contentMd, sourceKind: "manual" });
    return { ...up, title, contentMd, collectionId };
  }

  async function state(doc: DocumentFixture, scope = scopeA): Promise<State> {
    const row = await owner!.query<State["document"] & {}>("SELECT id,title,version,status,hash,content_md FROM kb_documents WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, doc.documentId]);
    const events = await owner!.query<State["events"][number]>(
      `SELECT event_id,payload->'decision'->>'action' AS action,payload->'decision'->'after' AS after
       FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'object'->>'id'=$3 ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, doc.documentId],
    );
    const approvals = await owner!.query<State["approvals"][number]>(
      `SELECT a.approval_id,a.event_id,a.status,a.gesture,a.decided_by,a.consumed_at,a.snapshot FROM approvals a
       JOIN biz_events e ON e.event_id=a.event_id AND e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id
       WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND e.payload->'object'->>'id'=$3 ORDER BY a.approval_id`,
      [scope.tenantId, scope.workspaceId, doc.documentId],
    );
    const gestures = await owner!.query<State["gestures"][number]>(
      `SELECT event_id,payload->'decision'->'after' AS after FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='approval.gesture'
         AND payload->'decision'->'after'->>'approvalId'=ANY($3::text[]) ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, approvals.rows.map((a) => a.approval_id)],
    );
    return { document: row.rows[0] ?? null, events: events.rows, approvals: approvals.rows, gestures: gestures.rows };
  }

  async function scopeCounts(): Promise<{ documents: number; events: number; approvals: number }> {
    const result = await owner!.query<{ documents: number; events: number; approvals: number }>(
      `SELECT (SELECT count(*)::int FROM kb_documents WHERE workspace_id=$1) AS documents,
              (SELECT count(*)::int FROM biz_events WHERE workspace_id=$1) AS events,
              (SELECT count(*)::int FROM approvals WHERE workspace_id=$1) AS approvals`,
      [scopeA.workspaceId],
    );
    return result.rows[0]!;
  }

  async function legacy(doc: DocumentFixture, opts: { status?: "active" | "pending_review"; action?: string; omitVersion?: boolean; hash?: string; version?: number; highRisk?: boolean; channel?: string } = {}): Promise<string> {
    return serviceTx(scopeA.workspaceId, async (client, sc) => {
      const event = await appendEventOn(client, sc, { id: identityA.memberNo, type: "human" }, {
        objectType: "kb_document", objectId: doc.documentId, action: opts.action ?? "kb.publish",
        // 原幽灵发布的 after 没有 documentId；object.id 仍是权威文档锚点。
        after: { title: doc.title, status: "active", ...(opts.omitVersion ? {} : { version: opts.version ?? doc.version }), ...(opts.hash ? { hash: opts.hash } : {}) },
      });
      const approvalId = `apr-fixture-${event.eventId.toLowerCase()}`;
      await client.query(
        `INSERT INTO approvals (approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot)
         VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [approvalId, sc.tenantId, sc.workspaceId, event.eventId, opts.channel ?? "inapp", JSON.stringify({ after: { documentId: doc.documentId, fence_action: "kb.publish" }, high_risk: opts.highRisk ?? false })],
      );
      await client.query("UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2", [sc.workspaceId, doc.documentId, opts.status ?? "active"]);
      return approvalId;
    }, scopeA);
  }

  async function setFault(stage: Fault, documentId: string): Promise<void> {
    await owner!.query("INSERT INTO kb_publish_faults (stage,document_id) VALUES ($1,$2)", [stage, documentId]);
  }
  async function clearFault(stage: Fault): Promise<void> { await owner!.query("DELETE FROM kb_publish_faults WHERE stage=$1", [stage]); }

  function assertPublication(value: State, doc: DocumentFixture, count = 1): void {
    expect(value.document).toMatchObject({ id: doc.documentId, status: "active", version: doc.version });
    const approved = value.approvals.filter((a) => a.status === "approved");
    expect(approved).toHaveLength(count);
    const last = approved.at(-1)!;
    expect(last).toMatchObject({ decided_by: identityA.memberNo, gesture: { type: "approve" }, consumed_at: null, snapshot: { after: { documentId: doc.documentId, version: doc.version }, post_hoc: true } });
    const event = value.events.find((e) => e.event_id === last.event_id)!;
    expect(event).toMatchObject({ action: "kb.publish", after: { documentId: doc.documentId, version: doc.version, hash: value.document!.hash, status: "active", approved_by: identityA.memberNo } });
    expect(value.approvals.filter((a) => a.status === "pending")).toHaveLength(0);
  }

  beforeAll(async () => {
    const socket = process.env.KB_PUBLISH_SOCKET;
    const port = process.env.KB_PUBLISH_PORT;
    const nonce = process.env.KB_PUBLISH_NONCE;
    if (!socket?.startsWith("/tmp/wl-kb-pg-") || !/^\d+$/.test(port ?? "") || !nonce) throw new Error("Refusing KB regression without isolated Unix ownership");
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"] as const) {
      const parsed = new URL(process.env[key] ?? "");
      if (parsed.pathname !== "/kb_publish" || parsed.searchParams.get("host") !== socket || parsed.searchParams.get("port") !== port) throw new Error(`Non-fixture ${key}`);
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const sentinel = await owner.query<{ nonce: string; listener: string }>("SELECT nonce,current_setting('listen_addresses') AS listener FROM kb_publish_fixture_owner");
    if (sentinel.rows.length !== 1 || sentinel.rows[0]!.nonce !== nonce || sentinel.rows[0]!.listener !== "") throw new Error("Fixture owner nonce/TCP listener mismatch");
    const db = await import("@workloom/db");
    closeAllPools = db.closeAllPools;
    app = db.getAppPool();
    appRouter = (await import("../trpc/router.js")).appRouter;
    eventHash = (await import("@workloom/base/workdata")).eventHash;
    ({ serviceTx, appendEventOn } = await import("./events.js"));
    callerA = appRouter.createCaller(context(identityA));
    callerB = appRouter.createCaller(context(identityB));
    for (const identity of [identityA, identityB]) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro')", [identity.tenantId, identity.name]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,$3,$1,'hotel')", [identity.workspaceId, identity.tenantId, identity.name]);
      await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role,status,permissions,im_openids) VALUES ($1,$2,$3,$4,'owner','active','{}',$5)", [identity.memberId, identity.workspaceId, identity.memberNo, identity.name, JSON.stringify({ wecom: `${identity.memberId}-openid` })]);
      const caller = identity === identityA ? callerA : callerB;
      const collection = await caller.service.kb.createCollection({ name: identity.name });
      collectionIds.set(identity.workspaceId, collection.collection.id);
    }
    await owner.query(`
      CREATE TABLE kb_publish_faults (stage text PRIMARY KEY, document_id text NOT NULL);
      CREATE FUNCTION kb_publish_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fixture$
      DECLARE target_document text; actual_document text;
      BEGIN
        SELECT document_id INTO target_document FROM public.kb_publish_faults WHERE stage=TG_ARGV[0];
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME='kb_documents' THEN actual_document=NEW.id;
        ELSIF TG_TABLE_NAME='biz_events' THEN actual_document=NEW.payload->'object'->>'id';
        ELSIF TG_TABLE_NAME='approvals' THEN actual_document=NEW.snapshot->'after'->>'documentId'; END IF;
        IF actual_document=target_document THEN RAISE EXCEPTION 'kb_publish injected failure at %',TG_ARGV[0]; END IF;
        RETURN NEW;
      END;
      $fixture$;
      CREATE TRIGGER kb_publish_document BEFORE UPDATE ON kb_documents FOR EACH ROW EXECUTE FUNCTION kb_publish_fault('document');
      CREATE TRIGGER kb_publish_event BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION kb_publish_fault('event');
      CREATE TRIGGER kb_publish_approval BEFORE INSERT OR UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION kb_publish_fault('approval');
      CREATE CONSTRAINT TRIGGER kb_publish_commit_approval AFTER INSERT OR UPDATE ON approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kb_publish_fault('commit');
      CREATE CONSTRAINT TRIGGER kb_publish_commit_document AFTER UPDATE ON kb_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kb_publish_fault('commit');
    `);
  }, 60_000);

  afterAll(async () => {
    if (process.env.KB_PUBLISH_RESULTS) writeFileSync(process.env.KB_PUBLISH_RESULTS, JSON.stringify({ schema: "workloom.kb-publish-pg@1", cases, actual_router: true, actual_member_authority: true, actual_gateway: true, synthetic_scopes: [scopeA, scopeB] }, null, 2) + "\n");
    try { if (closeAllPools) await closeAllPools(); }
    finally { if (owner) await owner.end(); }
  });

  it("非超级 app 角色、无 GUC 查询空集、事件旁路写入被拒", async () => {
    const role = await app.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    const unseen = await app.query("SELECT id FROM kb_documents");
    const bypass = await attempt(() => app.query("INSERT INTO biz_events (event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-KB-bypass','x','x','{}','GENESIS','x')"));
    record("pg-rls-role", ["fresh Unix fixture", "real app role"], ["inspect flags and empty-GUC visibility", "try direct event INSERT"], ["NOSUPERUSER/NOBYPASSRLS", "zero visible documents", "permission denied"], { role: role.rows, unseen: unseen.rows, bypass });
    expect(role.rows[0]).toMatchObject({ current_user: "workloom_app", rolsuper: false, rolbypassrls: false });
    expect(unseen.rows).toHaveLength(0);
    expect(bypass.ok).toBe(false);
    if (!bypass.ok) expect(bypass.error.code).toBe("42501");
  });

  it("逐条发布当场写 approved 决策记录，绑定文档、版本与内容哈希", async () => {
    const doc = await document("normal");
    const result = await attempt(() => callerA.service.kb.approveDocument({ documentId: doc.documentId }));
    const after = await state(doc);
    const search = await callerA.service.kb.search({ query: doc.title });
    record("pg-normal", ["pending document version 1"], ["approveDocument", "read document/event/approval and search"], ["active", "one approved human decision", "same document/version/hash in both receipt and snapshot", "search hit"], { result, after, search });
    expect(result.ok).toBe(true);
    assertPublication(after, doc);
    expect(search.hits.some((hit) => hit.documentId === doc.documentId)).toBe(true);
  });

  it("重复发布返回同一非空 eventId/approvalId，不写第二条记录", async () => {
    const doc = await document("repeat");
    const first = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const before = await state(doc);
    const repeated = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const after = await state(doc);
    record("pg-repeat", ["one completed publication"], ["publish twice"], ["deduped second result", "same nonempty receipt", "no committed changes"], { first, repeated, before, after });
    expect(repeated).toMatchObject({ deduped: true });
    const receipts = [first, repeated] as Array<{ eventId?: string | null; approvalId?: string | null }>;
    expect(typeof receipts[0]!.eventId).toBe("string");
    expect(typeof receipts[0]!.approvalId).toBe("string");
    expect(receipts[1]!.eventId).toBe(receipts[0]!.eventId);
    expect(receipts[1]!.approvalId).toBe(receipts[0]!.approvalId);
    expect(after).toEqual(before);
  });

  it.each(["pending_review", "disabled"] as const)("setStatus(active) 从 %s 同样逐条人审留痕", async (from) => {
    const doc = await document(`set-active-${from}`);
    if (from === "disabled") await callerA.service.kb.setStatus({ documentId: doc.documentId, status: "disabled" });
    const result = await attempt(() => callerA.service.kb.setStatus({ documentId: doc.documentId, status: "active" }));
    const after = await state(doc);
    record(`pg-set-active-${from}`, [`document ${from}`], ["setStatus(active)"], ["one approved publication with revision binding"], { result, after });
    expect(result.ok).toBe(true);
    assertPublication(after, doc);
  });

  it.each(["approve", "set-active", "legacy-decide", "im-callback"] as const)("显式 deny approval.decide 禁止 %s，普通内容写权限不能替代", async (route) => {
    const doc = await document(`deny-${route}`);
    const approvalId = route === "legacy-decide" || route === "im-callback" ? await legacy(doc) : null;
    const before = await state(doc);
    await owner!.query("UPDATE members SET permissions=$2 WHERE id=$1", [identityA.memberId, JSON.stringify({ deny: ["approval.decide"] })]);
    let result;
    try {
      result = await attempt<unknown>(() => route === "approve" ? callerA.service.kb.approveDocument({ documentId: doc.documentId })
        : route === "set-active" ? callerA.service.kb.setStatus({ documentId: doc.documentId, status: "active" })
          : route === "legacy-decide" ? callerA.approvals.decide({ approvalId: approvalId!, gesture: "approve" })
            : callerA.im.callback({ channel: "wecom", approvalId: approvalId!, operatorOpenId: `${identityA.memberId}-openid`, conversationId: "kb-fixture", gesture: "approve" }));
    } finally { await owner!.query("UPDATE members SET permissions='{}' WHERE id=$1", [identityA.memberId]); }
    const after = await state(doc);
    record(`pg-permission-${route}`, ["stale owner session", "live approval.decide denied, workspace.write allowed"], [`invoke ${route}`], ["FORBIDDEN", "all document/event/approval state unchanged"], { result, before, after });
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.error.code).toBe("FORBIDDEN");
    expect(after).toEqual(before);
  });

  it.each(["readonly", "removed-member", "forged-tenant", "other-workspace"] as const)("实时 %s 身份不能发布本区知识", async (kind) => {
    const doc = await document(`authority-${kind}`);
    const before = await state(doc);
    if (kind === "readonly") await owner!.query("UPDATE members SET role='readonly' WHERE id=$1", [identityA.memberId]);
    if (kind === "removed-member") await owner!.query("UPDATE members SET status='removed' WHERE id=$1", [identityA.memberId]);
    const caller = kind === "other-workspace" ? callerB : kind === "forged-tenant" ? appRouter.createCaller(context({ ...identityA, tenantId: scopeB.tenantId })) : callerA;
    let result;
    try { result = await attempt(() => caller.service.kb.approveDocument({ documentId: doc.documentId })); }
    finally { await owner!.query("UPDATE members SET role='owner',status='active' WHERE id=$1", [identityA.memberId]); }
    const after = await state(doc);
    record(`pg-authority-${kind}`, ["owner claim retained", `actual authority ${kind}`], ["approveDocument", "read committed state"], ["request rejected", "no mutations"], { result, before, after });
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.error.code).toBe(kind === "readonly" ? "FORBIDDEN" : kind === "other-workspace" ? "NOT_FOUND" : "UNAUTHORIZED");
    expect(after).toEqual(before);
  });

  it.each(["", "kbd-fixture-missing"])("不存在文档 %s 不写孤儿事件或审批", async (documentId) => {
    const before = await scopeCounts();
    const result = await attempt(() => callerA.service.kb.approveDocument({ documentId }));
    const after = await scopeCounts();
    record(`pg-missing-${documentId || "empty"}`, ["requested document absent"], ["approveDocument"], ["NOT_FOUND", "no writes"], { result, before, after });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(after).toEqual(before);
  });

  it("200 字标题和 100000 字正文的上界版本经过人审后绑定真实内容哈希", async () => {
    const title = `kb-max-${++fixtureNo}-`.padEnd(200, "界");
    const contentMd = "## 最大知识正文\n\n".padEnd(100_000, "界");
    const collectionId = collectionIds.get(scopeA.workspaceId)!;
    const up = await callerA.service.kb.upsertDocument({ collectionId, title, contentMd });
    const doc = { ...up, title, contentMd, collectionId };
    const published = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const after = await state(doc);
    record("pg-maximum-fields", ["title length 200", "content length 100000"], ["upsert maximum allowed strings", "approve current version", "read hash-bound publication"], ["version 1", "exact content preserved", "one approved publication on same hash"], { up, published, document: { id: after.document?.id, version: after.document?.version, status: after.document?.status, titleLength: after.document?.title.length, contentLength: after.document?.content_md.length, hash: after.document?.hash }, approvals: after.approvals, events: after.events });
    expect(after.document).toMatchObject({ title, content_md: contentMd });
    assertPublication(after, doc);
  });

  it.each([
    { id: "empty-title", title: "", contentMd: "合成内容" },
    { id: "overlong-title", title: "界".repeat(201), contentMd: "合成内容" },
    { id: "empty-content", title: "合成空正文", contentMd: "" },
    { id: "overlong-content", title: "合成越界正文", contentMd: "界".repeat(100_001) },
  ])("$id 校验失败不会创建文档、事件或审批", async ({ id, title, contentMd }) => {
    const before = await scopeCounts();
    const result = await attempt(() => callerA.service.kb.upsertDocument({ collectionId: collectionIds.get(scopeA.workspaceId)!, title, contentMd }));
    const after = await scopeCounts();
    record(`pg-validation-${id}`, [`title length ${title.length}`, `content length ${contentMd.length}`], ["upsert invalid input", "compare scoped table counters"], ["BAD_REQUEST", "no document/event/approval writes"], { result, before, after });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_REQUEST");
    expect(after).toEqual(before);
  });

  it("中文、引号、反斜线和 emoji 原文可发布并按同一回执幂等重放", async () => {
    const title = `kb-special-${++fixtureNo}-中文 O'Reilly \"引号\" \\ 😀`;
    const contentMd = `## ${title}\n\n原文：'单引号'、\"双引号\"、\\路径\\、😀、\`代码\` 和换行。`;
    const collectionId = collectionIds.get(scopeA.workspaceId)!;
    const up = await callerA.service.kb.upsertDocument({ collectionId, title, contentMd });
    const doc = { ...up, title, contentMd, collectionId };
    const published = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const before = await state(doc);
    const repeated = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const after = await state(doc);
    record("pg-special-characters", ["UTF-16 input contains CJK, quotes, backslash, emoji, Markdown and newline"], ["upsert", "approve", "repeat same publication"], ["exact title and source content", "same nonempty approved receipt", "no repeat writes"], { published, repeated, before, after });
    expect(after.document).toMatchObject({ title, content_md: contentMd });
    assertPublication(after, doc);
    expect(repeated).toMatchObject({ eventId: published.eventId, approvalId: published.approvalId, deduped: true });
    expect(after).toEqual(before);
  });

  it("停用文档直接批准被拒且不留下第二次发布，显式重新启用才可人审", async () => {
    const doc = await document("disabled-approve");
    await callerA.service.kb.setStatus({ documentId: doc.documentId, status: "disabled" });
    const before = await state(doc);
    const result = await attempt(() => callerA.service.kb.approveDocument({ documentId: doc.documentId }));
    const after = await state(doc);
    record("pg-disabled-direct-publication", ["disabled document"], ["approveDocument without explicit reactivation"], ["PRECONDITION_FAILED", "same document/event/approval state"], { result, before, after });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PRECONDITION_FAILED");
    expect(after).toEqual(before);
  });

  it.each(["document", "event", "approval", "commit"] as const)("新发布 %s 故障全部回滚，解除后同请求可重试", async (stage) => {
    const doc = await document(`new-fault-${stage}`);
    const before = await state(doc);
    await setFault(stage, doc.documentId);
    let failed;
    let afterFailure;
    try { failed = await attempt(() => callerA.service.kb.approveDocument({ documentId: doc.documentId })); afterFailure = await state(doc); }
    finally { await clearFault(stage); }
    const retry = await attempt(() => callerA.service.kb.approveDocument({ documentId: doc.documentId }));
    const afterRetry = await state(doc);
    record(`pg-new-fault-${stage}`, ["pending document", "no decision record"], [`inject real ${stage} SQL failure`, "publish", "clear fault", "repeat same documentId"], ["first fails", "exact pre-state after failure", "one complete publication after retry"], { before, failed, afterFailure, retry, afterRetry });
    expect(failed!.ok).toBe(false);
    if (!failed!.ok) expect(failed!.error.causeCode).toBe("P0001");
    expect(afterFailure).toEqual(before);
    expect(retry.ok).toBe(true);
    assertPublication(afterRetry, doc);
  });

  it.each(["approve", "edit", "reject"] as const)("遗留待审的 %s 与文档、手势事件同一提交且可重放", async (gesture) => {
    const doc = await document(`legacy-${gesture}`);
    const approvalId = await legacy(doc, { status: gesture === "reject" ? "active" : "pending_review" });
    const result = await attempt(() => callerA.approvals.decide({ approvalId, gesture, reasonEnum: gesture === "reject" ? "fixture.invalid" : undefined, editedAfter: gesture === "edit" ? { title: doc.title } : undefined }));
    const after = await state(doc);
    const repeated = await attempt(() => callerA.approvals.decide({ approvalId, gesture, reasonEnum: gesture === "reject" ? "fixture.invalid" : undefined, editedAfter: gesture === "edit" ? {} : undefined }));
    const afterRepeated = await state(doc);
    const search = await callerA.service.kb.search({ query: doc.title });
    record(`pg-legacy-${gesture}`, ["legacy kb.publish event lacks after.documentId", "pending review record", "same document version"], [`decide ${gesture}`, "repeat same gesture", "read KB search"], ["terminal approval and correct document state", "one gesture and one state event", "replay changes nothing", "search follows status"], { result, after, repeated, afterRepeated, search });
    expect(result.ok).toBe(true);
    expect(after.document?.status).toBe(gesture === "reject" ? "pending_review" : "active");
    expect(after.approvals[0]?.status).toBe(gesture === "approve" ? "approved" : gesture === "edit" ? "edited" : "rejected");
    expect(after.gestures).toHaveLength(1);
    expect(after.events.filter((e) => e.after.approvalId === approvalId)).toHaveLength(1);
    expect(after.events.find((e) => e.after.approvalId === approvalId)?.after).toMatchObject({ documentId: doc.documentId, version: doc.version });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.value.deduped).toBe(true);
    expect(afterRepeated).toEqual(after);
    expect(search.hits.some((hit) => hit.documentId === doc.documentId)).toBe(gesture !== "reject");
  });

  it.each((["approve", "reject"] as const).flatMap((gesture) => (["document", "event", "commit"] as const).map((stage) => ({ gesture, stage }))))("遗留 $gesture / $stage 故障回滚审批和文档，重试可恢复", async ({ gesture, stage }) => {
      const doc = await document(`legacy-${gesture}-fault-${stage}`);
      const approvalId = await legacy(doc, { status: gesture === "reject" ? "active" : "pending_review" });
      const input = { approvalId, gesture, reasonEnum: gesture === "reject" ? `fixture.${gesture}.${stage}` : undefined };
      const before = await state(doc);
      await setFault(stage, doc.documentId);
      let failed;
      let afterFailure;
      try { failed = await attempt(() => callerA.approvals.decide(input)); afterFailure = await state(doc); }
      finally { await clearFault(stage); }
      const retry = await attempt(() => callerA.approvals.decide(input));
      const afterRetry = await state(doc);
      record(`pg-legacy-${gesture}-fault-${stage}`, ["pending legacy approval", "current revision matches source event"], [`inject ${stage} failure`, `decide ${gesture}`, "clear failure", "same approvalId retry"], ["first fails", "document, approval and gesture rolled back", "retry commits one gesture and state application"], { before, failed, afterFailure, retry, afterRetry });
      expect(failed!.ok).toBe(false);
      expect(afterFailure).toEqual(before);
      expect(retry.ok).toBe(true);
      expect(afterRetry.document?.status).toBe(gesture === "reject" ? "pending_review" : "active");
      expect(afterRetry.gestures).toHaveLength(1);
  });

  it("已终态的旧驳回可通过 deduped 重试收敛半状态；COMMIT 失败后还能重试", async () => {
    const doc = await document("dedup-repair");
    const approvalId = await legacy(doc);
    await owner!.query("UPDATE approvals SET status='rejected',decided_by=$2,decided_at=now(),gesture=$3 WHERE approval_id=$1", [approvalId, identityA.memberNo, JSON.stringify({ type: "reject", weight: 3, reason_enum: "fixture.old" })]);
    const before = await state(doc);
    await setFault("commit", doc.documentId);
    let failed;
    let afterFailure;
    try { failed = await attempt(() => callerA.approvals.decide({ approvalId, gesture: "reject", reasonEnum: "fixture.old" })); afterFailure = await state(doc); }
    finally { await clearFault("commit"); }
    const retry = await callerA.approvals.decide({ approvalId, gesture: "reject", reasonEnum: "fixture.old" });
    const after = await state(doc);
    const repeated = await callerA.approvals.decide({ approvalId, gesture: "reject", reasonEnum: "fixture.old" });
    const final = await state(doc);
    record("pg-terminal-repair", ["pre-fix rejected approval but active KB document"], ["retry deduped decision under COMMIT fault", "clear failure", "repeat twice"], ["failure preserves half-state for retry", "deduped retry fixes document", "no new gesture and exactly one revoke event", "second repair no-op"], { before, failed, afterFailure, retry, after, repeated, final });
    expect(failed!.ok).toBe(false);
    expect(afterFailure).toEqual(before);
    expect(retry.deduped).toBe(true);
    expect(after.document?.status).toBe("pending_review");
    expect(after.gestures).toHaveLength(0);
    expect(after.events.filter((e) => e.action === "kb.publish.revoke")).toHaveLength(1);
    expect(final).toEqual(after);
  });

  it("已发布内容改写必须退回待审，同内容重传仍保持当前批准", async () => {
    const doc = await document("revision");
    await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const duplicate = await callerA.service.kb.upsertDocument({ collectionId: doc.collectionId, title: doc.title, contentMd: doc.contentMd });
    const same = await state(doc);
    const changedMd = doc.contentMd + "\n新增承诺必须再次审阅。";
    const changed = await callerA.service.kb.upsertDocument({ collectionId: doc.collectionId, title: doc.title, contentMd: changedMd });
    const beforeReview = await state(doc);
    const search = await callerA.service.kb.search({ query: doc.title });
    const published = await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const afterReview = await state({ ...doc, version: 2 });
    record("pg-revision-review", ["approved version 1"], ["same-content upload", "upload changed content", "search", "approve version 2"], ["same hash remains active", "version increments and new text pending_review", "new text not searchable before review", "new approved revision 2 receipt"], { duplicate, same, changed, beforeReview, search, published, afterReview });
    expect(duplicate).toMatchObject({ documentId: doc.documentId, version: 1, chunks: 0 });
    expect(same.document?.status).toBe("active");
    expect(changed.version).toBe(2);
    expect(beforeReview.document).toMatchObject({ status: "pending_review", version: 2, content_md: changedMd });
    expect(search.hits.some((hit) => hit.documentId === doc.documentId)).toBe(false);
    expect(afterReview.approvals).toHaveLength(2);
    expect(afterReview.events.filter((e) => e.action === "kb.publish").map((e) => e.after.version)).toEqual([1, 2]);
  });

  it.each(["approve", "reject"] as const)("旧版本 %s 不能改动新版本状态", async (gesture) => {
    const doc = await document(`stale-${gesture}`);
    const approvalId = await legacy(doc);
    const changed = await callerA.service.kb.upsertDocument({ collectionId: doc.collectionId, title: doc.title, contentMd: doc.contentMd + "\n新版本。" });
    const before = await state(doc);
    const result = await callerA.approvals.decide({ approvalId, gesture, reasonEnum: gesture === "reject" ? "fixture.stale" : undefined });
    const after = await state(doc);
    record(`pg-stale-${gesture}`, ["version 1 proposal", "current document version 2"], [`decide old ${gesture}`], ["decision retained as historical", "new revision stays pending_review", "no KB status side event"], { changed, before, result, after });
    expect(after.document).toEqual(before.document);
    expect(after.document?.status).toBe("pending_review");
    expect(after.events).toEqual(before.events);
  });

  it("同版本较新的逐条批准胜过旧待办驳回，避免重新审阅后被旧回调撤销", async () => {
    const doc = await document("newer-decision");
    const approvalId = await legacy(doc, { status: "pending_review" });
    await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const before = await state(doc);
    const result = await callerA.approvals.decide({ approvalId, gesture: "reject", reasonEnum: "fixture.newer" });
    const after = await state(doc);
    record("pg-newer-review-wins", ["old pending publication", "newer completed human approval on same revision"], ["reject old approval"], ["newer approved revision remains active", "old decision still retained"], { before, result, after });
    expect(after.document).toEqual(before.document);
    expect(after.events).toEqual(before.events);
  });

  it.each(["missing-version", "mismatched-hash", "non-kb"] as const)("%s 审批不替当前文档提供发布授权", async (kind) => {
    const doc = await document(`unbound-${kind}`);
    const approvalId = await legacy(doc, { status: "pending_review", omitVersion: kind === "missing-version", hash: kind === "mismatched-hash" ? "deadbeef" : undefined, action: kind === "non-kb" ? "test.review-control" : undefined });
    const before = await state(doc);
    const result = await callerA.approvals.decide({ approvalId, gesture: "approve" });
    const after = await state(doc);
    record(`pg-unbound-${kind}`, [`legacy source ${kind}`], ["approve source record"], ["current KB state untouched", "source action cannot grant unbound new publication"], { before, result, after });
    expect(after.document).toEqual(before.document);
    expect(after.events).toEqual(before.events);
  });

  it("跨工作区审批不可见，editedAfter 不能替换不可变事件的文档锚点", async () => {
    const doc = await document("cross-approval");
    const other = await document("other-target", callerB, scopeB);
    const approvalId = await legacy(doc, { status: "pending_review" });
    const beforeOther = await state(other, scopeB);
    const cross = await attempt(() => callerB.approvals.decide({ approvalId, gesture: "approve" }));
    const edited = await callerA.approvals.decide({ approvalId, gesture: "edit", editedAfter: { documentId: other.documentId, version: 99 } });
    const after = await state(doc);
    const afterOther = await state(other, scopeB);
    record("pg-document-anchor", ["approval owned by tenant A", "unrelated document tenant B"], ["tenant B tries decide", "tenant A edits gesture after to foreign document"], ["cross-scope rejected", "immutable source document gets decision", "foreign document unchanged"], { cross, edited, after, beforeOther, afterOther });
    expect(cross.ok).toBe(false);
    expect(after.document?.status).toBe("active");
    expect(afterOther).toEqual(beforeOther);
  });

  it("高危批量守卫、已消费票据标记与过期守卫保持有效", async () => {
    const doc = await document("high-risk");
    const approvalId = await legacy(doc, { status: "pending_review", highRisk: true });
    const before = await state(doc);
    const batch = await callerA.approvals.batchApprove({ approvalIds: [approvalId] });
    const afterBatch = await state(doc);
    const expiredDoc = await document("expired");
    const expiredApproval = await legacy(expiredDoc, { status: "pending_review" });
    await owner!.query("UPDATE approvals SET snapshot=snapshot || $2::jsonb WHERE approval_id=$1", [expiredApproval, JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() })]);
    const expired = await attempt(() => callerA.approvals.decide({ approvalId: expiredApproval, gesture: "approve" }));
    const afterExpired = await state(expiredDoc);
    const consumedDoc = await document("consumed");
    const consumedApproval = await legacy(consumedDoc, { status: "pending_review" });
    await owner!.query("UPDATE approvals SET status='approved',consumed_at='2026-01-01T00:00:00Z',gesture=$2,decided_by=$3,decided_at=now() WHERE approval_id=$1", [consumedApproval, JSON.stringify({ type: "approve", weight: 1 }), identityA.memberNo]);
    const consumptionBefore = await state(consumedDoc);
    const consumedRetry = await callerA.approvals.decide({ approvalId: consumedApproval, gesture: "approve" });
    const consumptionAfter = await state(consumedDoc);
    record("pg-approval-guards", ["high_risk pending", "expired pending", "terminal consumed approval"], ["batchApprove high-risk", "approve expired", "deduped retry consumed"], ["high-risk skipped", "expired not published", "consumed_at not cleared or altered"], { batch, before, afterBatch, expired, afterExpired, consumedRetry, consumptionBefore, consumptionAfter });
    expect(batch.approved).toHaveLength(0);
    expect(batch.skipped[0]?.reason).toContain("高危");
    expect(afterBatch).toEqual(before);
    expect(expired.ok).toBe(false);
    expect(afterExpired.document?.status).toBe("pending_review");
    expect(afterExpired.approvals[0]?.status).toBe("expired");
    expect(consumedRetry.deduped).toBe(true);
    expect(consumptionAfter.approvals[0]?.consumed_at).toEqual(consumptionBefore.approvals[0]?.consumed_at);
    expect(consumptionAfter).toEqual(consumptionBefore);
  });

  it("低危批量审批和 IM 本人回调也经同一事务钩子应用旧发布", async () => {
    const batched = await document("batch");
    const batchApproval = await legacy(batched, { status: "pending_review" });
    const batch = await callerA.approvals.batchApprove({ approvalIds: [batchApproval] });
    const afterBatch = await state(batched);
    const callbackDoc = await document("callback");
    const callbackApproval = await legacy(callbackDoc, { status: "pending_review", channel: "wecom" });
    const callback = await callerA.im.callback({ channel: "wecom", approvalId: callbackApproval, operatorOpenId: `${identityA.memberId}-openid`, conversationId: "kb-fixture", gesture: "approve" });
    const afterCallback = await state(callbackDoc);
    record("pg-multiple-entrypoints", ["low-risk pending publication", "valid mapped operator, unsigned self only"], ["batch approve", "IM callback approve"], ["both documents active", "one gesture per record"], { batch, afterBatch, callback, afterCallback });
    expect(batch.approved).toContain(batchApproval);
    expect(afterBatch.document?.status).toBe("active");
    expect(afterBatch.gestures).toHaveLength(1);
    expect(callback.status).toBe("approved");
    expect(afterCallback.document?.status).toBe("active");
    expect(afterCallback.gestures).toHaveLength(1);
  });

  it("同文档八路发布与 setStatus(active) 并发只产生一份批准和可重放回执", async () => {
    const doc = await document("concurrent-publish");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(() => i === 7 ? callerA.service.kb.setStatus({ documentId: doc.documentId, status: "active" }) : callerA.service.kb.approveDocument({ documentId: doc.documentId }))));
    const after = await state(doc);
    record("pg-concurrent-publication", ["one pending document"], ["7 approveDocument plus 1 setStatus(active) in parallel"], ["all requests succeed", "one non-deduped publication", "same nonempty receipt on each", "one approved row"], { results, after });
    expect(results.every((result) => result.ok)).toBe(true);
    const receipts = results.filter((result) => result.ok).map((result) => (result as { ok: true; value: { deduped: boolean; eventId: string; approvalId: string } }).value);
    expect(receipts.filter((value) => value.deduped === false)).toHaveLength(1);
    expect(new Set(receipts.map((value) => value.eventId)).size).toBe(1);
    expect(new Set(receipts.map((value) => value.approvalId)).size).toBe(1);
    assertPublication(after, doc);
  });

  it("同一遗留审批八路并发只提交一个手势和一个文档状态事件", async () => {
    const doc = await document("concurrent-legacy");
    const approvalId = await legacy(doc, { status: "pending_review" });
    const results = await Promise.all(Array.from({ length: 8 }, () => attempt(() => callerA.approvals.decide({ approvalId, gesture: "approve" }))));
    const after = await state(doc);
    record("pg-concurrent-legacy", ["one pending legacy approval on current revision"], ["8 identical approve decisions in parallel"], ["all succeed", "one fresh decision", "one gesture and one state event", "active document"], { results, after });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.value.deduped)).toHaveLength(1);
    expect(after.document?.status).toBe("active");
    expect(after.gestures).toHaveLength(1);
    expect(after.events.filter((event) => event.after.approvalId === approvalId)).toHaveLength(1);
  });

  it("人工停用后旧已批准回调重放不能重新激活文档", async () => {
    const doc = await document("disabled-replay");
    const approvalId = await legacy(doc, { status: "pending_review" });
    await callerA.approvals.decide({ approvalId, gesture: "approve" });
    await callerA.service.kb.setStatus({ documentId: doc.documentId, status: "disabled" });
    const before = await state(doc);
    const repeated = await callerA.approvals.decide({ approvalId, gesture: "approve" });
    const after = await state(doc);
    record("pg-disable-wins-replay", ["legacy approval terminal approved", "later human disabled document"], ["replay approved callback"], ["deduped", "document remains disabled", "no new event"], { before, repeated, after });
    expect(repeated.deduped).toBe(true);
    expect(after.document?.status).toBe("disabled");
    expect(after).toEqual(before);
  });

  it("并发内容改写保留两个独立版本，未审内容不进入检索", async () => {
    const doc = await document("concurrent-edit");
    await callerA.service.kb.approveDocument({ documentId: doc.documentId });
    const results = await Promise.all(["甲", "乙"].map((suffix) => callerA.service.kb.upsertDocument({ collectionId: doc.collectionId, title: doc.title, contentMd: doc.contentMd + `\n修订 ${suffix}` })));
    const after = await state(doc);
    const pendingSearch = await callerA.service.kb.search({ query: doc.title });
    record("pg-concurrent-revisions", ["published v1"], ["two distinct content edits concurrently", "query KB"], ["versions 2 and 3", "latest content pending_review", "not exposed to search"], { results, after, pendingSearch });
    expect(results.map((r) => r.version).sort()).toEqual([2, 3]);
    expect(after.document).toMatchObject({ version: 3, status: "pending_review" });
    expect(pendingSearch.hits.some((hit) => hit.documentId === doc.documentId)).toBe(false);
  });

  it("发布与内容改写并发时，active 文档必须有同一版本同一哈希的真实批准", async () => {
    const doc = await document("publish-edit-race");
    const results = await Promise.all([
      attempt(() => callerA.service.kb.approveDocument({ documentId: doc.documentId })),
      attempt(() => callerA.service.kb.upsertDocument({ collectionId: doc.collectionId, title: doc.title, contentMd: doc.contentMd + "\n新修订内容。" })),
    ]);
    const after = await state(doc);
    const search = await callerA.service.kb.search({ query: doc.title });
    const currentPublication = after.events.filter((event) => event.action === "kb.publish" && event.after.version === after.document?.version && event.after.hash === after.document?.hash && after.approvals.some((approval) => approval.event_id === event.event_id && approval.status === "approved"));
    record("pg-publication-edit-race", ["pending version 1"], ["publish v1 and upsert changed content concurrently", "inspect current revision receipt and search"], ["both succeed", "active iff current revision has an approved hash receipt", "otherwise pending and hidden from retrieval"], { results, after, search, currentPublication });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(after.document?.version).toBe(2);
    expect(after.document?.status === "active").toBe(currentPublication.length > 0);
    expect(search.hits.some((hit) => hit.documentId === doc.documentId)).toBe(after.document?.status === "active");
  });

  it("所有场景的事件链连续且内容哈希匹配，不因回滚留下孤儿事件", async () => {
    const rows = await owner!.query<{ workspace_id: string; payload: unknown; prev_hash: string; hash: string }>("SELECT workspace_id,payload,prev_hash,hash FROM biz_events WHERE workspace_id=ANY($1) ORDER BY workspace_id,seq", [[scopeA.workspaceId, scopeB.workspaceId]]);
    const tails = new Map<string, string>();
    const mismatches = rows.rows.filter((row) => { const previous = tails.get(row.workspace_id) ?? "GENESIS"; tails.set(row.workspace_id, row.hash); return row.prev_hash !== previous || row.hash !== eventHash(previous, row.payload); });
    record("pg-chain", ["all prior fixtures executed"], ["recompute every event and predecessor"], ["zero mismatches"], { eventCount: rows.rowCount, mismatchCount: mismatches.length });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(mismatches).toHaveLength(0);
  });
});
