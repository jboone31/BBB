import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";

/**
 * Task 13.2 — Property 1: Admin session is recorded verbatim on create.
 *
 * *For any* session identifier, creating a Game via `POST /api/games` records
 * that exact session identifier as the Game's `admin_session_id` — a
 * create-with-`sid` round-trips to `admin_session_id === sid` (R1.2, R8.1).
 *
 * The property is about *persisted* state produced by the real create route, so
 * it is exercised as an env-gated DB round-trip against a live Postgres,
 * mirroring the gating convention used by the schema/migration suites
 * (`supabase/__tests__/playersTeamNullable.test.ts`,
 * `migrationsSchema.test.ts`): it skips cleanly when `SUPABASE_DB_URL` is unset,
 * so the default `npm test` run stays green with no database.
 *
 * The route module (and `lib/db/server`) import `server-only`, which only
 * resolves inside the Next.js bundler, so both are loaded LAZILY (dynamic
 * import) — when this suite is skipped neither module is evaluated.
 *
 * Every Game created by the property is tracked and cascade-deleted in
 * `afterAll`, so the run leaves the database as it found it.
 *
 * Validates: Requirements 1.2, 8.1.
 */

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

const SESSION_HEADER = "x-bbb-session-id";

// Lazy module handles — only imported when the live-DB suite actually runs.
type RouteModule = typeof import("./route");
type ServerDb = typeof import("@/lib/db/server");

let routeModule: RouteModule | undefined;
let serverDb: ServerDb | undefined;

async function route(): Promise<RouteModule> {
  routeModule ??= await import("./route");
  return routeModule;
}
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

/** Build a `POST /api/games` request carrying the given session id header. */
function createRequest(sessionId: string): Request {
  return new Request("http://localhost/api/games", {
    method: "POST",
    headers: { [SESSION_HEADER]: sessionId },
  });
}

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "Property 1 — admin session recorded verbatim on create (Req 1.2, 8.1)",
  () => {
    // Track every game the property creates so we can remove them afterward.
    const createdGameIds: string[] = [];

    afterAll(async () => {
      if (!serverDb) return;
      const { withTransaction, closeDb } = serverDb;
      try {
        if (createdGameIds.length > 0) {
          await withTransaction(async (tx) => {
            // Cascade-delete removes the game plus its game_created event.
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

    it("round-trips any submitted session id to the Game's admin_session_id", async () => {
      const { POST } = await route();
      const { withTransaction } = await db();

      await fc.assert(
        // A session identifier is an opaque, non-empty string in the
        // Identity_Model. Constrain the generator to the realistic input space:
        // non-empty after trimming (the route rejects blank headers) and free of
        // control characters that an HTTP header cannot carry. The route trims
        // the header, so the persisted value must equal the *trimmed* input.
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 128 })
            .filter((s) => s.trim().length > 0)
            // Exclude characters not permitted in an HTTP header field value.
            .filter((s) => /^[\x20-\x7e]*$/.test(s)),
          async (rawSessionId) => {
            const expected = rawSessionId.trim();

            const response = await POST(createRequest(rawSessionId));
            expect(response.status).toBe(201);

            const body = (await response.json()) as {
              applied: boolean;
              gameId: string;
              joinCode: string;
            };
            expect(body.applied).toBe(true);
            expect(typeof body.gameId).toBe("string");
            createdGameIds.push(body.gameId);

            // Read the persisted row back and assert the exact round-trip.
            const persisted = await withTransaction(async (tx) => {
              const { rows } = await tx.query(
                `select admin_session_id from games where id = $1`,
                [body.gameId],
              );
              return rows[0] as { admin_session_id: string } | undefined;
            });

            expect(persisted).toBeDefined();
            expect(String(persisted!.admin_session_id)).toBe(expected);
          },
        ),
        { numRuns: 100 },
      );
    });
  },
);
