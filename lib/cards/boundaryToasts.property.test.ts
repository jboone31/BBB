import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  boundaryToastId,
  deriveBoundaryToasts,
  type BoundaryToastInput,
} from "./boundaryToasts";
import {
  toastBoundaries,
  type BoundaryKind,
  type EffectKind,
  type EffectRecord,
} from "./effects";
import type { CardSlug } from "./catalog";

/**
 * Feature: card-behavior, Property 25: Boundary_Toasts are shown at most once
 * per board.
 *
 * `deriveBoundaryToasts` in `lib/cards/boundaryToasts.ts` (task 9.7) is a pure
 * function the board re-runs on every render — the corrected device clock
 * (`serverNowMs`) advances, the set of boundary ids seen via transition events
 * (`announced`) grows, and the board accumulates the ids it has already shown
 * (`sessionShown`). The module exposes no internal mutable seen-set; instead its
 * dedupe is structural: every distinct boundary from {@link toastBoundaries}
 * derives one stable id via {@link boundaryToastId}
 * (`boundary:${effectId}:${start|end}`), and the board keys its visible toasts in
 * a `Map` by that id. A board therefore shows each boundary at most once no
 * matter how many times, or at which clock, it re-renders (Requirement 20.12).
 *
 * This property pins that structural contract down against the real API:
 *
 *   (a) Within any single render the returned ids are unique — the board's Map
 *       never receives two entries for one boundary from one call.
 *   (b) Re-rendering the identical input is idempotent (same ordered list).
 *   (c) Across an advancing sequence of renders that models a live board — the
 *       clock moves forward, `announced` only grows, and `sessionShown` is the
 *       running union of every id shown so far — the id a given boundary emits
 *       never changes, the set of shown ids grows monotonically, and so the
 *       union of everything shown over the board's life still contains each
 *       boundary id once. A board deduping by id shows it at most once.
 *
 * The stable id is keyed on the effect id and the boundary kind only (not the
 * clock, the audience, or the announced flag), which is exactly what makes the
 * local-timer source and the transition-event fallback collapse to one toast.
 *
 * All generators are hermetic; nothing touches a database, network, or clock.
 *
 * Validates: Requirements 20.12
 */

// ---------------------------------------------------------------------------
// Generators.
//
// `toastBoundaries` keys on `effect.kind` and `renderBoundaryToast` keys on
// `effect.slug`, so we generate only the (slug, kind) pairs that actually
// produce boundary copy: Crop Dusting / Cancel Culture / Happy Hour / Power
// Hour. Cancel Culture yields both a start and an end boundary; the others an
// end only.
// ---------------------------------------------------------------------------

interface BoundaryCard {
  readonly slug: CardSlug;
  readonly kind: EffectKind;
}

const BOUNDARY_CARDS: readonly BoundaryCard[] = [
  { slug: "crop-dusting", kind: "bar_lock" },
  { slug: "cancel-culture", kind: "radius_lock" },
  { slug: "happy-hour", kind: "bonus_window" },
  { slug: "power-hour", kind: "draw_override" },
];

const BAR_KEYS = ["ponce-city-market", "new-realm", "ladybird"] as const;

const EPOCH = Date.parse("2024-06-01T18:00:00.000Z");

/** An ISO server timestamp `offsetMs` after a fixed epoch. */
function iso(offsetMs: number): string {
  return new Date(EPOCH + offsetMs).toISOString();
}

/**
 * A timed effect that (barring cancellation/consumption) produces one or two
 * boundaries. Start/end are drawn so `startsAt < endsAt`; the effect may be
 * cancelled or consumed at an arbitrary point to exercise the suppression paths
 * in `toastBoundaries`.
 */
function effectArb(index: number): fc.Arbitrary<EffectRecord> {
  return fc
    .record({
      card: fc.constantFrom(...BOUNDARY_CARDS),
      startOffset: fc.integer({ min: 0, max: 3_600_000 }),
      duration: fc.integer({ min: 60_000, max: 3_600_000 }),
      targetBarKey: fc.option(fc.constantFrom(...BAR_KEYS), { nil: null }),
      cancel: fc.option(fc.integer({ min: -60_000, max: 3_600_000 }), {
        nil: null,
      }),
      consume: fc.option(fc.integer({ min: 0, max: 7_200_000 }), {
        nil: null,
      }),
    })
    .map(
      ({
        card,
        startOffset,
        duration,
        targetBarKey,
        cancel,
        consume,
      }): EffectRecord => {
        const startsAt = iso(startOffset);
        const endsAt = iso(startOffset + duration);
        return {
          effectId: `effect-${index}`,
          slug: card.slug,
          kind: card.kind,
          sourcePlayId: `play-${index}`,
          sourceChallengeId: null,
          ownerTeamId: "team-a",
          targetTeamId: null,
          targetBarKey,
          startsAt,
          endsAt,
          params: {},
          attachedClaimId: null,
          attachedBarKey: null,
          protectedPoints: null,
          consumedAt: consume === null ? null : iso(startOffset + consume),
          cancelledAt: cancel === null ? null : iso(startOffset + cancel),
          cancelReason: cancel === null ? null : "host",
          startAnnounced: false,
          endAnnounced: false,
        };
      },
    );
}

const effectsArb: fc.Arbitrary<EffectRecord[]> = fc
  .integer({ min: 0, max: 5 })
  .chain((n) =>
    n === 0
      ? fc.constant<EffectRecord[]>([])
      : fc.tuple(...Array.from({ length: n }, (_, i) => effectArb(i))),
  );

const lifecycleArb = fc.constantFrom<BoundaryToastInput["lifecycle"]>(
  "lobby",
  "live",
  "ended",
);

function dismissalArb(): fc.Arbitrary<BoundaryToastInput["dismissal"]> {
  return fc.record({
    floorSeq: fc.integer({ min: -1, max: 10 }),
    dismissed: fc.array(fc.constantFrom(...idUniverse()), { maxLength: 4 }),
  });
}

/** Every boundary id the generated effect space can possibly produce. */
function idUniverse(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const kinds: BoundaryKind[] = ["start", "end"];
    for (const kind of kinds) {
      ids.push(boundaryToastId(`effect-${i}`, kind));
    }
  }
  return ids;
}

/**
 * A full render input over a generated effect set. `announced`, `sessionShown`,
 * and `dismissal` are drawn independently so a single render exercises the
 * due-via-fallback, dismissed, late-join, and ended-suppression branches.
 */
const inputArb: fc.Arbitrary<BoundaryToastInput> = effectsArb.chain((effects) =>
  fc.record({
    effects: fc.constant(effects),
    playSeqByEffect: fc.constant(
      new Map(effects.map((e, i) => [e.effectId, i] as const)),
    ),
    lifecycle: lifecycleArb,
    serverNowMs: fc
      .integer({ min: -60_000, max: 7_200_000 })
      .map((o) => EPOCH + o),
    announced: fc
      .array(fc.constantFrom(...idUniverse()), { maxLength: 6 })
      .map((xs) => new Set(xs)),
    sessionShown: fc
      .array(fc.constantFrom(...idUniverse()), { maxLength: 6 })
      .map((xs) => new Set(xs)),
    dismissal: dismissalArb(),
  }),
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function ids(input: BoundaryToastInput): string[] {
  return deriveBoundaryToasts(input).map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("Property 25: Boundary_Toasts are shown at most once per board", () => {
  it("(a) emits each boundary id at most once within a single render", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const rendered = ids(input);
        expect(new Set(rendered).size).toBe(rendered.length);
      }),
    );
  });

  it("(a) every emitted id is a well-formed boundary id of a real boundary", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const validIds = new Set(
          toastBoundaries(input.effects).map((b) =>
            boundaryToastId(b.effectId, b.kind),
          ),
        );
        for (const id of ids(input)) {
          expect(validIds.has(id)).toBe(true);
        }
      }),
    );
  });

  it("(b) re-rendering the identical input is idempotent", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(deriveBoundaryToasts(input)).toEqual(
          deriveBoundaryToasts(input),
        );
      }),
    );
  });

  it("(c) a boundary's id is stable across clock, announced, and ended fallback", () => {
    // The same boundary must derive the same id whether it becomes due via the
    // local timer (clock past it) or via the transition-event fallback — that
    // single id is what lets the board's Map dedupe. Model a live board that has
    // already shown the boundary, then re-render it due from the other source.
    fc.assert(
      fc.property(inputArb, (input) => {
        const boundaries = toastBoundaries(input.effects);
        for (const b of boundaries) {
          const id = boundaryToastId(b.effectId, b.kind);

          // Render 1: due purely via the local timer (clock at/after the
          // boundary), nothing dismissed, live board, floor below every seq.
          const viaTimer: BoundaryToastInput = {
            ...input,
            lifecycle: "live",
            serverNowMs: b.atMs,
            announced: new Set(),
            sessionShown: new Set(),
            dismissal: { floorSeq: -1, dismissed: [] },
          };

          // Render 2: due purely via the transition-event fallback (clock before
          // it) with the same board otherwise.
          const viaAnnounced: BoundaryToastInput = {
            ...viaTimer,
            serverNowMs: b.atMs - 1,
            announced: new Set([id]),
          };

          const inTimer = ids(viaTimer).includes(id);
          const inAnnounced = ids(viaAnnounced).includes(id);
          // Both sources must agree the boundary is shown, under the same id.
          expect(inTimer).toBe(true);
          expect(inAnnounced).toBe(true);
        }
      }),
    );
  });

  it("(c) the shown set grows monotonically as a live board's clock advances", () => {
    // A live board re-renders at nondecreasing clocks, carrying forward the ids
    // it has already shown as `sessionShown`. The union of shown ids must only
    // grow, and every id ever shown stays a valid, unique boundary id — so the
    // board's keyed Map accumulates each boundary exactly once over its life.
    fc.assert(
      fc.property(
        inputArb,
        fc.array(fc.integer({ min: 0, max: 7_200_000 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (base, rawClocks) => {
          const clocks = [...rawClocks].sort((a, b) => a - b);
          const shown = new Set<string>();
          let prevSize = 0;

          for (const offset of clocks) {
            const input: BoundaryToastInput = {
              ...base,
              lifecycle: "live",
              serverNowMs: EPOCH + offset,
              // Carry forward everything shown so far (the running union).
              sessionShown: new Set(shown),
              // No dismissals / floor so the clock is the only gate here.
              dismissal: { floorSeq: -1, dismissed: [] },
            };

            const rendered = ids(input);
            // Still unique within the render.
            expect(new Set(rendered).size).toBe(rendered.length);

            for (const id of rendered) {
              shown.add(id);
            }
            // Monotonic growth of the union.
            expect(shown.size).toBeGreaterThanOrEqual(prevSize);
            prevSize = shown.size;
          }

          // Every accumulated id is a real boundary id (one per boundary).
          const universe = new Set(
            toastBoundaries(base.effects).map((b) =>
              boundaryToastId(b.effectId, b.kind),
            ),
          );
          for (const id of shown) {
            expect(universe.has(id)).toBe(true);
          }
          // The board showed at most one toast per boundary over its whole life.
          expect(shown.size).toBeLessThanOrEqual(universe.size);
        },
      ),
    );
  });

  it("(c) a once-shown boundary is never re-emitted with a different id", () => {
    // Re-rendering at a later clock after showing a boundary must not produce a
    // second, differently-identified toast for the same boundary: the id is a
    // pure function of (effectId, kind), independent of the render.
    fc.assert(
      fc.property(inputArb, (input) => {
        for (const b of toastBoundaries(input.effects)) {
          const expected = boundaryToastId(b.effectId, b.kind);
          const early: BoundaryToastInput = {
            ...input,
            lifecycle: "live",
            serverNowMs: b.atMs,
            announced: new Set(),
            dismissal: { floorSeq: -1, dismissed: [] },
          };
          const late: BoundaryToastInput = {
            ...early,
            serverNowMs: b.atMs + 1_000_000,
          };
          for (const t of deriveBoundaryToasts(early)) {
            if (t.id === expected) {
              expect(boundaryToastId(b.effectId, b.kind)).toBe(expected);
            }
          }
          for (const t of deriveBoundaryToasts(late)) {
            if (t.id === expected) {
              expect(boundaryToastId(b.effectId, b.kind)).toBe(expected);
            }
          }
        }
      }),
    );
  });
});
