import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { buildShareLink } from "./shareLink";

/**
 * Feature: lobby-host-player-and-sharing, Property 3: Share_Link round-trips to the same game and code
 *
 * `buildShareLink(origin, gameId, code)` always yields a relative `path` for the
 * Game's Lobby with the Join_Code embedded as the `code` query parameter, and an
 * `absolute` link that is present iff an origin was supplied:
 *
 *  - R5.2/R5.3: when an origin is present, an absolute link is produced and
 *    parsing it (`new URL(absolute)`) recovers the same `gameId` from the
 *    `/games/{gameId}/lobby` path segment and the same `code` from the query.
 *  - R5.4: when the origin is `null` (SSR), `absolute === null` while `path`
 *    still carries the URL-encoded code so the Join_Code stays representable.
 *
 * Validates: Requirements 5.2, 5.3, 5.4
 */

/**
 * URL-safe, non-empty `gameId` segments. Restricting to unreserved URL
 * characters keeps the id a single, unambiguous path segment so that a parsed
 * absolute link's `/games/{gameId}/lobby` pathname round-trips exactly.
 */
const gameIdArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split(
      "",
    ),
  ),
  minLength: 1,
  maxLength: 24,
});

/**
 * Valid Join_Codes: 6–12 alphanumeric characters, matching the
 * `isValidSubmittedCode` shape in `lib/lobby/joinCode`.
 */
const joinCodeArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(
      "",
    ),
  ),
  minLength: 6,
  maxLength: 12,
});

/**
 * A browser origin (scheme + host, no trailing slash) as `new URL` reports it.
 * Building the origin from a URL and reading back `.origin` guarantees the
 * generated value is a real, parseable origin.
 */
const originArb: fc.Arbitrary<string> = fc
  .webUrl()
  .map((url) => new URL(url).origin);

/** `origin` is either `null` (SSR) or a valid browser origin (client). */
const originOrNullArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  originArb,
);

describe("buildShareLink — Share_Link round-trips to the same game and code (Property 3)", () => {
  it("produces an absolute link iff an origin is present and round-trips gameId + code", () => {
    fc.assert(
      fc.property(
        gameIdArb,
        joinCodeArb,
        originOrNullArb,
        (gameId, code, origin) => {
          const { path, absolute } = buildShareLink(origin, gameId, code);

          // The path is always the Lobby URL with the code URL-encoded (R5.2, R5.4).
          expect(path).toBe(
            `/games/${gameId}/lobby?code=${encodeURIComponent(code)}`,
          );

          if (origin === null) {
            // SSR: no absolute link, but the code is still representable in the
            // relative path (R5.4).
            expect(absolute).toBeNull();
            expect(path).toContain(encodeURIComponent(code));
            return;
          }

          // Client: an absolute link is produced (R5.2, R5.3) ...
          expect(absolute).not.toBeNull();
          const parsed = new URL(absolute as string);

          // ... its origin is the supplied origin (R5.3) ...
          expect(parsed.origin).toBe(origin);

          // ... the gameId path segment round-trips (R5.2) ...
          const segments = parsed.pathname.split("/");
          // pathname is "/games/{gameId}/lobby" -> ["", "games", gameId, "lobby"]
          expect(segments[1]).toBe("games");
          expect(decodeURIComponent(segments[2])).toBe(gameId);
          expect(segments[3]).toBe("lobby");

          // ... and the code query param round-trips (R5.2).
          expect(parsed.searchParams.get("code")).toBe(code);
        },
      ),
      { numRuns: 100 },
    );
  });
});
