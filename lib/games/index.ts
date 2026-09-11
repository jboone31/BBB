/**
 * Pure model of the start/finish bar designation rule for a game (Req 3.7).
 *
 * Requirement 3.7: "THE Data_Schema SHALL designate exactly one start bar and
 * exactly one finish bar per game."
 *
 * The `supabase/migrations/0001_core_game_schema.sql` migration realizes this on
 * the `games` table with:
 *  - single-valued, nullable `start_bar_id` and `finish_bar_id` columns (so a
 *    game can designate *at most one* of each, and the columns are undesignated
 *    until set — mirrored here by allowing `null`); and
 *  - the `games_start_finish_differ` CHECK constraint, whose SQL is:
 *      check (start_bar_id is null or finish_bar_id is null
 *             or start_bar_id <> finish_bar_id)
 *    i.e. the designation is rejected only when BOTH are set and equal; NULLs
 *    (undesignated) are always allowed.
 *
 * This module is a framework-free, deterministic mirror of that exact rule so it
 * can be unit-tested without a live Postgres (the DB-backed guarantee is also
 * exercised by the migrations-apply smoke check, Task 19.3). It performs no I/O.
 */

/**
 * A start/finish bar designation for a single game.
 *
 * Both fields are single-valued (there is exactly one slot for the start bar and
 * one slot for the finish bar — never a list), matching the single `start_bar_id`
 * / `finish_bar_id` columns on `games`. A `null` (or `undefined`) value means
 * that role is not yet designated.
 */
export interface BarDesignation {
  /** The designated start bar id, or `null`/`undefined` if undesignated. */
  readonly startBarId: string | null | undefined;
  /** The designated finish bar id, or `null`/`undefined` if undesignated. */
  readonly finishBarId: string | null | undefined;
}

/** Why a proposed designation was rejected. */
export type DesignationError = "finish_equals_start";

/** The outcome of validating a start/finish bar designation. */
export type DesignationResult =
  | {
      readonly ok: true;
      /** The normalized designation (undefined coerced to null). */
      readonly startBarId: string | null;
      readonly finishBarId: string | null;
    }
  | {
      readonly ok: false;
      readonly error: DesignationError;
    };

/** Normalize `undefined` to `null` so callers get a single "undesignated" value. */
function normalizeId(id: string | null | undefined): string | null {
  return id == null ? null : id;
}

/**
 * Validate a proposed start/finish bar designation for a game (Req 3.7).
 *
 * Mirrors the `games_start_finish_differ` CHECK exactly:
 *  - if either the start or finish bar is undesignated (`null`/`undefined`), the
 *    designation is accepted (partial designation is allowed); and
 *  - if both are designated, they must differ — a finish bar equal to the start
 *    bar is rejected.
 *
 * Because each of `startBarId` and `finishBarId` is a single value (not a
 * collection), a game can never designate more than one start or more than one
 * finish bar: the "exactly one start / exactly one finish" shape of Req 3.7 is
 * structural, and this function guards the remaining rule (they must differ).
 *
 * @param designation the proposed start/finish bar ids for one game.
 * @returns an `ok: true` result with the normalized ids, or an `ok: false`
 *   result carrying `"finish_equals_start"` when both are set and equal.
 */
export function validateBarDesignation(
  designation: BarDesignation,
): DesignationResult {
  const startBarId = normalizeId(designation.startBarId);
  const finishBarId = normalizeId(designation.finishBarId);

  // NULLs are always allowed (undesignated); reject only when both are set and equal.
  if (
    startBarId !== null &&
    finishBarId !== null &&
    startBarId === finishBarId
  ) {
    return { ok: false, error: "finish_equals_start" };
  }

  return { ok: true, startBarId, finishBarId };
}

/**
 * Convenience predicate mirroring the boolean sense of the
 * `games_start_finish_differ` CHECK constraint.
 *
 * True iff the designation is permitted: either side undesignated, or both
 * designated and different. False only when both are set and equal.
 */
export function isValidBarDesignation(designation: BarDesignation): boolean {
  return validateBarDesignation(designation).ok;
}
