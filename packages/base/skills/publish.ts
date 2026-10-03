/**
 * skills · industry 上架门禁（D15 五机制位，第 9 轮）
 *
 * ① 上架脱敏扫描：maskText PII 检测 + 敏感凭据词清单，正文/描述命中即拒
 * ③ 供应链注入评估：提示词注入模式扫描（覆盖/泄露/外发三类），命中即拒
 * ② 审核流水线：提案（事件留痕）→ 两名不同成员复核（禁止自批）→ 完成上架
 * ④ 全局吊销：kill switch，installSkill 与 resolveAgentFenceBindings 双点排除
 * ⑤ 版本通道：安装时版本快照 vs 当前版本，列示可更新技能
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";
import type { SkillRow } from "./registry.js";
import { withSkillScope } from "./scope.js";
/** 本地 Scope（与 registry.Scope 同构；避免 registry↔publish 循环依赖） */
export interface Scope { tenantId: string; workspaceId: string }

/** 上架门禁错误（code 与 SkillError 同口径） */
export class PublishError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/* ================= ① 脱敏扫描 ================= */

/** 敏感凭据词清单（正文/描述出现即拒——无论是否被 PII 正则命中） */
const SENSITIVE_TERMS = [
  "api_key", "apikey", "secret_key", "access_token", "private_key", "password",
  "passwd", "aksk", "secret=", "token=", "-----BEGIN", "密码", "密钥", "凭据", "内网IP",
];

export interface ScanHit { kind: "pii" | "sensitive_term" | "injection"; detail: string }

/** ① 上架脱敏扫描：返回命中清单（空=通过） */
export function scanSkillForPublish(body: string, description = ""): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const [label, text] of [["正文", body], ["描述", description]] as const) {
    const masked = maskText(text);
    if (masked.hits > 0) hits.push({ kind: "pii", detail: `${label}含 ${masked.hits} 处 PII（手机号/身份证/银行卡/邮箱等）` });
    const lower = text.toLowerCase();
    for (const term of SENSITIVE_TERMS) {
      if (lower.includes(term.toLowerCase())) {
        hits.push({ kind: "sensitive_term", detail: `${label}含敏感词「${term}」` });
      }
    }
  }
  return hits;
}

/* ================= ③ 供应链注入评估 ================= */

/** 提示词注入模式（三类：覆盖指令 / 窃取泄露 / 数据外发） */
const INJECTION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /忽略(以上|之前|先前|所有).*指令/i, detail: "覆盖指令：要求忽略先前指令" },
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, detail: "覆盖指令：ignore previous instructions" },
  { re: /你(现在)?是(一个)?(不受限制|无审查|全新)/i, detail: "覆盖指令：人格覆盖" },
  { re: /(jailbreak|DAN\s+mode|do\s+anything\s+now)/i, detail: "覆盖指令：越狱模式" },
  { re: /(读取|获取|打印|输出).*(环境变量|env\b|process\.env)/i, detail: "窃取泄露：读取环境变量" },
  { re: /(泄露|发送|上传|回传).*(密钥|凭据|token|secret|password)/i, detail: "窃取泄露：凭据外泄" },
  { re: /(exfiltrate|leak)/i, detail: "窃取泄露：exfiltrate/leak" },
  { re: /(密钥|凭据|token|secret|password).{0,12}(发送|上传|回传|外发|到外部)/i, detail: "窃取泄露：凭据外发" },
  { re: /(curl|wget|fetch|http\.post).{0,40}https?:\/\/(?!(registry\.npmjs\.org|github\.com))/i, detail: "数据外发：指示对外发起网络请求" },
  { re: /(发送|POST).{0,20}(到|至).{0,20}(外部|第三方|远程)服务/i, detail: "数据外发：发送至外部服务" },
  { re: /绕过?(围栏|审批|权限|安全检查)/i, detail: "越权诱导：绕过围栏/审批" },
  { re: /bypass\s+(fence|approval|permission|security)/i, detail: "越权诱导：bypass fence/approval" },
];

/** ③ 供应链注入评估：返回命中清单（空=通过） */
export function scanSkillForInjection(body: string): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const { re, detail } of INJECTION_PATTERNS) {
    if (re.test(body)) hits.push({ kind: "injection", detail });
  }
  return hits;
}

/** 上架前完整门禁（①+③）：命中即抛 PUBLISH_SCAN_FAILED */
export function assertPublishable(body: string, description = ""): void {
  const hits = [...scanSkillForPublish(body, description), ...scanSkillForInjection(body)];
  if (hits.length > 0) {
    throw new PublishError(
      "PUBLISH_SCAN_FAILED",
      `上架扫描未通过（D15-①/③）：${hits.map((h) => h.detail).join("；")}`,
    );
  }
}

/* ================= ② 审核流水线 ================= */

interface PublishReviewRow {
  id: string; skill_id: string; from_workspace_id: string; proposed_by: string;
  status: "pending" | "approved" | "rejected" | "completed";
  approvals: Array<{ member_no: string; gesture: string; at: string }>;
  required_approvals: number; reason: string | null;
  reviewed_version: string | null; reviewed_body: string | null; reviewed_description: string | null;
  reviewed_name: string | null; reviewed_fence_bindings: string[] | null;
}
function sameSnapshot(review: PublishReviewRow, skill: SkillRow): boolean {
  return review.reviewed_version === skill.version && review.reviewed_body === skill.body
    && review.reviewed_description === skill.description && review.reviewed_name === skill.name
    && JSON.stringify(review.reviewed_fence_bindings) === JSON.stringify(skill.fence_bindings);
}
/** 与提案共用 skill → review 锁顺序，草稿迭代/提案与审批完成并发时不反向占锁。 */
async function lockReview(client: pg.PoolClient, id: string): Promise<PublishReviewRow> {
  const initial = (await client.query<PublishReviewRow>("SELECT * FROM skill_publish_reviews WHERE id=$1", [id])).rows[0];
  if (!initial) throw new PublishError("NOT_FOUND", "上架审核单不存在或不属于本工作区");
  await client.query("SELECT id FROM skills WHERE id=$1 FOR UPDATE", [initial.skill_id]);
  const review = (await client.query<PublishReviewRow>("SELECT * FROM skill_publish_reviews WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!review) throw new PublishError("NOT_FOUND", "上架审核单已发生变化");
  return review;
}
async function privateSkill(client: pg.PoolClient, scope: Scope, id: string, lock = false): Promise<SkillRow> {
  const r = await client.query<SkillRow>(
    `SELECT * FROM skills WHERE id=$1 AND level='team' AND ownership_state='owned'
     AND owner_tenant_id=$2 AND owner_workspace_id=$3 ${lock ? "FOR UPDATE" : ""}`,
    [id,scope.tenantId,scope.workspaceId]);
  if (!r.rows[0]) throw new PublishError("NOT_FOUND", "技能不存在或非本租户、本工作区私有草稿");
  return r.rows[0];
}
async function publishEvent(client: pg.PoolClient, scope: Scope, by: string, object: { type: string; id: string },
  action: string, after: Record<string, unknown>): Promise<void> {
  await gatewayAppendOnClient(client, { ...scope, actor: { id: by, type: "human" } }, {
    who: { type: "human",id: by },
    context: { tenant_id: scope.tenantId,workspace_id: scope.workspaceId,time: new Date().toISOString() },
    object,decision: { action,after },rule_impact: [],
  });
}

/** 审核单快照来自锁定的实际私有行；调用方不能用干净文本替不干净的数据库正文申请上架。 */
export async function proposePublish(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; skillName: string; body: string; description: string; by: string },
): Promise<{ reviewId: string; deduped: boolean }> {
  void gateway;
  return withSkillScope(app, scope, async (client) => {
    const skill = await privateSkill(client,scope,input.skillId,true);
    assertPublishable(skill.body,`${skill.description}\n${skill.name}`);
    if (input.body !== skill.body || input.description !== skill.description || input.skillName !== skill.name) {
      throw new PublishError("PUBLISH_SCAN_FAILED", "提案内容与当前技能不一致，请基于当前草稿重新预览并提案");
    }
    const pending = (await client.query<PublishReviewRow>(
      "SELECT * FROM skill_publish_reviews WHERE skill_id=$1 AND status='pending'", [skill.id])).rows;
    const dup = pending.find((row) => sameSnapshot(row,skill));
    if (dup) return { reviewId: dup.id,deduped: true };
    for (const stale of pending) {
      await client.query("UPDATE skill_publish_reviews SET status='rejected',reason='content_changed_before_review',decided_at=now() WHERE id=$1 AND status='pending'", [stale.id]);
      await publishEvent(client,scope,input.by,{ type: "skill_publish_review",id: stale.id },
        "skill.publish.supersede",{ reviewId: stale.id,skillId: skill.id,reason: "content_changed_before_review" });
    }
    const count = await client.query<{ c: string }>("SELECT count(*) AS c FROM skill_publish_reviews WHERE skill_id=$1", [skill.id]);
    const reviewId = `pub-${skill.id}-${Number(count.rows[0]!.c) + 1}`;
    await client.query(
      `INSERT INTO skill_publish_reviews (id,skill_id,from_workspace_id,proposed_by,reviewed_version,reviewed_body,reviewed_description,reviewed_name,reviewed_fence_bindings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [reviewId,skill.id,scope.workspaceId,input.by,skill.version,skill.body,skill.description,skill.name,JSON.stringify(skill.fence_bindings)]);
    await publishEvent(client,scope,input.by,{ type: "skill",id: skill.id },"skill.publish.propose",
      { reviewId,skillName: skill.name,version: skill.version });
    return { reviewId,deduped: false };
  });
}

export async function reviewPublish(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { reviewId: string; by: string; gesture: "approve" | "reject"; reason?: string },
): Promise<{ status: string; deduped: boolean }> {
  void gateway;
  return withSkillScope(app,scope,async (client) => {
    const row = await lockReview(client,input.reviewId);
    if (row.status !== "pending") return { status: row.status,deduped: true };
    const skill = await privateSkill(client,scope,row.skill_id);
    if (!sameSnapshot(row,skill)) throw new PublishError("NOT_APPROVED", "技能内容已变化或历史审核单缺快照，须重新提案复核");
    if (row.proposed_by === input.by) throw new PublishError("SELF_REVIEW_FORBIDDEN", `提案人 ${input.by} 禁止自批（D15-②）`);
    if (row.approvals.some((a) => a.member_no === input.by)) throw new PublishError("DUPLICATE_REVIEW", `成员 ${input.by} 已复核过本单`);
    if (input.gesture === "reject" && !input.reason?.trim()) throw new PublishError("EMPTY_REASON", "驳回必须填写原因");
    const approvals = [...row.approvals,{ member_no: input.by,gesture: input.gesture,at: new Date().toISOString() }];
    const approvedCount = new Set(approvals.filter((a) => a.gesture === "approve" && a.member_no !== row.proposed_by).map((a) => a.member_no)).size;
    const status = input.gesture === "reject" ? "rejected" : approvedCount >= Math.max(2,row.required_approvals) ? "approved" : "pending";
    await client.query(
      `UPDATE skill_publish_reviews SET approvals=$2,status=$3,reason=$4,
         decided_at=CASE WHEN $3 IN ('approved','rejected') THEN now() ELSE NULL END WHERE id=$1`,
      [row.id,JSON.stringify(approvals),status,input.reason ?? null]);
    await publishEvent(client,scope,input.by,{ type: "skill_publish_review",id: row.id },
      `skill.publish.${input.gesture}`,{ status,approvals: approvedCount,required: Math.max(2,row.required_approvals),reason: input.reason ?? null });
    return { status,deduped: false };
  });
}

/** 上架时再次锁定和扫描实际行，只有完整双人快照审核通过的当前版本可改为共享。 */
export async function completePublish(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { reviewId: string; by: string }): Promise<{ skillId: string }> {
  void gateway;
  return withSkillScope(app,scope,async (client) => {
    const row = await lockReview(client,input.reviewId);
    if (row.status === "completed") return { skillId: row.skill_id };
    const approves = new Set(row.approvals.filter((a) => a.gesture === "approve" && a.member_no !== row.proposed_by).map((a) => a.member_no));
    if (row.status !== "approved" || approves.size < Math.max(2,row.required_approvals)) {
      throw new PublishError("NOT_APPROVED", "上架须由两名不同的非提案成员复核通过");
    }
    const skill = await privateSkill(client,scope,row.skill_id,true);
    if (!sameSnapshot(row,skill)) throw new PublishError("NOT_APPROVED", "审核后内容已变化或历史审核缺快照，当前正文不得共享");
    assertPublishable(skill.body,`${skill.description}\n${skill.name}`);
    const updated = await client.query(
      "UPDATE skills SET level='industry',desensitized=true,ownership_state='shared' WHERE id=$1 AND level='team' AND ownership_state='owned'", [skill.id]);
    if (updated.rowCount !== 1) throw new PublishError("NOT_APPROVED", "上架前技能归属或状态已变化");
    await client.query("UPDATE skill_publish_reviews SET status='completed',decided_at=now() WHERE id=$1", [row.id]);
    await publishEvent(client,scope,input.by,{ type: "skill",id: skill.id },"skill.publish.complete",
      { reviewId: row.id,level: "industry",desensitized: true,version: skill.version });
    return { skillId: skill.id };
  });
}

/** 特权函数也验证真实工作区与技能 owner；吊销行与事件仍同一事务。 */
export async function revokeSkill(app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; reason: string; by: string }): Promise<{ deduped: boolean }> {
  void gateway;
  if (!input.reason?.trim()) throw new PublishError("EMPTY_REASON", "吊销必须填写原因");
  return withSkillScope(app,scope,async (client) => {
    const result = await client.query<{ skill_revoke: boolean }>("SELECT public.skill_revoke($1,$2,$3)", [input.skillId,input.reason,input.by]);
    if (result.rows[0]?.skill_revoke !== true) return { deduped: true };
    await publishEvent(client,scope,input.by,{ type: "skill",id: input.skillId },"skill.revoke",{ reason: input.reason,scope: "global" });
    return { deduped: false };
  });
}
export async function isSkillRevoked(app: pg.Pool, skillId: string): Promise<boolean> {
  return (await app.query("SELECT 1 FROM skill_revocations WHERE skill_id=$1", [skillId])).rowCount !== 0;
}
export interface SkillUpdate { skillId: string; name: string; installedVersion: string; currentVersion: string }
export async function listSkillUpdates(app: pg.Pool, scope: Scope): Promise<SkillUpdate[]> {
  return withSkillScope(app,scope,async (client) => {
    const rows = (await client.query<{ skill_id: string; name: string; installed_version: string; version: string }>(
      `SELECT si.skill_id,s.name,si.installed_version,s.version FROM skill_installs si JOIN skills s ON s.id=si.skill_id
       WHERE si.workspace_id=$1 AND si.installed_version<>'' AND si.installed_version<>s.version
       AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id=si.skill_id) ORDER BY si.skill_id`, [scope.workspaceId])).rows;
    return rows.map((row) => ({ skillId: row.skill_id,name: row.name,installedVersion: row.installed_version,currentVersion: row.version }));
  });
}
