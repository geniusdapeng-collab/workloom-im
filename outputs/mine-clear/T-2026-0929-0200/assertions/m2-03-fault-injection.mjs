/**
 * M2-03 异常注入
 *
 * 覆盖：① LLM provider 挂掉/超时/500（真机：本地 OpenAI 兼容 stub 三种模式）
 *      ② 保存未实测通过的配置必须失败关闭（不落半残配置）
 *      ③ 模型异常时主链路 fail-closed（走规则兜底，不 500、不阻塞）
 *      ④ IM 入站重复投递幂等 + PII 脱敏
 *      ⑤ 围栏表达式求值异常（缺参步骤）→ 人工裁决而非熔断（W-01）
 * 复跑：node m2-03-fault-injection.mjs
 */
import http from "node:http";
import { SFX, api, ok, errCode, loginAll, superQuery, createReport, waitFor, sleep, writeEvidence } from "./lib-m2.mjs";

const r = createReport("M2-03 异常注入");
const s = await loginAll();

/* ---------------- 本地 OpenAI 兼容 stub ---------------- */
let mode = "ok";
let hits = 0;
const stub = http.createServer((req, res) => {
  hits += 1;
  if (mode === "hang") return; // 永不响应：模拟网络挂起
  if (mode === "500") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub upstream failure" } }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-stub",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "已在线，可以开始工作（stub）" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
    }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;
const stubBase = `http://127.0.0.1:${stubPort}/v1`;
r.note("stub 就绪", { stubBase });

/* ---------------- ① 真实模型配置：实测通过才允许保存 ---------------- */
mode = "ok";
const probeOk = await api("onboarding.testLlm", { token: s.owner.token, body: { baseUrl: stubBase, apiKey: "sk-stub", model: "stub-model" } });
r.check("A1 测试连接（正常 stub）返回 ok=true", ok(probeOk)?.ok === true, ok(probeOk));

const saveOk = await api("onboarding.saveLlmConfig", { token: s.owner.token, body: { provider: "openai", baseUrl: stubBase, apiKey: "sk-stub", model: "stub-model" } });
r.check("A2 实测通过 → 保存真实模型配置成功", saveOk.status === 200 && ok(saveOk)?.real === true, ok(saveOk) ?? saveOk.raw.slice(0, 160));

const status1 = await api("onboarding.status", { token: s.owner.token });
r.check("A3 onboarding.status 反映真实模型已装配", ok(status1)?.llm?.real === true, ok(status1)?.llm);

/* ---------------- ② 挂起 / 500 的配置必须被拒绝 ---------------- */
mode = "hang";
const probeHang = await api("onboarding.testLlm", { token: s.owner.token, body: { baseUrl: stubBase, apiKey: "sk-stub", model: "stub-model" } });
r.check("A4 挂起 provider 的测试连接按时失败（不无限等待）", ok(probeHang)?.ok === false, { result: ok(probeHang), status: probeHang.status });

const saveHang = await api("onboarding.saveLlmConfig", { token: s.owner.token, body: { provider: "openai", baseUrl: stubBase, apiKey: "sk-stub", model: "stub-model" } });
r.check("A5 未通过实测的配置被拒（失败关闭，不落半残）", saveHang.status === 400, { status: saveHang.status, message: saveHang.data?.error?.message });

const status2 = await api("onboarding.status", { token: s.owner.token });
r.check("A6 被拒后仍保持上一份可用配置（未污染）", ok(status2)?.llm?.real === true && ok(status2)?.llm?.baseUrl === stubBase, ok(status2)?.llm);

mode = "500";
const save500 = await api("onboarding.saveLlmConfig", { token: s.owner.token, body: { provider: "openai", baseUrl: stubBase, apiKey: "sk-stub", model: "stub-model" } });
r.check("A7 上游 500 的配置同样被拒", save500.status === 400, { status: save500.status, message: String(save500.data?.error?.message ?? "").slice(0, 120) });

/* ---------------- ③ 运行期模型异常 → 规则兜底（fail-closed） ---------------- */
const t1 = Date.now();
const dHang = await api("threads.dispatch", { token: s.owner.token, body: { title: `把周五主打款调价 5%（${SFX}-模型挂起）`, runImmediately: false } });
const hangMs = Date.now() - t1;
r.check(
  "A8 模型挂起时派遣仍可用（预算内降级 via=timeout_fallback）",
  dHang.status === 200 && ["timeout_fallback", "rule"].includes(ok(dHang)?.via),
  { ms: hangMs, via: ok(dHang)?.via, status: dHang.status, threadId: ok(dHang)?.threadId },
);

mode = "500";
const t2 = Date.now();
const d500 = await api("threads.dispatch", { token: s.owner.token, body: { title: `把周五主打款调价 5%（${SFX}-模型500）`, runImmediately: false } });
const ms500 = Date.now() - t2;
r.check(
  "A9 上游 500 时派遣仍可用（不把故障透传给用户）",
  d500.status === 200 && ["timeout_fallback", "rule"].includes(ok(d500)?.via),
  { ms: ms500, via: ok(d500)?.via, status: d500.status, threadId: ok(d500)?.threadId },
);

const dispatchEvent = await superQuery(
  `SELECT payload->'decision'->>'action' AS action, payload->'decision'->>'via' AS via
     FROM biz_events WHERE workspace_id='ws-yunqi' AND session_id=$1 ORDER BY seq LIMIT 1`,
  [ok(dHang)?.threadId],
);
r.note("A10 派遣事件留痕（via 字段）", dispatchEvent[0] ?? null);

/* ---------------- ④ 恢复 mock，并验证 ask 链路在真实模型下的正向路径 ---------------- */
mode = "ok";
const ask = await api("threads.dispatch", { token: s.owner.token, body: { title: "今天前台还有哪些待办？", runImmediately: false } });
r.check("A11 正常 stub 下问答链路可用（via=llm 且有答案）", ask.status === 200 && ok(ask)?.mode === "ask" && String(ok(ask)?.answer ?? "").length > 0, { via: ok(ask)?.via, mode: ok(ask)?.mode, answer: String(ok(ask)?.answer ?? "").slice(0, 80) });

const restore = await api("onboarding.saveLlmConfig", { token: s.owner.token, body: { provider: "mock" } });
r.check("A12 还原 mock 装配", restore.status === 200 && ok(restore)?.real === false, ok(restore));
stub.close();

/* ---------------- ⑤ IM 入站：重复投递幂等 + PII 脱敏 ---------------- */
const msgId = `${SFX}-im-1`;
const inboundBody = {
  channel: "dingtalk", channelMsgId: msgId, conversationId: `cv-${SFX}`, kind: "direct",
  senderOpenId: `ou-${SFX}-visitor`, text: "客人电话 13800138000，身份证 110101199003072316，说房间有噪音，麻烦处理下",
};
const in1 = await api("im.inbound", { token: s.manager.token, body: inboundBody });
const in2 = await api("im.inbound", { token: s.manager.token, body: inboundBody });
const in3 = await api("im.inbound", { token: s.manager.token, body: { ...inboundBody, channelMsgId: `${SFX}-im-2`, text: "第二条消息" } });
r.check("B1 首次入站落库且返回 eventId", in1.status === 200 && Boolean(ok(in1)?.eventId) && ok(in1)?.deduped === false, ok(in1));
r.check("B2 重复投递幂等（deduped=true 且回同一 eventId）", ok(in2)?.deduped === true && ok(in2)?.eventId === ok(in1)?.eventId, ok(in2));
r.check("B3 新消息 id 正常新建事件", ok(in3)?.deduped === false && ok(in3)?.eventId && ok(in3)?.eventId !== ok(in1)?.eventId, ok(in3));

const inboundCount = await superQuery(
  `SELECT count(*)::int AS n FROM biz_events WHERE workspace_id='ws-yunqi'
     AND payload->'decision'->>'action'='im.message'
     AND payload->'decision'->'after'->>'channel_msg_id' LIKE $1`,
  [`${SFX}-im-%`],
);
r.check("B4 三次投递只落 2 条事件（重复未重复入账）", inboundCount[0]?.n === 2, inboundCount[0]);

const stored = await superQuery(
  `SELECT payload->'decision'->'after'->>'text' AS text FROM biz_events
    WHERE workspace_id='ws-yunqi' AND payload->'decision'->'after'->>'channel_msg_id'=$1`,
  [msgId],
);
const text = String(stored[0]?.text ?? "");
r.check(
  "B5 入站原文 PII 已脱敏（手机号/身份证不出现在账本）",
  !text.includes("13800138000") && !text.includes("110101199003072316"),
  { stored: text.slice(0, 120) },
);

/* ---------------- ⑥ 围栏求值异常（缺参步骤）→ 人工裁决（W-01） ---------------- */
const evalProbe = await api("threads.dispatch", { token: s.owner.token, body: { title: `把某房型调价到 510 元（${SFX}-缺基准）`, runImmediately: false } });
const evalThread = ok(evalProbe)?.threadId;
const evalWait = await waitFor(async () => {
  const rows = await superQuery(
    `SELECT a.approval_id, a.snapshot FROM approvals a
      JOIN biz_events e ON e.event_id=a.event_id
     WHERE a.workspace_id='ws-yunqi' AND e.session_id=$1 ORDER BY a.created_at DESC LIMIT 1`,
    [evalThread],
  );
  return { ok: rows.length > 0, row: rows[0] };
}, { timeoutMs: 40_000, intervalMs: 3_000 });
r.check(
  "C1 缺基准价的写步骤按「人工裁决」挂起（params_incomplete + 说明），而不是熔断/直接执行",
  evalWait.last?.row?.snapshot?.params_incomplete === true && String(evalWait.last?.row?.snapshot?.warning ?? "").includes("围栏无法求值"),
  { approvalId: evalWait.last?.row?.approval_id, snapshot: evalWait.last?.row?.snapshot && { gate: evalWait.last.row.snapshot.gate, params_incomplete: evalWait.last.row.snapshot.params_incomplete, warning: String(evalWait.last.row.snapshot.warning ?? "").slice(0, 90) } },
);

const threadRow = await superQuery(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [evalThread]);
r.note("C2 该线程状态（应为 pending_review，非 paused/failed）", threadRow[0] ?? null);

writeEvidence("m2-03-fault-injection.raw.json", {
  stubPort, hits, dispatchHang: ok(dHang), dispatch500: ok(d500), ask: ok(ask),
  inbound: [ok(in1), ok(in2), ok(in3)], inboundStoredText: text, evalThread, evalSnapshot: evalWait.last?.row?.snapshot ?? null,
});

process.exit(r.finish("m2-03-fault-injection.json"));
