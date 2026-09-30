#!/usr/bin/env node
/**
 * M3 联动排雷 · 探针 2：知识库文档「待审 → 生效」的状态投影保真度
 * （MCD v1.0 模板④；任务卡 T-2026-0929-0200）
 *
 * 真机制造状态变更：kb.upsertDocument（pending_review）→ kb.approveDocument（active）
 * 逐面取证：
 *   F1 service.kb.pendingReviews / listDocuments  （P22 待审区）
 *   F2 service.kb.search                          （检索索引面）
 *   F3 approvals.list                             （P4 审批台；P22 承诺"审批记录会同步进入审批中心"）
 *   F4 C 端 /c/chat                               （客户问答面：检索范围随文档状态变化）
 *   F5 approvals.decide(reject) 之后的矛盾面        （审批台 vs 知识库状态）
 * 用法：node .../m3-linkage-kb.mjs    （服务端须以出厂 .env 起在 MCD_BASE）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "evidence");
const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8899";
const WS_SLUG = process.env.MCD_WS ?? "ai-pm-demo";
const MEMBER_NO = process.env.MCD_MEMBER ?? "MEM-001";
const GW_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:<redacted>@127.0.0.1:5432/workloom";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:<redacted>@127.0.0.1:5432/workloom";
const MARK = `M3KB${Date.now()}`;
const DOC_TITLE = `M3 联动探针知识条目 ${MARK}`;
const DOC_BODY = [
  `# ${DOC_TITLE}`,
  "",
  `本条目由 M3 联动探针写入（标记 ${MARK}）。`,
  "",
  "- 探针口令：北极星布草协议",
  "- 布草更换周期：72 小时",
  "- 生效范围：仅用于排雷证据取证，不属于经营数据",
].join("\n");

const out = {
  probe: "m3-kb-linkage", started_at: new Date().toISOString(),
  base: BASE, workspaceSlug: WS_SLUG, memberNo: MEMBER_NO, mark: MARK, assertions: [],
};
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

/* ---------- 登录（B 端） ---------- */
const login = await api("/trpc/auth.loginAs", { method: "POST", body: { workspaceSlug: WS_SLUG, memberNo: MEMBER_NO } });
const token = unwrap(login)?.token;
check("B 端登录", Boolean(token), unwrap(login)?.identity?.workspaceId);

/* ---------- C 端会话（同一服务进程的公开网关） ---------- */
const sess = await api("/c/session", { method: "POST", body: { channel: "h5", openid: `m3-probe-${MARK}`, nickname: "M3 探针客户" } });
const cToken = sess.data?.token;
out.c_session = { status: sess.status, user: sess.data?.user ?? null, error: sess.data?.error ?? null };
check("C 端会话建立（h5 演示直登）", Boolean(cToken), { status: sess.status, error: sess.data?.error });

async function cChat(text, conversationId) {
  return api("/c/chat", { method: "POST", token: cToken, body: { conversationId, text } });
}
const convId = `conv-m3-${MARK}`;

const collections = unwrap(await q("/trpc/service.kb.listCollections", token))?.collections ?? [];
const collectionId = collections[0]?.id ?? null;
check("存在知识集可挂载探针文档", Boolean(collectionId), { collections: collections.map((c) => c.name).slice(0, 5) });

const docsBefore = unwrap(await q("/trpc/service.kb.listDocuments", token))?.documents?.length ?? null;
const pendingBefore = unwrap(await q("/trpc/service.kb.pendingReviews", token))?.documents?.length ?? null;
const approvalsBefore = unwrap(await q("/trpc/approvals.list", token, { status: "pending" })) ?? [];
/**
 * 检索判据用**每次运行唯一的 MARK**（而不是固定口令）：固定口令会被历史探针文档污染
 * （2026-09-30 批 E 实测：前一版探针留下的 active 文档让"变更前不可检索"恒为假红）。
 */
const search0 = unwrap(await q("/trpc/service.kb.search", token, { query: MARK, limit: 5 }))?.hits ?? [];
out.before = { docsBefore, pendingBefore, approvals: approvalsBefore.length, searchHits: search0.length };
check("探针口令在变更前不可检索（基线）", search0.length === 0, { hits: search0.length });

const chat0 = await cChat("布草更换周期是多久？", convId);
out.chat_before = { status: chat0.status, data: chat0.data };

/* ---------- 变更 1：上传文档（pending_review，按设计不入索引） ---------- */
const up = await api("/trpc/service.kb.upsertDocument", {
  method: "POST", token,
  body: { collectionId, title: DOC_TITLE, sourceKind: "manual", contentMd: DOC_BODY },
});
const upData = unwrap(up);
const documentId = upData?.documentId;
check("上传返回 documentId", Boolean(documentId), upData);
out.upload = upData;

const docsAfterUpload = unwrap(await q("/trpc/service.kb.listDocuments", token))?.documents ?? [];
const docRow = docsAfterUpload.find((d) => d.id === documentId) ?? null;
check("新文档落 pending_review", docRow?.status === "pending_review", { status: docRow?.status, version: docRow?.version });

const pendingAfterUpload = unwrap(await q("/trpc/service.kb.pendingReviews", token))?.documents ?? [];
check("待审区可见新文档", pendingAfterUpload.some((d) => d.id === documentId), { pending: pendingAfterUpload.length });

const search1 = unwrap(await q("/trpc/service.kb.search", token, { query: MARK, limit: 5 }))?.hits ?? [];
check("待审文档不入检索索引（承诺口径）", search1.length === 0, { hits: search1.length });

const approvalsAfterUpload = unwrap(await q("/trpc/approvals.list", token, { status: "pending" })) ?? [];
check("上传动作不产生 pending 审批（变更前对照）", approvalsAfterUpload.length === approvalsBefore.length,
  { before: approvalsBefore.length, after: approvalsAfterUpload.length });

/* ---------- 变更 2：待审区批准生效（approveDocument） ---------- */
const appr = await api("/trpc/service.kb.approveDocument", { method: "POST", token, body: { documentId } });
const apprData = unwrap(appr);
out.approve_document = { status: appr.status, data: apprData };
check("approveDocument 成功", apprData?.ok === true, apprData);

const docsAfterApprove = unwrap(await q("/trpc/service.kb.listDocuments", token))?.documents ?? [];
const docRow2 = docsAfterApprove.find((d) => d.id === documentId) ?? null;
check("文档状态 → active", docRow2?.status === "active", { status: docRow2?.status });

const search2 = unwrap(await q("/trpc/service.kb.search", token, { query: MARK, limit: 5 }))?.hits ?? [];
check("生效后可检索（索引面联动）", search2.length > 0, { hits: search2.length, first: search2[0]?.documentTitle });

const pendingAfterApprove = unwrap(await q("/trpc/service.kb.pendingReviews", token))?.documents ?? [];
check("待审区已移除该文档", !pendingAfterApprove.some((d) => d.id === documentId), { pending: pendingAfterApprove.length });

/* ---------- F3：审批台面（P22 承诺「审批记录会同步进入审批中心」） ----------
 * MC-110 修复后口径：待审区「批准生效」= 逐条人审动作本身，审批行与生效同事务落库且**直接 approved**
 * （带 decided_by/decided_at/gesture）；修复前的「pending + 已生效」幽灵条目必须消失。
 */
const approvalsAll = unwrap(await q("/trpc/approvals.list", token)) ?? [];
const publishRecord = approvalsAll.find((a) => (a.event?.decision?.action ?? "") === "kb.publish"
  && a.event?.object?.id === documentId) ?? null;
const approvalsPendingAfterApprove = unwrap(await q("/trpc/approvals.list", token, { status: "pending" })) ?? [];
out.approval_after_approve = { total: approvalsAll.length, record: publishRecord, pending: approvalsPendingAfterApprove.length };
check("审批中心出现 kb.publish 记录（承诺联动）", Boolean(publishRecord), { record: publishRecord && {
  approval_id: publishRecord.approval_id, status: publishRecord.status, decided_by: publishRecord.decided_by } });
check("记录为已裁决（approved + 决策人）：不存在「动作已执行却待办」的幽灵条目",
  publishRecord?.status === "approved" && Boolean(publishRecord?.decided_by),
  { status: publishRecord?.status, decided_by: publishRecord?.decided_by });
check("待审列表不含该文档（幽灵待办消失）",
  !approvalsPendingAfterApprove.some((a) => a.event?.object?.id === documentId),
  { pending: approvalsPendingAfterApprove.length });

/* ---------- F4：C 端问答面 ---------- */
const chat1 = await cChat("布草更换周期是多久？", convId);
out.chat_after = { status: chat1.status, data: chat1.data };
const answer1 = String(chat1.data?.answer ?? "");
check("C 端问答能引用生效后的知识（问答入口数据源覆盖）", answer1.includes("72"), { answer: answer1.slice(0, 200) });

/* ---------- F5：终态记录不可被"事后驳回"改坏两个面（原断点：驳回不回滚） ----------
 * 现在该审批已是终态：再次 decide 应幂等（deduped），文档与检索面不受影响；
 * 「存量 pending kb.publish 行被驳回 → 文档退回待审并退出检索」由 f1-kb-publish-gate.mjs 专项覆盖。
 */
let rejectResult = null;
if (publishRecord?.approval_id) {
  const rej = await api("/trpc/approvals.decide", {
    method: "POST", token,
    body: { approvalId: publishRecord.approval_id, gesture: "reject", reasonEnum: "other", reasonText: "M3 探针：验证终态审批幂等（文档已生效）" },
  });
  rejectResult = { status: rej.status, data: unwrap(rej) };
}
out.reject = rejectResult;

const docRow3 = (unwrap(await q("/trpc/service.kb.listDocuments", token))?.documents ?? []).find((d) => d.id === documentId) ?? null;
const search3 = unwrap(await q("/trpc/service.kb.search", token, { query: MARK, limit: 5 }))?.hits ?? [];
out.after_reject = { doc_status: docRow3?.status, search_hits: search3.length, decide: rejectResult?.data };
check("终态审批重复裁决幂等（deduped），知识库/检索面不被改坏",
  rejectResult?.data?.deduped === true && docRow3?.status === "active" && search3.length > 0,
  { approval: rejectResult?.data?.status, deduped: rejectResult?.data?.deduped, doc: docRow3?.status, hits: search3.length });

/* ---------- 事实源直查（gateway 池） ---------- */
const gw = new pg.Client({ connectionString: GW_URL });
await gw.connect();
try {
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi"]);
  const ev = await gw.query(
    `SELECT payload->'decision'->>'action' AS action, payload->'who'->>'id' AS actor, event_id, created_at
       FROM biz_events WHERE payload->'object'->>'id'=$1 ORDER BY seq`, [documentId]);
  const ap = await gw.query(
    `SELECT approval_id, status, decided_by, snapshot FROM approvals WHERE workspace_id=$1
      AND event_id IN (SELECT event_id FROM biz_events WHERE payload->'object'->>'id'=$2)`,
    [WS_SLUG === "ai-pm-demo" ? "ws-aipm-demo" : "ws-yunqi", documentId]);
  await gw.query("COMMIT");
  out.db = { events: ev.rows, approvals: ap.rows };
} finally { await gw.end().catch(() => {}); }

mkdirSync(EVIDENCE, { recursive: true });
const file = join(EVIDENCE, `m3-kb-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
const failed = out.assertions.filter((a) => !a.ok);
console.log(`\n联动探针 2：${out.assertions.length - failed.length}/${out.assertions.length} 通过；证据 → ${file}`);
