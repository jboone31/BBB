/**
 * Wireframe targeting card-play route (design.md §5 "the one server route",
 * §Request flow; Task 7.1). The single genuinely-wired mutation of the In-Game
 * Landing Wireframe feature.
 *
 * POST /api/games/{gameId}/wireframe-card-play — a Player confirms a wireframe
 * targeting card play against another Team. The route wraps **exactly one**
 * `wireframe_card_played` event in one transaction (`withTransaction`), so the
 * committed event propagates over the existing Realtime backbone and the target
 * Team's clients show an immediate `Targeted_Notification` (R7.1, R7.2).
 *
 * This is the feature's one exception to "wireframe, not the game": it writes a
 * real event. It still enforces **nothing** — no score/claim mutation and no
 * blocking of any Region or control (R7.6). The event exists only to exercise the
 * real-time delivery path so the future targeting feature's shape is validated.
 *
 * Mirrors `app/api/games/[gameId]/teams/select/route.ts`:
 *   - `runtime = "nodejs"` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser.
 *
 * Flow (all inside the transaction against the `FOR UPDATE`-locked game row):
 *   1. `requireSession` — no valid session writes nothing (R8.3 → 401
 *      `missing_session`).
 *   2. `assertMember` — non-members are rejected (→ 403 `not_member`); locks the
 *      game row `FOR UPDATE`.
 *   3. The requesting session must have a player row (with a Team) in this game —
 *      that Team is the caster (→ 403 `not_member` if none).
 *   4. The target Team must belong to this game and differ from the caster's own
 *      Team (→ 404 `not_found`).
 *   5. `appendEvent` exactly one `wireframe_card_played`
 *      `{ castingTeamId, targetTeamId, cardId }` with the caster's Team as actor.
 *   6. Any throw rolls back — no event written; the route returns a structured
 *      failure (500) so the client shows "not delivered" (R7.7).
 *
 * Requirements: 7.1, 7.6, 7.7.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";

import {
  applied,
  assertMember,
  type LobbyErrorReason,
  notApplied,
  requireSession,
} from "@/app/api/games/_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the wireframe card-play route. */
interface WireframeCardPlayBody {
  /** The placeholder card being played (opaque to the server). */
  readonly cardId?: unknown;
  /** The target Team id the card is played on. */
  readonly targetTeamId?: unknown;
}

/**
 * Confirm the target team belongs to this game (composite integrity). Positional
 * parameters: $1 team_id, $2 game_id.
 */
const TEAM_IN_GAME_SQL = `
select 1
from teams
where id = $1 and game_id = $2
limit 1
`;

/**
 * Read the requesting session's player row (its current team) in this game, so
 * the event can record the caster's Team. Positional parameters: $1 game_id,
 * $2 session_id.
 */
const PLAYER_FOR_SESSION_SQL = `
select id, team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

type PlayOutcome =
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
 * POST /api/games/[gameId]/wireframe-card-play
 *
 * Header: `x-bbb-session-id: <session>` (must be a Player of the game).
 * Body: `{ cardId: string, targetTeamId: string }`.
 *
 * Responses:
 *   - 200 `{ applied: true, seq }` — one `wireframe_card_played` event written
 *     (R7.1); the client shows a wireframe acknowledgement (R6.6).
 *   - 401 `missing_session` — no valid session (R8.3).
 *   - 403 `not_member` — the session is not a member, or has no player/team.
 *   - 404 `not_found` — the target team is not in this game or equals own Team.
 *   - 500 `{ applied: false, error }` — the transaction rolled back, nothing
 *     written; the client shows "not delivered" (R7.7).
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

  let body: WireframeCardPlayBody;
  try {
    body = (await request.json()) as WireframeCardPlayBody;
  } catch {
    return notApplied("not_found");
  }
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  const targetTeamId =
    typeof body.targetTeamId === "string" ? body.targetTeamId.trim() : "";
  if (!cardId || !targetTeamId) {
    return notApplied("not_found");
  }

  // --- Membership + target validation + exactly one event ------------------
  try {
    const outcome = await withTransaction<PlayOutcome>(async (tx) => {
      // 1. Membership (R8.4/8.5) — locks the game row FOR UPDATE.
      const isMemberOfGame = await assertMember(tx, gameId, session.sessionId);
      if (!isMemberOfGame) {
        return { ok: false, reason: "not_member" };
      }

      // 2. The requesting session must have a player row with a Team in this
      //    game — that Team is the caster. A member with no player row, or a
      //    player not yet on a team, has no casting Team.
      const player = await playerForSession(tx, gameId, session.sessionId);
      if (player === null || player.teamId === null) {
        return { ok: false, reason: "not_member" };
      }
      const castingTeamId = player.teamId;

      // 3. The target Team must belong to this game and differ from the caster's
      //    own Team (R7 targets *another* Team; composite integrity).
      if (targetTeamId === castingTeamId) {
        return { ok: false, reason: "not_found" };
      }
      const { rows: teamRows } = await tx.query(TEAM_IN_GAME_SQL, [
        targetTeamId,
        gameId,
      ]);
      if (teamRows.length === 0) {
        return { ok: false, reason: "not_found" };
      }

      // 4. Append exactly one wireframe_card_played event with the caster's Team
      //    as actor (R7.1). No score/claim mutation, no blocking (R7.6).
      const event = await appendEvent(tx, {
        gameId,
        type: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
        actor: { kind: "team", teamId: castingTeamId },
        payload: {
          castingTeamId,
          targetTeamId,
          cardId,
        },
      });

      return { ok: true, seq: event.seq };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch (err) {
    // The transaction rolled back: no event written. The client shows "not
    // delivered" and no success acknowledgement (R7.7).
    const message =
      err instanceof Error
        ? err.message
        : "wireframe card play could not be applied";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
