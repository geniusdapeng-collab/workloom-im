/**
 * biz_events.seq is a global PostgreSQL BIGSERIAL allocation, independent of each
 * (tenant_id, workspace_id) hash chain. ON CONFLICT, rollback, cache allocation and
 * other scopes can all leave arbitrarily large gaps. Their sizes are observations;
 * they cannot prove removal of signed events or identify why an ID is absent.
 */
export interface SequenceObservation {
  previous: bigint | null;
  gaps: bigint;
  intervals: number;
  maximumGap: bigint;
}

export function createSequenceObservation(): SequenceObservation {
  return { previous: null, gaps: 0n, intervals: 0, maximumGap: 0n };
}

/** Return a real storage-order violation; never classify an allocation gap as one. */
export function observeStorageSequence(state: SequenceObservation, raw: string): string | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return `seq ${raw} 不是正整数存储序号`;
  const value = BigInt(raw);
  if (value > 9223372036854775807n) return `seq ${raw} 超出 PostgreSQL bigint 存储范围`;
  if (state.previous !== null) {
    if (value <= state.previous) return `seq ${state.previous} → ${value} 未严格单调递增`;
    const gap = value - state.previous - 1n;
    if (gap > 0n) {
      state.gaps += gap;
      state.intervals += 1;
      if (gap > state.maximumGap) state.maximumGap = gap;
    }
  }
  state.previous = value;
  return undefined;
}

/** Existing safe counts stay numeric; larger counts use an exact decimal JSON string. */
export function exactSequenceCount(value: bigint): number | string {
  if (value < 0n) throw new RangeError("Sequence counts must be non-negative");
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
