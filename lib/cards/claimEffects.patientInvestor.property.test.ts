import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  planClaimSideEffects,
  planUnclaimSideEffects,
  type CountedClaim,
  type NewClaim,
} from "./claimEffects";
import type { AwardRecord, BehaviorState, EffectRecord } from "./behaviorState";
import type { ResolvedBar } from "@/lib/map/barResolver";

/**
 * Feature: card-behavior, Property 19: Patient Investor counts distinct
 * subsequent claims.
 *
 * `planClaimSideEffects` and `planUnclaimSideEffects` in
 * `lib/cards/claimEffects.ts` own a Patient Investor `claim_counter`'s lifecycle.
 * This property drives an active counter through arbitrary sequences of real
 * claims (some on fresh bars, some re-claims of already-counted bars) and
 * arbitrary unclaims (ordinary and voted-off), replaying each returned plan into
 * the counter's persisted `counted` list, and pins the design contract:
 *
 * - A claim advances the counter only on a bar key not already in `counted`
 *   (16.2); re-claiming an already-counted bar leaves it unchanged (16.2).
 * - The counter pays out `+6` and is consumed on exactly the fourth distinct
 *   bar, with no payout before and none after — including when the fourth bar is
 *   the finish bar (16.4, 16.7 via the counter starting at zero per 16.1).
 * - An ordinary unclaim uncounts the bar from an *unpaid* counter (16.3), but a
 *   counter that has already paid out is frozen (16.4): neither its count nor its
 *   payout moves.
 * - A `voted_off` removal never uncounts (the count survives an opponent's card
 *   effect, labelled here under 21.6 / 18.7).
 *
 * The reference side of every assertion is a plain model computed from the
 * replayed `counted` list, so the planner is checked against the rule rather than
 * against itself.
 *
 * Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.7, 21.6
 */

// ---------------------------------------------------------------------------
// Fixtures and builders.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const NOW_MS = BASE_MS + 30 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const TEAM = "team-under-test";
const OTHER_TEAM = "team-other";
const COUNTER_ID = "counter-patient-investor";
const FINISH_BAR = "bar-finish";

/** A scoring bar with resolvable coordinates, keyed by `barKey`. */
function bar(
  barKey: string,
  kind: ResolvedBar["kind"] = "scoring",
): ResolvedBar {
  return {
    barKey,
    barId: `id-${barKey}`,
    name: barKey,
    kind,
    coords: { lat: 33.75, lng: -84.37 },
  };
}

/** A base effect row; callers override the fields the test cares about. */
function effect(overrides: Partial<EffectRecord>): EffectRecord {
  return {
    effectId: "eff",
    slug: "patient-investor",
    kind: "claim_counter",
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

/**
 * A Patient Investor `claim_counter` owned by {@link TEAM}, started at zero, with
 * its `counted` list taken from `counted` and consumed when `consumedAtMs` is a
 * number. This mirrors the row the route persists between claims.
 */
function counter(
  counted: readonly CountedClaim[],
  consumedAtMs: number | null = null,
): EffectRecord {
  return effect({
    effectId: COUNTER_ID,
    ownerTeamId: TEAM,
    params: { counted: counted.map((c) => ({ ...c })) },
    consumedAt: consumedAtMs === null ? null : iso(consumedAtMs),
  });
}

/** A minimal live BehaviorState carrying only the effects/awards a test needs. */
function makeState(
  effects: readonly EffectRecord[],
  awards: readonly AwardRecord[] = [],
): BehaviorState {
  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: iso(NOW_MS),
    teams: [
      { teamId: TEAM, name: "Under Test", memberSessionIds: [] },
      { teamId: OTHER_TEAM, name: "Other", memberSessionIds: [] },
    ],
    hostSessionId: "host",
    bars: new Map<string, ResolvedBar>([
      [FINISH_BAR, bar(FINISH_BAR, "finish")],
    ]),
    startBarKey: null,
    finishBarKey: FINISH_BAR,
    activeClaims: [],
    claimHistory: [],
    hands: new Map(),
    plays: [],
    challenges: [],
    offers: [],
    effects,
    awards,
    ledger: [],
  };
}

/** The counter row in a plan result, or null when nothing updates it. */
function counterUpdate(
  plan: ReturnType<typeof planClaimSideEffects>,
): { counted: readonly CountedClaim[]; payout: boolean } | null {
  const update = plan.counterUpdates.find((u) => u.effectId === COUNTER_ID);
  return update ? { counted: update.counted, payout: update.payout } : null;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A short pool of bar keys so re-claims of counted bars happen naturally. */
const BAR_POOL = ["bar-a", "bar-b", "bar-c", "bar-d", "bar-e"] as const;

type Step =
  | { readonly op: "claim"; readonly barKey: string }
  | {
      readonly op: "unclaim";
      readonly reason: "ordinary_unclaim" | "voted_off";
    };

const claimStepArb: fc.Arbitrary<Step> = fc
  .constantFrom(...BAR_POOL, FINISH_BAR)
  .map((barKey) => ({ op: "claim", barKey }) as const);

const unclaimStepArb: fc.Arbitrary<Step> = fc
  .constantFrom("ordinary_unclaim", "voted_off")
  .map((reason) => ({ op: "unclaim", reason }) as const);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: claimStepArb },
  { weight: 1, arbitrary: unclaimStepArb },
);

const scriptArb: fc.Arbitrary<readonly Step[]> = fc.array(stepArb, {
  minLength: 1,
  maxLength: 12,
});

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

const THRESHOLD = 4;

describe("Patient Investor counter lifecycle (Property 19)", () => {
  it("counts distinct bars, pays out once at four, and freezes after payout (16.1-16.4, 16.7)", () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        // The counter's persisted state as we replay the plans back into it.
        let counted: CountedClaim[] = [];
        let consumedAtMs: number | null = null; // set once the counter pays out
        let payoutCount = 0; // how many claims triggered a +6 payout
        // Track which claim ids are still "live" so an unclaim targets a real one.
        const claimBars = new Map<string, string>(); // claimId -> barKey
        let claimSeq = 0;

        for (const step of script) {
          if (step.op === "claim") {
            const claimId = `claim-${claimSeq++}`;
            const claim: NewClaim = {
              claimId,
              teamId: TEAM,
              barKey: step.barKey,
            };
            const state = makeState([counter(counted, consumedAtMs)]);
            const plan = planClaimSideEffects(
              state,
              claim,
              new Map([[TEAM, 12]]),
              NOW_MS,
            );
            const update = counterUpdate(plan);

            if (consumedAtMs !== null) {
              // A consumed counter is inactive: no claim ever updates it again.
              expect(update).toBeNull();
              continue;
            }

            const alreadyCounted = counted.some(
              (c) => c.barKey === step.barKey,
            );
            if (alreadyCounted) {
              // Re-claiming an already-counted bar must not advance the counter.
              expect(update).toBeNull();
              continue;
            }

            // A distinct bar advances the counter by exactly this claim.
            expect(update).not.toBeNull();
            const next = [...counted, { claimId, barKey: step.barKey }];
            expect(update!.counted).toEqual(next);

            const shouldPayout = next.length >= THRESHOLD;
            expect(update!.payout).toBe(shouldPayout);

            counted = next;
            claimBars.set(claimId, step.barKey);
            if (shouldPayout) {
              // Payout happens exactly at the fourth distinct bar; the route
              // consumes the effect in the same transaction.
              expect(next.length).toBe(THRESHOLD);
              payoutCount += 1;
              consumedAtMs = NOW_MS;
            }
          } else {
            // Pick any still-live counted claim to remove; if none, the unclaim
            // targets an uncounted claim and must be a no-op for the counter.
            const liveCounted = counted.find((c) => claimBars.has(c.claimId));
            const targetClaimId = liveCounted?.claimId ?? "claim-uncounted";
            const state = makeState([counter(counted, consumedAtMs)]);
            const unplan = planUnclaimSideEffects(
              state,
              targetClaimId,
              step.reason,
            );
            const uncount = unplan.uncount.find(
              (u) => u.effectId === COUNTER_ID,
            );

            if (step.reason === "voted_off") {
              // Voted Off never uncounts: the count survives (21.6 / 18.7).
              expect(unplan.uncount).toEqual([]);
              continue;
            }

            if (consumedAtMs !== null) {
              // A paid-out counter is frozen: an ordinary unclaim leaves it be.
              expect(uncount).toBeUndefined();
              continue;
            }

            if (liveCounted === undefined) {
              // Nothing counted for this claim id — no counter change.
              expect(uncount).toBeUndefined();
              continue;
            }

            // Ordinary unclaim of a counted, unpaid claim removes exactly it.
            expect(uncount).not.toBeUndefined();
            const expected = counted.filter((c) => c.claimId !== targetClaimId);
            expect(uncount!.counted).toEqual(expected);
            counted = [...expected];
            claimBars.delete(targetClaimId);
          }
        }

        // The counter can pay out at most once across the whole script.
        expect(payoutCount).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it("the finish bar counts as the fourth distinct bar and triggers payout (16.4)", () => {
    const counted: CountedClaim[] = [
      { claimId: "c1", barKey: "bar-a" },
      { claimId: "c2", barKey: "bar-b" },
      { claimId: "c3", barKey: "bar-c" },
    ];
    const state = makeState([counter(counted)]);
    const plan = planClaimSideEffects(
      state,
      { claimId: "c4", teamId: TEAM, barKey: FINISH_BAR },
      new Map([[TEAM, 12]]),
      NOW_MS,
    );
    const update = counterUpdate(plan);
    expect(update).not.toBeNull();
    expect(update!.payout).toBe(true);
    expect(update!.counted.map((c) => c.barKey)).toEqual([
      "bar-a",
      "bar-b",
      "bar-c",
      FINISH_BAR,
    ]);
  });

  it("re-claiming an already-counted bar does not advance the counter (16.2)", () => {
    const counted: CountedClaim[] = [{ claimId: "c1", barKey: "bar-a" }];
    const state = makeState([counter(counted)]);
    const plan = planClaimSideEffects(
      state,
      { claimId: "c2", teamId: TEAM, barKey: "bar-a" },
      new Map([[TEAM, 12]]),
      NOW_MS,
    );
    expect(counterUpdate(plan)).toBeNull();
  });

  it("an ordinary unclaim uncounts an unpaid counter but a voted_off does not (16.3, 21.6)", () => {
    const counted: CountedClaim[] = [
      { claimId: "c1", barKey: "bar-a" },
      { claimId: "c2", barKey: "bar-b" },
    ];
    const state = makeState([counter(counted)]);

    const ordinary = planUnclaimSideEffects(state, "c1", "ordinary_unclaim");
    const ordinaryCount = ordinary.uncount.find(
      (u) => u.effectId === COUNTER_ID,
    );
    expect(ordinaryCount).not.toBeUndefined();
    expect(ordinaryCount!.counted).toEqual([
      { claimId: "c2", barKey: "bar-b" },
    ]);

    const voted = planUnclaimSideEffects(state, "c1", "voted_off");
    expect(voted.uncount).toEqual([]);
  });

  it("a consumed (paid-out) counter is frozen against ordinary unclaims (16.4)", () => {
    const counted: CountedClaim[] = [
      { claimId: "c1", barKey: "bar-a" },
      { claimId: "c2", barKey: "bar-b" },
      { claimId: "c3", barKey: "bar-c" },
      { claimId: "c4", barKey: "bar-d" },
    ];
    const state = makeState([counter(counted, NOW_MS - 60_000)]);
    const plan = planUnclaimSideEffects(state, "c1", "ordinary_unclaim");
    expect(plan.uncount).toEqual([]);
  });
});
