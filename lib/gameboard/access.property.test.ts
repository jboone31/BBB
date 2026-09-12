import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  selectBoardAccess,
  type BoardAccess,
} from "@/lib/gameboard/access";
import type { GameBoardLifecycle } from "@/lib/gameboard/events";

/**
 * Feature: in-game-landing-wireframe, Property 1: Board access decision is
 * exhaustive and gated.
 *
 * For any combination of Session presence (`hasSession`), membership role
 * (`isAdmin` / `isPlayer`, covering Admin, Player, or neither), and Game
 * lifecycle (`lobby`, `live`, `ended`), `selectBoardAccess` returns EXACTLY ONE
 * of the five valid decisions. It returns `board` IF AND ONLY IF a valid Session
 * is present, the Session is Admin or Player, and lifecycle is `live`; every
 * other input yields a non-`board` decision (design.md §Board access gate).
 *
 * Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.6
 */

/** The five valid board-access decisions. */
const VALID_DECISIONS: readonly BoardAccess[] = [
  "no-session",
  "not-authorized",
  "redirect-lobby",
  "ended",
  "board",
];

/** All three lifecycle phases, exhaustively generated. */
const LIFECYCLES: readonly GameBoardLifecycle[] = ["lobby", "live", "ended"];

/**
 * The reference mapping from the design's access-gate table, expressed
 * independently of the implementation and in the same priority order:
 * no Session → not-Admin-nor-Player → lobby → ended → board.
 */
function expectedDecision(
  lifecycle: GameBoardLifecycle,
  hasSession: boolean,
  isAdmin: boolean,
  isPlayer: boolean,
): BoardAccess {
  if (!hasSession) return "no-session";
  if (!isAdmin && !isPlayer) return "not-authorized";
  if (lifecycle === "lobby") return "redirect-lobby";
  if (lifecycle === "ended") return "ended";
  return "board";
}

describe("selectBoardAccess — exhaustive, gated access decision (Property 1)", () => {
  it("returns exactly one of the five decisions, and returns board iff a valid Admin-or-Player Session with a live lifecycle", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LIFECYCLES),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (lifecycle, hasSession, isAdmin, isPlayer) => {
          const result = selectBoardAccess(
            lifecycle,
            hasSession,
            isAdmin,
            isPlayer,
          );

          // Exhaustive + closed: the result is always one of the five valid
          // decisions (never undefined, never an out-of-set value).
          expect(VALID_DECISIONS).toContain(result);

          // Exactly one decision is selected — it matches the reference mapping
          // and no other of the five.
          const expected = expectedDecision(
            lifecycle,
            hasSession,
            isAdmin,
            isPlayer,
          );
          expect(result).toBe(expected);
          const selectedCount = VALID_DECISIONS.filter(
            (decision) => decision === result,
          ).length;
          expect(selectedCount).toBe(1);

          // The board-iff invariant (R1.1): `board` is returned if and only if a
          // valid Session is present, the Session is Admin or Player, and the
          // lifecycle is `live`.
          const shouldBeBoard =
            hasSession && (isAdmin || isPlayer) && lifecycle === "live";
          expect(result === "board").toBe(shouldBeBoard);
        },
      ),
      { numRuns: 100 },
    );
  });
});
