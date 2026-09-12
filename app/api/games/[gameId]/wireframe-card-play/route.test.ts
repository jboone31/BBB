/**
 * Example / edge-case unit tests for the wireframe targeting card-play route
 * (in-game-landing-wireframe Tasks 7.2 & 7.3). These complement the pure-logic
 * property suites in `lib/gameboard/`: where those assert universal invariants
 * over the reducer, this file pins the route's request-flow branches — the
 * append + validation gates (Task 7.2) and the append-failure/not-delivered
 * rollback path (Task 7.3).
 *
 * Requirements: 7.1, 7.6, 7.7.
 *
 * The database is mocked. `route.ts` imports `@/lib/db/server`, which imports
 * `server-only` (resolvable only inside the Next.js bundler), so mocking the
 * whole module with `vi.mock` replaces it before evaluation and this suite runs
 * in the default `node` environment with no live database. `withTransaction` is
 * replaced by a harness that hands the route a fake `QueryRunner` whose `query`
 * answers the two SQL statements the route runs inside the transaction
 * (membership + player-for-session), plus the target-team lookup. `appendEvent`
 * is replaced by a `vi.fn` so the suite can assert that exactly one
 * `wireframe_card_played` event is appended and that a throw there rolls the
 * transaction back with nothing written.
 *
 * Mirrors the mocking discipline of `app/api/games/resolve/route.test.ts`
 * (module-level `vi.mock`, `mock`-prefixed shared state the hoisted factory may
 * close over, `Request` objects built per case).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

// ---------------------------------------------------------------------------
// Mock shared state — declared with a `mock`-prefixed name so Vitest's hoisted
// `vi.mock` factories are allowed to close over it.
// ---------------------------------------------------------------------------

/** A member row exists for the requesting session in the game (assertMember). */
let mockIsMember = false;
/** The player row the requesting session owns in the game, or null (no player). */
let mockPlayer: { id: string; team_id: string | null } | null = null;
/** The set of team ids that belong to this game (TEAM_IN_GAME_SQL). */
let mockTeamsInGame = new Set<string>();
/** When set, the fake appendEvent throws this error to exercise rollback (R7.7). */
let mockAppendError: Error | null = null;

/**
 * Records of appendEvent calls (the args each call received). The route must
 * append exactly one `wireframe_card_played` event on the happy path and zero on
 * any rejected/failed path.
 */
const mockAppendCalls: Array<{
  gameId: string;
  type: string;
  actor: unknown;
  payload: unknown;
}> = [];

/**
 * Whether the transaction body ran to completion (committed) versus threw
 * (rolled back). The harness flips this so the append-failure test can assert
 * "no commit" without a real database.
 */
let mockCommitted = false;

/**
 * The fake `QueryRunner` handed to the route's transaction body. It matches on
 * the distinctive fragments of each statement the route runs:
 *   - `for update` + `players p` → MEMBERSHIP_SQL (assertMember)
 *   - `from players` + `session_id` → PLAYER_FOR_SESSION_SQL
 *   - `from teams` → TEAM_IN_GAME_SQL
 */
const fakeTx: QueryRunner = {
  async query(sql: string, params: readonly unknown[] = []) {
    const text = sql.toLowerCase();
    if (text.includes("from locked") || text.includes("exists")) {
      // MEMBERSHIP_SQL — returns a row iff the session is a member.
      return { rows: mockIsMember ? [{ "?column?": 1 }] : [] };
    }
    if (text.includes("from players") && text.includes("session_id")) {
      // PLAYER_FOR_SESSION_SQL — the requesting session's player row.
      return { rows: mockPlayer ? [{ ...mockPlayer }] : [] };
    }
    if (text.includes("from teams")) {
      // TEAM_IN_GAME_SQL — $1 team_id, $2 game_id.
      const teamId = String(params[0]);
      return { rows: mockTeamsInGame.has(teamId) ? [{ "?column?": 1 }] : [] };
    }
    return { rows: [] };
  },
};

// Replace the server DB helper before the route module loads: run the callback
// against the fake QueryRunner, commit on normal return, roll back (rethrow) on
// any throw — exactly the semantics postgres.js `sql.begin` provides.
vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> => {
    mockCommitted = false;
    const result = await fn(fakeTx); // a throw here propagates → route's catch
    mockCommitted = true;
    return result;
  },
}));

// Replace the event backbone's appendEvent with a recorder. Re-export the real
// pure helpers/types the route also imports so `GAME_BOARD_EVENT_TYPES` resolves
// unchanged. `importActual` keeps everything else (QueryRunner type, etc.) real.
vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    appendEvent: vi.fn(
      async (
        _tx: QueryRunner,
        args: {
          gameId: string;
          type: string;
          actor: unknown;
          payload: unknown;
        },
      ) => {
        if (mockAppendError) {
          throw mockAppendError;
        }
        mockAppendCalls.push(args);
        return {
          id: "evt-1",
          gameId: args.gameId,
          seq: 42,
          eventType: args.type,
          actorKind: "team" as const,
          actorTeamId:
            args.actor && typeof args.actor === "object"
              ? ((args.actor as { teamId?: string }).teamId ?? null)
              : null,
          payload: args.payload,
          createdAt: new Date(0).toISOString(),
        };
      },
    ),
  };
});

import { POST } from "./route";

/** Build a POST Request with the given session header and JSON body. */
function playRequest(options: {
  sessionId?: string;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.sessionId !== undefined) {
    headers["x-bbb-session-id"] = options.sessionId;
  }
  return new Request("http://test/api/games/g-1/wireframe-card-play", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

/** The route's `context.params` shape (a promise of the dynamic segment). */
function params(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

beforeEach(() => {
  mockIsMember = false;
  mockPlayer = null;
  mockTeamsInGame = new Set<string>();
  mockAppendError = null;
  mockAppendCalls.length = 0;
  mockCommitted = false;
});

// ---------------------------------------------------------------------------
// Task 7.2 — append + validation branches (Requirements 7.1, 7.6).
// ---------------------------------------------------------------------------

describe("POST /api/games/[gameId]/wireframe-card-play — append + validation (Task 7.2)", () => {
  it("happy path appends exactly one wireframe_card_played event carrying the target (R7.1)", async () => {
    // A member whose player row sits on team-A plays a card at team-B, which is
    // a real team in this game.
    mockIsMember = true;
    mockPlayer = { id: "p-1", team_id: "team-A" };
    mockTeamsInGame = new Set(["team-A", "team-B"]);

    const res = await POST(
      playRequest({
        sessionId: "sess-1",
        body: { cardId: "card-9", targetTeamId: "team-B" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applied: true, seq: 42 });

    // Exactly one event, of the wireframe type, carrying the target and caster.
    expect(mockAppendCalls).toHaveLength(1);
    const [call] = mockAppendCalls;
    expect(call.type).toBe("wireframe_card_played");
    expect(call.gameId).toBe("g-1");
    expect(call.actor).toEqual({ kind: "team", teamId: "team-A" });
    expect(call.payload).toEqual({
      castingTeamId: "team-A",
      targetTeamId: "team-B",
      cardId: "card-9",
    });
    expect(mockCommitted).toBe(true);
  });

  it("missing session → 401 missing_session and no event (R8.3)", async () => {
    // Even a fully-valid body writes nothing without a session header.
    mockIsMember = true;
    mockPlayer = { id: "p-1", team_id: "team-A" };
    mockTeamsInGame = new Set(["team-A", "team-B"]);

    const res = await POST(
      playRequest({ body: { cardId: "card-9", targetTeamId: "team-B" } }),
      params("g-1"),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      applied: false,
      error: "missing_session",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("non-member → 403 not_member and no event (R7.6)", async () => {
    // A session that is not a member of the game is rejected inside the tx.
    mockIsMember = false;
    mockTeamsInGame = new Set(["team-A", "team-B"]);

    const res = await POST(
      playRequest({
        sessionId: "sess-outsider",
        body: { cardId: "card-9", targetTeamId: "team-B" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("member with no player/team → 403 not_member and no event", async () => {
    // A member (e.g. the admin) with no player row has no casting Team.
    mockIsMember = true;
    mockPlayer = null;
    mockTeamsInGame = new Set(["team-A", "team-B"]);

    const res = await POST(
      playRequest({
        sessionId: "sess-admin",
        body: { cardId: "card-9", targetTeamId: "team-B" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("target team not in this game → 404 not_found and no event", async () => {
    // The target team id is not a team of this game.
    mockIsMember = true;
    mockPlayer = { id: "p-1", team_id: "team-A" };
    mockTeamsInGame = new Set(["team-A"]); // team-B is absent

    const res = await POST(
      playRequest({
        sessionId: "sess-1",
        body: { cardId: "card-9", targetTeamId: "team-B" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      applied: false,
      error: "not_found",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("target equals the caller's own team → 404 not_found and no event (R7 targets another Team)", async () => {
    // Playing a targeting card on your own team is invalid.
    mockIsMember = true;
    mockPlayer = { id: "p-1", team_id: "team-A" };
    mockTeamsInGame = new Set(["team-A", "team-B"]);

    const res = await POST(
      playRequest({
        sessionId: "sess-1",
        body: { cardId: "card-9", targetTeamId: "team-A" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      applied: false,
      error: "not_found",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 7.3 — append-failure handling / "not delivered" (Requirement 7.7).
// ---------------------------------------------------------------------------

describe("POST /api/games/[gameId]/wireframe-card-play — append failure rolls back (Task 7.3)", () => {
  it("a throw inside the transaction rolls back (no event written) and returns { applied: false, error } (R7.7)", async () => {
    // All validation passes, but the append itself throws (e.g. lost connection,
    // constraint violation). The transaction rolls back — nothing is committed —
    // and the route surfaces a structured 500 so the client shows "not
    // delivered".
    mockIsMember = true;
    mockPlayer = { id: "p-1", team_id: "team-A" };
    mockTeamsInGame = new Set(["team-A", "team-B"]);
    mockAppendError = new Error("append failed: connection lost");

    const res = await POST(
      playRequest({
        sessionId: "sess-1",
        body: { cardId: "card-9", targetTeamId: "team-B" },
      }),
      params("g-1"),
    );

    expect(res.status).toBe(500);
    const bodyJson = (await res.json()) as { applied: boolean; error: string };
    expect(bodyJson.applied).toBe(false);
    expect(typeof bodyJson.error).toBe("string");
    expect(bodyJson.error).toContain("append failed");

    // Rolled back: no event recorded and the transaction never committed.
    expect(mockAppendCalls).toHaveLength(0);
    expect(mockCommitted).toBe(false);
  });
});
