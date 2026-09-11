import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";

import {
  applyEvent,
  foldEvents,
  initialSnapshot,
  NO_EVENTS_SEQ,
  type GameStateSnapshot,
} from "./snapshot";

/**
 * Feature: web-app-foundation, Property 10: Snapshot equals the fold of all prior events
 *
 * When a client subscribes to a game it receives a snapshot: the state that
 * results from folding the append-only `game_events` log in ascending `seq`
 * order. The snapshot loader (`loadSnapshot` -> `foldEvents`) must produce
 * exactly
 *
 *   reduce(applyEvent, initialSnapshot(gameId), events with seq <= N, ascending)
 *
 * for the events persisted at fetch time (see design.md Component 5). This
 * property fixes that guarantee: for a random contiguous event log (seqs
 * 1..M for a single game) and an arbitrary cutoff N, `foldEvents` over the
 * events with `seq <= N` equals the reference left-fold of `applyEvent` over
 * those same events in ascending order — and the result is independent of the
 * arrival order the events are handed to `foldEvents` in (shuffling the input
 * yields the same snapshot).
 *
 * Validates: Requirements 6.4
 */

/** A small JSON-like payload generator — arbitrary event bodies. */
const payloadArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 12 }),
  fc.integer(),
  fc.boolean(),
  fc.dictionary(
    fc.string({ maxLength: 6 }),
    fc.oneof(fc.string({ maxLength: 12 }), fc.integer(), fc.boolean()),
    { maxKeys: 4 },
  ),
);

/**
 * Build a contiguous event log for `gameId`: events with seqs 1..count in
 * ascending order, each with an arbitrary type, actor, and payload. Sequences
 * are contiguous and gap-free to mirror the per-game `seq` the events backbone
 * assigns (see `nextSeq` / `FIRST_SEQ` in `lib/events`).
 */
function eventLogArb(gameId: string): fc.Arbitrary<GameEvent[]> {
  return fc
    .array(
      fc.record({
        eventType: fc.constantFrom(
          "claim_recorded",
          "card_played",
          "score_updated",
          "game_ended",
        ),
        actorKind: fc.constantFrom(
          "team" as const,
          "admin" as const,
          "system" as const,
        ),
        teamId: fc.constantFrom("t1", "t2", "t3", "t4"),
        payload: payloadArb,
        createdAtMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
      }),
      { minLength: 0, maxLength: 40 },
    )
    .map((rows) =>
      rows.map((row, index): GameEvent => {
        const seq = index + 1; // contiguous seqs starting at FIRST_SEQ (1)
        return {
          id: `${gameId}-e${seq}`,
          gameId,
          seq,
          eventType: row.eventType,
          actorKind: row.actorKind,
          actorTeamId: row.actorKind === "team" ? row.teamId : null,
          payload: row.payload,
          createdAt: new Date(row.createdAtMs).toISOString(),
        };
      }),
    );
}

/**
 * Reference implementation of the guarantee: a plain ascending left-fold of
 * `applyEvent` from the initial snapshot. `foldEvents` must agree with this for
 * any input, regardless of the order the events arrive in.
 */
function referenceFold(
  gameId: string,
  events: readonly GameEvent[],
): GameStateSnapshot {
  const ascending = [...events].sort((a, b) => a.seq - b.seq);
  return ascending.reduce(applyEvent, initialSnapshot(gameId));
}

describe("snapshot — Snapshot equals the fold of all prior events (Property 10)", () => {
  it("foldEvents(events with seq <= N) == reduce(applyEvent, initial, ascending)", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            eventLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        // A cutoff seed used to pick N in [0, M].
        fc.integer({ min: 0, max: 40 }),
        (log, cutoffSeed) => {
          const { gameId, events } = log;
          const m = events.length;
          const n = m === 0 ? 0 : cutoffSeed % (m + 1); // N in [0, M]

          const upToN = events.filter((e) => e.seq <= n);

          // Canonical fold from the module.
          const snapshot = foldEvents(gameId, upToN);
          // Independent reference fold.
          const expected = referenceFold(gameId, upToN);

          // 1. Snapshot equals the reference fold of events with seq <= N.
          expect(snapshot).toEqual(expected);

          // 2. It reflects exactly the events with seq <= N: count, last seq,
          //    and the applied seqs are precisely 1..N ascending.
          expect(snapshot.gameId).toBe(gameId);
          expect(snapshot.eventCount).toBe(upToN.length);
          expect(snapshot.appliedSeqs).toEqual(upToN.map((e) => e.seq));
          expect(snapshot.lastSeenSequence).toBe(
            upToN.length === 0 ? NO_EVENTS_SEQ : n,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is independent of input arrival order (shuffling the input yields the same snapshot)", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            eventLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        // A permutation of indices used to shuffle the input order.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 40 }),
        ({ gameId, events }, keys) => {
          const inOrder = foldEvents(gameId, events);

          // Shuffle a copy of the events by pairing each with a random key and
          // sorting on that key — arrival order is arbitrary.
          const shuffled = events
            .map((e, i) => ({ e, k: keys[i] ?? i }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.e);

          const shuffledFold = foldEvents(gameId, shuffled);

          // The fold sorts by seq internally, so arrival order is irrelevant.
          expect(shuffledFold).toEqual(inOrder);
          expect(shuffledFold).toEqual(referenceFold(gameId, events));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("de-duplicates repeated seqs so an event is folded at most once", () => {
    // Explicit example: duplicate deliveries (same seq) must not double-count,
    // matching applyEvent's stale/duplicate guard.
    const gameId = "game-dup";
    const base: Omit<GameEvent, "seq" | "id"> = {
      gameId,
      eventType: "claim_recorded",
      actorKind: "team",
      actorTeamId: "t1",
      payload: { barId: "b1" },
      createdAt: new Date(0).toISOString(),
    };
    const e1: GameEvent = { ...base, id: "e1", seq: 1 };
    const e2: GameEvent = { ...base, id: "e2", seq: 2 };

    const withDupes = foldEvents(gameId, [e1, e1, e2, e2, e1]);

    expect(withDupes.eventCount).toBe(2);
    expect(withDupes.appliedSeqs).toEqual([1, 2]);
    expect(withDupes.lastSeenSequence).toBe(2);
    expect(withDupes).toEqual(foldEvents(gameId, [e1, e2]));
  });
});
