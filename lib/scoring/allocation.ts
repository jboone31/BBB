/**
 * Target-allocation scoring for a single bar.
 *
 * Shares are modelled as a *target allocation* — the whole-number points every
 * claiming team should currently hold for one bar — rather than as signed
 * deltas. Three inputs shape that target:
 *
 *   - the base equal split of 12 among the active claimants,
 *   - a Party Crasher `phantom` team that drops everyone's share as if one more
 *     team were sharing (until four real teams claim it), and
 *   - Insurance `protectedFloors`, which guarantee a claimant at least the
 *     points it was promised when it claimed.
 *
 * The allocation is diffed against what the ledger currently holds for the bar
 * ({@link currentBarHoldings}) to produce the minimal set of signed ledger
 * adjustments ({@link reconcileBar}). Only the *share* categories participate in
 * holdings and reconciliation; the *award* categories (Happy Hour, Patient
 * Investor) are immutable and survive every share change, Voted Off removal, and
 * host override (Requirements 13.8, 16.5).
 *
 * This module is framework-free and deterministic so it can be property-tested
 * and reused by server routes. {@link computeShareAdjustments} in `./index` is a
 * thin wrapper over this module (no phantom, no floors) so the existing scoring
 * tests keep passing.
 */

import {
  FINISH_BAR_SOLO_AWARD,
  MAX_CLAIMING_TEAMS,
  NON_FINISH_BAR_TOTAL_POINTS,
  type ClaimScoringBarKind,
  type ScoreAdjustment,
} from "./index";

/**
 * Ledger categories that make up a bar's reconcilable share holdings. These are
 * the only categories {@link currentBarHoldings} sums and {@link reconcileBar}
 * ever emits.
 */
export const SHARE_CATEGORIES = [
  "bar_share",
  "bar_share_correction",
  "finish_award",
] as const;

/**
 * Immutable award categories. Reconciliation never reads or writes these, so a
 * Happy Hour bonus or Patient Investor payout survives every later share change
 * on the same bar (Requirements 13.8, 16.5).
 */
export const AWARD_CATEGORIES = [
  "happy_hour_bonus",
  "happy_hour_bonus_reversal",
  "patient_investor_award",
] as const;

type ShareCategory = (typeof SHARE_CATEGORIES)[number];
type AwardCategory = (typeof AWARD_CATEGORIES)[number];

/** Every score ledger category. */
export type LedgerCategory = ShareCategory | AwardCategory;

const SHARE_CATEGORY_SET: ReadonlySet<string> = new Set(SHARE_CATEGORIES);

/**
 * A minimal, read-only view of a persisted score ledger entry. Only the fields
 * reconciliation needs are modelled so callers can pass richer row shapes.
 */
export interface LedgerEntry {
  readonly teamId: string;
  readonly barId: string;
  readonly category: LedgerCategory;
  readonly points: number;
}

/** Inputs required to compute a bar's current target allocation. */
export interface BarAllocationInput {
  readonly barKind: ClaimScoringBarKind;
  /** Active claimant team ids for the bar (0..4), unique. */
  readonly claimantTeamIds: readonly string[];
  /** True when an active Party Crasher phantom shares this bar. */
  readonly phantom: boolean;
  /** Team -> protected points from an attached Insurance effect. */
  readonly protectedFloors: ReadonlyMap<string, number>;
}

function validateClaimants(teamIds: readonly string[]): void {
  if (teamIds.length > MAX_CLAIMING_TEAMS) {
    throw new RangeError(
      `a bar cannot have more than ${MAX_CLAIMING_TEAMS} claiming teams`,
    );
  }
  if (new Set(teamIds).size !== teamIds.length) {
    throw new RangeError("claiming team ids must be unique");
  }
}

/**
 * Compute the whole-number point target every claimant should currently hold
 * for one bar.
 *
 * - Start bar: every claimant gets 0 (claiming still triggers a draw elsewhere).
 * - Finish bar: the single claimant gets the solo award of 12.
 * - Scoring bar with `n` claimants: `base = 12 / (n + (phantom && n < 4 ? 1 : 0))`.
 *   The divisor is always a factor of 12 for `n` in 1..4, so `base` is a whole
 *   number. Once four real teams claim it the phantom no longer divides.
 * - Each claimant then receives `max(base, protectedFloors.get(team) ?? 0)` so an
 *   attached Insurance floor cannot be eroded by later claimants (Requirement
 *   15.4). Unprotected claimants receive `base`.
 *
 * @returns A map from claimant team id to its target points. Non-claiming teams
 *   are absent (they hold no share).
 */
export function computeBarAllocation(
  input: BarAllocationInput,
): ReadonlyMap<string, number> {
  const claimants = [...input.claimantTeamIds];
  validateClaimants(claimants);

  const target = new Map<string, number>();

  if (input.barKind === "start") {
    for (const teamId of claimants) {
      target.set(teamId, 0);
    }
    return target;
  }

  if (input.barKind === "finish") {
    if (claimants.length > 1) {
      throw new RangeError("a finish bar can have at most one claimant");
    }
    for (const teamId of claimants) {
      target.set(teamId, FINISH_BAR_SOLO_AWARD);
    }
    return target;
  }

  if (claimants.length === 0) {
    return target;
  }

  const n = claimants.length;
  const divisor = n + (input.phantom && n < MAX_CLAIMING_TEAMS ? 1 : 0);
  const base = NON_FINISH_BAR_TOTAL_POINTS / divisor;

  for (const teamId of claimants) {
    const floor = input.protectedFloors.get(teamId) ?? 0;
    target.set(teamId, Math.max(base, floor));
  }
  return target;
}

/**
 * Sum the *share*-category ledger entries for one bar into a team -> points map.
 * Award-category entries are ignored so they never influence reconciliation
 * (Requirements 13.8, 16.5). Teams whose share entries net to zero are omitted.
 */
export function currentBarHoldings(
  entries: readonly LedgerEntry[],
  barId: string,
): ReadonlyMap<string, number> {
  const holdings = new Map<string, number>();
  for (const entry of entries) {
    if (entry.barId !== barId) continue;
    if (!SHARE_CATEGORY_SET.has(entry.category)) continue;
    holdings.set(
      entry.teamId,
      (holdings.get(entry.teamId) ?? 0) + entry.points,
    );
  }
  for (const [teamId, points] of holdings) {
    if (points === 0) {
      holdings.delete(teamId);
    }
  }
  return holdings;
}

/**
 * Diff a bar's current share holdings against a freshly computed target
 * allocation and return the minimal signed ledger adjustments that move
 * holdings to the target.
 *
 * A team with zero prior holdings is treated as a first claim and its entry uses
 * the `bar_share` category; a team that already held share points uses
 * `bar_share_correction`. The `isInitialClaim` predicate lets callers that know
 * a team is newly claiming override the holdings-based inference (e.g. the first
 * claim of a bar whose target is zero). Only nonzero diffs are emitted, sorted
 * by team id for deterministic output.
 */
export function reconcileBar(
  holdings: ReadonlyMap<string, number>,
  target: ReadonlyMap<string, number>,
  isInitialClaim: (teamId: string) => boolean,
): ScoreAdjustment[] {
  const teamIds = [...new Set([...holdings.keys(), ...target.keys()])].sort();

  const adjustments: ScoreAdjustment[] = [];
  for (const teamId of teamIds) {
    const current = holdings.get(teamId) ?? 0;
    const desired = target.get(teamId) ?? 0;
    const points = desired - current;
    if (points === 0) continue;
    const initial = current === 0 && isInitialClaim(teamId);
    adjustments.push({
      teamId,
      points,
      category: initial ? "bar_share" : "bar_share_correction",
    });
  }
  return adjustments;
}
