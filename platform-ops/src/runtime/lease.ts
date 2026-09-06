/**
 * runtime/lease —— 执行监督：心跳租约与僵尸恢复（PRD V3.0 §18.2）
 *
 * 每个执行中的 run 持有租约（run:{id}:lease，TTL 60s，每步执行续约）；
 * 调度器扫描过期租约 → 判定僵尸 run → 自动 replay 从最后幂等断点续跑；
 * 同一 run 连续 3 次僵尸 → 判定"病态任务"：熔断该 run → P1 事件 + 需介入工单
 * （附完整事件时间线，人类零信息差接管）。
 */

export interface LeaseStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** 扫描全部 run 租约（生产：SCAN run:*:lease） */
  scanRunLeases(): Promise<Array<{ runId: string; value: string }>>;
}

interface LeaseEntry { value: string; expiresAt: number }

export class MemoryLeaseStore implements LeaseStore {
  private data = new Map<string, LeaseEntry>();
  constructor(private now: () => number = () => Date.now()) {}
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  async get(key: string): Promise<string | null> {
    const e = this.data.get(key);
    if (!e) return null;
    if (this.now() > e.expiresAt) { this.data.delete(key); return null; }
    return e.value;
  }
  async delete(key: string): Promise<void> { this.data.delete(key); }
  async scanRunLeases(): Promise<Array<{ runId: string; value: string }>> {
    const out: Array<{ runId: string; value: string }> = [];
    for (const [k, e] of this.data) {
      const m = /^run:(.+):lease$/.exec(k);
      if (m && this.now() <= e.expiresAt) out.push({ runId: m[1], value: e.value });
    }
    return out;
  }
  /** 测试辅助：全部租约（含过期未清的） */
  rawEntries(): Map<string, LeaseEntry> { return this.data; }
}

export interface ZombieVerdict {
  runId: string;
  action: "replay" | "circuit";
  zombieCount: number;
  /** action=circuit 时生成 P1 + 需介入工单 */
  ticket?: { level: "P1"; title: string; runId: string };
}

export class RunSupervisor {
  private zombies = new Map<string, number>(); // runId → 连续僵尸次数
  private known = new Set<string>();           // 曾见租约的 run（过期即消失 → 判僵尸）

  constructor(
    private store: MemoryLeaseStore,
    private opts: { leaseTtlMs?: number; maxZombies?: number; now?: () => number } = {},
  ) {}

  /** run 每步执行续约（TTL 60s） */
  async heartbeat(runId: string, checkpoint: string): Promise<void> {
    this.known.add(runId);
    await this.store.set(`run:${runId}:lease`, checkpoint, this.opts.leaseTtlMs ?? 60_000);
  }

  async runCompleted(runId: string): Promise<void> {
    this.known.delete(runId);
    this.zombies.delete(runId);
    await this.store.delete(`run:${runId}:lease`);
  }

  /** 调度器周期扫描：租约过期 → 僵尸判定 → replay 或熔断 */
  async sweep(): Promise<ZombieVerdict[]> {
    const now = (this.opts.now ?? Date.now)();
    const verdicts: ZombieVerdict[] = [];
    for (const runId of this.known) {
      const entry = this.store.rawEntries().get(`run:${runId}:lease`);
      const alive = entry !== undefined && now <= entry.expiresAt;
      if (alive) { this.zombies.delete(runId); continue; }
      const count = (this.zombies.get(runId) ?? 0) + 1;
      this.zombies.set(runId, count);
      if (count >= (this.opts.maxZombies ?? 3)) {
        this.known.delete(runId); // 熔断：不再自动 replay
        verdicts.push({
          runId, action: "circuit", zombieCount: count,
          ticket: { level: "P1", title: `病态任务熔断：run ${runId} 连续 ${count} 次僵尸`, runId },
        });
      } else {
        verdicts.push({ runId, action: "replay", zombieCount: count });
      }
    }
    return verdicts;
  }
}
