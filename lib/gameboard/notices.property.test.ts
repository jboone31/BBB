import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  dismissTargetedNotice,
  foldGameBoardEvents,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  type GameBoardView,
  type TargetedNotice,
} from "./events";

/**
 * Feature: in-game-landing-wireframe — Properties 9 & 10 (targeted-notice fold /
 * dismissal).
 *
 * The Game_Board derives its pending Targeted_Notifications by folding the
 * append-only `game_events` log: each `wireframe_card_played` event becomes one
 * {@link TargetedNotice} keyed by its producing event `seq` (design.md
 * §Components 1; R7.8). These two properties fix the guarantees the
 * notification pipeline relies on:
 *
 *   - Property 9 (R7.3, R7.8): folding a set of distinct `wireframe_card_played`
 *     events yields exactly one notice per event, each identifying the casting
 *     Team of its originating event — with a notice for every event targeting
 *     the viewing Team and none inadvertently dropped or duplicated.
 *   - Property 10 (R7.5): dismissing a notice by its producing event `seq`
 *     removes exactly that notice and leaves every other notice unchanged.
 *
 * Both drive the pure, framework-free reducer in `./events`, so no live database
 * or transport is involved. The generators below build valid `GameEvent` rows
 * (matching the `GameEvent` shape from `lib/events`) carrying the
 * `wireframe_card_played` payload shape `{ castingTeamId, targetTeamId, cardId }`
 * the wireframe card-play route appends, so the fold consumes exactly the rows
 * the backbone produces.
 */

// ---------------------------------------------------------------------------
// Generators
//
// Each generated event is a `wireframe_card_played` row carrying the
// `{ castingTeamId, targetTeamId, cardId }` payload the route writes. Seqs are
// stamped contiguously (1..count) after the array is built, matching the
// per-game seq the events backbone assigns (FIRST_SEQ = 1); the fold keys the
// notice identity on that seq.
// ---------------------------------------------------------------------------

/** Small identifier-ish string generator. */
const idArb = (prefix: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 9999 }).map((n) => `${prefix}${n}`);

/** The stable game id every generated event belongs to. */
const GAME_ID = "game-notices";

/** The viewing Team's id — the Team whose Game_Board we are reasoning about. */
const VIEWING_TEAM = "team-viewing";

/**
 * A `wireframe_card_played` event "spec" — its casting Team, target Team, and
 * card — before it is stamped with a seq. The target is either the viewing Team
 * or one of a few other Teams, so a fold mixes notices for the viewer with
 * notices for other Teams (the reducer folds all; the client filters by target).
 */
const cardPlaySpecArb: fc.Arbitrary<{
  castingTeamId: string;
  targetTeamId: string;
  cardId: string;
}> = fc.record({
  castingTeamId: idArb("caster"),
  // Bias toward the viewing Team so most runs exercise the viewer's notices,
  // while still generating events aimed at other Teams (which must NOT appear as
  // the viewer's notices).
  targetTeamId: fc.oneof(
    { weight: 3, arbitrary: fc.constant(VIEWING_TEAM) },
    { weight: 1, arbitrary: idArb("other-team") },
  ),
  cardId: idArb("card"),
});

/**
 * Build a contiguous log of `wireframe_card_played` events for {@link GAME_ID}:
 * events with seqs 1..count in ascending order. Each seq is distinct, so each
 * event produces a distinctly-identified notice.
 */
function cardPlayLogArb(): fc.Arbitrary<GameEvent[]> {
  return fc
    .array(cardPlaySpecArb, { minLength: 0, maxLength: 40 })
    .map((specs) =>
      specs.map((spec, index): GameEvent => {
        const seq = index + 1; // contiguous seqs starting at FIRST_SEQ (1)
        return {
          id: `${GAME_ID}-e${seq}`,
          gameId: GAME_ID,
          seq,
          eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
          actorKind: "team",
          actorTeamId: spec.castingTeamId,
          payload: {
            castingTeamId: spec.castingTeamId,
            targetTeamId: spec.targetTeamId,
            cardId: spec.cardId,
          },
          createdAt: new Date(seq).toISOString(),
        };
      }),
    );
}

/** Shuffle a copy of `events` by pairing each with a random sort key. */
function shuffleBy<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, k: keys[i] ?? i }))
    .sort((a, b) => a.k - b.k)
    .map(({ item }) => item);
}

// ===========================================================================
// Property 9: Each targeting event yields exactly one notice naming its caster
// ===========================================================================

describe("Game_Board notices — one notice per targeting event, naming its caster (Property 9)", () => {
  it("folds each wireframe_card_played event into exactly one notice for its target, identifying the casting Team, and none for a different Team", () => {
    fc.assert(
      fc.property(
        cardPlayLogArb(),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: 40,
          maxLength: 40,
        }),
        (events, keys) => {
          // Arrival order (and duplicates) must not matter: fold a shuffled copy.
          const shuffled = shuffleBy(events, keys);
          const view = foldGameBoardEvents(GAME_ID, shuffled);

          // The events partitioned by their target, computed independently of
          // the reducer straight from the generated payloads.
          const forViewer = events.filter(
            (e) => (e.payload as { targetTeamId: string }).targetTeamId ===
              VIEWING_TEAM,
          );
          const forOthers = events.filter(
            (e) => (e.payload as { targetTeamId: string }).targetTeamId !==
              VIEWING_TEAM,
          );

          // Exactly one notice per event overall (no drops, no duplicates): one
          // seq in, one notice out.
          expect(view.targetedNotices).toHaveLength(events.length);

          // The notices whose target is the viewing Team: exactly one per such
          // event, each carrying the seq, caster, target, and card of its event.
          const viewerNotices = view.targetedNotices.filter(
            (n) => n.targetTeamId === VIEWING_TEAM,
          );
          expect(viewerNotices).toHaveLength(forViewer.length);

          for (const event of forViewer) {
            const payload = event.payload as {
              castingTeamId: string;
              targetTeamId: string;
              cardId: string;
            };
            const matches = viewerNotices.filter((n) => n.seq === event.seq);
            // Exactly one notice for this event's seq...
            expect(matches).toHaveLength(1);
            // ...and it names the casting Team of THIS event.
            expect(matches[0]).toEqual<TargetedNotice>({
              seq: event.seq,
              castingTeamId: payload.castingTeamId,
              targetTeamId: payload.targetTeamId,
              cardId: payload.cardId,
            });
          }

          // No viewer-notice is produced for an event targeting a different Team:
          // every viewer notice's seq belongs to an event that targeted the viewer.
          const viewerSeqs = new Set(forViewer.map((e) => e.seq));
          for (const notice of viewerNotices) {
            expect(viewerSeqs.has(notice.seq)).toBe(true);
          }

          // Symmetrically, events targeting other Teams fold into notices for
          // those Teams (not the viewer), one apiece — never lost, never merged
          // into the viewer's set.
          const otherNotices = view.targetedNotices.filter(
            (n) => n.targetTeamId !== VIEWING_TEAM,
          );
          expect(otherNotices).toHaveLength(forOthers.length);

          // Notice seqs are unique across the whole view (one notice per event).
          const allSeqs = view.targetedNotices.map((n) => n.seq);
          expect(new Set(allSeqs).size).toBe(allSeqs.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does not duplicate a notice when its event is re-delivered (idempotent fold)", () => {
    fc.assert(
      fc.property(cardPlayLogArb(), (events) => {
        fc.pre(events.length > 0);
        // Deliver every event twice: the idempotence guard must drop the second
        // copy so each targeting event still yields exactly one notice.
        const withDuplicates = [...events, ...events];
        const once = foldGameBoardEvents(GAME_ID, events);
        const twice = foldGameBoardEvents(GAME_ID, withDuplicates);

        expect(twice.targetedNotices).toHaveLength(events.length);
        expect(twice.targetedNotices).toEqual(once.targetedNotices);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 10: Dismissing removes exactly the named notice
// ===========================================================================

/**
 * Build an arbitrary `GameBoardView` carrying one notice per generated
 * `wireframe_card_played` event, by folding the log. This yields views whose
 * `targetedNotices` have distinct seqs — exactly the shape dismissal operates on.
 */
const viewWithNoticesArb: fc.Arbitrary<GameBoardView> = cardPlayLogArb().map(
  (events) => foldGameBoardEvents(GAME_ID, events),
);

describe("Game_Board notices — dismissing removes exactly the named notice (Property 10)", () => {
  it("removes the notice with the given seq and leaves every other notice unchanged", () => {
    fc.assert(
      fc.property(
        viewWithNoticesArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (view, pick) => {
          // Only meaningful when there is a notice present to dismiss.
          fc.pre(view.targetedNotices.length > 0);

          // Choose one present notice by its producing event seq.
          const index = Math.min(
            view.targetedNotices.length - 1,
            Math.floor(pick * view.targetedNotices.length),
          );
          const target = view.targetedNotices[index]!;

          const after = dismissTargetedNotice(view, target.seq);

          // The dismissed notice is gone...
          expect(
            after.targetedNotices.some((n) => n.seq === target.seq),
          ).toBe(false);

          // ...exactly one notice was removed...
          expect(after.targetedNotices).toHaveLength(
            view.targetedNotices.length - 1,
          );

          // ...and every OTHER notice remains, unchanged and in order.
          const expectedRemaining = view.targetedNotices.filter(
            (n) => n.seq !== target.seq,
          );
          expect(after.targetedNotices).toEqual(expectedRemaining);

          // Nothing else about the view changed.
          expect(after.gameId).toBe(view.gameId);
          expect(after.lifecycle).toBe(view.lifecycle);
          expect(after.teams).toEqual(view.teams);
          expect(after.lastSeenSequence).toBe(view.lastSeenSequence);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is a no-op when the seq matches no present notice", () => {
    fc.assert(
      fc.property(viewWithNoticesArb, (view) => {
        // A seq guaranteed not to identify any present notice (seqs are 1..n).
        const absentSeq = -1;
        const after = dismissTargetedNotice(view, absentSeq);

        // No notice removed: the notice set is identical.
        expect(after.targetedNotices).toEqual(view.targetedNotices);
      }),
      { numRuns: 100 },
    );
  });
});

// A single concrete example anchoring the fold + dismissal, complementing the
// property runs above with a hand-checked scenario.
describe("Game_Board notices — worked example", () => {
  it("folds two targeting events into two notices, then dismisses one", () => {
    const events: GameEvent[] = [
      {
        id: `${GAME_ID}-e1`,
        gameId: GAME_ID,
        seq: 1,
        eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
        actorKind: "team",
        actorTeamId: "red",
        payload: {
          castingTeamId: "red",
          targetTeamId: VIEWING_TEAM,
          cardId: "card-a",
        },
        createdAt: new Date(1).toISOString(),
      },
      {
        id: `${GAME_ID}-e2`,
        gameId: GAME_ID,
        seq: 2,
        eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
        actorKind: "team",
        actorTeamId: "blue",
        payload: {
          castingTeamId: "blue",
          targetTeamId: VIEWING_TEAM,
          cardId: "card-b",
        },
        createdAt: new Date(2).toISOString(),
      },
    ];

    const view = foldGameBoardEvents(GAME_ID, events);
    expect(view.targetedNotices).toEqual<TargetedNotice[]>([
      {
        seq: 1,
        castingTeamId: "red",
        targetTeamId: VIEWING_TEAM,
        cardId: "card-a",
      },
      {
        seq: 2,
        castingTeamId: "blue",
        targetTeamId: VIEWING_TEAM,
        cardId: "card-b",
      },
    ]);

    const afterDismiss = dismissTargetedNotice(view, 1);
    expect(afterDismiss.targetedNotices).toEqual<TargetedNotice[]>([
      {
        seq: 2,
        castingTeamId: "blue",
        targetTeamId: VIEWING_TEAM,
        cardId: "card-b",
      },
    ]);
  });

  it("keeps applyGameBoardEvent single-notice per event when applied directly", () => {
    const base = initialGameBoardView(GAME_ID);
    const event: GameEvent = {
      id: `${GAME_ID}-e1`,
      gameId: GAME_ID,
      seq: 1,
      eventType: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
      actorKind: "team",
      actorTeamId: "green",
      payload: {
        castingTeamId: "green",
        targetTeamId: VIEWING_TEAM,
        cardId: "card-c",
      },
      createdAt: new Date(1).toISOString(),
    };
    const view = applyGameBoardEvent(base, event);
    expect(view.targetedNotices).toHaveLength(1);
    expect(view.targetedNotices[0]!.castingTeamId).toBe("green");
  });
});
