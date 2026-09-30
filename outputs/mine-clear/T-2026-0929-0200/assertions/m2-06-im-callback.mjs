/**
 * M2-06 IM 手势回调链路（多通道审批）
 *
 * 覆盖：openid 绑定校验（冒名 403）→ 未验签降级本人放行 → 重复回调幂等
 *      → **IM 通道批准后线程是否被服务端续跑**（与 m2-01 的 UI 路径对照）
 * 复跑：node m2-06-im-callback.mjs
 */
import { SFX, api, ok, loginAll, superQuery, createReport, threadGet, waitFor, writeEvidence } from "./lib-m2.mjs";

const r = createReport("M2-06 IM 手势回调");
const s = await loginAll();
const openid = `ou-m2-${SFX}`;

// 绑定测试用 openid（种子未绑定任何通道 openid；用例结束恢复）
const [before] = await superQuery(`SELECT im_openids FROM members WHERE workspace_id='ws-yunqi' AND member_no='MEM-002'`);
await superQuery(`UPDATE members SET im_openids = COALESCE(im_openids,'{}'::jsonb) || $1::jsonb WHERE workspace_id='ws-yunqi' AND member_no='MEM-002'`, [
  JSON.stringify({ dingtalk: openid }),
]);
r.note("已绑定测试 openid", { member: "MEM-002", channel: "dingtalk", openid, before: before?.im_openids });

/* ---------- 准备一条待审线程（缺基准价 → W-01 人审挂起） ---------- */
const dispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `把年会房型调价 5%（${SFX}-im）`, runImmediately: true } });
const threadId = ok(dispatch)?.threadId;
const thr = threadId ? await threadGet(s.owner.token, threadId) : null;
const approvalId = thr?.pending_approval_id;
r.check("A1 待审线程就绪（pending_review + approvalId）", Boolean(threadId && approvalId), { threadId, approvalId, status: thr?.status });

if (!approvalId) {
  await superQuery(`UPDATE members SET im_openids = $1::jsonb WHERE workspace_id='ws-yunqi' AND member_no='MEM-002'`, [JSON.stringify(before?.im_openids ?? {})]);
  r.finish("m2-06-im-callback.json");
  process.exit(1);
}

const call = (body, token = s.manager.token) => api("im.callback", { token, body });

/* ---------- B. 冒名（未绑定 openid）必须 403 ---------- */
const impostor = await call({ channel: "dingtalk", approvalId, operatorOpenId: "ou-impostor", conversationId: "cv-im-1", gesture: "approve" });
r.check("B1 未验签通道下冒名 openid 被拒（403，P0-1 降级纪律）", impostor.status === 403, { status: impostor.status, message: String(impostor.data?.error?.message ?? "").slice(0, 90) });
const [stillPending] = await superQuery(`SELECT status FROM approvals WHERE approval_id=$1`, [approvalId]);
r.check("B2 冒名被拒后审批未落库", stillPending?.status === "pending", stillPending);

/* ---------- C. 本人手势放行（未验签降级路径） ---------- */
const approve = await call({ channel: "dingtalk", approvalId, operatorOpenId: openid, conversationId: "cv-im-1", gesture: "approve", reasonText: `${SFX}-IM 采纳` });
r.check("C1 本人 IM 手势放行成功（unsigned 标注）", approve.status === 200 && ok(approve)?.status === "approved", ok(approve));

const dup = await call({ channel: "dingtalk", approvalId, operatorOpenId: openid, conversationId: "cv-im-1", gesture: "approve" });
r.check("C2 重复回调幂等（deduped=true）", ok(dup)?.deduped === true, ok(dup));

const gestureEvents = await superQuery(
  `SELECT count(*)::int AS n FROM biz_events WHERE workspace_id='ws-yunqi'
     AND payload->'decision'->>'action'='approval.gesture' AND payload->'decision'->'after'->>'approvalId'=$1`,
  [approvalId],
);
r.check("C3 手势事件只有一条（重复回调不重复入账）", gestureEvents[0]?.n === 1, gestureEvents[0]);

/* ---------- D. IM 批准后：线程是否被服务端续跑 ---------- */
const stall = await waitFor(async () => {
  const t = await threadGet(s.owner.token, threadId);
  return { ok: t?.status !== "pending_review", status: t?.status, progress_done: t?.progress_done, progress_total: t?.progress_total };
}, { timeoutMs: 21_000, intervalMs: 3_000 });
r.check(
  "D1 IM 通道批准后线程自动续跑（21s 内离开 pending_review）",
  stall.ok,
  { observed: stall.last, waitedMs: stall.waitedMs, note: stall.ok ? "已续跑" : "IM 批准后线程仍停在 pending_review：手机端批了，任务不会动（无服务端续跑出口）" },
);

// 收尾：恢复绑定
await superQuery(`UPDATE members SET im_openids = $1::jsonb WHERE workspace_id='ws-yunqi' AND member_no='MEM-002'`, [JSON.stringify(before?.im_openids ?? {})]);
const [after] = await superQuery(`SELECT im_openids FROM members WHERE workspace_id='ws-yunqi' AND member_no='MEM-002'`);
r.check("E1 用例环境已恢复（openid 绑定还原）", JSON.stringify(after?.im_openids ?? {}) === JSON.stringify(before?.im_openids ?? {}), { after: after?.im_openids });

writeEvidence("m2-06-im-callback.raw.json", { threadId, approvalId, approve: ok(approve), dup: ok(dup), stall });
process.exit(r.finish("m2-06-im-callback.json"));
