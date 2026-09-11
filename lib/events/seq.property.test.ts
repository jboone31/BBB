import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { FIRST_SEQ, nextSeq } from "./index";

/**
 * Feature: web-app-foundation, Property 7: Per-game sequence is contiguous, gap-free, and matches write order
 *
 * For any series of N successfully committed event appends within a single game
 * (including concurrent appends), the assigned `seq` values form a contiguous,
 * strictly increasing, duplicate-free set, and ordering the events by `seq`
 * reproduces exactly the order in which they committed.
 *
 * `appendEvent` (lib/events/index.ts) assigns each seq under a per-game lock:
 * the game row is taken `FOR UPDATE`, the current `max(seq)` is read, and the
 * event is inserted at `max+1` — all in one statement, so concurrent appenders
 * for the same game are serialized and cannot interleave the read/insert. The
 * pure core of that assignment is {@link nextSeq}: given the current committed
 * max (or null), it returns the next seq. This test models the lock as a
 * serialization of appends and drives seq assignment through `nextSeq`, so any
 * interleaving/concurrency of N appends reduces to some commit order of those
 * appends. It also models rollback: an append whose transaction rolls back
 * leaves the committed max unchanged, so it consumes no seq and leaves no gap.
 *
 * The real database-level guarantee (the `FOR UPDATE` lock + `unique (game_id,
 * seq)` constraint) is exercised end-to-end by the integration tests (Task 18);
 * here we property-test the pure sequencing model.
 *
 * Validates: Requirements 4.5
 */

/** A modeled append attempt against a game, tagged with the game it targets. */
interface AppendAttempt {
  /** Which game this append targets. */
  readonly gameId: string;
  /** True if the append's transaction commits; false if it rolls back. */
  readonly commits: boolean;
}

/** A committed append, in the order it committed, with its assigned seq. */
interface Committed {
  /** The order in which this append committed across the whole run (0-based). */
  readonly commitOrder: number;
  readonly seq: number;
}

/**
 * Simulate a serialized run of append attempts across one or more games under
 * the per-game lock modeled by {@link nextSeq}.
 *
 * Because the per-game lock serializes appenders for a game, ANY concurrent
 * interleaving of appends is observationally equivalent to processing the
 * attempts in some sequential commit order — that is exactly the input array's
 * order here. Each attempt:
 *   - reads the game's current committed max seq (null if none yet),
 *   - computes the next seq via `nextSeq`,
 *   - if it commits, records the event and advances the game's committed max;
 *   - if it rolls back, leaves the committed max unchanged (no seq consumed).
 *
 * @returns a map from gameId to the list of its committed events, in commit
 *   order, each carrying its assigned seq and a global commit-order index.
 */
function runAppends(
  attempts: readonly AppendAttempt[],
): Map<string, Committed[]> {
  const committedByGame = new Map<string, Committed[]>();
  const maxSeqByGame = new Map<string, number | null>();
  let globalCommitOrder = 0;

  for (const attempt of attempts) {
    const { gameId } = attempt;
    if (!committedByGame.has(gameId)) {
      committedByGame.set(gameId, []);
      maxSeqByGame.set(gameId, null);
    }

    // Read the current committed max under the lock, compute the next seq.
    const currentMax = maxSeqByGame.get(gameId) ?? null;
    const assigned = nextSeq(currentMax);

    if (attempt.commits) {
      committedByGame.get(gameId)!.push({
        commitOrder: globalCommitOrder++,
        seq: assigned,
      });
      // Only a committed append advances the game's max seq.
      maxSeqByGame.set(gameId, assigned);
    }
    // A rolled-back append leaves maxSeqByGame unchanged: no seq consumed.
  }

  return committedByGame;
}

/** An append attempt across a small set of games, mostly committing. */
const attemptArb: fc.Arbitrary<AppendAttempt> = fc.record({
  gameId: fc.constantFrom("g1", "g2", "g3"),
  // Bias toward commits so most runs have several committed events, while still
  // exercising rollbacks (which must not consume a seq / leave a gap).
  commits: fc.oneof(
    { arbitrary: fc.constant(true), weight: 4 },
    { arbitrary: fc.constant(false), weight: 1 },
  ),
});

describe("nextSeq — Per-game sequence is contiguous, gap-free, and matches write order (Property 7)", () => {
  it("assigns each game a contiguous, strictly-increasing, gap-free, duplicate-free seq that matches commit order", () => {
    fc.assert(
      fc.property(
        fc.array(attemptArb, { minLength: 0, maxLength: 200 }),
        (attempts) => {
          const committedByGame = runAppends(attempts);

          for (const committed of committedByGame.values()) {
            const seqs = committed.map((c) => c.seq);

            // Contiguous from FIRST_SEQ with no gaps: [1, 2, ..., k].
            const expected = seqs.map((_, i) => FIRST_SEQ + i);
            expect(seqs).toEqual(expected);

            // Strictly increasing (implied by the above, asserted explicitly).
            for (let i = 1; i < seqs.length; i++) {
              expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
            }

            // Duplicate-free.
            expect(new Set(seqs).size).toBe(seqs.length);

            // Ordering by seq reproduces commit order: the array is already in
            // commit order, so sorting by seq must not change the commit-order
            // sequence.
            const byCommitOrder = committed.map((c) => c.commitOrder);
            const bySeq = committed
              .slice()
              .sort((a, b) => a.seq - b.seq)
              .map((c) => c.commitOrder);
            expect(bySeq).toEqual(byCommitOrder);
            // And commit order is itself strictly increasing along seq order.
            for (let i = 1; i < bySeq.length; i++) {
              expect(bySeq[i]).toBeGreaterThan(bySeq[i - 1]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does not consume a seq for a rolled-back append (no gap)", () => {
    fc.assert(
      fc.property(
        // A run against a single game where some appends roll back.
        fc.array(fc.boolean(), { minLength: 0, maxLength: 100 }),
        (commitFlags) => {
          const attempts: AppendAttempt[] = commitFlags.map((commits) => ({
            gameId: "solo",
            commits,
          }));
          const committedByGame = runAppends(attempts);
          const committed = committedByGame.get("solo") ?? [];

          // The number of committed events equals the number of commit flags
          // that are true (rollbacks contributed nothing).
          const expectedCount = commitFlags.filter(Boolean).length;
          expect(committed.length).toBe(expectedCount);

          // Seqs are still a clean, gap-free run 1..k regardless of interleaved
          // rollbacks.
          expect(committed.map((c) => c.seq)).toEqual(
            committed.map((_, i) => FIRST_SEQ + i),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps sequences independent across games", () => {
    // Explicit interleaving: two games' appends alternate, yet each game gets
    // its own 1..k sequence unaffected by the other's appends.
    const attempts: AppendAttempt[] = [
      { gameId: "a", commits: true },
      { gameId: "b", commits: true },
      { gameId: "a", commits: true },
      { gameId: "b", commits: true },
      { gameId: "a", commits: true },
    ];
    const committedByGame = runAppends(attempts);

    expect(committedByGame.get("a")!.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(committedByGame.get("b")!.map((c) => c.seq)).toEqual([1, 2]);
  });

  it("first committed event of a game is FIRST_SEQ", () => {
    const committedByGame = runAppends([{ gameId: "g", commits: true }]);
    expect(committedByGame.get("g")![0].seq).toBe(FIRST_SEQ);
  });
});
