import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";
import type {
  LastSeenStore,
  RealtimeChannel,
  RealtimeTransport,
} from "@/lib/realtime";
import type { SnapshotSource } from "@/lib/realtime/snapshot";
import {
  resumeReinitialize,
  type ResetTransientRecovery,
} from "@/lib/realtime/resume";

/**
 * Feature: web-app-foundation, Property 12: Resume catch-up delivers exactly the missed events
 *
 * On resume-from-background / relaunch, {@link resumeReinitialize} (recovery
 * path (b); Req 6.7) reads the persisted `Last_Seen_Sequence` `L`, then fetches
 * the game's persisted events and applies — in ascending `seq` order — exactly
 * those with `seq > L`. Because the per-game sequence is gap-free (Req 4.5), an
 * arbitrarily long absence is caught up precisely: every event above the
 * watermark is delivered once, in order, and nothing at or below it is
 * re-delivered.
 *
 * This must hold for any watermark `L` (below 0, inside 1..M, or beyond M) over
 * a contiguous persisted set (seqs 1..M), and it must be **independent of any
 * transient path-(a) retry budget** — resume is unconditional, so an already
 * exhausted budget changes neither what is delivered nor the fact that it runs.
 * When a `resetTransientRecovery` hook is supplied it is always invoked (pulling
 * a possibly-terminal path (a) back to reconnecting; Req 6.8).
 *
 * Validates: Requirements 6.7
 */

const GAME_ID = "game-under-test";
const OTHER_GAME_ID = "other-game";

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
 * An in-memory {@link SnapshotSource} that returns a contiguous persisted event
 * set (seqs 1..M) for `GAME_ID`, ascending. Any other game yields no events.
 */
function fakeSnapshotSource(persisted: readonly GameEvent[]): SnapshotSource {
  return {
    async fetchEventsAscending(gameId: string): Promise<GameEvent[]> {
      return persisted
        .filter((e) => e.gameId === gameId)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.seq - b.seq);
    },
  };
}

/** A {@link RealtimeChannel} that records whether it was unsubscribed. */
class FakeChannel implements RealtimeChannel {
  unsubscribed = false;
  unsubscribe(): void {
    this.unsubscribed = true;
  }
}

/**
 * A {@link RealtimeTransport} that records every resubscribe call (the game id
 * and the row sink it was handed) and returns a trivial channel.
 */
class FakeTransport implements RealtimeTransport {
  readonly opened: Array<{
    gameId: string;
    onRow: (event: GameEvent) => void;
  }> = [];
  readonly channels: FakeChannel[] = [];

  channel(gameId: string, onRow: (event: GameEvent) => void): RealtimeChannel {
    this.opened.push({ gameId, onRow });
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
}

/** A {@link LastSeenStore} that always returns a fixed watermark `L`. */
function fixedLastSeenStore(l: number): LastSeenStore {
  return {
    get: () => l,
    set: () => {
      /* resume does not write the watermark; ignore. */
    },
  };
}

/**
 * Run {@link resumeReinitialize} for `GAME_ID` with fakes and collect what was
 * delivered. `budgetExhausted` is a purely transient path-(a) flag threaded
 * through only to prove independence: it must not change the delivered set.
 */
async function runResume(args: {
  persisted: readonly GameEvent[];
  l: number;
  budgetExhausted: boolean;
  withResetHook: boolean;
}): Promise<{
  delivered: GameEvent[];
  caughtUp: readonly GameEvent[];
  transport: FakeTransport;
  resetCalls: number;
}> {
  const delivered: GameEvent[] = [];
  const transport = new FakeTransport();
  let resetCalls = 0;

  // The retry-budget flag is deliberately inert: whether "exhausted" or not, it
  // feeds no branch of resume. It exists only so the property can compare two
  // runs that differ solely by it.
  void args.budgetExhausted;

  const resetTransientRecovery: ResetTransientRecovery | undefined =
    args.withResetHook
      ? () => {
          resetCalls += 1;
        }
      : undefined;

  const outcome = await resumeReinitialize({
    gameId: GAME_ID,
    lastSeenStore: fixedLastSeenStore(args.l),
    snapshotSource: fakeSnapshotSource(args.persisted),
    transport,
    onEvent: (event) => {
      delivered.push(event);
    },
    resetTransientRecovery,
  });

  return { delivered, caughtUp: outcome.caughtUp, transport, resetCalls };
}

describe("resumeReinitialize — Resume catch-up delivers exactly the missed events (Property 12)", () => {
  it("delivers exactly seq > L, ascending, no gaps/dupes, independent of retry budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Contiguous persisted set: seqs 1..M for the game.
        fc.integer({ min: 0, max: 60 }),
        // Watermark L spanning below 0 (well under the first seq) through beyond M.
        fc.integer({ min: -5, max: 70 }),
        // Arbitrary transient retry-budget state (must not affect the outcome).
        fc.boolean(),
        // Whether a reset-transient-recovery hook is wired in.
        fc.boolean(),
        async (m, l, budgetExhausted, withResetHook) => {
          const persisted = Array.from({ length: m }, (_, i) => eventAt(i + 1));

          const { delivered, caughtUp, transport, resetCalls } =
            await runResume({ persisted, l, budgetExhausted, withResetHook });

          // Expected catch-up: exactly the persisted events with seq > L, in
          // ascending seq order. Contiguous set means this is [max(L+1,1) .. M].
          const expectedSeqs = persisted
            .filter((e) => e.seq > l)
            .map((e) => e.seq);

          const deliveredSeqs = delivered.map((e) => e.seq);
          const caughtUpSeqs = caughtUp.map((e) => e.seq);

          // Delivered == events with seq > L (and matches the returned record).
          expect(deliveredSeqs).toEqual(expectedSeqs);
          expect(caughtUpSeqs).toEqual(expectedSeqs);

          // Ascending, strictly increasing => no gaps within the tail, no dupes.
          for (let i = 1; i < deliveredSeqs.length; i++) {
            expect(deliveredSeqs[i]).toBe(deliveredSeqs[i - 1] + 1);
          }
          expect(new Set(deliveredSeqs).size).toBe(deliveredSeqs.length);

          // Nothing at or below the watermark was re-delivered.
          for (const seq of deliveredSeqs) {
            expect(seq).toBeGreaterThan(l);
          }

          // Resubscribe happened, on the correct game.
          expect(transport.opened).toHaveLength(1);
          expect(transport.opened[0]?.gameId).toBe(GAME_ID);

          // The reset hook, when supplied, is invoked exactly once (Req 6.8);
          // when absent, resume still runs to completion.
          expect(resetCalls).toBe(withResetHook ? 1 : 0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("delivers the identical set whether or not the retry budget is exhausted (independence)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: -5, max: 70 }),
        async (m, l) => {
          const persisted = Array.from({ length: m }, (_, i) => eventAt(i + 1));

          const withBudget = await runResume({
            persisted,
            l,
            budgetExhausted: true,
            withResetHook: true,
          });
          const withoutBudget = await runResume({
            persisted,
            l,
            budgetExhausted: false,
            withResetHook: true,
          });

          // Same catch-up regardless of the transient retry-budget state.
          expect(withBudget.delivered.map((e) => e.seq)).toEqual(
            withoutBudget.delivered.map((e) => e.seq),
          );
          // And resume runs (resubscribes + resets) in both cases.
          expect(withBudget.transport.opened).toHaveLength(1);
          expect(withoutBudget.transport.opened).toHaveLength(1);
          expect(withBudget.resetCalls).toBe(1);
          expect(withoutBudget.resetCalls).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("only catches up its own game's events (isolation over the persisted set)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: -5, max: 50 }),
        async (m, other, l) => {
          const mine = Array.from({ length: m }, (_, i) => eventAt(i + 1));
          const theirs = Array.from({ length: other }, (_, i) =>
            eventAt(i + 1, OTHER_GAME_ID),
          );
          // Interleave the two games' events in the persisted set.
          const persisted = [...mine, ...theirs];

          const { delivered } = await runResume({
            persisted,
            l,
            budgetExhausted: false,
            withResetHook: false,
          });

          // Only GAME_ID events with seq > L are delivered; the other game's
          // events never leak in.
          expect(delivered.map((e) => e.seq)).toEqual(
            mine.filter((e) => e.seq > l).map((e) => e.seq),
          );
          expect(delivered.every((e) => e.gameId === GAME_ID)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
