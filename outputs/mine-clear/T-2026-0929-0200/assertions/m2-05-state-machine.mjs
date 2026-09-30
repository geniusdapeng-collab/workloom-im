/**
 * M2-05 状态机遍历（重点：没有出口的状态）
 *
 * 覆盖：queued→running→completed（auto）/ pending_review（review）/ paused（block）/ failed（无回执）
 *      / cancelled（驳回）以及审批终态（approved / rejected / expired）。
 * 环境补全：本用例会临时给一店一档注入 price_bands（演示档案缺价带 → 行业规划器无法取锚点），
 *          用于让 R1(auto)/R2(block) 真正可判定；用例结束恢复原档案。
 * 复跑：node m2-05-state-machine.mjs
 */
import { SFX, api, ok, errCode, loginAll, superQuery, createReport, threadGet, threadEvents, waitFor, sleep, writeEvidence } from "./lib-m2.mjs";

const r = createReport("M2-05 状态机遍历");
const s = await loginAll();

/* ---------- 0. 状态清单（数据库事实） ---------- */
const beforeStatus = await superQuery(`SELECT status, count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' GROUP BY 1 ORDER BY 2 DESC`);
const approvalStatus = await superQuery(`SELECT status, count(*)::int AS n FROM approvals WHERE workspace_id='ws-yunqi' GROUP BY 1 ORDER BY 2 DESC`);
r.note("S0 线程状态分布（跑前）", beforeStatus);
r.note("S0 审批状态分布（跑前）", approvalStatus);

/* ---------- 档案价带注入（环境补全，用例末尾恢复） ---------- */
const [archiveRow] = await superQuery(`SELECT archive FROM profiles WHERE workspace_id='ws-yunqi'`);
writeEvidence("m2-05-archive-before.json", archiveRow?.archive ?? null);
const hadBands = Boolean(archiveRow?.archive?.business?.price_bands);

/* ---------- H. 双入口计划一致性（MC-303） ---------- */
async function planOf(threadId) {
  const rows = await superQuery(
    `SELECT payload->'decision'->>'step_id' AS step, payload->'decision'->>'action' AS action,
            payload->'decision'->>'tool' AS tool, payload->'decision'->>'params' AS params
       FROM biz_events WHERE workspace_id='ws-yunqi' AND session_id=$1
        AND payload->'decision'->>'step_id' IS NOT NULL ORDER BY seq`,
    [threadId],
  );
  return rows.map((x) => `${x.step}:${x.action}:${x.tool}:${String(x.params ?? "{}").replace(/\s/g, "")}`).sort();
}
const goalAB = `把雅致大床房调价到 519 元（${SFX}-双入口）`;
const immDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `${goalAB}-立即`, runImmediately: true } });
const schDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `${goalAB}-调度`, runImmediately: false } });
const immThread = ok(immDispatch)?.threadId;
const schThread = ok(schDispatch)?.threadId;
if (schThread) {
  await waitFor(async () => {
    const [row] = await superQuery(`SELECT status FROM threads WHERE id=$1`, [schThread]);
    return { ok: row?.status !== "queued", row };
  }, { timeoutMs: 30_000, intervalMs: 2_000 });
}
const immPlan = immThread ? await planOf(immThread) : [];
const schPlan = schThread ? await planOf(schThread) : [];
r.check(
  "H1 两条入口（立即执行 / 调度器）对同一目标产出一致计划",
  immPlan.length > 0 && JSON.stringify(immPlan) === JSON.stringify(schPlan),
  { immediate: immPlan, scheduler: schPlan, verdict: JSON.stringify(immPlan) === JSON.stringify(schPlan) ? "一致" : "不一致：立即执行入口未走行业规划器（空参 / 工具名当动作名）" },
);

/* ---------- I. 差评回复的岗位路由与交付物（MC-304） ---------- */
const reviewGoal = `处理一条差评并回复（${SFX}-口碑）`;
const reviewDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: reviewGoal, runImmediately: true } });
const reviewThread = ok(reviewDispatch)?.threadId;
await waitFor(async () => {
  const [row] = await superQuery(`SELECT status FROM threads WHERE id=$1`, [reviewThread]);
  return { ok: row && row.status !== "running" && row.status !== "queued", row };
}, { timeoutMs: 30_000, intervalMs: 2_000 });
const [reviewRow] = await superQuery(
  `SELECT t.status, ag.preset_key,
          (SELECT count(*)::int FROM biz_events e WHERE e.session_id=t.id AND e.payload->'decision'->>'tool' LIKE 'review.%') AS review_steps,
          (SELECT count(*)::int FROM biz_events e WHERE e.session_id=t.id AND e.payload->'receipt' IS NOT NULL) AS exec_steps
     FROM threads t LEFT JOIN agents ag ON ag.id=t.agent_id AND ag.workspace_id=t.workspace_id WHERE t.id=$1`,
  [reviewThread],
);
r.check(
  "I1 「差评并回复」目标必须由持有 review.reply 的岗位执行（不得无关工具「完成」）",
  (reviewRow?.review_steps ?? 0) >= 1,
  { thread: reviewThread, row: reviewRow, verdict: (reviewRow?.review_steps ?? 0) >= 1 ? "命中口碑/回复链" : `未命中：岗位=${reviewRow?.preset_key}，执行步骤=${reviewRow?.exec_steps}（交付物与目标无关）` },
);

/* ---------- J. 出厂档案的价带契约（MC-306） ---------- */
const bandGoal = `把雅致大床房调价上调 3%（${SFX}-出厂档案）`;
const bandDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: bandGoal, runImmediately: false } });
const bandThread = ok(bandDispatch)?.threadId;
const bandWait = await waitFor(async () => {
  const [row] = await superQuery(
    `SELECT a.approval_id, a.snapshot FROM approvals a JOIN biz_events e ON e.event_id=a.event_id
      WHERE e.session_id=$1 ORDER BY a.created_at DESC LIMIT 1`,
    [bandThread],
  );
  const [t] = await superQuery(`SELECT status FROM threads WHERE id=$1`, [bandThread]);
  return { ok: t?.status === "completed" || Boolean(row?.approval_id), row, thread: t };
}, { timeoutMs: 30_000, intervalMs: 2_000 });
r.check(
  "J1 出厂档案下价带内调价应命中 R1 自动执行（不得因缺价带一律转人工）",
  bandWait.last?.thread?.status === "completed" && bandWait.last?.row?.snapshot?.params_incomplete !== true,
  {
    thread: bandThread, threadStatus: bandWait.last?.thread?.status,
    approval: bandWait.last?.row?.approval_id ?? null,
    params_incomplete: bandWait.last?.row?.snapshot?.params_incomplete ?? null,
    warning: String(bandWait.last?.row?.snapshot?.warning ?? "").slice(0, 80),
    verdict: bandWait.last?.row?.snapshot?.params_incomplete === true ? "缺价带 → 围栏无法求值 → 一律人工（R1 自动/R2 熔断不可达）" : "按 R1 自动执行",
  },
);

// 注意：jsonb_set 不会创建缺失的中间层键（PG 行为：父键不存在则原样返回），
// 因此这里用 || 合并整块 business 结构。
await superQuery(
  `UPDATE profiles SET archive = archive || jsonb_build_object('business',
      jsonb_build_object('price_bands', $1::jsonb)) WHERE workspace_id='ws-yunqi'`,
  [JSON.stringify({ 雅致大床房: [420, 480], 美团大床房: [380, 440] })],
);
r.note("S1 已注入价带（雅致大床房 420–480 / 美团大床房 380–440）", { hadBandsBefore: hadBands });

async function waitThreadStatus(threadId, want, timeoutMs = 40_000) {
  return waitFor(async () => {
    const [row] = await superQuery(`SELECT status, error, progress_done, progress_total FROM threads WHERE id=$1`, [threadId]);
    return { ok: row && want.includes(row.status), row };
  }, { timeoutMs, intervalMs: 2_000 });
}

/* ---------- A. auto 路径：R1 视窗内自动执行 → completed ---------- */
// 注意：标题必须带路由关键词（调价/房价/价格…）才会落到 pricing-agent；
// 只说「上调 3%」会被派给 competitor-agent（见 F4 语义路由缺口）。
const autoDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `把雅致大床房调价上调 3%（${SFX}-auto）`, runImmediately: false } });
const autoThread = ok(autoDispatch)?.threadId;
const autoWait = await waitThreadStatus(autoThread, ["completed", "pending_review", "failed", "paused"]);
r.check("A1 auto 视窗内的调价线程跑完（非挂起）", autoWait.last?.row?.status === "completed", { threadId: autoThread, row: autoWait.last?.row });

const autoEvents = await superQuery(
  `SELECT payload->'decision'->>'step_id' AS step, payload->'decision'->>'action' AS action,
          payload->'decision'->>'before' AS before, payload->'decision'->>'after' AS after,
          coalesce(jsonb_array_length(payload->'rule_impact')::int, 0) AS impacts,
          payload->'receipt'->>'synced' AS synced, payload->'decision'->>'basis' AS basis
     FROM biz_events WHERE workspace_id='ws-yunqi' AND session_id=$1 AND payload->'decision'->>'step_id' IS NOT NULL ORDER BY seq`,
  [autoThread],
);
const writeEv = autoEvents.find((e) => e.action === "price.adjust");
const autoApprovals = await superQuery(
  `SELECT count(*)::int AS n FROM approvals a JOIN biz_events e ON e.event_id=a.event_id WHERE e.session_id=$1`,
  [autoThread],
);
r.check(
  "A2 写步骤命中 R1（rule_impact 非空）→ 免审批直接执行且带回执",
  Boolean(writeEv) && writeEv.impacts >= 1 && writeEv.synced === "true" && autoApprovals[0]?.n === 0,
  { writeEv, approvals: autoApprovals[0]?.n },
);

/* ---------- B. block 路径：R2 保底价熔断 → paused ---------- */
const blockDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `把雅致大床房调价到 300 元（${SFX}-block）`, runImmediately: false } });
const blockThread = ok(blockDispatch)?.threadId;
const blockWait = await waitThreadStatus(blockThread, ["completed", "pending_review", "failed", "paused"]);
r.check("B1 越保底价 → 熔断暂停（paused）", blockWait.last?.row?.status === "paused", { threadId: blockThread, row: blockWait.last?.row });

const blockEvents = await superQuery(
  `SELECT payload->'decision'->>'action' AS action, payload->'decision'->>'basis' AS basis,
          payload->'rule_impact' AS impacts FROM biz_events
    WHERE workspace_id='ws-yunqi' AND session_id=$1 AND payload->'decision'->>'step_id' IS NOT NULL ORDER BY seq`,
  [blockThread],
);
const blockEv = blockEvents[blockEvents.length - 1];
const blockedRule = (blockEv?.impacts ?? []).find((i) => i.result === "blocked");
r.check(
  "B2 熔断事件写明命中规则（R2）与依据，且不产生审批行",
  Boolean(blockedRule) && JSON.stringify(blockEv?.basis ?? "").includes("熔断"),
  { basis: blockEv?.basis, impacts: (blockEv?.impacts ?? []).map((i) => `${i.rule_id}:${i.result}`) },
);

const blockRetry = await api("threads.run", { token: s.owner.token, body: { threadId: blockThread } });
const blockAfter = await waitThreadStatus(blockThread, ["completed", "pending_review", "failed", "paused"]);
r.check(
  "B3 熔断线程重跑不得放行（终态仍非 completed）",
  blockAfter.last?.row?.status !== "completed",
  { retryResult: ok(blockRetry)?.status, row: blockAfter.last?.row, note: "重跑会按同一围栏重新判定：仍被熔断或转人审，不会自动放行" },
);

/* ---------- C. 无回执 → failed；再跑一次是否绕过 E3.7 ---------- */
await superQuery(`UPDATE profiles SET archive = archive || '{"dataMode":"real"}'::jsonb WHERE workspace_id='ws-yunqi'`);
// 选一个不含路由关键词的中性目标：首跑与重跑都会落同一通用计划（步数一致），
// 才能干净地验证「无回执 → failed → 重跑」这条链路（否则两次规划器不同，步数会漂移）。
const realDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `例行行情比对（${SFX}-no-receipt）`, runImmediately: false } });
const realThread = ok(realDispatch)?.threadId;
const realWait = await waitThreadStatus(realThread, ["failed", "completed", "pending_review", "paused"]);
r.check("C1 真实数据态无连接器 → 线程 failed（无回执不得宣称完成）", realWait.last?.row?.status === "failed", { threadId: realThread, row: realWait.last?.row });

const unverifiedEv = await superQuery(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE payload->'receipt'->>'synced' = 'false')::int AS unsynced
     FROM biz_events WHERE workspace_id='ws-yunqi' AND session_id=$1 AND payload->'receipt' IS NOT NULL`,
  [realThread],
);
r.check("C2 未核实步骤如实写 receipt.synced=false（不是省略字段）", (unverifiedEv[0]?.unsynced ?? 0) >= 1, unverifiedEv[0]);

const rerun = await api("threads.run", { token: s.owner.token, body: { threadId: realThread } });
const rerunData = ok(rerun);
const rerunRow = await waitThreadStatus(realThread, ["failed", "completed", "pending_review", "paused"], 15_000);
r.check(
  "C3 无回执线程重跑不得直接变 completed（E3.7 回归）",
  rerunRow.last?.row?.status !== "completed",
  { runResult: rerunData?.status, row: rerunRow.last?.row, verdict: rerunRow.last?.row?.status === "completed" ? "重跑即完成：无回执步骤被 done 集合跳过，E3.7 断言被绕过" : "未被绕过" },
);
// 还原为种子出厂值（seed.ts: dataMode=simulated；不能直接删键，否则后续写步骤会全判「未核实」）
await superQuery(`UPDATE profiles SET archive = archive || '{"dataMode":"simulated"}'::jsonb WHERE workspace_id='ws-yunqi'`);

/* ---------- D. cancelled：驳回联动线程终态 ---------- */
// 缺基准（目标不含房型锚点）→ 围栏求值异常 → W-01 人工裁决挂起，用于走「驳回」分支
const rejDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `把周五主打款调价 5%（${SFX}-reject）`, runImmediately: true } });
const rejThread = ok(rejDispatch)?.threadId;
const rejThreadRow = rejThread ? await threadGet(s.owner.token, rejThread) : null;
const rejApproval = rejThreadRow?.pending_approval_id;
const rejectRes = rejApproval
  ? await api("approvals.decide", { token: s.manager.token, body: { approvalId: rejApproval, gesture: "reject", reasonEnum: "price.too_high", reasonText: `${SFX} 驳回回归` } })
  : null;
const rejWait = rejThread ? await waitThreadStatus(rejThread, ["cancelled", "pending_review", "completed", "failed"]) : null;
r.check(
  "D1 驳回步骤级审批 → 线程转 cancelled（GR-10 联动）",
  rejWait?.last?.row?.status === "cancelled",
  { approvalId: rejApproval, decide: ok(rejectRes) ?? rejectRes?.data?.error?.message, row: rejWait?.last?.row },
);

/* ---------- E. expired：超时扫描后审批终态与线程状态解耦 ---------- */
const expDispatch = await api("threads.dispatch", { token: s.owner.token, body: { title: `把周末特惠款调价 6%（${SFX}-expire）`, runImmediately: true } });
const expThread = ok(expDispatch)?.threadId;
const expRow = expThread ? await threadGet(s.owner.token, expThread) : null;
const expApproval = expRow?.pending_approval_id;
if (expApproval) {
  await superQuery(
    `UPDATE approvals SET snapshot = snapshot || jsonb_build_object('expires_at',
        to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE approval_id=$1`,
    [expApproval],
  );
}
const sweepRes = await api("approvals.sweep", { token: s.manager.token, body: {} });
const expAfter = expApproval ? (await superQuery(`SELECT status FROM approvals WHERE approval_id=$1`, [expApproval]))[0] : null;
const expThreadAfter = expThread ? (await superQuery(`SELECT status FROM threads WHERE id=$1`, [expThread]))[0] : null;
r.check("E1 过期审批被扫描标 expired 且有事件", expAfter?.status === "expired", { approvalId: expApproval, status: expAfter?.status, sweep: ok(sweepRes)?.expired?.length });
r.check(
  "E2 审批过期后线程仍在 pending_review（线程状态无出口，需人工处理）",
  expThreadAfter?.status === "pending_review",
  { thread: expThread, threadStatus: expThreadAfter?.status, note: "审批终态（expired/rejected）与线程状态未联动：expired 线程既不能自动续跑也不转终态" },
);

/* ---------- 恢复档案 ---------- */
await superQuery(
  `UPDATE profiles SET archive = archive - 'business' WHERE workspace_id='ws-yunqi'`,
);
const [restored] = await superQuery(`SELECT archive->'business'->'price_bands' AS bands, archive->>'dataMode' AS mode FROM profiles WHERE workspace_id='ws-yunqi'`);
// 一店一档里 dataMode 原本就不落库（运行时按 Bundle 默认 simulated 补齐），因此只断言价带已移除
r.check("F1 用例环境已恢复（价带移除、未遗留 dataMode 覆盖）", restored?.bands === null && (restored?.mode === null || restored?.mode === "simulated"), restored);

/* ---------- G. 过期后的恢复路径（人工重跑是否生成新审批） ---------- */
if (expThread) {
  const rerunExp = await api("threads.run", { token: s.owner.token, body: { threadId: expThread } });
  await sleep(1500);
  const [newRow] = await superQuery(
    `SELECT a.approval_id, a.status FROM approvals a JOIN biz_events e ON e.event_id=a.event_id
      WHERE e.session_id=$1 ORDER BY a.created_at DESC LIMIT 1`,
    [expThread],
  );
  r.check(
    "G1 过期审批可由人工重跑恢复（生成新审批行）",
    rerunExp.status === 200 && Boolean(newRow?.approval_id) && newRow.approval_id !== expApproval,
    { old: expApproval, latest: newRow, runStatus: ok(rerunExp)?.status ?? rerunExp.data?.error?.message },
  );
}

const afterStatus = await superQuery(`SELECT status, count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' GROUP BY 1 ORDER BY 2 DESC`);
r.note("S9 线程状态分布（跑后）", afterStatus);

writeEvidence("m2-05-state-machine.raw.json", {
  autoThread, blockThread, realThread, rejThread, expThread,
  autoEvents, blockEvents: blockEvents.map((e) => ({ action: e.action, basis: e.basis, impacts: (e.impacts ?? []).map((i) => `${i.rule_id}:${i.result}`) })),
  afterStatus,
});

process.exit(r.finish("m2-05-state-machine.json"));
