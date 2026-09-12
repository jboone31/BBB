import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameLifecycle } from "@/lib/gameend";

import { bothBarsDesignated, isAdmin, isLobbyPhase, isMember } from "./gate";

/**
 * Property suite for the lobby-phase and authorization gates (design
 * Correctness Properties 9, 11, 12, 13). Each gate is a pure predicate, so the
 * properties assert the exact iff relationship the design specifies across the
 * full input space — no I/O, no mocking.
 */

/** All three lifecycle values a Game can hold. */
const lifecycleArb: fc.Arbitrary<GameLifecycle> = fc.constantFrom(
  "lobby",
  "live",
  "ended",
);

/**
 * A bar-id slot: either designated (a non-empty id string) or undesignated
 * (`null`/`undefined`). Non-empty because a real bar id is always a non-empty
 * identifier; presence is what the gate keys on.
 */
const barSlotArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.constant(null),
  fc.constant(undefined),
);

/**
 * A session slot: either a present session (non-empty id) or an absent one
 * (empty string, `null`, or `undefined`). The gates treat every "absent" form
 * as "no valid session".
 */
const sessionSlotArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.constant(""),
  fc.constant(null),
  fc.constant(undefined),
);

/** True iff a session slot represents a present (non-empty) session. */
function isPresent(session: string | null | undefined): session is string {
  return typeof session === "string" && session.length > 0;
}

describe("bothBarsDesignated — Start requires both bars designated (Property 9)", () => {
  it("passes iff both the start bar and the finish bar are designated", () => {
    fc.assert(
      fc.property(barSlotArb, barSlotArb, (startBarId, finishBarId) => {
        const expected = startBarId != null && finishBarId != null;
        expect(bothBarsDesignated(startBarId, finishBarId)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("covers the four presence combinations explicitly", () => {
    expect(bothBarsDesignated("start", "finish")).toBe(true);
    expect(bothBarsDesignated("start", null)).toBe(false);
    expect(bothBarsDesignated(null, "finish")).toBe(false);
    expect(bothBarsDesignated(null, null)).toBe(false);
  });
});

describe("isLobbyPhase — Lobby-phase gate (Property 11)", () => {
  it("permits a mutation iff the lifecycle is `lobby`", () => {
    fc.assert(
      fc.property(lifecycleArb, (lifecycle) => {
        expect(isLobbyPhase(lifecycle)).toBe(lifecycle === "lobby");
      }),
      { numRuns: 100 },
    );
  });

  it("rejects `live` and `ended` and accepts `lobby`", () => {
    expect(isLobbyPhase("lobby")).toBe(true);
    expect(isLobbyPhase("live")).toBe(false);
    expect(isLobbyPhase("ended")).toBe(false);
  });
});

describe("isAdmin — Admin-authorization gate (Property 12)", () => {
  it("permits iff both sessions are present and exactly equal", () => {
    fc.assert(
      fc.property(
        sessionSlotArb,
        sessionSlotArb,
        (adminSessionId, requesterSessionId) => {
          const expected =
            isPresent(adminSessionId) &&
            isPresent(requesterSessionId) &&
            adminSessionId === requesterSessionId;
          expect(isAdmin(adminSessionId, requesterSessionId)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts an exact match and rejects mismatches and absent sessions", () => {
    expect(isAdmin("admin-1", "admin-1")).toBe(true);
    expect(isAdmin("admin-1", "someone-else")).toBe(false);
    expect(isAdmin("admin-1", null)).toBe(false);
    expect(isAdmin("admin-1", undefined)).toBe(false);
    expect(isAdmin("admin-1", "")).toBe(false);
    expect(isAdmin(null, "admin-1")).toBe(false);
    expect(isAdmin("", "")).toBe(false);
  });
});

describe("isMember — Membership-authorization gate (Property 13)", () => {
  /**
   * A membership set drawn from a small pool of ids so a random requester
   * naturally lands inside or outside the set, exercising both branches.
   */
  const memberIdArb: fc.Arbitrary<string> = fc.constantFrom(
    "admin",
    "p1",
    "p2",
    "p3",
  );
  const membershipArb: fc.Arbitrary<string[]> = fc.uniqueArray(memberIdArb, {
    maxLength: 4,
  });
  const requesterArb = fc.oneof(
    memberIdArb,
    fc.constantFrom("outsider", "ghost"),
    fc.constant(""),
    fc.constant(null),
    fc.constant(undefined),
  );

  it("permits iff the requesting session is a present member of the set", () => {
    fc.assert(
      fc.property(membershipArb, requesterArb, (members, requester) => {
        const expected = isPresent(requester) && members.includes(requester);
        expect(isMember(members, requester)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("accepts a listed member and rejects non-members and absent sessions", () => {
    const members = ["admin", "p1", "p2"];
    expect(isMember(members, "admin")).toBe(true);
    expect(isMember(members, "p2")).toBe(true);
    expect(isMember(members, "outsider")).toBe(false);
    expect(isMember(members, null)).toBe(false);
    expect(isMember(members, undefined)).toBe(false);
    expect(isMember(members, "")).toBe(false);
    expect(isMember([], "admin")).toBe(false);
  });
});
