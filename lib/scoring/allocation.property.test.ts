import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  computeBarAllocation,
  SHARE_CATEGORIES,
  currentBarHoldings,
  reconcileBar,
  type LedgerEntry,
} from "./allocation";
import {
  FINISH_BAR_SOLO_AWARD,
  MAX_CLAIMING_TEAMS,
  NON_FINISH_BAR_TOTAL_POINTS,
} from "./index";

/**
 * Feature: card-behavior, Property 16: Share allocation rule
 *
 * For any scoring bar with 1-4 claimants, a Party Crasher phantom flag, and
 * Insurance protection floors:
 *
 *   - Each unprotected claimant receives `12 / (n + 1)` when the phantom is
 *     present and `n < 4`, and `12 / n` otherwise. The result is always an
 *     integer.
 *   - Each protected claimant receives `max(base, floor)`.
 *
 * Start bars allocate 0 to every claimant. The finish bar allocates the solo 12
 * to its single claimant.
 *
 * Validates: Requirements 14.2, 14.3, 15.3, 15.4
 */

/** Distinct team-id generator so a claimant set never has duplicates. */
const teamId = fc.integer({ min: 0, max: 999 }).map((n) => `team-${n}`);

/** A unique, size-bounded claimant set of 1..4 teams. */
const claimantSet = fc
  .uniqueArray(teamId, { minLength: 1, maxLength: MAX_CLAIMING_TEAMS })
  .map((ids) => ids);

/** The exact base share the ruleset mandates for a given effective divisor. */
const EXPECTED_BASE: Record<number, number> = {
  1: 12,
  2: 6,
  3: 4,
  4: 3,
};

describe("computeBarAllocation — Share allocation rule (Property 16)", () => {
  it("splits 12 equally among n claimants with the phantom/floor rule", () => {
    fc.assert(
      fc.property(
        claimantSet,
        fc.boolean(),
        // A random integer floor per possible claimant index, used to build a
        // protectedFloors map over a subset of the claimants.
        fc.array(fc.integer({ min: 0, max: 15 }), {
          minLength: 0,
          maxLength: MAX_CLAIMING_TEAMS,
        }),
        (claimants, phantom, floorValues) => {
          const n = claimants.length;

          // Attach floors to the first `floorValues.length` claimants.
          const protectedFloors = new Map<string, number>();
          floorValues.slice(0, n).forEach((value, index) => {
            protectedFloors.set(claimants[index], value);
          });

          const allocation = computeBarAllocation({
            barKind: "scoring",
            claimantTeamIds: claimants,
            phantom,
            protectedFloors,
          });

          const divisor = phantom && n < MAX_CLAIMING_TEAMS ? n + 1 : n;
          const base = NON_FINISH_BAR_TOTAL_POINTS / divisor;

          // Base is the exact table value and always a whole number.
          expect(base).toBe(EXPECTED_BASE[divisor]);
          expect(Number.isInteger(base)).toBe(true);

          // Every claimant is present and gets max(base, floor); no extras.
          expect(allocation.size).toBe(n);
          for (const team of claimants) {
            const floor = protectedFloors.get(team) ?? 0;
            expect(allocation.get(team)).toBe(Math.max(base, floor));
          }

          // Unprotected claimants (floor 0 or absent) get exactly the base.
          for (const team of claimants) {
            const floor = protectedFloors.get(team) ?? 0;
            if (floor <= base) {
              expect(allocation.get(team)).toBe(base);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("drops each share as if one extra team shares while the phantom is active and n < 4", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(teamId, {
          minLength: 1,
          maxLength: MAX_CLAIMING_TEAMS - 1,
        }),
        (claimants) => {
          const noFloors = new Map<string, number>();
          const withPhantom = computeBarAllocation({
            barKind: "scoring",
            claimantTeamIds: claimants,
            phantom: true,
            protectedFloors: noFloors,
          });
          const withoutPhantom = computeBarAllocation({
            barKind: "scoring",
            claimantTeamIds: claimants,
            phantom: false,
            protectedFloors: noFloors,
          });

          const n = claimants.length;
          // A phantom with n<4 real teams reduces each share to the n+1 split.
          const phantomBase = NON_FINISH_BAR_TOTAL_POINTS / (n + 1);
          const plainBase = NON_FINISH_BAR_TOTAL_POINTS / n;
          for (const team of claimants) {
            expect(withPhantom.get(team)).toBe(phantomBase);
            expect(withoutPhantom.get(team)).toBe(plainBase);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("ignores the phantom once four real teams claim the bar", () => {
    const claimants = ["a", "b", "c", "d"];
    const noFloors = new Map<string, number>();
    const withPhantom = computeBarAllocation({
      barKind: "scoring",
      claimantTeamIds: claimants,
      phantom: true,
      protectedFloors: noFloors,
    });
    // With four real teams the phantom disappears: each team scores the normal 3.
    for (const team of claimants) {
      expect(withPhantom.get(team)).toBe(3);
    }
  });

  it("floors protected claimants at their promised points via max(base, floor)", () => {
    fc.assert(
      fc.property(
        claimantSet,
        fc.boolean(),
        fc.integer({ min: 0, max: 20 }),
        (claimants, phantom, floor) => {
          const protectedTeam = claimants[0];
          const protectedFloors = new Map<string, number>([
            [protectedTeam, floor],
          ]);

          const allocation = computeBarAllocation({
            barKind: "scoring",
            claimantTeamIds: claimants,
            phantom,
            protectedFloors,
          });

          const n = claimants.length;
          const divisor = phantom && n < MAX_CLAIMING_TEAMS ? n + 1 : n;
          const base = NON_FINISH_BAR_TOTAL_POINTS / divisor;

          // The protected team never drops below its floor.
          expect(allocation.get(protectedTeam)).toBe(Math.max(base, floor));
          expect(allocation.get(protectedTeam)).toBeGreaterThanOrEqual(floor);

          // Other claimants are unaffected by the one team's floor.
          for (const team of claimants.slice(1)) {
            expect(allocation.get(team)).toBe(base);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("allocates 0 to every claimant of a start bar", () => {
    fc.assert(
      fc.property(claimantSet, fc.boolean(), (claimants, phantom) => {
        const allocation = computeBarAllocation({
          barKind: "start",
          claimantTeamIds: claimants,
          phantom,
          protectedFloors: new Map<string, number>(),
        });
        expect(allocation.size).toBe(claimants.length);
        for (const team of claimants) {
          expect(allocation.get(team)).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("allocates the solo 12 to the single finish-bar claimant", () => {
    fc.assert(
      fc.property(teamId, fc.boolean(), (team, phantom) => {
        const allocation = computeBarAllocation({
          barKind: "finish",
          claimantTeamIds: [team],
          phantom,
          protectedFloors: new Map<string, number>(),
        });
        expect(allocation.size).toBe(1);
        expect(allocation.get(team)).toBe(FINISH_BAR_SOLO_AWARD);
      }),
      { numRuns: 50 },
    );
  });

  it("round-trips an allocation through the share ledger via reconcileBar", () => {
    // Reconciling an empty bar to its target produces ledger entries whose
    // share-category sum reproduces the allocation exactly — a sanity check that
    // the allocation is a faithful whole-number target.
    fc.assert(
      fc.property(claimantSet, fc.boolean(), (claimants, phantom) => {
        const target = computeBarAllocation({
          barKind: "scoring",
          claimantTeamIds: claimants,
          phantom,
          protectedFloors: new Map<string, number>(),
        });

        const barId = "bar-1";
        const emptyHoldings = currentBarHoldings([], barId);
        const adjustments = reconcileBar(emptyHoldings, target, () => true);

        // Replay the adjustments as ledger entries and re-sum the holdings.
        const entries: LedgerEntry[] = adjustments.map((adjustment) => ({
          teamId: adjustment.teamId,
          barId,
          category: adjustment.category,
          points: adjustment.points,
        }));
        // Every emitted category is a share category.
        for (const entry of entries) {
          expect(SHARE_CATEGORIES).toContain(entry.category);
        }

        const holdings = currentBarHoldings(entries, barId);
        for (const team of claimants) {
          const desired = target.get(team) ?? 0;
          // A zero target yields no holdings entry; otherwise they must match.
          expect(holdings.get(team) ?? 0).toBe(desired);
        }
      }),
      { numRuns: 100 },
    );
  });
});
