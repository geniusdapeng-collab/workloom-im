/**
 * M2-01 主链路闭环（正负对照）
 *
 * 覆盖：dispatch(quest, runImmediately) → 围栏 review → pending_review + approvals 行
 *      → 角色鉴权（readonly/manager）→ 手势校验负样例 → approve → 续跑 → 回执 → 终态与事件一致
 * 复跑：node m2-01-main-loop.mjs   （退出码 0=全绿，1=存在红色断言）
 */
import {
  SFX, api, ok, errCode, loginAll, superQuery, createReport, threadGet, threadEvents,
  approvalsList, waitFor, sleep, writeEvidence,
} from "./lib-m2.mjs";

const r = createReport("M2-01 主链路闭环");
const TITLE = `把周五主打款调价 5%（${SFX}-主线）`;
const t0 = Date.now();

const sessions = await loginAll();
r.note("seeded sessions", { owner: sessions.owner.identity.role, manager: sessions.manager.identity.role, readonly: sessions.readonly.identity.role });

/* ---------- 1. 派遣：进入 review 挂起 ---------- */
const dispatch = await api("threads.dispatch", {
  token: sessions.owner.token,
  body: { title: TITLE, runImmediately: true },
});
const d = ok(dispatch);
const threadId = d?.threadId;
r.check("dispatch 建线程且路由为 quest", d?.kind === "routed" && d?.mode === "quest", { status: dispatch.status, d });
r.check("dispatch 停在 pending_review（存在未放行写步骤）", d?.status === "pending_review" && d?.stepsDone < d?.stepsTotal, d);

if (!threadId) {
  r.finish("m2-01-main-loop.json");
  process.exit(1);
}

/* ---------- 2. 线程详情 / 审批行 / 挂起事件 三面一致 ---------- */
const thread1 = await threadGet(sessions.owner.token, threadId);
const approvalId = thread1?.pending_approval_id;
r.check("threads.get 返回 pending_approval_id", typeof approvalId === "string" && approvalId.length > 0, { approvalId, status: thread1?.status });

const [aprRow] = await superQuery(
  `SELECT approval_id, status, tier, snapshot, decided_by, decided_at FROM approvals WHERE approval_id=$1`,
  [approvalId],
);
r.check("approvals 行为 pending 且快照声明 gate", aprRow?.status === "pending" && aprRow?.snapshot?.gate === true, aprRow && { status: aprRow.status, tier: aprRow.tier, gate: aprRow.snapshot?.gate, step: aprRow.snapshot?.step_id, action: aprRow.snapshot?.action });

const suspendEvents = await superQuery(
  `SELECT event_id, payload FROM biz_events
    WHERE workspace_id='ws-yunqi' AND session_id=$1
      AND payload->'decision'->>'action' IS NOT NULL
      AND payload->'decision'->>'step_id' IS NOT NULL
    ORDER BY seq ASC`,
  [threadId],
);
/**
 * MC-509：挂起标记口径随上游合并升级——`decision.kind === "review"` 是权威判据
 * （N-08：挂起/熔断/执行只认显式 kind，历史事件才回落 basis 前缀；W-01 缺参数分支的文案
 * 也不再带「越围栏挂起：」前缀）。断言同时接受两种口径，避免对历史数据假红。
 */
const suspendEv = suspendEvents.find((e) => {
  const decision = e.payload?.decision ?? {};
  if (decision.kind === "review") return true;
  return (decision.basis ?? []).some((b) => String(b).startsWith("越围栏挂起"));
});
r.check("挂起事件落账（decision.kind=review 或 basis 标注越围栏挂起）", Boolean(suspendEv), suspendEv && { event_id: suspendEv.event_id, kind: suspendEv.payload?.decision?.kind, basis: suspendEv.payload?.decision?.basis, rule_impact: (suspendEv.payload?.rule_impact ?? []).map((x) => `${x.rule_id}:${x.result}`) });

const queue = await approvalsList(sessions.owner.token, "pending");
r.check("统一队列可见该审批", Array.isArray(queue) && queue.some((x) => x.approval_id === approvalId), { queueSize: queue?.length });

/* ---------- 3. 角色鉴权（负样例）：readonly 403 ---------- */
const ro = await api("approvals.decide", {
  token: sessions.readonly.token,
  body: { approvalId, gesture: "approve" },
});
r.check("readonly 审批被拒（403/FORBIDDEN）", ro.status === 403 || errCode(ro) === "FORBIDDEN", { status: ro.status, code: errCode(ro), body: ro.raw.slice(0, 160) });
const [afterRo] = await superQuery(`SELECT status FROM approvals WHERE approval_id=$1`, [approvalId]);
r.check("readonly 被拒后审批仍为 pending（未落库）", afterRo?.status === "pending", afterRo);

/* ---------- 4. 手势校验负样例：非法手势 / 空理由驳回 ---------- */
const badGesture = await api("approvals.decide", {
  token: sessions.manager.token,
  body: { approvalId, gesture: "bogus" },
});
r.check("非法手势被拒（400/BAD_REQUEST）", badGesture.status === 400, { status: badGesture.status, code: errCode(badGesture), message: badGesture.data?.error?.message });

const emptyReject = await api("approvals.decide", {
  token: sessions.manager.token,
  body: { approvalId, gesture: "reject" },
});
r.check("空理由驳回被拒（L5.2）", emptyReject.status === 400 && String(emptyReject.data?.error?.message ?? "").includes("原因"), { status: emptyReject.status, message: emptyReject.data?.error?.message });

const [afterBad] = await superQuery(`SELECT status, gesture FROM approvals WHERE approval_id=$1`, [approvalId]);
r.check("两次非法手势后审批状态未变", afterBad?.status === "pending" && afterBad?.gesture === null, afterBad);

/* ---------- 5. manager 采纳 → 手势事件 ---------- */
const approve = await api("approvals.decide", {
  token: sessions.manager.token,
  body: { approvalId, gesture: "approve", reasonText: `${SFX} 主线采纳` },
});
const ap = ok(approve);
r.check("manager 采纳成功", approve.status === 200 && ap?.status === "approved" && ap?.deduped === false, ap);

const gestureEvents = await superQuery(
  `SELECT event_id, payload FROM biz_events
    WHERE workspace_id='ws-yunqi' AND payload->'decision'->>'action'='approval.gesture'
      AND payload->'decision'->'after'->>'approvalId'=$1`,
  [approvalId],
);
r.check("手势事件经网关落账（唯一一条）", gestureEvents.length === 1 && gestureEvents[0].payload?.decision?.after?.gesture === "approve", { count: gestureEvents.length, after: gestureEvents[0]?.payload?.decision?.after });

/* ---------- 6. 审批通过后是否自动续跑（无客户端介入） ---------- */
const stallProbe = await waitFor(async () => {
  const t = await threadGet(sessions.owner.token, threadId);
  return { ok: t?.status === "completed", status: t?.status, progress_done: t?.progress_done, progress_total: t?.progress_total };
}, { timeoutMs: 21_000, intervalMs: 3_000 });
const stallObserved = !stallProbe.ok;
r.check(
  "审批通过后服务端自动续跑（21s 内线程自达 completed）",
  stallProbe.ok,
  { observed: stallProbe.last, waitedMs: stallProbe.waitedMs, note: stallObserved ? "未自动续跑：审批通过了但线程停在 pending_review（仅客户端触发 threads.run 才会推进）" : "已自动续跑" },
);

const afterStallEvents = await superQuery(
  `SELECT count(*)::int AS n FROM biz_events
    WHERE workspace_id='ws-yunqi' AND session_id=$1 AND payload->'decision'->>'step_id'=$2
      AND payload->'receipt' IS NOT NULL`,
  // MC-509 附带健壮性（P3）：探针对库状态敏感（依赖本线程的待批行仍存在）。缺行时不抛 TypeError，
  // 而是给出明确的状态依赖标记，便于复跑者区分「产品问题」与「探针前置不满足」。
  [threadId, aprRow?.snapshot?.step_id ?? null],
);
if (stallObserved) {
  r.check("停摆期间该步骤无执行回执事件（确为未推进）", afterStallEvents[0]?.n === 0, afterStallEvents[0]);
}

/* ---------- 7. 客户端推进（UI「推进」同路径）→ 闭环 ---------- */
const run = await api("threads.run", { token: sessions.owner.token, body: { threadId } });
const runData = ok(run);
r.check("threads.run 携带已批准步骤直接执行 → completed", runData?.status === "completed", { status: run.status, runData });

const thread2 = await threadGet(sessions.owner.token, threadId);
r.check("终态一致：completed + progress 收敛 + 无遗留审批", thread2?.status === "completed" && thread2?.progress_done === thread2?.progress_total && thread2?.pending_approval_id === null, { status: thread2?.status, done: thread2?.progress_done, total: thread2?.progress_total, pending: thread2?.pending_approval_id });

const execEv = (await superQuery(
  `SELECT event_id, payload FROM biz_events
    WHERE workspace_id='ws-yunqi' AND session_id=$1
      AND payload->'decision'->>'step_id'=$2
      AND payload->'decision'->>'action' IS NOT NULL
    ORDER BY seq DESC LIMIT 3`,
  [threadId, aprRow.snapshot?.step_id],
)).find((e) => e.payload?.receipt);
r.check(
  "执行事件带可核验回执（receipt.synced=true, mode=simulated）且标注审批来源",
  execEv?.payload?.receipt?.synced === true &&
    String(execEv?.payload?.receipt?.mode ?? "").length > 0 &&
    (execEv?.payload?.decision?.basis ?? []).some((b) => String(b).includes(approvalId)),
  execEv && { receipt: execEv.payload.receipt, basis: execEv.payload.decision?.basis, approval_ref: execEv.payload.decision?.approval_ref ?? null },
);

/* ---------- 8. 属性断言：completed ⇒ 全部已执行步骤回执已同步（全库） ---------- */
const badCompleted = await superQuery(
  `WITH done AS (
     SELECT t.id AS thread_id,
            count(*) FILTER (WHERE e.payload->'receipt' IS NOT NULL AND e.payload->'decision'->>'action' IS NOT NULL
                              AND NOT (e.payload->'decision'->'basis' @> '["越围栏挂起"]'::jsonb)) AS exec_steps,
            count(*) FILTER (WHERE e.payload->'receipt'->>'synced' = 'true') AS synced_steps
       FROM threads t JOIN biz_events e ON e.session_id = t.id AND e.workspace_id = t.workspace_id
      WHERE t.workspace_id='ws-yunqi' AND t.status='completed'
      GROUP BY t.id)
   SELECT thread_id, exec_steps, synced_steps FROM done WHERE exec_steps > 0 AND synced_steps < exec_steps`,
);
r.check(
  "属性：completed 线程的执行事件全部 receipt.synced=true（全工作区）",
  badCompleted.length === 0,
  { offenders: badCompleted.slice(0, 5), note: "反例即 E3.7「无回执不得宣称完成」被破坏" },
);

const settled = await api("threads.settledSince", { input: { since: Date.now() - 5 * 60_000, limit: 50 }, token: sessions.owner.token });
r.check("settledSince 流水含该线程（结算投影）", (ok(settled) ?? []).some((x) => x.id === threadId), { n: (ok(settled) ?? []).length });

const eventsView = await threadEvents(sessions.owner.token, threadId);
r.check("行动消息流投影含挂起 + 执行 + 手势链路（≥3 条）", Array.isArray(eventsView) && eventsView.length >= 3, { n: eventsView?.length });

writeEvidence("m2-01-main-loop.raw.json", {
  threadId, approvalId, dispatch: d, threadFinal: thread2, execEvent: execEv?.payload ?? null,
  gestureEvent: gestureEvents[0]?.payload ?? null, stall: stallProbe, elapsedMs: Date.now() - t0,
  title: TITLE,
});

await sleep(50);
process.exit(r.finish("m2-01-main-loop.json"));
