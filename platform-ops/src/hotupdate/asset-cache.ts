/**
 * hotupdate/asset-cache —— 带版本键的热更新缓存（PRD V3.0 §19.1 统一生效机制）
 *
 * 所有资产（技能/围栏/班组/模型策略/知识/运营策略）读取处改为带版本键的缓存：
 * 激活事件经总线广播 asset.invalidate → 各进程失效对应缓存键 → 下次读取即新版本。
 * 无重启、无全量刷新，秒级生效。
 * 安全语义优先：围栏规则的缓存额外加 60s 强制 TTL 兜底——拦截规则的变更最迟 1 分钟生效。
 */

export type AssetKind = "skill" | "fence" | "preset" | "model-policy" | "kb" | "strategy";

export interface VersionedAsset<T = unknown> {
  kind: AssetKind;
  key: string;
  version: string;
  data: T;
}

interface CacheEntry { asset: VersionedAsset; cachedAt: number; lastAccess: number }

/** 围栏类资产强制短 TTL（§19.1 安全语义优先） */
export const FENCE_FORCE_TTL_MS = 60_000;

export class AssetCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }
  private now: () => number;

  private id(kind: AssetKind, key: string): string { return `${kind}:${key}`; }

  /** 读取（缓存命中且未过期直接返回；否则 loader 回源并回填最新版本） */
  async get<T>(kind: AssetKind, key: string, loader: () => Promise<VersionedAsset<T>>): Promise<VersionedAsset<T>> {
    const id = this.id(kind, key);
    const hit = this.cache.get(id);
    if (hit) {
      const forceTtl = kind === "fence" ? FENCE_FORCE_TTL_MS : Infinity;
      if (this.now() - hit.cachedAt < forceTtl) {
        hit.lastAccess = this.now();
        return hit.asset as VersionedAsset<T>;
      }
      this.cache.delete(id); // 围栏强制过期：回源
    }
    const fresh = await loader();
    this.set(fresh);
    return fresh;
  }

  set(asset: VersionedAsset): void {
    if (this.cache.size >= this.maxEntries) this.evictLru();
    this.cache.set(this.id(asset.kind, asset.key), { asset, cachedAt: this.now(), lastAccess: this.now() });
  }

  /** asset.invalidate 广播处理（激活事件 → 失效对应键） */
  invalidate(kind: AssetKind, key: string): boolean {
    return this.cache.delete(this.id(kind, key));
  }

  /** 整类失效（如 bundle 原子激活后整批失效） */
  invalidateKind(kind: AssetKind): number {
    let n = 0;
    for (const id of this.cache.keys()) if (id.startsWith(`${kind}:`)) { this.cache.delete(id); n += 1; }
    return n;
  }

  private evictLru(): void {
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [id, e] of this.cache) if (e.lastAccess < oldestAt) { oldestAt = e.lastAccess; oldest = id; }
    if (oldest) this.cache.delete(oldest);
  }

  size(): number { return this.cache.size; }
}

/**
 * 围栏变更安全红线（§19.4-1）：放宽（block→review、review→auto）必须人类审批+双人复核；
 * 收紧可走快速通道。返回变更方向判定。
 */
export function fenceChangeDirection(before: string, after: string): "tighten" | "loosen" | "neutral" {
  const rank: Record<string, number> = { block: 2, review: 1, auto: 0 };
  const b = rank[before] ?? -1;
  const a = rank[after] ?? -1;
  if (a > b) return "tighten";
  if (a < b) return "loosen";
  return "neutral";
}
