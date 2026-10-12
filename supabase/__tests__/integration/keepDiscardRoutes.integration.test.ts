/**
 * Keep / discard routes — live integration (brawl-deck-architecture Task 5).
 *
 * Gated on SUPABASE_DB_URL. Drives the real keep + discard route handlers
 * end-to-end against Postgres, then folds the game's event log through the board
 * projection (`foldGameBoardEvents`) to prove the projection reflects the
 * transition — exactly what the Game_Board client renders.
 *
 * Coverage:
 *   - keep moves exactly one pending card to `hand` and discards the rest (R1.2);
 *   - discard frees a held card's slot (R2.4);
 *   - both are visible in the folded board projection (R4.2).
 *
 * The hermetic route tests (`route.test.ts` beside each route) cover auth and
 * rejection mapping with the persistence helper mocked; this suite is the live,
 * unmocked path.
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

type KeepRoute = typeof import("@/app/api/games/[gameId]/cards/keep/route");
type DiscardRoute =
  typeof import("@/app/api/games/[gameId]/cards/discard/route");
async function keepRoute(): Promise<KeepRoute> {
  return import("@/app/api/games/[gameId]/cards/keep/route");
}
async function discardRoute(): Promise<DiscardRoute> {
  return import("@/app/api/games/[gameId]/cards/discard/route");
}

type Persistence = typeof import("@/lib/cards/persistence");
async function persist(): Promise<Persistence> {
  return import("@/lib/cards/persistence");
}

type Deck = typeof import("@/lib/cards/deck");
async function engine(): Promise<Deck> {
  return import("@/lib/cards/deck");
}

type Gameboard = typeof import("@/lib/gameboard/events");
async function gameboard(): Promise<Gameboard> {
  return import("@/lib/gameboard/events");
}

type Events = typeof import("@/lib/events");
async function eventsLib(): Promise<Events> {
  return import("@/lib/events");
}

interface Fixture {
  readonly gameId: string;
  readonly teamId: string;
  readonly sessionId: string;
  readonly barId: string;
}

const createdGameIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const adminSession = `it-keepdisc-admin-${randomUUID()}`;
  const sessionId = `it-keepdisc-player-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now())
       returning id`,
      [adminSession, `ITKD${randomUUID().slice(0, 8)}`],
    );
    const gameId = String(game.rows[0]?.id);

    const team = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'KD Team', '#e6194b')
       returning id`,
      [gameId],
    );
    const teamId = String(team.rows[0]?.id);

    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'KD Player')`,
      [gameId, teamId, sessionId],
    );

    const bar = await tx.query(
      `insert into bars (game_id, name) values ($1, 'KD Bar') returning id`,
      [gameId],
    );

    return { gameId, teamId, sessionId, barId: String(bar.rows[0]?.id) };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
}

function keepRequest(fixture: Fixture, cardId: string): Request {
  return new Request(
    `http://localhost/api/games/${fixture.gameId}/cards/keep`,
    {
      method: "POST",
      headers: {
        "x-bbb-session-id": fixture.sessionId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cardId }),
    },
  );
}

function discardRequest(fixture: Fixture, cardId: string): Request {
  return new Request(
    `http://localhost/api/games/${fixture.gameId}/cards/discard`,
    {
      method: "POST",
      headers: {
        "x-bbb-session-id": fixture.sessionId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cardId }),
    },
  );
}

function ctxFor(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

/** Fold the game's whole event log into the board projection. */
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
  const events = rows.rows.map((r) => rowToGameEvent(r));
  return foldGameBoardEvents(gameId, events);
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

describe.skipIf(!DB_CONFIGURED)(
  "keep / discard routes (R1.2, R2.4, R4.2)",
  () => {
    it(
      "keep moves one pending card to hand and discards the rest; the board reflects it",
      async () => {
        const fixture = await createFixture();
        const { withTransaction } = await db();
        const { applyDeckTransition } = await persist();
        const { drawForBar } = await engine();
        const { POST: keep } = await keepRoute();

        // Seed a pending draw via the persistence helper (same path claims uses).
        const draw = await withTransaction((tx) =>
          applyDeckTransition(tx, {
            ctx: { gameId: fixture.gameId, teamId: fixture.teamId },
            kind: "draw",
            transition: (state) => drawForBar(state, fixture.barId),
            barId: fixture.barId,
          }),
        );
        expect(draw.ok).toBe(true);
        if (!draw.ok) return;
        const keptId = draw.cardIds?.[0] as string;

        const response = await keep(
          keepRequest(fixture, keptId),
          ctxFor(fixture.gameId),
        );
        expect(
          response.status,
          JSON.stringify(await response.clone().json()),
        ).toBe(200);

        const board = await foldBoard(fixture.gameId);
        const mine = board.cards.filter((c) => c.teamId === fixture.teamId);
        expect(mine.filter((c) => c.state === "hand")).toHaveLength(1);
        expect(mine.filter((c) => c.state === "discarded")).toHaveLength(1);
        expect(mine.filter((c) => c.state === "pending")).toHaveLength(0);
        expect(mine.find((c) => c.cardId === keptId)?.state).toBe("hand");
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "discard frees a held card's slot; the board reflects it",
      async () => {
        const fixture = await createFixture();
        const { withTransaction } = await db();
        const { applyDeckTransition } = await persist();
        const { drawForBar, keepCard } = await engine();
        const { POST: discard } = await discardRoute();

        const draw = await withTransaction((tx) =>
          applyDeckTransition(tx, {
            ctx: { gameId: fixture.gameId, teamId: fixture.teamId },
            kind: "draw",
            transition: (state) => drawForBar(state, fixture.barId),
            barId: fixture.barId,
          }),
        );
        if (!draw.ok) return;
        const keptId = draw.cardIds?.[0] as string;
        // Keep one so it is in hand, then discard it via the route.
        await withTransaction((tx) =>
          applyDeckTransition(tx, {
            ctx: { gameId: fixture.gameId, teamId: fixture.teamId },
            kind: "keep",
            transition: (state) => keepCard(state, keptId),
          }),
        );

        const response = await discard(
          discardRequest(fixture, keptId),
          ctxFor(fixture.gameId),
        );
        expect(
          response.status,
          JSON.stringify(await response.clone().json()),
        ).toBe(200);

        const board = await foldBoard(fixture.gameId);
        const mine = board.cards.filter((c) => c.teamId === fixture.teamId);
        expect(mine.find((c) => c.cardId === keptId)?.state).toBe("discarded");
        expect(mine.filter((c) => c.state === "hand")).toHaveLength(0);
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "rejects a keep with no pending draw (409 no_pending_draw)",
      async () => {
        const fixture = await createFixture();
        const { POST: keep } = await keepRoute();

        const response = await keep(
          keepRequest(fixture, `${fixture.teamId}:go-piss-girl`),
          ctxFor(fixture.gameId),
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          applied: false,
          error: "no_pending_draw",
        });
      },
      DB_TEST_TIMEOUT_MS,
    );
  },
);
