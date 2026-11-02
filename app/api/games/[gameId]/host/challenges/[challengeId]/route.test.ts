/**
 * Host challenge-override route tests (card-behavior Task 11.3).
 *
 * The route runs the real Card_Behavior_Mutation pipeline (`assertAdmin` lock,
 * `clock_timestamp()`, lazy settle, `loadBehaviorState`, the pure
 * `hostChallengeOverride`, the writes, and one `host_override_applied` event).
 * These tests drive it against the hermetic {@link HostTestDb} wrapper over the
 * shared fake {@link QueryRunner}, asserting:
 *
 *   - non-host → `not_authorized`, write-free (21.9);
 *   - clear of an `open` challenge → `cleared_by_host`, pending offer voided,
 *     gate lifted (21.1); clear of a non-open challenge → `conflict`;
 *   - reset of `completed` / `failed` → `open` (21.2); reset of `cleared_by_host`
 *     → `conflict`; UIOLI reset with an empty hand → `conflict`, write-free;
 *   - reset of a failed Everyone's a Critic cancels its claim block so the next
 *     claim is no longer critic-blocked (21.3);
 *   - exactly one mutation event, after the due-transition events (21.7, 19.9),
 *     and a rejection still commits only the transition events (19.10);
 *   - an append failure rolls back → `unavailable`.
 *
 * Hermetic: no live Postgres (24.2).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.7, 21.9, 19.9, 19.10, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";
import { loadBehaviorState } from "@/lib/cards/behaviorStore";

import type { ChallengeSeed } from "../../../cards/_mutationTestDb";
import {
  HostTestDb,
  IDS_HOST as IDS,
  NOW,
  claimBlocksFor,
  type HostDbOptions,
} from "../../_hostTestDb";

let host: HostTestDb;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(host.runner),
}));

import { POST } from "./route";

const CHALLENGE_ID = "chal-host-1";
const CRITIC_EFFECT_ID = "effect-critic-1";

function fresh(options: HostDbOptions = {}): HostTestDb {
  host = new HostTestDb(options);
  return host;
}

function challenge(overrides: Partial<ChallengeSeed> = {}): ChallengeSeed {
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

function request(body: unknown, sessionId: string | null = IDS.host): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(
    `http://test/api/games/${IDS.gameId}/host/challenges/${CHALLENGE_ID}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function params(challengeId = CHALLENGE_ID): {
  params: Promise<{ gameId: string; challengeId: string }>;
} {
  return { params: Promise.resolve({ gameId: IDS.gameId, challengeId }) };
}

/** No domain row and no mutation event was written. */
function expectWriteFree(): void {
  expect(host.db.challengeUpserts).toHaveLength(0);
  expect(host.db.offerUpserts).toHaveLength(0);
  expect(host.db.effectUpserts).toHaveLength(0);
  expect(host.db.effectUpdates).toHaveLength(0);
  expect(host.db.ledgerInserts).toHaveLength(0);
  expect(host.db.mutationEvents).toHaveLength(0);
}

beforeEach(() => {
  fresh();
});

describe("POST /host/challenges/[challengeId] — authorization", () => {
  it("rejects a non-host session with not_authorized and writes nothing", async () => {
    fresh({ admin: false, challenges: [challenge()] });

    const response = await POST(
      request({ action: "clear" }, "session-a"),
      params(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_authorized",
    });
    expectWriteFree();
    // Rejected before reading the clock or settling.
    expect(host.db.countSql("bbb_settle_card_effects")).toBe(0);
  });

  it("rejects a missing session with 401", async () => {
    const response = await POST(request({ action: "clear" }, null), params());
    expect(response.status).toBe(401);
    expectWriteFree();
  });

  it("rejects an unknown action with invalid_input", async () => {
    fresh({ challenges: [challenge()] });
    const response = await POST(request({ action: "delete" }), params());
    expect(response.status).toBe(400);
    expectWriteFree();
  });

  it("rejects an unknown challenge with not_found", async () => {
    fresh({ challenges: [challenge()] });
    const response = await POST(request({ action: "clear" }), params("nope"));
    expect(response.status).toBe(404);
    expectWriteFree();
  });
});

describe("POST /host/challenges/[challengeId] — clear", () => {
  it("clears an open challenge, voids its pending offer, and lifts the gate", async () => {
    fresh({
      instances: [
        { slug: "fairest-of-them-all", deckState: "hand", drawPosition: 0 },
      ],
      challenges: [challenge()],
      offers: [
        {
          id: "offer-1",
          sourcePlayId: "play-1",
          holderTeamId: IDS.teamA,
          originalCasterTeamId: IDS.teamB,
          challengeId: CHALLENGE_ID,
          status: "pending",
        },
      ],
    });

    // Gate is in force before the override.
    const before = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(
      claimBlocksFor(before, IDS.teamA, IDS.midBar).some(
        (b) => b.kind === "challenge",
      ),
    ).toBe(true);

    const response = await POST(request({ action: "clear" }), params());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { applied: boolean; seq: number };
    expect(body.applied).toBe(true);

    expect(host.db.challengeUpserts).toEqual([
      { id: CHALLENGE_ID, status: "cleared_by_host", failureEffectId: null },
    ]);
    expect(host.db.offerUpserts).toHaveLength(1);
    expect(host.db.offerUpserts[0]).toMatchObject({
      id: "offer-1",
      status: "void",
    });
    expect(host.db.effectUpserts).toHaveLength(0);

    expect(host.db.mutationEvents).toHaveLength(1);
    const event = host.db.mutationEvents[0];
    expect(event.eventType).toBe("host_override_applied");
    expect(body.seq).toBe(event.seq);
    expect(event.payload.action).toBe("clear");
    const embedded = event.payload.challenges as {
      challengeId: string;
      status: string;
      resolvedByKind: string;
    }[];
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toMatchObject({
      challengeId: CHALLENGE_ID,
      status: "cleared_by_host",
      resolvedByKind: "host",
    });
    expect((event.payload.offers as { status: string }[])[0].status).toBe(
      "void",
    );

    // With the embedded challenge folded in, the gate no longer blocks.
    const after = {
      ...before,
      challenges: before.challenges.map((c) =>
        c.challengeId === CHALLENGE_ID
          ? { ...c, status: "cleared_by_host" as const }
          : c,
      ),
    };
    expect(
      claimBlocksFor(after, IDS.teamA, IDS.midBar).some(
        (b) => b.kind === "challenge",
      ),
    ).toBe(false);
  });

  it.each(["completed", "failed", "cleared_by_host"])(
    "rejects clearing a %s challenge with conflict, write-free",
    async (status) => {
      fresh({ challenges: [challenge({ status })] });
      const response = await POST(request({ action: "clear" }), params());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        applied: false,
        error: "conflict",
      });
      expectWriteFree();
    },
  );
});

describe("POST /host/challenges/[challengeId] — reset", () => {
  it.each(["completed", "failed"])(
    "resets a %s challenge to open with one host_override_applied event",
    async (status) => {
      fresh({ challenges: [challenge({ status })] });

      const response = await POST(request({ action: "reset" }), params());

      expect(response.status).toBe(200);
      expect(host.db.challengeUpserts).toEqual([
        { id: CHALLENGE_ID, status: "open", failureEffectId: null },
      ]);
      expect(host.db.effectUpserts).toHaveLength(0);
      expect(host.db.mutationEvents).toHaveLength(1);
      const event = host.db.mutationEvents[0];
      expect(event.eventType).toBe("host_override_applied");
      expect(event.payload.action).toBe("reset");
      expect((event.payload.challenges as { status: string }[])[0].status).toBe(
        "open",
      );
      expect(event.payload.effects).toEqual([]);
    },
  );

  it("rejects resetting a cleared_by_host challenge with conflict", async () => {
    fresh({ challenges: [challenge({ status: "cleared_by_host" })] });
    const response = await POST(request({ action: "reset" }), params());
    expect(response.status).toBe(409);
    expectWriteFree();
  });

  it("rejects resetting an open challenge with conflict", async () => {
    fresh({ challenges: [challenge({ status: "open" })] });
    const response = await POST(request({ action: "reset" }), params());
    expect(response.status).toBe(409);
    expectWriteFree();
  });

  it("rejects a UIOLI reset with conflict when the target has an empty hand and no pending draw", async () => {
    // The fake attributes staged instances to team A (the target); none staged → empty hand.
    fresh({
      challenges: [
        challenge({ slug: "use-it-or-lose-it", status: "completed" }),
      ],
    });
    const response = await POST(request({ action: "reset" }), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    expectWriteFree();
  });

  it("allows a UIOLI reset when the target still holds a card", async () => {
    fresh({
      instances: [{ slug: "wired", deckState: "hand", drawPosition: 0 }],
      challenges: [
        challenge({ slug: "use-it-or-lose-it", status: "completed" }),
      ],
    });
    const response = await POST(request({ action: "reset" }), params());
    expect(response.status).toBe(200);
    expect(host.db.challengeUpserts).toEqual([
      { id: CHALLENGE_ID, status: "open", failureEffectId: null },
    ]);
    expect(host.db.mutationEvents).toHaveLength(1);
  });

  it("resetting a failed Everyone's a Critic cancels its claim block so the next claim is not critic-blocked", async () => {
    fresh({
      challenges: [challenge({ slug: "everyones-a-critic", status: "failed" })],
      failureEffectIds: { [CHALLENGE_ID]: CRITIC_EFFECT_ID },
      effects: [
        {
          id: CRITIC_EFFECT_ID,
          slug: "everyones-a-critic",
          kind: "team_claim_block",
          sourceChallengeId: CHALLENGE_ID,
          targetTeamId: IDS.teamA,
          startsAt: "2024-01-01T11:55:00.000Z",
          endsAt: "2024-01-01T12:10:00.000Z",
        },
      ],
    });

    const before = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(
      claimBlocksFor(before, IDS.teamA, IDS.midBar).some(
        (b) => b.kind === "critic_block",
      ),
    ).toBe(true);

    const response = await POST(request({ action: "reset" }), params());

    expect(response.status).toBe(200);
    expect(host.db.challengeUpserts).toEqual([
      { id: CHALLENGE_ID, status: "open", failureEffectId: null },
    ]);
    // The failure block was rewritten (cancelled in place).
    expect(host.db.effectUpserts.map((e) => e.id)).toEqual([CRITIC_EFFECT_ID]);

    expect(host.db.mutationEvents).toHaveLength(1);
    const effects = host.db.mutationEvents[0].payload.effects as {
      effectId: string;
      cancelledAt: string | null;
      cancelReason: string | null;
    }[];
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      effectId: CRITIC_EFFECT_ID,
      cancelledAt: NOW,
      cancelReason: "host",
    });

    // Reloaded state: the critic block no longer applies.
    const after = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(
      claimBlocksFor(after, IDS.teamA, IDS.midBar).some(
        (b) => b.kind === "critic_block",
      ),
    ).toBe(false);
  });
});

describe("POST /host/challenges/[challengeId] — settle ordering + rollback", () => {
  it("orders due transition events before exactly one mutation event", async () => {
    fresh({ challenges: [challenge()], dueTransitions: 2 });

    const response = await POST(request({ action: "clear" }), params());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seq: number };

    expect(host.db.transitionEvents).toHaveLength(2);
    expect(host.db.mutationEvents).toHaveLength(1);
    const mutation = host.db.mutationEvents[0];
    for (const t of host.db.transitionEvents) {
      expect(t.seq).toBeLessThan(mutation.seq);
    }
    // The response seq is the mutation event, never a transition event.
    expect(body.seq).toBe(mutation.seq);
  });

  it("commits only the transition events when the override is rejected", async () => {
    fresh({
      challenges: [challenge({ status: "completed" })],
      dueTransitions: 1,
    });

    const response = await POST(request({ action: "clear" }), params());
    expect(response.status).toBe(409);
    expect(host.db.transitionEvents).toHaveLength(1);
    expectWriteFree();
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    fresh({ challenges: [challenge()], failMutationAppend: true });

    const response = await POST(request({ action: "clear" }), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    expect(host.db.mutationEvents).toHaveLength(0);
  });
});
