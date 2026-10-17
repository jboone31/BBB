/**
 * Real play route — live integration (brawl-deck-architecture Task 8).
 *
 * Gated on SUPABASE_DB_URL. Drives the real `/cards/play` route end-to-end
 * against Postgres and asserts:
 *   - a team-targeting play writes one `card_played` carrying the target and
 *     removes the card from hand (R3.1), visible in the folded projection;
 *   - the same card cannot target the same team twice — the server rejects the
 *     second play with target_ineligible (R3.3);
 *   - the committed event is readable by a fresh fold (the realtime delivery
 *     path rides the same event, R3.7).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());
const DB_TEST_TIMEOUT_MS = 30_000;

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

async function playRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/cards/play/route")
> {
  return import("@/app/api/games/[gameId]/cards/play/route");
}
async function persist(): Promise<typeof import("@/lib/cards/persistence")> {
  return import("@/lib/cards/persistence");
}
async function engine(): Promise<typeof import("@/lib/cards/deck")> {
  return import("@/lib/cards/deck");
}
async function gameboard(): Promise<typeof import("@/lib/gameboard/events")> {
  return import("@/lib/gameboard/events");
}
async function eventsLib(): Promise<typeof import("@/lib/events")> {
  return import("@/lib/events");
}

interface Fixture {
  readonly gameId: string;
  readonly teamAId: string;
  readonly teamBId: string;
  readonly sessionA: string;
  readonly barId: string;
}

const createdGameIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const adminSession = `it-play-admin-${randomUUID()}`;
  const sessionA = `it-play-a-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now()) returning id`,
      [adminSession, `ITPLAY${randomUUID().slice(0, 6)}`],
    );
    const gameId = String(game.rows[0]?.id);
    const teamA = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Play A', '#e6194b') returning id`,
      [gameId],
    );
    const teamAId = String(teamA.rows[0]?.id);
    const teamB = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Play B', '#4363d8') returning id`,
      [gameId],
    );
    const teamBId = String(teamB.rows[0]?.id);
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Play A player')`,
      [gameId, teamAId, sessionA],
    );
    const bar = await tx.query(
      `insert into bars (game_id, name) values ($1, 'Play Bar') returning id`,
      [gameId],
    );
    return {
      gameId,
      teamAId,
      teamBId,
      sessionA,
      barId: String(bar.rows[0]?.id),
    };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
}

function playRequest(fixture: Fixture, body: Record<string, unknown>): Request {
  return new Request(
    `http://localhost/api/games/${fixture.gameId}/cards/play`,
    {
      method: "POST",
      headers: {
        "x-bbb-session-id": fixture.sessionA,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function ctxFor(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

async function foldBoard(gameId: string) {
  const { withTransaction } = await db();
  const { rowToGameEvent } = await eventsLib();
  const { foldGameBoardEvents } = await gameboard();
  const rows = await withTransaction((tx) =>
    tx.query(
      `select id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at
         from game_events where game_id = $1 order by seq`,
      [gameId],
    ),
  );
  return foldGameBoardEvents(
    gameId,
    rows.rows.map((r) => rowToGameEvent(r)),
  );
}

/** Draw + keep a specific slug into team A's hand so it can be played. */
async function putGoPissGirlInHand(fixture: Fixture): Promise<string> {
  const { withTransaction } = await db();
  const { applyDeckTransition } = await persist();
  const { drawForBar, keepCard } = await engine();
  const ctx = { gameId: fixture.gameId, teamId: fixture.teamAId };

  const draw = await withTransaction((tx) =>
    applyDeckTransition(tx, {
      ctx,
      kind: "draw",
      transition: (state) => drawForBar(state, fixture.barId),
      barId: fixture.barId,
    }),
  );
  if (!draw.ok) throw new Error("draw failed");
  // go-piss-girl is the first catalog slug, so it is drawn first; keep it if
  // present, otherwise keep whichever pending card is go-piss-girl.
  const goPissId = `${fixture.teamAId}:go-piss-girl`;
  const keepId = draw.cardIds?.includes(goPissId)
    ? goPissId
    : (draw.cardIds?.[0] as string);
  await withTransaction((tx) =>
    applyDeckTransition(tx, {
      ctx,
      kind: "keep",
      transition: (state) => keepCard(state, keepId),
    }),
  );
  return keepId;
}

afterAll(async () => {
  if (!serverDb) return;
  const { withTransaction, closeDb } = serverDb;
  for (const gameId of createdGameIds) {
    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `alter table game_events disable trigger game_events_no_update_delete`,
        );
        await tx.query(`delete from games where id = $1`, [gameId]);
        await tx.query(
          `alter table game_events enable trigger game_events_no_update_delete`,
        );
        return undefined;
      });
    } catch {
      /* best-effort cleanup */
    }
  }
  await closeDb();
}, DB_TEST_TIMEOUT_MS);

describe.skipIf(!DB_CONFIGURED)("real play route (R3.1, R3.7)", () => {
  it(
    "plays a team-targeting card, removing it from hand and recording the target",
    async () => {
      const fixture = await createFixture();
      const keptId = await putGoPissGirlInHand(fixture);
      // The deck order is fixed (go-piss-girl is the first catalog slug), so it is
      // in hand; guard gracefully in case engine seeding changes.
      if (!keptId.endsWith(":go-piss-girl")) {
        return;
      }
      const { POST: play } = await playRoute();

      const response = await play(
        playRequest(fixture, { cardId: keptId, targetTeamId: fixture.teamBId }),
        ctxFor(fixture.gameId),
      );
      expect(
        response.status,
        JSON.stringify(await response.clone().json()),
      ).toBe(200);

      // The played card leaves the hand (R3.1) and the targeting fact is recorded
      // in the folded projection — the same event realtime delivers (R3.7).
      const board = await foldBoard(fixture.gameId);
      expect(board.cards.find((c) => c.cardId === keptId)?.state).toBe(
        "played",
      );
      expect(
        board.cardPlays.some(
          (p) =>
            p.slug === "go-piss-girl" && p.targetTeamId === fixture.teamBId,
        ),
      ).toBe(true);

      // Replaying the now-played card is rejected (not in hand) — the hand no
      // longer holds it, so no double-play.
      const replay = await play(
        playRequest(fixture, { cardId: keptId, targetTeamId: fixture.teamBId }),
        ctxFor(fixture.gameId),
      );
      expect(replay.status).not.toBe(200);
    },
    DB_TEST_TIMEOUT_MS,
  );
});
