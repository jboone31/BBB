import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  useItOrLoseItShouldComplete,
  settleInventoryChange,
} from "./challenges";
import type {
  BehaviorState,
  ChallengeRecord,
  ChallengeStatus,
} from "./behaviorState";
import type { CardInstance, DeckState } from "./deck";
import type { CardSlug } from "./catalog";

/**
 * Feature: card-behavior, Property 11: Use It or Lose It completes exactly when
 * the hand clears.
 *
 * `lib/cards/challenges.ts` owns the Use It or Lose It (UIOLI) auto-completion
 * that rides on a team's deck transition. A UIOLI challenge stays `open` while
 * the target holds any card in hand or has an unresolved pending draw, and
 * completes (`resolvedByKind: "system"`) in the same transaction as the play or
 * discard that empties the hand with no pending draw left (Requirement 8.1, 8.5).
 * A UIOLI played on an already-empty hand is created `completed` immediately
 * (8.6), which is the same completion predicate evaluated at play time. Cards are
 * never removed by the challenge itself — they stay in hand until the team plays
 * or discards them — so completion is gated purely on the emptiness of the hand
 * and pending draw (8.7).
 *
 * This property pins down the single completion predicate and the inventory
 * settle that drives it:
 *
 * - `useItOrLoseItShouldComplete(hand, pending)` is true iff both counts are 0
 *   (8.5) — the exact predicate that also decides the 8.6 immediate completion.
 * - `settleInventoryChange` completes an `open` UIOLI targeting the team exactly
 *   when its hand and pending draw both clear, and does nothing otherwise (8.5,
 *   8.7). A non-`open` UIOLI, a UIOLI targeting a different team, and a non-empty
 *   hand or pending draw all leave the follow-up empty, which models "cards
 *   remain until played/discarded" (8.7): the challenge cannot complete while any
 *   card is still held.
 *
 * All generators are hermetic; nothing touches a database or device clock.
 *
 * Validates: Requirements 8.1, 8.5, 8.6, 8.7
 */

// ---------------------------------------------------------------------------
// Slugs.
// ---------------------------------------------------------------------------

const UIOLI_SLUG: CardSlug = "use-it-or-lose-it";

/** Non-UIOLI gated slugs, used to prove the completion only touches UIOLI. */
const OTHER_SLUGS: readonly CardSlug[] = [
  "go-piss-girl",
  "wired",
  "broad-shoulders",
  "everyones-a-critic",
];

const BASE_ISO = "2025-06-01T18:00:00.000Z";

// ---------------------------------------------------------------------------
// Factories.
// ---------------------------------------------------------------------------

const TEAM_IDS = ["team-a", "team-b", "team-c"] as const;

function makeState(challenges: readonly ChallengeRecord[]): BehaviorState {
  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: BASE_ISO,
    teams: TEAM_IDS.map((teamId) => ({
      teamId,
      name: teamId,
      memberSessionIds: [`${teamId}-session`],
    })),
    hostSessionId: "host-session",
    bars: new Map(),
    startBarKey: null,
    finishBarKey: null,
    activeClaims: [],
    claimHistory: [],
    hands: new Map(),
    plays: [],
    challenges,
    offers: [],
    effects: [],
    awards: [],
    ledger: [],
  };
}

function makeChallenge(overrides: {
  challengeId: string;
  slug: CardSlug;
  targetTeamId: string;
  status: ChallengeStatus;
}): ChallengeRecord {
  return {
    sourcePlayId: `${overrides.challengeId}-play`,
    casterTeamId: "caster",
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    createdAt: BASE_ISO,
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
    ...overrides,
  };
}

/** Build a post-transition {@link DeckState} with the given hand / pending counts. */
function makeDeckState(
  teamId: string,
  handCount: number,
  pendingCount: number,
): DeckState {
  const cards: CardInstance[] = [
    ...Array.from({ length: handCount }, (_, i) => ({
      id: `${teamId}-h${i}`,
      slug: "go-piss-girl" as CardSlug,
      state: "hand" as const,
      position: i,
    })),
    ...Array.from({ length: pendingCount }, (_, i) => ({
      id: `${teamId}-p${i}`,
      slug: "wired" as CardSlug,
      state: "pending" as const,
      position: i,
    })),
  ];
  return {
    teamId,
    cards,
    drawnBarIds: [],
    pendingBarId: pendingCount > 0 ? "bar-1" : null,
    pendingMode: "choose_one",
  };
}

// ---------------------------------------------------------------------------
// Property 11a: the completion predicate.
// ---------------------------------------------------------------------------

describe("Property 11: Use It or Lose It completion predicate", () => {
  it("completes iff hand and pending are both zero (8.5)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 5 }), fc.nat({ max: 5 }), (hand, pending) => {
        expect(useItOrLoseItShouldComplete(hand, pending)).toBe(
          hand === 0 && pending === 0,
        );
      }),
    );
  });

  it("an already-empty hand completes immediately (8.6) via the same predicate", () => {
    // Requirement 8.6: a UIOLI played on a target whose hand is already empty
    // with no pending draw is created `completed`. The play-time decision uses
    // the very predicate under test, so an empty hand must read as "complete".
    expect(useItOrLoseItShouldComplete(0, 0)).toBe(true);
  });

  it("any held card or pending draw keeps it open (8.1, 8.7)", () => {
    // Requirement 8.1 / 8.7: cards remain in hand until played or discarded, and
    // the challenge stays open while any card is held or a draw is unresolved.
    fc.assert(
      fc.property(fc.nat({ max: 5 }), fc.nat({ max: 5 }), (hand, pending) => {
        fc.pre(hand > 0 || pending > 0);
        expect(useItOrLoseItShouldComplete(hand, pending)).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11b: the inventory settle drives completion.
// ---------------------------------------------------------------------------

describe("Property 11: settleInventoryChange UIOLI completion", () => {
  it("completes an open UIOLI iff the team's hand and pending both clear (8.5, 8.7)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ChallengeStatus>(
          "open",
          "completed",
          "failed",
          "cleared_by_host",
        ),
        fc.constantFrom(...TEAM_IDS),
        fc.constantFrom(...TEAM_IDS),
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        (status, targetTeamId, settleTeamId, handCount, pendingCount) => {
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug: UIOLI_SLUG,
            targetTeamId,
            status,
          });
          const state = makeState([challenge]);
          const after = makeDeckState(settleTeamId, handCount, pendingCount);

          const followUp = settleInventoryChange(
            state,
            settleTeamId,
            after,
            BASE_ISO,
          );

          // The challenge completes only when: it is open, the settling team is
          // its target, and both the hand and pending draw are now empty. Any
          // held card or pending draw (8.7) keeps it open.
          const shouldComplete =
            status === "open" &&
            targetTeamId === settleTeamId &&
            handCount === 0 &&
            pendingCount === 0;

          if (shouldComplete) {
            expect(followUp.completeChallenges).toEqual(["ch-1"]);
          } else {
            expect(followUp.completeChallenges).toEqual([]);
          }
        },
      ),
    );
  });

  it("only UIOLI challenges auto-complete, never other gated slugs (8.5)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OTHER_SLUGS),
        fc.constantFrom(...TEAM_IDS),
        (slug, teamId) => {
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug,
            targetTeamId: teamId,
            status: "open",
          });
          const state = makeState([challenge]);
          // Fully empty hand and pending — the UIOLI trigger condition — yet a
          // non-UIOLI challenge must never be auto-completed by the settle.
          const after = makeDeckState(teamId, 0, 0);

          const followUp = settleInventoryChange(
            state,
            teamId,
            after,
            BASE_ISO,
          );

          expect(followUp.completeChallenges).toEqual([]);
        },
      ),
    );
  });

  it("completes every open UIOLI targeting the emptied team at once (8.5)", () => {
    // Multiple open UIOLI challenges can target the same team (e.g. an original
    // plus a mirror). Emptying the hand completes all of them in one settle.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (count) => {
        const target = "team-a";
        const challenges = Array.from({ length: count }, (_, i) =>
          makeChallenge({
            challengeId: `ch-${i}`,
            slug: UIOLI_SLUG,
            targetTeamId: target,
            status: "open",
          }),
        );
        const state = makeState(challenges);
        const after = makeDeckState(target, 0, 0);

        const followUp = settleInventoryChange(state, target, after, BASE_ISO);

        expect(new Set(followUp.completeChallenges)).toEqual(
          new Set(challenges.map((c) => c.challengeId)),
        );
        expect(followUp.completeChallenges).toHaveLength(count);
      }),
    );
  });
});
