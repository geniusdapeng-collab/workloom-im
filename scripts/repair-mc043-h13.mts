/**
 * MC-043 / H-13 复现：onboarding 夹具若把工作区永久翻到 dataMode=real，
 * 后续 Quest 会拿不到模拟回执、线程被判 failed。夹具的写入必须在 finally 复位。
 *
 *   node --import tsx scripts/repair-mc043-h13.mts <before|after> <DATABASE_URL>
 *
 * before：模拟「门禁放行」把 profiles.archive.dataMode 写成 real 且不复位 →
 *         第二个写入者看到的仍是 real，H-13 之后的所有用例被连坐。非零退出。
 * after ：同一写入在 finally 中按原字节复位 → 第二个观察者看到 simulated，
 *         且 archive 与复位前逐字节相同。两个观察者都成立才算绿。
 */
import pg from "pg";

const mode = process.argv[2];
// 私有集群 URL 由包装器经 DATABASE_URL 注入；绝不接受共享库地址。
const url = process.argv[3] ?? process.env.DATABASE_URL;
if (!["before", "after"].includes(mode ?? "") || !url) {
  console.error("usage: repair-mc043-h13.mts <before|after> [DATABASE_URL]");
  process.exit(2);
}
if (!/tmp%2Fwl-|tmp\/wl-/.test(url)) {
  console.error("refusing: DATABASE_URL is not a runner-owned private Unix socket");
  process.exit(2);
}

const workspaceId = `mc043-h13-${mode}`;
const tenantId = `mc043-tenant-${mode}`;
const client = new pg.Client({ connectionString: url });
await client.connect();
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
const dataMode = async () => (await client.query("SELECT archive->>'dataMode' AS m FROM profiles WHERE workspace_id=$1", [workspaceId])).rows[0]?.m;

/** 与 scripts/suite.ts 的 H-13 夹具同形：写入向导档案并尝试 activateRealMode。 */
async function activateRealModeFixture(): Promise<void> {
  await client.query(`UPDATE profiles SET archive = jsonb_set(archive, '{dataMode}', '"real"'), updated_at = now() WHERE workspace_id=$1`, [workspaceId]);
}

try {
  await client.query("INSERT INTO tenants(id,name) VALUES($1,'MC-043 probe') ON CONFLICT (id) DO NOTHING", [tenantId]);
  await client.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'MC-043 probe',$1,'synthetic') ON CONFLICT (id) DO NOTHING", [workspaceId, tenantId]);
  await client.query(`INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'synthetic','{"dataMode":"simulated","purpose":"MC-043 probe"}'::jsonb)
    ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive`, [workspaceId, tenantId]);

  const before = (await client.query("SELECT archive FROM profiles WHERE workspace_id=$1", [workspaceId])).rows[0].archive;
  check(before.dataMode === "simulated", `夹具起点是模拟运行态（dataMode=${before.dataMode}）`);

  if (mode === "before") {
    await activateRealModeFixture(); // 没有 finally：写死在 real
    const after = await dataMode();
    check(after === "real", `无复位时工作区被永久翻到 real（dataMode=${after}）`);
  } else {
    try {
      await activateRealModeFixture();
      check((await dataMode()) === "real", "门禁放行时写入确实发生了（复现负例场景）");
    } finally {
      await client.query("UPDATE profiles SET archive=$2::jsonb, updated_at=now() WHERE workspace_id=$1", [workspaceId, JSON.stringify(before)]);
    }
    const after = await dataMode();
    check(after === "simulated", `复位后工作区回到模拟运行态（dataMode=${after}）`);
    const restored = (await client.query("SELECT archive FROM profiles WHERE workspace_id=$1", [workspaceId])).rows[0].archive;
    check(JSON.stringify(restored) === JSON.stringify(before), "archive 按原字节还原，后续用例不再被连坐");
  }
} finally {
  await client.end();
}

console.log(JSON.stringify({ mode, failures: failures.length, result: failures.length ? "fail" : "pass" }));
process.exitCode = failures.length ? 1 : 0;
