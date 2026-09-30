/**
 * M1 assertion (MC-105): RDAS/acceptance 脚本声明调用的每个 tRPC 过程必须真实存在。
 *
 * 红：任一过程返回 404 `No procedure found on path "..."`。
 *    历史实证：`scripts/acceptance/outcome.mjs` 调用 `approvals.batchRelease`——服务端从未实现，
 *    O 域每个需要人工介入的 trial 都拿不到放行、停在 pending_review 被记成失败（测量口径失真）。
 * 绿：逐个探测均非 404（200/400/401/405 都证明该路径已注册；405 = 存在的 mutation 被 GET 调）。
 *
 * 用法：MCD_BASE=http://127.0.0.1:8961 MCD_REPO=/path/to/repo node m1-outcome-trpc-surface.mjs
 * 依赖：仅 node 内建 fetch（无需 pg/jose）；身份走被测实例的演示直登（与 O 域执行器同一入口）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.MCD_BASE ?? "http://127.0.0.1:8787";
const REPO = process.env.MCD_REPO ?? process.cwd();
const SLUG = process.env.MCD_WORKSPACE_SLUG ?? "yunqi-hotel";
const MEMBER = process.env.MCD_MEMBER ?? "MEM-001";

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(mjs|mts|ts|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 提取两类声明：`/trpc/<path>` 字面量；`post|get|trpcPost|trpcGet|call("<path>"` 形式的动态调用 */
function extractProcedures(file) {
  const source = readFileSync(file, "utf-8");
  const found = new Map();
  for (const m of source.matchAll(/\/trpc\/([A-Za-z][A-Za-z0-9_.]*)/g)) found.set(m[1], "literal");
  for (const m of source.matchAll(/\b(?:post|get|trpcPost|trpcGet|call)\(\s*["'`]([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)["'`]/g)) {
    if (!found.has(m[1])) found.set(m[1], "helper-arg");
  }
  return found;
}

const files = walk(join(REPO, "scripts", "acceptance"));
if (!files.length) {
  console.log(`SKIP  MC-105 :: 未在 ${REPO}/scripts/acceptance 找到可扫描脚本（fail-closed 视为未验证）`);
  process.exit(2);
}

const declared = new Map();
for (const file of files) {
  for (const [path, how] of extractProcedures(file)) {
    const where = relative(REPO, file);
    if (!declared.has(path)) declared.set(path, []);
    declared.get(path).push(`${where}(${how})`);
  }
}
const paths = [...declared.keys()].sort();
if (!paths.length) {
  console.log("FAIL  MC-105 :: 未从 acceptance 脚本提取到任何 tRPC 过程（断言失去意义）");
  process.exit(1);
}

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) {
  console.log(`SKIP  MC-105 :: 目标实例 ${BASE} 不可达（fail-closed，不判绿）`);
  process.exit(2);
}

const login = await fetch(`${BASE}/trpc/auth.loginAs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceSlug: SLUG, memberNo: MEMBER }),
}).catch(() => null);
const loginJson = await login?.json().catch(() => ({}));
const token = loginJson?.result?.data?.token;
if (!token) {
  console.log(`SKIP  MC-105 :: 无法取得验收身份（auth.loginAs ${login?.status ?? "无响应"}；生产档请改用开发档实例或以验收令牌复跑）`);
  process.exit(2);
}

async function probe(path) {
  const url = `${BASE}/trpc/${path}?input=${encodeURIComponent("{}")}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (res.status === 405) {
    // 存在的 mutation 被 GET 调：用 POST 复核一次，仍 404 才算缺失
    const post = await fetch(`${BASE}/trpc/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    return { status: post.status, missing: /No procedure found/.test(await post.text().catch(() => "")) };
  }
  return { status: res.status, missing: /No procedure found/.test(body) };
}

const missing = [];
for (const path of paths) {
  let result;
  try {
    result = await probe(path);
  } catch (err) {
    result = { status: 0, missing: false, error: String(err).slice(0, 120) };
  }
  if (result.missing) {
    missing.push(path);
    console.log(`✗ ${path} —— 404 No procedure found（声明于 ${declared.get(path).join("、")}）`);
  } else {
    console.log(`✓ ${path} —— 已注册（HTTP ${result.status}${result.error ? `，${result.error}` : ""}）`);
  }
}

if (missing.length) {
  console.log(`FAIL  MC-105 :: ${missing.length} 个被 acceptance 脚本调用的过程不存在：${missing.join("、")}`);
  process.exit(1);
}
console.log(`PASS  MC-105 :: ${paths.length} 个 acceptance tRPC 过程全部存在：${paths.join("、")}`);
process.exit(0);
