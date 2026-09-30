/**
 * M2-02 并发竞争
 *
 * 覆盖：① 同一审批行 N 路并发 decide（恰一生效，其余幂等）
 *      ② 并发 dispatch 打 L3.1 工作区并发上限（10）
 *      ③ 并发写库后事件账本哈希链完整性（scripts/verify-chain.ts）
 *      ④ expireSweep 与 decide 竞态（超时扫描是否会覆盖已裁决结果）
 * 复跑：node m2-02-concurrency.mjs
 */
import { spawnSync } from "node:child_process";
import {
  SFX, REPO, ENV_FILE, api, ok, loginAll, superQuery, createReport, threadGet, waitFor, sleep, writeEvidence, EVID,
} from "./lib-m2.mjs";
import path from "node:path";

const r = createReport("M2-02 并发竞争");
const s = await loginAll();
const T = (tag) => `并发用例 ${tag}（${SFX}）`;

async function dispatchQuest(title, token, runImmediately = true) {
  const res = await api("threads.dispatch", { token, body: { title, runImmediately } });
  return { status: res.status, code: res.data?.error?.data?.code ?? null, data: ok(res), message: res.data?.error?.message ?? null };
}

/* ---------- A. 并发 decide：恰一生效 ---------- */
const first = await dispatchQuest("把周五主打款调价 5%（并发 decide 目标）", s.owner.token);
const approvalId = first.data?.threadId ? (await threadGet(s.owner.token, first.data.threadId))?.pending_approval_id : null;
r.check("A0 目标审批行就绪", Boolean(approvalId) && first.status === 200, { approvalId, threadId: first.data?.threadId });

if (!approvalId) {
  r.finish("m2-02-concurrency.json");
  process.exit(1);
}

const tokens = [s.owner.token, s.manager.token];
const wave = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    api("approvals.decide", {
      token: tokens[i % tokens.length],
      body: { approvalId, gesture: "approve", reasonText: `${SFX}-wave-${i}` },
    }).then((res) => ({ i, status: res.status, data: ok(res), code: res.data?.error?.data?.code ?? null })),
  ),
);
const decided = wave.filter((x) => x.data && x.data.deduped === false);
const deduped = wave.filter((x) => x.data && x.data.deduped === true);
const failed = wave.filter((x) => x.status !== 200);
r.check("A1 8 路并发 decide：恰一条真正生效", decided.length === 1, { decided: decided.length, deduped: deduped.length, failed: failed.map((f) => ({ i: f.i, status: f.status, code: f.code })) });
r.check("A2 其余并发请求幂等返回（200/deduped），无 500", failed.length === 0, { failed });

const gestureCount = await superQuery(
  `SELECT count(*)::int AS n FROM biz_events WHERE workspace_id='ws-yunqi'
     AND payload->'decision'->>'action'='approval.gesture' AND payload->'decision'->'after'->>'approvalId'=$1`,
  [approvalId],
);
r.check("A3 手势事件只落一条（并发不重复写入账本）", gestureCount[0]?.n === 1, gestureCount[0]);

const [aprFinal] = await superQuery(`SELECT status, decided_by FROM approvals WHERE approval_id=$1`, [approvalId]);
r.check("A4 审批终态唯一且已落 decided_by", aprFinal?.status === "approved" && Boolean(aprFinal?.decided_by), aprFinal);

/* ---------- B. 并发 dispatch 打工作区并发上限 ---------- */
const before = await superQuery(
  `SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi'
     AND (status='queued' OR (status='running' AND updated_at > now() - interval '10 minutes'))`,
);
const K0 = before[0]?.n ?? 0;
const N = 15;
const burst = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    api("threads.dispatch", { token: s.owner.token, body: { title: T(`cap-${i}`), runImmediately: false } })
      .then((res) => ({ i, status: res.status, code: res.data?.error?.data?.code ?? null, threadId: ok(res)?.threadId, message: res.data?.error?.message ?? null })),
  ),
);
const accepted = burst.filter((x) => x.status === 200);
const rejected = burst.filter((x) => x.status !== 200);
const capacity = Math.max(0, 10 - K0);
r.check(
  `B1 并发派遣不超过 L3.1 上限（抢占前余量 ${capacity}，并发 ${N}）`,
  accepted.length <= capacity,
  { preexisting: K0, capacity, accepted: accepted.length, rejected: rejected.length, firstReject: rejected[0] ?? null, verdict: accepted.length <= capacity ? "未穿透" : "并发穿透：多接受了 " + (accepted.length - capacity) },
);
r.check("B2 超限请求返回 429 且有可读原因", rejected.length === 0 || (rejected.every((x) => x.status === 429) && String(rejected[0].message ?? "").includes("并发上限")), { sample: rejected[0] ?? null });
r.check("B3 超限时线程未建档（拒绝就拒绝，不落半截数据）", rejected.every((x) => !x.threadId), { rejectedWithId: rejected.filter((x) => x.threadId).length });

/* ---------- B4. 队列 ≥ 上限时调度器是否仍能推进（没有出口的状态） ---------- */
const q0 = (await superQuery(
  `SELECT count(*)::int AS n, max(updated_at) AS last FROM threads WHERE workspace_id='ws-yunqi' AND status='queued'`,
))[0];
const obsT0 = Date.now();
let progressed = false;
let q1 = q0;
while (Date.now() - obsT0 < 35_000 && !progressed) {
  await sleep(7_000);
  q1 = (await superQuery(
    `SELECT count(*)::int AS n, max(updated_at) AS last FROM threads WHERE workspace_id='ws-yunqi' AND status='queued'`,
  ))[0];
  progressed = (q1?.n ?? 99) < (q0?.n ?? 0);
}
r.check(
  "B4 队列 ≥ 并发上限时调度器仍推进（不得整体停摆）",
  progressed,
  { start: q0, after35s: q1, acceptedByBurst: accepted.length, verdict: progressed ? "有推进" : "零推进：queued ≥ MAX 时调度器拒绝拾取任何线程（自锁）" },
);

/* ---------- B5. 用产品自身路径（threads.run）排空队列，保证后续用例可跑 ---------- */
const queuedRows = await superQuery(
  `SELECT id FROM threads WHERE workspace_id='ws-yunqi' AND status='queued' ORDER BY created_at`,
);
const drained = [];
for (const row of queuedRows) {
  const res = await api("threads.run", { token: s.owner.token, body: { threadId: row.id } });
  drained.push({ id: row.id, status: res.status, result: ok(res)?.status ?? res.data?.error?.message });
}
const qAfterDrain = await superQuery(
  `SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' AND status='queued'`,
);
r.check("B5 人工可解锁（threads.run 逐个排空）但需逐个用户操作", (qAfterDrain[0]?.n ?? 1) === 0, { drained: drained.length, left: qAfterDrain[0]?.n, sample: drained.slice(0, 3) });

/* ---------- C. 并发写后哈希链完整性 ---------- */
const chain = spawnSync(
  path.join(REPO, "node_modules/.bin/tsx"),
  ["--env-file=" + ENV_FILE, "scripts/verify-chain.ts"],
  { cwd: REPO, encoding: "utf8", env: { ...process.env, PATH: `/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:${process.env.PATH}` } },
);
writeEvidence("m2-02-verify-chain.log", `${chain.stdout ?? ""}\n${chain.stderr ?? ""}`);
r.check("C1 并发写库后哈希链验证通过（verify-chain 退出码 0）", chain.status === 0, { exit: chain.status, tail: (chain.stdout ?? "").split("\n").slice(-6).join(" | ") });

/* ---------- D. expireSweep vs decide 竞态 ---------- */
// 状态准备：把本轮并发产生的待审行快照置为「已过期」，再让扫描与裁决同时发生。
// 判据（不变量）：扫描不得把已裁决（approved/rejected/edited）的审批改写成 expired。
const raceThreads = [];
for (let i = 0; i < 3; i += 1) {
  const res = await dispatchQuest(`把周五主打款调价 5%（竞态准备 ${i}）`, s.owner.token);
  const tid = res.data?.threadId;
  const thr = tid ? await threadGet(s.owner.token, tid) : null;
  if (thr?.pending_approval_id) raceThreads.push({ threadId: tid, approvalId: thr.pending_approval_id });
}
const targetIds = raceThreads.map((x) => x.approvalId);
r.note("D0 待审行样本", { n: targetIds.length });

if (targetIds.length >= 3) {
  await superQuery(
    `UPDATE approvals SET snapshot = snapshot || jsonb_build_object('expires_at',
        to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      WHERE approval_id = ANY($1::text[])`,
    [targetIds],
  );
  const last = targetIds[targetIds.length - 1];
  const sweepP = api("approvals.sweep", { token: s.manager.token, body: {} }).then((x) => ({ role: "sweep", status: x.status }));
  await sleep(2);
  const decideP = api("approvals.decide", { token: s.owner.token, body: { approvalId: last, gesture: "approve", reasonText: `${SFX}-race` } }).then((x) => ({ role: "decide", status: x.status, data: ok(x), code: x.data?.error?.data?.code ?? null, message: x.data?.error?.message ?? null }));
  const [sweepRes, decideRes] = await Promise.all([sweepP, decideP]);

  const [rowAfter] = await superQuery(`SELECT status, decided_by FROM approvals WHERE approval_id=$1`, [last]);
  const events = await superQuery(
    `SELECT payload->'decision'->>'action' AS action FROM biz_events
      WHERE workspace_id='ws-yunqi'
        AND (payload->'decision'->'after'->>'approvalId'=$1 OR payload->'decision'->'after'->>'approval_id'=$1)`,
    [last],
  );
  const actions = events.map((x) => x.action);
  const overwritten = decideRes.data?.status === "approved" && rowAfter?.status === "expired";
  r.check(
    "D1 竞态下审批终态唯一（不得出现「已采纳但被写成 expired」）",
    !overwritten,
    { sweepStatus: sweepRes.status, decide: { status: decideRes.status, code: decideRes.code, message: decideRes.message, data: decideRes.data }, finalRow: rowAfter, events: actions, verdict: overwritten ? "扫描覆盖了已裁决结果（lost update）" : "未观察到覆盖" },
  );
  r.check(
    "D2 竞态下不出现双事件（approval.expired 与 approval.gesture 同时存在）",
    !(actions.includes("approval.expired") && actions.includes("approval.gesture")),
    { actions },
  );

  const sweepData = ok(await api("approvals.sweep", { token: s.manager.token, body: {} }));
  r.note("D3 二次扫描（应幂等：不重复处理终态行）", sweepData);
  writeEvidence("m2-02-race.raw.json", { targetIds, sweepRes, decideRes, rowAfter, actions });
}

/* ---------- E. 收尾：把竞态用例线程也解锁，避免污染后续脚本 ---------- */
const leftover = await superQuery(
  `SELECT id FROM threads WHERE workspace_id='ws-yunqi' AND status IN ('queued','pending_review') AND id = ANY($1::text[])`,
  [raceThreads.map((x) => x.threadId)],
);
for (const row of leftover) {
  await api("threads.run", { token: s.owner.token, body: { threadId: row.id } });
}
writeEvidence("m2-02-drain.json", { drained, raceThreads, leftoverRuns: leftover.length });

process.exit(r.finish("m2-02-concurrency.json"));
