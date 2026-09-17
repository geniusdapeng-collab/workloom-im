/**
 * service · 对话（接口对齐 packages/base/service-dialog 签名；表结构为底座迁移版）
 * 意图流水线（M8：与 packages/base/service-dialog/intents.ts 同一张规则表 ruleBasedIntent）：
 *   complaint（投诉）> 已验证行业适配器业务查询 / 通用工单进度 > service_request（产 ticketDraft）
 *   > kb_qa（KB 检索三档分流）> chat（规则未命中兜底）
 *   疑问句（几点/时间/吗/呢/怎么/如何）优先 kb_qa；行业写操作只由已验证适配器识别。
 * 置信度三档（H5：检索 score 归一化 0..1，复用 base scoreChunkFallback）：
 *   ≥0.72 直接作答（带引用）；0.45–0.72 作答但附「可能不完全准确」提示；<0.45 诚实拒答 + ticketDraft。
 * 命中 KB 必带 citations，无据不答（诚实拒答）。
 * 全量消息落 c_messages（stats.overview 聚合数据源；mock 仅在响应标注）。
 */
import { ruleBasedIntent } from "@workloom/base/service-dialog";
import { isWeakKbToken, type KbSearchLexicon } from "@workloom/base/service-kb";
import { ensureServiceSchema } from "./store.js";
import { searchKB, type KbHit } from "./kb.js";
import { llmCall } from "./llm.js";
import { serviceTx, svcQuery } from "./events.js";
import type { Channel } from "./channels.js";
import {
  projectBusinessDialogMatch,
  type BusinessTool,
  type ServiceFrontBusinessAdapter,
} from "./adapters/business.js";

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";
export type BizToolName = BusinessTool | "query_ticket";

export interface DialogResult {
  conversationId: string;
  intent: Intent;
  answer: string;
  confidence: number;
  citations: Array<{ documentTitle: string; heading: string; content: string }>;
  ticketDraft?: { kind: string; title: string; payload: Record<string, unknown> };
  toolCall?: { tool: BizToolName; params: Record<string, unknown> };
  latencyMs: number;
  mock?: boolean;
}

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46636;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

/* ================= 意图（M8：复用 base 同一张规则表） ================= */

/** 工单进度属于基座公共能力，不依赖行业适配器。 */
const RE_TICKET_STATUS = /工单.*(进度|状态|怎么样)|进度.*工单/;

export function classify(
  text: string,
  businessAdapter?: ServiceFrontBusinessAdapter | null,
): { intent: Intent; tool?: BizToolName; answer?: string; params?: Record<string, unknown> } {
  if (RE_TICKET_STATUS.test(text)) return { intent: "biz_query", tool: "query_ticket" };
  const ruled = ruleBasedIntent(text);
  if (ruled === "complaint") return { intent: "complaint" };
  const industryMatch = projectBusinessDialogMatch(businessAdapter?.classify(text) ?? null);
  if (industryMatch) {
    return {
      intent: "biz_query",
      tool: industryMatch.tool,
      answer: industryMatch.answer,
      params: industryMatch.params,
    };
  }
  // 通用疑问句优先知识问答；行业适配器不能仅因句中出现履约动词就误建单。
  // 明确的行业业务查询已在上方由 classify 精确识别，因此不受此优先级影响。
  if (ruled === "kb_qa") return { intent: "kb_qa" };
  // 行业履约意图由活动 Bundle 适配器识别，基座规则不保存行业词表。
  if (businessAdapter?.ticketKind?.(text)) return { intent: "service_request" };
  if (ruled === "service_request") return { intent: "service_request" };
  // 通用规则只能判断“像业务查询”，不能猜测行业工具；未启用适配器时回到有据可查的知识库。
  if (ruled === "biz_query") return { intent: "kb_qa" };
  return { intent: "kb_qa" }; // 规则未命中：默认先查知识库（低置信走诚实拒答三档）
}

/** service_request → 通用工单类型；行业细分由已验证适配器优先提供。 */
export function ticketKindOf(
  text: string,
  businessAdapter?: ServiceFrontBusinessAdapter | null,
): "repair" | "delivery" | "other" {
  const industryKind = businessAdapter?.ticketKind?.(text);
  if (industryKind === "repair" || industryKind === "delivery" || industryKind === "other") return industryKind;
  return "other";
}

/* ================= 置信度三档（H5） ================= */

export type ConfidenceTier = "high" | "medium" | "low";
export const CONFIDENCE_HIGH = 0.72;
export const CONFIDENCE_MEDIUM = 0.45;

/** score 归一化（0..1）后分档：≥0.72 高 / 0.45–0.72 中 / <0.45 低 */
export function tierOfScore(score: number | undefined): ConfidenceTier {
  if (score === undefined) return "low";
  const s = Math.max(0, Math.min(1, score));
  if (s >= CONFIDENCE_HIGH) return "high";
  if (s >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

export const MEDIUM_HINT = "以上回答可能不完全准确，仅供参考；如需确认可转人工服务。";
export const LOW_REFUSAL = "抱歉，这个问题我暂时无法准确回答，不敢随意编造。已为您准备好工单草稿，确认后转人工跟进；您也可以换个说法再问我。";

async function ensureConversation(input: {
  workspaceId: string; cUserId: string; channel: Channel; conversationId?: string;
}): Promise<string> {
  if (input.conversationId) {
    const rows = await svcQuery(
      input.workspaceId,
      `SELECT id FROM c_conversations WHERE workspace_id=$1 AND id=$2 AND c_user_id=$3`,
      [input.workspaceId, input.conversationId, input.cUserId],
    );
    if (rows[0]) return input.conversationId;
  }
  const id = newId("cvn");
  await svcQuery(
    input.workspaceId,
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel) VALUES ($1,$2,$3,$4) RETURNING id`,
    [id, input.workspaceId, input.cUserId, input.channel],
  );
  return id;
}

async function logMessage(row: {
  workspaceId: string; conversationId: string; role: "user" | "assistant";
  content: string; intent?: Intent; confidence?: number; citations?: unknown[]; latencyMs?: number;
}): Promise<void> {
  await serviceTx(row.workspaceId, async (client) => {
    await client.query(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.workspaceId, row.conversationId, row.role, row.content,
       row.intent ?? null, row.confidence ?? null, JSON.stringify(row.citations ?? []), row.latencyMs ?? null],
    );
    await client.query(
      `UPDATE c_conversations SET last_message_at=now() WHERE workspace_id=$1 AND id=$2`,
      [row.workspaceId, row.conversationId],
    );
  });
}

function citationsOf(hits: KbHit[]): Array<{ documentTitle: string; heading: string; content: string }> {
  return hits.slice(0, 3).map((h) => ({ documentTitle: h.documentTitle, heading: h.heading, content: h.content.slice(0, 300) }));
}

function normalizedEvidenceTokens(
  hit: Pick<KbHit, "heading" | "content">,
  lexicon?: KbSearchLexicon,
): Set<string> {
  const text = `${hit.heading}\n${hit.content}`
    .toLowerCase()
    .replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, "");
  return new Set(
    (text.match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? [])
      .filter((token) => !isWeakKbToken(token, lexicon)),
  );
}

/** top-2 合并只采用显式词表的弱词定义；省略词表时不理解任何行业弱词。 */
export function sharesDistinctiveEvidence(
  first: Pick<KbHit, "heading" | "content">,
  second: Pick<KbHit, "heading" | "content">,
  lexicon?: KbSearchLexicon,
): boolean {
  const firstTokens = normalizedEvidenceTokens(first, lexicon);
  return [...normalizedEvidenceTokens(second, lexicon)].some((token) => firstTokens.has(token));
}

export async function handleMessage(input: {
  workspaceId: string; cUserId: string; channel: Channel; text: string; conversationId?: string;
  businessAdapter?: ServiceFrontBusinessAdapter | null;
}): Promise<DialogResult> {
  await ensureServiceSchema();
  const t0 = Date.now();
  const llm = llmCall();
  const mock = !llm;
  const conversationId = await ensureConversation(input);
  await logMessage({ workspaceId: input.workspaceId, conversationId, role: "user", content: input.text });

  const cls = classify(input.text, input.businessAdapter);
  let result: Omit<DialogResult, "conversationId" | "latencyMs" | "mock">;

  if (cls.intent === "biz_query") {
    const tool = cls.tool!;
    const answer = tool === "query_ticket" ? "正在为您查询工单进度。" : cls.answer ?? "正在为您查询相关信息。";
    result = {
      intent: "biz_query", answer, confidence: 0.95, citations: [],
      toolCall: { tool, params: cls.params ?? {} },
    };
  } else if (cls.intent === "complaint") {
    result = {
      intent: "complaint",
      answer: "非常抱歉给您带来不便。我可以立即为您生成投诉工单，相关服务团队将优先跟进。请确认是否提交？",
      confidence: 0.9,
      citations: [],
      ticketDraft: { kind: "complaint", title: input.text.slice(0, 40), payload: { text: input.text } },
    };
  } else if (cls.intent === "service_request") {
    const kind = ticketKindOf(input.text, input.businessAdapter);
    result = {
      intent: "service_request",
      answer: "好的，我可以为您生成服务工单，相关部门会尽快处理。请确认是否提交？",
      confidence: 0.85,
      citations: [],
      ticketDraft: { kind, title: input.text.slice(0, 40), payload: { text: input.text } },
    };
  } else {
    // kb_qa：检索三档分流（H5）——score 已归一化 0..1
    const lexicon = input.businessAdapter?.kbLexicon;
    const hits = await searchKB({ workspaceId: input.workspaceId, query: input.text, limit: 5, lexicon });
    const top = hits[0];
    const tier = tierOfScore(top?.score);
    if (tier === "low") {
      // 诚实拒答 + 工单草稿（不编造；L1 低置信留痕）
      result = {
        intent: "kb_qa",
        answer: LOW_REFUSAL,
        confidence: top?.score ?? 0,
        citations: [],
        ticketDraft: {
          kind: "other",
          title: `知识库未覆盖咨询：${input.text.slice(0, 30)}`,
          payload: { text: input.text, intent: "kb_qa", topScore: top?.score ?? null },
        },
      };
    } else if (top) {
      // top-2 合并：次命中与首命中共享非弱词 token 且自身 ≥0.45 时并入（跨知识块事实）
      const second = hits[1];
      const mergeSecond = second
        && second.score >= CONFIDENCE_MEDIUM
        && sharesDistinctiveEvidence(top, second, lexicon);
      const blocks = [top, ...(mergeSecond ? [second] : [])];
      let answer = blocks
        .map((h) => `${h.heading ? `【${h.heading}】` : ""}${h.content.replace(/^#\s.*$/m, "").trim().slice(0, 300)}`)
        .join("\n");
      if (llm) {
        try {
          answer = await llm(
            `你是智能服务助手。仅依据以下资料回答用户问题，不要编造资料之外的信息，回答控制在 80 字内。\n用户：${input.text}\n资料：${blocks.map((h) => h.content.slice(0, 400)).join("\n---\n")}`,
          );
        } catch (err) {
          console.warn("[service-c] kb_qa 组答 LLM 失败，使用确定性拼装答案：", err instanceof Error ? err.message : err);
        }
      }
      if (tier === "medium") answer = `${answer}\n${MEDIUM_HINT}`;
      result = { intent: "kb_qa", answer, confidence: Math.max(0, Math.min(1, top.score)), citations: citationsOf(hits) };
    } else {
      result = {
        intent: "kb_qa",
        answer: LOW_REFUSAL,
        confidence: 0,
        citations: [],
        ticketDraft: {
          kind: "other",
          title: `知识库未覆盖咨询：${input.text.slice(0, 30)}`,
          payload: { text: input.text, intent: "kb_qa", topScore: null },
        },
      };
    }
  }

  const latencyMs = Date.now() - t0;
  await logMessage({
    workspaceId: input.workspaceId, conversationId, role: "assistant",
    content: result.answer, intent: result.intent, confidence: result.confidence,
    citations: result.citations, latencyMs,
  });
  return { conversationId, ...result, latencyMs, mock };
}
