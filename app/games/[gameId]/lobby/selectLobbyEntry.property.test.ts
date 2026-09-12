import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { selectLobbyEntry, type LobbyEntry } from "./selectLobbyEntry";

/**
 * Feature: lobby-host-player-and-sharing, Property 2: Exhaustive, mutually
 * exclusive lobby-entry selection.
 *
 * For any combination of the durable local facts `(isAdmin, hasJoined)` plus
 * whether the visitor arrived with a resolved Join_Code (`hasResolvedCode`)
 * while a Game is in the Lobby, `selectLobbyEntry` returns EXACTLY ONE
 * lobby-entry surface, chosen in priority order:
 *   - `hasJoined`            -> 'team'          (the Team_Pipeline / TeamSelection)
 *   - else `isAdmin`         -> 'host-complete' (the not-yet-joined Admin surface)
 *   - else `hasResolvedCode` -> 'code-complete' (name-only join for a code-arriving visitor)
 *   - else                   -> 'join'          (the full code-entry Join_Game_Form)
 *
 * The returned value is always exactly one of the four valid surfaces, and it
 * matches the spec mapping and no other — so the selection is both exhaustive
 * (every input has a defined surface) and mutually exclusive (never two).
 *
 * Validates: Requirements 3.2, 4.1, 4.2, 4.3, 4.4
 */

/** The four valid lobby-entry surfaces. */
const VALID_SURFACES: readonly LobbyEntry[] = [
  "team",
  "host-complete",
  "code-complete",
  "join",
];

/** The reference mapping, expressed independently of the implementation. */
function expectedSurface(
  isAdmin: boolean,
  hasJoined: boolean,
  hasResolvedCode: boolean,
): LobbyEntry {
  if (hasJoined) return "team";
  if (isAdmin) return "host-complete";
  if (hasResolvedCode) return "code-complete";
  return "join";
}

describe("selectLobbyEntry — exhaustive, mutually exclusive selection (Property 2)", () => {
  it("returns exactly one of the four surfaces, matching the spec mapping and no other, for every (isAdmin, hasJoined, hasResolvedCode)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (isAdmin, hasJoined, hasResolvedCode) => {
          const result = selectLobbyEntry(isAdmin, hasJoined, hasResolvedCode);

          // Exhaustive + closed: the result is always one of the four valid
          // surfaces (never undefined, never an out-of-set value).
          expect(VALID_SURFACES).toContain(result);

          // Correct per the spec mapping.
          const expected = expectedSurface(isAdmin, hasJoined, hasResolvedCode);
          expect(result).toBe(expected);

          // Mutually exclusive: the result equals the expected surface and no
          // other — exactly one of the four surfaces is selected.
          const selectedCount = VALID_SURFACES.filter(
            (surface) => surface === result,
          ).length;
          expect(selectedCount).toBe(1);
          for (const surface of VALID_SURFACES) {
            expect(surface === result).toBe(surface === expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("defaults hasResolvedCode to false, preserving the two-arg mapping", () => {
    // Calling with only (isAdmin, hasJoined) must behave as if hasResolvedCode
    // is false: an Admin who has not joined still lands on 'host-complete', and
    // any other not-yet-joined visitor falls through to the full 'join' form
    // (never 'code-complete', which requires a resolved code).
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (isAdmin, hasJoined) => {
        const defaulted = selectLobbyEntry(isAdmin, hasJoined);
        const explicitFalse = selectLobbyEntry(isAdmin, hasJoined, false);
        expect(defaulted).toBe(explicitFalse);

        if (!hasJoined && isAdmin) {
          expect(defaulted).toBe("host-complete");
        }
        if (!hasJoined && !isAdmin) {
          expect(defaulted).toBe("join");
        }
      }),
      { numRuns: 100 },
    );
  });
});
