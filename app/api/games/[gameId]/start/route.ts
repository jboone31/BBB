/**
 * Start-game route (design.md §Components 1e, Server routes; Task 17).
 *
 * POST /api/games/{gameId}/start — the Admin transitions a Game from its lobby
 * phase to `live`, which unlocks claiming (owned by later features). The route
 * composes the shared lobby helpers (`app/api/games/_shared.ts`) and the pure
 * gates (`lib/lobby/gate.ts`, `lib/gameend`) inside a single transaction so the
 * lifecycle write and its single `game_started` event commit together (Req 6.1),
 * mirroring the demo-mutation write path.
 *
 * The start is permitted only when every precondition holds, checked in order so
 * each rejection returns *before* the `UPDATE` and therefore leaves the Game's
 * lifecycle unchanged (Req 5.3–5.7):
 *
 *   1. a valid Session is presented (Req 8.3)                    → missing_session (401)
 *   2. the Session is the Game's Admin (Req 5.6, 8.8)            → not_admin (403) / not_found (404)
 *   3. the Game is still in its lobby phase (Req 5.7)            → not_in_lobby (409)
 *   4. the Game has 2–4 Teams (Req 5.1, 5.3, 5.4)               → min_teams / max_teams (409)
 *   5. both the Start_Bar and Finish_Bar are designated (Req 5.5) → bars_missing (409)
 *
 * Only once all five pass does the route set `lifecycle = 'live'` and stamp
 * `live_started_at = now()` (Req 5.1, 5.2 — one `UPDATE` satisfies the
 * `games_live_started_at_when_started` CHECK, which requires the timestamp be set
 * on any non-lobby lifecycle), then appends exactly one `game_started` event
 * carrying that UTC timestamp (Req 5.8), and returns the event's per-game `seq`.
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent } from "@/lib/events";
import { canStartGame, MIN_TEAMS } from "@/lib/gameend";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import { bothBarsDesignated, isLobbyPhase } from "@/lib/lobby/gate";

import {
  applied,
  assertAdmin,
  type LobbyErrorReason,
  notApplied,
  requireSession,
} from "@/app/api/games/_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Count the game's teams inside the transaction (locked game row already held). */
const TEAM_COUNT_SQL = `
select count(*)::int as team_count
from teams
where game_id = $1
`;

/**
 * Transition the game to `live` and stamp the UTC go-live time (Req 5.1, 5.2).
 *
 * A single `UPDATE` sets both columns so the `games_live_started_at_when_started`
 * CHECK (a non-lobby lifecycle must have a non-null `live_started_at`) is
 * satisfied atomically. `now()` is UTC; it is returned so the event payload
 * records the exact stamped value.
 */
const GO_LIVE_SQL = `
update games
set lifecycle = 'live',
    live_started_at = now()
where id = $1
returning live_started_at
`;

/**
 * The transaction's outcome: either a rejection reason (nothing written), or the
 * appended event's `seq` on success.
 */
type StartOutcome =
  | { readonly ok: false; readonly reason: LobbyErrorReason }
  | { readonly ok: true; readonly seq: number };

/**
 * POST /api/games/[gameId]/start
 *
 * Header: `x-bbb-session-id: <session>` (must be the game admin).
 *
 * Responses:
 *   - 200 `{ applied: true, seq }` — the game went live; one `game_started` event written.
 *   - 401 missing session (`missing_session`).
 *   - 403 the session is not this game's admin (`not_admin`).
 *   - 404 the game does not exist (`not_found`).
 *   - 409 the game is not in lobby (`not_in_lobby`), has too few / too many teams
 *         (`min_teams` / `max_teams`), or is missing a bar designation
 *         (`bars_missing`) — the lifecycle is left unchanged.
 *   - 500 the transaction failed and was rolled back (nothing applied).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // --- Session identity (Req 8.3) -----------------------------------------
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }

  // --- Admin check + guarded lobby→live transition, all in one tx ----------
  try {
    const outcome = await withTransaction<StartOutcome>(async (tx) => {
      // 1. Authorize: the session must be this game's admin (Req 5.6, 8.8). The
      //    check locks the game row FOR UPDATE and loads lifecycle + bars.
      const auth = await assertAdmin(tx, gameId, session.sessionId);
      if (!auth.ok) {
        return { ok: false, reason: auth.reason };
      }
      const { game } = auth;

      // 2. Lobby-phase gate (Req 5.7): only a lobby game can be started.
      if (!isLobbyPhase(game.lifecycle)) {
        return { ok: false, reason: "not_in_lobby" };
      }

      // 3. Team-count bounds (Req 5.1, 5.3, 5.4). canStartGame is the combined
      //    2–4 guard; we still distinguish under/over to report the right reason.
      const { rows: teamRows } = await tx.query(TEAM_COUNT_SQL, [gameId]);
      const teamCount = Number(teamRows[0]?.team_count ?? 0);
      if (!canStartGame(teamCount)) {
        // Distinguish under- vs over-count for the reason: canStartGame already
        // rejected the count, so below the floor is min_teams and anything else
        // (above the ceiling, or a non-integer) is max_teams.
        const reason: LobbyErrorReason =
          teamCount < MIN_TEAMS ? "min_teams" : "max_teams";
        return { ok: false, reason };
      }

      // 4. Both route bars must be designated (Req 5.5).
      if (!bothBarsDesignated(game.startBarId, game.finishBarId)) {
        return { ok: false, reason: "bars_missing" };
      }

      // 5. All gates passed: go live + stamp UTC time (Req 5.1, 5.2), then
      //    append exactly one game_started event in the same tx (Req 5.8, 6.1).
      const { rows: liveRows } = await tx.query(GO_LIVE_SQL, [gameId]);
      const liveStartedAt = liveRows[0]?.live_started_at;
      const liveStartedAtIso =
        liveStartedAt instanceof Date
          ? liveStartedAt.toISOString()
          : String(liveStartedAt);

      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.gameStarted,
        actor: "admin",
        payload: { liveStartedAt: liveStartedAtIso },
      });

      return { ok: true, seq: event.seq };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch (err) {
    // The transaction rolled back: lifecycle unchanged, log unchanged (Req 6.1).
    const message =
      err instanceof Error ? err.message : "start could not be applied";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
