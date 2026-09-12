import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendEvent, type QueryRunner, type SqlRow } from "@/lib/events";
import { canStartGame, MAX_TEAMS, MIN_TEAMS } from "@/lib/gameend";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import { bothBarsDesignated, isLobbyPhase } from "@/lib/lobby/gate";

/**
 * Feature: game-setup-lobby, Property 16b: Start excludes teamless players and
 * counts only teams.
 *
 * For any Lobby roster of Players (some associated with a Team, some teamless)
 * over a Game with 2–4 Teams, starting the Game
 *   (a) evaluates the 2–4 start bound against the Team count ONLY, independently
 *       of any teamless Players, and
 *   (b) yields a started Game whose set of participating Players is exactly the
 *       Players with a non-null Team association at the moment of the
 *       `lobby → live` transition — every teamless Player is excluded.
 *
 * The start route (`app/api/games/[gameId]/start/route.ts`) enforces this by
 * counting `teams` rows for the `canStartGame` bound (never `players`) and by
 * transitioning `lobby → live` without touching player rows — so a `team_id =
 * null` player is neither counted toward the bound nor made a participant; it is
 * simply left unassociated (design.md §"Start-game teamless exclusion", R5.9/5.10).
 *
 * This suite property-tests that rule at two levels, matching the codebase's two
 * conventions:
 *
 *   1. A PURE TRANSACTIONAL MODEL (always runs, no database). A fake in-memory
 *      store + a `withTransaction`-like wrapper drives the SAME decision path the
 *      route uses: the locked-game read, the `count(*) from teams` query, the
 *      real `canStartGame`/`bothBarsDesignated` gates, and the REAL `appendEvent`
 *      writing one `game_started` event. The store holds a mixed teamed/teamless
 *      roster so both parts of the property can be asserted directly against the
 *      route's actual team-count SQL and go-live behavior.
 *
 *   2. A LIVE APPLY CHECK (env-gated, skips cleanly when SUPABASE_DB_URL is
 *      unset). Applies every migration to a throwaway schema on a real Postgres,
 *      seeds a game with 2–4 teams and a mix of teamed + teamless players, runs
 *      the same start decision (team-count bound + `lobby → live`) inside one
 *      transaction, and asserts the game goes live while teamless players remain
 *      teamless and unremoved (excluded, not deleted). Mirrors the gating in
 *      `supabase/__tests__/playersTeamNullable.test.ts`.
 *
 * Validates: Requirements 5.9, 5.10
 */

// ===========================================================================
// Part 1 — Pure transactional model (always runs)
// ===========================================================================

/** A modeled team row for the game under test. */
interface TeamRow {
  readonly id: string;
}

/** A modeled player row: teamless when `teamId` is null (R10.1 / R3.9). */
interface PlayerRow {
  readonly id: string;
  teamId: string | null;
}

/** A stored game_events row (snake_case columns, as a real driver returns). */
interface EventRow extends SqlRow {
  id: string;
  game_id: string;
  seq: number;
  event_type: string;
  actor_kind: string;
  actor_team_id: string | null;
  payload: unknown;
  created_at: string;
}

type Lifecycle = "lobby" | "live" | "ended";

const GAME_ID = "game-16b";

/**
 * A fake transactional store modeling one game, its teams, its players, and its
 * append-only event log. It answers exactly the statements the start decision
 * issues against it:
 *   - the locked-game read (lifecycle + bar designation),
 *   - `count(*) as team_count from teams`,
 *   - the `lobby → live` UPDATE, and
 *   - `appendEvent`'s lock+next-seq+insert CTE.
 * Player rows are held but never mutated by the start path — that is the point:
 * teamless players stay teamless through the transition.
 */
class FakeStore {
  lifecycle: Lifecycle = "lobby";
  liveStartedAt: string | null = null;
  private readonly teams: TeamRow[];
  private readonly players: PlayerRow[];
  private readonly events: EventRow[] = [];
  private nextId = 1;

  constructor(args: {
    lifecycle: Lifecycle;
    startBarId: string | null;
    finishBarId: string | null;
    teams: TeamRow[];
    players: PlayerRow[];
  }) {
    this.lifecycle = args.lifecycle;
    this.startBarId = args.startBarId;
    this.finishBarId = args.finishBarId;
    this.teams = args.teams.map((t) => ({ ...t }));
    this.players = args.players.map((p) => ({ ...p }));
  }

  startBarId: string | null;
  finishBarId: string | null;

  get eventCount(): number {
    return this.events.length;
  }

  /** Snapshot the player roster (id + team association) for before/after asserts. */
  playerSnapshot(): PlayerRow[] {
    return this.players.map((p) => ({ ...p }));
  }

  /** The set of participating player ids: exactly those with a non-null team. */
  participatingPlayerIds(): string[] {
    return this.players.filter((p) => p.teamId != null).map((p) => p.id);
  }

  /** The set of teamless player ids. */
  teamlessPlayerIds(): string[] {
    return this.players.filter((p) => p.teamId == null).map((p) => p.id);
  }

  runner(): QueryRunner {
    return {
      query: (sql: string, params: readonly unknown[] = []) =>
        Promise.resolve(this.dispatch(sql, params)),
    };
  }

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): { rows: SqlRow[] } {
    const text = sql.trim();

    // assertAdmin's ADMIN_CHECK_SQL: return the locked game row.
    if (text.startsWith("select") && text.includes("is_admin")) {
      return {
        rows: [
          {
            id: GAME_ID,
            lifecycle: this.lifecycle,
            admin_session_id: "admin-session",
            start_bar_id: this.startBarId,
            finish_bar_id: this.finishBarId,
            is_admin: true,
          },
        ],
      };
    }

    // TEAM_COUNT_SQL: count teams only (never players) — R5.10.
    if (text.startsWith("select") && text.includes("team_count")) {
      return { rows: [{ team_count: this.teams.length }] };
    }

    // GO_LIVE_SQL: lobby → live, stamp live_started_at. Players untouched.
    if (text.startsWith("update games")) {
      this.lifecycle = "live";
      this.liveStartedAt = new Date().toISOString();
      return { rows: [{ live_started_at: this.liveStartedAt }] };
    }

    // appendEvent: lock + next-seq + insert CTE.
    if (text.startsWith("with locked")) {
      const [
        gameId,
        eventType,
        actorKind,
        actorTeamId,
        payloadJson,
        createdAt,
      ] = params as [string, string, string, string | null, string, string];
      const seq =
        this.events.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      const row: EventRow = {
        id: `e${this.nextId++}`,
        game_id: gameId,
        seq,
        event_type: eventType,
        actor_kind: actorKind,
        actor_team_id: actorTeamId,
        payload: payloadJson,
        created_at: createdAt,
      };
      this.events.push(row);
      return { rows: [row] };
    }

    throw new Error(`FakeStore: unexpected SQL: ${text.slice(0, 40)}`);
  }
}

/** Team-count SQL the route runs — matched by the FakeStore dispatcher. */
const TEAM_COUNT_SQL = `select count(*)::int as team_count from teams where game_id = $1`;
/** Admin/lock read SQL — matched by the FakeStore dispatcher (contains is_admin). */
const ADMIN_CHECK_SQL = `select id, lifecycle, admin_session_id, start_bar_id, finish_bar_id, (admin_session_id = $2) as is_admin from games where id = $1 for update`;
/** Go-live SQL — matched by the FakeStore dispatcher. */
const GO_LIVE_SQL = `update games set lifecycle = 'live', live_started_at = now() where id = $1 returning live_started_at`;

/** A `withTransaction`-like wrapper: run against the store's runner. */
async function withTransaction<T>(
  store: FakeStore,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  return fn(store.runner());
}

type StartOutcome =
  | {
      readonly ok: false;
      readonly reason:
        "not_in_lobby" | "min_teams" | "max_teams" | "bars_missing";
    }
  | { readonly ok: true; readonly seq: number };

/**
 * The start decision, mirroring the route's ordered guards but driving the same
 * SQL/gates against the FakeStore. Counts teams only (R5.10) and transitions
 * `lobby → live` without touching players (R5.9).
 */
async function decideStart(store: FakeStore): Promise<StartOutcome> {
  return withTransaction(store, async (tx) => {
    const { rows: gameRows } = await tx.query(ADMIN_CHECK_SQL, [
      GAME_ID,
      "admin-session",
    ]);
    const game = gameRows[0];
    const lifecycle = String(game.lifecycle) as Lifecycle;

    if (!isLobbyPhase(lifecycle)) {
      return { ok: false, reason: "not_in_lobby" };
    }

    const { rows: teamRows } = await tx.query(TEAM_COUNT_SQL, [GAME_ID]);
    const teamCount = Number(teamRows[0]?.team_count ?? 0);
    if (!canStartGame(teamCount)) {
      const reason = teamCount < MIN_TEAMS ? "min_teams" : "max_teams";
      return { ok: false, reason };
    }

    const startBarId =
      game.start_bar_id == null ? null : String(game.start_bar_id);
    const finishBarId =
      game.finish_bar_id == null ? null : String(game.finish_bar_id);
    if (!bothBarsDesignated(startBarId, finishBarId)) {
      return { ok: false, reason: "bars_missing" };
    }

    const { rows: liveRows } = await tx.query(GO_LIVE_SQL, [GAME_ID]);
    const liveStartedAtIso = String(liveRows[0]?.live_started_at);

    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.gameStarted,
      actor: "admin",
      payload: { liveStartedAt: liveStartedAtIso },
    });
    return { ok: true, seq: event.seq };
  });
}

// --- Generators ------------------------------------------------------------

/** A roster: `teamCount` teams (spanning below/at/above the 2–4 bound) plus a
 *  mix of teamed and teamless players. Teamed players reference a real team. */
const rosterArb = fc
  .record({
    // Team counts spanning 0..MAX_TEAMS+2 so the bound is exercised on both sides.
    teamCount: fc.integer({ min: 0, max: MAX_TEAMS + 2 }),
    teamedCount: fc.integer({ min: 0, max: 6 }),
    teamlessCount: fc.integer({ min: 0, max: 6 }),
  })
  .map(({ teamCount, teamedCount, teamlessCount }) => {
    const teams: TeamRow[] = Array.from({ length: teamCount }, (_, i) => ({
      id: `team-${i}`,
    }));
    const players: PlayerRow[] = [];
    let pid = 0;
    for (let i = 0; i < teamedCount; i++) {
      // Only assign to a real team when one exists; otherwise this "teamed"
      // player is effectively teamless (no team to reference).
      const teamId = teams.length > 0 ? teams[i % teams.length].id : null;
      players.push({ id: `p-${pid++}`, teamId });
    }
    for (let i = 0; i < teamlessCount; i++) {
      players.push({ id: `p-${pid++}`, teamId: null });
    }
    return { teams, players };
  });

describe("start route — teamless exclusion & team-only count (Property 16b)", () => {
  it("(a) the 2–4 start bound is decided by the team count alone, regardless of teamless players", async () => {
    await fc.assert(
      fc.asyncProperty(rosterArb, async ({ teams, players }) => {
        const store = new FakeStore({
          lifecycle: "lobby",
          startBarId: "bar-start",
          finishBarId: "bar-finish",
          teams,
          players,
        });

        const outcome = await decideStart(store);

        // The outcome tracks canStartGame(teamCount) EXACTLY — teamless players
        // (and teamed players) never change whether the bound is met.
        const boundMet = teams.length >= MIN_TEAMS && teams.length <= MAX_TEAMS;
        expect(outcome.ok).toBe(boundMet);

        if (!boundMet) {
          // Rejected on the count: nothing written, game stays in lobby.
          expect(store.eventCount).toBe(0);
          expect(store.lifecycle).toBe("lobby");
          if (!outcome.ok) {
            expect(outcome.reason).toBe(
              teams.length < MIN_TEAMS ? "min_teams" : "max_teams",
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("(b) on a successful start the participants are exactly the non-null-team players; every teamless player is excluded and left untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Constrain to a valid team count so the game actually starts.
        rosterArb.filter(
          ({ teams }) => teams.length >= MIN_TEAMS && teams.length <= MAX_TEAMS,
        ),
        async ({ teams, players }) => {
          const store = new FakeStore({
            lifecycle: "lobby",
            startBarId: "bar-start",
            finishBarId: "bar-finish",
            teams,
            players,
          });

          const expectedParticipants = new Set(store.participatingPlayerIds());
          const expectedTeamless = new Set(store.teamlessPlayerIds());
          const before = store.playerSnapshot();

          const outcome = await decideStart(store);

          // The game went live with exactly one game_started event.
          expect(outcome.ok).toBe(true);
          expect(store.lifecycle).toBe("live");
          expect(store.eventCount).toBe(1);

          // Players were not mutated by the transition: teamless stay teamless,
          // teamed stay teamed — the roster is byte-for-byte unchanged.
          const after = store.playerSnapshot();
          expect(after).toEqual(before);

          // Participants == players with a non-null team; teamless are excluded.
          const participants = new Set(store.participatingPlayerIds());
          expect(participants).toEqual(expectedParticipants);
          for (const id of expectedTeamless) {
            expect(participants.has(id)).toBe(false);
          }
          // Excluded means "not a participant", never "removed".
          expect(
            store
              .playerSnapshot()
              .map((p) => p.id)
              .sort(),
          ).toEqual(before.map((p) => p.id).sort());
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Part 2 — Live apply check (env-gated, skips cleanly when SUPABASE_DB_URL unset)
// ===========================================================================
//
// `lib/db/server.ts` imports `server-only`, which only resolves inside the
// Next.js bundler, so it is loaded LAZILY (dynamic import) — when this suite is
// skipped the module is never evaluated and the default `npm test` run stays
// green outside a Next build. Mirrors the gating in
// `supabase/__tests__/playersTeamNullable.test.ts`.

const HERE = dirname(fileURLToPath(import.meta.url));
// app/api/games/[gameId]/start -> up 5 -> project root
const PROJECT_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS = join(PROJECT_ROOT, "supabase", "migrations");

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

/** Load every committed migration ordered by numeric prefix. */
function loadMigrationSqls(): string[] {
  const re = /^(\d+)_.+\.sql$/;
  return readdirSync(MIGRATIONS)
    .filter((f) => re.test(f))
    .sort((a, b) => Number(a.match(re)![1]) - Number(b.match(re)![1]))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"));
}

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "start against a live Postgres — teamless exclusion & team-only count (Req 5.9/5.10)",
  () => {
    const TEST_SCHEMA = `bbb_start_teamless_${Date.now()}`;

    afterAll(async () => {
      if (!serverDb) return;
      try {
        const { withTransaction } = serverDb;
        await withTransaction(async (tx) => {
          await tx.query(`drop schema if exists ${TEST_SCHEMA} cascade`, []);
          return undefined;
        });
      } catch {
        /* best-effort cleanup */
      }
      await serverDb.closeDb();
    });

    it("starts a game with 2 teams and a teamless player: game goes live, teamless player stays teamless and is not removed", async () => {
      const migrations = loadMigrationSqls();
      const { withTransaction } = await db();

      await withTransaction(async (tx) => {
        await tx.query(`drop schema if exists ${TEST_SCHEMA} cascade`, []);
        await tx.query(`create schema ${TEST_SCHEMA}`, []);
        await tx.query(`set local search_path = ${TEST_SCHEMA}, public`, []);

        for (const sql of migrations) {
          await tx.query(sql, []);
        }

        // Seed a lobby game with both bars designated.
        const g = await tx.query(
          `insert into games (admin_session_id, join_code, lifecycle)
             values ('admin-live', 'STARTAB', 'lobby') returning id`,
          [],
        );
        const gameId = (g.rows[0] as { id: string }).id;

        const barStart = await tx.query(
          `insert into bars (game_id, name) values ($1, 'Start') returning id`,
          [gameId],
        );
        const barFinish = await tx.query(
          `insert into bars (game_id, name) values ($1, 'Finish') returning id`,
          [gameId],
        );
        await tx.query(
          `update games set start_bar_id = $1, finish_bar_id = $2 where id = $3`,
          [
            (barStart.rows[0] as { id: string }).id,
            (barFinish.rows[0] as { id: string }).id,
            gameId,
          ],
        );

        // Two teams (satisfies the 2–4 bound counting teams only, R5.10).
        const tA = await tx.query(
          `insert into teams (game_id, name, color) values ($1, 'A', 'red') returning id`,
          [gameId],
        );
        const tB = await tx.query(
          `insert into teams (game_id, name, color) values ($1, 'B', 'blue') returning id`,
          [gameId],
        );
        const teamA = (tA.rows[0] as { id: string }).id;

        // One teamed player and one teamless player (R10.1 / R3.9).
        await tx.query(
          `insert into players (team_id, game_id, session_id, display_name)
             values ($1, $2, 'sess-teamed', 'Teamed')`,
          [teamA, gameId],
        );
        const teamless = await tx.query(
          `insert into players (team_id, game_id, session_id, display_name)
             values (null, $1, 'sess-teamless', 'Teamless') returning id`,
          [gameId],
        );
        const teamlessId = (teamless.rows[0] as { id: string }).id;
        void tB;

        // --- R5.10: the start bound counts teams only, independent of players.
        const countRows = await tx.query(
          `select count(*)::int as team_count from teams where game_id = $1`,
          [gameId],
        );
        const teamCount = Number(
          (countRows.rows[0] as { team_count: number }).team_count,
        );
        expect(teamCount).toBe(2);
        expect(canStartGame(teamCount)).toBe(true);

        // --- Perform the go-live transition (lobby → live), players untouched.
        await tx.query(
          `update games set lifecycle = 'live', live_started_at = now() where id = $1`,
          [gameId],
        );
        await appendEvent(tx, {
          gameId,
          type: LOBBY_EVENT_TYPES.gameStarted,
          actor: "admin",
          payload: { note: "live" },
        });

        // The game is live.
        const liveRows = await tx.query(
          `select lifecycle, live_started_at from games where id = $1`,
          [gameId],
        );
        const live = liveRows.rows[0] as {
          lifecycle: string;
          live_started_at: unknown;
        };
        expect(String(live.lifecycle)).toBe("live");
        expect(live.live_started_at).not.toBeNull();

        // --- R5.9: the teamless player is excluded, not removed, and still teamless.
        const still = await tx.query(
          `select id, team_id from players where id = $1`,
          [teamlessId],
        );
        expect(still.rows).toHaveLength(1);
        expect(
          (still.rows[0] as { team_id: string | null }).team_id,
        ).toBeNull();

        // Exactly one game_started event was appended for the transition.
        const eventRows = await tx.query(
          `select count(*)::int as n from game_events
             where game_id = $1 and event_type = 'game_started'`,
          [gameId],
        );
        expect(Number((eventRows.rows[0] as { n: number }).n)).toBe(1);

        return undefined;
      });
    });
  },
);
