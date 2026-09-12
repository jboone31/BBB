/**
 * Create-team route (design.md "Server routes", Component 1c; Task 15).
 *
 * POST /api/games/{gameId}/teams — a Player (any game member) creates a new Team
 * in a Game that is still in its lobby phase. The route wraps the pure
 * `decideCreateTeam` decision (`lib/lobby/team.ts`) in a single transaction
 * (`withTransaction`): it confirms membership, checks the lobby-phase gate, reads
 * the colors already used by the game's teams, lets `decideCreateTeam` gate on
 * the team-count bound and assign a distinct color, inserts the team, and appends
 * exactly one `team_created` event — all atomically (Req 4.6, 6.1). On any guard
 * rejection nothing is written and a structured `{ applied:false, error }` is
 * returned (Req 6.5).
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser
 *     (`lib/db/server.ts` is `server-only`).
 *
 * Auth (session-based Identity_Model, Req 8.4/8.5): the request must carry an
 * `x-bbb-session-id` header, and that session must be a **member** of the game
 * (its admin or a joined player) — creating a team does not require admin
 * identity (design.md server-routes table: "game member"). The membership check
 * runs in the same transaction as the read/insert, against the `FOR UPDATE`
 * -locked game row, so the lobby-phase and team-count decisions taken afterwards
 * cannot race a concurrent writer.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 6.1.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent } from "@/lib/events";
import { isLobbyPhase } from "@/lib/lobby/gate";
import { decideCreateTeam } from "@/lib/lobby/team";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import {
  applied,
  assertMember,
  type LobbyErrorReason,
  notApplied,
  requireSession,
} from "@/app/api/games/_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the create-team route. */
interface CreateTeamBody {
  /** The proposed team name (trimmed 1–100 chars; validated by `decideCreateTeam`). */
  readonly name?: unknown;
}

/**
 * Read the game's lifecycle inside the caller's transaction. `assertMember`
 * already took the `FOR UPDATE` lock on the game row, so this read sees the same
 * serialized state and cannot race a concurrent writer. Returns `null` when the
 * game row is absent (which `assertMember` would already have rejected as a
 * non-member).
 */
const GAME_LIFECYCLE_SQL = `
select lifecycle
from games
where id = $1
limit 1
`;

/** Read the colors already used by the game's teams (feeds `decideCreateTeam`). */
const EXISTING_COLORS_SQL = `
select color
from teams
where game_id = $1
`;

/** Insert the new team with its assigned color, returning the new id. */
const INSERT_TEAM_SQL = `
insert into teams (game_id, name, color)
values ($1, $2, $3)
returning id
`;

/**
 * POST /api/games/[gameId]/teams
 *
 * Body: `{ name: string }`; header `x-bbb-session-id: <session>` (must be a game
 * member).
 *
 * Responses:
 *   - 201 `{ applied: true, seq }` — the team was created; one `team_created`
 *     event written.
 *   - 401 missing session header.
 *   - 403 the session is not a member of this game.
 *   - 409 the game is not in its lobby phase (`lobby_closed`) or already has the
 *     maximum number of teams (`team_limit_reached`).
 *   - 400 the team name is empty/blank or exceeds 100 chars (`invalid_team_name`).
 *   - 500 the transaction failed and was rolled back (nothing applied).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // --- Parse + validate the request ---------------------------------------
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    // No game id in the path → treat as a non-member (mirrors the other routes,
    // which do not leak game existence).
    return notApplied("not_member");
  }

  let body: CreateTeamBody;
  try {
    body = (await request.json()) as CreateTeamBody;
  } catch {
    // A malformed body has no valid team name.
    return notApplied("invalid_team_name");
  }
  const name = typeof body.name === "string" ? body.name : "";

  // --- Membership + lobby-phase gate + atomic insert + one event -----------
  try {
    const result = await withTransaction<
      | { applied: true; seq: number }
      | { applied: false; reason: LobbyErrorReason }
    >(async (tx) => {
      // Membership (Req 8.4/8.5) — locks the game row FOR UPDATE.
      const isMemberOfGame = await assertMember(tx, gameId, session.sessionId);
      if (!isMemberOfGame) {
        return { applied: false, reason: "not_member" };
      }

      // Lobby-phase gate (Req 4.8) — read lifecycle under the same lock.
      const { rows: gameRows } = await tx.query(GAME_LIFECYCLE_SQL, [gameId]);
      const lifecycle = gameRows[0]?.lifecycle as
        "lobby" | "live" | "ended" | undefined;
      if (lifecycle === undefined || !isLobbyPhase(lifecycle)) {
        return { applied: false, reason: "lobby_closed" };
      }

      // Existing team colors feed the count gate + distinct-color assignment.
      const { rows: colorRows } = await tx.query(EXISTING_COLORS_SQL, [gameId]);
      const existingColors = colorRows.map((row) => String(row.color));

      // Pure decision (Req 4.2/4.3/4.4/4.7): count gate + name + color.
      const decision = decideCreateTeam(existingColors, name);
      if (!decision.ok) {
        return { applied: false, reason: decision.reason };
      }

      // Domain write: insert the team with its assigned distinct color.
      const trimmedName = name.trim();
      const { rows: teamRows } = await tx.query(INSERT_TEAM_SQL, [
        gameId,
        trimmedName,
        decision.color,
      ]);
      const teamId = String(teamRows[0]?.id);

      // EXACTLY ONE event, in the same transaction (Req 4.6/6.1). If this throws
      // (size, constraint, connectivity), the whole transaction rolls back: the
      // team insert above is undone and the log is unchanged.
      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.teamCreated,
        actor: "admin",
        payload: { teamId, name: trimmedName, color: decision.color },
      });

      return { applied: true, seq: event.seq };
    });

    if (result.applied) {
      // Success: team + its single event committed together (Req 6.4).
      return applied(result.seq, 201);
    }
    // Guard/validation rejection (Req 6.5): nothing was written.
    return notApplied(result.reason);
  } catch (err) {
    // The transaction rolled back: no team persisted, log unchanged. This is an
    // infrastructure failure (not a lobby guard), so it is reported as a 500
    // with the same `{ applied:false, error }` shape the guard rejections use.
    const message =
      err instanceof Error ? err.message : "team could not be created";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
