/**
 * bus/stream —— 事件总线（PRD V3.0 §17.3 消息队列拓扑 / ADR-1 NATS JetStream）
 *
 * 语义对齐 JetStream：四条 Stream（留存与消费模式各异）/ 消费者组扇出（一条事件 N 组独立消费）/
 * deliver-at 延迟消息（SLA 到期、回访第 3 天、灰度观察期结束，替代定时扫表）/
 * 显式 ack + maxAckPending 背压（积压留在总线持久层，不靠丢消息削峰）/ 位点重放（投影重建）。
 *
 * 本文件是「起步形态」的内存实现（§21.3 起步阶梯：JetStream 单机）——接口即生产语义，
 * 集群化时以同一接口替换为 NATS 客户端适配器，上层流处理器零改动。
 */

/** §17.3 四条流的拓扑声明（单一事实源，生产部署按本表建流） */
export const STREAM_TOPOLOGY = {
  "events-core":    { subject: "ev.{tenant}.{type}",        retention: "limits-72h",  consumers: ["projector", "chain-verifier", "cdc-relay"] },
  "credits-ledger": { subject: "credits.{tenant}",          retention: "workqueue-30d", consumers: ["balance-projector", "anomaly-detector", "daily-reconciler"] },
  "tickets-flow":   { subject: "ticket.{tenant}.{ticket}",  retention: "workqueue-30d", consumers: ["ticket-projector", "sla-timer", "push-matcher", "revisit-scheduler"] },
  "ops-signals":    { subject: "ops.{check}.{object}",      retention: "limits-7d",   consumers: ["alert-aggregator", "inspection-dispatch", "strategy-trigger"] },
} as const;
export type StreamName = keyof typeof STREAM_TOPOLOGY;

export interface BusMessage<T = unknown> {
  /** 全局单调位点（重放基准） */
  seq: number;
  stream: StreamName;
  subject: string;
  payload: T;
  /** 事件产生时刻（服务端权威时钟，§20.4 时钟纪律） */
  ts: number;
  /** deliver-at：到点前对消费者不可见 */
  deliverAt: number;
}

interface PendingDelivery<T> { msg: BusMessage<T>; deliverCount: number }

class ConsumerGroup<T = unknown> {
  private pending = new Map<number, PendingDelivery<T>>();
  private cursor = 0; // 下一待拉取位点（durable：崩溃后从本位点重投递）
  constructor(
    private bus: EventBus,
    public readonly stream: StreamName,
    public readonly name: string,
    private maxAckPending: number,
  ) {}

  /** 拉取一批可见消息（deliverAt 已到点且未超背压上限） */
  pull(batchSize: number, now: number): BusMessage<T>[] {
    if (this.pending.size >= this.maxAckPending) return []; // 背压：积压留在总线
    const out: BusMessage<T>[] = [];
    const log = this.bus.logOf(this.stream);
    // out 中的消息已同步计入 pending，背压判定只看 pending（避免重复计数）
    while (out.length < batchSize && this.pending.size < this.maxAckPending) {
      const next = log.find((m) => m.seq > this.cursor);
      if (!next) break;
      this.cursor = next.seq;
      if (next.deliverAt > now) continue; // 延迟消息未到点：位点照走、不投递（到点后经 redeliver 可见）
      const msg = next as BusMessage<T>;
      this.pending.set(msg.seq, { msg, deliverCount: 1 });
      out.push(msg);
    }
    return out;
  }

  ack(seq: number): void { this.pending.delete(seq); }

  /** 未 ack 重投递（durable consumer 语义；deliver-at 到点消息也经此变为可见） */
  redeliver(now: number): BusMessage<T>[] {
    const out: BusMessage<T>[] = [];
    for (const [seq, p] of this.pending) {
      if (p.msg.deliverAt <= now) { p.deliverCount += 1; out.push(p.msg); }
    }
    return out;
  }

  /** 延迟消息到点补投：扫描游标之后的 deliver-at 消息 */
  pullDueDelayed(now: number): BusMessage<T>[] {
    const log = this.bus.logOf(this.stream);
    const out: BusMessage<T>[] = [];
    for (const m of log) {
      if (m.seq <= this.cursor && m.deliverAt > 0 && m.deliverAt <= now && !this.pending.has(m.seq)) {
        this.pending.set(m.seq, { msg: m as BusMessage<T>, deliverCount: 1 });
        out.push(m as BusMessage<T>);
      }
    }
    return out;
  }

  pendingCount(): number { return this.pending.size; }
  position(): number { return this.cursor; }
}

export class EventBus {
  private streams = new Map<StreamName, BusMessage[]>();
  private groups = new Map<string, ConsumerGroup>();
  private seq = 0;

  constructor(private now: () => number = () => Date.now()) {
    for (const name of Object.keys(STREAM_TOPOLOGY) as StreamName[]) this.streams.set(name, []);
  }

  /** 发布（§17.1 纪律：调用方须先落库后上总线——见 outbox-relay） */
  publish<T>(stream: StreamName, subject: string, payload: T, opts: { deliverAt?: number; ts?: number } = {}): BusMessage<T> {
    const msg: BusMessage<T> = {
      seq: ++this.seq, stream, subject, payload,
      ts: opts.ts ?? this.now(), deliverAt: opts.deliverAt ?? 0,
    };
    this.streams.get(stream)!.push(msg);
    return msg;
  }

  /** 注册消费者组（扇出：同一 stream 多组各自独立位点） */
  consumer(stream: StreamName, group: string, maxAckPending = 1000): ConsumerGroup {
    const key = `${stream}/${group}`;
    if (!this.groups.has(key)) this.groups.set(key, new ConsumerGroup(this, stream, group, maxAckPending));
    return this.groups.get(key)! as ConsumerGroup;
  }

  /** 位点重放（§17.3：投影/策略新版本上线后从历史位点重建） */
  replay(stream: StreamName, fromSeq = 0): BusMessage[] {
    return this.logOf(stream).filter((m) => m.seq > fromSeq);
  }

  /** 积压深度（§17.4 HPA 伸缩信号：>5 万扩容） */
  backlog(stream: StreamName, group: string): number {
    const g = this.groups.get(`${stream}/${group}`);
    const pos = g ? g.position() : 0;
    return this.logOf(stream).filter((m) => m.seq > pos).length;
  }

  logOf(stream: StreamName): BusMessage[] { return this.streams.get(stream) ?? []; }
}
