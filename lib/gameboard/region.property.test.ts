import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { INITIAL_REGION, selectRegion, type Region } from "./region";

/**
 * Property suite for the active-Region transition logic (design.md §Components
 * 3; R2). Covers Property 2 (transition selects the target and is idempotent on
 * the already-active Region) and Property 3 (exactly one Region is active over
 * any sequence of selections).
 *
 * The transition under test is the pure core of the Game_Board's region
 * navigation: `selectRegion(current, target)` makes `target` active (R2.2), and
 * re-selecting the already-active Region returns an equal state (R2.7). The
 * Game_Board displays exactly one of the three Regions as active at any time
 * (R2.6).
 */

/** The three navigable Regions of the Game_Board (R2.1). */
const REGIONS: readonly Region[] = ["bars", "scoreboard", "cards"];

/** A generator over the three Regions. */
const regionArb: fc.Arbitrary<Region> = fc.constantFrom(...REGIONS);

/**
 * Feature: in-game-landing-wireframe, Property 2: Region transition selects the
 * target and is idempotent on the active one.
 *
 * For any current active Region and any target Region, selecting the target
 * Region makes the target the active Region; and selecting the Region that is
 * already active returns an equal state (no change to which Region is
 * displayed) (design.md §Property 2).
 *
 * Validates: Requirements 2.2, 2.7
 */
describe("selectRegion — select target and idempotence on the active one (Property 2)", () => {
  it("makes the target the active Region for any current/target pair (R2.2)", () => {
    fc.assert(
      fc.property(regionArb, regionArb, (current, target) => {
        const next = selectRegion(current, target);

        // Selecting the target activates exactly the target (R2.2).
        expect(next).toBe(target);
        // The result is always one of the three Regions.
        expect(REGIONS).toContain(next);
      }),
      { numRuns: 100 },
    );
  });

  it("is a no-op when the target is already the active Region (R2.7)", () => {
    fc.assert(
      fc.property(regionArb, (current) => {
        // Re-selecting the active Region returns an equal state — no change to
        // which Region is displayed (R2.7).
        const next = selectRegion(current, current);
        expect(next).toBe(current);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: in-game-landing-wireframe, Property 3: Exactly one Region is active.
 *
 * For any sequence of Region selections applied to the initial Game_Board
 * state, the resulting active Region is exactly one of the three Regions —
 * never zero and never more than one (design.md §Property 3).
 *
 * The active Region is modeled as a single `Region` value: applying a sequence
 * of selections is a left fold of `selectRegion` starting from
 * `INITIAL_REGION`. Membership in the three-Region set (with no null/duplicate
 * state possible) is what "exactly one active" means for this pure model.
 *
 * Validates: Requirements 2.6
 */
describe("selectRegion — exactly one Region is active over any selection sequence (Property 3)", () => {
  it("yields exactly one of the three Regions after any sequence of selections (R2.6)", () => {
    fc.assert(
      fc.property(fc.array(regionArb, { maxLength: 50 }), (selections) => {
        // Fold the selection sequence over the initial active Region, exactly
        // as the Game_Board would drive its single active-Region state.
        const active = selections.reduce<Region>(
          (current, target) => selectRegion(current, target),
          INITIAL_REGION,
        );

        // Exactly one Region is active: the result is a member of the
        // three-Region set — never zero, never more than one (R2.6).
        expect(REGIONS).toContain(active);
        expect(REGIONS.filter((region) => region === active)).toHaveLength(1);

        // An empty sequence leaves the initial Region active (R2.3 baseline).
        if (selections.length === 0) {
          expect(active).toBe(INITIAL_REGION);
        } else {
          // A non-empty sequence ends on its last selection (R2.2).
          expect(active).toBe(selections[selections.length - 1]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
