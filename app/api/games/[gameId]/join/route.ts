/**
 * Join-game route (design.md "Server routes", Component 1b; Task 15).
 *
 * POST /api/games/{gameId}/join — a Player joins a Game that is still in its
 * lobby phase by submitting a Join_Code and a display name. The route wraps the
 * pure validators (`isValidSubmittedCode`/`normalizeSubmittedCode` from
 * `lib/lobby/joinCode`, `validateDisplayName` from `lib/lobby/displayName`) in a
 * single transaction (`withTransaction`): it validates the submitted code shape,
 * confirms the game exists and matches the code, checks the lobby-phase gate,
 * validates the display name, then does a **read-first idempotent insert** on
 * `(game_id, session_id)` — returning the existing Player without a second
 * insert or event when the session already joined (R3.8/R8.2), otherwise
 * inserting one teamless Player (`team_id = null`, relies on migration 0008) and
 * appending exactly one `player_joined` event (R4.6, R6.1).
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser.
 *
 * Auth (session-based Identity_Model, Req 8.2/8.3): the request must carry an
 * `x-bbb-session-id` header. Any valid session may join (this is how a session
 * *becomes* a member); no prior membership is required.
 *
 * Flow (all inside the transaction against the `FOR UPDATE`-locked game row):
 *   1. `requireSession` — no valid session writes nothing (R8.3 → 401).
 *   2. submitted-code shape (R3.3) — reject before any DB lookup (→ 400).
 *   3. game lookup by id + matching Join_Code (R3.1/R3.2 → 404 not_found).
 *   4. lobby-phase gate (R3.4 → 409 lobby_closed).
 *   5. `validateDisplayName` (R3.5/R3.6 → 400 invalid_display_name).
 *   6. read-first idempotent insert of a teamless player (R3.7/R3.8/R3.9) +
 *      exactly one `player_joined` event on first join (R4.6, R6.1).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.6, 6.1, 8.2.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { validateDisplayName } from "@/lib/lobby/displayName";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";
import { isLobbyPhase } from "@/lib/lobby/gate";

import {
  type LobbyErrorReason,
  notApplied,
  requireSession,
} from "../../_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the join route. */
interface JoinBody {
  /** The submitted Join_Code (6–12 alphanumeric after trim + upcase, R3.3). */
  readonly joinCode?: unknown;
  /** The display name (trimmed 1–40 chars, R3.5/R3.6). */
  readonly displayName?: unknown;
}

/**
 * Look up the game whose id matches the path AND whose Join_Code matches the
 * submitted (normalized) code, locking the row `FOR UPDATE` so the lobby-phase
 * decision and the subsequent insert see serialized state (R3.1/R3.2).
 *
 * Positional parameters: $1 game_id, $2 normalized_join_code.
 */
const GAME_BY_ID_AND_CODE_SQL = `
select id, lifecycle
from games
where id = $1 and join_code = $2
for update
`;

/**
 * Read-first: the existing player for `(game_id, session_id)`, if any (R3.8).
 * The column list is matched by prefix in the join property-test model, so keep
 * it in sync with `join.property.test.ts`.
 *
 * Positional parameters: $1 game_id, $2 session_id.
 */
const EXISTING_PLAYER_SQL = `
select id, session_id, display_name, team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

/**
 * Insert one teamless player (R3.7/R3.9). `team_id` is null (relies on migration
 * 0008 making `players.team_id` nullable). Matched by prefix in the join
 * property-test model.
 *
 * Positional parameters: $1 game_id, $2 session_id, $3 display_name.
 */
const INSERT_PLAYER_SQL = `
insert into players (game_id, session_id, display_name, team_id)
values ($1, $2, $3, null)
returning id
`;

/**
 * The join success body: the shared `{ applied, seq }` shape (Req 6.4) plus the
 * player id and whether the player was freshly created. A repeat join
 * (`created: false`) reports `seq: null` since no event was appended (R3.8).
 */
interface JoinResult {
  readonly applied: true;
  readonly seq: number | null;
  readonly playerId: string;
  readonly created: boolean;
}

type JoinOutcome =
  JoinResult | { readonly applied: false; readonly reason: LobbyErrorReason };

/** Read an existing teamless/joined player row for the (game, session) pair. */
async function findExistingPlayer(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<string | null> {
  const { rows } = await tx.query(EXISTING_PLAYER_SQL, [gameId, sessionId]);
  const existing = rows[0];
  return existing ? String(existing.id) : null;
}

/**
 * POST /api/games/[gameId]/join
 *
 * Header: `x-bbb-session-id: <session>`.
 * Body: `{ joinCode: string, displayName: string }`.
 *
 * Responses:
 *   - 200 `{ applied: true, seq, playerId, created }` — joined (first join
 *     appends one `player_joined` event; a repeat returns the existing player
 *     with `seq: null` and `created: false`, R3.8).
 *   - 401 `missing_session` — no valid session (R8.3).
 *   - 400 `invalid_code` — submitted code is not 6–12 alphanumeric (R3.3).
 *   - 404 `not_found` — no game matches the id + code (R3.2).
 *   - 409 `lobby_closed` — the game is not in its lobby phase (R3.4).
 *   - 400 `invalid_display_name` — trimmed name is not 1–40 chars (R3.6).
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
    return notApplied("not_found");
  }

  let body: JoinBody;
  try {
    body = (await request.json()) as JoinBody;
  } catch {
    // A malformed body carries no valid code.
    return notApplied("invalid_code");
  }

  // --- Submitted-code shape (R3.3), before any DB lookup ------------------
  const rawCode = typeof body.joinCode === "string" ? body.joinCode : "";
  if (!isValidSubmittedCode(rawCode)) {
    return notApplied("invalid_code");
  }
  const normalizedCode = normalizeSubmittedCode(rawCode);
  const rawName = typeof body.displayName === "string" ? body.displayName : "";

  // --- Atomic lookup + guarded idempotent join + one appendEvent ----------
  try {
    const outcome = await withTransaction<JoinOutcome>(async (tx) => {
      // 1. Locate the game by id + matching code (R3.1/R3.2), locking the row.
      const { rows } = await tx.query(GAME_BY_ID_AND_CODE_SQL, [
        gameId,
        normalizedCode,
      ]);
      const gameRow = rows[0];
      if (!gameRow) {
        return { applied: false, reason: "not_found" };
      }
      const lifecycle = gameRow.lifecycle as "lobby" | "live" | "ended";

      // 2. Lobby-phase gate (R3.4).
      if (!isLobbyPhase(lifecycle)) {
        return { applied: false, reason: "lobby_closed" };
      }

      // 3. Display-name validation (R3.5/R3.6).
      const nameResult = validateDisplayName(rawName);
      if (!nameResult.ok) {
        return { applied: false, reason: "invalid_display_name" };
      }

      // 4. Read-first idempotent join (R3.8): a repeat returns the existing
      //    player and appends no event.
      const existingId = await findExistingPlayer(
        tx,
        gameId,
        session.sessionId,
      );
      if (existingId !== null) {
        return {
          applied: true,
          seq: null,
          playerId: existingId,
          created: false,
        };
      }

      // 5. First join: insert one teamless player (R3.7/R3.9) + exactly one
      //    player_joined event (R4.6, R6.1). If the append throws, the whole
      //    transaction rolls back and the player insert is undone.
      const { rows: inserted } = await tx.query(INSERT_PLAYER_SQL, [
        gameId,
        session.sessionId,
        nameResult.value,
      ]);
      const playerId = String(inserted[0]?.id);

      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.playerJoined,
        actor: "admin",
        payload: { playerId, displayName: nameResult.value },
      });

      return { applied: true, seq: event.seq, playerId, created: true };
    });

    if (!outcome.applied) {
      return notApplied(outcome.reason);
    }
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    // The transaction rolled back: no player, no event persisted (R6.2/R6.3).
    const message =
      err instanceof Error ? err.message : "join could not be applied";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
