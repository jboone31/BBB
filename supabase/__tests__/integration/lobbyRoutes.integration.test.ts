/**
 * Task 23.2 — DB-backed integration tests for the lobby mutation routes
 * (bars, join, team create + select/switch, start).
 *
 * This suite drives the REAL Next.js POST route handlers end-to-end against a
 * live Postgres, then asserts the persisted rows AND the emitted `game_events`.
 * It follows the env-gated convention established by
 * `supabase/__tests__/playersTeamNullable.test.ts` and the `route.property.test`
 * suites:
 *
 *   - `describe.skipIf(!SUPABASE_DB_URL)` — the whole suite skips cleanly when
 *     no live database is configured, so the default `npm test` run stays green
 *     with no external dependency.
 *   - The route handlers and `@/lib/db/server` import `server-only`, which only
 *     resolves inside the Next.js bundler, so every server module is loaded
 *     LAZILY via dynamic import — when the suite is skipped none is evaluated.
 *   - Every game the suite creates is tracked and cascade-deleted in `afterAll`
 *     (deleting a game removes its teams/players/bars/events), so the run leaves
 *     the database as it found it.
 *
 * What is exercised (against the real POST handlers + live DB):
 *
 *   BARS  (POST /api/games/{id}/bars, admin)
 *     - designating by name records a start/finish bar and persists the
 *       designation + one `bars_designated` event (R2.1/R2.2/R2.7);
 *     - the designation is mutable while in the lobby — a second designation
 *       replaces the prior one (R2.5);
 *     - designating an unknown bar id is rejected `bar_not_found` (404) and
 *       leaves the existing designation unchanged (R2.4).
 *
 *   JOIN  (POST /api/games/{id}/join)
 *     - a matching Join_Code proceeds and records a Player with `team_id = null`
 *       (teamless, R3.1/R3.2/R3.7/R3.9) plus one `player_joined` event;
 *     - an unknown code is rejected `not_found` (404) and records no player.
 *
 *   TEAM  (POST /api/games/{id}/teams + /teams/select, member)
 *     - create records a team and writes exactly one `team_created` event;
 *     - the first selection sets `team_id` from null (R4.1) and writes exactly
 *       one `team_changed` event;
 *     - a switch replaces the association (R4.5) and writes exactly one more
 *       `team_changed` event.
 *
 *   START (POST /api/games/{id}/start, admin)
 *     - with 2 teams and both bars designated, start sets `lifecycle = live` +
 *       stamps `live_started_at` (R5.1/R5.2) and writes exactly one
 *       `game_started` event (R5.8);
 *     - a teamless Player present does NOT block start and stays teamless after
 *       (excluded, R5.9); the 2–4 bound counts teams only (R5.10).
 *
 * Validates: Requirements 2.1, 2.2, 2.4, 2.5, 2.7, 3.1, 3.2, 3.7, 3.9, 4.1,
 * 4.6, 5.1, 5.2, 5.8, 5.9, 5.10.
 */

import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Env gating: skip cleanly unless a live Postgres is configured.
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

const SESSION_HEADER = "x-bbb-session-id";

// ---------------------------------------------------------------------------
// Lazy server-module handles — only imported when the live-DB suite runs.
//
// The route handlers and `lib/db/server` import `server-only`, which only
// resolves inside the Next.js bundler; dynamic import keeps them out of the
// default (skipped) run.
// ---------------------------------------------------------------------------

type CreateRoute = typeof import("@/app/api/games/route");
type BarsRoute = typeof import("@/app/api/games/[gameId]/bars/route");
type JoinRoute = typeof import("@/app/api/games/[gameId]/join/route");
type TeamsRoute = typeof import("@/app/api/games/[gameId]/teams/route");
type SelectRoute = typeof import("@/app/api/games/[gameId]/teams/select/route");
type StartRoute = typeof import("@/app/api/games/[gameId]/start/route");
type ServerDb = typeof import("@/lib/db/server");

let createRoute: CreateRoute | undefined;
let barsRoute: BarsRoute | undefined;
let joinRoute: JoinRoute | undefined;
let teamsRoute: TeamsRoute | undefined;
let selectRoute: SelectRoute | undefined;
let startRoute: StartRoute | undefined;
let serverDb: ServerDb | undefined;

async function routes(): Promise<{
  create: CreateRoute;
  bars: BarsRoute;
  join: JoinRoute;
  teams: TeamsRoute;
  select: SelectRoute;
  start: StartRoute;
}> {
  createRoute ??= await import("@/app/api/games/route");
  barsRoute ??= await import("@/app/api/games/[gameId]/bars/route");
  joinRoute ??= await import("@/app/api/games/[gameId]/join/route");
  teamsRoute ??= await import("@/app/api/games/[gameId]/teams/route");
  selectRoute ??= await import("@/app/api/games/[gameId]/teams/select/route");
  startRoute ??= await import("@/app/api/games/[gameId]/start/route");
  return {
    create: createRoute,
    bars: barsRoute,
    join: joinRoute,
    teams: teamsRoute,
    select: selectRoute,
    start: startRoute,
  };
}

async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

// ---------------------------------------------------------------------------
// Request builders + route-context helper
// ---------------------------------------------------------------------------

/** Route handlers receive `context.params` as a Promise of the path params. */
function ctx(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

/** Build a POST request carrying the session header and an optional JSON body. */
function post(sessionId: string, body?: unknown): Request {
  return new Request("http://localhost/api/games/x", {
    method: "POST",
    headers: {
      [SESSION_HEADER]: sessionId,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// DB read helpers (privileged owner connection, via withTransaction)
// ---------------------------------------------------------------------------

/** Count `game_events` of a given type for a game. */
async function eventCount(gameId: string, eventType: string): Promise<number> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select count(*)::int as n
         from game_events
        where game_id = $1 and event_type = $2`,
      [gameId, eventType],
    );
    return Number((rows[0] as { n: number }).n);
  });
}

/** Read the game's lifecycle + designation + go-live timestamp. */
async function readGame(gameId: string): Promise<{
  lifecycle: string;
  startBarId: string | null;
  finishBarId: string | null;
  liveStartedAt: unknown;
}> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select lifecycle, start_bar_id, finish_bar_id, live_started_at
         from games where id = $1`,
      [gameId],
    );
    const row = rows[0] as {
      lifecycle: string;
      start_bar_id: string | null;
      finish_bar_id: string | null;
      live_started_at: unknown;
    };
    return {
      lifecycle: String(row.lifecycle),
      startBarId: row.start_bar_id == null ? null : String(row.start_bar_id),
      finishBarId: row.finish_bar_id == null ? null : String(row.finish_bar_id),
      liveStartedAt: row.live_started_at,
    };
  });
}

/** Read a player's persisted `team_id` (null when teamless) by player id. */
async function readPlayerTeam(playerId: string): Promise<string | null> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select team_id from players where id = $1`,
      [playerId],
    );
    const row = rows[0] as { team_id: string | null } | undefined;
    return row && row.team_id != null ? String(row.team_id) : null;
  });
}

/** Insert a bar directly (owner connection) and return its id. */
async function insertBar(gameId: string, name: string): Promise<string> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into bars (game_id, name) values ($1, $2) returning id`,
      [gameId, name],
    );
    return String((rows[0] as { id: string }).id);
  });
}

// ---------------------------------------------------------------------------
// Fixture: create a fresh game via the REAL create route.
//
// The create route mints a unique Join_Code and records the admin session, so
// the fixture returns everything the downstream routes need. Each created game
// id is tracked for cascade cleanup.
// ---------------------------------------------------------------------------

const createdGameIds: string[] = [];

interface GameFixture {
  readonly gameId: string;
  readonly joinCode: string;
  readonly adminSessionId: string;
}

async function createGame(): Promise<GameFixture> {
  const { create } = await routes();
  const adminSessionId = `it-admin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const response = await create.POST(post(adminSessionId));
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    applied: boolean;
    gameId: string;
    joinCode: string;
  };
  expect(body.applied).toBe(true);
  createdGameIds.push(body.gameId);
  return {
    gameId: body.gameId,
    joinCode: body.joinCode,
    adminSessionId,
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "lobby routes DB-backed integration (Task 23.2)",
  () => {
    afterAll(async () => {
      if (!serverDb) return;
      const { withTransaction, closeDb } = serverDb;
      try {
        if (createdGameIds.length > 0) {
          await withTransaction(async (tx) => {
            // Cascade-delete removes each game plus its teams/players/bars/events.
            await tx.query(`delete from games where id = any($1::uuid[])`, [
              createdGameIds,
            ]);
            return undefined;
          });
        }
      } catch {
        /* best-effort cleanup */
      }
      await closeDb();
    });

    // -----------------------------------------------------------------------
    // BARS
    // -----------------------------------------------------------------------

    it("bars: designates by name, is mutable in lobby, and rejects an unknown bar id (R2.1/R2.2/R2.4/R2.5/R2.7)", async () => {
      const { bars } = await routes();
      const game = await createGame();

      // Designate start + finish by name (route creates the bar rows).
      const res1 = await bars.POST(
        post(game.adminSessionId, {
          startBarName: "Start Tavern",
          finishBarName: "Finish Line Pub",
        }),
        ctx(game.gameId),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { applied: boolean; seq: number };
      expect(body1.applied).toBe(true);

      const after1 = await readGame(game.gameId);
      expect(after1.startBarId).not.toBeNull();
      expect(after1.finishBarId).not.toBeNull();
      expect(after1.startBarId).not.toBe(after1.finishBarId);
      // Exactly one bars_designated event so far (R2.7).
      expect(await eventCount(game.gameId, "bars_designated")).toBe(1);

      const firstStart = after1.startBarId;
      const firstFinish = after1.finishBarId;

      // Mutable in the lobby: re-designate the start side by name; it replaces
      // the prior start designation (R2.5), leaving finish unchanged.
      const res2 = await bars.POST(
        post(game.adminSessionId, { startBarName: "New Start Bar" }),
        ctx(game.gameId),
      );
      expect(res2.status).toBe(200);

      const after2 = await readGame(game.gameId);
      expect(after2.startBarId).not.toBe(firstStart); // replaced
      expect(after2.finishBarId).toBe(firstFinish); // untouched side kept
      expect(await eventCount(game.gameId, "bars_designated")).toBe(2);

      // Unknown bar id → bar_not_found (404); designation is left unchanged (R2.4).
      const res3 = await bars.POST(
        post(game.adminSessionId, {
          startBarId: "00000000-0000-0000-0000-000000000000",
        }),
        ctx(game.gameId),
      );
      expect(res3.status).toBe(404);
      const body3 = (await res3.json()) as { applied: boolean; error: string };
      expect(body3.applied).toBe(false);
      expect(body3.error).toBe("bar_not_found");

      const after3 = await readGame(game.gameId);
      expect(after3.startBarId).toBe(after2.startBarId); // unchanged
      expect(after3.finishBarId).toBe(after2.finishBarId);
      // No extra event written for the rejected designation.
      expect(await eventCount(game.gameId, "bars_designated")).toBe(2);
    });

    // -----------------------------------------------------------------------
    // JOIN
    // -----------------------------------------------------------------------

    it("join: matching code records a teamless player + one event; unknown code is rejected (R3.1/R3.2/R3.7/R3.9)", async () => {
      const { join } = await routes();
      const game = await createGame();

      // Unknown code → not_found (404), records no player.
      const playerSession = `it-player-${Date.now()}-a`;
      const badRes = await join.POST(
        post(playerSession, {
          joinCode: "ZZZZZZ", // valid shape, no matching game
          displayName: "Nope",
        }),
        ctx(game.gameId),
      );
      expect(badRes.status).toBe(404);
      const badBody = (await badRes.json()) as {
        applied: boolean;
        error: string;
      };
      expect(badBody.applied).toBe(false);
      expect(badBody.error).toBe("not_found");
      expect(await eventCount(game.gameId, "player_joined")).toBe(0);

      // Matching code → joins as a teamless player (team_id = null) + one event.
      const okRes = await join.POST(
        post(playerSession, {
          joinCode: game.joinCode,
          displayName: "  Ada  ", // trimmed to "Ada" by the route
        }),
        ctx(game.gameId),
      );
      expect(okRes.status).toBe(200);
      const okBody = (await okRes.json()) as {
        applied: boolean;
        seq: number | null;
        playerId: string;
        created: boolean;
      };
      expect(okBody.applied).toBe(true);
      expect(okBody.created).toBe(true);
      expect(typeof okBody.playerId).toBe("string");

      // Persisted player is teamless (R3.9) and carries the trimmed name.
      const { withTransaction } = await db();
      const persisted = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `select session_id, display_name, team_id
             from players where id = $1`,
          [okBody.playerId],
        );
        return rows[0] as {
          session_id: string;
          display_name: string;
          team_id: string | null;
        };
      });
      expect(String(persisted.session_id)).toBe(playerSession);
      expect(String(persisted.display_name)).toBe("Ada");
      expect(persisted.team_id).toBeNull();

      // Exactly one player_joined event (R4.6).
      expect(await eventCount(game.gameId, "player_joined")).toBe(1);
    });

    // -----------------------------------------------------------------------
    // TEAM create + select/switch
    // -----------------------------------------------------------------------

    it("team: create writes one event; first selection sets team from null, switch replaces it (R4.1/R4.5/R4.6)", async () => {
      const { join, teams, select } = await routes();
      const game = await createGame();

      // A player joins (teamless) so it has a player row to associate.
      const playerSession = `it-player-${Date.now()}-b`;
      const joinRes = await join.POST(
        post(playerSession, {
          joinCode: game.joinCode,
          displayName: "Grace",
        }),
        ctx(game.gameId),
      );
      expect(joinRes.status).toBe(200);
      const playerId = ((await joinRes.json()) as { playerId: string })
        .playerId;

      // Create two teams (as a member — the player above qualifies).
      const teamARes = await teams.POST(
        post(playerSession, { name: "Team Alpha" }),
        ctx(game.gameId),
      );
      expect(teamARes.status).toBe(201);
      const teamBRes = await teams.POST(
        post(playerSession, { name: "Team Bravo" }),
        ctx(game.gameId),
      );
      expect(teamBRes.status).toBe(201);
      // Exactly one team_created event per create (R4.6).
      expect(await eventCount(game.gameId, "team_created")).toBe(2);

      // Resolve the two team ids from the DB.
      const { withTransaction } = await db();
      const teamIds = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `select id, name from teams where game_id = $1 order by name`,
          [game.gameId],
        );
        return rows.map((r) => ({
          id: String((r as { id: string }).id),
          name: String((r as { name: string }).name),
        }));
      });
      const teamAlpha = teamIds.find((t) => t.name === "Team Alpha")!.id;
      const teamBravo = teamIds.find((t) => t.name === "Team Bravo")!.id;

      // Player is teamless before any selection (R3.9).
      expect(await readPlayerTeam(playerId)).toBeNull();

      // First selection: sets team_id from null (R4.1) + one team_changed event.
      const sel1 = await select.POST(
        post(playerSession, { teamId: teamAlpha }),
        ctx(game.gameId),
      );
      expect(sel1.status).toBe(200);
      expect(await readPlayerTeam(playerId)).toBe(teamAlpha);
      expect(await eventCount(game.gameId, "team_changed")).toBe(1);

      // Switch: replaces the association (R4.5) + one more team_changed event.
      const sel2 = await select.POST(
        post(playerSession, { teamId: teamBravo }),
        ctx(game.gameId),
      );
      expect(sel2.status).toBe(200);
      expect(await readPlayerTeam(playerId)).toBe(teamBravo);
      expect(await eventCount(game.gameId, "team_changed")).toBe(2);
    });

    // -----------------------------------------------------------------------
    // START
    // -----------------------------------------------------------------------

    it("start: goes live with 2 teams + both bars, writes one game_started, and leaves a teamless player teamless (R5.1/R5.2/R5.8/R5.9/R5.10)", async () => {
      const { join, teams, select, bars, start } = await routes();
      const game = await createGame();

      // Designate both bars (admin) so the start's bars gate passes (R5.5).
      const startBar = await insertBar(game.gameId, "S");
      const finishBar = await insertBar(game.gameId, "F");
      const barsRes = await bars.POST(
        post(game.adminSessionId, {
          startBarId: startBar,
          finishBarId: finishBar,
        }),
        ctx(game.gameId),
      );
      expect(barsRes.status).toBe(200);

      // Two teamed players (each on a distinct team) → team count = 2.
      const p1Session = `it-p1-${Date.now()}`;
      const p2Session = `it-p2-${Date.now()}`;
      const p1 = (
        (await (
          await join.POST(
            post(p1Session, { joinCode: game.joinCode, displayName: "P1" }),
            ctx(game.gameId),
          )
        ).json()) as { playerId: string }
      ).playerId;
      const p2 = (
        (await (
          await join.POST(
            post(p2Session, { joinCode: game.joinCode, displayName: "P2" }),
            ctx(game.gameId),
          )
        ).json()) as { playerId: string }
      ).playerId;

      // A THIRD player joins but never picks a team → stays teamless (R5.9).
      const teamlessSession = `it-teamless-${Date.now()}`;
      const teamlessPlayerId = (
        (await (
          await join.POST(
            post(teamlessSession, {
              joinCode: game.joinCode,
              displayName: "Teamless",
            }),
            ctx(game.gameId),
          )
        ).json()) as { playerId: string }
      ).playerId;

      // Create two teams and put p1/p2 on them.
      await teams.POST(post(p1Session, { name: "Reds" }), ctx(game.gameId));
      await teams.POST(post(p2Session, { name: "Blues" }), ctx(game.gameId));
      const { withTransaction } = await db();
      const teamRows = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `select id, name from teams where game_id = $1 order by name`,
          [game.gameId],
        );
        return rows.map((r) => ({
          id: String((r as { id: string }).id),
          name: String((r as { name: string }).name),
        }));
      });
      const reds = teamRows.find((t) => t.name === "Reds")!.id;
      const blues = teamRows.find((t) => t.name === "Blues")!.id;
      await select.POST(post(p1Session, { teamId: reds }), ctx(game.gameId));
      await select.POST(post(p2Session, { teamId: blues }), ctx(game.gameId));

      // Sanity: p1/p2 teamed, third player still teamless before start.
      expect(await readPlayerTeam(p1)).toBe(reds);
      expect(await readPlayerTeam(p2)).toBe(blues);
      expect(await readPlayerTeam(teamlessPlayerId)).toBeNull();

      // START (admin): a teamless player present does NOT block start (R5.9),
      // the 2–4 bound counts teams only (R5.10).
      const startRes = await start.POST(
        post(game.adminSessionId),
        ctx(game.gameId),
      );
      expect(startRes.status).toBe(200);
      const startBody = (await startRes.json()) as {
        applied: boolean;
        seq: number;
      };
      expect(startBody.applied).toBe(true);

      // Lifecycle live + live_started_at stamped (R5.1/R5.2).
      const afterStart = await readGame(game.gameId);
      expect(afterStart.lifecycle).toBe("live");
      expect(afterStart.liveStartedAt).not.toBeNull();

      // Exactly one game_started event (R5.8).
      expect(await eventCount(game.gameId, "game_started")).toBe(1);

      // The teamless player is excluded, not deleted, and stays teamless (R5.9).
      expect(await readPlayerTeam(teamlessPlayerId)).toBeNull();
    });
  },
);
