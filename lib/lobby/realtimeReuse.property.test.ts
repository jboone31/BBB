import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Reference suite for lobby Properties 22, 23, 24 (task 8.1).
 *
 * These three real-time properties are NOT re-implemented here. The lobby
 * design (Correctness Properties 22–24) states each one "reuses the
 * foundation's" existing suite: the Lobby_Client subscribes through
 * `lib/realtime/*` unchanged, so the foundation's already-passing property
 * tests are the coverage for these requirements. This file exists only to
 * document that reuse and to cite — by exact path — where each property is
 * actually property-tested, so the traceability is greppable from `lib/lobby`.
 *
 * The tests below assert the cited suites still exist, so this reference fails
 * loudly if a foundation suite is renamed or moved rather than silently going
 * stale.
 *
 * - Property 22: Per-game isolation of applied events — a subscription for one
 *   Game applies only events whose `gameId` matches the subscribed Game.
 *   Reused suite: lib/realtime/isolation.property.test.ts
 *   ("Per-game isolation — delivery", foundation Property 14 / Req 6.3).
 *   Validates: Requirements 7.4
 *
 * - Property 23: Bounded reconnect schedule — `reconnectDelay(i)` is within
 *   [0, 5000]ms for 1 ≤ i ≤ 12 and signals no further attempt for i > 12.
 *   Reused suite: lib/realtime/reconnect.property.test.ts
 *   ("reconnectDelay — Reconnect schedule stays within bounds").
 *   Validates: Requirements 7.5
 *
 * - Property 24: Resume catch-up delivers exactly the missed tail — resume
 *   re-initialization delivers exactly the events with `seq > L`, in ascending
 *   `seq` order, before resuming live delivery.
 *   Reused suite: lib/realtime/resume.property.test.ts
 *   (foundation Property 12 / Req 6.7).
 *   Validates: Requirements 7.6
 *
 * Validates: Requirements 7.4, 7.5, 7.6
 */

/** Repo root, two levels up from lib/lobby/. */
const REPO_ROOT = resolve(__dirname, "..", "..");

/** The reused foundation suites, keyed by the lobby property they cover. */
const REUSED_SUITES: ReadonlyArray<{
  property: string;
  requirement: string;
  path: string;
}> = [
  {
    property: "Property 22: Per-game isolation of applied events",
    requirement: "7.4",
    path: "lib/realtime/isolation.property.test.ts",
  },
  {
    property: "Property 23: Bounded reconnect schedule",
    requirement: "7.5",
    path: "lib/realtime/reconnect.property.test.ts",
  },
  {
    property: "Property 24: Resume catch-up delivers exactly the missed tail",
    requirement: "7.6",
    path: "lib/realtime/resume.property.test.ts",
  },
];

describe("Lobby real-time properties reuse foundation suites (Properties 22–24)", () => {
  it.each(REUSED_SUITES)(
    "$property is covered by $path (Req $requirement)",
    ({ path }) => {
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
    },
  );
});
