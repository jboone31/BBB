/**
 * Admin-ended game-end route (design.md "Game-end behavior"; Task 10.2, Req 5.1).
 *
 * POST /api/games/{gameId}/end — the Admin ends a live game. The game transitions
 * to `ended` with `end_reason = 'admin_ended'` **and** exactly one `game_event`
 * is appended, atomically, via the shared {@link endGame} helper run inside one
 * transaction (`withTransaction`). On success it returns the new event's `seq`;
 * on a guard rejection it returns a structured "not applied" error (409 when the
 * game is not `live`, so an already-`ended` or `lobby` game is refused).
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser
 *     (`lib/db/server.ts` is `server-only`).
 *
 * Auth (session-based Identity_Model, Req 1.7): the request must carry an
 * `x-bbb-session-id` header, and that session must be **the game's admin**
 * (`games.admin_session_id`). Only the admin may end a game (Req 5.1), so — unlike
 * the demo mutation, which accepts any game member — this route checks admin
 * identity specifically. The check runs in the same transaction as the end write.
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { endGame, type EndGameResult } from "@/lib/gameend/transition";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Header carrying the per-game session id (session-based Identity_Model). */
const SESSION_HEADER = "x-bbb-session-id";

/** Structured "not applied" failure shape (mirrors the demo mutation route). */
interface NotAppliedError {
  readonly applied: false;
  readonly error: string;
}

/** Success shape: the game ended and produced one event at `seq`. */
interface AppliedResult {
  readonly applied: true;
  /** The new `game_ended` event's per-game sequence number. */
  readonly seq: number;
}

/** Build a structured not-applied JSON response with the given status. */
function notApplied(error: string, status: number): NextResponse {
  const body: NotAppliedError = { applied: false, error };
  return NextResponse.json(body, { status });
}

/**
 * Confirm the session is the game's admin, inside the caller's transaction so
 * the check and the end write are consistent. Ending is an admin-only action
 * (Req 5.1), so we match `games.admin_session_id` specifically (not general
 * membership). Returns no row when the game is missing or the session is not the
 * admin — the route cannot distinguish the two and treats both as "not admin".
 */
const ADMIN_CHECK_SQL = `
select 1
from games
where id = $1
  and admin_session_id = $2
limit 1
`;

/** Marker returned from the transaction when the session is not the game admin. */
type NotAdmin = "not_admin";

/**
 * POST /api/games/[gameId]/end
 *
 * Header: `x-bbb-session-id: <session>` (must be the game admin).
 *
 * Responses:
 *   - 200 `{ applied: true, seq }` — the game ended; one `game_ended` event written.
 *   - 401 missing session header.
 *   - 403 the session is not this game's admin.
 *   - 404 the game does not exist.
 *   - 409 `{ applied: false, error }` — the game is not `live` (already ended or in
 *         lobby); lifecycle and any `end_reason` are unchanged (Req 5.4/5.5).
 *   - 500 the transaction failed and was rolled back (nothing applied).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // --- Parse + validate the request ---------------------------------------
  const sessionId = request.headers.get(SESSION_HEADER)?.trim();
  if (!sessionId) {
    return notApplied(`missing ${SESSION_HEADER} header`, 401);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("gameId is required", 400);
  }

  // --- Admin check + atomic end transition (Req 5.1, 5.3, 5.4, 5.5) --------
  try {
    const result = await withTransaction<EndGameResult | NotAdmin>(
      async (tx) => {
        // Game-scoped admin auth: confirm the session is the admin, same tx.
        const { rows: adminRows } = await tx.query(ADMIN_CHECK_SQL, [
          gameId,
          sessionId,
        ]);
        if (adminRows.length === 0) {
          return "not_admin";
        }

        // Shared atomic end: lifecycle -> 'ended' + end_reason='admin_ended'
        // AND exactly one game_event, guarded by canEndGame, all in this tx.
        return endGame(tx, { gameId, endReason: "admin_ended" });
      },
    );

    if (result === "not_admin") {
      // We cannot tell "no such game" from "not the admin" without leaking
      // existence; treat as forbidden for the admin-only action.
      return notApplied("session is not the admin of this game", 403);
    }

    if (result.ok) {
      // Success: lifecycle + end_reason + its single event committed together.
      const body: AppliedResult = { applied: true, seq: result.seq };
      return NextResponse.json(body, { status: 200 });
    }

    // Guard rejection (Req 5.4/5.5): nothing was written.
    if (result.reason === "not_found") {
      return notApplied("game not found", 404);
    }
    // not_live: already ended or still in lobby -> conflict with the requested end.
    return notApplied(
      `game cannot be ended from '${result.current}' state`,
      409,
    );
  } catch (err) {
    // The transaction rolled back: no lifecycle change persisted, log unchanged.
    const message =
      err instanceof Error
        ? err.message
        : "end transition could not be applied";
    return notApplied(message, 500);
  }
}
