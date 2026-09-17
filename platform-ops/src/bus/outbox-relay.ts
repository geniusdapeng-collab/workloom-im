/**
 * bus/outbox-relay —— transactional outbox 中继（PRD V3.0 §17.1）
 *
 * 关键纪律：事件先落库、后上总线。事件写入与 outbox 标记同事务；
 * 独立 relay 进程把已提交事件发布到事件总线（至少一次语义），消费者幂等。
 * 杜绝"总线上有、库里没有"的幽灵事件；relay 崩溃后从未发布位点续发，杜绝"库里有、总线丢了"。
 * （现状 skill_reflux_outbox 表是该模式的雏形，本模块推广为全系统通用机制。）
 */
import type { EventBus, StreamName } from "./stream.js";

export interface OutboxRow {
  eventId: string;
  tenantId: string;
  stream: StreamName;
  subject: string;
  payload: unknown;
  published: boolean;
}

/** PG outbox 表的最小接口（生产由 Drizzle/pg 实现；测试用内存实现） */
export interface OutboxStore {
  /** 取未发布行（按入库序）；relay 循环调用 */
  fetchUnpublished(limit: number): Promise<OutboxRow[]>;
  /** 标记已发布（幂等：重复标记无副作用） */
  markPublished(eventId: string): Promise<void>;
}

export class OutboxRelay {
  constructor(
    private store: OutboxStore,
    private bus: EventBus,
    private batchSize = 500,
  ) {}

  /** 中继一轮：返回本轮发布数。至少一次——markPublished 失败则下轮重发，消费者按 event_id 幂等 */
  async pumpOnce(): Promise<number> {
    const rows = await this.store.fetchUnpublished(this.batchSize);
    for (const row of rows) {
      this.bus.publish(row.stream, row.subject, { ...asObject(row.payload), event_id: row.eventId, tenant_id: row.tenantId });
      await this.store.markPublished(row.eventId);
    }
    return rows.length;
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
}

/** 内存 outbox（测试/起步形态） */
export class MemoryOutboxStore implements OutboxStore {
  private rows: OutboxRow[] = [];
  /** 与事件写入同事务追加（生产：INSERT INTO event_outbox ... 与 biz_events 同一 tx） */
  append(row: Omit<OutboxRow, "published">): void { this.rows.push({ ...row, published: false }); }
  async fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    return this.rows.filter((r) => !r.published).slice(0, limit);
  }
  async markPublished(eventId: string): Promise<void> {
    for (const r of this.rows) if (r.eventId === eventId) r.published = true;
  }
}
