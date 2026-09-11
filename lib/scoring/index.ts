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
