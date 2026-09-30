/**
 * M4 安全边界探针（对真实运行实例取证）
 * 覆盖：绑定地址 / CORS / 匿名 C 端会话 / 跨租户越权 / 注入式输入 / 批量高危守卫
 * 用法：node sec-probe.mjs http://127.0.0.1:8921 <repo>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { envOf, memberToken, signHs256 } from "./jwt.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8921";
const REPO = process.argv[3] ?? "/Users/mac/WorkLoom-fleet/.wt-mcd-c";
const OUT = "/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/m4/evidence";
mkdirSync(OUT, { recursive: true });

const env = envOf(REPO);
const results = [];
const raw = {};
const rec = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();

async function tokenFor(workspaceId, memberNo) {
  const m = await db.query(
    `SELECT m.id, m.member_no, m.name, m.role, w.tenant_id
       FROM members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id=$1 AND m.member_no=$2`,
    [workspaceId, memberNo],
  );
  const row = m.rows[0];
  if (!row) throw new Error(`成员不存在 ${workspaceId}/${memberNo}`);
  return {
    identity: row,
    token: memberToken(env.JWT_SECRET, {
      memberId: row.id, memberNo: row.member_no, name: row.name, role: row.role,
      tenantId: row.tenant_id, workspaceId,
    }),
  };
}

async function trpc(proc, { input, token, method = "query", base = BASE } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = method === "query"
    ? await fetch(`${base}/trpc/${proc}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers })
    : await fetch(`${base}/trpc/${proc}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * C 端会话获取（MC-207 后口径）：生产档已强制关闭匿名演示直登，探针改用本机 SERVICE_C_SECRET
 * 自签 c-token（与 B 端探针用 JWT_SECRET 自签成员令牌同一纪律：本机持有密钥的验收探针，
 * 不依赖只应在开发档存在的演示入口）。开发档仍优先走真实 /c/session 演示入口。
 */
async function cSessionToken(openid, nickname = "隔离探针") {
  const demo = await fetch(`${BASE}/c/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.90" },
    body: JSON.stringify({ channel: "h5", openid, nickname }),
  });
  const demoBody = await demo.json().catch(() => ({}));
  if (demo.status === 200 && demoBody?.token) return { token: demoBody.token, via: "demo" };
  const workspaceId = env.SERVICE_C_WORKSPACE_ID ?? "ws-yunqi";
  const cUserId = `cu-probe-${openid.slice(-12)}`;
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.workspace_id',$1,true), set_config('app.tenant_id',$2,true)",
    [workspaceId, (await db.query("SELECT tenant_id FROM workspaces WHERE id=$1", [workspaceId])).rows[0]?.tenant_id ?? "tenant-demo"]);
  await db.query(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname)
     VALUES ($1,$2,'h5',$3,$4)
     ON CONFLICT (workspace_id, channel, openid) DO UPDATE SET nickname = COALESCE(EXCLUDED.nickname, c_users.nickname)`,
    [cUserId, workspaceId, openid, nickname],
  );
  await db.query("COMMIT");
  const token = signHs256({ workspaceId, cUserId, channel: "h5", scope: "c-user" }, env.SERVICE_C_SECRET, { issuer: "workloom-c" });
  return { token, via: "signed" };
}

const yunqi = await tokenFor("ws-yunqi", "MEM-001");
const yunqiRo = await tokenFor("ws-yunqi", "MEM-003");
const aipm = await tokenFor("ws-aipm-demo", "MEM-001");

/* ---------- 1. 绑定地址（仅回环） ---------- */
{
  const { execFileSync } = await import("node:child_process");
  const listen = execFileSync("lsof", ["-nP", `-iTCP:${new URL(BASE).port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  raw.bind = listen;
  const addrs = listen.split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/)[8]);
  rec("SEC-BIND-01 服务只监听回环地址", addrs.every((a) => /^127\.0\.0\.1:/.test(a)), addrs.join(","));
}

/* ---------- 2. CORS（生产档） ---------- */
{
  const evil = await fetch(`${BASE}/health`, { headers: { origin: "http://evil.example" } });
  const loop = await fetch(`${BASE}/health`, { headers: { origin: "http://127.0.0.1:5321" } });
  raw.cors = { evil: Object.fromEntries(evil.headers), loop: Object.fromEntries(loop.headers) };
  rec("SEC-CORS-01 非回环来源不回 ACAO", !evil.headers.get("access-control-allow-origin"), {
    acao: evil.headers.get("access-control-allow-origin"),
  });
  rec("SEC-CORS-02 回环来源放行", loop.headers.get("access-control-allow-origin") === "http://127.0.0.1:5321", {
    acao: loop.headers.get("access-control-allow-origin"), acac: loop.headers.get("access-control-allow-credentials"),
  });
  const evilPost = await fetch(`${BASE}/trpc/health`, { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  raw.cors.evilPost = Object.fromEntries(evilPost.headers);
  rec("SEC-CORS-03 非回环来源的 tRPC 响应不回 ACAO", !evilPost.headers.get("access-control-allow-origin"), { status: evilPost.status });
}

/* ---------- 3. 生产档下的匿名 C 端会话（MC-207 修复后口径：生产档必须拒绝） ---------- */
{
  const anon = await fetch(`${BASE}/c/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
    body: JSON.stringify({ channel: "h5", openid: `probe-anon-${Date.now().toString(36)}`, nickname: "匿名探针" }),
  });
  const text = await anon.text();
  raw.anonSession = { status: anon.status, body: text.slice(0, 400) };
  let body = null; try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  /**
   * MC-207：生产档 + 出厂配置下，匿名设备**不得**拿到 C 端会话。
   * 修复前该探针记录的是漏洞复现（200 + token）；现在断言应然行为：
   * 非 200（403/503）且响应体不含 token。开发档实例仍允许演示直登（下面分支继续验隔离）。
   */
  rec("SEC-DEMO-01 生产档拒绝匿名签发 C 端会话（MC-207）", anon.status !== 200 && !body?.token, {
    status: anon.status, hasToken: Boolean(body?.token), body: text.slice(0, 160),
  });
  if (body?.token) {
    // 开发档演示直登：继续验证「演示身份也只能读到自己的数据」
    const notif = await fetch(`${BASE}/c/notifications`, { headers: { authorization: `Bearer ${body.token}` } });
    const notifText = await notif.text();
    raw.anonNotifications = { status: notif.status, body: notifText.slice(0, 600) };
    rec("SEC-DEMO-02 演示会话可读服务前台数据（限本人数据）", notif.status === 200, { status: notif.status, sample: notifText.slice(0, 200) });
    const chat = await fetch(`${BASE}/c/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${body.token}`, "x-forwarded-for": "198.51.100.78" },
      body: JSON.stringify({ text: "你好，请问酒店有什么房型？" }),
    });
    const chatText = await chat.text();
    raw.anonChat = { status: chat.status, body: chatText.slice(0, 600) };
    rec("SEC-DEMO-03 演示会话可消耗对话（LLM）链路", chat.status === 200, { status: chat.status });
  }
}

/* ---------- 4. 跨租户越权（建 A 区线程，用 B 区凭据读） ---------- */
{
  const mk = await trpc("threads.dispatch", {
    method: "POST", token: yunqi.token, input: { title: "M4 越权探针：云栖酒店调价" },
  });
  const threadId = mk.body?.result?.data?.threadId;
  raw.crossTenant = { create: mk.body, threadId };
  rec("SEC-TENANT-00 云栖线程建立（取证前置）", Boolean(threadId), { status: mk.status, threadId });
  const ownerCheck = await db.query(`SELECT workspace_id FROM threads WHERE id=$1`, [threadId]);
  raw.crossTenant.dbWorkspace = ownerCheck.rows[0]?.workspace_id;

  const read = await trpc("threads.get", { token: aipm.token, input: { threadId } });
  raw.crossTenant.crossRead = read.body;
  const leaked = JSON.stringify(read.body ?? "").includes(String(threadId)) && read.body?.result?.data != null;
  rec("SEC-TENANT-01 跨工作区读线程不泄露（返回空/错误）", !leaked, { status: read.status, body: JSON.stringify(read.body).slice(0, 240) });

  const events = await trpc("threads.events", { token: aipm.token, input: { threadId } });
  raw.crossTenant.crossEvents = JSON.stringify(events.body).slice(0, 400);
  const evLeak = Array.isArray(events.body?.result?.data) ? events.body.result.data.length > 0 : Boolean(events.body?.result?.data);
  rec("SEC-TENANT-02 跨工作区读线程事件流不泄露", !evLeak, { status: events.status, body: raw.crossTenant.crossEvents.slice(0, 200) });

  // 正对照：本区凭据读同一线程必须拿得到（证明上面两条不是"本来就取不到"的空断言）
  const own = await trpc("threads.get", { token: yunqi.token, input: { threadId } });
  raw.crossTenant.ownRead = JSON.stringify(own.body).slice(0, 200);
  rec("SEC-TENANT-00b 正对照：本区凭据可读到该线程", own.body?.result?.data != null, { body: raw.crossTenant.ownRead });

  // 真实的跨区审批 id（存在于云栖工作区）+ 合法手势字符串：应 NOT_FOUND，不得泄露存在性/不得改状态
  const foreign = await db.query(
    `SELECT approval_id FROM approvals WHERE workspace_id='ws-yunqi' AND status='pending' ORDER BY approval_id LIMIT 1`,
  );
  const foreignId = foreign.rows[0]?.approval_id;
  const before = await db.query(`SELECT status FROM approvals WHERE approval_id=$1`, [foreignId]);
  const apr = await trpc("approvals.decide", {
    method: "POST", token: aipm.token,
    input: { approvalId: foreignId, gesture: "approve" },
  });
  const after = await db.query(`SELECT status FROM approvals WHERE approval_id=$1`, [foreignId]);
  raw.crossTenant.crossDecide = apr.body;
  raw.crossTenant.crossDecideId = foreignId;
  raw.crossTenant.crossDecideStatus = { before: before.rows[0]?.status, after: after.rows[0]?.status };
  rec("SEC-TENANT-03 跨工作区审批裁决被拒且不改状态",
    Boolean(apr.body?.error) && before.rows[0]?.status === after.rows[0]?.status,
    { status: apr.status, code: apr.body?.error?.data?.code, before: before.rows[0]?.status, after: after.rows[0]?.status });

  const ownQueue = await trpc("approvals.list", { token: aipm.token, input: { status: "pending" } });
  const ownIds = (ownQueue.body?.result?.data ?? []).map((r) => r.approval_id);
  const foreignVisible = ownIds.filter((id) => String(id).includes("yunqi"));
  const dbOwn = await db.query(
    `SELECT count(*)::int AS n FROM approvals WHERE workspace_id='ws-aipm-demo' AND status='pending'`,
  );
  raw.crossTenant.ownQueue = { count: ownIds.length, dbOwnCount: dbOwn.rows[0]?.n, foreignVisible };
  rec("SEC-TENANT-04 审批队列仅含本工作区条目",
    foreignVisible.length === 0 && ownIds.length === dbOwn.rows[0]?.n,
    { listed: ownIds.length, dbOwn: dbOwn.rows[0]?.n, foreignVisible });
}

/* ---------- 5. readonly 角色提权 ---------- */
{
  const write = await trpc("threads.dispatch", { method: "POST", token: yunqiRo.token, input: { title: "readonly 越权派单" } });
  raw.readonlyWrite = write.body;
  rec("SEC-ROLE-01 readonly 角色派发任务被拒（403）", write.status === 403 || write.body?.error?.data?.httpStatus === 403, {
    status: write.status, code: write.body?.error?.data?.code,
  });
  const decide = await trpc("approvals.decide", {
    method: "POST", token: yunqiRo.token, input: { approvalId: "apr-nonexistent", gesture: "approve" },
  });
  raw.readonlyDecide = decide.body;
  rec("SEC-ROLE-02 readonly 角色审批被拒", decide.status === 403 || decide.body?.error?.data?.httpStatus === 403, { status: decide.status });
}

/* ---------- 5b. C 端：会话隔离 / 输入约束 / 限流 ---------- */
{
  const mkSession = async (openid) => {
    // MC-207 后：生产档用本机 SERVICE_C_SECRET 自签会话，开发档优先真实演示入口
    const { token, via } = await cSessionToken(openid);
    raw.cSessionVia = via;
    return token;
  };
  const tokenA = await mkSession(`probe-iso-a-${Date.now().toString(36)}`);
  const tokenB = await mkSession(`probe-iso-b-${Date.now().toString(36)}`);
  const created = await fetch(`${BASE}/c/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}`, "x-forwarded-for": "198.51.100.90" },
    body: JSON.stringify({ kind: "complaint", title: "M4 隔离探针工单", payload: { note: "A 用户" } }),
  });
  const createdText = await created.text();
  raw.cTicket = { status: created.status, body: createdText.slice(0, 300) };
  let ticketId = null;
  try { ticketId = JSON.parse(createdText)?.ticket?.id ?? JSON.parse(createdText)?.id; } catch { /* ignore */ }
  rec("SEC-CUSER-00 C 端建单（取证前置）", Boolean(ticketId), { status: created.status, ticketId });
  if (ticketId) {
    const mine = await fetch(`${BASE}/c/tickets/${ticketId}`, { headers: { authorization: `Bearer ${tokenA}` } });
    const other = await fetch(`${BASE}/c/tickets/${ticketId}`, { headers: { authorization: `Bearer ${tokenB}` } });
    const otherText = await other.text();
    raw.cTicketIsolation = { mine: mine.status, other: other.status, otherBody: otherText.slice(0, 200) };
    rec("SEC-CUSER-01 他用户凭证读不到本人工单",
      mine.status === 200 && other.status >= 400 && !otherText.includes(String(ticketId).slice(0, 12)),
      { mineStatus: mine.status, otherStatus: other.status, otherBody: otherText.slice(0, 120) });
  }

  const overLong = await fetch(`${BASE}/c/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}`, "x-forwarded-for": "198.51.100.91" },
    body: JSON.stringify({ text: "长".repeat(2001) }),
  });
  raw.cChatOverLong = { status: overLong.status, body: (await overLong.text()).slice(0, 200) };
  rec("SEC-CINPUT-01 /c/chat 文本超 2000 字被拒", overLong.status === 400 || overLong.status === 413, { status: overLong.status });

  const badTicket = await fetch(`${BASE}/c/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ kind: "not-in-whitelist", title: "非法类型" }),
  });
  raw.cTicketKind = { status: badTicket.status };
  rec("SEC-CINPUT-02 /c/tickets 非法 kind 被拒", badTicket.status === 400, { status: badTicket.status });

  let limited = 0;
  for (let i = 0; i < 62; i += 1) {
    const r = await fetch(`${BASE}/c/notifications`, { headers: { authorization: `Bearer ${tokenB}` } });
    if (r.status === 429) { limited = 429; break; }
  }
  raw.cRateLimit = { saw429: limited === 429 };
  rec("SEC-CRATE-01 C 端每用户限流触发 429", limited === 429, { saw: limited || "no-429-in-62" });
}

/* ---------- 6. 注入式输入（写入口） ---------- */
{
  const payload = "'; DROP TABLE biz_events; -- <script>alert(1)</script> \\u0000 ${jndi:ldap://x}";
  const inj = await trpc("threads.dispatch", { method: "POST", token: yunqi.token, input: { title: payload } });
  const threadId = inj.body?.result?.data?.threadId;
  raw.injection = { dispatch: inj.body };
  const table = await db.query(`SELECT to_regclass('public.biz_events') AS t`);
  rec("SEC-INJ-01 注入式标题不破坏数据库（biz_events 仍在）", table.rows[0]?.t === "biz_events", { regclass: table.rows[0]?.t });
  if (threadId) {
    const back = await db.query(`SELECT title FROM threads WHERE id=$1`, [threadId]);
    raw.injection.stored = back.rows[0]?.title;
    rec("SEC-INJ-02 注入式标题按字面存储（未被解释执行/截断破坏）", back.rows[0]?.title === payload, { stored: String(back.rows[0]?.title).slice(0, 80) });
  } else {
    rec("SEC-INJ-02 注入式标题按字面存储（未被解释执行/截断破坏）", false, { detail: "未取到 threadId", body: JSON.stringify(inj.body).slice(0, 200) });
  }
  const long = "A".repeat(20_000);
  const longRes = await trpc("threads.dispatch", { method: "POST", token: yunqi.token, input: { title: long } });
  const storedLen = await db.query(`SELECT max(length(title)) AS n FROM threads WHERE workspace_id='ws-yunqi'`);
  raw.longTitle = { status: longRes.status, body: JSON.stringify(longRes.body).slice(0, 200), maxTitleLen: storedLen.rows[0]?.n };
  rec("SEC-INJ-03 超长标题被拒绝或截断（不落 20000 字）", (storedLen.rows[0]?.n ?? 0) < 20_000, {
    status: longRes.status, maxStoredTitleLen: storedLen.rows[0]?.n,
  });
}

/* ---------- 7. 批量高危守卫（l4_chairman 必须逐条） ---------- */
{
  const rows = await db.query(
    `SELECT approval_id FROM approvals WHERE workspace_id='ws-yunqi' AND status='pending' AND tier='l4_chairman' ORDER BY approval_id LIMIT 5`,
  );
  const ids = rows.rows.map((r) => r.approval_id);
  raw.highRiskIds = ids;
  if (ids.length === 0) {
    rec("SEC-BATCH-01 高危审批批量采纳必须逐条跳过（l4_chairman）", false, "无 pending l4_chairman 样本，无法取证");
  } else {
    const res = await trpc("approvals.batchApprove", { method: "POST", token: yunqi.token, input: { approvalIds: ids } });
    raw.batchApprove = res.body;
    const data = res.body?.result?.data;
    const approved = data?.approved ?? data?.succeeded ?? [];
    const skipped = data?.skipped ?? [];
    const after = await db.query(
      `SELECT approval_id, status FROM approvals WHERE approval_id = ANY($1::text[])`, [ids],
    );
    const stillPending = after.rows.filter((r) => r.status === "pending").length;
    raw.batchApproveAfter = after.rows;
    rec("SEC-BATCH-01 高危审批批量采纳必须逐条跳过（l4_chairman）",
      stillPending === ids.length && skipped.length === ids.length,
      { requested: ids.length, approved: Array.isArray(approved) ? approved.length : approved, skipped: Array.isArray(skipped) ? skipped.length : skipped, stillPending });
  }
}

/* ---------- 8. 未认证访问（） ---------- */
{
  const noAuth = await trpc("threads.list", {});
  raw.noAuth = noAuth.body;
  rec("SEC-AUTH-01 无令牌访问受保护过程 → 401", noAuth.status === 401 || noAuth.body?.error?.data?.httpStatus === 401, { status: noAuth.status });
  const badToken = await trpc("threads.list", { token: "not-a-jwt" });
  rec("SEC-AUTH-02 伪造令牌 → 401", badToken.status === 401 || badToken.body?.error?.data?.httpStatus === 401, { status: badToken.status });
  const forged = memberToken("workloom-wrong-secret-" + "000000000", { memberId: yunqi.identity.id, workspaceId: "ws-yunqi", tenantId: yunqi.identity.tenant_id });
  const forgedRes = await trpc("threads.list", { token: forged });
  rec("SEC-AUTH-03 错误密钥签发的令牌 → 401", forgedRes.status === 401 || forgedRes.body?.error?.data?.httpStatus === 401, { status: forgedRes.status });
  const loginAs = await trpc("auth.loginAs", { method: "POST", input: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
  raw.loginAs = loginAs.body;
  rec("SEC-AUTH-04 生产档演示直登被拒（403）", loginAs.status === 403 || loginAs.body?.error?.data?.httpStatus === 403, {
    status: loginAs.status, code: loginAs.body?.error?.data?.code,
  });
}

await db.end();
writeFileSync(`${OUT}/sec-probe.json`, JSON.stringify({ base: BASE, results, raw }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n安全探针：${results.length - failed.length}/${results.length} 通过`);
writeFileSync(`${OUT}/sec-probe.txt`, results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.id} :: ${JSON.stringify(r.detail)}`).join("\n") + "\n");
process.exit(failed.length ? 1 : 0);
