/**
 * service · 知识库（接口对齐 packages/base/service-kb 签名；表结构为底座迁移版）
 *  - 切块：Markdown 二级标题分段（store.splitChunks → kb_chunks.chunk_index）
 *  - 检索（H4）：SQL 侧候选召回（content/heading ILIKE ANY 关键词数组，LIMIT 100），
 *    JS 侧用与 base 一致的 2-gram 切词（tokenizeQuery）+ scoreChunkFallback 确定性精排，
 *    score 归一化 0..1，仅命中 status='active' 文档
 *  - 状态枚举（底座 CHECK）：active | pending_review | disabled；来源：manual | upload | official_site
 *  - 站点源：统一使用 0010 已有的 kb_sources（幽灵表 kb_site_sources 已废弃，S1）；
 *    fetch 走 base 共用 SSRF 守卫（协议白名单 + 内网拒绝 + 2MB 上限，H7）；
 *    抓取 → 去标签纯文本 →（可选）LLM 结构化为 FAQ；无 LLM 降级直存（degraded:true）
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文）。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import {
  guardedFetchText,
  scoreChunkFallback,
  tokenizeQuery,
  type KbSearchLexicon,
} from "@workloom/base/service-kb";
import { ensureServiceSchema, indexChunks } from "./store.js";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";
import type { LlmCall } from "./llm.js";

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export interface KbCollection { id: string; workspaceId: string; name: string; description: string; createdAt: string }
export interface KbDocument {
  id: string; workspaceId: string; collectionId: string; title: string;
  sourceKind: string; sourceUrl: string | null; version: number; status: string; createdAt: string;
}
export interface KbHit { content: string; heading: string; documentTitle: string; documentId: string; score: number }

function collectionOf(x: Record<string, unknown>): KbCollection {
  return { id: String(x.id), workspaceId: String(x.workspace_id), name: String(x.name), description: String(x.description ?? ""), createdAt: new Date(String(x.created_at)).toISOString() };
}
function documentOf(x: Record<string, unknown>): KbDocument {
  return {
    id: String(x.id), workspaceId: String(x.workspace_id), collectionId: String(x.collection_id),
    title: String(x.title), sourceKind: String(x.source_kind), sourceUrl: x.source_url as string | null,
    version: Number(x.version), status: String(x.status), createdAt: new Date(String(x.created_at)).toISOString(),
  };
}

/** 事务内建集（D16：供 router serviceTx 回调复用同一 client，不再嵌套另开连接） */
export async function createCollectionOn(
  client: pg.PoolClient,
  input: { workspaceId: string; name: string; description?: string },
): Promise<KbCollection> {
  await ensureServiceSchema();
  const r = await client.query(
    `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [newId("kbc"), input.workspaceId, input.name, input.description ?? ""],
  );
  return collectionOf(r.rows[0] as Record<string, unknown>);
}

export async function createCollection(input: { workspaceId: string; name: string; description?: string }): Promise<KbCollection> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => createCollectionOn(client, input));
}

export async function listCollections(input: { workspaceId: string }): Promise<KbCollection[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(input.workspaceId, `SELECT * FROM kb_collections WHERE workspace_id=$1 ORDER BY created_at`, [input.workspaceId]);
  return rows.map(collectionOf);
}

/** upsert：同工作区同标题（或同 sourceUrl）→ 版本 +1 重建切块；否则新建（pending_review 待审批生效） */
export async function upsertDocumentOn(
  client: pg.PoolClient,
  input: {
    workspaceId: string; collectionId: string; title: string;
    sourceKind: string; sourceUrl?: string; contentMd: string;
  },
): Promise<{ documentId: string; version: number; chunks: number }> {
  await ensureServiceSchema();
  // 同区同标题 / sourceUrl 的建版先串行，再锁实际文档行；版本号不能由并发旧快照重复计算。
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kb-upsert:${input.workspaceId}`]);
  const hash = createHash("sha256").update(input.contentMd).digest("hex");
  // 同内容指纹幂等（H8：UNIQUE(workspace_id,hash)）：已存在则直接复用，不建版不重切
  const sameHash = await client.query(
    `SELECT id, version FROM kb_documents WHERE workspace_id=$1 AND hash=$2 LIMIT 1 FOR UPDATE`,
    [input.workspaceId, hash],
  );
  if (sameHash.rows[0]) {
    const d = sameHash.rows[0] as { id: string; version: number };
    return { documentId: String(d.id), version: Number(d.version), chunks: 0 };
  }
  const exist = await client.query(
    `SELECT id, version FROM kb_documents
     WHERE workspace_id=$1 AND (title=$2 OR ($3::text IS NOT NULL AND source_url=$3)) LIMIT 1 FOR UPDATE`,
    [input.workspaceId, input.title, input.sourceUrl ?? null],
  );
  let documentId: string;
  let version: number;
  if (exist.rows[0]) {
    documentId = String(exist.rows[0].id);
    version = Number(exist.rows[0].version) + 1;
    await client.query(
      `UPDATE kb_documents SET collection_id=$3, source_kind=$4, source_url=$5, content_md=$6, version=$7, hash=$8, status='pending_review'
       WHERE workspace_id=$1 AND id=$2`,
      [input.workspaceId, documentId, input.collectionId, input.sourceKind, input.sourceUrl ?? null, input.contentMd, version, hash],
    );
  } else {
    documentId = newId("kbd");
    version = 1;
    const ins = await client.query(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, content_md, hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review')
       ON CONFLICT (workspace_id, hash) DO NOTHING
       RETURNING id`,
      [documentId, input.workspaceId, input.collectionId, input.title, input.sourceKind, input.sourceUrl ?? null, input.contentMd, hash],
    );
    if (!ins.rows[0]) {
      // 同 hash 已存在（并发/异名同文）：复用原文档，不重切版（H8 幂等）
      const dup = await client.query(
        `SELECT id, version FROM kb_documents WHERE workspace_id=$1 AND hash=$2 LIMIT 1`,
        [input.workspaceId, hash],
      );
      const d = dup.rows[0] as { id: string; version: number } | undefined;
      if (!d) throw new Error("kb_documents hash 冲突但回查为空（数据异常）");
      return { documentId: String(d.id), version: Number(d.version), chunks: 0 };
    }
  }
  const chunks = await indexChunks(
    client as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    input.workspaceId, documentId, input.contentMd,
  );
  return { documentId, version, chunks };
}

export async function upsertDocument(input: {
  workspaceId: string; collectionId: string; title: string;
  sourceKind: string; sourceUrl?: string; contentMd: string;
}): Promise<{ documentId: string; version: number; chunks: number }> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => upsertDocumentOn(client, input));
}

export async function listDocuments(input: { workspaceId: string; collectionId?: string }): Promise<KbDocument[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    input.workspaceId,
    `SELECT * FROM kb_documents WHERE workspace_id=$1 AND ($2::text IS NULL OR collection_id=$2) ORDER BY created_at DESC`,
    [input.workspaceId, input.collectionId ?? null],
  );
  return rows.map(documentOf);
}

/** 事务内文档状态变更（D16：供 router serviceTx 回调复用同一 client） */
export async function setDocumentStatusOn(
  client: pg.PoolClient,
  input: { workspaceId: string; documentId: string; status: string },
): Promise<void> {
  await ensureServiceSchema();
  await client.query(
    `UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2`,
    [input.workspaceId, input.documentId, input.status],
  );
}

export async function setDocumentStatus(input: { workspaceId: string; documentId: string; status: string }): Promise<void> {
  await ensureServiceSchema();
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.documentId, input.status],
  );
}

/** 事务内注册官网抓取源（D16：供 router serviceTx 回调复用同一 client） */
export async function registerSiteSourceOn(
  client: pg.PoolClient,
  input: { workspaceId: string; url: string },
): Promise<{ sourceId: string }> {
  await ensureServiceSchema();
  const r = await client.query(
    `INSERT INTO kb_sources (id, workspace_id, url) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, url) DO UPDATE SET status='active'
     RETURNING id`,
    [newId("kbs"), input.workspaceId, input.url],
  );
  return { sourceId: String((r.rows[0] as { id: string }).id) };
}

/** 注册官网抓取源（统一走 0010 的 kb_sources；UNIQUE(workspace_id,url) 幂等） */
export async function registerSiteSource(input: { workspaceId: string; url: string }): Promise<{ sourceId: string }> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => registerSiteSourceOn(client, input));
}

/** HTML → 纯文本（演示级去标签） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** 页面抓取（H7：base 共用 SSRF 守卫——协议白名单 + 内网拒绝 + 2MB 读取上限） */
async function fetchPage(url: string): Promise<string> {
  return htmlToText(await guardedFetchText(url));
}

async function defaultCollection(workspaceId: string): Promise<string> {
  const rows = await svcQuery(workspaceId, `SELECT id FROM kb_collections WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [workspaceId]);
  if (rows[0]) return String(rows[0].id);
  const c = await createCollection({ workspaceId, name: "默认知识库" });
  return c.id;
}

interface KbSourceRow extends Record<string, unknown> {
  id: string; url: string; fingerprint: string | null;
}

async function loadSource(workspaceId: string, sourceId: string): Promise<KbSourceRow> {
  const src = await svcQuery<KbSourceRow>(
    workspaceId,
    `SELECT id, url, fingerprint FROM kb_sources WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, sourceId],
  );
  const source = src[0];
  if (!source) throw new Error(`站点源不存在：${sourceId}`);
  return source;
}

/** 抓取并结构化：LLM 在场 → 提炼 FAQ；否则降级直存原文（degraded:true）。文档进 pending_review 待审批生效。 */
export async function crawlAndStructure(input: {
  workspaceId: string; sourceId: string; llm?: LlmCall;
}): Promise<{ documentId: string; entryCount: number; degraded?: boolean }> {
  await ensureServiceSchema();
  const source = await loadSource(input.workspaceId, input.sourceId);
  const url = String(source.url);
  const text = await fetchPage(url);
  const hash = createHash("sha256").update(text).digest("hex");

  let md: string;
  let degraded = false;
  if (input.llm) {
    try {
      md = await input.llm(
        `把以下网页内容结构化为当前业务的客户服务常见问答（Markdown，二级标题为问题，正文为答案，不要编造原文没有的信息）：\n\n${text.slice(0, 6000)}`,
      );
    } catch (err) {
      console.warn("[service-c] KB 抓取 LLM 结构化失败，降级直存原文：", err instanceof Error ? err.message : err);
      md = `# ${url}\n\n${text.slice(0, 8000)}`;
      degraded = true;
    }
  } else {
    md = `# ${url}\n\n${text.slice(0, 8000)}`;
    degraded = true;
  }
  const up = await upsertDocument({
    workspaceId: input.workspaceId,
    collectionId: await defaultCollection(input.workspaceId),
    title: `站点抓取 ${url}`,
    sourceKind: "official_site",
    sourceUrl: url,
    contentMd: md,
  });
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_sources SET fingerprint=$3, last_crawled_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.sourceId, hash],
  );
  return { documentId: up.documentId, entryCount: up.chunks, degraded };
}

/** 定时复扫：内容指纹变化 → 生成新版本文档（pending_review），返回 changed/newDocumentId */
export async function diffScan(input: { workspaceId: string; sourceId: string }): Promise<{ changed: boolean; newDocumentId?: string }> {
  await ensureServiceSchema();
  const source = await loadSource(input.workspaceId, input.sourceId);
  const text = await fetchPage(String(source.url));
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash === source.fingerprint) {
    await svcQuery(
      input.workspaceId,
      `UPDATE kb_sources SET last_crawled_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
      [input.workspaceId, input.sourceId],
    );
    return { changed: false };
  }
  const up = await upsertDocument({
    workspaceId: input.workspaceId,
    collectionId: await defaultCollection(input.workspaceId),
    title: `站点抓取 ${String(source.url)}`,
    sourceKind: "official_site",
    sourceUrl: String(source.url),
    contentMd: `# ${String(source.url)}\n\n${text.slice(0, 8000)}`,
  });
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_sources SET fingerprint=$3, last_crawled_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.sourceId, hash],
  );
  return { changed: true, newDocumentId: up.documentId };
}

/**
 * 检索（H4 修复全表扫描）：SQL 侧候选召回（content/heading ILIKE ANY 关键词数组，LIMIT 100），
 * JS 侧与 base 一致的 2-gram 切词（tokenizeQuery）+ scoreChunkFallback 精排（score 归一化 0..1）。
 */
export async function searchKB(input: {
  workspaceId: string;
  query: string;
  limit?: number;
  /**
   * MC-111：相关性下限（0..1）。默认 0 = 保持既有「score>0 即命中」口径（P22 知识库检索面
   * 需要宽召回，让操作者看到候选）；ask 事实面注入时必须给下限，避免 2-gram 噪声 FAQ
   * 冒充「系统事实」（详见 packages/runtime/src/ask.ts#ASK_KB_MIN_SCORE）。
   */
  minScore?: number;
  /** 由已验证活动 Bundle 选择的适配器注入；省略时基座不理解行业词义。 */
  lexicon?: KbSearchLexicon;
}): Promise<KbHit[]> {
  await ensureServiceSchema();
  const terms = tokenizeQuery(input.query, input.lexicon);
  if (terms.length === 0) return [];
  const patterns = terms.map((t) => `%${t}%`);
  const rows = await svcQuery<{ document_id: string; heading: string; content: string; title: string }>(
    input.workspaceId,
    `SELECT ch.document_id, ch.heading, ch.content, d.title
     FROM kb_chunks ch JOIN kb_documents d ON d.id = ch.document_id AND d.workspace_id = ch.workspace_id
     WHERE ch.workspace_id=$1 AND d.status='active'
       AND (replace(lower(ch.content), '-', '') ILIKE ANY($2::text[]) OR replace(lower(ch.heading), '-', '') ILIKE ANY($2::text[]))
     LIMIT 100`,
    [input.workspaceId, patterns],
  );
  return rows
    .map((x) => ({
      content: x.content, heading: x.heading, documentTitle: x.title, documentId: x.document_id,
      score: scoreChunkFallback(input.query, { heading: x.heading, content: x.content }, input.lexicon),
    }))
    .filter((x) => x.score > 0 && x.score >= (input.minScore ?? 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5);
}

type KbDecisionApplication = { documentId: string; status: "active" | "pending_review"; changed: boolean } | null;

/**
 * MC-012：在 decide 持有的事务内应用旧 kb.publish 裁决。事件是不可变授权锚点：
 * 租户、工作区、对象和版本必须全等；缺版本、内容哈希不符、已消费或较旧裁决不改当前文档。
 * 先锁审批、再锁文档、最后写事件；故障直接抛出，让文档、审批、手势和 COMMIT 一起回滚。
 */
export async function applyKbPublishAfterApprovalOn(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<KbDecisionApplication> {
  await ensureServiceSchema();
  const result = await client.query<{
    status: string; consumed_at: Date | null; decided_by: string | null; decided_at: Date | null;
    action: string | null; object_type: string | null; document_id: string | null; event_seq: string;
    after: Record<string, unknown> | null; snapshot: { after?: Record<string, unknown> } | null;
  }>(
    `SELECT a.status,a.consumed_at,a.decided_by,a.decided_at,a.snapshot,
            e.payload->'decision'->>'action' AS action,e.payload->'object'->>'type' AS object_type,
            e.payload->'object'->>'id' AS document_id,e.payload->'decision'->'after' AS after,e.seq::text AS event_seq
       FROM approvals a
       JOIN biz_events e ON e.event_id=a.event_id AND e.workspace_id=a.workspace_id AND e.tenant_id=a.tenant_id
      WHERE a.approval_id=$1 AND a.workspace_id=$2 AND a.tenant_id=$3 FOR UPDATE OF a`,
    [approvalId, scope.workspaceId, scope.tenantId],
  );
  const row = result.rows[0];
  if (!row || row.action !== "kb.publish" || row.object_type !== "kb_document" || !row.document_id) return null;
  if (row.consumed_at || !row.decided_by || !row.decided_at) return null;
  const approved = row.status === "approved" || row.status === "edited";
  if (!approved && row.status !== "rejected") return null;
  const after = row.after ?? {};
  const version = after.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (after.documentId !== undefined && after.documentId !== row.document_id) return null;
  const snapshot = row.snapshot?.after ?? {};
  if (snapshot.documentId !== undefined && snapshot.documentId !== row.document_id) return null;
  if (snapshot.version !== undefined && snapshot.version !== version) return null;

  const document = await client.query<{ version: number; hash: string | null; status: string }>(
    `SELECT version,hash,status FROM kb_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [scope.workspaceId, row.document_id],
  );
  const current = document.rows[0];
  if (!current || current.version !== version) return null;
  if (after.hash !== undefined && after.hash !== current.hash) return null;
  if (snapshot.hash !== undefined && snapshot.hash !== current.hash) return null;

  // 修复前待办不能撤销较新的逐条批准，也不能经幂等重试复活后来被人停用的文档。
  const newer = await client.query(
    `SELECT 1 FROM biz_events e
      WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.seq>$3::bigint AND e.payload->'object'->>'id'=$4
        AND (
          (e.payload->'decision'->>'action'='kb.document.status' AND e.payload->'who'->>'type'='human')
          OR (e.payload->'decision'->>'action'='kb.publish' AND e.payload->'decision'->'after'->>'version'=$5
            AND EXISTS (SELECT 1 FROM approvals a WHERE a.event_id=e.event_id AND a.tenant_id=e.tenant_id
              AND a.workspace_id=e.workspace_id AND a.status IN ('approved','edited') AND a.decided_by IS NOT NULL))
        ) LIMIT 1`,
    [scope.tenantId, scope.workspaceId, row.event_seq, row.document_id, String(version)],
  );
  if (newer.rows[0]) return null;
  const target = approved ? "active" as const : "pending_review" as const;
  if (current.status === target) return { documentId: row.document_id, status: target, changed: false };
  await client.query(
    `UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2 AND version=$4 AND hash IS NOT DISTINCT FROM $5`,
    [scope.workspaceId, row.document_id, target, version, current.hash],
  );
  await appendEventOn(client, scope, { id: "review-console", type: "system" }, {
    objectType: "kb_document", objectId: row.document_id,
    action: approved ? "kb.publish" : "kb.publish.revoke",
    after: { documentId: row.document_id, version, hash: current.hash, status: target, approvalId },
    basis: [approved ? `审批 ${approvalId} 通过：同一版本进入客户问答检索范围` : `审批 ${approvalId} 驳回：同一版本退回待审并退出客户问答检索范围`],
  });
  return { documentId: row.document_id, status: target, changed: true };
}

/** 已裁决存量记录的独立幂等修复入口；正常裁决使用上面的事务内入口。 */
export async function applyKbPublishAfterApproval(scope: { workspaceId: string }, approvalId: string): Promise<KbDecisionApplication> {
  return serviceTx(scope.workspaceId, (client, parsedScope) => applyKbPublishAfterApprovalOn(client, parsedScope, approvalId));
}
