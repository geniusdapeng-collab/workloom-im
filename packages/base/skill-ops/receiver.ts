/**
 * skill-ops · 客户端接收器（方案 v0.2 §3.3，P0 核心编排）
 *
 * 流程：拉取 manifest（夜班窗口/手动立即同步）→ 定向匹配 → staging 五道预检 → 定级分流：
 *  - L0/L1 + silent 策略 → 热装载（技能库 upsert + 已装技能版本快照跟进）+ 角标留痕
 *  - L0/L1 + prompt 策略 → 入 staging 待人工装载
 *  - L2 → 入 staging + 审批提案（审批卡片直达手机，批准后 loadStaging 完成装载）
 *  - 预检不过 → rejected 留档，不进运行时
 * 回滚：装载前必落快照（skill_dist_snapshots），rollbackSkill 恢复上一版本。
 * 红线：一切动作进 biz_events 哈希链；装载仅更新技能库与已装快照——
 *      新技能的"安装即绑定围栏"仍走 installSkill 原流程（E8.1 冲突检测不旁路）。
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { runStagingChecks } from "./staging.js";
import { matchesTargets, compareVersions } from "./targeting.js";
import { getSilentMode } from "./policy.js";
import { DistManifest, DistMeta, type InstanceProfile, type SkillPackage, type StagingCheck } from "./types.js";
import { getSkill } from "../skills/registry.js";
import { setSkillScope, withSkillScope, rollbackSkills, releaseSkillClient } from "../skills/scope.js";

interface Scope { tenantId: string; workspaceId: string }

export class SkillOpsError extends Error {
  constructor(
    public readonly code: "DISABLED" | "NOT_FOUND" | "BAD_STATE" | "NOT_APPROVED" | "NO_SNAPSHOT" | "REGISTRY_UNREACHABLE",
    message: string,
  ) {
    super(message);
    this.name = "SkillOpsError";
  }
}

/* ---------- 事件留痕（与 skills/registry.ts 同口径；actor 支持系统身份——夜班自动同步归因 night-shift） ---------- */

/** 事件归因身份：人工同步=human:memberNo；夜班自动同步=system:night-shift（白名单系统组件） */
export interface EventActor { id: string; type: "human" | "system" }

async function emit(gateway: pg.Pool, scope: Scope, by: EventActor, decision: Record<string, unknown>, links?: string[]): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by.id, type: by.type },
  }, {
    who: { type: by.type, id: by.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: by.type === "system" ? "夜班" : "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

async function emitInTx(client: pg.PoolClient, scope: Scope, by: EventActor, decision: Record<string, unknown>): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by.id, type: by.type },
  }, {
    who: { type: by.type, id: by.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: by.type === "system" ? "夜班" : "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** by 字符串（人工成员号）→ EventActor 的兼容转换 */
const human = (memberNo: string): EventActor => ({ id: memberNo, type: "human" });

/* ---------- 拉取 ---------- */

export type ManifestFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: ManifestFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new SkillOpsError("REGISTRY_UNREACHABLE", `registry 不可达：HTTP ${res.status}`);
  return res.json();
};

/* ---------- 装载（事务内：快照 → 技能库 upsert → 已装快照跟进 → 事件） ---------- */

/** 下行命名空间只允许无私有属主的 official 行；隔离、team 和上架后保留属主的行不可被分发覆盖。 */
async function loadPackageInTx(client: pg.PoolClient, scope: Scope, pkg: SkillPackage, tier: string,
  by: EventActor, checks: StagingCheck[]): Promise<{ upgraded: boolean; previousVersion: string | null }> {
  if (pkg.skillId.startsWith("skill-t-")) throw new SkillOpsError("BAD_STATE", "团队技能命名空间禁止下行分发，须先抽象为公共技能 ID");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`skill-dist:${pkg.skillId}`]);
  const cur = await client.query(
    `SELECT s.*,i.installed_version,i.fence_bindings_snapshot FROM skills s
     LEFT JOIN skill_installs i ON i.skill_id=s.id AND i.workspace_id=$2
     WHERE s.id=$1 FOR UPDATE OF s`, [pkg.skillId,scope.workspaceId]);
  const prev = cur.rows[0] ?? null;
  if (prev && (prev.level !== "official" || prev.ownership_state !== "shared" || prev.owner_tenant_id !== null || prev.owner_workspace_id !== null)) {
    throw new SkillOpsError("BAD_STATE", "下行包不能覆盖私有、隔离或保留私有属主的技能");
  }
  if (prev && compareVersions(prev.version,pkg.version) > 0) throw new SkillOpsError("BAD_STATE", "当前公共技能版本已推进，拒绝旧包覆盖");
  const values = [pkg.skillId,pkg.name,pkg.version,pkg.description,JSON.stringify(pkg.fenceBindings),pkg.body,JSON.stringify(pkg.meta)];
  if (!prev) {
    const inserted = await client.query(
      `INSERT INTO skills (id,level,bundle,name,version,description,fence_bindings,body,desensitized,dist_meta)
       VALUES ($1,'official',NULL,$2,$3,$4,$5,$6,false,$7) ON CONFLICT (id) DO NOTHING RETURNING id`, values);
    if (inserted.rowCount !== 1) throw new SkillOpsError("BAD_STATE", "分发目标已被不可消费的资产占用，拒绝覆盖");
  }
  const snapId = `snap-${pkg.skillId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
  await client.query(
    `INSERT INTO skill_dist_snapshots (id,skill_id,workspace_id,skill_row,install_row,reason,loaded_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [snapId,pkg.skillId,scope.workspaceId,
     prev ? JSON.stringify({ ...prev,installed_version: undefined,fence_bindings_snapshot: undefined }) : null,
     prev?.installed_version ? JSON.stringify({ installed_version: prev.installed_version,fence_bindings_snapshot: prev.fence_bindings_snapshot }) : null,
     `装载 ${pkg.skillId}@${pkg.version}（${tier}）前自动快照`,pkg.version]);
  if (prev) {
    const updated = await client.query(
      `UPDATE skills SET name=$2,version=$3,description=$4,fence_bindings=$5,body=$6,dist_meta=$7
       WHERE id=$1 AND level='official' AND ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL`, values);
    if (updated.rowCount !== 1) throw new SkillOpsError("BAD_STATE", "分发目标归属在装载前变化");
  }
  await client.query(
    "UPDATE skill_installs SET installed_version=$3,fence_bindings_snapshot=$4 WHERE skill_id=$1 AND workspace_id=$2",
    [pkg.skillId,scope.workspaceId,pkg.version,JSON.stringify(pkg.fenceBindings)]);
  await emitInTx(client,scope,by,{
    action: tier === "L2" ? "skill.dist.approved_loaded" : "skill.dist.loaded",
    after: { skillId: pkg.skillId,name: pkg.name,version: pkg.version,tier,upgraded: !!prev,previousVersion: prev?.version ?? null,snapshotId: snapId },
    basis: [`staging 预检全过（${checks.map((c) => c.gate).join("/")}）`,"只装载公共 official 命名空间；新技能安装仍走 installSkill（MC-022/E8.1）"],
  });
  return { upgraded: !!prev,previousVersion: prev?.version ?? null };
}

/* ---------- 主流程：同步分发 ---------- */

export interface SyncResult {
  disabled?: boolean;
  manifestVersion?: string;
  matched: number;
  loaded: Array<{ skillId: string; version: string; tier: string }>;
  pending: Array<{ skillId: string; version: string; tier: string; stagingId: string; approvalId?: string }>;
  rejected: Array<{ skillId: string; version: string; reasons: string[] }>;
  skipped: Array<{ skillId: string; reason: string }>;
}

export async function syncDistribution(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  opts: {
    registryUrl: string; signingKey: string; instance: InstanceProfile; by: string;
    fetcher?: ManifestFetcher;
    depsAvailable?: (dep: string) => boolean;
    /** 事件归因身份：缺省 = human:by（人工同步）；夜班自动同步传 { id: "night-shift", type: "system" } */
    actor?: EventActor;
  },
): Promise<SyncResult> {
  // 未配置 registry 或签名密钥 = 分发功能整体禁用（不降级为跳过验签）
  if (!opts.registryUrl || !opts.signingKey) {
    return { disabled: true, matched: 0, loaded: [], pending: [], rejected: [], skipped: [] };
  }
  const fetcher = opts.fetcher ?? defaultFetcher;
  const actor: EventActor = opts.actor ?? human(opts.by);
  const raw = await fetcher(opts.registryUrl);
  const manifest = DistManifest.parse(raw); // schema 不合直接抛错（残缺资产不静默放行，与 official.ts 同纪律）

  const result: SyncResult = { manifestVersion: manifest.registryVersion, matched: 0, loaded: [], pending: [], rejected: [], skipped: [] };
  const silentMode = await getSilentMode(app, scope);

  for (const entry of manifest.entries) {
    const pkg = entry.package;
    if (!matchesTargets(entry.targets, opts.instance)) {
      result.skipped.push({ skillId: pkg.skillId, reason: "定向不匹配" });
      continue;
    }
    result.matched++;

    // 幂等：本机版本已 ≥ 分发版本 → 跳过（同版本重推不重复装载）
    const stagingId = `stg-v2.${Buffer.from(JSON.stringify([scope.tenantId,scope.workspaceId,pkg.skillId,pkg.version]),"utf8").toString("hex")}`;
    const curRow = await getSkill(app,pkg.skillId,scope);
    if (pkg.skillId.startsWith("skill-t-") || (curRow && (curRow.level !== "official" || curRow.ownership_state !== "shared"
        || curRow.owner_tenant_id !== null || curRow.owner_workspace_id !== null))) {
      const reasons = ["下行分发禁止占用私有、隔离或已上架团队技能的命名空间（MC-022）"];
      // 私有 ID 不进入 staging，避免旧下行缓存成为私有正文的读取旁路。
      if (!pkg.skillId.startsWith("skill-t-")) await upsertStaging(app,scope,{ stagingId,pkg,tier: "L0",checks: [{ gate: "schema_deps",pass: false,detail: reasons[0]! }],status: "rejected" });
      await emit(gateway,scope,actor,{ action: "skill.dist.rejected",after: { skillId: pkg.skillId,version: pkg.version,stagingId,reasons },basis: reasons });
      result.rejected.push({ skillId: pkg.skillId,version: pkg.version,reasons });
      continue;
    }
    if (curRow && compareVersions(curRow.version, pkg.version) >= 0) {
      result.skipped.push({ skillId: pkg.skillId, reason: `本机版本 ${curRow.version} 已不落后于分发版本` });
      continue;
    }
    const currentState = curRow
      ? { meta: DistMeta.parse(curRow.dist_meta ?? {}), fenceBindings: curRow.fence_bindings ?? [] }
      : null;

    // staging 五道预检
    const staging = runStagingChecks({ pkg, signingKey: opts.signingKey, current: currentState, depsAvailable: opts.depsAvailable });

    if (!staging.pass) {
      const reasons = staging.checks.filter((c) => !c.pass).map((c) => c.detail);
      await upsertStaging(app, scope, { stagingId, pkg, tier: staging.tier, checks: staging.checks, status: "rejected" });
      await emit(gateway, scope, actor, {
        action: "skill.dist.rejected",
        after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, reasons },
        basis: ["staging 预检不过不装载、不降级（方案 v0.2 §3.3）；留档供审计"],
      });
      result.rejected.push({ skillId: pkg.skillId, version: pkg.version, reasons });
      continue;
    }

    // 定级分流
    if (staging.tier === "L2") {
      // L2 永不静默：入 staging + 审批提案（幂等：同 staging 已有 pending 审批则复用）
      const existing = await withSkillScope(app,scope,(client) => client.query<{ approval_id: string | null }>(
        `SELECT approval_id FROM skill_dist_staging WHERE id=$1 AND status='pending'`, [stagingId]));
      let approvalId = existing.rows[0]?.approval_id ?? undefined;
      if (!approvalId) {
        const evId = await emit(gateway, scope, actor, {
          action: "skill.dist.pending_approval",
          after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, tier: "L2", diff: staging.diff },
          basis: ["L2 执行面/权限面变化永不静默，走审批（升级永不自动铁律）"],
        });
        approvalId = `apr-${evId.toLowerCase()}`;
        const client = await app.connect();
        try {
          await client.query("BEGIN");
          await setSkillScope(client, scope);
          await client.query(
            // tier='l4_chairman'：权限面扩张=董事长级人审（围栏放宽同层），
            // 必须显式指定——缺省 tier='l2_captain' 会被数字CEO队列节拍自动裁决，绕过 L2 永不静默红线
            `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
             VALUES ($1,$2,$3,$4,'inapp','pending',$5,'l4_chairman')`,
            [approvalId, scope.tenantId, scope.workspaceId, evId,
             JSON.stringify({ kind: "skill_dist_install", stagingId, skillId: pkg.skillId, version: pkg.version, high_risk: true })]);
          await client.query("COMMIT");
        } catch (err) {
          return await rollbackSkills(client, err);
        } finally {
          releaseSkillClient(client);
        }
      }
      await upsertStaging(app, scope, { stagingId, pkg, tier: "L2", checks: staging.checks, status: "pending", approvalId });
      result.pending.push({ skillId: pkg.skillId, version: pkg.version, tier: "L2", stagingId, approvalId });
      continue;
    }

    // L0/L1：silent → 立即热装载；prompt → 入 staging 待人工
    if (silentMode === "prompt") {
      await upsertStaging(app, scope, { stagingId, pkg, tier: staging.tier, checks: staging.checks, status: "pending" });
      await emit(gateway, scope, actor, {
        action: "skill.dist.staged",
        after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, tier: staging.tier },
        basis: ["静默策略=prompt：L0/L1 入 staging 待人工装载（提示后升级）"],
      });
      result.pending.push({ skillId: pkg.skillId, version: pkg.version, tier: staging.tier, stagingId });
      continue;
    }

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await setSkillScope(client, scope);
      await loadPackageInTx(client, scope, pkg, staging.tier, actor, staging.checks);
      await client.query(
        `INSERT INTO skill_dist_staging (id, skill_id, workspace_id, tier, package, checks, status, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,'loaded',now())
         ON CONFLICT (id) DO UPDATE SET status='loaded', decided_at=now(), checks=$6, package=$5, tier=$4`,
        [stagingId, pkg.skillId, scope.workspaceId, staging.tier, JSON.stringify(pkg), JSON.stringify(staging.checks)]);
      await client.query("COMMIT");
    } catch (err) {
      return await rollbackSkills(client, err);
    } finally {
      releaseSkillClient(client);
    }
    result.loaded.push({ skillId: pkg.skillId, version: pkg.version, tier: staging.tier });
  }

  // 同步游标 + 总事件
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await setSkillScope(client, scope);
    await client.query(
      `INSERT INTO skill_dist_state (workspace_id, last_manifest_version, last_sync_at)
       VALUES ($1,$2,now())
       ON CONFLICT (workspace_id) DO UPDATE SET last_manifest_version=$2, last_sync_at=now()`,
      [scope.workspaceId, manifest.registryVersion]);
    await client.query("COMMIT");
  } catch (err) {
    return await rollbackSkills(client, err);
  } finally {
    releaseSkillClient(client);
  }
  await emit(gateway, scope, actor, {
    action: "skill.dist.sync",
    after: {
      manifestVersion: manifest.registryVersion,
      matched: result.matched, loaded: result.loaded.length,
      pending: result.pending.length, rejected: result.rejected.length, skipped: result.skipped.length,
    },
    basis: ["下行分发同步完成（拉取为主通道；夜班窗口/手动立即同步同路径）"],
  });
  return result;
}

async function upsertStaging(
  app: pg.Pool, scope: Scope,
  row: { stagingId: string; pkg: SkillPackage; tier: string; checks: StagingCheck[]; status: string; approvalId?: string },
): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await setSkillScope(client, scope);
    await client.query(
      `INSERT INTO skill_dist_staging (id, skill_id, workspace_id, tier, package, checks, status, approval_id, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7='rejected' THEN now() ELSE NULL END)
       ON CONFLICT (id) DO UPDATE SET tier=$4, package=$5, checks=$6, status=$7,
         approval_id=COALESCE($8, skill_dist_staging.approval_id),
         decided_at=CASE WHEN $7='rejected' THEN now() ELSE skill_dist_staging.decided_at END`,
      [row.stagingId, row.pkg.skillId, scope.workspaceId, row.tier,
       JSON.stringify(row.pkg), JSON.stringify(row.checks), row.status, row.approvalId ?? null]);
    await client.query("COMMIT");
  } catch (err) {
    return await rollbackSkills(client, err);
  } finally {
    releaseSkillClient(client);
  }
}

/* ---------- 人工装载（prompt 策略项 / L2 审批通过项） ---------- */

export async function loadStaging(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { stagingId: string; by: string },
): Promise<{ skillId: string; version: string; tier: string }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await setSkillScope(client, scope);
    const r = await client.query<{
      id: string; skill_id: string; tier: string; package: SkillPackage;
      checks: StagingCheck[]; status: string; approval_id: string | null;
    }>(`SELECT * FROM skill_dist_staging WHERE id=$1 FOR UPDATE`, [input.stagingId]);
    const row = r.rows[0];
    if (!row) throw new SkillOpsError("NOT_FOUND", `staging 项 ${input.stagingId} 不存在`);
    if (row.status === "loaded") {
      await client.query("COMMIT");
      return { skillId: row.skill_id, version: row.package.version, tier: row.tier }; // 幂等
    }
    if (row.status !== "pending") {
      throw new SkillOpsError("BAD_STATE", `staging 项状态 ${row.status}，仅 pending 可装载`);
    }
    if (row.tier === "L2") {
      // L2 必须审批已通过（approvalRef 验真口径同段③：查无此行/状态不符一律拒绝）
      if (!row.approval_id) throw new SkillOpsError("NOT_APPROVED", "L2 staging 项缺审批单，拒绝装载");
      const ap = await client.query<{ status: string }>(
        `SELECT status FROM approvals WHERE approval_id=$1`, [row.approval_id]);
      if (ap.rows[0]?.status !== "approved") {
        throw new SkillOpsError("NOT_APPROVED", `审批单 ${row.approval_id} 状态 ${ap.rows[0]?.status ?? "不存在"}，L2 装载须审批通过（升级永不自动）`);
      }
    }
    const pkg = row.package;
    await loadPackageInTx(client, scope, pkg, row.tier, human(input.by), row.checks ?? []);
    await client.query(`UPDATE skill_dist_staging SET status='loaded', decided_at=now() WHERE id=$1`, [input.stagingId]);
    await client.query("COMMIT");
    return { skillId: row.skill_id, version: pkg.version, tier: row.tier };
  } catch (err) {
    return await rollbackSkills(client, err);
  } finally { releaseSkillClient(client); }
}

/* ---------- 回滚 ---------- */

export async function rollbackSkill(app: pg.Pool,gateway: pg.Pool,scope: Scope,
  input: { skillId: string; by: string }): Promise<{ restoredVersion: string | null; snapshotId: string }> {
  void gateway;
  interface SnapRow {
    id: string;loaded_version: string | null;
    skill_row: { id: string;level: string;bundle: string | null;name: string;version: string;description: string;
      fence_bindings: string[];body: string;desensitized: boolean;dist_meta: unknown;
      ownership_state?: string;owner_tenant_id?: string | null;owner_workspace_id?: string | null } | null;
    install_row: { installed_version: string;fence_bindings_snapshot: string[] } | null;
  }
  if (input.skillId.startsWith("skill-t-")) throw new SkillOpsError("BAD_STATE","私有技能命名空间不允许分发回滚");
  return withSkillScope(app,scope,async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`skill-dist:${input.skillId}`]);
    const snap = (await client.query<SnapRow>(
      `SELECT id,skill_row,install_row,loaded_version FROM skill_dist_snapshots WHERE skill_id=$1
       ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [input.skillId])).rows[0];
    if (!snap) throw new SkillOpsError("NO_SNAPSHOT","技能无可用公共分发快照");
    const current = (await client.query("SELECT * FROM skills WHERE id=$1 FOR UPDATE",[input.skillId])).rows[0];
    const previous = snap.skill_row;
    if (!current || current.level !== "official" || current.ownership_state !== "shared"
        || current.owner_tenant_id !== null || current.owner_workspace_id !== null
        || (previous && (previous.id !== input.skillId || previous.level !== "official"
          || (previous.ownership_state ?? "shared") !== "shared" || previous.owner_tenant_id != null || previous.owner_workspace_id != null))) {
      throw new SkillOpsError("BAD_STATE","回滚只恢复公共 official 资产，私有/隔离快照必须保留并由人工核对");
    }
    if (!snap.loaded_version || current.version !== snap.loaded_version) {
      throw new SkillOpsError("BAD_STATE","公共技能已由另一装载推进或历史快照缺版本证据，拒绝陈旧回滚");
    }
    if (previous) {
      const restored = await client.query(
        `UPDATE skills SET bundle=$2,name=$3,version=$4,description=$5,fence_bindings=$6,body=$7,desensitized=$8,dist_meta=$9
         WHERE id=$1 AND level='official' AND ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL`,
        [previous.id,previous.bundle,previous.name,previous.version,previous.description,
         JSON.stringify(previous.fence_bindings ?? []),previous.body,previous.desensitized,JSON.stringify(previous.dist_meta ?? {})]);
      if (restored.rowCount !== 1) throw new SkillOpsError("BAD_STATE","回滚目标归属已经变化");
    }
    if (snap.install_row) {
      await client.query("UPDATE skill_installs SET installed_version=$3,fence_bindings_snapshot=$4 WHERE skill_id=$1 AND workspace_id=$2",
        [input.skillId,scope.workspaceId,snap.install_row.installed_version,JSON.stringify(snap.install_row.fence_bindings_snapshot)]);
    } else {
      await client.query("DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2",[input.skillId,scope.workspaceId]);
    }
    // 在目标仍可见时消费公共快照；随后若 FK 或事件失败，整笔事务会恢复该快照。
    const consumed = await client.query("DELETE FROM skill_dist_snapshots WHERE id=$1",[snap.id]);
    if (consumed.rowCount !== 1) throw new SkillOpsError("BAD_STATE","回滚快照归属已经变化");
    if (!previous) {
      try { await client.query("DELETE FROM skills WHERE id=$1",[input.skillId]); }
      catch (error) {
        if ((error as { code?: string }).code === "23503") throw new SkillOpsError("BAD_STATE","公共技能仍被其他安装或历史审核引用，拒绝移除并保留快照");
        throw error;
      }
    }
    await emitInTx(client,scope,human(input.by),{ action: "skill.dist.rollback",
      after: { skillId: input.skillId,snapshotId: snap.id,restoredVersion: previous?.version ?? null },
      basis: ["公共分发资产与本工作区安装快照同一事务恢复；旧私有资产和其他工作区状态保留（MC-022）"] });
    return { restoredVersion: previous?.version ?? null,snapshotId: snap.id };
  });
}

/* ---------- 状态查询（技能中心 + 通栏通知投影） ---------- */

export async function distStatus(app: pg.Pool, scope: Scope) {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await setSkillScope(client, scope);
    const staging = await client.query(
      `SELECT id, skill_id, tier, status, approval_id, created_at, decided_at,
              package->>'name' AS name, package->>'version' AS version
       FROM skill_dist_staging ORDER BY created_at DESC LIMIT 50`);
    const policy = await client.query(
      `SELECT silent_mode, auto_sync, updated_by, updated_at FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    const state = await client.query(
      `SELECT last_manifest_version, last_sync_at FROM skill_dist_state WHERE workspace_id=$1`, [scope.workspaceId]);
    // 通栏通知数据源①：近 24h 装载事件（静默/审批装载；auto=系统归因即夜班自动）
    const loaded = await client.query<{
      skillId: string; name: string; version: string; tier: string; at: Date; auto: boolean;
    }>(
      `SELECT payload->'decision'->'after'->>'skillId' AS "skillId",
              payload->'decision'->'after'->>'name' AS name,
              payload->'decision'->'after'->>'version' AS version,
              payload->'decision'->'after'->>'tier' AS tier,
              created_at AS at,
              (payload->'who'->>'type' = 'system') AS auto
       FROM biz_events
       WHERE workspace_id=$1
         AND payload->'decision'->>'action' IN ('skill.dist.loaded','skill.dist.approved_loaded')
         AND created_at > now() - interval '24 hours'
       ORDER BY created_at DESC LIMIT 10`, [scope.workspaceId]);
    // 通栏通知数据源②：待审批/待装载计数（L2 审批提案 + prompt 待装载）
    const pending = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM skill_dist_staging WHERE status='pending'`);
    await client.query("COMMIT");
    return {
      staging: staging.rows,
      silentMode: policy.rows[0]?.silent_mode ?? "silent",
      autoSync: policy.rows[0]?.auto_sync ?? true,
      policyUpdatedBy: policy.rows[0]?.updated_by ?? null,
      lastManifestVersion: state.rows[0]?.last_manifest_version ?? null,
      lastSyncAt: state.rows[0]?.last_sync_at ?? null,
      recentLoaded: loaded.rows,
      pendingCount: Number(pending.rows[0]?.c ?? 0),
    };
  } catch (err) {
    return await rollbackSkills(client, err);
  } finally { releaseSkillClient(client); }
}
