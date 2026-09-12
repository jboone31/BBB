/**
 * Display-name validation for the Game Setup & Lobby feature
 * (design §Components 1b; Requirements 3.5, 3.6).
 *
 * When a Player joins a Game they supply a display name. After trimming leading
 * and trailing whitespace it must contain 1–40 characters; otherwise the join is
 * rejected with an `invalid_display_name` result and no Player is created.
 *
 * This module is framework-free and performs no I/O.
 *
 * NOTE: This is the Task 1 scaffold — constants, result type, and signature per
 * the design. The function body is implemented in Task 3.
 */

/** Minimum length of a trimmed display name (R3.5). */
export const MIN_DISPLAY_NAME = 1;

/** Maximum length of a trimmed display name (R3.5). */
export const MAX_DISPLAY_NAME = 40;

/**
 * The outcome of validating a raw display name.
 *
 * On success, `value` is the trimmed name (1–40 chars). On failure, `reason`
 * identifies why it was rejected.
 */
export type DisplayNameResult =
  { ok: true; value: string } | { ok: false; reason: "invalid_display_name" };

/**
 * R3.5/R3.6: trim leading/trailing whitespace, then require 1–40 characters.
 *
 * @param raw the raw display name as submitted.
 * @returns an `ok: true` result carrying the trimmed value, or an `ok: false`
 *   `invalid_display_name` result for empty, all-whitespace, or over-40 input.
 */
export function validateDisplayName(raw: string): DisplayNameResult {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_DISPLAY_NAME || trimmed.length > MAX_DISPLAY_NAME) {
    return { ok: false, reason: "invalid_display_name" };
  }
  return { ok: true, value: trimmed };
}
