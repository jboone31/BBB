import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { appendEvent, type QueryRunner, type SqlRow } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";

/**
 * Feature: game-setup-lobby, Property 18: Rollback leaves nothing persisted on
 * failure.
 *
 * *For any* lobby mutation, if either the domain write OR the event append
 * fails, the transaction rolls back so that neither the domain change nor any
 * `game_event` persists (design.md §Property 18; Req 6.2, 6.3).
 *
 * The real guarantee comes from `withTransaction` (lib/db/server.ts), which
 * runs the caller's domain write and `appendEvent` inside one postgres.js
 * `sql.begin(...)` transaction that COMMITs on normal return and ROLLBACKs on
 * any throw (exercised end-to-end by the DB-backed integration tests, Task 23).
 * Here we property-test the pure transactional model of that rule the way the
 * codebase already models route-level transactional properties (see
 * `lib/gameend/atomicEnd.property.test.ts` and
 * `app/api/games/[gameId]/join/join.property.test.ts`): a fake in-memory store
 * holding the lobby domain tables (`games`, `players`, `teams`) plus the
 * append-only `game_events` log, a `withTransaction`-like wrapper that snapshots
 * state on begin and restores it on throw, and the REAL `appendEvent` driven
 * through a fake QueryRunner.
 *
 * Two independent failure injection points model the two clauses of the
 * requirement:
 *   - `failDomainWrite` — the domain INSERT throws (Req 6.3), so the append is
 *     never reached; nothing must persist.
 *   - `failEventWrite`  — the domain INSERT succeeds but `appendEvent` throws
 *     (Req 6.2), so the already-written domain row must be rolled back too.
 * A fast-check-controlled flag chooses which (if any) step fails for each step,
 * and every modeled lobby mutation — create game, join player, create team —
 * must be all-or-nothing.
 *
 * Validates: Requirements 6.2, 6.3
 */

// ---------------------------------------------------------------------------
// Fake in-memory transactional store: lobby domain tables + event log
// ---------------------------------------------------------------------------

interface GameRow extends SqlRow {
  id: string;
  admin_session_id: string;
}

interface PlayerRow extends SqlRow {
  id: string;
  game_id: string;
  session_id: string;
  display_name: string;
  team_id: string | null;
}

interface TeamRow extends SqlRow {
  id: string;
  game_id: string;
  name: string;
  color: string;
}

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

/** A structural snapshot used to assert state is unchanged on rollback. */
interface StoreSnapshot {
  games: GameRow[];
  players: PlayerRow[];
  teams: TeamRow[];
  events: EventRow[];
}

/**
 * A fake transactional store modeling one game's lobby domain tables plus its
 * append-only `game_events` log.
 *
 * Its {@link QueryRunner} understands exactly the domain INSERTs the modeled
 * lobby mutations issue plus `appendEvent`'s lock+next-seq+insert CTE. Either
 * the domain INSERT or the event INSERT can be injected to throw, simulating a
 * constraint violation / lost connection at that step — the two failure modes
 * Property 18 requires to roll the whole transaction back.
 */
class FakeStore {
  private games: GameRow[] = [];
  private players: PlayerRow[] = [];
  private teams: TeamRow[] = [];
  private events: EventRow[] = [];
  private nextId = 1;

  /** When true, the next domain INSERT throws instead of writing (Req 6.3). */
  failDomainWrite = false;
  /** When true, the next event INSERT throws instead of writing (Req 6.2). */
  failEventWrite = false;

  snapshot(): StoreSnapshot {
    return {
      games: this.games.map((row) => ({ ...row })),
      players: this.players.map((row) => ({ ...row })),
      teams: this.teams.map((row) => ({ ...row })),
      events: this.events.map((row) => ({ ...row })),
    };
  }

  restore(snap: StoreSnapshot): void {
    this.games = snap.games.map((row) => ({ ...row }));
    this.players = snap.players.map((row) => ({ ...row }));
    this.teams = snap.teams.map((row) => ({ ...row }));
    this.events = snap.events.map((row) => ({ ...row }));
  }

  get gameCount(): number {
    return this.games.length;
  }
  get playerCount(): number {
    return this.players.length;
  }
  get teamCount(): number {
    return this.teams.length;
  }
  get eventCount(): number {
    return this.events.length;
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

    if (text.startsWith("insert into games")) {
      if (this.failDomainWrite) {
        throw new Error("injected domain-write failure (games)");
      }
      const [adminSessionId] = params as [string];
      const row: GameRow = {
        id: `g${this.nextId++}`,
        admin_session_id: adminSessionId,
      };
      this.games.push(row);
      return { rows: [{ id: row.id }] };
    }

    if (text.startsWith("insert into players")) {
      if (this.failDomainWrite) {
        throw new Error("injected domain-write failure (players)");
      }
      const [gameId, sessionId, displayName] = params as [
        string,
        string,
        string,
      ];
      const row: PlayerRow = {
        id: `p${this.nextId++}`,
        game_id: gameId,
        session_id: sessionId,
        display_name: displayName,
        team_id: null,
      };
      this.players.push(row);
      return { rows: [{ id: row.id }] };
    }

    if (text.startsWith("insert into teams")) {
      if (this.failDomainWrite) {
        throw new Error("injected domain-write failure (teams)");
      }
      const [gameId, name, color] = params as [string, string, string];
      const row: TeamRow = {
        id: `t${this.nextId++}`,
        game_id: gameId,
        name,
        color,
      };
      this.teams.push(row);
      return { rows: [{ id: row.id }] };
    }

    // appendEvent: the lock + next-seq + insert CTE.
    if (text.startsWith("with locked")) {
      if (this.failEventWrite) {
        throw new Error("injected event-write failure");
      }
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

/**
 * A `withTransaction`-like wrapper mirroring lib/db/server.ts: snapshot on
 * begin, run `fn`, COMMIT on normal return (keep mutations), ROLLBACK (restore
 * the snapshot) then rethrow on any throw. This is the pure model of
 * postgres.js `sql.begin(...)`.
 */
async function withTransaction<T>(
  store: FakeStore,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const snap = store.snapshot();
  try {
    return await fn(store.runner());
  } catch (err) {
    store.restore(snap); // ROLLBACK: domain tables AND event log unchanged.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Modeled lobby mutations: domain write + exactly one appendEvent, one txn.
// ---------------------------------------------------------------------------

type MutationKind = "create_game" | "join_player" | "create_team";

const GAME_ID = "game-1";

const INSERT_GAME_SQL = `
insert into games (admin_session_id, lifecycle)
values ($1, 'lobby')
returning id
`;

const INSERT_PLAYER_SQL = `
insert into players (game_id, session_id, display_name, team_id)
values ($1, $2, $3, null)
returning id
`;

const INSERT_TEAM_SQL = `
insert into teams (game_id, name, color)
values ($1, $2, $3)
returning id
`;

/**
 * Run one lobby mutation inside a transaction, mirroring each route's plan:
 * perform the domain INSERT, then append exactly one lobby `game_event`. A
 * failure injected at either step must roll the whole transaction back.
 */
async function runMutation(
  store: FakeStore,
  kind: MutationKind,
): Promise<{ applied: true }> {
  return withTransaction(store, async (tx) => {
    if (kind === "create_game") {
      const { rows } = await tx.query(INSERT_GAME_SQL, ["admin-session"]);
      const gameId = String(rows[0]?.id);
      await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.gameCreated,
        actor: "system",
        payload: { joinCode: "ABC123" },
      });
      return { applied: true };
    }

    if (kind === "join_player") {
      const { rows } = await tx.query(INSERT_PLAYER_SQL, [
        GAME_ID,
        "session-x",
        "Alice",
      ]);
      const playerId = String(rows[0]?.id);
      await appendEvent(tx, {
        gameId: GAME_ID,
        type: LOBBY_EVENT_TYPES.playerJoined,
        actor: "system",
        payload: { playerId, displayName: "Alice" },
      });
      return { applied: true };
    }

    // create_team
    const { rows } = await tx.query(INSERT_TEAM_SQL, [
      GAME_ID,
      "Red Team",
      "red",
    ]);
    const teamId = String(rows[0]?.id);
    await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.teamCreated,
      actor: "system",
      payload: { teamId, name: "Red Team", color: "red" },
    });
    return { applied: true };
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const mutationArb: fc.Arbitrary<MutationKind> = fc.constantFrom(
  "create_game",
  "join_player",
  "create_team",
);

/** Which step (if any) to fail for a given mutation. */
type FailAt = "none" | "domain" | "event";

const failAtArb: fc.Arbitrary<FailAt> = fc.constantFrom(
  "none",
  "domain",
  "event",
);

const stepArb = fc.record({
  kind: mutationArb,
  failAt: failAtArb,
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Rollback leaves nothing persisted on failure (Property 18)", () => {
  it("rolls the whole transaction back when either the domain write or the event append fails; nothing new persists", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 40 }),
        async (steps) => {
          const store = new FakeStore();

          for (const step of steps) {
            // Snapshot the observable state before the mutation.
            const before = store.snapshot();

            store.failDomainWrite = step.failAt === "domain";
            store.failEventWrite = step.failAt === "event";

            let threw = false;
            try {
              await runMutation(store, step.kind);
            } catch {
              threw = true;
            } finally {
              store.failDomainWrite = false;
              store.failEventWrite = false;
            }

            if (step.failAt === "none") {
              // SUCCESS PATH: the domain row and exactly one event persist.
              expect(threw).toBe(false);
              expect(store.eventCount).toBe(before.events.length + 1);
              const domainDelta =
                store.gameCount -
                before.games.length +
                (store.playerCount - before.players.length) +
                (store.teamCount - before.teams.length);
              expect(domainDelta).toBe(1);
              continue;
            }

            // FAILURE PATH (domain-write or event-append failure): the injected
            // failure must roll the whole transaction back. An error is
            // surfaced, and NEITHER the domain change NOR any game_event
            // persists — every table is exactly as it was before (Req 6.2, 6.3).
            expect(threw).toBe(true);
            expect(store.gameCount).toBe(before.games.length);
            expect(store.playerCount).toBe(before.players.length);
            expect(store.teamCount).toBe(before.teams.length);
            expect(store.eventCount).toBe(before.events.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rolls back a create-game when the domain write fails (Req 6.3, explicit example)", async () => {
    const store = new FakeStore();
    store.failDomainWrite = true;

    await expect(runMutation(store, "create_game")).rejects.toThrow(
      /injected domain-write failure/,
    );

    // No game, and the append was never even reached: no event either.
    expect(store.gameCount).toBe(0);
    expect(store.eventCount).toBe(0);
  });

  it("rolls back a join when the event append fails after a successful domain write (Req 6.2, explicit example)", async () => {
    const store = new FakeStore();
    store.failEventWrite = true;

    await expect(runMutation(store, "join_player")).rejects.toThrow(
      /injected event-write failure/,
    );

    // The player row was written inside the transaction, then the event append
    // failed — the domain write must be rolled back too.
    expect(store.playerCount).toBe(0);
    expect(store.eventCount).toBe(0);
  });

  it("rolls back a create-team when the event append fails (Req 6.2, explicit example)", async () => {
    const store = new FakeStore();
    store.failEventWrite = true;

    await expect(runMutation(store, "create_team")).rejects.toThrow(
      /injected event-write failure/,
    );

    expect(store.teamCount).toBe(0);
    expect(store.eventCount).toBe(0);
  });

  it("commits the domain change + exactly one event on success (explicit example)", async () => {
    const store = new FakeStore();

    await runMutation(store, "create_game");

    expect(store.gameCount).toBe(1);
    expect(store.eventCount).toBe(1);
  });
});
