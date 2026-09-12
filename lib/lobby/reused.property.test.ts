import { describe, expect, it } from "vitest";

import { validateBarDesignation } from "@/lib/games";
import { canStartGame, MAX_TEAMS, MIN_TEAMS } from "@/lib/gameend";

/**
 * Reference-only suite for lobby correctness Properties 8 and 10 (design
 * §Correctness Properties). Both properties are stated by the lobby design as
 * *reusing* foundation logic that is already property-tested — the lobby layer
 * imports those functions verbatim rather than re-deriving the rules, so the
 * design explicitly directs that they are NOT re-implemented here.
 *
 * This file exists so the reuse is discoverable from `lib/lobby/`: it names the
 * reused functions, points at the authoritative foundation suites, and confirms
 * the imports resolve (a broken re-export would fail typecheck/compile here).
 * The exhaustive iff coverage lives in the cited foundation suites.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Property 8 — Start-game team-count bound
 *   Validates: Requirements 5.1, 5.3, 5.4
 *   Reused function: `canStartGame` (with `MIN_TEAMS`/`MAX_TEAMS`) from `lib/gameend`.
 *   Authoritative property suite:
 *     lib/gameend/teamcount.property.test.ts
 *       ("canStartGame — Team-count bound per game")
 *   The lobby start route (design §Components 3, task 17) calls `canStartGame`
 *   directly; the 2..4 iff bound is proven there.
 *
 * Property 10 — Bar designation start ≠ finish
 *   Validates: Requirements 2.3
 *   Reused function: `validateBarDesignation` from `lib/games`.
 *   Authoritative property suite:
 *     lib/games/designation.test.ts
 *       ("validateBarDesignation — start/finish designation")
 *   The lobby bars route (design §Components 1d, task 13) calls
 *   `validateBarDesignation` verbatim; the start-≠-finish rule is proven there.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe("lib/lobby — reused foundation property suites (Properties 8, 10)", () => {
  it("Property 8: reuses lib/gameend/teamcount.property.test.ts — canStartGame is imported, not re-implemented", () => {
    // Not a re-test of the property (that lives in the cited foundation suite);
    // just a smoke assertion that the reused symbols resolve so the reference
    // stays honest if the foundation export ever changes shape.
    expect(typeof canStartGame).toBe("function");
    expect(MIN_TEAMS).toBe(2);
    expect(MAX_TEAMS).toBe(4);
  });

  it("Property 10: reuses lib/games/designation.test.ts — validateBarDesignation is imported, not re-implemented", () => {
    expect(typeof validateBarDesignation).toBe("function");
  });
});
