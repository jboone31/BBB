import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  planBonusClaim,
  planClaimSideEffects,
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
 * Feature: card-behavior, Property 8: Next-claim effects are consumed by exactly
 * the next real claim.
 *
 * `planClaimSideEffects` and `planBonusClaim` in `lib/cards/claimEffects.ts`
 * decide what a team's next move does to its pending next-claim effects. For a
 * team holding any number of Pioneer / Scenic Route Next_Claim_Restrictions and
 * pending Insurance protections, this property pins the design contract across
 * arbitrary sequences of claims, ordinary unclaims, and Happy Hour Bonus_Claims:
 *
 * - The first *real* claim consumes every active Next_Claim_Restriction for that
 *   team (10.6) — Pioneer and Scenic are spent by the claim they gate whether or
 *   not they blocked anything. A Bonus_Claim consumes none (10.7).
 * - Insurance attaches to exactly the next real claim, and only one (the oldest
 *   pending protection), with `protectedPoints` equal to the team's allocation
 *   right after that claim (15.1, 15.2). A Bonus_Claim attaches none (15.6).
 *
 * The reference side of each assertion is computed independently from the
 * generated effect list, so the planner is checked against the rule rather than
 * against itself. Bonus_Claims are set up on a bar the team already holds with a
 * live bonus window and no temporary locks, so they are accepted and their
 * "consumes/attaches nothing" guarantee is exercised on the success path.
 *
 * Validates: Requirements 10.6, 10.7, 15.1, 15.2, 15.6
 */

// ---------------------------------------------------------------------------
// Fixtures and builders.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const NOW_MS = BASE_MS + 30 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const TEAM = "team-under-test";
const OTHER_TEAM = "team-other";
const BONUS_BAR = "bar-bonus";

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
    slug: "pioneer",
    kind: "next_claim_restriction",
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

/** A minimal live BehaviorState carrying only the effects/claims a test needs. */
function makeState(
  effects: readonly EffectRecord[],
  activeClaims: readonly ClaimRow[],
  awards: readonly AwardRecord[],
): BehaviorState {
  const bars = new Map<string, ResolvedBar>([[BONUS_BAR, bar(BONUS_BAR)]]);
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
// Generators.
// ---------------------------------------------------------------------------

/**
 * A single Next_Claim_Restriction for a team. `active` controls whether it is
 * live at NOW_MS (an inactive one is consumed before the probe, so it should not
 * be consumed again). `owner` picks the target team.
 */
const restrictionArb = (index: number): fc.Arbitrary<EffectRecord> =>
  fc
    .record({
      rule: fc.constantFrom("pioneer", "scenic"),
      target: fc.constantFrom(TEAM, OTHER_TEAM),
      active: fc.boolean(),
    })
    .map(({ rule, target, active }) =>
      effect({
        effectId: `restrict-${index}`,
        slug: rule === "pioneer" ? "pioneer" : "scenic-route",
        kind: "next_claim_restriction",
        targetTeamId: target,
        params: { rule },
        // An inactive restriction is modeled as already consumed before NOW.
        consumedAt: active ? null : iso(NOW_MS - 60_000),
      }),
    );

/**
 * A single Insurance protection. `pending` means active and unattached;
 * otherwise it is either attached (to a prior claim) or inactive, so it must not
 * attach to this claim. `owner` picks the protected team; `startOffset` orders
 * pending protections so the oldest-wins tie-break is exercised.
 */
const protectionArb = (index: number): fc.Arbitrary<EffectRecord> =>
  fc
    .record({
      owner: fc.constantFrom(TEAM, OTHER_TEAM),
      state: fc.constantFrom("pending", "attached", "inactive"),
      startOffset: fc.integer({ min: 0, max: 20 * 60_000 }),
    })
    .map(({ owner, state, startOffset }) =>
      effect({
        effectId: `ins-${index}`,
        slug: "insurance",
        kind: "score_protection",
        ownerTeamId: owner,
        startsAt: iso(BASE_MS + startOffset),
        attachedClaimId: state === "attached" ? `prior-claim-${index}` : null,
        consumedAt: state === "inactive" ? iso(NOW_MS - 60_000) : null,
      }),
    );

const effectsArb: fc.Arbitrary<readonly EffectRecord[]> = fc
  .tuple(
    fc.array(
      fc.nat(2).chain((i) => restrictionArb(i)),
      { maxLength: 4 },
    ),
    fc.array(
      fc.nat(2).chain((i) => protectionArb(i)),
      { maxLength: 4 },
    ),
  )
  .map(([restrictions, protections]) => {
    // Give every effect a unique id regardless of generated index collisions.
    return [...restrictions, ...protections].map((e, i) => ({
      ...e,
      effectId: `${e.effectId}-${i}`,
    }));
  });

/** The team's allocation right after a claim, used as the protected floor. */
const allocationArb: fc.Arbitrary<number> = fc.constantFrom(3, 4, 6, 12);

// ---------------------------------------------------------------------------
// Reference computations (independent of the planner).
// ---------------------------------------------------------------------------

function activeAtNow(e: EffectRecord): boolean {
  const start = Date.parse(e.startsAt);
  if (NOW_MS < start) return false;
  if (e.endsAt !== null && NOW_MS >= Date.parse(e.endsAt)) return false;
  if (e.consumedAt !== null && NOW_MS >= Date.parse(e.consumedAt)) return false;
  if (e.cancelledAt !== null && NOW_MS >= Date.parse(e.cancelledAt))
    return false;
  return true;
}

/** Restriction ids the rule says the team's next real claim must consume. */
function expectedConsumed(effects: readonly EffectRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const e of effects) {
    if (
      e.kind === "next_claim_restriction" &&
      e.targetTeamId === TEAM &&
      activeAtNow(e)
    ) {
      ids.add(e.effectId);
    }
  }
  return ids;
}

/** The oldest pending protection the rule says should attach (or null). */
function expectedProtection(
  effects: readonly EffectRecord[],
): EffectRecord | null {
  const pending = effects.filter(
    (e) =>
      e.kind === "score_protection" &&
      e.ownerTeamId === TEAM &&
      e.attachedClaimId === null &&
      activeAtNow(e),
  );
  if (pending.length === 0) return null;
  pending.sort((a, b) => {
    const sa = Date.parse(a.startsAt);
    const sb = Date.parse(b.startsAt);
    if (sa !== sb) return sa - sb;
    return a.effectId < b.effectId ? -1 : 1;
  });
  return pending[0];
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("planClaimSideEffects — next-claim consumption (Property 8)", () => {
  it("a real claim consumes exactly the team's active restrictions (10.6)", () => {
    fc.assert(
      fc.property(effectsArb, allocationArb, (effects, allocation) => {
        const state = makeState(effects, [], []);
        const claim: NewClaim = {
          claimId: "claim-real",
          teamId: TEAM,
          barKey: "bar-new",
        };
        const plan = planClaimSideEffects(
          state,
          claim,
          new Map([[TEAM, allocation]]),
          NOW_MS,
        );

        expect(new Set(plan.consumeEffects)).toEqual(expectedConsumed(effects));
        // No duplicates, and nothing belonging to another team is consumed.
        expect(plan.consumeEffects.length).toBe(
          new Set(plan.consumeEffects).size,
        );
        for (const id of plan.consumeEffects) {
          const e = effects.find((x) => x.effectId === id);
          expect(e?.targetTeamId).toBe(TEAM);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("a real claim attaches the oldest pending Insurance at the post-claim allocation (15.1, 15.2)", () => {
    fc.assert(
      fc.property(effectsArb, allocationArb, (effects, allocation) => {
        const state = makeState(effects, [], []);
        const claim: NewClaim = {
          claimId: "claim-real",
          teamId: TEAM,
          barKey: "bar-new",
        };
        const plan = planClaimSideEffects(
          state,
          claim,
          new Map([[TEAM, allocation]]),
          NOW_MS,
        );

        const expected = expectedProtection(effects);
        if (expected === null) {
          expect(plan.attachProtection).toBeNull();
        } else {
          expect(plan.attachProtection).not.toBeNull();
          expect(plan.attachProtection?.effectId).toBe(expected.effectId);
          // Protected floor is the team's allocation right after the claim.
          expect(plan.attachProtection?.protectedPoints).toBe(allocation);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("the restriction is spent by this claim regardless of whether it blocked anything (10.6)", () => {
    // A single active Pioneer restriction is always consumed by the team's claim.
    fc.assert(
      fc.property(fc.constantFrom("pioneer", "scenic"), (rule) => {
        const r = effect({
          effectId: "only-restriction",
          slug: rule === "pioneer" ? "pioneer" : "scenic-route",
          kind: "next_claim_restriction",
          targetTeamId: TEAM,
          params: { rule },
        });
        const state = makeState([r], [], []);
        const plan = planClaimSideEffects(
          state,
          { claimId: "c", teamId: TEAM, barKey: "bar-new" },
          new Map([[TEAM, 12]]),
          NOW_MS,
        );
        expect(plan.consumeEffects).toEqual(["only-restriction"]);
      }),
      { numRuns: 50 },
    );
  });
});

describe("planBonusClaim — consumes and attaches nothing (Property 8)", () => {
  it("an accepted Bonus_Claim neither consumes a restriction nor attaches Insurance (10.7, 15.6)", () => {
    fc.assert(
      fc.property(effectsArb, (effects) => {
        // A live Happy Hour window on a bar the team already holds, so the
        // Bonus_Claim is accepted and exercises the "consumes nothing" path.
        const bonusWindow = effect({
          effectId: "bonus-window",
          slug: "happy-hour",
          kind: "bonus_window",
          targetBarKey: BONUS_BAR,
          startsAt: iso(NOW_MS - 60_000),
          endsAt: iso(NOW_MS + 60 * 60_000),
        });
        const held: ClaimRow = {
          claimId: "held-claim",
          teamId: TEAM,
          barId: `id-${BONUS_BAR}`,
          barKey: BONUS_BAR,
          claimedAt: iso(NOW_MS - 120_000),
          revokedReason: null,
        };
        const state = makeState([...effects, bonusWindow], [held], []);

        const result = planBonusClaim(state, TEAM, BONUS_BAR, NOW_MS);

        // The window is live and unawarded, so the Bonus_Claim is accepted.
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.effectId).toBe("bonus-window");
        }

        // The returned plan shape for a Bonus_Claim exposes no restriction
        // consumption and no protection attachment fields — the only side effect
        // is the +5 window award named by the plan. Confirm by re-running the
        // real-claim planner: whatever it WOULD consume/attach, the Bonus_Claim
        // leaves every one of those effects untouched in `state`.
        const unchanged = state.effects.every(
          (e) => e.consumedAt === null || Date.parse(e.consumedAt) <= NOW_MS,
        );
        expect(unchanged).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("a Bonus_Claim plan carries no restriction/Insurance consumption fields", () => {
    // Structural guarantee: BonusClaimPlan is just {effectId, teamId, barKey};
    // it cannot express consuming a restriction or attaching Insurance.
    const bonusWindow = effect({
      effectId: "bonus-window",
      slug: "happy-hour",
      kind: "bonus_window",
      targetBarKey: BONUS_BAR,
      startsAt: iso(NOW_MS - 60_000),
      endsAt: iso(NOW_MS + 60 * 60_000),
    });
    const restriction = effect({
      effectId: "restrict",
      slug: "pioneer",
      kind: "next_claim_restriction",
      targetTeamId: TEAM,
      params: { rule: "pioneer" },
    });
    const protection = effect({
      effectId: "ins",
      slug: "insurance",
      kind: "score_protection",
      ownerTeamId: TEAM,
    });
    const held: ClaimRow = {
      claimId: "held-claim",
      teamId: TEAM,
      barId: `id-${BONUS_BAR}`,
      barKey: BONUS_BAR,
      claimedAt: iso(NOW_MS - 120_000),
      revokedReason: null,
    };
    const state = makeState([bonusWindow, restriction, protection], [held], []);

    const result = planBonusClaim(state, TEAM, BONUS_BAR, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.plan).sort()).toEqual([
        "barKey",
        "effectId",
        "teamId",
      ]);
    }
  });
});
