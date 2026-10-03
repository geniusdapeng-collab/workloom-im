import { describe, expect, it } from "vitest";
import { createSequenceObservation, observeStorageSequence, exactSequenceCount } from "./chain-sequence.js";

describe("global storage sequence observations", () => {
  it("starts with an empty observation and no inferred missing prefix", () => {
    const state = createSequenceObservation();
    expect(state).toEqual({ previous: null, gaps: 0n, intervals: 0, maximumGap: 0n });
    expect(observeStorageSequence(state, "9000")).toBeUndefined();
    expect(state.gaps).toBe(0n);
  });

  it("accepts contiguous positive storage IDs", () => {
    const state = createSequenceObservation();
    for (const value of ["1", "2", "3"]) expect(observeStorageSequence(state, value)).toBeUndefined();
    expect(state.gaps).toBe(0n);
    expect(state.intervals).toBe(0);
  });

  it("observes unbounded allocator gaps without inferring deletions", () => {
    const state = createSequenceObservation();
    for (const value of ["1", "609", "610", "9223372036854775807"]) {
      expect(observeStorageSequence(state, value)).toBeUndefined();
    }
    expect(state.gaps).toBe(9223372036854775803n);
    expect(state.intervals).toBe(2);
    expect(state.maximumGap).toBe(9223372036854775196n);
  });

  it.each(["0", "-1", "+1", "1.5", "NaN", "", "9223372036854775808"])("rejects invalid storage IDs: %j", (value) => {
    const state = createSequenceObservation();
    expect(observeStorageSequence(state, value)).toMatch(/seq/);
    expect(state.previous).toBeNull();
  });

  it.each(["7", "6"])("rejects repeated or decreasing storage IDs: %s", (value) => {
    const state = createSequenceObservation();
    expect(observeStorageSequence(state, "7")).toBeUndefined();
    expect(observeStorageSequence(state, value)).toMatch(/单调递增/);
    expect(state.previous).toBe(7n);
    expect(state.gaps).toBe(0n);
  });

  it("does not combine tenant/workspace observations", () => {
    const a = createSequenceObservation();
    const b = createSequenceObservation();
    for (const value of ["1", "10"]) expect(observeStorageSequence(a, value)).toBeUndefined();
    for (const value of ["2", "9"]) expect(observeStorageSequence(b, value)).toBeUndefined();
    expect(a.gaps).toBe(8n);
    expect(b.gaps).toBe(6n);
  });

  it("keeps exact counts across the safe integer boundary and JSON serialization", () => {
    expect(exactSequenceCount(0n)).toBe(0);
    expect(exactSequenceCount(9007199254740991n)).toBe(9007199254740991);
    expect(exactSequenceCount(9007199254740992n)).toBe("9007199254740992");
    const huge = exactSequenceCount(9223372036854775805n);
    expect(JSON.parse(JSON.stringify({ huge }))).toEqual({ huge: "9223372036854775805" });
    expect(() => exactSequenceCount(-1n)).toThrow(/non-negative/);
  });

  it("counts every gap exactly for 200 deterministic interleaved allocations", () => {
    for (let length = 1; length <= 200; length += 1) {
      const state = createSequenceObservation();
      const rows: bigint[] = [];
      let value = 9007199254740990n;
      for (let index = 0; index < length; index += 1) {
        value += BigInt((index * 17 + length) % 997 + 1);
        rows.push(value);
        expect(observeStorageSequence(state, value.toString())).toBeUndefined();
      }
      const expected = rows.at(-1)! - rows[0]! + 1n - BigInt(rows.length);
      expect(state.gaps).toBe(expected);
      expect(BigInt(exactSequenceCount(state.gaps))).toBe(expected);
    }
  });
});
