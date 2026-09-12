import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";

/**
 * Property tests for the code → gameId Resolution_Service
 * (`app/api/games/resolve/route.ts`; app-shell-navigation design "Correctness
 * Properties").
 *
 * The route's pure decision logic — not Supabase — is the target here, so the
 * database is replaced with a tiny in-memory `games` store. Mocking
 * `@/lib/db/server` wholesale has a second, essential benefit: that module opens
 * with `import "server-only"`, a build-time guard that throws under plain Vitest
 * (no Next.js bundler). Because `vi.mock` substitutes the module before it is
 * ever evaluated, `server-only` never loads and the route runs offline.
 *
 * `route.ts` binds `getSql` at import time, so the mock's `getSql` closes over a
 * MUTABLE in-memory store (`gamesStore`) that each test seeds via `setGames`.
 * Its `.unsafe(sql, params)` mirrors the route's query semantics: match on
 * `join_code = $1` while excluding `lifecycle = 'ended'`, returning `[{ id }]` or
 * `[]`.
 *
 * Shared setup (the DB mock, the in-memory store, `setGames`, and the request
 * builder) lives at module scope so the sibling property suites for Property 2
 * (Task 5.3) and Property 3 (Task 5.4) can append their own `describe`/`it`
 * blocks against the same fixtures without duplication.
 */

// ---------------------------------------------------------------------------
// In-memory `games` store + DB mock (shared across all suites in this file).
// ---------------------------------------------------------------------------

/** Lifecycle values a Game row can hold, mirroring the `games.lifecycle` enum. */
type Lifecycle = "lobby" | "live" | "ended";

/** A minimal Game row: only the columns the resolution query touches. */
interface GameRow {
  readonly id: string;
  readonly join_code: string;
  readonly lifecycle: Lifecycle;
}

/**
 * The mutable backing store the mocked `getSql()` reads. Tests replace its
 * contents via {@link setGames}; `beforeEach` empties it so suites never leak
 * rows into one another.
 */
let gamesStore: GameRow[] = [];

/** Seed the in-memory store for the current test. */
function setGames(rows: readonly GameRow[]): void {
  gamesStore = [...rows];
}

// Mock the server-only DB module: `getSql()` returns an object whose
// `.unsafe(sql, params)` resolves to rows from `gamesStore`, applying the same
// filter the route's SQL does — `join_code = $1 AND lifecycle <> 'ended'`,
// limited to one row. This replaces Supabase with our decision-logic harness and
// keeps `server-only` from ever being evaluated.
vi.mock("@/lib/db/server", () => ({
  getSql: () => ({
    unsafe: async (_sql: string, params: readonly unknown[] = []) => {
      const wanted = String(params[0] ?? "");
      const match = gamesStore.find(
        (g) => g.join_code === wanted && g.lifecycle !== "ended",
      );
      return match ? [{ id: match.id }] : [];
    },
  }),
}));

// ---------------------------------------------------------------------------
// Shared request helper.
// ---------------------------------------------------------------------------

/** Build a `POST /api/games/resolve` request carrying the given JSON body. */
function resolveRequest(body: unknown): Request {
  return new Request("http://localhost/api/games/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The route imports the mocked `@/lib/db/server`, so it is safe to import
// statically once the mock is registered (vi.mock is hoisted above imports).
import { POST } from "./route";

beforeEach(() => {
  gamesStore = [];
});

// ---------------------------------------------------------------------------
// Property 1 — Not-found is uniform and indistinguishable (Task 5.2).
// ---------------------------------------------------------------------------

describe("Feature: app-shell-navigation, Property 1: Not-found is uniform and indistinguishable", () => {
  // A well-formed submitted code: 6–12 characters from an alphanumeric alphabet.
  // (Uppercase-only keeps the generated code equal to its normalized form, which
  // matters for the "unmatched" case where we must guarantee no row matches.)
  const wellFormedCode = fc
    .string({
      minLength: 6,
      maxLength: 12,
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
      ),
    })
    .filter((s) => isValidSubmittedCode(s));

  // Arbitrary raw input for the malformed case, filtered to the strings whose
  // NORMALIZED value is NOT 6–12 alphanumeric (so the route rejects on shape).
  const malformedCode = fc
    .string({ maxLength: 20 })
    .filter((s) => !isValidSubmittedCode(s));

  /**
   * Validates: Requirements 6.2, 6.3, 6.4.
   *
   * For every kind of miss — a malformed code (not 6–12 alphanumeric, R6.2), a
   * well-formed code that matches no non-`ended` game (R6.3), and a well-formed
   * code that matches ONLY an `ended` game (R6.4) — the route must return the
   * identical response: HTTP 404 with body `{ resolved: false }` and nothing
   * else. The three cases are asserted against one another so any divergence in
   * status, body shape, or extra fields fails the property.
   */
  it("returns the identical 404 { resolved: false } for malformed, unmatched, and ended-only misses", async () => {
    await fc.assert(
      fc.asyncProperty(
        malformedCode,
        wellFormedCode,
        wellFormedCode,
        async (malformed, unmatchedCode, endedOnlyCode) => {
          // --- Malformed miss (R6.2): no games needed; rejected on shape. ---
          setGames([]);
          const malformedRes = await POST(
            resolveRequest({ joinCode: malformed }),
          );
          const malformedBody: unknown = await malformedRes.json();

          // --- Unmatched miss (R6.3): a well-formed code with no game at all. ---
          setGames([]);
          const unmatchedRes = await POST(
            resolveRequest({ joinCode: unmatchedCode }),
          );
          const unmatchedBody: unknown = await unmatchedRes.json();

          // --- Ended-only miss (R6.4): the code belongs solely to an `ended`
          // game, which the query filters out (`lifecycle <> 'ended'`). ---
          const normalizedEnded = normalizeSubmittedCode(endedOnlyCode);
          setGames([
            {
              id: "ended-game-id",
              join_code: normalizedEnded,
              lifecycle: "ended",
            },
          ]);
          const endedRes = await POST(
            resolveRequest({ joinCode: endedOnlyCode }),
          );
          const endedBody: unknown = await endedRes.json();

          // Every miss is a 404.
          expect(malformedRes.status).toBe(404);
          expect(unmatchedRes.status).toBe(404);
          expect(endedRes.status).toBe(404);

          // Every miss carries the exact same body — no more, no less.
          const expectedBody = { resolved: false };
          expect(malformedBody).toEqual(expectedBody);
          expect(unmatchedBody).toEqual(expectedBody);
          expect(endedBody).toEqual(expectedBody);

          // And the three responses are indistinguishable from one another:
          // same status and byte-for-byte-equivalent JSON body.
          expect(unmatchedRes.status).toBe(malformedRes.status);
          expect(endedRes.status).toBe(malformedRes.status);
          expect(unmatchedBody).toEqual(malformedBody);
          expect(endedBody).toEqual(malformedBody);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Successful resolution exposes only the game id (Task 5.3).
// ---------------------------------------------------------------------------

describe("Feature: app-shell-navigation, Property 2: Successful resolution exposes only the game id", () => {
  // A well-formed submitted code: 6–12 characters from an uppercase alphanumeric
  // alphabet, so the generated value already equals its normalized form and is
  // guaranteed to match the seeded row's stored `join_code`.
  const wellFormedCode = fc
    .string({
      minLength: 6,
      maxLength: 12,
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
      ),
    })
    .filter((s) => isValidSubmittedCode(s));

  // An arbitrary, non-empty game id for the single matching row.
  const gameId = fc.string({ minLength: 1, maxLength: 40 });

  // The (non-`ended`) lifecycle of the single matching game — either resolvable
  // state qualifies, since the query only excludes `ended`.
  const liveLifecycle = fc.constantFrom<Lifecycle>("lobby", "live");

  /**
   * Validates: Requirements 6.1, 6.5.
   *
   * For any submitted code that matches exactly one non-`ended` game (R6.1), the
   * 200 response body exposes ONLY the resolved game id: its keys are exactly
   * `{ resolved, gameId }` with `resolved === true` and `gameId` equal to the
   * matched row's id. No `join_code`, no `lifecycle`, and no other game
   * attribute leak into the body (R6.5) — asserted by comparing the sorted key
   * set to the exact expected pair, so any extra field fails the property.
   */
  it("returns 200 with a body whose keys are exactly { resolved, gameId } and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(
        wellFormedCode,
        gameId,
        liveLifecycle,
        async (code, id, lifecycle) => {
          // Seed exactly one non-`ended` game owning this code. The stored
          // join_code is the normalized form, matching how the join path writes it.
          const normalized = normalizeSubmittedCode(code);
          setGames([{ id, join_code: normalized, lifecycle }]);

          const res = await POST(resolveRequest({ joinCode: code }));
          const body: unknown = await res.json();

          // A match resolves with 200.
          expect(res.status).toBe(200);

          // The body is exactly the resolved flag plus the id — no more fields.
          expect(body).toEqual({ resolved: true, gameId: id });

          // Belt-and-suspenders on R6.5: the key set is precisely these two, so
          // any leaked game field (join_code, lifecycle, etc.) fails here.
          expect(Object.keys(body as object).sort()).toEqual([
            "gameId",
            "resolved",
          ]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Resolution is invariant under code normalization (Task 5.4).
// ---------------------------------------------------------------------------

describe("Feature: app-shell-navigation, Property 3: Resolution is invariant under code normalization", () => {
  // A well-formed submitted code drawn from an UPPERCASE alphanumeric alphabet,
  // so the generated value already equals its normalized form. This is the
  // canonical code we seed the store with; the property then submits arbitrary
  // casing/whitespace variants of it and asserts they all resolve identically.
  const canonicalCode = fc
    .string({
      minLength: 6,
      maxLength: 12,
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
      ),
    })
    .filter((s) => isValidSubmittedCode(s));

  // An arbitrary, non-empty game id for the single matching row.
  const gameId = fc.string({ minLength: 1, maxLength: 40 });

  // Whitespace fragments that normalization (trim) must strip when they appear
  // only at the leading/trailing edges of a submitted code.
  const edgeWhitespace = fc.string({
    maxLength: 4,
    unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  });

  /**
   * Produce a casing/whitespace VARIANT of `canonical` that must normalize back
   * to `canonical` (which is already trimmed + uppercased). We randomly re-case
   * each character and wrap the result in arbitrary leading/trailing whitespace.
   * Interior whitespace is deliberately NOT introduced, because `trim()` only
   * strips the edges — an interior space would change the normalized value and
   * legitimately produce a different (not-found) outcome.
   */
  function variantOf(canonical: string) {
    return fc
      .tuple(
        edgeWhitespace,
        edgeWhitespace,
        fc.array(fc.boolean(), {
          minLength: canonical.length,
          maxLength: canonical.length,
        }),
      )
      .map(([lead, trail, lowerFlags]) => {
        const recased = canonical
          .split("")
          .map((ch, i) => (lowerFlags[i] ? ch.toLowerCase() : ch))
          .join("");
        return `${lead}${recased}${trail}`;
      });
  }

  /**
   * Validates: Requirements 6.6.
   *
   * The route normalizes (trim + uppercase) before matching, so resolution is
   * invariant under casing and edge-whitespace variation of the submitted code:
   * any variant of a code that names a non-`ended` game resolves to the SAME
   * gameId with a 200, and every variant resolves identically to every other.
   *
   * We seed the store once with the canonical (already-normalized) code, then
   * submit two independently generated variants of it. Each must return
   * `{ resolved: true, gameId: id }` with status 200, and the two responses must
   * be byte-for-byte equal to one another — so any casing/whitespace sensitivity
   * in the route's matching path fails the property.
   */
  it("resolves every casing/whitespace variant of a code to the same gameId", async () => {
    await fc.assert(
      fc.asyncProperty(canonicalCode, gameId, async (canonical, id) => {
        // The stored join_code is the canonical (normalized) form, matching how
        // the join path writes it.
        setGames([{ id, join_code: canonical, lifecycle: "lobby" }]);

        // Two arbitrary casing/whitespace renderings of the same code.
        const [variantA, variantB] = await Promise.all([
          fc.sample(variantOf(canonical), 1)[0],
          fc.sample(variantOf(canonical), 1)[0],
        ]);

        // Sanity: each variant truly normalizes back to the canonical code, so
        // the property is exercising normalization — not an accidental miss.
        expect(normalizeSubmittedCode(variantA)).toBe(canonical);
        expect(normalizeSubmittedCode(variantB)).toBe(canonical);

        const resA = await POST(resolveRequest({ joinCode: variantA }));
        const bodyA: unknown = await resA.json();

        const resB = await POST(resolveRequest({ joinCode: variantB }));
        const bodyB: unknown = await resB.json();

        // Both variants resolve to the same game id with a 200.
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        expect(bodyA).toEqual({ resolved: true, gameId: id });
        expect(bodyB).toEqual({ resolved: true, gameId: id });

        // And the two responses are indistinguishable from one another:
        // identical status and body regardless of casing/whitespace.
        expect(resB.status).toBe(resA.status);
        expect(bodyB).toEqual(bodyA);
      }),
      { numRuns: 100 },
    );
  });
});
