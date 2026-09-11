import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";
import {
  applyInOrder,
  initialOrderedApplyState,
  type OrderedApplyState,
} from "@/lib/realtime";
import { NO_EVENTS_SEQ } from "@/lib/realtime/snapshot";

/**
 * Feature: web-app-foundation, Property 13: Client applies events in sequence order
 *
 * The realtime transport may deliver a game's events out of order and may
 * re-deliver them. The pure ordered-apply core ({@link applyInOrder}) must,
 * regardless of arrival order or duplicates, report events as *applied* exactly
 * once each and in ascending `seq` order — de-duplicating already-applied
 * `seq`s and buffering out-of-order (future) arrivals until the gap fills
 * (see the JSDoc on `applyInOrder`; Req 6.6, 6.9).
 *
 * For a contiguous event batch (seqs 1..M for a game) delivered in a random
 * permutation with random duplicates inserted, feeding each arrival through
 * `applyInOrder` and concatenating each result's `applied` yields exactly
 * [1..M] in ascending order, once each, and ends with `lastSeenSequence === M`.
 *
 * Validates: Requirements 6.9
 */

const GAME_ID = "game-under-test";

/** Build a minimal but well-formed {@link GameEvent} at a given `seq`. */
function eventAt(seq: number, gameId: string = GAME_ID): GameEvent {
  return {
    id: `${gameId}:${seq}`,
    gameId,
    seq,
    eventType: "score_updated",
    actorKind: "system",
    actorTeamId: null,
    payload: { seq },
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  };
}

/**
 * Feed a stream of arrivals through {@link applyInOrder}, starting from an
 * optional seed watermark, and return the concatenation of everything applied
 * (in the order it was applied) plus the final state.
 */
function drive(
  arrivals: readonly GameEvent[],
  seed: number = NO_EVENTS_SEQ,
): { applied: GameEvent[]; state: OrderedApplyState } {
  let state = initialOrderedApplyState(seed);
  const applied: GameEvent[] = [];
  for (const event of arrivals) {
    const result = applyInOrder(state, event);
    state = result.state;
    applied.push(...result.applied);
  }
  return { applied, state };
}

describe("applyInOrder — Client applies events in sequence order (Property 13)", () => {
  it("applies a permuted, duplicated contiguous batch in ascending seq, deduped", () => {
    fc.assert(
      fc.property(
        // Batch size M (contiguous seqs 1..M).
        fc.integer({ min: 1, max: 60 }),
        // A seed shuffle for the permutation.
        fc.integer({ min: 0, max: 0xffff_ffff }),
        // How many random duplicates to sprinkle in.
        fc.integer({ min: 0, max: 40 }),
        (m, shuffleSeed, dupCount) => {
          const batch = Array.from({ length: m }, (_, i) => eventAt(i + 1));

          // Random permutation of the batch (deterministic from shuffleSeed).
          const rng = mulberry32(shuffleSeed);
          const permuted = shuffle(batch, rng);

          // Insert random duplicates (re-deliveries of arbitrary events) at
          // random positions.
          const arrivals = permuted.slice();
          for (let i = 0; i < dupCount; i++) {
            const dup = batch[Math.floor(rng() * batch.length)];
            const at = Math.floor(rng() * (arrivals.length + 1));
            arrivals.splice(at, 0, dup);
          }

          const { applied, state } = drive(arrivals);

          // Applied order is exactly 1..M, ascending, once each (deduped).
          expect(applied.map((e) => e.seq)).toEqual(
            Array.from({ length: m }, (_, i) => i + 1),
          );
          // Watermark reached the end of the batch, buffer fully drained.
          expect(state.lastSeenSequence).toBe(m);
          expect(state.buffer.size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("de-duplicates events at or below the seeded watermark", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }), // seed watermark
        fc.integer({ min: 1, max: 30 }), // additional new events beyond the seed
        fc.integer({ min: 0, max: 20 }), // how many stale re-deliveries
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (seed, extra, staleCount, shuffleSeed) => {
          const rng = mulberry32(shuffleSeed);

          // New events beyond the seed: seqs seed+1 .. seed+extra.
          const fresh = Array.from({ length: extra }, (_, i) =>
            eventAt(seed + 1 + i),
          );
          const arrivals = shuffle(fresh, rng);

          // Stale re-deliveries: seqs in 1..seed, already covered by the seed.
          for (let i = 0; i < staleCount; i++) {
            const staleSeq = 1 + Math.floor(rng() * seed);
            const at = Math.floor(rng() * (arrivals.length + 1));
            arrivals.splice(at, 0, eventAt(staleSeq));
          }

          const { applied, state } = drive(arrivals, seed);

          // Only the fresh events apply, ascending; stale ones are dropped.
          expect(applied.map((e) => e.seq)).toEqual(
            Array.from({ length: extra }, (_, i) => seed + 1 + i),
          );
          expect(state.lastSeenSequence).toBe(seed + extra);
          expect(state.buffer.size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps events after a gap buffered until the missing seq arrives", () => {
    // Explicit gap example: deliver 1, then 3, 4, 5 (seq 2 missing). Nothing
    // past the gap may be applied; the buffer holds 3,4,5. Once 2 arrives, the
    // whole contiguous run 2..5 drains at once.
    let state = initialOrderedApplyState();

    const r1 = applyInOrder(state, eventAt(1));
    state = r1.state;
    expect(r1.applied.map((e) => e.seq)).toEqual([1]);
    expect(state.lastSeenSequence).toBe(1);

    for (const s of [3, 4, 5]) {
      const r = applyInOrder(state, eventAt(s));
      state = r.state;
      // Nothing applies while seq 2 is missing.
      expect(r.applied).toEqual([]);
      // Watermark stays put at 1.
      expect(state.lastSeenSequence).toBe(1);
    }
    // 3, 4, 5 are all buffered.
    expect(state.buffer.size).toBe(3);

    // The missing seq 2 arrives: 2, then buffered 3,4,5 drain contiguously.
    const rFill = applyInOrder(state, eventAt(2));
    state = rFill.state;
    expect(rFill.applied.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    expect(state.lastSeenSequence).toBe(5);
    expect(state.buffer.size).toBe(0);
  });

  it("does not apply past a still-missing seq (property over random gaps)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }), // batch size M
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (m, shuffleSeed) => {
          const rng = mulberry32(shuffleSeed);
          // Pick a seq in 2..M to withhold, creating a gap.
          const missing = 2 + Math.floor(rng() * (m - 1));

          const batch = Array.from({ length: m }, (_, i) => eventAt(i + 1));
          const withoutMissing = batch.filter((e) => e.seq !== missing);
          const arrivals = shuffle(withoutMissing, rng);

          const { applied, state } = drive(arrivals);

          // Only the contiguous prefix below the gap can ever apply.
          expect(applied.map((e) => e.seq)).toEqual(
            Array.from({ length: missing - 1 }, (_, i) => i + 1),
          );
          expect(state.lastSeenSequence).toBe(missing - 1);
          // Everything above the gap (missing+1..M) sits buffered.
          expect(state.buffer.size).toBe(m - missing);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Deterministic helpers (self-contained so runs are reproducible from seeds)
 * -------------------------------------------------------------------------- */

/** A tiny deterministic PRNG (mulberry32) yielding floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using the supplied PRNG; returns a new array. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
