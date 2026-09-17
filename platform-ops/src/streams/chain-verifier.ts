/**
 * streams/chain-verifier —— 哈希链流式增量校验（PRD V3.0 §16.2-4）
 *
 * 现状 verify-chain 是全量脚本；工程篇升级为流式增量校验：
 * 流处理器逐事件验 sha256 链（hash = sha256(prev_hash + canonical(payload))），断链即 P0 事件。
 */
import { createHash } from "node:crypto";

export interface ChainedEvent {
  event_id: string;
  tenant_id: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export function computeHash(prevHash: string, payload: unknown): string {
  return createHash("sha256").update(prevHash + canonical(payload)).digest("hex");
}

export interface ChainBreak { tenantId: string; eventId: string; reason: "prev_mismatch" | "hash_mismatch"; expected: string; actual: string }

export class ChainVerifier {
  private tip = new Map<string, string>(); // tenant → 最新 hash（每租户独立链，与现状哈希链口径一致）

  /** 逐事件校验；断链返回 ChainBreak（调用方发 P0 事件） */
  verify(e: ChainedEvent): ChainBreak | null {
    const tip = this.tip.get(e.tenant_id) ?? "";
    if (e.prev_hash !== tip) {
      return { tenantId: e.tenant_id, eventId: e.event_id, reason: "prev_mismatch", expected: tip, actual: e.prev_hash };
    }
    const expect = computeHash(e.prev_hash, e.payload);
    if (expect !== e.hash) {
      return { tenantId: e.tenant_id, eventId: e.event_id, reason: "hash_mismatch", expected: expect, actual: e.hash };
    }
    this.tip.set(e.tenant_id, e.hash);
    return null;
  }

  /** 从 checkpoint 恢复（重启后从最近已验位点续验，不回放全量） */
  restore(tenant: string, tipHash: string): void { this.tip.set(tenant, tipHash); }
}
