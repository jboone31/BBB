/**
 * Pure scoring logic for the Beltline Bar Brawl v1 ruleset.
 *
 * Every non-finish, non-start bar is worth a fixed total of 12 points that is
 * split *equally* among all teams currently claiming that bar. As more teams
 * claim the same bar, each claimer's share drops so the total across claimers
 * stays exactly 12 (Requirement 3.13):
 *
 *   1 claiming team  -> 12 each
 *   2 claiming teams ->  6 each
 *   3 claiming teams ->  4 each
 *   4 claiming teams ->  3 each
 *
 * The finish bar is special: it awards the full 12 points to the single
 * claiming team alone (never split) and ends the game.
 *
 * This module is framework-free and deterministic so it can be property-tested
 * (see the scoring property test) and reused by server routes later.
 */

/** Total points a non-finish scoring bar is worth, split among its claimers. */
export const NON_FINISH_BAR_TOTAL_POINTS = 12;

/** The solo award granted to the single team that claims the finish bar. */
export const FINISH_BAR_SOLO_AWARD = 12;

/** The minimum and maximum number of teams that can claim a single bar. */
export const MIN_CLAIMING_TEAMS = 1;
export const MAX_CLAIMING_TEAMS = 4;

/**
 * Compute the per-team point share for a non-finish scoring bar given the
 * number of teams currently claiming it.
 *
 * The 12-point total is divided equally among the claiming teams:
 *   1 -> 12, 2 -> 6, 3 -> 4, 4 -> 3.
 *
 * The share always divides evenly for the supported range (1..4 teams), so the
 * shares across all claimers sum to exactly {@link NON_FINISH_BAR_TOTAL_POINTS}.
 *
 * @param claimingTeamCount - Number of teams currently claiming the bar. Must
 *   be an integer in the range [{@link MIN_CLAIMING_TEAMS}, {@link MAX_CLAIMING_TEAMS}].
 * @returns The whole-number point share awarded to each claiming team.
 * @throws {RangeError} If `claimingTeamCount` is not an integer in [1, 4].
 */
export function computeShares(claimingTeamCount: number): number {
  if (
    !Number.isInteger(claimingTeamCount) ||
    claimingTeamCount < MIN_CLAIMING_TEAMS ||
    claimingTeamCount > MAX_CLAIMING_TEAMS
  ) {
    throw new RangeError(
      `claimingTeamCount must be an integer in [${MIN_CLAIMING_TEAMS}, ${MAX_CLAIMING_TEAMS}], got ${claimingTeamCount}`,
    );
  }

  return NON_FINISH_BAR_TOTAL_POINTS / claimingTeamCount;
}

/** Bar categories that control the base claim scoring transition. */
export type ClaimScoringBarKind = "start" | "scoring" | "finish";

/** One immutable signed adjustment to the score ledger. */
export interface ScoreAdjustment {
  readonly teamId: string;
  readonly points: number;
  readonly category: "bar_share" | "bar_share_correction" | "finish_award";
}

/** Inputs required to recompute a bar's current base claim allocation. */
export interface ShareTransition {
  readonly barKind: ClaimScoringBarKind;
  readonly previousClaimingTeamIds: readonly string[];
  readonly nextClaimingTeamIds: readonly string[];
}

function validateClaimingTeamIds(teamIds: readonly string[]): void {
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
 * Compute the signed ledger adjustments needed to move between two active
 * claimant sets. Only nonzero changes are returned, in deterministic team-id
 * order. Start bars never award points; finish bars award one solo 12-point
 * entry and may not transition from an existing claimant set.
 */
export function computeShareAdjustments(
  transition: ShareTransition,
): ScoreAdjustment[] {
  const previous = [...transition.previousClaimingTeamIds];
  const next = [...transition.nextClaimingTeamIds];
  validateClaimingTeamIds(previous);
  validateClaimingTeamIds(next);

  if (transition.barKind === "start") {
    return [];
  }

  if (transition.barKind === "finish") {
    if (previous.length > 0 || next.length !== 1) {
      throw new RangeError(
        "a finish bar must transition from no claimers to one claimer",
      );
    }
    return [
      {
        teamId: next[0],
        points: FINISH_BAR_SOLO_AWARD,
        category: "finish_award",
      },
    ];
  }

  const previousShare =
    previous.length === 0 ? 0 : computeShares(previous.length);
  const nextShare = next.length === 0 ? 0 : computeShares(next.length);
  const teams = [...new Set([...previous, ...next])].sort();

  return teams.flatMap((teamId) => {
    const points =
      (next.includes(teamId) ? nextShare : 0) -
      (previous.includes(teamId) ? previousShare : 0);
    if (points === 0) {
      return [];
    }
    return [
      {
        teamId,
        points,
        category: previous.length === 0 ? "bar_share" : "bar_share_correction",
      },
    ];
  });
}
