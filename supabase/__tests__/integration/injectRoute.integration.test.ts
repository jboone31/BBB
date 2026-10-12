/**
 * Dev inject — live integration (brawl-deck-architecture Task 10).
 *
 * Gated on SUPABASE_DB_URL. Two live checks:
 *   - With the committed DEV_CARD_INJECTION flag at its shipped value (false),
 *     the real inject route REFUSES the operation (404) against a real game —
 *     the server gate, not just the hidden UI (R5.3).
 *   - The persistence `injectCardToHand` helper, driven directly against
 *     Postgres, forces a card into hand and bypasses the hand-size limit (R5.2),
 *     visible in the folded projection.
 *
 * The route's "flag on" path is covered hermetically (route.test.ts mocks the
 * flag); flipping the committed constant for a live run is out of scope here.
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

async function injectRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/cards/inject/route")
> {
  return import("@/app/api/games/[gameId]/cards/inject/route");
}
async function persist(): Promise<typeof import("@/lib/cards/persistence")> {
  return import("@/lib/cards/persistence");
}
async function gameboard(): Promise<typeof import("@/lib/gameboard/events")> {
  return import("@/lib/gameboard/events");
}
async function eventsLib(): Promise<typeof import("@/lib/events")> {
  return import("@/lib/events");
}
async function devFlags(): Promise<typeof import("@/lib/config/devFlags")> {
  return import("@/lib/config/devFlags");
}

interface Fixture {
  readonly gameId: string;
  readonly teamId: string;
  readonly sessionId: string;
}

const createdGameIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const adminSession = `it-inject-admin-${randomUUID()}`;
  const sessionId = `it-inject-player-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now()) returning id`,
      [adminSession, `ITINJ${randomUUID().slice(0, 6)}`],
    );
    const gameId = String(game.rows[0]?.id);
    const team = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Inject Team', '#e6194b') returning id`,
      [gameId],
    );
    const teamId = String(team.rows[0]?.id);
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Inject Player')`,
      [gameId, teamId, sessionId],
    );
    return { gameId, teamId, sessionId };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
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

describe.skipIf(!DB_CONFIGURED)("dev inject (R5.2, R5.3)", () => {
  it(
    "the route refuses injection while the committed flag is off (R5.3)",
    async () => {
      const { isDevCardInjectionEnabled } = await devFlags();
      // This live check only asserts the SHIPPED behavior (flag false). If the
      // constant were flipped on a dev branch, skip rather than assert refusal.
      if (isDevCardInjectionEnabled()) {
        return;
      }
      const fixture = await createFixture();
      const { POST } = await injectRoute();
      const response = await POST(
        new Request(
          `http://localhost/api/games/${fixture.gameId}/cards/inject`,
          {
            method: "POST",
            headers: {
              "x-bbb-session-id": fixture.sessionId,
              "content-type": "application/json",
            },
            body: JSON.stringify({ slug: "go-piss-girl" }),
          },
        ),
        { params: Promise.resolve({ gameId: fixture.gameId }) },
      );
      expect(response.status).toBe(404);

      // Nothing was injected: no card_kept event exists.
      const board = await foldBoard(fixture.gameId);
      expect(board.cards.filter((c) => c.state === "hand")).toHaveLength(0);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    "injectCardToHand forces a card into hand, bypassing the hand limit (R5.2)",
    async () => {
      const fixture = await createFixture();
      const { withTransaction } = await db();
      const { injectCardToHand } = await persist();
      const ctx = { gameId: fixture.gameId, teamId: fixture.teamId };

      for (const slug of ["go-piss-girl", "moneybags", "wired"] as const) {
        const result = await withTransaction((tx) =>
          injectCardToHand(tx, ctx, slug),
        );
        expect(result.ok).toBe(true);
      }

      // Three cards in hand — over the normal max of 2.
      const board = await foldBoard(fixture.gameId);
      const mine = board.cards.filter(
        (c) => c.teamId === fixture.teamId && c.state === "hand",
      );
      expect(mine).toHaveLength(3);
    },
    DB_TEST_TIMEOUT_MS,
  );
});
