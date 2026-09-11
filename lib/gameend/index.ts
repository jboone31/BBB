/**
 * Pure game-end logic for the BBB web-app foundation.
 *
 * These are framework-free, deterministic functions that model the game-end
 * rules from Requirement 5 (design.md, Component 4 "Scoring and game-end logic"
 * and the "Game-end behavior" section). They intentionally do NOT touch the
 * database or perform the transition themselves — a server route (task 10.2)
 * and the scheduled sweep (task 10.3) apply these predicates inside an atomic
 * state-change-plus-event write. Keeping the rules pure lets them be
 * property-tested (tasks 4.2, 4.3) against real transition logic.
 *
 * This module is designed to be extended: task 5.1 will add a start-eligibility
 * guard (2–4 teams) here, so the file is organized around small, independent
 * pure predicates rather than one monolithic function.
 */

/**
 * A game's lifecycle state (Req 3.2 / 5.x).
 *
 * - `lobby`  — created but not yet started; cannot be ended.
 * - `live`   — in progress; the only state from which an end transition is allowed.
 * - `ended`  — terminal; re-ending is rejected and `end_reason` is immutable.
 */
export type GameLifecycle = "lobby" | "live" | "ended";

/**
 * The reason an ended game ended (Req 3.4 / 5.1 / 5.2).
 *
 * - `finish_bar_claimed` — a team claimed the finish bar (a later feature, but it
 *   shares this enum on `games`).
 * - `admin_ended`        — the admin ended a live game (Req 5.1).
 * - `auto_timeout`       — 12h elapsed since `live_started_at` (Req 5.2).
 */
export type EndReason = "finish_bar_claimed" | "admin_ended" | "auto_timeout";

/** The fixed maximum a game may stay `live` before auto-timeout (Req 5.2). */
export const AUTO_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

/**
 * Coerce a `Date` or epoch-millisecond number to epoch milliseconds.
 * Keeps the public predicates ergonomic for both callers (DB timestamps come
 * back as ISO strings → `Date`; tests often use raw numbers).
 */
function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * Deterministic auto-timeout predicate (Req 5.2).
 *
 * True iff at least 12 hours have elapsed between the moment the game went
 * `live` and `now`, i.e. `now - liveStartedAt >= AUTO_TIMEOUT_MS`. This is the
 * predicate the auto-timeout trigger (scheduled sweep / lazy check) applies to a
 * live game; the actual transition still goes through the atomic end write.
 *
 * The boundary is inclusive: exactly 12h is due.
 *
 * @param liveStartedAt when the game transitioned to `live` (UTC).
 * @param now the current time to evaluate against (UTC).
 */
export function isDueForAutoTimeout(
  liveStartedAt: Date | number,
  now: Date | number,
): boolean {
  return toMillis(now) - toMillis(liveStartedAt) >= AUTO_TIMEOUT_MS;
}

/**
 * End-transition lifecycle guard (Req 5.4, 5.5).
 *
 * True iff the game is `live`. Ending a `lobby` game or re-ending an already
 * `ended` game is rejected, which leaves the lifecycle (and any recorded
 * `end_reason`) unchanged. This is the single gate every end path — admin-ended,
 * auto-timeout, and later finish-bar-claimed — must pass.
 */
export function canEndGame(lifecycle: GameLifecycle): boolean {
  return lifecycle === "live";
}

/**
 * The current end-state of a game, as seen by the immutability guard.
 * `endReason` is `null`/`undefined` until the game has ended.
 */
export interface GameEndState {
  lifecycle: GameLifecycle;
  endReason: EndReason | null | undefined;
}

/** The outcome of attempting to record an end transition. */
export type ApplyEndResult =
  | {
      readonly ok: true;
      readonly lifecycle: "ended";
      readonly endReason: EndReason;
    }
  | {
      readonly ok: false;
      readonly reason: "not_live";
      readonly current: GameEndState;
    };

/**
 * Guarded, pure model of an end transition that enforces `end_reason`
 * immutability once set (Req 5.4, 5.5).
 *
 * Rules:
 * - The transition is permitted only from `live` (`canEndGame`). From `lobby`
 *   or `ended`, it is rejected and the current state is returned unchanged — in
 *   particular an already-set `end_reason` is never overwritten, so re-ending an
 *   `ended` game is a no-op that preserves the original reason.
 * - On success, the game becomes `ended` with the supplied `end_reason`. Because
 *   a second call now sees `lifecycle === 'ended'`, it is rejected, which is what
 *   makes `end_reason` immutable after the first successful end.
 *
 * This is a pure decision function; the caller (server route / scheduled sweep)
 * is responsible for persisting the result atomically alongside its `game_event`.
 */
export function applyEnd(
  current: GameEndState,
  endReason: EndReason,
): ApplyEndResult {
  if (!canEndGame(current.lifecycle)) {
    return { ok: false, reason: "not_live", current };
  }
  return { ok: true, lifecycle: "ended", endReason };
}

/** The minimum number of teams a game may start (go `live`) with (Req 3.6). */
export const MIN_TEAMS = 2;

/** The maximum number of teams a game may start (go `live`) with (Req 3.6). */
export const MAX_TEAMS = 4;

/**
 * Start-eligibility guard: team-count bound per game (Req 3.6).
 *
 * True iff `MIN_TEAMS <= teamCount <= MAX_TEAMS`, i.e. a game may transition to
 * `live` only with 2, 3, or 4 teams. Fewer than 2 (a game needs opponents) or
 * more than 4 is rejected, leaving the game in `lobby`.
 *
 * This mirrors `canEndGame`: a small, pure lifecycle predicate the start route
 * consults before performing the `lobby → live` transition. Enforced by
 * application validation (the schema records teams but does not itself bound the
 * count), so keeping it pure lets it be property-tested (task 5.2) and reused by
 * both team-creation validation and the start check.
 *
 * Non-integer or non-finite counts (e.g. `2.5`, `NaN`) are rejected: a team
 * count is a whole number, so anything else is not an eligible start.
 *
 * @param teamCount the number of teams currently in the game.
 */
export function canStartGame(teamCount: number): boolean {
  return (
    Number.isInteger(teamCount) &&
    teamCount >= MIN_TEAMS &&
    teamCount <= MAX_TEAMS
  );
}
