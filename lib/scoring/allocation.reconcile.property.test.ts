import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  AWARD_CATEGORIES,
  SHARE_CATEGORIES,
  computeBarAllocation,
  currentBarHoldings,
  reconcileBar,
  type LedgerEntry,
} from "./allocation";
import { MAX_CLAIMING_TEAMS } from "./index";

/**
 * Feature: card-behavior, Property 17: Ledger reconciliation preserves
 * allocations and awards.
 *
 * A single scoring bar is driven through an arbitrary sequence of
 * share-changing operations — claims, ordinary unclaims, Voted Off removals,
 * Party Crasher phantom on/off, Insurance attach/release, and host effect
 * endings — interleaved with immutable award entries (Happy Hour bonus, Patient
 * Investor payout). After every share-changing step the bar is reconciled by
 * diffing {@link currentBarHoldings} against a freshly computed
 * {@link computeBarAllocation} target and appending the resulting
 * {@link reconcileBar} adjustments to an append-only ledger.
 *
 * The property asserts four invariants that hold after every step of every
 * sequence:
 *
 *   - Reconciliation only ever emits SHARE_CATEGORIES entries (16.5).
 *   - Award-category entries are never read or modified by reconciliation, so a
 *     reconcile step's output is identical whether or not award entries are
 *     present in the ledger (13.8, 16.5).
 *   - The summed share holdings per team equal the current allocation target —
 *     claims (14.2, 14.4), ordinary unclaims and Voted Off removals (14.5,
 *     15.5, 18.4, 18.7), Party Crasher (14.4, 14.6), Insurance floors (15.5),
 *     and host endings (21.5) all reconcile exactly.
 *   - Award totals are preserved across every share reconciliation and removal,
 *     including Voted Off removals (18.7) and host effect endings (21.5, 21.6).
 *
 * Validates: Requirements 13.8, 14.4, 14.5, 14.6, 15.5, 16.5, 18.4, 18.7, 21.5,
 * 21.6
 */

const BAR_ID = "bar-1";
const OTHER_BAR_ID = "bar-2";

/** The four possible real teams on a single bar. */
const TEAM_IDS = ["team-a", "team-b", "team-c", "team-d"] as const;
type TeamId = (typeof TEAM_IDS)[number];

const SHARE_CATEGORY_SET: ReadonlySet<string> = new Set(SHARE_CATEGORIES);
const AWARD_CATEGORY_SET: ReadonlySet<string> = new Set(AWARD_CATEGORIES);

/**
 * Authoritative, non-ledger model of a bar's current state. The ledger is a
 * derived projection kept in sync by reconciling after each share change.
 */
interface BarModel {
  /** Active claimant team ids, insertion-ordered. */
  readonly claimants: TeamId[];
  /** True while an active Party Crasher phantom shares the bar. */
  phantom: boolean;
  /** Team -> Insurance protected floor, present only while attached. */
  readonly protectedFloors: Map<TeamId, number>;
  /** Teams that have ever held a nonzero share entry (for initial-claim logic). */
  readonly everHeld: Set<TeamId>;
}

type Step =
  | { kind: "claim"; team: TeamId }
  | { kind: "unclaim"; team: TeamId }
  | { kind: "votedOff"; team: TeamId }
  | { kind: "phantomOn" }
  | { kind: "phantomOff" }
  | { kind: "insuranceAttach"; team: TeamId }
  | { kind: "insuranceRelease"; team: TeamId }
  | { kind: "happyHourAward"; team: TeamId }
  | { kind: "patientInvestorAward"; team: TeamId };

const teamArb = fc.constantFrom<TeamId>(...TEAM_IDS);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  teamArb.map((team) => ({ kind: "claim", team }) as Step),
  teamArb.map((team) => ({ kind: "unclaim", team }) as Step),
  teamArb.map((team) => ({ kind: "votedOff", team }) as Step),
  fc.constant({ kind: "phantomOn" } as Step),
  fc.constant({ kind: "phantomOff" } as Step),
  teamArb.map((team) => ({ kind: "insuranceAttach", team }) as Step),
  teamArb.map((team) => ({ kind: "insuranceRelease", team }) as Step),
  teamArb.map((team) => ({ kind: "happyHourAward", team }) as Step),
  teamArb.map((team) => ({ kind: "patientInvestorAward", team }) as Step),
);

/** The current share-allocation target for the modelled bar. */
function targetFor(model: BarModel): ReadonlyMap<string, number> {
  return computeBarAllocation({
    barKind: "scoring",
    claimantTeamIds: model.claimants,
    phantom: model.phantom,
    protectedFloors: model.protectedFloors,
  });
}

/** Sum the immutable award-category entries per team. */
function awardTotals(ledger: readonly LedgerEntry[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of ledger) {
    if (!AWARD_CATEGORY_SET.has(entry.category)) continue;
    totals.set(entry.teamId, (totals.get(entry.teamId) ?? 0) + entry.points);
  }
  return totals;
}

describe("reconcileBar — ledger reconciliation (Property 17)", () => {
  it("keeps share holdings on target and awards intact across any step sequence", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { minLength: 0, maxLength: 60 }),
        (steps) => {
          const model: BarModel = {
            claimants: [],
            phantom: false,
            protectedFloors: new Map<TeamId, number>(),
            everHeld: new Set<TeamId>(),
          };
          const ledger: LedgerEntry[] = [];

          // Reconcile the modelled bar after a share-changing step and append
          // the adjustments to the ledger, asserting per-step invariants.
          const reconcileAndAppend = () => {
            const target = targetFor(model);
            const holdings = currentBarHoldings(ledger, BAR_ID);

            const adjustments = reconcileBar(
              holdings,
              target,
              (teamId) =>
                // A team with no prior share holdings that is newly claiming is an
                // initial claim; otherwise it is a correction.
                !model.everHeld.has(teamId as TeamId),
            );

            // Invariant 1: reconciliation only emits SHARE_CATEGORIES entries.
            for (const adjustment of adjustments) {
              expect(SHARE_CATEGORY_SET.has(adjustment.category)).toBe(true);
            }

            // Invariant 2: award entries are invisible to reconciliation. Run
            // the same reconcile against an award-stripped ledger and confirm
            // identical output.
            const shareOnlyLedger = ledger.filter((entry) =>
              SHARE_CATEGORY_SET.has(entry.category),
            );
            const shareOnlyHoldings = currentBarHoldings(
              shareOnlyLedger,
              BAR_ID,
            );
            const shareOnlyAdjustments = reconcileBar(
              shareOnlyHoldings,
              target,
              (teamId) => !model.everHeld.has(teamId as TeamId),
            );
            expect(shareOnlyAdjustments).toEqual(adjustments);

            for (const adjustment of adjustments) {
              ledger.push({
                teamId: adjustment.teamId,
                barId: BAR_ID,
                category: adjustment.category,
                points: adjustment.points,
              });
              if (adjustment.points !== 0) {
                model.everHeld.add(adjustment.teamId as TeamId);
              }
            }
          };

          for (const step of steps) {
            switch (step.kind) {
              case "claim": {
                if (
                  model.claimants.includes(step.team) ||
                  model.claimants.length >= MAX_CLAIMING_TEAMS
                ) {
                  continue; // no re-claim, bounded by the 4-team cap
                }
                model.claimants.push(step.team);
                reconcileAndAppend();
                break;
              }
              case "unclaim":
              case "votedOff": {
                const index = model.claimants.indexOf(step.team);
                if (index === -1) continue;
                model.claimants.splice(index, 1);
                // Both ordinary unclaim and Voted Off release any attached
                // Insurance floor for the removed team (15.5).
                model.protectedFloors.delete(step.team);
                reconcileAndAppend();
                break;
              }
              case "phantomOn": {
                if (model.phantom) continue;
                model.phantom = true;
                reconcileAndAppend();
                break;
              }
              case "phantomOff": {
                // Host ending the Party Crasher effect restores the normal
                // share rule (21.5).
                if (!model.phantom) continue;
                model.phantom = false;
                reconcileAndAppend();
                break;
              }
              case "insuranceAttach": {
                // Insurance records the claimant's share at claim time as its
                // protected floor; only a current claimant can attach one.
                if (!model.claimants.includes(step.team)) continue;
                if (model.protectedFloors.has(step.team)) continue;
                const promised = targetFor(model).get(step.team) ?? 0;
                model.protectedFloors.set(step.team, promised);
                reconcileAndAppend();
                break;
              }
              case "insuranceRelease": {
                // Host ending an Insurance protected share restores the normal
                // share rule for the bar (21.5).
                if (!model.protectedFloors.has(step.team)) continue;
                model.protectedFloors.delete(step.team);
                reconcileAndAppend();
                break;
              }
              case "happyHourAward": {
                // Immutable +5 Happy Hour bonus. Not a share change, so no
                // reconcile; it must survive every later share reconciliation.
                ledger.push({
                  teamId: step.team,
                  barId: BAR_ID,
                  category: "happy_hour_bonus",
                  points: 5,
                });
                break;
              }
              case "patientInvestorAward": {
                // Immutable +6 Patient Investor payout on this bar.
                ledger.push({
                  teamId: step.team,
                  barId: BAR_ID,
                  category: "patient_investor_award",
                  points: 6,
                });
                break;
              }
            }

            // Invariant 3: after every step, the summed share holdings per team
            // equal the current allocation target.
            const holdings = currentBarHoldings(ledger, BAR_ID);
            const target = targetFor(model);
            for (const team of TEAM_IDS) {
              expect(holdings.get(team) ?? 0).toBe(target.get(team) ?? 0);
            }
            // No stray share holdings for non-targeted teams.
            for (const [team, points] of holdings) {
              expect(target.get(team) ?? 0).toBe(points);
            }
          }

          // Invariant 4: award totals equal the sum of every award step emitted
          // for the bar — no reconciliation or removal ever touched them.
          const awards = awardTotals(ledger);
          const expectedAwards = new Map<string, number>();
          for (const step of steps) {
            if (step.kind === "happyHourAward") {
              expectedAwards.set(
                step.team,
                (expectedAwards.get(step.team) ?? 0) + 5,
              );
            } else if (step.kind === "patientInvestorAward") {
              expectedAwards.set(
                step.team,
                (expectedAwards.get(step.team) ?? 0) + 6,
              );
            }
          }
          expect(awards).toEqual(expectedAwards);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("confines reconciliation to the targeted bar, never touching other bars' entries", () => {
    // A share change on BAR_ID must not read or emit entries for OTHER_BAR_ID,
    // and award entries parked on the other bar stay untouched (13.8, 16.5).
    fc.assert(
      fc.property(
        fc.uniqueArray(teamArb, {
          minLength: 1,
          maxLength: MAX_CLAIMING_TEAMS,
        }),
        (claimants) => {
          const ledger: LedgerEntry[] = [
            // Pre-existing, unrelated entries on another bar.
            {
              teamId: "team-a",
              barId: OTHER_BAR_ID,
              category: "bar_share",
              points: 12,
            },
            {
              teamId: "team-b",
              barId: OTHER_BAR_ID,
              category: "happy_hour_bonus",
              points: 5,
            },
          ];

          const target = computeBarAllocation({
            barKind: "scoring",
            claimantTeamIds: claimants,
            phantom: false,
            protectedFloors: new Map<string, number>(),
          });
          const holdings = currentBarHoldings(ledger, BAR_ID);
          // No holdings are read from the other bar.
          expect(holdings.size).toBe(0);

          const adjustments = reconcileBar(holdings, target, () => true);
          for (const adjustment of adjustments) {
            ledger.push({
              teamId: adjustment.teamId,
              barId: BAR_ID,
              category: adjustment.category,
              points: adjustment.points,
            });
          }

          // The other bar's entries are byte-for-byte unchanged.
          const otherEntries = ledger.filter(
            (entry) => entry.barId === OTHER_BAR_ID,
          );
          expect(otherEntries).toEqual([
            {
              teamId: "team-a",
              barId: OTHER_BAR_ID,
              category: "bar_share",
              points: 12,
            },
            {
              teamId: "team-b",
              barId: OTHER_BAR_ID,
              category: "happy_hour_bonus",
              points: 5,
            },
          ]);

          // The targeted bar lands on its allocation.
          const barHoldings = currentBarHoldings(ledger, BAR_ID);
          for (const team of claimants) {
            expect(barHoldings.get(team) ?? 0).toBe(target.get(team) ?? 0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
