import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { selectPendingActions, type ToastAction } from "./toasts";
import type {
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
  FairestOfferStatus,
} from "./behaviorState";
import type { CardSlug } from "./catalog";
import { getCardMetadata } from "./catalog";
import type { CastingParams } from "./inputs";
import {
  initialGameBoardView,
  type CardBehaviorView,
  type GameBoardView,
} from "@/lib/gameboard/events";

/**
 * Feature: card-behavior, Property 5: Pending actions are a pure function of
 * challenge and offer state.
 *
 * `selectPendingActions` in `lib/cards/toasts.ts` (task 9.4) turns the folded
 * challenge and offer records into the action buttons a team currently owes. The
 * design fixes exactly what it must contain for any event sequence:
 *
 *   - Mark complete for each open, gated, non-UIOLI challenge targeting the team
 *     that has no live Fairest offer, plus We failed for Everyone's a Critic.
 *   - Play and Decline for each pending offer whose holder is the team.
 *   - Nothing for Pioneer, Scenic Route, or Voted Off notices (not gated), and no
 *     Mark complete for Use It or Lose It (its discard action lives in the hand).
 *
 * Because the function reads only the folded `challenges`/`offers` records and
 * never a clock or the event order, a reconnect that rebuilds the same records —
 * from the full log or from a snapshot plus the remaining tail — reconstructs the
 * identical action list (Requirement 3.9). This property pins that down: the
 * expected set is recomputed independently from the generated records, and the
 * result is shown invariant under reordering the record maps.
 *
 * All generators are hermetic; nothing touches a database, network, or clock.
 *
 * Validates: Requirements 3.8, 3.9, 5.1, 7.1, 9.2, 9.3, 9.12, 10.8
 */

// ---------------------------------------------------------------------------
// Slug partitions (derived from the catalog so they stay in sync).
// ---------------------------------------------------------------------------

/** Team-targeting challenge slugs with `completionRequired`, excluding UIOLI. */
const GATED_ACTION_SLUGS: readonly CardSlug[] = [
  "go-piss-girl",
  "moneybags",
  "wired",
  "art-school-dropout",
  "broad-shoulders",
  "bird-guide",
  "interested-buyer",
  "different-tastes",
  "everyones-a-critic",
  "spin-cycle",
  "dirty-bird",
];

/** Challenge slugs that owe no Mark complete: UIOLI and the non-gated notices. */
const NON_ACTION_SLUGS: readonly CardSlug[] = [
  "use-it-or-lose-it",
  "pioneer",
  "scenic-route",
  "voted-off-the-island",
];

const CHALLENGE_SLUGS: readonly CardSlug[] = [
  ...GATED_ACTION_SLUGS,
  ...NON_ACTION_SLUGS,
];

// Guard: the generator partition must match the catalog predicate the code uses.
describe("gated-action slug partition matches the catalog", () => {
  it("includes exactly the completion-required team challenges minus UIOLI", () => {
    for (const slug of GATED_ACTION_SLUGS) {
      const meta = getCardMetadata(slug);
      expect(meta.completionRequired && meta.targetMode === "team").toBe(true);
      expect(slug).not.toBe("use-it-or-lose-it");
    }
    expect(getCardMetadata("use-it-or-lose-it").completionRequired).toBe(true);
    expect(getCardMetadata("use-it-or-lose-it").targetMode).toBe("team");
    for (const slug of ["pioneer", "scenic-route"] as const) {
      expect(getCardMetadata(slug).completionRequired).toBe(false);
    }
    expect(getCardMetadata("voted-off-the-island").targetMode).toBe(
      "team_and_bar",
    );
  });
});

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const TEAM_IDS = ["team-a", "team-b", "team-c", "team-d"] as const;
const NONE_PARAMS: CastingParams = { kind: "none" };

const teamIdArb = fc.constantFrom(...TEAM_IDS);
const challengeStatusArb = fc.constantFrom<ChallengeStatus>(
  "open",
  "completed",
  "failed",
  "cleared_by_host",
);
const offerStatusArb = fc.constantFrom<FairestOfferStatus>(
  "pending",
  "played",
  "declined",
  "void",
);

function challengeArb(id: string): fc.Arbitrary<ChallengeRecord> {
  return fc
    .record({
      slug: fc.constantFrom(...CHALLENGE_SLUGS),
      casterTeamId: teamIdArb,
      targetTeamId: teamIdArb,
      status: challengeStatusArb,
    })
    .map(({ slug, casterTeamId, targetTeamId, status }): ChallengeRecord => ({
      challengeId: id,
      slug,
      sourcePlayId: `play-${id}`,
      casterTeamId,
      targetTeamId,
      params: NONE_PARAMS,
      mirroredFromChallengeId: null,
      mirroredFromPlayId: null,
      status,
      createdAt: "2024-01-01T00:00:00.000Z",
      resolvedAt: null,
      resolvedByTeamId: null,
      resolvedBySessionId: null,
      resolvedByKind: null,
      failureEffectId: null,
    }));
}

/**
 * An offer whose `challengeId` points at one of the generated challenges (so the
 * "live Fairest offer for that challenge" interaction actually fires), with a
 * generated holder and status.
 */
function offerArb(
  id: string,
  challengeIds: readonly string[],
): fc.Arbitrary<FairestOfferRecord> {
  const linkArb =
    challengeIds.length === 0
      ? fc.constant<string | null>(null)
      : fc.option(fc.constantFrom(...challengeIds), { nil: null });
  return fc
    .record({
      challengeId: linkArb,
      holderTeamId: teamIdArb,
      originalCasterTeamId: teamIdArb,
      slug: fc.constantFrom<CardSlug>(...GATED_ACTION_SLUGS, "pioneer"),
      status: offerStatusArb,
    })
    .map(
      ({
        challengeId,
        holderTeamId,
        originalCasterTeamId,
        slug,
        status,
      }): FairestOfferRecord => ({
        offerId: id,
        sourcePlayId: `play-offer-${id}`,
        slug,
        holderTeamId,
        originalCasterTeamId,
        challengeId,
        restrictionEffectId: null,
        status,
        decidedAt: null,
        mirroredChallengeId: null,
        mirroredEffectId: null,
      }),
    );
}

interface Scenario {
  readonly challenges: readonly ChallengeRecord[];
  readonly offers: readonly FairestOfferRecord[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .array(fc.boolean(), { minLength: 0, maxLength: 5 })
  .chain((challengeFlags) => {
    const challengeIds = challengeFlags.map((_, i) => `chal-${i}`);
    const challengesArb =
      challengeIds.length === 0
        ? fc.constant<ChallengeRecord[]>([])
        : fc.tuple(...challengeIds.map((id) => challengeArb(id)));
    return fc
      .array(fc.boolean(), { minLength: 0, maxLength: 5 })
      .chain((offerFlags) => {
        const offerIds = offerFlags.map((_, i) => `offer-${i}`);
        const offersArb =
          offerIds.length === 0
            ? fc.constant<FairestOfferRecord[]>([])
            : fc.tuple(...offerIds.map((id) => offerArb(id, challengeIds)));
        return fc.record({
          challenges: challengesArb as fc.Arbitrary<ChallengeRecord[]>,
          offers: offersArb as fc.Arbitrary<FairestOfferRecord[]>,
        });
      });
  });

// ---------------------------------------------------------------------------
// Independent reference implementation of the spec rule.
// ---------------------------------------------------------------------------

function expectedActions(scenario: Scenario, teamId: string): ToastAction[] {
  const actions: ToastAction[] = [];

  // Play + Decline for each pending offer this team holds, offerId-sorted.
  const heldPending = scenario.offers
    .filter((o) => o.status === "pending" && o.holderTeamId === teamId)
    .sort((a, b) => a.offerId.localeCompare(b.offerId));
  for (const offer of heldPending) {
    actions.push({ kind: "fairest_play", offerId: offer.offerId });
    actions.push({ kind: "fairest_decline", offerId: offer.offerId });
  }

  // Mark complete (+ We failed for Critic) for open gated-action challenges
  // targeting the team with no pending offer tied to them, challengeId-sorted.
  const openGated = scenario.challenges
    .filter(
      (c) =>
        c.status === "open" &&
        c.targetTeamId === teamId &&
        GATED_ACTION_SLUGS.includes(c.slug),
    )
    .sort((a, b) => a.challengeId.localeCompare(b.challengeId));
  for (const challenge of openGated) {
    const hasLiveOffer = scenario.offers.some(
      (o) => o.status === "pending" && o.challengeId === challenge.challengeId,
    );
    if (hasLiveOffer) {
      continue;
    }
    actions.push({ kind: "mark_complete", challengeId: challenge.challengeId });
    if (challenge.slug === "everyones-a-critic") {
      actions.push({ kind: "we_failed", challengeId: challenge.challengeId });
    }
  }

  return actions;
}

function viewFor(scenario: Scenario): GameBoardView {
  const base = initialGameBoardView("game-1");
  const cardBehavior: CardBehaviorView = {
    ...base.cardBehavior,
    challenges: Object.fromEntries(
      scenario.challenges.map((c) => [c.challengeId, c]),
    ),
    offers: Object.fromEntries(scenario.offers.map((o) => [o.offerId, o])),
  };
  return { ...base, cardBehavior };
}

function reverse<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("Property 5: pending actions are a pure function of challenge/offer state", () => {
  it("matches the spec rule for every team", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        for (const teamId of TEAM_IDS) {
          const actual = selectPendingActions(viewFor(scenario), teamId);
          expect(actual).toEqual(expectedActions(scenario, teamId));
        }
      }),
    );
  });

  it("is invariant under reordering the folded records (reconnect parity)", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const reordered: Scenario = {
          challenges: reverse(scenario.challenges),
          offers: reverse(scenario.offers),
        };
        for (const teamId of TEAM_IDS) {
          expect(selectPendingActions(viewFor(reordered), teamId)).toEqual(
            selectPendingActions(viewFor(scenario), teamId),
          );
        }
      }),
    );
  });

  it("never emits Mark complete for Pioneer, Scenic Route, UIOLI, or Voted Off", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        for (const teamId of TEAM_IDS) {
          const actions = selectPendingActions(viewFor(scenario), teamId);
          for (const action of actions) {
            if (
              action.kind !== "mark_complete" &&
              action.kind !== "we_failed"
            ) {
              continue;
            }
            const challenge = scenario.challenges.find(
              (c) => c.challengeId === action.challengeId,
            );
            expect(challenge?.slug).not.toBeUndefined();
            expect(NON_ACTION_SLUGS).not.toContain(challenge?.slug);
          }
        }
      }),
    );
  });

  it("suppresses Mark complete exactly while a live Fairest offer targets the challenge", () => {
    const challengeId = "chal-0";
    const base: ChallengeRecord = {
      challengeId,
      slug: "everyones-a-critic",
      sourcePlayId: "play-0",
      casterTeamId: "team-b",
      targetTeamId: "team-a",
      params: NONE_PARAMS,
      mirroredFromChallengeId: null,
      mirroredFromPlayId: null,
      status: "open",
      createdAt: "2024-01-01T00:00:00.000Z",
      resolvedAt: null,
      resolvedByTeamId: null,
      resolvedBySessionId: null,
      resolvedByKind: null,
      failureEffectId: null,
    };
    const offer = (status: FairestOfferStatus): FairestOfferRecord => ({
      offerId: "offer-0",
      sourcePlayId: "play-0",
      slug: "everyones-a-critic",
      holderTeamId: "team-a",
      originalCasterTeamId: "team-b",
      challengeId,
      restrictionEffectId: null,
      status,
      decidedAt: null,
      mirroredChallengeId: null,
      mirroredEffectId: null,
    });

    // No offer: Mark complete + We failed are owed to the target.
    expect(
      selectPendingActions(
        viewFor({ challenges: [base], offers: [] }),
        "team-a",
      ),
    ).toEqual([
      { kind: "mark_complete", challengeId },
      { kind: "we_failed", challengeId },
    ]);

    // Pending offer: the Fairest prompt (Play/Decline) replaces the gate actions.
    expect(
      selectPendingActions(
        viewFor({ challenges: [base], offers: [offer("pending")] }),
        "team-a",
      ),
    ).toEqual([
      { kind: "fairest_play", offerId: "offer-0" },
      { kind: "fairest_decline", offerId: "offer-0" },
    ]);

    // Resolved (declined) offer: the gate actions return.
    expect(
      selectPendingActions(
        viewFor({ challenges: [base], offers: [offer("declined")] }),
        "team-a",
      ),
    ).toEqual([
      { kind: "mark_complete", challengeId },
      { kind: "we_failed", challengeId },
    ]);
  });
});
