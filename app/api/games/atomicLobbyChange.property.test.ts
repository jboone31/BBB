import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { appendEvent, type QueryRunner, type SqlRow } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";

/**
 * Feature: game-setup-lobby, Property 17: Atomic single-event append per lobby
 * change.
 *
 * For any accepted lobby mutation, applying it performs the domain write AND
 * appends exactly one `game_event` within a single transaction, and reports the
 * appended event's per-game sequence (design.md §Property 17; R6.1, R6.4).
 *
 * The six lobby routes (`app/api/games/**`, Tasks 13–18) share one shape: each
 * runs inside a single `withTransaction` (lib/db/server.ts) that wraps a domain
 * write (insert a game / update bars / insert a player / insert a team / update
 * a player's team / flip lifecycle to live) plus exactly one `appendEvent` — the
 * `game_created` / `bars_designated` / `player_joined` / `team_created` /
 * `team_changed` / `game_started` event of the matching payload (design.md
 * "Lobby event payloads"). The route returns the appended event's `seq` in its
 * structured `{ applied: true, seq }` result (R6.4).
 *
 * The real guarantee comes from postgres.js `sql.begin(...)` committing the
 * domain write and the append together, exercised end-to-end by the DB-backed
 * integration tests (Task 23). Here we property-test the pure transactional
 * model of the atomic-append rule the way the codebase already models
 * route-level transactional properties (see
 * `lib/gameend/atomicEnd.property.test.ts` and
 * `app/api/games/[gameId]/join/join.property.test.ts`): a fake in-memory store,
 * a `withTransaction`-like wrapper, and the REAL `appendEvent` driven through a
 * fake QueryRunner. Applying an arbitrary sequence of accepted lobby mutations
 * must, for every mutation, perform exactly one domain write and grow the event
 * log by exactly one row, all inside one transaction, and return that event's
 * per-game seq — which must equal the log's new length (a contiguous 1..n
 * sequence).
 *
 * Validates: Requirements 6.1
 */

// ---------------------------------------------------------------------------
// Fake in-memory transactional store: one game, its lobby domain tables, and
// its append-only game_events log.
// ---------------------------------------------------------------------------

type Lifecycle = "lobby" | "live" | "ended";

/** A stored `games` row (only the columns the lobby mutations touch). */
interface GameRow extends SqlRow {
  id: string;
  lifecycle: Lifecycle;
  start_bar_id: string | null;
  finish_bar_id: string | null;
  live_started_at: string | null;
}

/** A stored `players` row; `team_id` is null when the player is teamless. */
interface PlayerRow extends SqlRow {
  id: string;
  team_id: string | null;
}

/** A stored `teams` row. */
interface TeamRow extends SqlRow {
  id: string;
  name: string;
  color: string;
}

/** A stored `game_events` row (snake_case columns, as a real driver returns). */
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

/**
 * A count of every domain-table row the store holds, used to prove a mutation
 * performs exactly one domain write (one row inserted, or one existing row
 * mutated — tracked via a monotonically increasing write counter).
 */
interface DomainSnapshot {
  players: number;
  teams: number;
  /** Total domain writes applied so far (inserts + updates). */
  domainWrites: number;
}

/**
 * A fake transactional store modeling a single game's lobby domain tables plus
 * its append-only event log.
 *
 * Its {@link QueryRunner} understands exactly the statements the modeled lobby
 * mutations issue (matched by prefix): the game insert/update, the player
 * insert, the team insert, the player-team update, and `appendEvent`'s
 * lock+next-seq+insert CTE. Every domain statement bumps a `domainWrites`
 * counter so the property can assert each mutation performs exactly one domain
 * write.
 */
class FakeStore {
  private game: GameRow;
  private players: PlayerRow[] = [];
  private teams: TeamRow[] = [];
  private events: EventRow[] = [];
  private nextPlayerId = 1;
  private nextTeamId = 1;
  private nextEventId = 1;
  private writes = 0;

  constructor(gameId: string) {
    this.game = {
      id: gameId,
      lifecycle: "lobby",
      start_bar_id: null,
      finish_bar_id: null,
      live_started_at: null,
    };
  }

  get eventCount(): number {
    return this.events.length;
  }

  get lastEvent(): EventRow | undefined {
    return this.events[this.events.length - 1];
  }

  domainSnapshot(): DomainSnapshot {
    return {
      players: this.players.length,
      teams: this.teams.length,
      domainWrites: this.writes,
    };
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

    // create route: insert the game (domain write #1 for the create mutation).
    if (text.startsWith("insert into games")) {
      this.writes += 1;
      // Idempotent for the single modeled game: keep one game row.
      return { rows: [{ id: this.game.id }] };
    }

    // bars route: designate start/finish bars.
    if (text.startsWith("update games set start_bar_id")) {
      const [startBarId, finishBarId] = params as [string, string];
      this.game.start_bar_id = startBarId;
      this.game.finish_bar_id = finishBarId;
      this.writes += 1;
      return { rows: [{ id: this.game.id }] };
    }

    // start route: flip lifecycle to live + stamp live_started_at.
    if (text.startsWith("update games set lifecycle")) {
      const [liveStartedAt] = params as [string];
      this.game.lifecycle = "live";
      this.game.live_started_at = liveStartedAt;
      this.writes += 1;
      return { rows: [{ id: this.game.id }] };
    }

    // join route: insert a teamless player.
    if (text.startsWith("insert into players")) {
      const row: PlayerRow = {
        id: `p${this.nextPlayerId++}`,
        team_id: null,
      };
      this.players.push(row);
      this.writes += 1;
      return { rows: [{ id: row.id }] };
    }

    // teams route: insert a team with an assigned color.
    if (text.startsWith("insert into teams")) {
      const [name, color] = params as [string, string];
      const row: TeamRow = { id: `t${this.nextTeamId++}`, name, color };
      this.teams.push(row);
      this.writes += 1;
      return { rows: [{ id: row.id }] };
    }

    // teams/select route: update a player's team association.
    if (text.startsWith("update players set team_id")) {
      const [teamId, playerId] = params as [string, string];
      const player = this.players.find((p) => p.id === playerId);
      if (player) {
        player.team_id = teamId;
      }
      this.writes += 1;
      return { rows: player ? [{ id: player.id }] : [] };
    }

    // appendEvent: the lock + next-seq + insert CTE.
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
        id: `e${this.nextEventId++}`,
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

  /** Helper for the switch mutation: register a player already on a team. */
  seedTeamedPlayer(teamId: string): string {
    const row: PlayerRow = { id: `p${this.nextPlayerId++}`, team_id: teamId };
    this.players.push(row);
    return row.id;
  }
}

/**
 * A `withTransaction`-like wrapper mirroring `lib/db/server.ts`: run `fn`
 * against the store's runner and return its result (COMMIT on normal return).
 * The atomicity focus of Property 17 is the accepted (committed) path — one
 * domain write + exactly one event; the rollback-on-failure path is Property 18
 * (Task 19.2). No snapshot/restore is needed here because every modeled mutation
 * is an accepted one that commits.
 */
async function withTransaction<T>(
  store: FakeStore,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  return fn(store.runner());
}

// ---------------------------------------------------------------------------
// The six modeled lobby mutations. Each does one domain write + exactly one
// appendEvent inside one transaction, and returns the appended event's seq.
// The SQL prefixes match what FakeStore.dispatch recognizes.
// ---------------------------------------------------------------------------

const GAME_ID = "game-1";

/** The result every modeled lobby mutation returns (R6.4 shape, seq subset). */
interface AppliedResult {
  readonly applied: true;
  readonly seq: number;
}

/** create (R1.6): insert game + one `game_created` event. */
async function runCreate(
  store: FakeStore,
  joinCode: string,
): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    await tx.query("insert into games (id, lifecycle) values ($1, 'lobby')", [
      GAME_ID,
    ]);
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.gameCreated,
      actor: "admin",
      payload: { joinCode },
    });
    return { applied: true, seq: event.seq };
  });
}

/** bars (R2.7): update start/finish bars + one `bars_designated` event. */
async function runDesignateBars(
  store: FakeStore,
  startBarId: string,
  finishBarId: string,
): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    await tx.query(
      "update games set start_bar_id = $1, finish_bar_id = $2 where id = $3",
      [startBarId, finishBarId, GAME_ID],
    );
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.barsDesignated,
      actor: "admin",
      payload: { startBarId, finishBarId },
    });
    return { applied: true, seq: event.seq };
  });
}

/** join (R4.6): insert teamless player + one `player_joined` event. */
async function runJoin(
  store: FakeStore,
  displayName: string,
): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    const { rows } = await tx.query(
      "insert into players (game_id, session_id, display_name, team_id) values ($1, $2, $3, null) returning id",
      [GAME_ID, `s-${displayName}`, displayName],
    );
    const playerId = String(rows[0]?.id);
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.playerJoined,
      actor: "admin",
      payload: { playerId, displayName },
    });
    return { applied: true, seq: event.seq };
  });
}

/** team create (R4.6): insert team + one `team_created` event. */
async function runCreateTeam(
  store: FakeStore,
  name: string,
  color: string,
): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    const { rows } = await tx.query(
      "insert into teams (game_id, name, color) values ($1, $2, $3) returning id",
      [GAME_ID, name, color],
    );
    const teamId = String(rows[0]?.id);
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.teamCreated,
      actor: "admin",
      payload: { teamId, name, color },
    });
    return { applied: true, seq: event.seq };
  });
}

/**
 * team select/switch (R4.6): update player's team + one `team_changed` event.
 * `fromTeamId` is null on first selection, a prior team id on a switch.
 */
async function runSelectTeam(
  store: FakeStore,
  playerId: string,
  fromTeamId: string | null,
  toTeamId: string,
): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    await tx.query("update players set team_id = $1 where id = $2", [
      toTeamId,
      playerId,
    ]);
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.teamChanged,
      actor: { kind: "team", teamId: toTeamId },
      payload: { playerId, fromTeamId, toTeamId },
    });
    return { applied: true, seq: event.seq };
  });
}

/** start (R5.8): flip lifecycle to live + one `game_started` event. */
async function runStart(store: FakeStore): Promise<AppliedResult> {
  return withTransaction(store, async (tx) => {
    const liveStartedAt = new Date().toISOString();
    await tx.query(
      "update games set lifecycle = 'live', live_started_at = $1 where id = $2",
      [liveStartedAt, GAME_ID],
    );
    const event = await appendEvent(tx, {
      gameId: GAME_ID,
      type: LOBBY_EVENT_TYPES.gameStarted,
      actor: "admin",
      payload: { liveStartedAt },
    });
    return { applied: true, seq: event.seq };
  });
}

// ---------------------------------------------------------------------------
// Generators: an arbitrary sequence of accepted lobby mutations.
// ---------------------------------------------------------------------------

type MutationKind =
  | "create"
  | "designate_bars"
  | "join"
  | "create_team"
  | "select_team"
  | "start";

const mutationKindArb: fc.Arbitrary<MutationKind> = fc.constantFrom(
  "create",
  "designate_bars",
  "join",
  "create_team",
  "select_team",
  "start",
);

const shortIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => `x${s}`.slice(0, 8));

/**
 * Apply one modeled mutation of the given kind against the store, choosing
 * benign arguments. For `select_team`, seed a teamed or teamless player first so
 * both the first-selection and switch cases are exercised; the seeded insert is
 * NOT part of the measured mutation (only the update + event is).
 */
async function applyMutation(
  store: FakeStore,
  kind: MutationKind,
  arg: string,
  fromTeamed: boolean,
): Promise<AppliedResult> {
  switch (kind) {
    case "create":
      return runCreate(store, arg);
    case "designate_bars":
      return runDesignateBars(store, `${arg}-start`, `${arg}-finish`);
    case "join":
      return runJoin(store, arg);
    case "create_team":
      return runCreateTeam(store, arg, `#${arg.slice(0, 3)}`);
    case "select_team": {
      const fromTeamId = fromTeamed ? "team-old" : null;
      const playerId = fromTeamed
        ? store.seedTeamedPlayer(fromTeamId as string)
        : store.seedTeamedPlayer(null as unknown as string);
      return runSelectTeam(store, playerId, fromTeamId, `${arg}-team`);
    }
    case "start":
      return runStart(store);
  }
}

const stepArb = fc.record({
  kind: mutationKindArb,
  arg: shortIdArb,
  fromTeamed: fc.boolean(),
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Atomic single-event append per lobby change (Property 17)", () => {
  it("every accepted lobby mutation performs exactly one domain write and appends exactly one event, returning its per-game seq", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 40 }),
        async (steps) => {
          const store = new FakeStore(GAME_ID);

          for (const step of steps) {
            const before = store.domainSnapshot();
            const eventsBefore = store.eventCount;

            const result = await applyMutation(
              store,
              step.kind,
              step.arg,
              step.fromTeamed,
            );

            const after = store.domainSnapshot();

            // Exactly one domain write for the mutation (R6.1).
            expect(after.domainWrites).toBe(before.domainWrites + 1);

            // Exactly one game_event appended for the mutation (R6.1).
            expect(store.eventCount).toBe(eventsBefore + 1);

            // The result reports success and the appended event's seq (R6.4).
            expect(result.applied).toBe(true);
            const appended = store.lastEvent;
            expect(appended).toBeDefined();
            expect(result.seq).toBe(appended?.seq);

            // The reported seq equals the (contiguous 1..n) log length: the new
            // event sits at the tail with no gap.
            expect(result.seq).toBe(store.eventCount);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("appends exactly one event per mutation kind and reports increasing seqs (explicit walk-through)", async () => {
    const store = new FakeStore(GAME_ID);

    const created = await runCreate(store, "ABC123");
    expect(created.seq).toBe(1);
    expect(store.eventCount).toBe(1);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.gameCreated);

    const bars = await runDesignateBars(store, "bar-1", "bar-2");
    expect(bars.seq).toBe(2);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.barsDesignated);

    const joined = await runJoin(store, "Alice");
    expect(joined.seq).toBe(3);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.playerJoined);

    const team = await runCreateTeam(store, "Reds", "#f00");
    expect(team.seq).toBe(4);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.teamCreated);

    const playerId = store.seedTeamedPlayer(null as unknown as string);
    const selected = await runSelectTeam(store, playerId, null, "t1");
    expect(selected.seq).toBe(5);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.teamChanged);

    const started = await runStart(store);
    expect(started.seq).toBe(6);
    expect(store.lastEvent?.event_type).toBe(LOBBY_EVENT_TYPES.gameStarted);

    // Six mutations → six events, one per mutation, contiguous seqs 1..6.
    expect(store.eventCount).toBe(6);
  });
});
