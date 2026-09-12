import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  foldGameBoardEvents,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  NO_EVENTS_SEQ,
  type GameBoardView,
} from "./events";

/**
 * Feature: in-game-landing-wireframe — Properties 4 & 5 (Game_Board event fold /
 * reducer).
 *
 * The Game_Board keeps no separate "current state" table: the `GameBoardView`
 * the Game_Board_Client renders is derived by folding the append-only
 * `game_events` log in ascending `seq` order (design.md §Components 1). These two
 * properties fix the guarantees that make that fold trustworthy:
 *
 *   - Property 4 (R8.2, R8.3): the snapshot loaded on subscribe equals the
 *     ordered fold — `foldGameBoardEvents(gameId, events)` equals applying those
 *     events once each in ascending `seq` order to `initialGameBoardView`; and
 *     applying an event whose `seq` is at or below the highest
 *     contiguously-applied `seq` leaves the view unchanged (idempotence guard).
 *   - Property 5 (R8.4): the reducer only folds its own Game's events — for any
 *     view and any event whose `gameId` differs, `applyGameBoardEvent` rejects
 *     the event (it throws a `RangeError` rather than folding a foreign Game's
 *     event into the view).
 *
 * Both properties drive the pure, framework-free reducer in `./events`, so no
 * live database or transport is involved. The generator below builds valid
 * `GameEvent` rows (matching the `GameEvent` shape from `lib/events`) carrying
 * the Game_Board `event_type`/payload shapes from the design, mirroring the
 * lobby suite in `lib/lobby/events.property.test.ts`.
 */

// ---------------------------------------------------------------------------
// Generators: build valid Game_Board GameEvent fixtures.
//
// Each generated event carries one of the design's Game_Board event types with a
// payload of the matching shape. The `seq`/`id` fields are stamped after the
// array is built so sequences are contiguous (1..count), gap-free, matching the
// per-game seq the events backbone assigns (FIRST_SEQ = 1). `actorKind`/
// `actorTeamId` are consistent with the actor column model but do not affect the
// fold, which keys on `event_type`/`payload`.
// ---------------------------------------------------------------------------

/** Small identifier-ish string generator for ids/names/colors. */
const idArb = (prefix: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 9999 }).map((n) => `${prefix}${n}`);

/**
 * A Game_Board event "spec" — the type + payload — before it is stamped with a
 * seq. Payloads follow the design's Game_Board event shapes exactly.
 */
const boardEventSpecArb: fc.Arbitrary<{
  eventType: string;
  payload: unknown;
  actorTeamId: string | null;
}> = fc.oneof(
  // game_created — Team-less game facts (adds no Team to the roster).
  fc.record({ joinCode: idArb("JOIN") }).map((payload) => ({
    eventType: GAME_BOARD_EVENT_TYPES.gameCreated,
    payload,
    actorTeamId: null,
  })),
  // team_created — { teamId, name, color } (builds the scoreboard roster).
  fc
    .record({ teamId: idArb("t"), name: idArb("team"), color: idArb("#c") })
    .map((payload) => ({
      eventType: GAME_BOARD_EVENT_TYPES.teamCreated,
      payload,
      actorTeamId: null,
    })),
  // game_started — lifecycle → live.
  fc.record({ liveStartedAt: idArb("ts") }).map((payload) => ({
    eventType: GAME_BOARD_EVENT_TYPES.gameStarted,
    payload,
    actorTeamId: null,
  })),
  // game_ended — lifecycle → ended.
  fc.record({ endedAt: idArb("ts") }).map((payload) => ({
    eventType: GAME_BOARD_EVENT_TYPES.gameEnded,
    payload,
    actorTeamId: null,
  })),
  // wireframe_card_played — { castingTeamId, targetTeamId, cardId } → one notice.
  fc
    .record({
      castingTeamId: idArb("t"),
      targetTeamId: idArb("t"),
      cardId: idArb("card"),
    })
    .map((payload) => ({
      eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
      payload,
      actorTeamId: payload.castingTeamId,
    })),
  // An unrecognized event type: the reducer must advance the watermark but leave
  // domain fields untouched, so it still participates in the fold.
  fc.record({ note: idArb("x") }).map((payload) => ({
    eventType: "unrelated_event",
    payload,
    actorTeamId: null,
  })),
);

/**
 * Build a contiguous Game_Board event log for `gameId`: events with seqs
 * 1..count in ascending order, each carrying a valid Game_Board payload.
 */
function eventLogArb(gameId: string): fc.Arbitrary<GameEvent[]> {
  return fc
    .array(boardEventSpecArb, { minLength: 0, maxLength: 40 })
    .map((specs) =>
      specs.map((spec, index): GameEvent => {
        const seq = index + 1; // contiguous seqs starting at FIRST_SEQ (1)
        return {
          id: `${gameId}-e${seq}`,
          gameId,
          seq,
          eventType: spec.eventType,
          actorKind: spec.actorTeamId === null ? "admin" : "team",
          actorTeamId: spec.actorTeamId,
          payload: spec.payload,
          createdAt: new Date(seq).toISOString(),
        };
      }),
    );
}

/**
 * Reference implementation of the guarantee: a plain ascending left-fold of
 * `applyGameBoardEvent` from the initial view. `foldGameBoardEvents` must agree
 * with this for any input, regardless of the order events arrive in.
 */
function referenceFold(
  gameId: string,
  events: readonly GameEvent[],
): GameBoardView {
  const ascending = [...events].sort((a, b) => a.seq - b.seq);
  return ascending.reduce(applyGameBoardEvent, initialGameBoardView(gameId));
}

/** Shuffle a copy of `events` by pairing each with a random sort key. */
function shuffleBy<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, k: keys[i] ?? i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.item);
}

describe("gameboard events — canonical, idempotent, ordered fold (Property 4)", () => {
  /**
   * Feature: in-game-landing-wireframe, Property 4: Canonical, idempotent,
   * ordered fold.
   *
   * Validates: Requirements 8.2, 8.3
   *
   * For any set of a Game's events delivered in any order and with arbitrary
   * duplicates, `foldGameBoardEvents` produces the same `GameBoardView` as
   * applying the events once each in ascending `seq` order to the initial view
   * (R8.2); equivalently, applying an event whose `seq` is at or below the
   * highest contiguously-applied `seq` leaves the view unchanged (R8.3).
   */
  it("fold is order-independent, duplicate-tolerant, and equals the ascending reference fold", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            eventLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        // Sort keys to shuffle arrival order.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 120 }),
        // Which events to duplicate (indices into the log), producing repeats.
        fc.array(fc.integer({ min: 0, max: 39 }), { maxLength: 40 }),
        ({ gameId, events }, keys, dupIndices) => {
          const m = events.length;

          // Canonical fold over the raw ascending log.
          const view = foldGameBoardEvents(gameId, events);
          // Independent reference ascending fold.
          const expected = referenceFold(gameId, events);

          // 1. R8.2: the fold equals applying each event once in ascending order.
          expect(view).toEqual(expected);

          // 2. The watermark is the highest applied seq (M), or NO_EVENTS_SEQ
          //    when the log is empty.
          expect(view.gameId).toBe(gameId);
          expect(view.lastSeenSequence).toBe(m === 0 ? NO_EVENTS_SEQ : m);

          // 3. R8.2: order independence — folding a shuffled arrival order (with
          //    arbitrary duplicates injected) yields the same view. The
          //    duplicates exercise R8.3: a re-delivered seq must not double-apply.
          const dupes = dupIndices
            .map((i) => (m === 0 ? undefined : events[i % m]))
            .filter((e): e is GameEvent => e !== undefined);
          const arrivals = shuffleBy([...events, ...dupes], keys);
          const foldedFromArrivals = foldGameBoardEvents(gameId, arrivals);
          expect(foldedFromArrivals).toEqual(view);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Feature: in-game-landing-wireframe, Property 4: Canonical, idempotent,
   * ordered fold (idempotence-guard clause).
   *
   * Validates: Requirements 8.3
   *
   * Applying, to an already-folded view, any single event whose `seq` is at or
   * below that view's highest contiguously-applied `seq` returns a view equal to
   * the one before (a no-op). Re-applying such a stale/duplicate event never
   * mutates the roster, lifecycle, notices, or watermark.
   */
  it("applying an event at or below the watermark leaves the view unchanged", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            eventLogArb(gameId).map((events) => ({ gameId, events })),
          )
          .filter(({ events }) => events.length > 0),
        // Pick which already-applied event to re-deliver.
        fc.integer({ min: 0, max: 39 }),
        ({ gameId, events }, staleSeed) => {
          const view = foldGameBoardEvents(gameId, events);
          // Any event in the log has seq <= the watermark, so re-applying it is a
          // no-op (R8.3). Choose one by the seed.
          const stale = events[staleSeed % events.length];
          expect(stale.seq).toBeLessThanOrEqual(view.lastSeenSequence);

          const after = applyGameBoardEvent(view, stale);
          expect(after).toEqual(view);
          // The guard returns the same reference (no allocation) — a stronger,
          // implementation-consistent no-op.
          expect(after).toBe(view);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("gameboard events — the reducer only folds its own Game's events (Property 5)", () => {
  /**
   * Feature: in-game-landing-wireframe, Property 5: The reducer only folds its
   * own Game's events.
   *
   * Validates: Requirements 8.4
   *
   * For any `GameBoardView` and any `GameEvent` whose `gameId` differs from the
   * view's `gameId`, `applyGameBoardEvent` rejects the event: it throws a
   * `RangeError` and does not fold the foreign Game's event into the view. This
   * is the single-game isolation guarantee — a board view never ingests another
   * Game's events even if the transport misroutes one.
   */
  it("rejects any event whose gameId differs from the view's gameId", () => {
    fc.assert(
      fc.property(
        // Two distinct game ids: the view's game and a foreign game.
        fc
          .tuple(fc.uuid(), fc.uuid())
          .filter(([viewGame, eventGame]) => viewGame !== eventGame),
        // A prefix log for the view's own game so the view can be non-trivial.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 20 }),
        // A seq for the foreign event, including seqs below the watermark to show
        // the gameId check precedes the idempotence guard.
        fc.integer({ min: 1, max: 1000 }),
        ([viewGameId, foreignGameId], ownSeqSeeds, foreignSeq) => {
          // Fold a small own-game log so the view has real state + a watermark.
          const ownEvents: GameEvent[] = ownSeqSeeds.map(
            (_, index): GameEvent => ({
              id: `${viewGameId}-e${index + 1}`,
              gameId: viewGameId,
              seq: index + 1,
              eventType: GAME_BOARD_EVENT_TYPES.teamCreated,
              actorKind: "admin",
              actorTeamId: null,
              payload: {
                teamId: `t${index}`,
                name: `team${index}`,
                color: `#c${index}`,
              },
              createdAt: new Date(index + 1).toISOString(),
            }),
          );
          const view = foldGameBoardEvents(viewGameId, ownEvents);

          const foreignEvent: GameEvent = {
            id: `${foreignGameId}-e${foreignSeq}`,
            gameId: foreignGameId,
            seq: foreignSeq,
            eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
            actorKind: "team",
            actorTeamId: "tX",
            payload: {
              castingTeamId: "tX",
              targetTeamId: "tY",
              cardId: "cardZ",
            },
            createdAt: new Date(foreignSeq).toISOString(),
          };

          // The reducer rejects the foreign-game event by throwing RangeError,
          // rather than silently ignoring it or folding it in.
          const before = structuredClone(view);
          expect(() => applyGameBoardEvent(view, foreignEvent)).toThrow(
            RangeError,
          );
          // The view is never mutated by the rejected call — it still describes
          // only its own game.
          expect(view).toEqual(before);
          expect(view.gameId).toBe(viewGameId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
