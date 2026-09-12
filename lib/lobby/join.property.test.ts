import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MAX_DISPLAY_NAME,
  MIN_DISPLAY_NAME,
  validateDisplayName,
} from "./displayName";

/**
 * Property coverage for the join-game route (design §Components, `player_joined`
 * event; `app/api/games/[gameId]/join/route.ts`).
 *
 * The DB write itself (a `players` row landing in Postgres) is exercised by the
 * env-gated integration suite under `supabase/__tests__` (design Testing
 * Strategy: "player recorded (R3.7 DB side)"). This co-located property test
 * covers the *pure* record-building the route performs before the write: given
 * the joining Session and a valid raw display name, it constructs the Player
 * record whose `sessionId` is the joining Session verbatim and whose
 * `displayName` is the trimmed name produced by {@link validateDisplayName}.
 *
 * `buildPlayerRecord` models exactly that composition (R3.5 trim + R3.7 record).
 * Keeping it here — rather than importing an unwritten route — lets the property
 * pin the round-trip law the route must uphold, independent of I/O.
 */

/** The fields the join route persists / echoes for a newly joined Player. */
interface PlayerRecord {
  /** The joining Session, recorded verbatim (R3.7). */
  readonly sessionId: string;
  /** The trimmed display name (R3.5/R3.7). */
  readonly displayName: string;
}

/**
 * Build the Player record for a join, mirroring the route: the Session is
 * recorded as-is, and the display name is validated+trimmed. Throws on an
 * invalid name so callers must gate on {@link validateDisplayName} first — the
 * property below only feeds names it has already deemed valid.
 */
function buildPlayerRecord(
  sessionId: string,
  rawDisplayName: string,
): PlayerRecord {
  const validated = validateDisplayName(rawDisplayName);
  if (!validated.ok) {
    throw new Error(`invalid display name: ${validated.reason}`);
  }
  return { sessionId, displayName: validated.value };
}

/**
 * A raw display name whose *trimmed* length is 1..40, optionally padded with
 * surrounding whitespace so trimming is genuinely exercised. The trimmed core
 * is what the record must carry, regardless of the padding.
 */
const validRawDisplayNameArb = fc
  .integer({ min: MIN_DISPLAY_NAME, max: MAX_DISPLAY_NAME })
  .chain((coreLen) =>
    fc.record({
      // A core of non-whitespace characters of the chosen length, matching the
      // sibling suites' convention (`"x".repeat(...)`). This keeps `trim()` from
      // eating into the core so the core length decides the trimmed result.
      core: fc.constant("x".repeat(coreLen)),
      pad: fc.string({
        unit: fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"),
        minLength: 0,
        maxLength: 5,
      }),
    }),
  )
  .map(({ core, pad }) => ({ raw: `${pad}${core}${pad}`, core }));

/** A session identifier — any non-empty string (UUIDs in practice). */
const sessionIdArb = fc.string({ minLength: 1, maxLength: 64 });

/**
 * Feature: game-setup-lobby, Property 15: Join records the joining session and
 * trimmed name.
 *
 * For any session identifier and any valid raw display name, the recorded
 * Player carries that session identifier and the trimmed display name (a join
 * round-trips its session and normalized name).
 *
 * Validates: Requirements 3.7
 */
describe("join record — records the joining session and trimmed name (Property 15)", () => {
  it("carries the session verbatim and the trimmed display name", () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        validRawDisplayNameArb,
        (sessionId, { raw, core }) => {
          const record = buildPlayerRecord(sessionId, raw);

          // Session is recorded verbatim — unchanged from the request.
          expect(record.sessionId).toBe(sessionId);

          // Display name is the trimmed value...
          expect(record.displayName).toBe(raw.trim());
          // ...which, for these generated inputs, is exactly the padded core.
          expect(record.displayName).toBe(core);

          // The stored name is never padded and is within the accepted bounds.
          expect(record.displayName).toBe(record.displayName.trim());
          expect(record.displayName.length).toBeGreaterThanOrEqual(
            MIN_DISPLAY_NAME,
          );
          expect(record.displayName.length).toBeLessThanOrEqual(
            MAX_DISPLAY_NAME,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is a fixed point: re-recording the stored name yields the same record", () => {
    // Round-trip stability — once trimmed, the name passes through unchanged, so
    // recording it again reproduces the identical record for the same session.
    fc.assert(
      fc.property(
        sessionIdArb,
        validRawDisplayNameArb,
        (sessionId, { raw }) => {
          const first = buildPlayerRecord(sessionId, raw);
          const second = buildPlayerRecord(first.sessionId, first.displayName);
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 100 },
    );
  });
});
