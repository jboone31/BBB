// Example / edge-case unit tests for the code → gameId resolution route
// (app-shell-navigation Task 5.5). These complement the co-located property
// suite (`route.property.test.ts`, owned by Tasks 5.2–5.4): where the property
// tests assert universal invariants (uniform not-found, only-id, normalization
// invariance), this file pins down specific examples and boundary values.
//
// Requirements: 6.1, 6.2, 6.3.
//
// DB is mocked. `route.ts` imports `@/lib/db/server`, which imports
// `server-only` (resolvable only inside the Next.js bundler). Mocking the whole
// module with `vi.mock` replaces it before evaluation, so `server-only` is never
// loaded and this suite runs in the default `node` environment with no live
// database. The mock is a tiny in-memory `games` map: `getSql().unsafe(sql,
// [code])` selects the `id` of the single row whose `join_code` matches and whose
// `lifecycle <> 'ended'`, mirroring `RESOLVE_SQL` in the route.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A row in the in-memory games store, keyed by join_code. */
interface GameRow {
  readonly id: string;
  readonly join_code: string;
  readonly lifecycle: "lobby" | "live" | "ended";
}

/**
 * The in-memory games table the mocked `getSql().unsafe` reads from. Tests reset
 * and seed this in `beforeEach`. It is declared with a `mock`-prefixed name so
 * Vitest's hoisted `vi.mock` factory is allowed to close over it.
 */
const mockGames: GameRow[] = [];

// Replace the server DB helper before the route module loads. Only `unsafe` is
// exercised by the route (`getSql().unsafe(RESOLVE_SQL, [normalizedCode])`); it
// resolves to the rows array directly, matching postgres.js.
vi.mock("@/lib/db/server", () => ({
  getSql: () => ({
    unsafe: (_sql: string, params: readonly unknown[]) => {
      const code = params[0] as string;
      // Mirror `where join_code = $1 and lifecycle <> 'ended' limit 1`.
      const match = mockGames.find(
        (g) => g.join_code === code && g.lifecycle !== "ended",
      );
      return Promise.resolve(match ? [{ id: match.id }] : []);
    },
  }),
}));

import { POST } from "./route";

/** Build a POST Request whose body is the given raw string (not re-serialized). */
function rawRequest(body: string): Request {
  return new Request("http://test/api/games/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Build a POST Request whose JSON body carries the given joinCode. */
function jsonRequest(joinCode: unknown): Request {
  return rawRequest(JSON.stringify({ joinCode }));
}

/** A valid-shape submitted code padded/truncated to an exact length. */
function codeOfLength(length: number): string {
  return "A".repeat(length);
}

beforeEach(() => {
  mockGames.length = 0;
});

describe("POST /api/games/resolve — resolution edge cases (Task 5.5)", () => {
  it("returns 404 { resolved: false } for a malformed JSON body (R6.2/R6.4)", async () => {
    // Not valid JSON — the route's `request.json()` throws and it returns the
    // uniform not-found without any DB lookup.
    const res = await POST(rawRequest("this is not json {"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ resolved: false });
  });

  it("resolves a code that matches a `live` game — only `ended` is excluded (R6.1)", async () => {
    // A live (not lobby) game must still resolve: the route filters on
    // `lifecycle <> 'ended'`, so `live` is a hit.
    mockGames.push({
      id: "game-live-1",
      join_code: "LIVE99",
      lifecycle: "live",
    });

    const res = await POST(jsonRequest("live99"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      resolved: true,
      gameId: "game-live-1",
    });
  });

  it("returns 404 for a code belonging only to an `ended` game (R6.3/R6.4)", async () => {
    mockGames.push({
      id: "game-ended-1",
      join_code: "DONE12",
      lifecycle: "ended",
    });

    const res = await POST(jsonRequest("done12"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ resolved: false });
  });

  describe("boundary code lengths (R6.2)", () => {
    it("rejects a 5-character code (below the 6–12 range) → 404", async () => {
      // Seed a matching row so a rejection can only come from the shape check,
      // not from an empty table.
      const code = codeOfLength(5);
      mockGames.push({ id: "game-5", join_code: code, lifecycle: "lobby" });

      const res = await POST(jsonRequest(code));

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ resolved: false });
    });

    it("accepts a 6-character code (lower bound) → 200 with the matching id", async () => {
      const code = codeOfLength(6);
      mockGames.push({ id: "game-6", join_code: code, lifecycle: "lobby" });

      const res = await POST(jsonRequest(code));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        resolved: true,
        gameId: "game-6",
      });
    });

    it("accepts a 12-character code (upper bound) → 200 with the matching id", async () => {
      const code = codeOfLength(12);
      mockGames.push({ id: "game-12", join_code: code, lifecycle: "lobby" });

      const res = await POST(jsonRequest(code));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        resolved: true,
        gameId: "game-12",
      });
    });

    it("rejects a 13-character code (above the 6–12 range) → 404", async () => {
      const code = codeOfLength(13);
      mockGames.push({ id: "game-13", join_code: code, lifecycle: "lobby" });

      const res = await POST(jsonRequest(code));

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ resolved: false });
    });
  });
});
