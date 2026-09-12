/**
 * Team validation and creation decision for the Game Setup & Lobby feature
 * (design §Components 1c; Requirements 4.2, 4.3, 4.4, 4.7).
 *
 * A Player may create a new Team while a Game has fewer than `MAX_TEAMS` (4)
 * teams. A Team requires a non-empty name of at most 100 characters (trimmed)
 * and is assigned a color distinct from every other Team's color in the same
 * Game. The color palette is sized `>= MAX_TEAMS`, so a distinct color is always
 * available whenever creation is permitted (R4.4).
 *
 * This module is framework-free and performs no I/O. It reuses `MAX_TEAMS` from
 * `lib/gameend` rather than redefining the team-count bound.
 *
 * NOTE: This is the Task 1 scaffold — constants, result types, and signatures
 * per the design. The function bodies are implemented in Task 4.
 */

import { MAX_TEAMS } from "@/lib/gameend";

/** Maximum length of a trimmed team name (R4.4/R4.7). */
export const MAX_TEAM_NAME = 100;

/**
 * The palette of distinct team colors, in assignment order.
 *
 * Length is `>= MAX_TEAMS` (4) so a color distinct from all existing teams is
 * always available while a new team may still be created. Color assignment picks
 * the first palette entry not already in use.
 */
export const TEAM_COLORS: readonly string[] = [
  "#e6194b", // red
  "#3cb44b", // green
  "#4363d8", // blue
  "#f58231", // orange
];

/**
 * The outcome of validating a raw team name.
 *
 * On success, `value` is the trimmed name (1–100 chars). On failure, `reason`
 * identifies why it was rejected.
 */
export type TeamNameResult =
  { ok: true; value: string } | { ok: false; reason: "invalid_team_name" };

/**
 * R4.4/R4.7: trim leading/trailing whitespace, then require 1–100 characters.
 *
 * @param raw the raw team name as submitted.
 * @returns an `ok: true` result carrying the trimmed value, or an `ok: false`
 *   `invalid_team_name` result for empty, all-whitespace, or over-100 input.
 */
export function validateTeamName(raw: string): TeamNameResult {
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_TEAM_NAME) {
    return { ok: false, reason: "invalid_team_name" };
  }
  return { ok: true, value };
}

/**
 * The outcome of deciding whether a new Team may be created.
 *
 * On success, `color` is a palette color distinct from all existing team colors.
 * On failure, `reason` identifies why creation was rejected.
 */
export type CreateTeamResult =
  | { ok: true; color: string }
  | { ok: false; reason: "team_limit_reached" }
  | { ok: false; reason: "invalid_team_name" };

/**
 * R4.2/R4.3/R4.4: decide whether a new Team may be created and, if so, choose a
 * color distinct from every existing Team color.
 *
 * Gates creation on `existingColors.length < MAX_TEAMS` (R4.2/R4.3) and, when
 * permitted with a valid name, assigns the first {@link TEAM_COLORS} entry not
 * present in `existingColors` (R4.4). Because the palette is sized `>= MAX_TEAMS`,
 * a distinct color is always available when creation is permitted.
 *
 * @param existingColors the colors already used by teams in the same Game.
 * @param proposedName the raw proposed team name.
 * @returns an `ok: true` result carrying the assigned color, or an `ok: false`
 *   result carrying `team_limit_reached` or `invalid_team_name`.
 */
export function decideCreateTeam(
  existingColors: readonly string[],
  proposedName: string,
): CreateTeamResult {
  const name = validateTeamName(proposedName);
  if (!name.ok) {
    return { ok: false, reason: "invalid_team_name" };
  }
  if (existingColors.length >= MAX_TEAMS) {
    return { ok: false, reason: "team_limit_reached" };
  }
  const color = TEAM_COLORS.find((c) => !existingColors.includes(c))!;
  return { ok: true, color };
}
