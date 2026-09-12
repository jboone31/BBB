import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Feature: in-game-landing-wireframe, Task 11.2 — realtime reuse reference (NOT a re-proof).
 *
 * The Game_Board page does not re-implement the realtime machinery that makes
 * live propagation correct. It **reuses**, unchanged, the already-property-tested
 * `lib/realtime` foundation (subscribe / applyInOrder / ReconnectController /
 * ResumeController / LocalStorageLastSeenStore / supabaseBrowser). Per the
 * design's Testing Strategy, the board therefore does NOT re-test that behavior;
 * these guarantees are proven once, in the foundation suites, and merely wired
 * in here (the wiring itself is exercised by the board page example/render tests
 * in `page.test.tsx`).
 *
 * This file is that citation, kept honest by lightweight assertions rather than
 * prose alone: it asserts (1) each cited foundation property suite still exists,
 * and (2) the board page still imports the reused realtime modules. If a cited
 * suite is renamed/removed, or the board stops importing the reused machinery
 * (e.g. someone starts hand-rolling reconnect/resume), this test fails and the
 * citation stops silently rotting.
 *
 * Cited foundation property suites (the reused, already-proven behaviors):
 *
 *   - Ordered apply (R8.3): out-of-order / duplicated delivery is applied once
 *     each in ascending `seq` order.
 *       → lib/realtime/orderedApply.property.test.ts
 *         (web-app-foundation, Property 13: Client applies events in sequence order)
 *
 *   - Per-game isolation (R8.4): a client scoped to game G applies/reads only
 *     G's events, never another game's.
 *       → lib/realtime/isolation.property.test.ts
 *         (web-app-foundation, Property 14: Per-game isolation of delivery and data access)
 *
 *   - Bounded reconnect ≤5s / ≤12 (R8.5 / R8.7): the transient reconnect schedule
 *     never exceeds a 5s delay and at most 12 attempts, then goes terminal.
 *       → lib/realtime/reconnect.property.test.ts
 *         (web-app-foundation, Property 11: Reconnect schedule stays within bounds)
 *
 *   - Resume catch-up (R8.6): on resume-from-background / relaunch, exactly the
 *     events above the persisted watermark are delivered, once each, in order.
 *       → lib/realtime/resume.property.test.ts
 *         (web-app-foundation, Property 12: Resume catch-up delivers exactly the missed events)
 *
 * Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7 (by reference — proven in the
 * cited foundation suites, not re-proven here).
 */

/** Repo root, resolved from this test file's location. */
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** The foundation property suites the board reuses, each keyed to the R8.x clause it covers. */
const CITED_SUITES: ReadonlyArray<{
  requirement: string;
  behavior: string;
  file: string;
  propertyTag: string;
}> = [
  {
    requirement: "8.3",
    behavior: "ordered apply",
    file: "lib/realtime/orderedApply.property.test.ts",
    propertyTag:
      "Feature: web-app-foundation, Property 13: Client applies events in sequence order",
  },
  {
    requirement: "8.4",
    behavior: "per-game isolation",
    file: "lib/realtime/isolation.property.test.ts",
    propertyTag:
      "Feature: web-app-foundation, Property 14: Per-game isolation of delivery and data access",
  },
  {
    requirement: "8.5/8.7",
    behavior: "bounded reconnect (≤5s / ≤12 attempts)",
    file: "lib/realtime/reconnect.property.test.ts",
    propertyTag:
      "Feature: web-app-foundation, Property 11: Reconnect schedule stays within bounds",
  },
  {
    requirement: "8.6",
    behavior: "resume catch-up",
    file: "lib/realtime/resume.property.test.ts",
    propertyTag:
      "Feature: web-app-foundation, Property 12: Resume catch-up delivers exactly the missed events",
  },
];

/** The reused `lib/realtime` symbols the board page imports (the wiring seam). */
const REUSED_REALTIME_IMPORTS: ReadonlyArray<string> = [
  "subscribe",
  "LocalStorageLastSeenStore",
  "ReconnectController",
  "ResumeController",
];

describe("Game_Board reuses lib/realtime foundation suites (Task 11.2 reference)", () => {
  it.each(CITED_SUITES)(
    "cites an existing foundation suite for $behavior (R$requirement)",
    ({ file, propertyTag }) => {
      const abs = path.join(repoRoot, file);
      // The cited suite must still exist — a rename/removal breaks the citation.
      expect(existsSync(abs), `cited suite missing: ${file}`).toBe(true);
      // ...and still carry the exact property it is cited for, so the citation
      // points at the behavior we claim it does.
      const contents = readFileSync(abs, "utf8");
      expect(contents, `cited suite lost its property tag: ${file}`).toContain(
        propertyTag,
      );
    },
  );

  it("keeps the board page importing the reused realtime machinery (not hand-rolled)", () => {
    const boardPage = path.join(
      repoRoot,
      "app/games/[gameId]/board/page.tsx",
    );
    expect(existsSync(boardPage)).toBe(true);
    const contents = readFileSync(boardPage, "utf8");

    // The board must still pull the reused modules from lib/realtime.
    expect(contents).toContain('from "@/lib/realtime"');
    for (const symbol of REUSED_REALTIME_IMPORTS) {
      expect(contents, `board no longer references ${symbol}`).toContain(symbol);
    }
  });
});
