import { NextResponse } from "next/server";

import { appendEvent } from "@/lib/events";
import { withTransaction } from "@/lib/db/server";
import { requireSession } from "@/app/api/games/_shared";

export const runtime = "nodejs";

const PLAYER_SQL = `
select p.id
from players p
join games g on g.id = p.game_id
where p.game_id = $1
  and p.session_id = $2
  and g.lifecycle = 'live'
  and g.admin_session_id <> $2
for update
`;

const DELETE_PLAYER_SQL = `
delete from players
where id = $1
returning id
`;

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) {
    return NextResponse.json(
      { applied: false, error: session.reason },
      { status: 401 },
    );
  }
  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return NextResponse.json(
      { applied: false, error: "gameId is required" },
      { status: 400 },
    );
  }

  try {
    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query(PLAYER_SQL, [gameId, session.sessionId]);
      const playerId = rows[0]?.id;
      if (playerId === undefined) {
        return {
          applied: false as const,
          error: "player is not an active participant",
        };
      }
      const deleted = await tx.query(DELETE_PLAYER_SQL, [playerId]);
      if (deleted.rows.length !== 1) {
        throw new Error("leave transition did not remove the player");
      }
      const event = await appendEvent(tx, {
        gameId,
        type: "player_left",
        actor: "system",
        payload: { playerId: String(playerId) },
      });
      return { applied: true as const, seq: event.seq };
    });
    return NextResponse.json(result, { status: result.applied ? 200 : 409 });
  } catch {
    return NextResponse.json(
      { applied: false, error: "leave transition could not be applied" },
      { status: 500 },
    );
  }
}
