import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  evaluateClaimBlocks,
  type ClaimBlock,
  type ClaimBlockInput,
} from "./blocks";
import type {
  ChallengeRecord,
  EffectRecord,
  ResolvedBarRef,
} from "@/lib/cards/behaviorState";
import { isEffectActive } from "@/lib/cards/effects";
import {
  CANCEL_CULTURE_RADIUS_MILES,
  withinMiles,
  type LatLng,
} from "@/lib/map/geo";
import { barSatisfiesRule } from "@/lib/claims/legalNextBar";

/**
 * Feature: card-behavior, Property 6: Claim block evaluation is complete and exact.
 *
 * `evaluateClaimBlocks` is the single place that decides why a team may not
 * claim a given bar right now. It must collect *every* applicable reason — it
 * never short-circuits — in the fixed Requirement 19.1 order so a rejection can
 * list all blocking cards. This property pins down that contract against an
 * independent reference built straight from the rule text:
 *
 * - The emitted blocks equal the reference blocks, in the same order: challenge
 *   gate (4.2), critic block (7.3), Crop Dusting owner-exempt (11.3), Cancel
 *   Culture inclusive 0.25-mile radius (12.4), then — in `claim` mode only —
 *   Pioneer and Scenic Route next-claim restrictions (19.1, 19.3).
 * - The result is empty iff the claim is allowed.
 * - `bonus` mode never emits a pioneer/scenic block (10.7); the first four
 *   families are identical between the two modes.
 * - Crop Dusting exempts the lock's owner and blocks every other team (11.3).
 * - Cancel Culture blocks every team whose bar is within the inclusive radius of
 *   a lock center, and never blocks a bar with no coordinates or a lock whose
 *   center is unknown (12.4).
 * - Every decision depends only on the server `nowMs`, never on an effect's
 *   `startAnnounced` / `endAnnounced` flags (20.3c): flipping those flips no
 *   block.
 *
 * Validates: Requirements 4.2, 4.3, 7.3, 11.3, 12.4, 19.1, 19.3, 10.7
 */

// ---------------------------------------------------------------------------
// Timeline + coordinate anchors.
// ---------------------------------------------------------------------------

/** A fixed base instant so every generated window shares one timeline. */
const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A small cluster of coordinates around the Beltline. Two of them sit well
 * inside 0.25 mi of each other, one sits well outside, so the Cancel Culture
 * radius test exercises both sides of the boundary.
 */
const COORD_A: LatLng = { lat: 33.749, lng: -84.388 };
const COORD_NEAR: LatLng = { lat: 33.7492, lng: -84.3882 }; // ~0.02 mi from A
const COORD_FAR: LatLng = { lat: 33.77, lng: -84.36 }; // ~2 mi from A

const TEAMS = ["team-1", "team-2", "team-3", "team-4"] as const;

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const teamArb: fc.Arbitrary<string> = fc.constantFrom(...TEAMS);

const coordsArb: fc.Arbitrary<LatLng | null> = fc.option(
  fc.constantFrom(COORD_A, COORD_NEAR, COORD_FAR),
  { nil: null },
);

/** A game bar: a key, a scoring kind, and optional coordinates. */
const barArb: fc.Arbitrary<ResolvedBarRef> = fc
  .record({
    barKey: fc.constantFrom("bar-a", "bar-b", "bar-c", "finish"),
    coords: coordsArb,
  })
  .map(({ barKey, coords }): ResolvedBarRef => ({
    barKey,
    kind: barKey === "finish" ? "finish" : "scoring",
    coords,
  }));

/** An arbitrary challenge targeting some team with some status. */
const challengeArb: fc.Arbitrary<ChallengeRecord> = fc
  .record({
    id: fc.integer({ min: 0, max: 100000 }),
    targetTeamId: teamArb,
    status: fc.constantFrom(
      "open",
      "completed",
      "failed",
      "cleared_by_host",
    ) as fc.Arbitrary<ChallengeRecord["status"]>,
  })
  .map(({ id, targetTeamId, status }): ChallengeRecord => ({
    challengeId: `chal-${id}`,
    slug: "go-piss-girl",
    sourcePlayId: `play-${id}`,
    casterTeamId: "team-1",
    targetTeamId,
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status,
    createdAt: iso(BASE_MS),
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
  }));

/** A window relative to the base instant, sometimes cancelled/consumed. */
function windowArb() {
  return fc.record({
    startOffset: fc.integer({ min: -60 * 60_000, max: 60 * 60_000 }),
    duration: fc.integer({ min: 1, max: 60 * 60_000 }),
    cancelOffset: fc.option(
      fc.integer({ min: -60 * 60_000, max: 120 * 60_000 }),
      { nil: null },
    ),
    consumeOffset: fc.option(
      fc.integer({ min: -60 * 60_000, max: 120 * 60_000 }),
      { nil: null },
    ),
    // Announced flags are deliberately random: they must change no decision.
    startAnnounced: fc.boolean(),
    endAnnounced: fc.boolean(),
  });
}

const baseEffect = (id: number): EffectRecord => ({
  effectId: `eff-${id}`,
  slug: "crop-dusting",
  kind: "bar_lock",
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
});

const criticEffectArb = (id: number): fc.Arbitrary<EffectRecord> =>
  fc.tuple(teamArb, windowArb()).map(([targetTeamId, w]) => ({
    ...baseEffect(id),
    effectId: `critic-${id}`,
    slug: "everyones-a-critic" as const,
    kind: "team_claim_block" as const,
    targetTeamId,
    startsAt: iso(BASE_MS + w.startOffset),
    endsAt: iso(BASE_MS + w.startOffset + w.duration),
    consumedAt:
      w.consumeOffset === null ? null : iso(BASE_MS + w.consumeOffset),
    cancelledAt: w.cancelOffset === null ? null : iso(BASE_MS + w.cancelOffset),
    cancelReason: w.cancelOffset === null ? null : ("host" as const),
    startAnnounced: w.startAnnounced,
    endAnnounced: w.endAnnounced,
  }));

const cropDustingEffectArb = (id: number): fc.Arbitrary<EffectRecord> =>
  fc
    .tuple(
      teamArb, // owner
      fc.constantFrom("bar-a", "bar-b", "bar-c", "finish"),
      windowArb(),
    )
    .map(([ownerTeamId, targetBarKey, w]) => ({
      ...baseEffect(id),
      effectId: `crop-${id}`,
      slug: "crop-dusting" as const,
      kind: "bar_lock" as const,
      ownerTeamId,
      targetBarKey,
      startsAt: iso(BASE_MS + w.startOffset),
      endsAt: iso(BASE_MS + w.startOffset + w.duration),
      consumedAt:
        w.consumeOffset === null ? null : iso(BASE_MS + w.consumeOffset),
      cancelledAt:
        w.cancelOffset === null ? null : iso(BASE_MS + w.cancelOffset),
      cancelReason: w.cancelOffset === null ? null : ("host" as const),
      startAnnounced: w.startAnnounced,
      endAnnounced: w.endAnnounced,
    }));

const cancelCultureEffectArb = (id: number): fc.Arbitrary<EffectRecord> =>
  fc
    .tuple(
      // A lock center keyed by one of the known bar keys, or an unresolvable key.
      fc.constantFrom("bar-a", "bar-b", "bar-c", "unknown-center"),
      windowArb(),
    )
    .map(([targetBarKey, w]) => ({
      ...baseEffect(id),
      effectId: `cancel-${id}`,
      slug: "cancel-culture" as const,
      kind: "radius_lock" as const,
      targetBarKey,
      startsAt: iso(BASE_MS + w.startOffset),
      endsAt: iso(BASE_MS + w.startOffset + w.duration),
      consumedAt:
        w.consumeOffset === null ? null : iso(BASE_MS + w.consumeOffset),
      cancelledAt:
        w.cancelOffset === null ? null : iso(BASE_MS + w.cancelOffset),
      cancelReason: w.cancelOffset === null ? null : ("host" as const),
      startAnnounced: w.startAnnounced,
      endAnnounced: w.endAnnounced,
    }));

const restrictionEffectArb = (id: number): fc.Arbitrary<EffectRecord> =>
  fc
    .tuple(teamArb, fc.constantFrom("pioneer", "scenic"), windowArb())
    .map(([targetTeamId, rule, w]) => ({
      ...baseEffect(id),
      effectId: `restr-${id}`,
      slug:
        rule === "pioneer" ? ("pioneer" as const) : ("scenic-route" as const),
      kind: "next_claim_restriction" as const,
      targetTeamId,
      params: { rule },
      startsAt: iso(BASE_MS + w.startOffset),
      endsAt: null, // next-claim restrictions clear by consumption, not clock
      consumedAt:
        w.consumeOffset === null ? null : iso(BASE_MS + w.consumeOffset),
      cancelledAt:
        w.cancelOffset === null ? null : iso(BASE_MS + w.cancelOffset),
      cancelReason: w.cancelOffset === null ? null : ("host" as const),
      startAnnounced: w.startAnnounced,
      endAnnounced: w.endAnnounced,
    }));

/** A pool of mixed effects of every relevant kind. */
const anyEffectArb: fc.Arbitrary<EffectRecord> = fc
  .integer({ min: 0, max: 4 })
  .chain((kindPick) => {
    switch (kindPick) {
      case 0:
        return criticEffectArb(0);
      case 1:
        return cropDustingEffectArb(0);
      case 2:
        return cancelCultureEffectArb(0);
      default:
        return restrictionEffectArb(0);
    }
  });

const effectsArb: fc.Arbitrary<EffectRecord[]> = fc
  .array(anyEffectArb, { minLength: 0, maxLength: 8 })
  // Deterministic unique ids so reference ordering ties never depend on chance.
  .map((effects) =>
    effects.map((e, i) => ({ ...e, effectId: `${e.effectId}-${i}` })),
  );

const claimsArb: fc.Arbitrary<{ teamId: string; barKey: string }[]> = fc.array(
  fc.record({
    teamId: teamArb,
    barKey: fc.constantFrom("bar-a", "bar-b", "bar-c"),
  }),
  { minLength: 0, maxLength: 6 },
);

const probeTimeArb: fc.Arbitrary<number> = fc.integer({
  min: BASE_MS - 90 * 60_000,
  max: BASE_MS + 180 * 60_000,
});

const inputArb: fc.Arbitrary<ClaimBlockInput> = fc
  .record({
    teamId: teamArb,
    bar: barArb,
    challenges: fc.array(challengeArb, { minLength: 0, maxLength: 5 }),
    effects: effectsArb,
    activeClaims: claimsArb,
    previousBar: barArb,
    mode: fc.constantFrom<"claim" | "bonus">("claim", "bonus"),
    nowMs: probeTimeArb,
  })
  .map((r): ClaimBlockInput => {
    // Fixed coordinate map for lock-center resolution. "unknown-center" is
    // deliberately absent so it resolves to undefined.
    const barCoords = new Map<string, LatLng>([
      ["bar-a", COORD_A],
      ["bar-b", COORD_NEAR],
      ["bar-c", COORD_FAR],
      ["finish", COORD_FAR],
    ]);
    return {
      teamId: r.teamId,
      bar: r.bar,
      finishCoords: COORD_FAR,
      challenges: r.challenges,
      effects: r.effects,
      activeClaims: r.activeClaims,
      previousBar: r.previousBar,
      barCoords,
      mode: r.mode,
      nowMs: r.nowMs,
    };
  });

// ---------------------------------------------------------------------------
// Independent reference implementation (kept separate from blocks.ts).
// ---------------------------------------------------------------------------

/**
 * Re-derive the expected block list straight from the rule text, in the fixed
 * Requirement 19.1 order. This is the oracle `evaluateClaimBlocks` must match.
 */
function referenceBlocks(input: ClaimBlockInput): ClaimBlock[] {
  const { teamId, bar, effects, nowMs, mode } = input;
  const out: ClaimBlock[] = [];

  // 1. Challenge gate.
  for (const c of input.challenges) {
    if (c.targetTeamId === teamId && c.status === "open") {
      out.push({ kind: "challenge", slug: c.slug, challengeId: c.challengeId });
    }
  }

  // 2. Critic block.
  for (const e of effects) {
    if (
      e.kind === "team_claim_block" &&
      e.targetTeamId === teamId &&
      e.endsAt !== null &&
      isEffectActive(e, nowMs)
    ) {
      out.push({
        kind: "critic_block",
        slug: "everyones-a-critic",
        effectId: e.effectId,
        endsAt: e.endsAt,
      });
    }
  }

  // 3. Crop Dusting (owner exempt).
  for (const e of effects) {
    if (
      e.kind === "bar_lock" &&
      e.targetBarKey === bar.barKey &&
      e.ownerTeamId !== teamId &&
      e.endsAt !== null &&
      isEffectActive(e, nowMs)
    ) {
      out.push({
        kind: "bar_lock",
        slug: "crop-dusting",
        effectId: e.effectId,
        endsAt: e.endsAt,
      });
    }
  }

  // 4. Cancel Culture (inclusive radius; uncoordinated never blocks).
  if (bar.coords !== null) {
    for (const e of effects) {
      if (
        e.kind !== "radius_lock" ||
        e.endsAt === null ||
        !isEffectActive(e, nowMs)
      ) {
        continue;
      }
      const center =
        e.targetBarKey === null
          ? undefined
          : input.barCoords.get(e.targetBarKey);
      if (center === undefined) {
        continue;
      }
      if (withinMiles(bar.coords, center, CANCEL_CULTURE_RADIUS_MILES)) {
        out.push({
          kind: "radius_lock",
          slug: "cancel-culture",
          effectId: e.effectId,
          endsAt: e.endsAt,
        });
      }
    }
  }

  // 5. Pioneer / Scenic — claim mode only.
  if (mode === "claim") {
    const legalInput = {
      teamId,
      rules: [],
      bars: [bar],
      finishCoords: input.finishCoords,
      activeClaims: input.activeClaims,
      previousBar: input.previousBar,
    };
    for (const e of effects) {
      if (
        e.kind !== "next_claim_restriction" ||
        e.targetTeamId !== teamId ||
        !isEffectActive(e, nowMs)
      ) {
        continue;
      }
      const rule = e.params.rule as "pioneer" | "scenic" | undefined;
      if (rule === "pioneer") {
        if (bar.kind === "finish") {
          out.push({
            kind: "pioneer",
            slug: "pioneer",
            effectId: e.effectId,
            reason: "finish_bar",
          });
        } else if (!barSatisfiesRule("pioneer", bar, legalInput)) {
          out.push({
            kind: "pioneer",
            slug: "pioneer",
            effectId: e.effectId,
            reason: "claimed_by_other",
          });
        }
      } else if (rule === "scenic") {
        if (!barSatisfiesRule("scenic", bar, legalInput)) {
          const reason =
            bar.coords === null ||
            input.finishCoords === null ||
            input.previousBar.coords === null
              ? "no_coordinates"
              : "not_farther";
          out.push({
            kind: "scenic",
            slug: "scenic-route",
            effectId: e.effectId,
            reason,
          });
        }
      }
    }
  }

  return out;
}

/** Strip an effect's announced flags to the opposite value. */
function flipAnnounced(e: EffectRecord): EffectRecord {
  return {
    ...e,
    startAnnounced: !e.startAnnounced,
    endAnnounced: !e.endAnnounced,
  };
}

// ---------------------------------------------------------------------------
// Completeness + exact ordering against the reference.
// ---------------------------------------------------------------------------

describe("evaluateClaimBlocks — complete, ordered, exact (Property 6)", () => {
  it("emits exactly the reference blocks in the fixed 19.1 order", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const blocks = evaluateClaimBlocks(input);
        // Deep equality pins both the set of blocks and their order (19.1, 19.3).
        expect(blocks).toEqual(referenceBlocks(input));
      }),
      { numRuns: 1500 },
    );
  });

  it("never short-circuits: the family order is non-decreasing", () => {
    const rank: Record<ClaimBlock["kind"], number> = {
      challenge: 0,
      critic_block: 1,
      bar_lock: 2,
      radius_lock: 3,
      pioneer: 4,
      scenic: 4,
    };
    fc.assert(
      fc.property(inputArb, (input) => {
        const kinds = evaluateClaimBlocks(input).map((b) => rank[b.kind]);
        for (let i = 1; i < kinds.length; i++) {
          expect(kinds[i]).toBeGreaterThanOrEqual(kinds[i - 1]);
        }
      }),
      { numRuns: 800 },
    );
  });

  it("is empty iff the claim is allowed (empty reference ⇔ empty result)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const blocks = evaluateClaimBlocks(input);
        expect(blocks.length === 0).toBe(referenceBlocks(input).length === 0);
      }),
      { numRuns: 800 },
    );
  });
});

// ---------------------------------------------------------------------------
// Decisions depend only on server nowMs, never on announced flags (20.3c).
// ---------------------------------------------------------------------------

describe("evaluateClaimBlocks — announced flags change no decision (Property 6)", () => {
  it("flipping every effect's announced flags yields identical blocks", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const flipped: ClaimBlockInput = {
          ...input,
          effects: input.effects.map(flipAnnounced),
        };
        expect(evaluateClaimBlocks(flipped)).toEqual(
          evaluateClaimBlocks(input),
        );
      }),
      { numRuns: 800 },
    );
  });
});

// ---------------------------------------------------------------------------
// Bonus mode never emits pioneer/scenic (10.7).
// ---------------------------------------------------------------------------

describe("evaluateClaimBlocks — bonus mode skips next-claim restrictions (Property 6)", () => {
  it("bonus mode emits no pioneer or scenic block", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const bonus: ClaimBlockInput = { ...input, mode: "bonus" };
        const blocks = evaluateClaimBlocks(bonus);
        expect(
          blocks.some((b) => b.kind === "pioneer" || b.kind === "scenic"),
        ).toBe(false);
      }),
      { numRuns: 800 },
    );
  });

  it("claim and bonus agree on the first four families (challenge, critic, crop, cancel)", () => {
    const restrictionKinds = new Set(["pioneer", "scenic"]);
    fc.assert(
      fc.property(inputArb, (input) => {
        const claimBlocks = evaluateClaimBlocks({
          ...input,
          mode: "claim",
        }).filter((b) => !restrictionKinds.has(b.kind));
        const bonusBlocks = evaluateClaimBlocks({ ...input, mode: "bonus" });
        expect(bonusBlocks).toEqual(claimBlocks);
      }),
      { numRuns: 800 },
    );
  });
});

// ---------------------------------------------------------------------------
// Crop Dusting exempts the owner, blocks everyone else (11.3).
// ---------------------------------------------------------------------------

describe("evaluateClaimBlocks — Crop Dusting owner exemption (Property 6)", () => {
  it("an active lock blocks every non-owner on its bar and never the owner", () => {
    fc.assert(
      fc.property(
        teamArb, // owner
        teamArb, // claiming team
        fc.constantFrom("bar-a", "bar-b", "bar-c"),
        (owner, claimer, barKey) => {
          const effect: EffectRecord = {
            ...baseEffect(1),
            effectId: "crop-fixed",
            slug: "crop-dusting",
            kind: "bar_lock",
            ownerTeamId: owner,
            targetBarKey: barKey,
            startsAt: iso(BASE_MS),
            endsAt: iso(BASE_MS + 15 * 60_000),
          };
          const input: ClaimBlockInput = {
            teamId: claimer,
            bar: { barKey, kind: "scoring", coords: null },
            finishCoords: COORD_FAR,
            challenges: [],
            effects: [effect],
            activeClaims: [],
            previousBar: { barKey: "start", kind: "start", coords: COORD_A },
            barCoords: new Map(),
            mode: "claim",
            nowMs: BASE_MS + 60_000, // inside the window
          };
          const hasBarLock = evaluateClaimBlocks(input).some(
            (b) => b.kind === "bar_lock",
          );
          // Owner is exempt; everyone else is blocked.
          expect(hasBarLock).toBe(claimer !== owner);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// Cancel Culture radius + uncoordinated handling (12.4).
// ---------------------------------------------------------------------------

describe("evaluateClaimBlocks — Cancel Culture radius (Property 6)", () => {
  it("blocks a bar within the radius and spares one outside it", () => {
    const effect: EffectRecord = {
      ...baseEffect(1),
      effectId: "cancel-fixed",
      slug: "cancel-culture",
      kind: "radius_lock",
      targetBarKey: "center",
      startsAt: iso(BASE_MS),
      endsAt: iso(BASE_MS + 15 * 60_000),
    };
    const barCoords = new Map<string, LatLng>([["center", COORD_A]]);
    const base: Omit<ClaimBlockInput, "bar"> = {
      teamId: "team-1",
      finishCoords: COORD_FAR,
      challenges: [],
      effects: [effect],
      activeClaims: [],
      previousBar: { barKey: "start", kind: "start", coords: COORD_A },
      barCoords,
      mode: "claim",
      nowMs: BASE_MS + 60_000,
    };

    // Within radius of the center → blocked.
    const near = evaluateClaimBlocks({
      ...base,
      bar: { barKey: "near", kind: "scoring", coords: COORD_NEAR },
    });
    expect(near.some((b) => b.kind === "radius_lock")).toBe(true);

    // Far outside the radius → not blocked.
    const far = evaluateClaimBlocks({
      ...base,
      bar: { barKey: "far", kind: "scoring", coords: COORD_FAR },
    });
    expect(far.some((b) => b.kind === "radius_lock")).toBe(false);
  });

  it("never blocks a bar with no coordinates, regardless of active locks", () => {
    fc.assert(
      fc.property(
        fc.array(cancelCultureEffectArb(0), { minLength: 1, maxLength: 5 }),
        teamArb,
        (rawEffects, claimer) => {
          const effects = rawEffects.map((e, i) => ({
            ...e,
            effectId: `cc-${i}`,
            // Force an active window around the probe time.
            startsAt: iso(BASE_MS - 60_000),
            endsAt: iso(BASE_MS + 60 * 60_000),
            cancelledAt: null,
            consumedAt: null,
            cancelReason: null,
          }));
          const input: ClaimBlockInput = {
            teamId: claimer,
            bar: { barKey: "no-coords", kind: "scoring", coords: null },
            finishCoords: COORD_FAR,
            challenges: [],
            effects,
            activeClaims: [],
            previousBar: { barKey: "start", kind: "start", coords: COORD_A },
            barCoords: new Map([
              ["bar-a", COORD_A],
              ["bar-b", COORD_NEAR],
              ["bar-c", COORD_FAR],
            ]),
            mode: "claim",
            nowMs: BASE_MS,
          };
          expect(
            evaluateClaimBlocks(input).some((b) => b.kind === "radius_lock"),
          ).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never blocks when the lock center has no resolvable coordinates", () => {
    const effect: EffectRecord = {
      ...baseEffect(1),
      effectId: "cancel-unknown",
      slug: "cancel-culture",
      kind: "radius_lock",
      targetBarKey: "unknown-center",
      startsAt: iso(BASE_MS),
      endsAt: iso(BASE_MS + 15 * 60_000),
    };
    const input: ClaimBlockInput = {
      teamId: "team-1",
      bar: { barKey: "bar-a", kind: "scoring", coords: COORD_A },
      finishCoords: COORD_FAR,
      challenges: [],
      effects: [effect],
      activeClaims: [],
      previousBar: { barKey: "start", kind: "start", coords: COORD_A },
      barCoords: new Map([["bar-a", COORD_A]]), // no "unknown-center" entry
      mode: "claim",
      nowMs: BASE_MS + 60_000,
    };
    expect(
      evaluateClaimBlocks(input).some((b) => b.kind === "radius_lock"),
    ).toBe(false);
  });
});
