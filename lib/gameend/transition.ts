/**
 * Shared atomic game-end transition (design.md "Game-end behavior"; Task 10.2).
 *
 * This module owns the single helper both end paths go through:
 *   - the admin-ended server route (`app/api/games/[gameId]/end/route.ts`, Task 10.2), and
 *   - the scheduled auto-timeout sweep (Task 10.3, which imports {@link endGame}
 *     from here and passes `endReason: 'auto_timeout'`).
 *
 * "Every end transition is a `Game_State_Change`" (Req 5.3): ending a game writes
 * the `ended` lifecycle **and** its `end_reason`, **and** appends **exactly one**
 * `game_event`, all in **one transaction**. Because {@link endGame} runs inside
 * the caller's transaction (via a {@link QueryRunner}), the lifecycle write and
 * the event append commit or roll back together, just like every other write on
 * the event backbone (Req 4.3/4.4).
 *
 * The lifecycle guard and `end_reason` immutability (Req 5.4/5.5) are enforced by
 * reading + locking the game row and checking {@link canEndGame} before writing:
 *   - `SELECT ... FOR UPDATE` locks the row so a concurrent ender (e.g. the sweep
 *     racing the admin route) cannot both transition the same game — the second
 *     waiter re-reads a now-`ended` lifecycle and is rejected;
 *   - if the game is not `live`, {@link endGame} returns a structured rejected
 *     result and writes **nothing**, so lifecycle and any already-set `end_reason`
 *     are left unchanged (an already-`ended` game keeps its original reason).
 *
 * This helper is framework-free (no Next.js, no `server-only`): it takes a
 * transaction-scoped {@link QueryRunner} so it can be driven by a server route
 * (`withTransaction`) or a scheduled job alike. It reuses the pure guard
 * {@link canEndGame} and the {@link appendEvent} backbone.
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5.
 */
import { appendEvent, type QueryRunner } from "@/lib/events";

import { canEndGame, type EndReason, type GameLifecycle } from "./index";

/**
 * The `game_events.event_type` written for an end transition. Subscribed clients
 * observe this to learn the game ended (design.md "Game-end behavior").
 */
export const GAME_ENDED_EVENT_TYPE = "game_ended";

/** Arguments to {@link endGame}. */
export interface EndGameArgs {
  /** The game to end (Req 4.1: exactly one game per event). */
  readonly gameId: string;
  /**
   * Why the game is ending. `admin_ended` for the admin route (Req 5.1);
   * `auto_timeout` for the scheduled sweep (Req 5.2, Task 10.3).
   */
  readonly endReason: EndReason;
}

/**
 * A rejected end attempt (Req 5.4/5.5): the game was not `live`, so nothing was
 * written. `current` reports the lifecycle read under the lock, so callers can
 * distinguish "already ended" (`current === 'ended'`) from "still in lobby".
 */
export interface EndGameRejected {
  readonly ok: false;
  readonly reason: "not_live" | "not_found";
  /** The lifecycle observed under the lock, or `null` when the game is missing. */
  readonly current: GameLifecycle | null;
}

/** A successful end transition (Req 5.3): the `seq` of the one appended event. */
export interface EndGameApplied {
  readonly ok: true;
  /** The per-game sequence of the single `game_ended` event written. */
  readonly seq: number;
}

/** The outcome of {@link endGame}. */
export type EndGameResult = EndGameApplied | EndGameRejected;

/**
 * Map an {@link EndReason} to the `game_events.actor` that caused the end
 * (design.md: admin-ended → `admin`; auto-timeout → `system`). A finish-bar
 * claim (a later feature) is caused by the claiming team, but this foundation
 * helper only handles the two `system`/`admin`-initiated reasons and defaults
 * finish-bar to `system` should a caller ever pass it.
 */
function actorForReason(endReason: EndReason): "admin" | "system" {
  return endReason === "admin_ended" ? "admin" : "system";
}

/**
 * SQL that locks the game row and reads its current lifecycle (Req 5.4/5.5).
 *
 * `FOR UPDATE` serializes concurrent enders on the same game: whoever locks first
 * completes its transition (or rejection); the next waiter re-reads the updated
 * lifecycle and is rejected by {@link canEndGame}, so `end_reason` is never
 * overwritten. Returns no row when the game does not exist.
 */
const LOCK_GAME_SQL = `
select lifecycle
from games
where id = $1
for update
`;

/**
 * SQL that performs the lifecycle write of the end transition (Req 5.3).
 *
 * Sets `lifecycle = 'ended'` and `end_reason = $2` together — required by the
 * `games_end_reason_matches_lifecycle` check (an `ended` game must have a
 * reason). The `where ... and lifecycle = 'live'` predicate is a second, in-SQL
 * expression of the {@link canEndGame} guard: even though we already checked the
 * locked lifecycle in application code, this makes the UPDATE itself refuse to
 * touch a non-`live` row. `returning id` lets us assert exactly one row changed.
 */
const END_GAME_SQL = `
update games
set lifecycle = 'ended',
    end_reason = $2::game_end_reason
where id = $1
  and lifecycle = 'live'
returning id
`;

/**
 * Atomically end a game inside the caller's transaction (Req 5.1, 5.3, 5.4, 5.5).
 *
 * Steps, all on the caller-supplied {@link QueryRunner} (one transaction):
 *   1. `SELECT ... FOR UPDATE` the game row to read + lock its lifecycle.
 *   2. Guard with {@link canEndGame}: if the game is missing or not `live`,
 *      return a structured rejected result **without writing anything**, so the
 *      lifecycle and any recorded `end_reason` stay unchanged (Req 5.4/5.5).
 *   3. If `live`, `UPDATE games SET lifecycle='ended', end_reason=$endReason` and
 *      append **exactly one** `game_ended` event (actor `admin` for `admin_ended`,
 *      `system` for `auto_timeout`) in the same transaction (Req 5.3). The
 *      `and lifecycle = 'live'` UPDATE predicate is a redundant in-SQL guard; if
 *      it unexpectedly matched no row we throw so the transaction rolls back.
 *   4. Return the created event's `seq`.
 *
 * The caller owns commit/rollback (e.g. `withTransaction`): on any throw here —
 * a failed event append, a constraint violation — the lifecycle write and the
 * event both roll back, so the game is not left half-ended (Req 4.3/4.4).
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param args the game to end and why.
 * @returns {@link EndGameApplied} with the event `seq` on success, or
 *   {@link EndGameRejected} when the game is not `live` (or not found).
 */
export async function endGame(
  tx: QueryRunner,
  args: EndGameArgs,
): Promise<EndGameResult> {
  const { gameId, endReason } = args;

  // 1. Lock + read the current lifecycle (Req 5.4/5.5).
  const { rows: lockRows } = await tx.query(LOCK_GAME_SQL, [gameId]);
  const lockRow = lockRows[0];
  if (!lockRow) {
    // No such game: nothing to end, nothing written.
    return { ok: false, reason: "not_found", current: null };
  }

  const lifecycle = lockRow.lifecycle as GameLifecycle;

  // 2. Guard: only 'live' games can end; otherwise reject unchanged (Req 5.4/5.5).
  if (!canEndGame(lifecycle)) {
    return { ok: false, reason: "not_live", current: lifecycle };
  }

  // 3a. Lifecycle write: lifecycle -> 'ended' + end_reason, in this transaction.
  const { rows: endedRows } = await tx.query(END_GAME_SQL, [gameId, endReason]);
  if (endedRows.length !== 1) {
    // We hold FOR UPDATE and observed 'live', so the guarded UPDATE must have
    // matched exactly one row. Anything else is an invariant violation — throw
    // so the whole transaction rolls back (no partial end).
    throw new Error(
      `endGame: expected to end exactly 1 live game ${gameId}, updated ${endedRows.length}`,
    );
  }

  // 3b. EXACTLY ONE event, same transaction (Req 5.3). If this throws, the
  //     lifecycle write above rolls back with it (Req 4.3/4.4).
  const event = await appendEvent(tx, {
    gameId,
    type: GAME_ENDED_EVENT_TYPE,
    actor: actorForReason(endReason),
    payload: { endReason },
  });

  // 4. Report the single event's sequence.
  return { ok: true, seq: event.seq };
}
