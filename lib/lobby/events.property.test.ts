import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";

import { applyInOrder, initialOrderedApplyState } from "@/lib/realtime";

import {
  applyLobbyEvent,
  foldLobbyEvents,
  initialLobbyView,
  LOBBY_EVENT_TYPES,
  NO_EVENTS_SEQ,
  type LobbyView,
} from "./events";

/**
 * Feature: game-setup-lobby — Properties 20 & 21 (lobby event fold / reducer).
 *
 * The lobby maintains no separate "current state" table: the `LobbyView` the
 * Lobby_Client renders is derived by folding the append-only `game_events` log
 * in ascending `seq` order (design.md Component 2). These properties fix the two
 * guarantees that make that fold trustworthy:
 *
 *   - Property 20 (Req 7.2): the snapshot loaded on subscribe equals the ordered
 *     fold — `foldLobbyEvents(events)` equals applying those events one at a time
 *     in ascending `seq` order to `initialLobbyView`.
 *   - Property 21 (Req 7.3): under any arrival ordering, including duplicates,
 *     the reducer applies each event exactly once in ascending `seq` order,
 *     ignoring any event at or below the highest contiguously-applied `seq`.
 *
 * Both properties drive the pure, framework-free reducer in `./events`, so no
 * live database or transport is involved. The generator below builds valid
 * `GameEvent` rows (matching the `GameEvent` shape from `lib/events`) carrying
 * the lobby `event_type`/payload shapes from the design's "Lobby event payloads"
 * table, so the fold consumes exactly the rows the backbone produces.
 */

// ---------------------------------------------------------------------------
// Generators: build valid lobby GameEvent fixtures.
//
// Each generated event carries one of the design's lobby event types with a
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
 * A lobby event "spec" — the type + payload — before it is stamped with a seq.
 * Payloads follow the design's "Lobby event payloads" table exactly.
 */
const lobbyEventSpecArb: fc.Arbitrary<{
  eventType: string;
  payload: unknown;
  actorTeamId: string | null;
}> = fc.oneof(
  // game_created — { joinCode }
  fc.record({ joinCode: idArb("JOIN") }).map((payload) => ({
    eventType: LOBBY_EVENT_TYPES.gameCreated,
    payload,
    actorTeamId: null,
  })),
  // bars_designated — { startBarId, finishBarId }
  fc
    .record({ startBarId: idArb("bar"), finishBarId: idArb("bar") })
    .map((payload) => ({
      eventType: LOBBY_EVENT_TYPES.barsDesignated,
      payload,
      actorTeamId: null,
    })),
  // player_joined — { playerId, displayName }
  fc
    .record({ playerId: idArb("p"), displayName: idArb("name") })
    .map((payload) => ({
      eventType: LOBBY_EVENT_TYPES.playerJoined,
      payload,
      actorTeamId: null,
    })),
  // team_created — { teamId, name, color }
  fc
    .record({ teamId: idArb("t"), name: idArb("team"), color: idArb("#c") })
    .map((payload) => ({
      eventType: LOBBY_EVENT_TYPES.teamCreated,
      payload,
      actorTeamId: null,
    })),
  // team_changed — { playerId, fromTeamId, toTeamId }; actor is the team.
  fc
    .record({
      playerId: idArb("p"),
      fromTeamId: idArb("t"),
      toTeamId: idArb("t"),
    })
    .map((payload) => ({
      eventType: LOBBY_EVENT_TYPES.teamChanged,
      payload,
      actorTeamId: payload.toTeamId,
    })),
  // game_started — { liveStartedAt }
  fc.record({ liveStartedAt: idArb("ts") }).map((payload) => ({
    eventType: LOBBY_EVENT_TYPES.gameStarted,
    payload,
    actorTeamId: null,
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
 * Build a contiguous lobby event log for `gameId`: events with seqs 1..count in
 * ascending order, each carrying a valid lobby payload.
 */
function eventLogArb(gameId: string): fc.Arbitrary<GameEvent[]> {
  return fc
    .array(lobbyEventSpecArb, { minLength: 0, maxLength: 40 })
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
 * `applyLobbyEvent` from the initial view. `foldLobbyEvents` must agree with
 * this for any input, regardless of the order events arrive in.
 */
function referenceFold(
  gameId: string,
  events: readonly GameEvent[],
): LobbyView {
  const ascending = [...events].sort((a, b) => a.seq - b.seq);
  return ascending.reduce(applyLobbyEvent, initialLobbyView(gameId));
}

/** Shuffle a copy of `events` by pairing each with a random sort key. */
function shuffleBy<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, k: keys[i] ?? i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.item);
}

describe("lobby events — Lobby snapshot equals the ordered fold (Property 20)", () => {
  /**
   * Validates: Requirements 7.2
   *
   * For a random contiguous lobby log (seqs 1..M for a single game) and an
   * arbitrary cutoff N, `foldLobbyEvents` over the events with `seq <= N` equals
   * the reference ascending left-fold of `applyLobbyEvent` over those same
   * events — the snapshot loaded on subscribe equals the fold of all events with
   * `seq <= N`. The result is independent of the order events are handed to the
   * fold in (shuffling the input yields the same view).
   */
  it("foldLobbyEvents(events with seq <= N) == reduce(applyLobbyEvent, initial, ascending)", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            eventLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        // A cutoff seed used to pick N in [0, M].
        fc.integer({ min: 0, max: 40 }),
        // A permutation of sort keys used to shuffle arrival order.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 40 }),
        ({ gameId, events }, cutoffSeed, keys) => {
          const m = events.length;
          const n = m === 0 ? 0 : cutoffSeed % (m + 1); // N in [0, M]

          const upToN = events.filter((e) => e.seq <= n);

          // Canonical fold from the module.
          const view = foldLobbyEvents(gameId, upToN);
          // Independent reference fold.
          const expected = referenceFold(gameId, upToN);

          // 1. The fold equals the reference ascending fold of events seq <= N.
          expect(view).toEqual(expected);

          // 2. It reflects exactly the events with seq <= N: the watermark is
          //    the highest applied seq (N), or NO_EVENTS_SEQ when empty.
          expect(view.gameId).toBe(gameId);
          expect(view.lastSeenSequence).toBe(
            upToN.length === 0 ? NO_EVENTS_SEQ : n,
          );

          // 3. The fold is independent of arrival order: shuffling the same
          //    events yields the same view.
          const shuffledView = foldLobbyEvents(gameId, shuffleBy(upToN, keys));
          expect(shuffledView).toEqual(view);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("lobby events — Lobby reducer applies each event once, in order (Property 21)", () => {
  /**
   * Validates: Requirements 7.3
   *
   * For any arrival ordering of a lobby event stream, including duplicates, the
   * lobby reducer *under the ordered-apply core* (design.md: "`applyLobbyEvent`
   * under the ordered-apply core") applies each event exactly once, in ascending
   * `seq` order, ignoring any event at or below the highest contiguously-applied
   * sequence. This mirrors how the Lobby_Client actually consumes the stream: the
   * pure `applyInOrder` core (`lib/realtime`) de-duplicates and reorders raw
   * arrivals, emitting an ascending, gap-free, once-each `applied` list, which the
   * client folds through `applyLobbyEvent`.
   *
   * We drive a shuffled, duplicated arrival stream through `applyInOrder`,
   * asserting the emitted `applied` seqs are exactly [1..M] ascending (each once),
   * then fold that emitted order through `applyLobbyEvent` and assert it equals
   * the ascending reference fold. Because the reducer also carries its own
   * at/below-watermark guard, feeding the same events straight into
   * `applyLobbyEvent` in the (already ascending) applied order agrees too.
   */
  it("under the ordered-apply core, any arrival order (with duplicates) applies each event once, ascending", () => {
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

          // Build a delivery stream: every event, plus duplicates of some,
          // shuffled into an arbitrary arrival order.
          const dupes = dupIndices
            .map((i) => (m === 0 ? undefined : events[i % m]))
            .filter((e): e is GameEvent => e !== undefined);
          const arrivals = shuffleBy([...events, ...dupes], keys);

          // Drive the raw arrivals through the ordered-apply core: it emits each
          // event exactly once, in ascending seq order, buffering out-of-order
          // arrivals and de-duplicating re-deliveries (Req 7.3).
          let orderState = initialOrderedApplyState();
          const appliedOrder: GameEvent[] = [];
          for (const event of arrivals) {
            const result = applyInOrder(orderState, event);
            orderState = result.state;
            appliedOrder.push(...result.applied);
          }

          // The core emits exactly [1..M] ascending, once each.
          expect(appliedOrder.map((e) => e.seq)).toEqual(
            Array.from({ length: m }, (_, i) => i + 1),
          );

          // Fold the emitted order through the lobby reducer, tracking the
          // watermark to confirm it advances by exactly one seq per applied event
          // and never regresses.
          let view = initialLobbyView(gameId);
          for (const event of appliedOrder) {
            const before = view.lastSeenSequence;
            view = applyLobbyEvent(view, event);
            expect(view.lastSeenSequence).toBe(event.seq);
            expect(view.lastSeenSequence).toBeGreaterThan(before);
          }

          // Applying each event once in ascending order equals the reference
          // ascending fold and the canonical fold over the raw log.
          expect(view).toEqual(referenceFold(gameId, events));
          expect(view).toEqual(foldLobbyEvents(gameId, events));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("de-duplicates repeated seqs so an event is applied at most once", () => {
    // Explicit example: duplicate deliveries (same seq) must not double-apply.
    const gameId = "game-dup";
    const events: GameEvent[] = [
      {
        id: "e1",
        gameId,
        seq: 1,
        eventType: LOBBY_EVENT_TYPES.gameCreated,
        actorKind: "admin",
        actorTeamId: null,
        payload: { joinCode: "ABCD" },
        createdAt: new Date(1).toISOString(),
      },
      {
        id: "e2",
        gameId,
        seq: 2,
        eventType: LOBBY_EVENT_TYPES.playerJoined,
        actorKind: "admin",
        actorTeamId: null,
        payload: { playerId: "p1", displayName: "Ada" },
        createdAt: new Date(2).toISOString(),
      },
    ];
    const [e1, e2] = events;

    const withDupes = foldLobbyEvents(gameId, [e1, e1, e2, e2, e1]);

    expect(withDupes.lastSeenSequence).toBe(2);
    expect(withDupes.joinCode).toBe("ABCD");
    expect(withDupes.players).toEqual([
      { id: "p1", displayName: "Ada", teamId: null },
    ]);
    // Applying once == applying with duplicates.
    expect(withDupes).toEqual(foldLobbyEvents(gameId, [e1, e2]));
  });
});
