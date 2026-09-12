import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { selectLobbyEntry, type LobbyEntry } from "./selectLobbyEntry";

/**
 * Feature: lobby-host-player-and-sharing, Property 2: Exhaustive, mutually
 * exclusive lobby-entry selection.
 *
 * For any combination of the durable local facts `(isAdmin, hasJoined)` while a
 * Game is in the Lobby, `selectLobbyEntry` returns EXACTLY ONE lobby-entry
 * surface, chosen as:
 *   - `hasJoined`            -> 'team'          (the Team_Pipeline / TeamSelection)
 *   - else `isAdmin`         -> 'host-complete' (the not-yet-joined Admin surface)
 *   - else                   -> 'join'          (the code-entry Join_Game_Form)
 *
 * The returned value is always exactly one of the three valid surfaces, and it
 * matches the spec mapping and no other — so the selection is both exhaustive
 * (every input has a defined surface) and mutually exclusive (never two).
 *
 * Validates: Requirements 3.2, 4.1, 4.2, 4.3, 4.4
 */

/** The three valid lobby-entry surfaces. */
const VALID_SURFACES: readonly LobbyEntry[] = ["team", "host-complete", "join"];

/** The reference mapping, expressed independently of the implementation. */
function expectedSurface(isAdmin: boolean, hasJoined: boolean): LobbyEntry {
  if (hasJoined) return "team";
  if (isAdmin) return "host-complete";
  return "join";
}

describe("selectLobbyEntry — exhaustive, mutually exclusive selection (Property 2)", () => {
  it("returns exactly one of the three surfaces, matching the spec mapping and no other, for every (isAdmin, hasJoined)", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (isAdmin, hasJoined) => {
        const result = selectLobbyEntry(isAdmin, hasJoined);

        // Exhaustive + closed: the result is always one of the three valid
        // surfaces (never undefined, never an out-of-set value).
        expect(VALID_SURFACES).toContain(result);

        // Correct per the spec mapping.
        const expected = expectedSurface(isAdmin, hasJoined);
        expect(result).toBe(expected);

        // Mutually exclusive: the result equals the expected surface and no
        // other — exactly one of the three surfaces is selected.
        const selectedCount = VALID_SURFACES.filter(
          (surface) => surface === result,
        ).length;
        expect(selectedCount).toBe(1);
        for (const surface of VALID_SURFACES) {
          expect(surface === result).toBe(surface === expected);
        }
      }),
      { numRuns: 100 },
    );
  });
});
