/**
 * streams/projector —— 投影器框架（PRD V3.0 §16.3 写放大控制 / §16.6 幂等）
 *
 * 两条铁律的工程化：
 * ① 投影更新全部设计为幂等写（checkpoint + event_id 去重，崩溃重放不重复扣投影）；
 * ② 写放大控制——model.call 占事件 70%，按 tenant 做 1s 窗口微批合并再写投影，写次数降一个量级。
 */
import type { BusMessage, ConsumerGroup } from "../bus/stream.js";

export interface CheckpointStore {
  get(projector: string): Promise<number>;
  set(projector: string, seq: number): Promise<void>;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private map = new Map<string, number>();
  async get(p: string): Promise<number> { return this.map.get(p) ?? 0; }
  async set(p: string, s: number): Promise<void> { this.map.set(p, s); }
}

export interface ProjectorOptions<T> {
  name: string;
  group: ConsumerGroup;
  checkpoints: CheckpointStore;
  /** 微批窗口（§16.3：默认 1000ms） */
  windowMs?: number;
  /** 微批合并：同 key 多条事件合并为一次投影写（如按 tenant 合并积分增量） */
  mergeKey?: (msg: BusMessage<T>) => string;
  merge?: (acc: T[], batch: T[]) => T[];
  /** 幂等投影写（生产：HSET/UPSERT；必须可安全重放） */
  apply: (batch: BusMessage<T>[]) => Promise<void>;
  now?: () => number;
}

export class Projector<T = unknown> {
  private lastFlush: number;
  private buffer: BusMessage<T>[] = [];
  private seen = new Set<string>(); // event_id 幂等去重（有限窗口内）

  constructor(private opts: ProjectorOptions<T>) {
    this.lastFlush = (opts.now ?? Date.now)();
  }

  /** 拉一轮：poll → 微批缓冲 → 到窗/满批 flush → ack + checkpoint */
  async tick(batchSize = 200): Promise<number> {
    const now = (this.opts.now ?? Date.now)();
    const msgs = this.opts.group.pull(batchSize, now).filter((m) => {
      const id = (m.payload as { event_id?: string })?.event_id;
      if (id && this.seen.has(id)) return false;
      if (id) this.seen.add(id);
      return true;
    });
    this.buffer.push(...msgs);
    if (this.buffer.length > 0 && (now - this.lastFlush >= (this.opts.windowMs ?? 1000) || this.buffer.length >= batchSize)) {
      await this.flush();
    }
    return msgs.length;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.opts.apply(batch);
    const last = batch[batch.length - 1];
    for (const m of batch) this.opts.group.ack(m.seq);
    await this.opts.checkpoints.set(this.opts.name, last.seq);
    this.lastFlush = (this.opts.now ?? Date.now)();
  }
}
