/**
 * M2-04 边界值 / 注入式输入
 *
 * 覆盖：空串、超长（500/501）、纯空白、特殊字符与注入式 payload（SQL/模板/emoji）、
 *      缺失参数、非法枚举、跨工作区越权读、分页边界。
 * 复跑：node m2-04-boundaries.mjs
 */
import { SFX, api, ok, loginAll, superQuery, createReport, writeEvidence } from "./lib-m2.mjs";

const r = createReport("M2-04 边界值与注入");
const s = await loginAll();
const created = [];

async function dispatch(body, token = s.owner.token) {
  const res = await api("threads.dispatch", { token, body });
  const d = ok(res);
  if (d?.threadId) created.push(d.threadId);
  return { status: res.status, code: res.data?.error?.data?.code ?? null, data: d, message: String(res.data?.error?.message ?? "").slice(0, 140) };
}

/* ---------- 1. 空串 / 纯空白 / 超长 ---------- */
const empty = await dispatch({ title: "" });
r.check("B1 空标题被拒（400，不建档）", empty.status === 400 && !empty.data, empty);

const blank = await dispatch({ title: "   " });
r.check("B2 纯空白 → 含糊反问（clarify，不盲目建档）", blank.status === 200 && blank.data?.kind === "clarify", blank);

const long500 = "长".repeat(500);
const at500 = await dispatch({ title: long500, runImmediately: true });
r.check("B3 500 字标题可派遣", at500.status === 200 && Boolean(at500.data?.threadId), { status: at500.status, threadId: at500.data?.threadId });
if (at500.data?.threadId) {
  const [row] = await superQuery(`SELECT length(title) AS len FROM threads WHERE id=$1`, [at500.data.threadId]);
  r.check("B4 500 字标题落库未截断", row?.len === 500, row);
}

const at501 = await dispatch({ title: "长".repeat(501) });
r.check("B5 501 字标题被拒（上限 500）", at501.status === 400, { status: at501.status, message: at501.message });

/* ---------- 2. 注入式输入 ---------- */
const sqlPayload = `'; DROP TABLE biz_events; -- 🧨 "双引号" '单引号'`;
const sqlRes = await dispatch({ title: sqlPayload, runImmediately: true });
r.check("B6 SQL 注入式标题不导致 5xx", sqlRes.status === 200, { status: sqlRes.status, threadId: sqlRes.data?.threadId });
const tableAlive = await superQuery(`SELECT count(*)::int AS n FROM biz_events`);
r.check("B7 biz_events 表仍存在且可查（注入未被执行）", (tableAlive[0]?.n ?? 0) > 0, tableAlive[0]);
if (sqlRes.data?.threadId) {
  const [row] = await superQuery(`SELECT title FROM threads WHERE id=$1`, [sqlRes.data.threadId]);
  r.check("B8 注入文本按数据原样落库（无解释/无转义损坏）", row?.title === sqlPayload, { stored: String(row?.title ?? "").slice(0, 60) });
}

const tplPayload = `模板注入 {{7*7}} \${1+1} %{x} <%= 1 %> （${SFX}）`;
const tplRes = await dispatch({ title: tplPayload, runImmediately: true });
if (tplRes.data?.threadId) {
  const [row] = await superQuery(`SELECT title FROM threads WHERE id=$1`, [tplRes.data.threadId]);
  r.check("B9 模板表达式不被求值（原样存储）", row?.title === tplPayload, { stored: String(row?.title ?? "").slice(0, 60) });
}

/* ---------- 3. 审批手势参数边界 ---------- */
const [pendingApproval] = await superQuery(
  `SELECT approval_id FROM approvals WHERE workspace_id='ws-yunqi' AND status='pending' ORDER BY created_at DESC LIMIT 1`,
);
const approvalId = pendingApproval?.approval_id;

const missing = await api("approvals.decide", { token: s.owner.token, body: { gesture: "approve" } });
r.check("B10 缺失 approvalId 被拒（400）", missing.status === 400, { status: missing.status });

const ghost = await api("approvals.decide", { token: s.owner.token, body: { approvalId: `apr-does-not-exist-${SFX}`, gesture: "approve" } });
r.check("B11 不存在的审批单返回可读 400（非 500）", ghost.status === 400 && String(ghost.data?.error?.message ?? "").includes("不存在"), { status: ghost.status, message: String(ghost.data?.error?.message ?? "").slice(0, 80) });

const editNoAfter = await api("approvals.decide", { token: s.owner.token, body: { approvalId, gesture: "edit", editKind: "preference" } });
r.check("B12 edit 手势缺 editedAfter 被拒", editNoAfter.status === 400 && String(editNoAfter.data?.error?.message ?? "").includes("edited_after"), { status: editNoAfter.status, message: String(editNoAfter.data?.error?.message ?? "").slice(0, 90) });

const longReason = await api("approvals.decide", { token: s.owner.token, body: { approvalId, gesture: "reject", reasonEnum: "other", reasonText: "理".repeat(201) } });
r.check("B13 驳回自由文本 >200 字被拒", longReason.status === 400, { status: longReason.status });

const badEditKind = await api("approvals.decide", { token: s.owner.token, body: { approvalId, gesture: "edit", editedAfter: { price: 500 }, editKind: "nonsense" } });
r.check("B14 非法 editKind 被拒（纠错/口味二分白名单）", badEditKind.status === 400, { status: badEditKind.status, message: String(badEditKind.data?.error?.message ?? "").slice(0, 90) });

const badEnum = await api("approvals.decide", { token: s.owner.token, body: { approvalId, gesture: "approve", reasonEnum: `not-in-enum-${SFX}` } });
r.check("B15 未知驳回枚举（approve 携带）不产生脏数据/不 5xx", badEnum.status === 200 || badEnum.status === 400, { status: badEnum.status });

/* ---------- 4. 查询边界 ---------- */
const noThread = await api("threads.get", { input: { threadId: `T-not-exist-${SFX}` }, token: s.owner.token });
r.check("B16 不存在的线程返回 null（非 500）", noThread.status === 200 && ok(noThread) === null, { status: noThread.status, data: ok(noThread) });

const lim0 = await api("threads.events", { input: { threadId: created[0] ?? "T-1", limit: 0 }, token: s.owner.token });
const lim1000 = await api("threads.events", { input: { threadId: created[0] ?? "T-1", limit: 1000 }, token: s.owner.token });
r.check("B17 事件流分页边界（0 / 1000 均被拒）", lim0.status === 400 && lim1000.status === 400, { lim0: lim0.status, lim1000: lim1000.status });

// 跨工作区越权：用 ai-pm 工作区成员的身份读云栖酒店线程（两区同号不同域）
const foreignLogin = await api("auth.loginAs", { body: { workspaceSlug: "ai-pm-demo", memberNo: "MEM-001" } });
const foreignToken = ok(foreignLogin)?.token;
const [ownThread] = await superQuery(`SELECT id FROM threads WHERE workspace_id='ws-yunqi' ORDER BY created_at DESC LIMIT 1`);
const cross = await api("threads.get", { input: { threadId: ownThread?.id }, token: foreignToken });
r.check(
  "B18 跨工作区读线程返回 null（不泄露存在性）",
  cross.status === 200 && ok(cross) === null && Boolean(foreignToken),
  { ownThread: ownThread?.id, foreignToken: Boolean(foreignToken), status: cross.status, data: ok(cross) },
);

/* ---------- 5. IM 入站边界 ---------- */
const tooLong = await api("im.inbound", {
  token: s.manager.token,
  body: { channel: "dingtalk", channelMsgId: `${SFX}-long`, conversationId: "cv", kind: "direct", senderOpenId: "ou-x", text: "长".repeat(2001) },
});
r.check("B19 入站正文 >2000 字被拒", tooLong.status === 400, { status: tooLong.status });

const badChannel = await api("im.inbound", {
  token: s.manager.token,
  body: { channel: "telegram", channelMsgId: `${SFX}-ch`, conversationId: "cv", kind: "direct", senderOpenId: "ou-x", text: "hi" },
});
r.check("B20 非法通道枚举被拒", badChannel.status === 400, { status: badChannel.status });

/* ---------- 6. goalRef 不存在 → fail-closed（按标题规划，不 500） ---------- */
const ghostGoal = await dispatch({ title: `把周五主打款调价 5%（${SFX}-空档案引用）`, goalRef: `no-such-archive-${SFX}`, runImmediately: true });
r.check("B21 不存在的 goalRef fail-closed（按标题继续，不 5xx）", ghostGoal.status === 200, { status: ghostGoal.status, threadId: ghostGoal.data?.threadId });

writeEvidence("m2-04-boundaries.raw.json", { created, sqlRes, tplRes, cross: ok(cross), approvalId });
process.exit(r.finish("m2-04-boundaries.json"));
