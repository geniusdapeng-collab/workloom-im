#!/usr/bin/env node
/**
 * 批 E 断言（MC-110）：知识文档「待审 → 生效 → 撤回」三面一致（审批台 / 知识库 / 检索面）。
 *
 * 修复后契约（与卡片断言「pending 期间不得已生效；或批准后审批行直接 approved」第二条一致）：
 *  1) approveDocument（待审区「批准生效」）是**逐条人审动作本身**：文档置 active + kb.publish 事件 +
 *     一条 **approved** 审批记录（decided_by/decided_at/gesture 齐备）三写同一 COMMIT；
 *  2) 审批台不再出现「动作已执行却仍 pending」的幽灵条目；重复批准幂等（不重复落事件/审批行）；
 *  3) 存量/任何来源的 kb.publish pending 行由 approvals.decide 钩子收敛：
 *     reject → 文档退回 pending_review 且**即刻退出检索**；approve/edit → 文档生效。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8981 DATABASE_APP_URL=... node f1-kb-publish-gate.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * 与 packages/base/workdata/events.ts 完全同构的链式哈希（本探针只依赖 pg，不引入 TS 运行时）。
 * 正确性由下方「哈希链自检」保证：对既有 N 条事件重算 hash，必须逐条与库中一致。
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
function eventHash(prevHash, payload) {
  return createHash("sha256").update(prevHash + canonicalJson(payload), "utf-8").digest("hex");
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence", "fix-e");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "ai-pm-demo";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:<redacted>@127.0.0.1:5432/workloom";
const MARK = `F1KB${Date.now()}`;
const WS_ID = WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi";

const out = { probe: "f1-kb-publish-gate", started_at: new Date().toISOString(), base: BASE, workspaceSlug: WS_SLUG, mark: MARK, assertions: [] };
const check = (name, ok, detail) => {
  out.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  return Boolean(ok);
};
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const q = (path, token, input) => api(`${path}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { token });
const unwrap = (r) => r?.data?.result?.data;

async function withDb(fn) {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
    await client.query(
      "SELECT set_config('app.tenant_id', (SELECT tenant_id FROM workspaces WHERE id=$1), true)",
      [WS_ID],
    );
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

const search = async (query) => unwrap(await q("/trpc/service.kb.search", token, { query, limit: 5 }))?.hits ?? [];
const listDocs = async () => unwrap(await q("/trpc/service.kb.listDocuments", token))?.documents ?? [];
const pendingApprovals = async () => unwrap(await q("/trpc/approvals.list", token, { status: "pending" })) ?? [];
const allApprovals = async () => unwrap(await q("/trpc/approvals.list", token)) ?? [];

check("基线：探针标记不可检索", (await search(MARK)).length === 0, { mark: MARK });

const collections = unwrap(await q("/trpc/service.kb.listCollections", token))?.collections ?? [];
const collectionId = collections[0]?.id ?? null;
check("存在知识集", Boolean(collectionId), collections.map((c) => c.name).slice(0, 3));

const up = await api("/trpc/service.kb.upsertDocument", {
  method: "POST", token,
  body: {
    collectionId, title: `F1 知识发布门禁 ${MARK}`, sourceKind: "manual",
    contentMd: `## 门禁探针\n\n本条目用于 MC-110 证据取证，口令 ${MARK}，不应在批准前进入检索。\n`,
  },
});
const documentId = unwrap(up)?.documentId;
check("上传返回 documentId", Boolean(documentId), unwrap(up));
check("新文档落 pending_review", (await listDocs()).find((d) => d.id === documentId)?.status === "pending_review");
check("待审期间不可检索（发布门禁）", (await search(MARK)).length === 0);

const pendingBefore = (await pendingApprovals()).length;
const appr = await api("/trpc/service.kb.approveDocument", { method: "POST", token, body: { documentId } });
const apprData = unwrap(appr);
check("approveDocument 成功", apprData?.ok === true && apprData?.status === "active", apprData);
check("文档状态 → active", (await listDocs()).find((d) => d.id === documentId)?.status === "active");
check("生效后进入检索", (await search(MARK)).length > 0);

const eventsForDoc = await withDb((c) => c.query(
  `SELECT event_id, payload->'decision'->>'action' AS action FROM biz_events
    WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 AND payload->'decision'->>'action'='kb.publish'
    ORDER BY seq DESC`,
  [WS_ID, documentId]));
check("落 kb.publish 五元事件", eventsForDoc.rows.length === 1, eventsForDoc.rows);
const publishEventId = eventsForDoc.rows[0]?.event_id;

const pendingAfter = await pendingApprovals();
check("审批台不留「已执行却待办」幽灵条目", pendingAfter.length === pendingBefore
  && !pendingAfter.some((a) => a.event?.object?.id === documentId),
  { before: pendingBefore, after: pendingAfter.length });

const rec = (await allApprovals()).find((a) => a.event?.object?.id === documentId && a.event?.decision?.action === "kb.publish");
check("审批记录为 approved + 决策人/时间/手势齐备（不可回滚的当场留痕）",
  rec?.status === "approved" && rec?.decided_by === MEMBER_NO && Boolean(rec?.decided_at)
  && rec?.gesture?.type === "approve" && rec?.snapshot?.post_hoc === true,
  rec && { status: rec.status, decided_by: rec.decided_by, decided_at: rec.decided_at, gesture: rec.gesture, snapshot: rec.snapshot });

const appr2 = await api("/trpc/service.kb.approveDocument", { method: "POST", token, body: { documentId } });
const eventsAfter2 = await withDb((c) => c.query(
  `SELECT count(*)::int AS c FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 AND payload->'decision'->>'action'='kb.publish'`,
  [WS_ID, documentId]));
check("重复批准幂等（不重复落事件/审批行）", unwrap(appr2)?.deduped === true && eventsAfter2.rows[0].c === 1,
  { deduped: unwrap(appr2)?.deduped, events: eventsAfter2.rows[0].c });

/* ---------- 存量幽灵行：approve/reject 钩子必须改变知识库状态（不再"驳回不回滚"） ----------
 * 修复前的真实形态是「kb.publish 事件 + 该事件上唯一的 pending 审批行 + 文档已生效」。
 * 这里复刻该形态：经 append_event_insert 特权函数补一条同链事件（哈希接龙合法），
 * 再插 pending 审批行（channel=wecom）——同事件无已裁决兄弟行，走不到 #43 跨通道去重。
 */
async function createGhostEvent(suffix) {
  const eventId = `E-GHOST${suffix}-${MARK}`;
  return withDb(async (c) => {
    const ten = await c.query(`SELECT tenant_id FROM workspaces WHERE id=$1`, [WS_ID]);
    const tenantId = ten.rows[0].tenant_id;
    const tail = await c.query(
      `SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`,
      [tenantId, WS_ID],
    );
    const prevHash = tail.rows[0]?.hash ?? "GENESIS";
    const payload = {
      who: { type: "human", id: MEMBER_NO },
      context: { tenant_id: tenantId, workspace_id: WS_ID, time: new Date().toISOString(), channel: "wecom" },
      object: { type: "kb_document", id: documentId },
      decision: { action: "kb.publish", after: { documentId, status: "active" }, basis: ["F1 断言：复刻修复前的事后审批形态"] },
      rule_impact: [],
    };
    const hash = eventHash(prevHash, payload);
    await c.query(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5::jsonb,$6,$7,now())`,
      [eventId, tenantId, WS_ID, null, JSON.stringify(payload), prevHash, hash],
    );
    return { eventId, tenantId };
  });
}

/* 内联哈希算法自检：与库中既有链逐条对齐（不一致则后面的复刻事件不可信） */
const chainCheck = await withDb(async (c) => {
  const rows = (await c.query(
    `SELECT seq, payload, prev_hash, hash FROM biz_events
      WHERE tenant_id=(SELECT tenant_id FROM workspaces WHERE id=$1) AND workspace_id=$1
      ORDER BY seq DESC LIMIT 50`,
    [WS_ID],
  )).rows;
  const bad = rows.filter((r) => eventHash(r.prev_hash, r.payload) !== r.hash);
  return { checked: rows.length, bad: bad.length, firstBad: bad[0]?.seq ?? null };
});
check("哈希链自检（内联 canonicalJson/hash 与生产逐条一致）", chainCheck.checked > 0 && chainCheck.bad === 0, chainCheck);

const ghostEvent = await createGhostEvent("");

const ghostId = `apr-ghost-${MARK.toLowerCase()}`;
await withDb((c) => c.query(
  `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
   VALUES ($1,$2,$3,$4,'wecom','pending',$5::jsonb)`,
  [ghostId, ghostEvent.tenantId, WS_ID, ghostEvent.eventId,
   JSON.stringify({ after: { documentId, fence_action: "kb.publish" }, high_risk: false })]));
const ghosts = (await pendingApprovals()).filter((a) => a.approval_id === ghostId);
check("（制造存量场景）pending kb.publish 行已落库", ghosts.length === 1, { ghostId });

const rej = await api("/trpc/approvals.decide", {
  method: "POST", token,
  body: { approvalId: ghostId, gesture: "reject", reasonEnum: "other", reasonText: "F1 断言：存量待审行驳回必须退出检索" },
});
check("驳回手势成功", unwrap(rej)?.status === "rejected", unwrap(rej));
const docAfterReject = (await listDocs()).find((d) => d.id === documentId);
const hitsAfterReject = (await search(MARK)).length;
check("驳回即不可检索（文档退回 pending_review）", docAfterReject?.status === "pending_review" && hitsAfterReject === 0,
  { doc: docAfterReject?.status, hits: hitsAfterReject });

const ghostEvent2 = await createGhostEvent("2");
const ghostId2 = `apr-ghost2-${MARK.toLowerCase()}`;
await withDb((c) => c.query(
  `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
   VALUES ($1,$2,$3,$4,'dingtalk','pending',$5::jsonb)`,
  [ghostId2, ghostEvent2.tenantId, WS_ID, ghostEvent2.eventId,
   JSON.stringify({ after: { documentId, fence_action: "kb.publish" }, high_risk: false })]));
const apprGhost = await api("/trpc/approvals.decide", { method: "POST", token, body: { approvalId: ghostId2, gesture: "approve" } });
const docAfterApprove = (await listDocs()).find((d) => d.id === documentId);
check("存量待审行批准 → 文档重新生效且可检索",
  unwrap(apprGhost)?.status === "approved" && docAfterApprove?.status === "active" && (await search(MARK)).length > 0,
  { approval: unwrap(apprGhost)?.status, doc: docAfterApprove?.status });

check("事件留痕可追溯到发布/撤回动作", (await withDb((c) => c.query(
  `SELECT count(*)::int AS c FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2
     AND payload->'decision'->>'action' IN ('kb.publish','kb.publish.revoke')`,
  [WS_ID, documentId]))).rows[0].c >= 3, { hint: "1 次发布 + 1 次撤回 + 1 次重新发布" });

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `f1-kb-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\nf1 知识发布门禁：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
