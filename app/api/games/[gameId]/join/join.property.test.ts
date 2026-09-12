import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { appendEvent, type QueryRunner, type SqlRow } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";

/**
 * Feature: game-setup-lobby, Property 14: One player per session per game
 * (join idempotence).
 *
 * For any Game and session identifier, applying any number of join requests for
 * that `(game, session)` pair yields exactly one Player record — the first — and
 * the stored player count for that pair never exceeds one; a repeat join returns
 * the existing Player (design.md §Property 14; Req 3.8, 8.2).
 *
 * The join route (`app/api/games/[gameId]/join/route.ts`, Task 15) is
 * transaction-wrapped: inside one `withTransaction` it reads the existing player
 * for `(game_id, session_id)` first and, if one exists, returns it WITHOUT
 * inserting a second row or appending a `player_joined` event; otherwise it
 * inserts one player with `team_id = null` and appends exactly one
 * `player_joined` event (design.md "Idempotent join" note + the
 * `players_game_session_unique (game_id, session_id)` constraint, R3.8/R8.2).
 *
 * The real guarantee is enforced by that read-first path plus the database's
 * `players_game_session_unique` constraint (exercised end-to-end by the
 * DB-backed integration tests, Task 23). Here we property-test the pure model of
 * that rule the way the codebase models route-level transactional properties
 * (see `lib/gameend/atomicEnd.property.test.ts`): a fake in-memory store that
 * enforces the unique `(game_id, session_id)` constraint, a `withTransaction`
 * -like wrapper, and the REAL `appendEvent` driven through a fake QueryRunner.
 * Applying an arbitrary sequence of join requests — including many repeats of
 * the same session and interleaved distinct sessions — must always leave exactly
 * one Player per `(game, session)` pair, and a repeat must return the first
 * Player unchanged and append no additional event.
 *
 * Validates: Requirements 3.8, 8.2
 */

// ---------------------------------------------------------------------------
// Fake in-memory store enforcing players_game_session_unique(game_id, session_id)
// ---------------------------------------------------------------------------

/** A stored `players` row (snake_case columns, as a real driver returns). */
interface PlayerRow extends SqlRow {
  id: string;
  game_id: string;
  session_id: string;
  display_name: string;
  team_id: string | null;
}

/** A stored `game_events` row. */
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
 * Read the `playerId` from a stored event payload. `appendEvent` stores the
 * payload as JSON text (the `jsonb` parameter), so the fake row's `payload` is a
 * string; parse it defensively (a real driver may hand back either shape).
 */
function readPayloadPlayerId(payload: unknown): string | undefined {
  const obj =
    typeof payload === "string"
      ? (() => {
          try {
            return JSON.parse(payload) as unknown;
          } catch {
            return null;
          }
        })()
      : payload;
  if (obj === null || typeof obj !== "object") {
    return undefined;
  }
  const value = (obj as Record<string, unknown>).playerId;
  return typeof value === "string" ? value : undefined;
}

/** A structural snapshot used for transaction rollback. */
interface StoreSnapshot {
  players: PlayerRow[];
  events: EventRow[];
}

/**
 * A fake transactional store modeling one game's `players` table plus its
 * append-only `game_events` log.
 *
 * Its {@link QueryRunner} understands exactly the statements the join route
 * issues:
 *   - the read-first SELECT for an existing player on `(game_id, session_id)`,
 *   - the guarded INSERT of a new player (which the fake rejects with a
 *     unique-violation-like throw if a row for the pair already exists, mirroring
 *     `players_game_session_unique`), and
 *   - `appendEvent`'s lock+next-seq+insert CTE.
 */
class FakeStore {
  private players: PlayerRow[] = [];
  private events: EventRow[] = [];
  private nextPlayerId = 1;
  private nextEventId = 1;

  constructor(private readonly gameId: string) {}

  snapshot(): StoreSnapshot {
    return {
      players: this.players.map((row) => ({ ...row })),
      events: this.events.map((row) => ({ ...row })),
    };
  }

  restore(snap: StoreSnapshot): void {
    this.players = snap.players.map((row) => ({ ...row }));
    this.events = snap.events.map((row) => ({ ...row }));
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** Players stored for a given `(game, session)` pair. */
  playersFor(sessionId: string): PlayerRow[] {
    return this.players.filter(
      (row) => row.game_id === this.gameId && row.session_id === sessionId,
    );
  }

  /** `player_joined` events referencing a given player id. */
  joinedEventsForPlayer(playerId: string): EventRow[] {
    return this.events.filter(
      (row) =>
        row.event_type === LOBBY_EVENT_TYPES.playerJoined &&
        readPayloadPlayerId(row.payload) === playerId,
    );
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

    // Read-first: existing player for (game_id, session_id).
    if (text.startsWith("select id, session_id, display_name, team_id")) {
      const [gameId, sessionId] = params as [string, string];
      const existing = this.players.filter(
        (row) => row.game_id === gameId && row.session_id === sessionId,
      );
      return { rows: existing };
    }

    // Guarded INSERT of a new player. The unique constraint on
    // (game_id, session_id) means a second insert for the same pair fails.
    if (text.startsWith("insert into players")) {
      const [gameId, sessionId, displayName] = params as [
        string,
        string,
        string,
      ];
      const clash = this.players.some(
        (row) => row.game_id === gameId && row.session_id === sessionId,
      );
      if (clash) {
        throw new Error(
          'duplicate key value violates unique constraint "players_game_session_unique"',
        );
      }
      const row: PlayerRow = {
        id: `p${this.nextPlayerId++}`,
        game_id: gameId,
        session_id: sessionId,
        display_name: displayName,
        team_id: null,
      };
      this.players.push(row);
      return { rows: [{ id: row.id }] };
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
}

/**
 * A `withTransaction`-like wrapper mirroring `lib/db/server.ts`: snapshot on
 * begin, run `fn`, COMMIT on normal return, ROLLBACK (restore) then rethrow on
 * any throw. This is the pure model of postgres.js `sql.begin(...)`.
 */
async function withTransaction<T>(
  store: FakeStore,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const snap = store.snapshot();
  try {
    return await fn(store.runner());
  } catch (err) {
    store.restore(snap);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Modeled join: the route's read-first, insert-once idempotent join.
// ---------------------------------------------------------------------------

/** The statements the modeled join issues, matched by prefix in FakeStore. */
const EXISTING_PLAYER_SQL = `
select id, session_id, display_name, team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

const INSERT_PLAYER_SQL = `
insert into players (game_id, session_id, display_name, team_id)
values ($1, $2, $3, null)
returning id
`;

/** The result of a modeled join: the player id, and whether it was freshly created. */
interface JoinResult {
  readonly playerId: string;
  readonly created: boolean;
}

/**
 * Run one idempotent join inside a transaction, mirroring the join route's plan:
 * read the existing `(game, session)` player first; if present, return it and
 * append NO event; otherwise insert one teamless player and append exactly one
 * `player_joined` event (design.md "Idempotent join").
 */
async function runJoin(
  store: FakeStore,
  gameId: string,
  sessionId: string,
  displayName: string,
): Promise<JoinResult> {
  return withTransaction(store, async (tx) => {
    const { rows } = await tx.query(EXISTING_PLAYER_SQL, [gameId, sessionId]);
    const existing = rows[0];
    if (existing) {
      // Repeat join for the same pair: return the existing player, no insert,
      // no event (R3.8).
      return { playerId: String(existing.id), created: false };
    }

    const { rows: inserted } = await tx.query(INSERT_PLAYER_SQL, [
      gameId,
      sessionId,
      displayName.trim(),
    ]);
    const playerId = String(inserted[0]?.id);

    await appendEvent(tx, {
      gameId,
      type: LOBBY_EVENT_TYPES.playerJoined,
      actor: "system",
      payload: { playerId, displayName: displayName.trim() },
    });

    return { playerId, created: true };
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const GAME_ID = "game-1";

/** A small pool of session ids so join requests deliberately collide/repeat. */
const sessionArb: fc.Arbitrary<string> = fc.constantFrom(
  "s-a",
  "s-b",
  "s-c",
  "s-d",
);

/** A valid display name (1-40 chars after trimming). */
const displayNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => `n${s}`.slice(0, 40));

/** One join request: a session and the display name it submits. */
const joinRequestArb = fc.record({
  sessionId: sessionArb,
  displayName: displayNameArb,
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("One player per session per game — join idempotence (Property 14)", () => {
  it("any number of joins for a (game, session) yields exactly one player; repeats return the first and append no event", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(joinRequestArb, { minLength: 1, maxLength: 40 }),
        async (requests) => {
          const store = new FakeStore(GAME_ID);

          // The first player id observed for each session (the one that must be
          // returned by every subsequent join for that session).
          const firstPlayerId = new Map<string, string>();

          for (const req of requests) {
            const eventsBefore = store.eventCount;
            const priorPlayers = store.playersFor(req.sessionId).length;

            const result = await runJoin(
              store,
              GAME_ID,
              req.sessionId,
              req.displayName,
            );

            const alreadyJoined = priorPlayers > 0;

            if (alreadyJoined) {
              // Repeat join: the existing player is returned, no new player, and
              // NO new event is appended (R3.8).
              expect(result.created).toBe(false);
              expect(result.playerId).toBe(firstPlayerId.get(req.sessionId));
              expect(store.eventCount).toBe(eventsBefore);
            } else {
              // First join for this session: exactly one player created and
              // exactly one player_joined event appended.
              expect(result.created).toBe(true);
              expect(store.eventCount).toBe(eventsBefore + 1);
              firstPlayerId.set(req.sessionId, result.playerId);
            }

            // Invariant after every request: at most one player per pair.
            expect(store.playersFor(req.sessionId).length).toBe(1);
            // Exactly one player_joined event exists for that player id.
            expect(store.joinedEventsForPlayer(result.playerId).length).toBe(1);
          }

          // Final invariant: every distinct session that ever joined has exactly
          // one player, and the player count never exceeds one per pair (R8.2).
          const distinctSessions = new Set(requests.map((r) => r.sessionId));
          for (const sessionId of distinctSessions) {
            expect(store.playersFor(sessionId).length).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a repeat join returns the first player's id unchanged (explicit example)", async () => {
    const store = new FakeStore(GAME_ID);

    const first = await runJoin(store, GAME_ID, "s-a", "  Alice  ");
    expect(first.created).toBe(true);
    const afterFirst = store.eventCount;

    const second = await runJoin(store, GAME_ID, "s-a", "Someone Else");
    expect(second.created).toBe(false);
    expect(second.playerId).toBe(first.playerId);

    // No second player, no additional event.
    expect(store.playersFor("s-a").length).toBe(1);
    expect(store.eventCount).toBe(afterFirst);
    // The stored player kept the first display name (trimmed), unchanged by the
    // repeat.
    expect(store.playersFor("s-a")[0].display_name).toBe("Alice");
  });

  it("distinct sessions in the same game each get their own single player", async () => {
    const store = new FakeStore(GAME_ID);

    const a = await runJoin(store, GAME_ID, "s-a", "Alice");
    const b = await runJoin(store, GAME_ID, "s-b", "Bob");

    expect(a.playerId).not.toBe(b.playerId);
    expect(store.playersFor("s-a").length).toBe(1);
    expect(store.playersFor("s-b").length).toBe(1);
    expect(store.eventCount).toBe(2);
  });
});
