/**
 * Team-select/switch route (design.md "Server routes", Component 1c; Task 17).
 *
 * POST /api/games/{gameId}/teams/select — a Player (any game member) joins a
 * Team, or switches from one Team to another, while the Game is still in its
 * lobby phase. The route wraps a single `UPDATE players SET team_id = $target`
 * plus exactly one `team_changed` event in one transaction (`withTransaction`),
 * so the association change and its event commit together (R4.6, R6.1). Because
 * `players.team_id` is a single-valued column, the update makes exactly one
 * association true by construction — the teamless-first-selection (R4.1) and the
 * switch (R4.5) cases both resolve to the player being on exactly the target
 * team and no other.
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser.
 *
 * Auth (session-based Identity_Model, Req 8.4/8.5): the request must carry an
 * `x-bbb-session-id` header, and that session must be a **member** of the game
 * (its admin or a joined player). Selecting a team does not require admin
 * identity.
 *
 * Flow (all inside the transaction against the `FOR UPDATE`-locked game row):
 *   1. `requireSession` — no valid session writes nothing (R8.3 → 401).
 *   2. `assertMember` — non-members are rejected (R8.4/8.5 → 403 not_member).
 *   3. lobby-phase gate (R4.8 → 409 lobby_closed).
 *   4. the target team must belong to this game (→ 404 not_found).
 *   5. the requesting session must have a player row in this game (→ 403
 *      not_member — a member session with no player cannot select a team).
 *   6. `UPDATE players SET team_id = $target`, then `appendEvent` `team_changed`
 *      `{ playerId, fromTeamId, toTeamId }` — `fromTeamId` is null on a first
 *      selection (R4.1), the prior team id on a switch (R4.5).
 *
 * Requirements: 4.1, 4.5, 4.6, 4.8, 6.1.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import { isLobbyPhase } from "@/lib/lobby/gate";

import {
  applied,
  assertMember,
  type LobbyErrorReason,
  notApplied,
  requireSession,
} from "@/app/api/games/_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the team-select route. */
interface SelectTeamBody {
  /** The target Team id the player joins/switches to. */
  readonly teamId?: unknown;
}

/**
 * Read the game's lifecycle under the lock `assertMember` already took, so the
 * lobby-phase decision sees the same serialized state (R4.8).
 */
const GAME_LIFECYCLE_SQL = `
select lifecycle
from games
where id = $1
limit 1
`;

/** Confirm the target team belongs to this game (composite integrity, R4.1/R4.5). */
const TEAM_IN_GAME_SQL = `
select 1
from teams
where id = $1 and game_id = $2
limit 1
`;

/**
 * Read the requesting session's player row (its id and current team) in this
 * game, so the event can record `fromTeamId` accurately.
 *
 * Positional parameters: $1 game_id, $2 session_id.
 */
const PLAYER_FOR_SESSION_SQL = `
select id, team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

/**
 * Associate the player with the target team (R4.1/R4.5). A single-valued column
 * makes exactly one association true; the composite FK keeps the team in the
 * same game.
 *
 * Positional parameters: $1 target_team_id, $2 player_id.
 */
const UPDATE_PLAYER_TEAM_SQL = `
update players
set team_id = $1
where id = $2
`;

type SelectOutcome =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

/** Read the requesting session's player id + current team id in the game. */
async function playerForSession(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<{ playerId: string; teamId: string | null } | null> {
  const { rows } = await tx.query(PLAYER_FOR_SESSION_SQL, [gameId, sessionId]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    playerId: String(row.id),
    teamId: row.team_id == null ? null : String(row.team_id),
  };
}

/**
 * POST /api/games/[gameId]/teams/select
 *
 * Header: `x-bbb-session-id: <session>` (must be a game member).
 * Body: `{ teamId: string }` — the target team to join/switch to.
 *
 * Responses:
 *   - 200 `{ applied: true, seq }` — the association changed; one `team_changed`
 *     event written.
 *   - 401 `missing_session` — no valid session (R8.3).
 *   - 403 `not_member` — the session is not a member, or has no player row.
 *   - 409 `lobby_closed` — the game is not in its lobby phase (R4.8).
 *   - 404 `not_found` — the target team is not a team of this game.
 *   - 500 — the transaction failed and was rolled back (nothing applied).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // --- Session identity (R8.3) --------------------------------------------
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_member");
  }

  let body: SelectTeamBody;
  try {
    body = (await request.json()) as SelectTeamBody;
  } catch {
    return notApplied("not_found");
  }
  const targetTeamId =
    typeof body.teamId === "string" ? body.teamId.trim() : "";
  if (!targetTeamId) {
    return notApplied("not_found");
  }

  // --- Membership + lobby-phase gate + atomic update + one event ----------
  try {
    const outcome = await withTransaction<SelectOutcome>(async (tx) => {
      // 1. Membership (R8.4/8.5) — locks the game row FOR UPDATE.
      const isMemberOfGame = await assertMember(tx, gameId, session.sessionId);
      if (!isMemberOfGame) {
        return { ok: false, reason: "not_member" };
      }

      // 2. Lobby-phase gate (R4.8) — read lifecycle under the same lock.
      const { rows: gameRows } = await tx.query(GAME_LIFECYCLE_SQL, [gameId]);
      const lifecycle = gameRows[0]?.lifecycle as
        "lobby" | "live" | "ended" | undefined;
      if (lifecycle === undefined || !isLobbyPhase(lifecycle)) {
        return { ok: false, reason: "lobby_closed" };
      }

      // 3. The target team must belong to this game (R4.1/R4.5 integrity).
      const { rows: teamRows } = await tx.query(TEAM_IN_GAME_SQL, [
        targetTeamId,
        gameId,
      ]);
      if (teamRows.length === 0) {
        return { ok: false, reason: "not_found" };
      }

      // 4. The requesting session must have a player row in this game. A member
      //    with no player (e.g. the admin who never joined) has nothing to
      //    associate; treat as not a (player) member.
      const player = await playerForSession(tx, gameId, session.sessionId);
      if (player === null) {
        return { ok: false, reason: "not_member" };
      }

      // 5. Associate the player with the target team (R4.1/R4.5) + exactly one
      //    team_changed event (R4.6, R6.1). fromTeamId is null on first select.
      await tx.query(UPDATE_PLAYER_TEAM_SQL, [targetTeamId, player.playerId]);

      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.teamChanged,
        actor: { kind: "team", teamId: targetTeamId },
        payload: {
          playerId: player.playerId,
          fromTeamId: player.teamId,
          toTeamId: targetTeamId,
        },
      });

      return { ok: true, seq: event.seq };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch (err) {
    // The transaction rolled back: association unchanged, log unchanged.
    const message =
      err instanceof Error
        ? err.message
        : "team selection could not be applied";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
