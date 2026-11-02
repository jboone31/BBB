import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DURATIONS_MS,
  drawOverrideActive,
  effectPhase,
  isEffectActive,
  type EffectKind,
  type EffectRecord,
} from "./effects";

/**
 * Feature: card-behavior, Property 13: Effect windows follow server time.
 *
 * Every window decision in `lib/cards/effects.ts` is made against a server time
 * in milliseconds, never a device clock or an announced flag. This property
 * pins down that contract against an independent reference implementation:
 *
 * - `isEffectActive(e, t)` is true iff `startsAt <= t`, `endsAt` is null or
 *   `t < endsAt`, and neither `cancelledAt` nor `consumedAt` is at or before `t`
 *   (Requirements 11.2, 12.3, 13.2, 17.1, 20.1, 20.2).
 * - `effectPhase` returns `pending` before the start, `active` exactly while
 *   `isEffectActive`, and `ended` otherwise — fully consistent with
 *   `isEffectActive` (Requirement 20.2).
 * - `drawOverrideActive` is the union of active `draw_override` (Power Hour)
 *   windows, so overlapping plays keep the override active until the latest end
 *   (Requirements 17.1, 17.3).
 * - A host cancellation or a consumption deactivates the effect at exactly the
 *   cancel/consume time — the `>= cancelledAt`/`>= consumedAt` boundary
 *   (Requirement 21.4).
 *
 * Generators place the probe time exactly on each boundary and at `boundary ± 1
 * ms`, since the open/closed edges are where an off-by-one in the predicate
 * would hide. Overlapping Power Hour sets are generated so the union behavior is
 * exercised directly.
 *
 * Validates: Requirements 11.2, 12.3, 13.2, 17.1, 17.3, 20.1, 20.2, 21.4
 */

// ---------------------------------------------------------------------------
// Reference implementation (kept deliberately separate from effects.ts).
// ---------------------------------------------------------------------------

/**
 * Independent oracle for `isEffectActive`, written straight from the window
 * contract in milliseconds so the generated boundaries have something to agree
 * with that is not the function under test.
 */
function referenceActive(e: EffectRecord, tMs: number): boolean {
  const start = Date.parse(e.startsAt);
  if (tMs < start) {
    return false;
  }
  if (e.endsAt !== null) {
    const end = Date.parse(e.endsAt);
    if (tMs >= end) {
      return false;
    }
  }
  if (e.cancelledAt !== null && tMs >= Date.parse(e.cancelledAt)) {
    return false;
  }
  if (e.consumedAt !== null && tMs >= Date.parse(e.consumedAt)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A fixed base instant so every generated window shares a timeline. */
const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");

const iso = (ms: number): string => new Date(ms).toISOString();

const EFFECT_KINDS: readonly EffectKind[] = [
  "bar_lock",
  "radius_lock",
  "team_claim_block",
  "next_claim_restriction",
  "score_protection",
  "bonus_window",
  "phantom_share",
  "claim_counter",
  "draw_override",
];

/** An offset, in ms, somewhere inside a few hours of the base instant. */
const offsetMs: fc.Arbitrary<number> = fc.integer({
  min: -2 * 60 * 60_000,
  max: 4 * 60 * 60_000,
});

/**
 * A single effect with an arbitrary start, optional end (null = open-ended),
 * and optional cancellation / consumption stamps. Durations are nudged toward
 * the canonical ones so boundaries land on realistic windows, but the predicate
 * must hold for any ordering, so stamps are otherwise free.
 */
function effectArb(kind?: EffectKind): fc.Arbitrary<EffectRecord> {
  return fc
    .record({
      kind: kind ? fc.constant(kind) : fc.constantFrom(...EFFECT_KINDS),
      startOffset: offsetMs,
      duration: fc.option(
        fc.oneof(
          fc.constantFrom(
            DURATIONS_MS.cropDusting,
            DURATIONS_MS.happyHour,
            DURATIONS_MS.powerHour,
            DURATIONS_MS.criticBlock,
          ),
          fc.integer({ min: 1, max: 90 * 60_000 }),
        ),
        { nil: null },
      ),
      cancelOffset: fc.option(offsetMs, { nil: null }),
      consumeOffset: fc.option(offsetMs, { nil: null }),
      id: fc.integer({ min: 0, max: 1_000_000 }),
    })
    .map(
      ({
        kind: k,
        startOffset,
        duration,
        cancelOffset,
        consumeOffset,
        id,
      }): EffectRecord => {
        const startsAt = iso(BASE_MS + startOffset);
        const endsAt =
          duration === null ? null : iso(BASE_MS + startOffset + duration);
        return {
          effectId: `eff-${id}`,
          slug: "power-hour",
          kind: k,
          sourcePlayId: null,
          sourceChallengeId: null,
          ownerTeamId: null,
          targetTeamId: null,
          targetBarKey: null,
          startsAt,
          endsAt,
          params: {},
          attachedClaimId: null,
          attachedBarKey: null,
          protectedPoints: null,
          consumedAt:
            consumeOffset === null ? null : iso(BASE_MS + consumeOffset),
          cancelledAt:
            cancelOffset === null ? null : iso(BASE_MS + cancelOffset),
          cancelReason: cancelOffset === null ? null : "host",
          startAnnounced: false,
          endAnnounced: false,
        };
      },
    );
}

/** Every millisecond boundary this effect could flip on. */
function boundariesOf(e: EffectRecord): number[] {
  const bs = [Date.parse(e.startsAt)];
  if (e.endsAt !== null) {
    bs.push(Date.parse(e.endsAt));
  }
  if (e.cancelledAt !== null) {
    bs.push(Date.parse(e.cancelledAt));
  }
  if (e.consumedAt !== null) {
    bs.push(Date.parse(e.consumedAt));
  }
  return bs;
}

/**
 * A probe time drawn from the set {boundary, boundary ± 1 ms} across all of an
 * effect's boundaries, plus a couple of far-field points. This is where an
 * off-by-one between `<`, `<=`, `>`, and `>=` would surface.
 */
function probeTimeArb(e: EffectRecord): fc.Arbitrary<number> {
  const bs = boundariesOf(e);
  const edges = bs.flatMap((b) => [b - 1, b, b + 1]);
  // Far-field anchors so "well before" and "well after" are always covered.
  edges.push(BASE_MS - 10 * 60 * 60_000, BASE_MS + 10 * 60 * 60_000);
  return fc.constantFrom(...edges);
}

// ---------------------------------------------------------------------------
// isEffectActive — window contract at the boundaries.
// ---------------------------------------------------------------------------

describe("isEffectActive — server-time window at the boundaries (Property 13)", () => {
  it("matches the reference window predicate at boundary ± 1 ms", () => {
    fc.assert(
      fc.property(
        effectArb().chain((e) => probeTimeArb(e).map((t) => ({ e, t }))),
        ({ e, t }) => {
          expect(isEffectActive(e, t)).toBe(referenceActive(e, t));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is active exactly at the start and inactive 1 ms before it", () => {
    fc.assert(
      fc.property(effectArb(), (e) => {
        const start = Date.parse(e.startsAt);
        // 1 ms before the start is always pending, regardless of later stamps.
        expect(isEffectActive(e, start - 1)).toBe(false);
        // At the start the effect is active iff nothing stops it at/before start.
        expect(isEffectActive(e, start)).toBe(referenceActive(e, start));
      }),
      { numRuns: 500 },
    );
  });

  it("closes the end boundary: inactive at endsAt, active 1 ms before (absent earlier stops)", () => {
    fc.assert(
      fc.property(
        effectArb().filter((e) => e.endsAt !== null),
        (e) => {
          const end = Date.parse(e.endsAt as string);
          // endsAt is exclusive: never active at the end instant.
          expect(isEffectActive(e, end)).toBe(false);
          // 1 ms before the end is active iff the window has already opened and
          // no cancel/consume lands at or before that instant.
          expect(isEffectActive(e, end - 1)).toBe(referenceActive(e, end - 1));
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Host / consume cancellation deactivates at the cancel/consume instant.
// ---------------------------------------------------------------------------

describe("cancellation and consumption close the window at their instant (Property 13)", () => {
  it("a host cancellation inside an open window deactivates at exactly cancelledAt", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 * 60_000 }), // start..cancel gap (>= 1 so a live moment exists before the cancel)
        fc.integer({ min: 1, max: 60 * 60_000 }), // cancel..end gap (cancel strictly before end)
        (startToCancel, cancelToEnd) => {
          const start = BASE_MS;
          const cancel = start + startToCancel;
          const end = cancel + cancelToEnd;
          const e: EffectRecord = {
            ...baseEffect("draw_override"),
            startsAt: iso(start),
            endsAt: iso(end),
            cancelledAt: iso(cancel),
            cancelReason: "host",
          };
          // Active just before the cancel (it opened and nothing else stops it).
          expect(isEffectActive(e, cancel - 1)).toBe(true);
          // Cancel instant is inclusive-closed: no longer active.
          expect(isEffectActive(e, cancel)).toBe(false);
          // Stays inactive through the would-be natural end.
          expect(isEffectActive(e, end - 1)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a consumption deactivates at exactly consumedAt", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 * 60_000 }),
        (startToConsume) => {
          const start = BASE_MS;
          const consume = start + startToConsume;
          const e: EffectRecord = {
            ...baseEffect("score_protection"),
            startsAt: iso(start),
            endsAt: null, // open-ended until consumed
            consumedAt: iso(consume),
          };
          expect(isEffectActive(e, consume - 1)).toBe(true);
          expect(isEffectActive(e, consume)).toBe(false);
          expect(isEffectActive(e, consume + 1)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("the earliest stop wins when cancel and consume both land", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 * 60_000 }),
        fc.integer({ min: 1, max: 30 * 60_000 }),
        (toCancel, toConsume) => {
          const start = BASE_MS;
          const cancel = start + toCancel;
          const consume = start + toConsume;
          const stop = Math.min(cancel, consume);
          const e: EffectRecord = {
            ...baseEffect("phantom_share"),
            startsAt: iso(start),
            endsAt: null,
            cancelledAt: iso(cancel),
            cancelReason: "host",
            consumedAt: iso(consume),
          };
          expect(isEffectActive(e, stop - 1)).toBe(true);
          expect(isEffectActive(e, stop)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// effectPhase — consistency with isEffectActive.
// ---------------------------------------------------------------------------

describe("effectPhase — pending/active/ended consistent with isEffectActive (Property 13)", () => {
  it("returns active iff isEffectActive, pending only before the start", () => {
    fc.assert(
      fc.property(
        effectArb().chain((e) => probeTimeArb(e).map((t) => ({ e, t }))),
        ({ e, t }) => {
          const phase = effectPhase(e, t);
          const active = isEffectActive(e, t);
          const start = Date.parse(e.startsAt);

          if (active) {
            expect(phase).toBe("active");
          } else if (t < start) {
            expect(phase).toBe("pending");
          } else {
            expect(phase).toBe("ended");
          }

          // The three phases partition: active is exactly the active window.
          expect(phase === "active").toBe(active);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is monotonic across a window: pending then active then ended as t advances", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 * 60_000 }),
        fc.integer({ min: 1, max: 60 * 60_000 }),
        (preGap, duration) => {
          const start = BASE_MS + preGap;
          const end = start + duration;
          const e: EffectRecord = {
            ...baseEffect("bonus_window"),
            startsAt: iso(start),
            endsAt: iso(end),
          };
          expect(effectPhase(e, start - 1)).toBe("pending");
          expect(effectPhase(e, start)).toBe("active");
          expect(effectPhase(e, end - 1)).toBe("active");
          expect(effectPhase(e, end)).toBe("ended");
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// drawOverrideActive — union of active Power Hour windows.
// ---------------------------------------------------------------------------

describe("drawOverrideActive — union of active Power Hour windows (Property 13)", () => {
  it("is true iff at least one draw_override window is active at t", () => {
    fc.assert(
      fc.property(
        fc.array(effectArb(), { minLength: 0, maxLength: 6 }),
        offsetMs,
        (effects, probeOffset) => {
          const t = BASE_MS + probeOffset;
          const expected = effects.some(
            (e) => e.kind === "draw_override" && referenceActive(e, t),
          );
          expect(drawOverrideActive(effects, t)).toBe(expected);
        },
      ),
      { numRuns: 600 },
    );
  });

  it("ignores active windows of any non-Power-Hour kind", () => {
    fc.assert(
      fc.property(
        fc.array(
          effectArb().filter((e) => e.kind !== "draw_override"),
          { minLength: 1, maxLength: 6 },
        ),
        offsetMs,
        (effects, probeOffset) => {
          const t = BASE_MS + probeOffset;
          // No draw_override effects present, so the override is never active.
          expect(drawOverrideActive(effects, t)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("stays active across overlapping Power Hour sets until the latest end", () => {
    fc.assert(
      fc.property(
        // A set of overlapping Power Hour windows. Each starts within the prior
        // one's span so the union is a single contiguous interval [minStart,
        // maxEnd); we assert the override holds throughout and flips off exactly
        // at the latest end.
        fc
          .array(
            fc.record({
              startOffset: fc.integer({ min: 0, max: 15 * 60_000 }),
              id: fc.integer({ min: 0, max: 1_000_000 }),
            }),
            { minLength: 2, maxLength: 5 },
          )
          .map((specs) => {
            // Chain the starts so every window overlaps the running union: each
            // start is before the current max end, keeping the union contiguous.
            let unionEnd = BASE_MS;
            const windows = specs.map((s, i) => {
              const start =
                i === 0
                  ? BASE_MS
                  : Math.min(unionEnd - 1, BASE_MS + s.startOffset);
              const end = start + DURATIONS_MS.powerHour;
              unionEnd = Math.max(unionEnd, end);
              return {
                ...baseEffect("draw_override"),
                effectId: `ph-${i}-${s.id}`,
                startsAt: iso(start),
                endsAt: iso(end),
              } satisfies EffectRecord;
            });
            return windows;
          }),
        (windows) => {
          const starts = windows.map((w) => Date.parse(w.startsAt));
          const ends = windows.map((w) => Date.parse(w.endsAt as string));
          const minStart = Math.min(...starts);
          const maxEnd = Math.max(...ends);

          // Before any window opens: inactive.
          expect(drawOverrideActive(windows, minStart - 1)).toBe(false);
          // Throughout the contiguous union: active, even where individual
          // windows have already ended but a later one covers the gap.
          expect(drawOverrideActive(windows, minStart)).toBe(true);
          expect(drawOverrideActive(windows, maxEnd - 1)).toBe(true);
          // At the latest end the union closes.
          expect(drawOverrideActive(windows, maxEnd)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a later Power Hour extends the override past an earlier one's end", () => {
    // Two windows: the second starts before the first ends, so the union must
    // remain active in the gap between the first end and the second end.
    const start1 = BASE_MS;
    const end1 = start1 + DURATIONS_MS.powerHour;
    const start2 = start1 + 5 * 60_000; // overlaps the first
    const end2 = start2 + DURATIONS_MS.powerHour;

    const windows: EffectRecord[] = [
      {
        ...baseEffect("draw_override"),
        effectId: "ph-a",
        startsAt: iso(start1),
        endsAt: iso(end1),
      },
      {
        ...baseEffect("draw_override"),
        effectId: "ph-b",
        startsAt: iso(start2),
        endsAt: iso(end2),
      },
    ];

    // In the window after the first ends but before the second ends: still on.
    expect(drawOverrideActive(windows, end1)).toBe(true);
    expect(drawOverrideActive(windows, end2 - 1)).toBe(true);
    // Off exactly at the latest end.
    expect(drawOverrideActive(windows, end2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A minimal, fully-defaulted effect of the given kind for direct assertions. */
function baseEffect(kind: EffectKind): EffectRecord {
  return {
    effectId: "eff-base",
    slug: "power-hour",
    kind,
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
  };
}
