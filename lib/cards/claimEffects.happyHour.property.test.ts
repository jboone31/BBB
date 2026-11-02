import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  planBonusClaim,
  planClaimSideEffects,
  planUnclaimSideEffects,
  type NewClaim,
} from "./claimEffects";
import type {
  AwardRecord,
  BehaviorState,
  ClaimRow,
  EffectRecord,
} from "./behaviorState";
import type { ResolvedBar } from "@/lib/map/barResolver";

/**
 * Feature: card-behavior, Property 18: Happy Hour bonus uniqueness.
 *
 * `planClaimSideEffects`, `planBonusClaim`, and `planUnclaimSideEffects` in
 * `lib/cards/claimEffects.ts` together decide every Happy Hour bonus a team ever
 * receives. This property pins the design contract that a team holds at most one
 * unreversed +5 per Happy Hour window, across arbitrary sequences of claims,
 * Bonus_Claims, and ordinary unclaims:
 *
 * - A real claim on a bar during an active Happy Hour window awards +5 exactly
 *   once for that window (13.3).
 * - A team that already holds an unreversed bonus for that window gets no second
 *   award, whether it re-claims or submits a Bonus_Claim; the repeated
 *   Bonus_Claim is rejected `already_resolved` (13.6, 13.7).
 * - A Bonus_Claim awards +5 to a team that already claimed the bar, but only once
 *   per window (13.5).
 * - An ordinary unclaim reverses the Happy Hour bonus booked against that claim
 *   (−5); a `voted_off` removal does not (13.9).
 * - Folding any generated sequence of these decisions into a running award ledger
 *   leaves every (window, team) pair with at most one unreversed bonus.
 *
 * The reference side of each assertion is computed independently of the planners,
 * so they are checked against the rule rather than against themselves.
 *
 * Validates: Requirements 13.3, 13.5, 13.6, 13.7, 13.9
 */

// ---------------------------------------------------------------------------
// Fixtures and builders.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const NOW_MS = BASE_MS + 30 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const TEAM = "team-under-test";
const OTHER_TEAM = "team-other";
const HH_BAR = "bar-happy-hour";
const WINDOW_ID = "bonus-window";

/** A scoring bar with resolvable coordinates, keyed by `barKey`. */
function bar(barKey: string): ResolvedBar {
  return {
    barKey,
    barId: `id-${barKey}`,
    name: barKey,
    kind: "scoring",
    coords: { lat: 33.75, lng: -84.37 },
  };
}

/** A base effect row; callers override the fields the test cares about. */
function effect(overrides: Partial<EffectRecord>): EffectRecord {
  return {
    effectId: "eff",
    slug: "happy-hour",
    kind: "bonus_window",
    sourcePlayId: null,
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: null,
    targetBarKey: null,
    startsAt: iso(BASE_MS),
    endsAt: null,
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: false,
    endAnnounced: false,
    ...overrides,
  };
}

/** A Happy Hour window on HH_BAR. `active` controls liveness at NOW_MS. */
function happyHourWindow(active: boolean, id = WINDOW_ID): EffectRecord {
  return effect({
    effectId: id,
    slug: "happy-hour",
    kind: "bonus_window",
    targetBarKey: HH_BAR,
    startsAt: iso(NOW_MS - 10 * 60_000),
    // Active: ends well after NOW. Inactive: already ended before NOW.
    endsAt: active ? iso(NOW_MS + 30 * 60_000) : iso(NOW_MS - 60_000),
  });
}

/** An unreversed Happy Hour award for a team against a window and claim. */
function award(overrides: Partial<AwardRecord>): AwardRecord {
  return {
    awardId: "award",
    effectId: WINDOW_ID,
    teamId: TEAM,
    kind: "happy_hour_bonus",
    claimId: "some-claim",
    ledgerEntryId: "ledger",
    reversedAt: null,
    reversalLedgerEntryId: null,
    createdAt: iso(NOW_MS - 60_000),
    ...overrides,
  };
}

/** An active claim held by a team on HH_BAR. */
function heldClaim(teamId: string, claimId: string): ClaimRow {
  return {
    claimId,
    teamId,
    barId: `id-${HH_BAR}`,
    barKey: HH_BAR,
    claimedAt: iso(NOW_MS - 2 * 60_000),
    revokedReason: null,
  };
}

/** A minimal live BehaviorState carrying only the rows a test needs. */
function makeState(
  effects: readonly EffectRecord[],
  activeClaims: readonly ClaimRow[],
  awards: readonly AwardRecord[],
): BehaviorState {
  const bars = new Map<string, ResolvedBar>([[HH_BAR, bar(HH_BAR)]]);
  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: iso(NOW_MS),
    teams: [
      { teamId: TEAM, name: "Under Test", memberSessionIds: [] },
      { teamId: OTHER_TEAM, name: "Other", memberSessionIds: [] },
    ],
    hostSessionId: "host",
    bars,
    startBarKey: null,
    finishBarKey: null,
    activeClaims,
    claimHistory: activeClaims,
    hands: new Map(),
    plays: [],
    challenges: [],
    offers: [],
    effects,
    awards,
    ledger: [],
  };
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("planClaimSideEffects — Happy Hour award on claim (Property 18)", () => {
  it("a claim during an active window with no prior bonus awards +5 once (13.3)", () => {
    const state = makeState([happyHourWindow(true)], [], []);
    const claim: NewClaim = {
      claimId: "claim-real",
      teamId: TEAM,
      barKey: HH_BAR,
    };
    const plan = planClaimSideEffects(
      state,
      claim,
      new Map([[TEAM, 12]]),
      NOW_MS,
    );
    expect(plan.happyHourAward).not.toBeNull();
    expect(plan.happyHourAward?.effectId).toBe(WINDOW_ID);
  });

  it("a team already holding an unreversed bonus for the window gets no second award (13.6, 13.7)", () => {
    fc.assert(
      fc.property(fc.boolean(), (reclaims) => {
        // The team already holds an unreversed bonus for this window.
        const prior = award({ awardId: "prior", reversedAt: null });
        const state = makeState([happyHourWindow(true)], [], [prior]);
        const plan = planClaimSideEffects(
          state,
          {
            claimId: reclaims ? "claim-again" : "claim-new",
            teamId: TEAM,
            barKey: HH_BAR,
          },
          new Map([[TEAM, 12]]),
          NOW_MS,
        );
        // No additional Happy Hour award is planned for the held window.
        expect(plan.happyHourAward).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("a claim awards again only after the prior bonus for the window was reversed (13.7, 13.9)", () => {
    // A reversed award no longer counts, so a fresh claim re-awards the window.
    const reversed = award({
      awardId: "reversed",
      reversedAt: iso(NOW_MS - 30_000),
      reversalLedgerEntryId: "rev-ledger",
    });
    const state = makeState([happyHourWindow(true)], [], [reversed]);
    const plan = planClaimSideEffects(
      state,
      { claimId: "claim-after-reverse", teamId: TEAM, barKey: HH_BAR },
      new Map([[TEAM, 12]]),
      NOW_MS,
    );
    expect(plan.happyHourAward?.effectId).toBe(WINDOW_ID);
  });

  it("awards are scoped to the team: another team's bonus does not block this team (13.6)", () => {
    const othersBonus = award({ awardId: "others", teamId: OTHER_TEAM });
    const state = makeState([happyHourWindow(true)], [], [othersBonus]);
    const plan = planClaimSideEffects(
      state,
      { claimId: "claim-real", teamId: TEAM, barKey: HH_BAR },
      new Map([[TEAM, 12]]),
      NOW_MS,
    );
    expect(plan.happyHourAward?.effectId).toBe(WINDOW_ID);
  });
});

describe("planBonusClaim — Happy Hour Bonus_Claim uniqueness (Property 18)", () => {
  it("awards +5 to a team that already claimed the bar, when no prior bonus (13.5)", () => {
    const state = makeState(
      [happyHourWindow(true)],
      [heldClaim(TEAM, "held")],
      [],
    );
    const result = planBonusClaim(state, TEAM, HH_BAR, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.effectId).toBe(WINDOW_ID);
      expect(result.plan.teamId).toBe(TEAM);
      expect(result.plan.barKey).toBe(HH_BAR);
    }
  });

  it("a repeated Bonus_Claim after the team already holds the bonus is rejected already_resolved (13.6)", () => {
    const prior = award({ awardId: "prior", claimId: null });
    const state = makeState(
      [happyHourWindow(true)],
      [heldClaim(TEAM, "held")],
      [prior],
    );
    const result = planBonusClaim(state, TEAM, HH_BAR, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("already_resolved");
    }
  });

  it("across claim-vs-bonus orderings, a team is paid the window exactly once (13.5, 13.6)", () => {
    // Model the two durable paths to a bonus (a claim award and a Bonus_Claim)
    // in either order. Whichever runs first books the only unreversed award;
    // the second must find nothing left to award.
    fc.assert(
      fc.property(fc.boolean(), (bonusFirst) => {
        const held = heldClaim(TEAM, "held");

        // Round 1: no awards yet. Both the claim planner and the Bonus_Claim
        // would each award the window.
        const empty = makeState([happyHourWindow(true)], [held], []);
        expect(
          planClaimSideEffects(
            empty,
            { claimId: "c1", teamId: TEAM, barKey: HH_BAR },
            new Map([[TEAM, 12]]),
            NOW_MS,
          ).happyHourAward?.effectId,
        ).toBe(WINDOW_ID);
        const firstBonus = planBonusClaim(empty, TEAM, HH_BAR, NOW_MS);
        expect(firstBonus.ok).toBe(true);

        // Round 2: whichever path "won" first books an unreversed award. The
        // other path must now decline — the window is already paid.
        const booked = award({
          awardId: "booked",
          claimId: bonusFirst ? null : "c1",
        });
        const after = makeState([happyHourWindow(true)], [held], [booked]);

        expect(
          planClaimSideEffects(
            after,
            { claimId: "c2", teamId: TEAM, barKey: HH_BAR },
            new Map([[TEAM, 12]]),
            NOW_MS,
          ).happyHourAward,
        ).toBeNull();
        const secondBonus = planBonusClaim(after, TEAM, HH_BAR, NOW_MS);
        expect(secondBonus.ok).toBe(false);
        if (!secondBonus.ok) {
          expect(secondBonus.error).toBe("already_resolved");
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("planUnclaimSideEffects — Happy Hour reversal (Property 18)", () => {
  it("an ordinary unclaim reverses the claim's unreversed Happy Hour bonus (13.9)", () => {
    const booked = award({ awardId: "booked", claimId: "the-claim" });
    const state = makeState([happyHourWindow(true)], [], [booked]);
    const plan = planUnclaimSideEffects(state, "the-claim", "ordinary_unclaim");
    expect(plan.reverseAwards).toEqual(["booked"]);
  });

  it("an ordinary unclaim leaves other claims' and already-reversed bonuses untouched (13.9)", () => {
    const mine = award({ awardId: "mine", claimId: "the-claim" });
    const otherClaim = award({ awardId: "other-claim", claimId: "elsewhere" });
    const alreadyReversed = award({
      awardId: "already",
      claimId: "the-claim",
      reversedAt: iso(NOW_MS - 60_000),
    });
    const state = makeState(
      [happyHourWindow(true)],
      [],
      [mine, otherClaim, alreadyReversed],
    );
    const plan = planUnclaimSideEffects(state, "the-claim", "ordinary_unclaim");
    // Only the unreversed bonus for exactly this claim is reversed.
    expect(plan.reverseAwards).toEqual(["mine"]);
  });

  it("a voted_off removal reverses no Happy Hour bonus (13.9)", () => {
    const booked = award({ awardId: "booked", claimId: "the-claim" });
    const state = makeState([happyHourWindow(true)], [], [booked]);
    const plan = planUnclaimSideEffects(state, "the-claim", "voted_off");
    expect(plan.reverseAwards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sequence invariant: at most one unreversed bonus per (window, team).
// ---------------------------------------------------------------------------

/**
 * A generated step in a team's Happy Hour history on HH_BAR.
 * - `claim` runs `planClaimSideEffects` and books the award it plans.
 * - `bonus` runs `planBonusClaim` and books the award if accepted.
 * - `unclaim` runs `planUnclaimSideEffects` and reverses what it plans.
 */
type Step =
  | { readonly type: "claim"; readonly claimId: string }
  | { readonly type: "bonus" }
  | { readonly type: "unclaim"; readonly claimId: string };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc
    .integer({ min: 0, max: 3 })
    .map((n) => ({ type: "claim" as const, claimId: `claim-${n}` })),
  fc.constant({ type: "bonus" as const }),
  fc
    .integer({ min: 0, max: 3 })
    .map((n) => ({ type: "unclaim" as const, claimId: `claim-${n}` })),
);

describe("Happy Hour bonus uniqueness invariant across sequences (Property 18)", () => {
  it("every (window, team) holds at most one unreversed bonus throughout", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { minLength: 1, maxLength: 12 }),
        (steps) => {
          const windowEffect = happyHourWindow(true);
          // Running award ledger, folded by applying each planner's decision.
          let awards: AwardRecord[] = [];
          let awardSeq = 0;

          const unreversedForTeam = (): AwardRecord[] =>
            awards.filter(
              (a) =>
                a.kind === "happy_hour_bonus" &&
                a.effectId === WINDOW_ID &&
                a.teamId === TEAM &&
                a.reversedAt === null,
            );

          for (const step of steps) {
            // The team holds every claim it ever claimed (unclaims don't remove
            // the row here; they just reverse the booked award, which is all the
            // uniqueness invariant cares about).
            const held = heldClaim(TEAM, "held");
            const state = makeState([windowEffect], [held], awards);

            if (step.type === "claim") {
              const plan = planClaimSideEffects(
                state,
                { claimId: step.claimId, teamId: TEAM, barKey: HH_BAR },
                new Map([[TEAM, 12]]),
                NOW_MS,
              );
              if (plan.happyHourAward !== null) {
                awards = [
                  ...awards,
                  award({
                    awardId: `a-${awardSeq++}`,
                    effectId: plan.happyHourAward.effectId,
                    claimId: step.claimId,
                  }),
                ];
              }
            } else if (step.type === "bonus") {
              const result = planBonusClaim(state, TEAM, HH_BAR, NOW_MS);
              if (result.ok) {
                awards = [
                  ...awards,
                  award({
                    awardId: `a-${awardSeq++}`,
                    effectId: result.plan.effectId,
                    claimId: null,
                  }),
                ];
              }
            } else {
              const plan = planUnclaimSideEffects(
                state,
                step.claimId,
                "ordinary_unclaim",
              );
              const reverse = new Set(plan.reverseAwards);
              awards = awards.map((a) =>
                reverse.has(a.awardId) ? { ...a, reversedAt: iso(NOW_MS) } : a,
              );
            }

            // Invariant after every step: at most one unreversed bonus.
            expect(unreversedForTeam().length).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
