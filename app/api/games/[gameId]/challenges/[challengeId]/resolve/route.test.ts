/**
 * Challenge-resolution route tests (card-behavior Task 7.9), on the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the
 * "POST /challenges/{challengeId}/resolve" row).
 *
 * The route runs the real pipeline (`resolveCardActor`: authorize + lock,
 * server `now`, lazy settle, `loadBehaviorState`; then the pure
 * `resolveChallenge`, `writeChallenges`, `writeEffects`, and one
 * `challenge_resolved` mutation event). These tests drive that whole pipeline
 * against the shared in-memory {@link FakeMutationDb} harness so the pipeline's
 * observable contract is asserted directly rather than mocked:
 *
 *   - Mark complete sets a gated challenge `completed` with exactly one
 *     `challenge_resolved` mutation event embedding the challenge (R5.3, R19.6);
 *   - a `failed` resolution of Everyone's a Critic sets `failed` and writes the
 *     `team_claim_block` effect embedded in that single event (R5.4, R19.6);
 *   - `not_authorized` when the actor is not on the target team, write-free
 *     (R5.3);
 *   - `already_resolved` for a non-open challenge, write-free (R5.3);
 *   - `conflict` while a live Fairest offer is pending, write-free (R5.5);
 *   - with a due-transition fixture the lazy-settle transition events precede
 *     the single mutation event (R19.9, R19.10);
 *   - an injected append failure rolls back: no mutation event, `unavailable`
 *     (R19.5, R19.9, R19.10).
 *
 * Hermetic: the fake {@link QueryRunner} needs no live Postgres (R24.2).
 *
 * Requirements: 5.3, 5.4, 5.5, 19.5, 19.6, 19.9, 19.10, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

import {
  FakeMutationDb,
  IDS,
  type ChallengeSeed,
  type FakeDbOptions,
} from "../../../cards/_mutationTestDb";

let db: FakeMutationDb;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(db.runner),
}));

import { POST } from "./route";

const CHALLENGE_ID = "chal-resolve-1";

function freshDb(options: FakeDbOptions = {}): FakeMutationDb {
  db = new FakeMutationDb(options);
  return db;
}

/**
 * A gated challenge the target team (team A, the acting team by default)
 * resolves. `go-piss-girl` is a plain gated challenge; the `slug` override
 * drives the Everyone's a Critic fail path.
 */
function gatedChallenge(overrides: Partial<ChallengeSeed> = {}): ChallengeSeed {
  return {
    id: CHALLENGE_ID,
    slug: "go-piss-girl",
    sourcePlayId: "play-1",
    casterTeamId: IDS.teamB,
    targetTeamId: IDS.teamA,
    status: "open",
    ...overrides,
  };
}

function request(
  body: unknown,
  sessionId: string | null = "session-a",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(
    `http://test/api/games/${IDS.gameId}/challenges/${CHALLENGE_ID}/resolve`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function params(): {
  params: Promise<{ gameId: string; challengeId: string }>;
} {
  return {
    params: Promise.resolve({
      gameId: IDS.gameId,
      challengeId: CHALLENGE_ID,
    }),
  };
}

beforeEach(() => {
  freshDb();
});

// ---------------------------------------------------------------------------
// Mark complete.
// ---------------------------------------------------------------------------

describe("POST /challenges/[challengeId]/resolve — mark complete", () => {
  it("sets a gated challenge completed with exactly one challenge_resolved event embedding it", async () => {
    freshDb({ challenges: [gatedChallenge()] });

    const response = await POST(request({ outcome: "completed" }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ applied: true });

    // The patched challenge was written as completed, with no failure effect.
    expect(db.challengeUpserts).toEqual([
      { id: CHALLENGE_ID, status: "completed", failureEffectId: null },
    ]);
    // A plain complete writes no effect row.
    expect(db.effectUpserts).toHaveLength(0);

    // Exactly one mutation event, carrying the embedded challenge.
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.eventType).toBe("challenge_resolved");
    expect(event.actorTeamId).toBe(IDS.teamA);
    expect(event.payload.challengeId).toBe(CHALLENGE_ID);
    expect(event.payload.outcome).toBe("completed");
    expect(
      (event.payload.challenges as { challengeId: string }[])[0].challengeId,
    ).toBe(CHALLENGE_ID);
    expect(event.payload.effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fail Everyone's a Critic.
// ---------------------------------------------------------------------------

describe("POST /challenges/[challengeId]/resolve — fail Everyone's a Critic", () => {
  it("sets failed and embeds the team_claim_block effect in the one event", async () => {
    freshDb({
      challenges: [gatedChallenge({ slug: "everyones-a-critic" })],
    });

    const response = await POST(request({ outcome: "failed" }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ applied: true });

    // The challenge is failed and names its failure effect.
    expect(db.challengeUpserts).toHaveLength(1);
    expect(db.challengeUpserts[0].status).toBe("failed");
    const failureEffectId = db.challengeUpserts[0].failureEffectId;
    expect(failureEffectId).not.toBeNull();

    // Exactly one critic block effect targeting the failing team was written.
    expect(db.effectUpserts).toHaveLength(1);
    expect(db.effectUpserts[0].kind).toBe("team_claim_block");
    expect(db.effectUpserts[0].targetTeamId).toBe(IDS.teamA);
    expect(db.effectUpserts[0].id).toBe(failureEffectId);

    // Exactly one mutation event embedding the challenge and the block effect.
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.eventType).toBe("challenge_resolved");
    expect(event.payload.outcome).toBe("failed");
    expect(
      (event.payload.effects as { effectId: string; kind: string }[])[0].kind,
    ).toBe("team_claim_block");
  });
});

// ---------------------------------------------------------------------------
// Write-free rejections.
// ---------------------------------------------------------------------------

describe("POST /challenges/[challengeId]/resolve — write-free rejections", () => {
  it("rejects not_authorized when the actor is not on the target team", async () => {
    // The challenge targets team B, but the acting session resolves to team A.
    freshDb({ challenges: [gatedChallenge({ targetTeamId: IDS.teamB })] });

    const response = await POST(request({ outcome: "completed" }), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_authorized",
    });
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.effectUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects already_resolved for a non-open challenge", async () => {
    freshDb({ challenges: [gatedChallenge({ status: "completed" })] });

    const response = await POST(request({ outcome: "completed" }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "already_resolved",
    });
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects conflict while a live Fairest offer is pending", async () => {
    // Team A (the target + acting team) holds Fairest and has a pending offer
    // attached to the challenge, so resolution is frozen (R5.5 / 9.4).
    freshDb({
      instances: [
        { slug: "fairest-of-them-all", deckState: "hand", drawPosition: 0 },
      ],
      challenges: [gatedChallenge()],
      offers: [
        {
          id: "offer-live",
          sourcePlayId: "play-1",
          holderTeamId: IDS.teamA,
          originalCasterTeamId: IDS.teamB,
          challengeId: CHALLENGE_ID,
          status: "pending",
        },
      ],
    });

    const response = await POST(request({ outcome: "completed" }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(
      request({ outcome: "completed" }, null),
      params(),
    );
    expect(response.status).toBe(401);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a non-member write-free (the actor-resolution reason maps to invalid_input)", async () => {
    // resolveCardActor rejects a non-member with `not_member`, which the route's
    // `reasonFor` — scoped to the planner's Stable_Error vocabulary — collapses
    // to `invalid_input` (400) rather than leaking the token. The point of the
    // assertion is write-free rejection before any resolution.
    freshDb({ member: false, challenges: [gatedChallenge()] });
    const response = await POST(request({ outcome: "completed" }), params());
    expect(response.status).toBe(400);
    expect(db.mutationEvents).toHaveLength(0);
    expect(db.challengeUpserts).toHaveLength(0);
  });

  it("rejects a bad outcome body with 400", async () => {
    freshDb({ challenges: [gatedChallenge()] });
    const response = await POST(request({ outcome: "nope" }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_input",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lazy-settle ordering + append-failure rollback.
// ---------------------------------------------------------------------------

describe("POST /challenges/[challengeId]/resolve — settle ordering + rollback", () => {
  it("orders the lazy-settle transition events before the single mutation event", async () => {
    freshDb({ challenges: [gatedChallenge()], dueTransitions: 1 });

    const response = await POST(request({ outcome: "completed" }), params());
    expect(response.status).toBe(200);

    // One transition event from the settle, one mutation event from the route,
    // and the transition precedes the mutation in the log (R19.9).
    expect(db.transitionEvents).toHaveLength(1);
    expect(db.mutationEvents).toHaveLength(1);
    expect(db.transitionEvents[0].seq).toBeLessThan(db.mutationEvents[0].seq);

    // The settle ran before loadBehaviorState (its SELECTs follow the settle).
    const settleIdx = db.sqlCalls.findIndex((s) =>
      s.includes("bbb_settle_card_effects"),
    );
    const loadIdx = db.sqlCalls.findIndex((s) => s.includes("from teams t"));
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeLessThan(loadIdx);
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    freshDb({ challenges: [gatedChallenge()], failMutationAppend: true });

    const response = await POST(request({ outcome: "completed" }), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    // The mutation event never committed.
    expect(db.mutationEvents).toHaveLength(0);
  });
});
