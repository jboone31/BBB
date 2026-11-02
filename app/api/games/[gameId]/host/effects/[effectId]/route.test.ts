/**
 * Host effect early-end route tests (card-behavior Task 11.3).
 *
 * The route runs the real Card_Behavior_Mutation pipeline (`assertAdmin` lock,
 * `clock_timestamp()`, lazy settle, `loadBehaviorState`, the pure
 * `planHostEffectEnd`, the cancel / release / reconcile writes, and one
 * `host_override_applied` event). These tests drive it against the hermetic
 * {@link HostTestDb} wrapper over the shared fake {@link QueryRunner}, asserting:
 *
 *   - non-host → `not_authorized`, write-free (21.9);
 *   - every effect kind ends with `cancel_reason = 'host'` at server now,
 *     including a pending Cancel Culture (21.4);
 *   - Party Crasher and an attached Insurance append share corrections that
 *     restore the normal split (21.5), while Happy Hour / Patient Investor
 *     awards in the ledger are untouched (21.6);
 *   - ending a Pioneer / Scenic Route restriction means the team's next claim
 *     is no longer restriction-blocked (21.11);
 *   - already ended / consumed / cancelled → `already_resolved`; unknown →
 *     `not_found`;
 *   - exactly one mutation event, after the due-transition events (21.7, 19.9),
 *     a rejection still commits only the transition events (19.10), and an
 *     append failure rolls back → `unavailable`.
 *
 * Hermetic: no live Postgres (24.2).
 *
 * Requirements: 21.4, 21.5, 21.6, 21.7, 21.9, 21.11, 19.9, 19.10, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";
import { loadBehaviorState } from "@/lib/cards/behaviorStore";

import type { EffectSeed } from "../../../cards/_mutationTestDb";
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

const EFFECT_ID = "effect-host-1";

function fresh(options: HostDbOptions = {}): HostTestDb {
  host = new HostTestDb(options);
  return host;
}

function request(body: unknown, sessionId: string | null = IDS.host): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(
    `http://test/api/games/${IDS.gameId}/host/effects/${EFFECT_ID}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function params(effectId = EFFECT_ID): {
  params: Promise<{ gameId: string; effectId: string }>;
} {
  return { params: Promise.resolve({ gameId: IDS.gameId, effectId }) };
}

function seed(
  overrides: Partial<EffectSeed> & Pick<EffectSeed, "slug" | "kind">,
): EffectSeed {
  return {
    id: EFFECT_ID,
    sourcePlayId: "play-1",
    startsAt: "2024-01-01T11:50:00.000Z",
    ...overrides,
  };
}

function expectWriteFree(): void {
  expect(host.db.effectUpdates).toHaveLength(0);
  expect(host.db.effectUpserts).toHaveLength(0);
  expect(host.db.ledgerInserts).toHaveLength(0);
  expect(host.awardWrites).toHaveLength(0);
  expect(host.db.mutationEvents).toHaveLength(0);
}

type Embedded = {
  effectId: string;
  cancelledAt: string | null;
  cancelReason: string | null;
};

/** Assert the single host_override_applied event and return its payload. */
function singleMutation(): Record<string, unknown> {
  expect(host.db.mutationEvents).toHaveLength(1);
  const event = host.db.mutationEvents[0];
  expect(event.eventType).toBe("host_override_applied");
  expect(event.payload.action).toBe("end");
  expect(event.payload.effectId).toBe(EFFECT_ID);
  return event.payload;
}

beforeEach(() => {
  fresh();
});

describe("POST /host/effects/[effectId] — authorization + input", () => {
  it("rejects a non-host session with not_authorized and writes nothing", async () => {
    fresh({
      admin: false,
      effects: [
        seed({
          slug: "power-hour",
          kind: "draw_override",
          endsAt: "2024-01-01T12:15:00.000Z",
        }),
      ],
    });

    const response = await POST(
      request({ action: "end" }, "session-a"),
      params(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_authorized",
    });
    expectWriteFree();
    expect(host.db.countSql("bbb_settle_card_effects")).toBe(0);
  });

  it("rejects a body other than { action: 'end' } with invalid_input", async () => {
    const response = await POST(request({ action: "clear" }), params());
    expect(response.status).toBe(400);
    expectWriteFree();
  });

  it("rejects an unknown effect with not_found", async () => {
    const response = await POST(request({ action: "end" }), params("nope"));
    expect(response.status).toBe(404);
    expectWriteFree();
  });
});

describe("POST /host/effects/[effectId] — end each kind", () => {
  const cases: Array<[string, EffectSeed]> = [
    [
      "Crop Dusting bar lock",
      seed({
        slug: "crop-dusting",
        kind: "bar_lock",
        ownerTeamId: IDS.teamB,
        targetBarId: IDS.midBar,
        endsAt: "2024-01-01T12:05:00.000Z",
      }),
    ],
    [
      "active Cancel Culture radius lock",
      seed({
        slug: "cancel-culture",
        kind: "radius_lock",
        ownerTeamId: IDS.teamB,
        targetBarId: IDS.midBar,
        startsAt: "2024-01-01T11:55:00.000Z",
        endsAt: "2024-01-01T12:10:00.000Z",
      }),
    ],
    [
      "pending Cancel Culture radius lock",
      seed({
        slug: "cancel-culture",
        kind: "radius_lock",
        ownerTeamId: IDS.teamB,
        targetBarId: IDS.midBar,
        startsAt: "2024-01-01T12:05:00.000Z",
        endsAt: "2024-01-01T12:20:00.000Z",
        startAnnouncedAt: null,
      }),
    ],
    [
      "Everyone's a Critic block",
      seed({
        slug: "everyones-a-critic",
        kind: "team_claim_block",
        targetTeamId: IDS.teamA,
        endsAt: "2024-01-01T12:10:00.000Z",
      }),
    ],
    [
      "Happy Hour window",
      seed({
        slug: "happy-hour",
        kind: "bonus_window",
        ownerTeamId: IDS.teamB,
        targetBarId: IDS.midBar,
        endsAt: "2024-01-01T12:50:00.000Z",
      }),
    ],
    [
      "Power Hour draw override",
      seed({
        slug: "power-hour",
        kind: "draw_override",
        ownerTeamId: IDS.teamB,
        endsAt: "2024-01-01T12:10:00.000Z",
      }),
    ],
    [
      "Patient Investor counter",
      seed({
        slug: "patient-investor",
        kind: "claim_counter",
        ownerTeamId: IDS.teamA,
        params: { count: 1 },
      }),
    ],
    [
      "unattached Insurance",
      seed({
        slug: "insurance",
        kind: "score_protection",
        ownerTeamId: IDS.teamA,
      }),
    ],
    [
      "Pioneer restriction",
      seed({
        slug: "pioneer",
        kind: "next_claim_restriction",
        ownerTeamId: IDS.teamB,
        targetTeamId: IDS.teamA,
        params: { rule: "pioneer" },
      }),
    ],
    [
      "Scenic Route restriction",
      seed({
        slug: "scenic-route",
        kind: "next_claim_restriction",
        ownerTeamId: IDS.teamB,
        targetTeamId: IDS.teamA,
        params: { rule: "scenic" },
      }),
    ],
  ];

  it.each(cases)(
    "ends a %s with cancel_reason host and one event",
    async (_label, effect) => {
      fresh({ effects: [effect] });

      const response = await POST(request({ action: "end" }), params());

      expect(response.status).toBe(200);
      const body = (await response.json()) as { applied: boolean; seq: number };
      expect(body.applied).toBe(true);

      expect(host.db.effectUpdates).toEqual([
        { id: EFFECT_ID, cancelReason: "host" },
      ]);
      // No share-rule change for these kinds: nothing to reconcile.
      expect(host.db.ledgerInserts).toHaveLength(0);
      expect(host.awardWrites).toHaveLength(0);

      const payload = singleMutation();
      expect(body.seq).toBe(host.db.mutationEvents[0].seq);
      const effects = payload.effects as Embedded[];
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        effectId: EFFECT_ID,
        cancelledAt: NOW,
        cancelReason: "host",
      });
      expect(payload.scoreEntries).toEqual([]);
    },
  );
});

describe("POST /host/effects/[effectId] — Pioneer / Scenic restriction lifted", () => {
  it("after ending Pioneer, the team's next claim is no longer restriction-blocked", async () => {
    fresh({
      // Team B already holds the mid bar, so Pioneer blocks team A there.
      claims: [{ id: "claim-b", teamId: IDS.teamB, barId: IDS.midBar }],
      effects: [
        seed({
          slug: "pioneer",
          kind: "next_claim_restriction",
          ownerTeamId: IDS.teamB,
          targetTeamId: IDS.teamA,
          params: { rule: "pioneer" },
        }),
      ],
    });

    const before = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(claimBlocksFor(before, IDS.teamA, IDS.midBar)).toEqual([
      expect.objectContaining({ kind: "pioneer", reason: "claimed_by_other" }),
    ]);
    expect(claimBlocksFor(before, IDS.teamA, IDS.finishBar)).toEqual([
      expect.objectContaining({ kind: "pioneer", reason: "finish_bar" }),
    ]);

    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(200);
    singleMutation();

    const after = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(claimBlocksFor(after, IDS.teamA, IDS.midBar)).toEqual([]);
    expect(claimBlocksFor(after, IDS.teamA, IDS.finishBar)).toEqual([]);
  });

  it("after ending Scenic Route, the team's next claim is no longer restriction-blocked", async () => {
    fresh({
      effects: [
        seed({
          slug: "scenic-route",
          kind: "next_claim_restriction",
          ownerTeamId: IDS.teamB,
          targetTeamId: IDS.teamA,
          params: { rule: "scenic" },
        }),
      ],
    });

    // Team A's previous bar is the start bar; the mid bar is closer to the finish.
    const before = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(claimBlocksFor(before, IDS.teamA, IDS.midBar)).toEqual([
      expect.objectContaining({ kind: "scenic", reason: "not_farther" }),
    ]);

    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(200);
    singleMutation();

    const after = await loadBehaviorState(host.runner, IDS.gameId, NOW);
    expect(claimBlocksFor(after, IDS.teamA, IDS.midBar)).toEqual([]);
  });
});

describe("POST /host/effects/[effectId] — share corrections + awards unchanged", () => {
  /** A Happy Hour award for team A on the mid bar, already in the ledger. */
  const awardFixture: Pick<HostDbOptions, "awards"> = {
    awards: [
      {
        id: "award-1",
        effectId: "effect-hh",
        teamId: IDS.teamA,
        kind: "happy_hour_bonus",
        claimId: "claim-a",
        ledgerEntryId: "ledger-hh",
      },
    ],
  };
  const awardLedger = {
    id: "ledger-hh",
    teamId: IDS.teamA,
    barId: IDS.midBar,
    category: "happy_hour_bonus",
    points: 5,
    sourceClaimId: "claim-a",
    sourceEffectId: "effect-hh",
  };
  const twoClaims = [
    { id: "claim-a", teamId: IDS.teamA, barId: IDS.midBar },
    { id: "claim-b", teamId: IDS.teamB, barId: IDS.midBar },
  ];

  it("ending Party Crasher restores the normal split and leaves awards untouched", async () => {
    fresh({
      claims: twoClaims,
      // Two claimants + phantom → 4 each.
      ledger: [
        {
          id: "l-a",
          teamId: IDS.teamA,
          barId: IDS.midBar,
          category: "bar_share",
          points: 4,
          sourceClaimId: "claim-a",
        },
        {
          id: "l-b",
          teamId: IDS.teamB,
          barId: IDS.midBar,
          category: "bar_share",
          points: 4,
          sourceClaimId: "claim-b",
        },
        awardLedger,
      ],
      ...awardFixture,
      effects: [
        seed({
          slug: "party-crasher",
          kind: "phantom_share",
          ownerTeamId: IDS.teamB,
          targetBarId: IDS.midBar,
        }),
      ],
    });

    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(200);

    expect(host.db.effectUpdates).toEqual([
      { id: EFFECT_ID, cancelReason: "host" },
    ]);
    // Normal two-team split is 6 each: +2 correction per team.
    expect(host.db.ledgerInserts).toEqual([
      {
        teamId: IDS.teamA,
        barId: IDS.midBar,
        category: "bar_share_correction",
        points: 2,
      },
      {
        teamId: IDS.teamB,
        barId: IDS.midBar,
        category: "bar_share_correction",
        points: 2,
      },
    ]);
    // The Happy Hour award is untouched.
    expect(host.awardWrites).toHaveLength(0);
    expect(
      host.db.ledgerInserts.some(
        (l) =>
          l.category.startsWith("happy_hour") ||
          l.category === "patient_investor_award",
      ),
    ).toBe(false);

    const payload = singleMutation();
    expect((payload.scoreEntries as unknown[]).length).toBe(2);
  });

  it("ending an attached Insurance releases the floor and corrects the share", async () => {
    fresh({
      claims: twoClaims,
      // Base 6 each, team A protected at 12.
      ledger: [
        {
          id: "l-a",
          teamId: IDS.teamA,
          barId: IDS.midBar,
          category: "bar_share",
          points: 12,
          sourceClaimId: "claim-a",
        },
        {
          id: "l-b",
          teamId: IDS.teamB,
          barId: IDS.midBar,
          category: "bar_share",
          points: 6,
          sourceClaimId: "claim-b",
        },
        awardLedger,
      ],
      ...awardFixture,
      effects: [
        seed({
          slug: "insurance",
          kind: "score_protection",
          ownerTeamId: IDS.teamA,
          attachedClaimId: "claim-a",
          attachedBarId: IDS.midBar,
          protectedPoints: 12,
        }),
      ],
    });

    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(200);

    // The protection itself is the ended effect: cancelled once, as host.
    expect(host.db.effectUpdates).toEqual([
      { id: EFFECT_ID, cancelReason: "host" },
    ]);
    expect(host.db.ledgerInserts).toEqual([
      {
        teamId: IDS.teamA,
        barId: IDS.midBar,
        category: "bar_share_correction",
        points: -6,
      },
    ]);
    expect(host.awardWrites).toHaveLength(0);

    const payload = singleMutation();
    expect((payload.effects as Embedded[]).map((e) => e.effectId)).toEqual([
      EFFECT_ID,
    ]);
    expect((payload.scoreEntries as unknown[]).length).toBe(1);
  });

  it.each([
    [
      "Happy Hour",
      seed({
        slug: "happy-hour",
        kind: "bonus_window",
        ownerTeamId: IDS.teamB,
        targetBarId: IDS.midBar,
        endsAt: "2024-01-01T12:50:00.000Z",
      }),
    ],
    [
      "Patient Investor",
      seed({
        slug: "patient-investor",
        kind: "claim_counter",
        ownerTeamId: IDS.teamA,
        params: { count: 4 },
      }),
    ],
  ])(
    "ending %s leaves its awards in the ledger unchanged",
    async (_label, effect) => {
      fresh({
        claims: [{ id: "claim-a", teamId: IDS.teamA, barId: IDS.midBar }],
        ledger: [
          {
            id: "l-a",
            teamId: IDS.teamA,
            barId: IDS.midBar,
            category: "bar_share",
            points: 12,
            sourceClaimId: "claim-a",
          },
          awardLedger,
          {
            id: "ledger-pi",
            teamId: IDS.teamA,
            barId: null,
            category: "patient_investor_award",
            points: 6,
          },
        ],
        awards: [
          ...(awardFixture.awards ?? []),
          {
            id: "award-2",
            effectId: EFFECT_ID,
            teamId: IDS.teamA,
            kind: "patient_investor_award",
            claimId: "claim-a",
            ledgerEntryId: "ledger-pi",
          },
        ],
        effects: [effect],
      });

      const response = await POST(request({ action: "end" }), params());
      expect(response.status).toBe(200);
      expect(host.db.ledgerInserts).toHaveLength(0);
      expect(host.awardWrites).toHaveLength(0);
      expect(singleMutation().scoreEntries).toEqual([]);
    },
  );
});

describe("POST /host/effects/[effectId] — already resolved", () => {
  it.each([
    ["naturally ended", { endsAt: "2024-01-01T11:59:00.000Z" }],
    ["consumed", { consumedAt: "2024-01-01T11:58:00.000Z" }],
    [
      "cancelled",
      { cancelledAt: "2024-01-01T11:58:00.000Z", cancelReason: "host" },
    ],
  ] as const)(
    "rejects a %s effect with already_resolved, write-free",
    async (_label, extra) => {
      fresh({
        effects: [
          seed({
            slug: "crop-dusting",
            kind: "bar_lock",
            targetBarId: IDS.midBar,
            endsAt: "2024-01-01T12:10:00.000Z",
            ...extra,
          }),
        ],
      });
      const response = await POST(request({ action: "end" }), params());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        applied: false,
        error: "already_resolved",
      });
      expectWriteFree();
    },
  );
});

describe("POST /host/effects/[effectId] — settle ordering + rollback", () => {
  const live = seed({
    slug: "power-hour",
    kind: "draw_override",
    endsAt: "2024-01-01T12:15:00.000Z",
  });

  it("orders due transition events before exactly one mutation event", async () => {
    fresh({ effects: [live], dueTransitions: 2 });

    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seq: number };

    expect(host.db.transitionEvents).toHaveLength(2);
    singleMutation();
    const mutation = host.db.mutationEvents[0];
    for (const t of host.db.transitionEvents) {
      expect(t.seq).toBeLessThan(mutation.seq);
    }
    expect(body.seq).toBe(mutation.seq);
  });

  it("commits only the transition events when the end is rejected", async () => {
    fresh({
      effects: [{ ...live, consumedAt: "2024-01-01T11:58:00.000Z" }],
      dueTransitions: 1,
    });
    const response = await POST(request({ action: "end" }), params());
    expect(response.status).toBe(409);
    expect(host.db.transitionEvents).toHaveLength(1);
    expectWriteFree();
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    fresh({ effects: [live], failMutationAppend: true });

    const response = await POST(request({ action: "end" }), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    expect(host.db.mutationEvents).toHaveLength(0);
  });
});
