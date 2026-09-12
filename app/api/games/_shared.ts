/**
 * Shared server-route helpers for the lobby mutation routes (design.md
 * "Server routes"; Task 11).
 *
 * The six lobby routes under `app/api/games/…` (create, designate bars, join,
 * create team, select team, start) all share the same three concerns:
 *
 *   1. **Session identity** — every request carries an `x-bbb-session-id` header
 *      (the session-based Identity_Model, Req 8.3); a request with no valid
 *      session is rejected with 401 and writes nothing (Req 1.3, 8.3).
 *   2. **In-transaction authorization** — player actions require game membership
 *      (Req 8.4/8.5) and admin actions require the requesting session to equal
 *      the game's `admin_session_id` (Req 8.8). Both checks run **inside the
 *      caller's transaction against a `FOR UPDATE`-locked game row**, so the
 *      authorization decision and the subsequent domain write see the same
 *      consistent, serialized game state (the same discipline `appendEvent` uses
 *      for its seq assignment).
 *   3. **Structured responses** — success is `{ applied: true, seq }` carrying
 *      the appended event's per-game sequence (Req 6.4); rejection is
 *      `{ applied: false, error }` with a reason and an appropriate HTTP status
 *      (Req 6.5), matching `demo-mutation/route.ts` and the `end` route.
 *
 * The membership / admin SQL below is lifted directly from those existing routes
 * (`MEMBERSHIP_SQL` in `demo-mutation`, `ADMIN_CHECK_SQL` in `end`), with the
 * game-row `FOR UPDATE` lock made explicit so that state-dependent decisions
 * (lifecycle, bar designation, team count) taken after the check cannot race a
 * concurrent writer.
 *
 * This module is imported by all six lobby route handlers, so its API is kept
 * small and reusable: a header reader, two authorization helpers, the response
 * shape types, the reason→status map, and two `NextResponse` builders.
 *
 * Requirements: 1.3, 6.4, 6.5, 8.3, 8.4, 8.5.
 */
import { NextResponse } from "next/server";

import type { QueryRunner, SqlRow } from "@/lib/events";

/**
 * Header carrying the per-game session id (session-based Identity_Model).
 *
 * The single source of truth for the header name across all lobby routes; the
 * foundation routes hard-code the same literal (`demo-mutation`, `end`).
 */
export const SESSION_HEADER = "x-bbb-session-id";

// --------------------------------------------------------------------------
// Structured response shape (design.md §Error Handling; Req 6.4/6.5)
// --------------------------------------------------------------------------

/**
 * The set of rejection reasons a lobby mutation may return. Each maps to a fixed
 * HTTP status via {@link ERROR_STATUS}. Keeping this a string-literal union lets
 * every route reference reasons by name and gives the status map exhaustive
 * type-checking.
 */
export type LobbyErrorReason =
  | "missing_session"
  | "not_admin"
  | "not_member"
  | "invalid_code"
  | "not_found"
  | "invalid_display_name"
  | "invalid_team_name"
  | "team_limit_reached"
  | "bar_not_found"
  | "start_finish_equal"
  | "lobby_closed"
  | "min_teams"
  | "max_teams"
  | "bars_missing"
  | "not_in_lobby"
  | "code_generation_failed";

/** Success shape: the mutation was applied and produced one event at `seq` (Req 6.4). */
export interface AppliedResponse {
  readonly applied: true;
  /** The appended event's per-game sequence number. */
  readonly seq: number;
}

/** Structured "not applied" failure shape (Req 6.5): a reason, no write performed. */
export interface NotAppliedResponse {
  readonly applied: false;
  readonly error: LobbyErrorReason;
}

/** The JSON body every lobby route returns: applied-with-seq or not-applied-with-reason. */
export type LobbyResponseBody = AppliedResponse | NotAppliedResponse;

/**
 * Reason → HTTP status map (design.md §Error Handling table).
 *
 * The single mapping every lobby route shares so status codes stay consistent:
 *   - `401` the request carried no valid session (Req 1.3, 8.3).
 *   - `403` the requester is not authorized for the action (Req 2.8, 5.6, 8.5).
 *   - `400` a supplied value has an invalid shape (code / name / equal bars).
 *   - `404` a referenced game or bar does not exist.
 *   - `409` the game's current state conflicts with the request (lobby closed,
 *     team-count bounds, bars not yet designated).
 *   - `503` unique Join_Code generation was exhausted (Req 1.5).
 */
export const ERROR_STATUS: Readonly<Record<LobbyErrorReason, number>> = {
  missing_session: 401,
  not_admin: 403,
  not_member: 403,
  invalid_code: 400,
  not_found: 404,
  invalid_display_name: 400,
  invalid_team_name: 400,
  team_limit_reached: 409,
  bar_not_found: 404,
  start_finish_equal: 400,
  lobby_closed: 409,
  min_teams: 409,
  max_teams: 409,
  bars_missing: 409,
  not_in_lobby: 409,
  code_generation_failed: 503,
};

/**
 * Build the success `NextResponse` for an applied lobby mutation (Req 6.4).
 *
 * @param seq the appended event's per-game sequence number.
 * @param status the HTTP status to use; defaults to 200. Routes that create a
 *   resource (e.g. the create-game route) pass 201.
 */
export function applied(seq: number, status = 200): NextResponse {
  const body: AppliedResponse = { applied: true, seq };
  return NextResponse.json(body, { status });
}

/**
 * Build the structured not-applied `NextResponse` for a rejected mutation
 * (Req 6.5). The HTTP status is derived from {@link ERROR_STATUS} for the given
 * reason, so callers never hand-pick a status — they name the reason and the map
 * decides the code.
 *
 * @param reason the rejection reason to report to the client.
 */
export function notApplied(reason: LobbyErrorReason): NextResponse {
  const body: NotAppliedResponse = { applied: false, error: reason };
  return NextResponse.json(body, { status: ERROR_STATUS[reason] });
}

// --------------------------------------------------------------------------
// Session identity (Req 1.3, 8.3)
// --------------------------------------------------------------------------

/**
 * The outcome of reading the session header: either the trimmed session id, or a
 * signal that no valid session was presented (blank/missing header).
 */
export type SessionResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: "missing_session" };

/**
 * Read and validate the `x-bbb-session-id` header (Req 8.3).
 *
 * Returns the trimmed session id when present and non-empty; otherwise a
 * `missing_session` signal the route turns into a 401 via {@link notApplied},
 * writing nothing (Req 1.3). Trimming matches the foundation routes, which treat
 * a whitespace-only header as absent.
 *
 * @param request the incoming request.
 */
export function requireSession(request: Request): SessionResult {
  const sessionId = request.headers.get(SESSION_HEADER)?.trim();
  if (!sessionId) {
    return { ok: false, reason: "missing_session" };
  }
  return { ok: true, sessionId };
}

// --------------------------------------------------------------------------
// In-transaction authorization (Req 8.4, 8.5, 8.8)
// --------------------------------------------------------------------------

/**
 * A `games` row as loaded by {@link assertAdmin}, with the columns lobby routes
 * need to make state-dependent decisions after authorization: the lifecycle
 * phase, the admin session, and the current start/finish bar designation.
 *
 * Kept intentionally small; routes that need additional columns can extend the
 * shared `SELECT` in one place.
 */
export interface GameRow {
  readonly id: string;
  readonly lifecycle: "lobby" | "live" | "ended";
  readonly adminSessionId: string;
  readonly startBarId: string | null;
  readonly finishBarId: string | null;
}

/**
 * Membership check (Req 8.4/8.5), lifted from `demo-mutation`'s `MEMBERSHIP_SQL`.
 *
 * Locks the game row `FOR UPDATE` and returns a row iff the session is the game's
 * admin or a joined player of that game. Taking the lock here means any
 * state-dependent decision the route makes afterwards (e.g. the lobby-phase
 * guard) sees a game state no concurrent writer can change until this
 * transaction commits.
 *
 * Positional parameters: $1 game_id, $2 session_id.
 */
const MEMBERSHIP_SQL = `
with locked as (
  select id, admin_session_id from games where id = $1 for update
)
select 1
from locked g
where g.admin_session_id = $2
   or exists (
     select 1 from players p
     where p.game_id = g.id and p.session_id = $2
   )
limit 1
`;

/**
 * Admin check (Req 8.8), lifted from the `end` route's `ADMIN_CHECK_SQL` and
 * extended to return the locked game row so callers can read lifecycle and bar
 * designation without a second query.
 *
 * Locks the game row `FOR UPDATE` and returns it together with a boolean of
 * whether the requesting session equals `admin_session_id`. The row is returned
 * even when the session is not the admin so a caller could distinguish
 * "no such game" from "not the admin"; routes generally collapse both to a
 * forbidden response to avoid leaking game existence.
 *
 * Positional parameters: $1 game_id, $2 session_id.
 */
const ADMIN_CHECK_SQL = `
select
  id,
  lifecycle,
  admin_session_id,
  start_bar_id,
  finish_bar_id,
  (admin_session_id = $2) as is_admin
from games
where id = $1
for update
`;

/** Map a raw `games` row (snake_case) to the shared {@link GameRow}. */
function rowToGameRow(row: SqlRow): GameRow {
  return {
    id: String(row.id),
    lifecycle: row.lifecycle as GameRow["lifecycle"],
    adminSessionId: String(row.admin_session_id),
    startBarId: row.start_bar_id == null ? null : String(row.start_bar_id),
    finishBarId: row.finish_bar_id == null ? null : String(row.finish_bar_id),
  };
}

/**
 * Confirm the session is a member of the game (its admin or a joined player),
 * inside the caller's transaction against the `FOR UPDATE`-locked game row
 * (Req 8.4/8.5).
 *
 * Used by player actions (create team, select team) that require membership but
 * not admin identity. Returns `false` both when the game does not exist and when
 * the session is not a member — the caller cannot distinguish the two and treats
 * both as "not a member" (mirroring the foundation routes, which avoid leaking
 * existence).
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param gameId the game to authorize against.
 * @param sessionId the requesting session (from {@link requireSession}).
 * @returns whether the session is a member of the game.
 */
export async function assertMember(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await tx.query(MEMBERSHIP_SQL, [gameId, sessionId]);
  return rows.length > 0;
}

/** The outcome of {@link assertAdmin}: the loaded game row and whether the session is its admin. */
export type AdminCheckResult =
  | { readonly ok: true; readonly game: GameRow }
  | { readonly ok: false; readonly game: GameRow; readonly reason: "not_admin" }
  | { readonly ok: false; readonly game: null; readonly reason: "not_found" };

/**
 * Confirm the session is the game's admin, inside the caller's transaction
 * against the `FOR UPDATE`-locked game row (Req 8.8), returning the loaded row so
 * the caller can read lifecycle and bar designation for its state-dependent
 * guards (e.g. lobby-phase, bars-designated).
 *
 * Used by admin actions (designate bars, start game). Distinguishes the missing
 * game (`not_found`) from a present game whose admin the session is not
 * (`not_admin`); routes typically surface both as a forbidden/not-found response
 * per the design's status map.
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param gameId the game to authorize against.
 * @param sessionId the requesting session (from {@link requireSession}).
 * @returns an {@link AdminCheckResult} carrying the locked game row when present.
 */
export async function assertAdmin(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<AdminCheckResult> {
  const { rows } = await tx.query(ADMIN_CHECK_SQL, [gameId, sessionId]);
  const row = rows[0];
  if (!row) {
    return { ok: false, game: null, reason: "not_found" };
  }
  const game = rowToGameRow(row);
  if (row.is_admin === true) {
    return { ok: true, game };
  }
  return { ok: false, game, reason: "not_admin" };
}
