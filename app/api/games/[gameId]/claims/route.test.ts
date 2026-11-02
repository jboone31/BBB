/**
 * Route tests for `POST /api/games/{gameId}/claims` (card-behavior Task 7.7).
 *
 * These run the real reworked route — pipeline (authorize + lock, server `now`,
 * lazy settle, `loadBehaviorState`, `resolveGameBar`), block evaluation, the
 * claim / unclaim / Bonus_Claim planners, ledger reconciliation, and the event
 * append — against the hermetic {@link FakeClaimsDb} (no network, `npm test`).
 *
 * The only module mocked besides the transaction boundary is the deck
 * persistence helper (`applyDeckTransition`): the deck engine has its own
 * hermetic + live coverage, so here it is replaced by a stand-in that writes a
 * `card_draws` row and a `cards_drawn` event through the SAME transaction runner,
 * letting these tests assert the draw commits/rolls back with the claim.
 *
 * Requirements: 19.3, 19.4, 19.5, 19.6, 19.9, 19.10, 20.3c, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

import {
  BARS,
  FakeClaimsDb,
  NOW_ISO,
  TEAM_A,
  TEAM_B,
  type FakeClaimsDbOptions,
} from "./_claimsTestDb";

let db: FakeClaimsDb = new FakeClaimsDb();

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(
    fn: (tx: QueryRunner) => Promise<T>,
  ): Promise<T> => {
    db.begin();
    try {
      const result = await fn(db.runner);
      db.commit();
      return result;
    } catch (err) {
      db.rollback();
      throw err;
    }
  },
}));

let drawRejects = false;
const drawCalls: Array<{ tx: QueryRunner; teamId: string; barId?: string }> =
  [];

vi.mock("@/lib/cards/persistence", () => ({
  applyDeckTransition: vi.fn(
    async (
      tx: QueryRunner,
      args: { ctx: { gameId: string; teamId: string }; barId?: string },
    ) => {
      drawCalls.push({ tx, teamId: args.ctx.teamId, barId: args.barId });
      if (drawRejects) {
        return { ok: false, reason: "duplicate_bar_draw", state: {} };
      }
      await tx.query(
        "insert into card_draws (game_id, team_id, bar_id) values ($1, $2, $3)",
        [args.ctx.gameId, args.ctx.teamId, args.barId],
      );
      const { appendEvent } = await import("@/lib/events");
      const event = await appendEvent(tx, {
        gameId: args.ctx.gameId,
        type: "cards_drawn",
        actor: { kind: "team", teamId: args.ctx.teamId },
        payload: { barId: args.barId },
      });
      return { ok: true, seq: event.seq, state: {} };
    },
  ),
}));

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function setup(options: FakeClaimsDbOptions = {}): FakeClaimsDb {
  db = new FakeClaimsDb(options);
  return db;
}

function request(body: unknown, sessionId = "session-a"): Request {
  return new Request("http://test/api/games/game-1/claims", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bbb-session-id": sessionId,
    },
    body: JSON.stringify(body),
  });
}

const params = () => ({ params: Promise.resolve({ gameId: "game-1" }) });

function claim(barId: string, finishedDrinkCount = 1) {
  return POST(
    request({
      action: "claim",
      barId,
      allMembersPresent: true,
      finishedDrinkCount,
    }),
    params(),
  );
}

const unclaim = (barId: string) =>
  POST(request({ action: "unclaim", barId }), params());

const bonus = (barId: string) =>
  POST(request({ action: "bonus", barId }), params());

/** Minutes relative to the fixed server `now`, as ISO. */
function at(minutes: number): string {
  return new Date(Date.parse(NOW_ISO) + minutes * 60_000).toISOString();
}

/** Committed domain rows (every table write the route performed). */
function domainWrites(fake: FakeClaimsDb) {
  return fake.committedWrites;
}

/** An active Happy Hour window on bar A. */
const happyHourOnA = {
  id: "eff-hh",
  slug: "happy-hour",
  kind: "bonus_window",
  ownerTeamId: TEAM_B,
  targetBarKey: BARS.a.id,
  startsAt: at(-30),
  endsAt: at(30),
} as const;

/** Team A's active claim on bar A (for unclaim / Bonus_Claim fixtures). */
const teamAClaimOnA = {
  id: "claim-a1",
  teamId: TEAM_A,
  barId: BARS.a.id,
  claimedAt: at(-20),
} as const;

beforeEach(() => {
  drawRejects = false;
  drawCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Baseline claim behavior.
// ---------------------------------------------------------------------------

describe("POST /claims — claim basics", () => {
  it("accepts an eligible claim: claim, share entry, and draw commit together", async () => {
    const fake = setup();
    const response = await claim(BARS.a.id);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_recorded",
      "score_awarded",
      "cards_drawn",
    ]);
    // The response seq is the last mutation event (the draw).
    expect(body).toEqual({
      applied: true,
      seq: fake.mutationEvents.at(-1)!.seq,
      result: { claimId: expect.any(String) },
    });
    expect(fake.writesTo("score_ledger_entries")[0].detail).toMatchObject({
      teamId: TEAM_A,
      category: "bar_share",
      points: 12,
    });
    expect(drawCalls).toEqual([
      { tx: fake.runner, teamId: TEAM_A, barId: BARS.a.id },
    ]);
  });

  it("rejects a team below the half-team threshold and writes nothing", async () => {
    const fake = setup({ memberCount: 3 });
    const response = await claim(BARS.a.id, 1);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "claim_ineligible",
    });
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
  });

  it("rejects a duplicate claim by the same team", async () => {
    const fake = setup({ claims: [teamAClaimOnA] });
    const response = await claim(BARS.a.id);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "claim_duplicate",
    });
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
  });

  it("records a start-bar claim with no points but still draws", async () => {
    const fake = setup();
    const response = await claim(BARS.start.id);
    expect(response.status).toBe(200);
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_recorded",
      "cards_drawn",
    ]);
    expect(fake.writesTo("score_ledger_entries")).toEqual([]);
  });

  it("materializes a candidate bar on first touch before claiming it", async () => {
    const fake = setup();
    const response = await claim("park-tavern");
    expect(response.status).toBe(200);
    expect(fake.writesTo("bars")).toHaveLength(1);
    expect(fake.mutationEvents[0].payload.barId).toBe("park-tavern");
  });

  it("awards the finish bar, ends the game and its effects, and does not draw", async () => {
    const fake = setup();
    const response = await claim(BARS.finish.id);

    expect(response.status).toBe(200);
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_recorded",
      "score_awarded",
      "game_ended",
    ]);
    await expect(response.json()).resolves.toMatchObject({
      seq: fake.mutationEvents.at(-1)!.seq,
    });
    expect(fake.writesTo("games")).toHaveLength(1);
    expect(fake.writesTo("card_effects").map((w) => w.op)).toContain(
      "end_game",
    );
    expect(drawCalls).toHaveLength(0);
  });

  it("still commits the claim when the draw is rejected; seq falls back to the score event", async () => {
    drawRejects = true;
    const fake = setup();
    const response = await claim(BARS.a.id);

    expect(response.status).toBe(200);
    expect(drawCalls).toHaveLength(1);
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_recorded",
      "score_awarded",
    ]);
    await expect(response.json()).resolves.toMatchObject({
      seq: fake.mutationEvents.at(-1)!.seq,
    });
  });
});

// ---------------------------------------------------------------------------
// Blocks (19.3, 20.3c).
// ---------------------------------------------------------------------------

describe("POST /claims — blocked details (19.3)", () => {
  it("lists every blocking card, in order, with end times for timed blocks", async () => {
    const fake = setup({
      // Bar A is held by team B, so Pioneer's "unclaimed bar" rule fails too.
      claims: [{ id: "claim-b1", teamId: TEAM_B, barId: BARS.a.id }],
      challenges: [
        {
          id: "ch-1",
          slug: "wired",
          casterTeamId: TEAM_B,
          targetTeamId: TEAM_A,
          status: "open",
        },
        // A resolved challenge never blocks.
        {
          id: "ch-2",
          slug: "dirty-bird",
          casterTeamId: TEAM_B,
          targetTeamId: TEAM_A,
          status: "completed",
        },
      ],
      effects: [
        {
          id: "eff-critic",
          slug: "everyones-a-critic",
          kind: "team_claim_block",
          targetTeamId: TEAM_A,
          startsAt: at(-5),
          endsAt: at(10),
        },
        {
          id: "eff-crop",
          slug: "crop-dusting",
          kind: "bar_lock",
          ownerTeamId: TEAM_B,
          targetBarKey: BARS.a.id,
          startsAt: at(-3),
          endsAt: at(12),
        },
        {
          id: "eff-cancel",
          slug: "cancel-culture",
          kind: "radius_lock",
          ownerTeamId: TEAM_B,
          targetBarKey: BARS.c.id,
          startsAt: at(-1),
          endsAt: at(14),
        },
        {
          id: "eff-pioneer",
          slug: "pioneer",
          kind: "next_claim_restriction",
          targetTeamId: TEAM_A,
          params: { rule: "pioneer" },
        },
        {
          // Previous bar is the start bar; bar A is closer to the finish.
          id: "eff-scenic",
          slug: "scenic-route",
          kind: "next_claim_restriction",
          targetTeamId: TEAM_A,
          params: { rule: "scenic" },
        },
      ],
    });

    const response = await claim(BARS.a.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "blocked",
      details: {
        blocks: [
          { kind: "challenge", slug: "wired", challengeId: "ch-1" },
          {
            kind: "critic_block",
            slug: "everyones-a-critic",
            effectId: "eff-critic",
            endsAt: at(10),
          },
          {
            kind: "bar_lock",
            slug: "crop-dusting",
            effectId: "eff-crop",
            endsAt: at(12),
          },
          {
            kind: "radius_lock",
            slug: "cancel-culture",
            effectId: "eff-cancel",
            endsAt: at(14),
          },
          {
            kind: "pioneer",
            slug: "pioneer",
            effectId: "eff-pioneer",
            reason: "claimed_by_other",
          },
          {
            kind: "scenic",
            slug: "scenic-route",
            effectId: "eff-scenic",
            reason: "not_farther",
          },
        ],
      },
    });
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
    expect(drawCalls).toHaveLength(0);
  });

  it("enforces a timed block at server time before any activation event exists (20.3c)", async () => {
    // The Crop Dusting lock started 2 minutes ago but its activation has never
    // been announced and the settle appends nothing: the block still holds.
    const fake = setup({
      dueTransitions: 0,
      effects: [
        {
          id: "eff-crop",
          slug: "crop-dusting",
          kind: "bar_lock",
          ownerTeamId: TEAM_B,
          targetBarKey: BARS.a.id,
          startsAt: at(-2),
          endsAt: at(13),
          startAnnouncedAt: null,
        },
      ],
    });

    const response = await claim(BARS.a.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "blocked",
      details: {
        blocks: [{ kind: "bar_lock", effectId: "eff-crop", endsAt: at(13) }],
      },
    });
    expect(fake.committedEvents).toEqual([]);
    expect(domainWrites(fake)).toEqual([]);
  });

  it("stops enforcing a timed block once its end passes at server time, with no expiry event yet (20.3c)", async () => {
    const fake = setup({
      dueTransitions: 0,
      effects: [
        {
          id: "eff-crop",
          slug: "crop-dusting",
          kind: "bar_lock",
          ownerTeamId: TEAM_B,
          targetBarKey: BARS.a.id,
          startsAt: at(-20),
          endsAt: at(-5),
          startAnnouncedAt: at(-20),
          endAnnouncedAt: null,
        },
      ],
    });

    const response = await claim(BARS.a.id);

    expect(response.status).toBe(200);
    expect(fake.transitionEvents).toEqual([]);
    expect(fake.writesTo("claims")).toHaveLength(1);
  });

  it("exempts the Crop Dusting owner from its own lock", async () => {
    const fake = setup({
      effects: [
        {
          id: "eff-crop",
          slug: "crop-dusting",
          kind: "bar_lock",
          ownerTeamId: TEAM_A,
          targetBarKey: BARS.a.id,
          startsAt: at(-2),
          endsAt: at(13),
        },
      ],
    });
    const response = await claim(BARS.a.id);
    expect(response.status).toBe(200);
    expect(fake.writesTo("claims")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Side effects in one transaction (19.4).
// ---------------------------------------------------------------------------

describe("POST /claims — side-effect writes in one transaction (19.4)", () => {
  it("commits the claim, restriction consumption, Insurance attach, Happy Hour +5, Patient Investor payout, shares, and draw atomically", async () => {
    const fake = setup({
      effects: [
        {
          id: "eff-pioneer",
          slug: "pioneer",
          kind: "next_claim_restriction",
          targetTeamId: TEAM_A,
          params: { rule: "pioneer" },
        },
        {
          id: "eff-ins",
          slug: "insurance",
          kind: "score_protection",
          ownerTeamId: TEAM_A,
        },
        happyHourOnA,
        {
          id: "eff-pi",
          slug: "patient-investor",
          kind: "claim_counter",
          ownerTeamId: TEAM_A,
          params: {
            counted: [
              { claimId: "c1", barKey: "bar-x1" },
              { claimId: "c2", barKey: "bar-x2" },
              { claimId: "c3", barKey: "bar-x3" },
            ],
          },
        },
        {
          id: "eff-power",
          slug: "power-hour",
          kind: "draw_override",
          ownerTeamId: TEAM_B,
          startsAt: at(-5),
          endsAt: at(15),
        },
      ],
    });

    const response = await claim(BARS.a.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    const claimId = body.result.claimId as string;

    // One transaction, committed once, nothing rolled back.
    expect(fake.transactions).toBe(1);
    expect(fake.committed).toBe(true);
    expect(fake.rolledBack).toBe(false);

    const effectOps = fake.writesTo("card_effects");
    expect(effectOps).toEqual([
      {
        table: "card_effects",
        op: "consume",
        detail: { ids: ["eff-pioneer"], claimId },
      },
      {
        table: "card_effects",
        op: "attach",
        detail: { id: "eff-ins", claimId, protectedPoints: 12 },
      },
      {
        table: "card_effects",
        op: "counter",
        detail: {
          id: "eff-pi",
          params: {
            counted: [
              { claimId: "c1", barKey: "bar-x1" },
              { claimId: "c2", barKey: "bar-x2" },
              { claimId: "c3", barKey: "bar-x3" },
              { claimId, barKey: BARS.a.id },
            ],
          },
          payout: true,
        },
      },
    ]);

    const ledger = fake.writesTo("score_ledger_entries").map((w) => w.detail);
    expect(ledger.map((l) => [l.category, l.points, l.sourceEffectId])).toEqual(
      expect.arrayContaining([
        ["happy_hour_bonus", 5, "eff-hh"],
        ["patient_investor_award", 6, "eff-pi"],
        ["bar_share", 12, null],
      ]),
    );
    expect(ledger).toHaveLength(3);
    expect(
      fake.writesTo("card_effect_awards").map((w) => w.detail.kind),
    ).toEqual(["happy_hour_bonus", "patient_investor_award"]);
    expect(fake.writesTo("card_draws")).toHaveLength(1);
    expect(drawCalls[0].tx).toBe(fake.runner);

    // claim_recorded embeds the changed effects and awards.
    const recorded = fake.mutationEvents[0];
    expect(recorded.eventType).toBe("claim_recorded");
    expect(
      (recorded.payload.effects as Array<{ effectId: string }>).map(
        (e) => e.effectId,
      ),
    ).toEqual(["eff-pioneer", "eff-ins", "eff-pi"]);
    expect(
      (recorded.payload.awards as Array<{ kind: string }>).map((a) => a.kind),
    ).toEqual(["happy_hour_bonus", "patient_investor_award"]);
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_recorded",
      "score_awarded",
      "score_awarded",
      "score_awarded",
      "cards_drawn",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unclaim reversals.
// ---------------------------------------------------------------------------

describe("POST /claims — unclaim reversals", () => {
  it("revokes the claim, corrects shares, reverses Happy Hour, uncounts Patient Investor, and releases Insurance", async () => {
    const fake = setup({
      claims: [teamAClaimOnA],
      ledger: [
        {
          id: "led-share",
          teamId: TEAM_A,
          barId: BARS.a.id,
          category: "bar_share",
          points: 12,
        },
        {
          id: "led-hh",
          teamId: TEAM_A,
          barId: BARS.a.id,
          category: "happy_hour_bonus",
          points: 5,
        },
      ],
      awards: [
        {
          id: "award-hh",
          effectId: "eff-hh",
          teamId: TEAM_A,
          kind: "happy_hour_bonus",
          claimId: "claim-a1",
          ledgerEntryId: "led-hh",
        },
      ],
      effects: [
        happyHourOnA,
        {
          id: "eff-pi",
          slug: "patient-investor",
          kind: "claim_counter",
          ownerTeamId: TEAM_A,
          params: {
            counted: [
              { claimId: "c0", barKey: "bar-x0" },
              { claimId: "claim-a1", barKey: BARS.a.id },
            ],
          },
        },
        {
          id: "eff-ins",
          slug: "insurance",
          kind: "score_protection",
          ownerTeamId: TEAM_A,
          attachedClaimId: "claim-a1",
          protectedPoints: 12,
        },
      ],
    });

    const response = await unclaim(BARS.a.id);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      applied: true,
      seq: fake.mutationEvents.at(-1)!.seq,
      result: { claimId: "claim-a1" },
    });

    expect(fake.writesTo("claims")).toEqual([
      { table: "claims", op: "revoke", detail: { id: "claim-a1" } },
    ]);
    const ledger = fake.writesTo("score_ledger_entries").map((w) => w.detail);
    // Side-effect reversals are written first, then the share reconciliation.
    expect(ledger.map((l) => [l.category, l.points])).toEqual([
      ["happy_hour_bonus_reversal", -5],
      ["bar_share_correction", -12],
    ]);
    expect(fake.writesTo("card_effect_awards")).toEqual([
      {
        table: "card_effect_awards",
        op: "reverse",
        detail: { id: "award-hh", reversalLedgerEntryId: ledger[0].id },
      },
    ]);
    expect(fake.writesTo("card_effects")).toEqual([
      {
        table: "card_effects",
        op: "counter",
        detail: {
          id: "eff-pi",
          params: { counted: [{ claimId: "c0", barKey: "bar-x0" }] },
          payout: false,
        },
      },
      { table: "card_effects", op: "release", detail: { id: "eff-ins" } },
    ]);

    const removed = fake.mutationEvents[0];
    expect(removed.eventType).toBe("claim_removed");
    expect(removed.payload).toMatchObject({
      claimId: "claim-a1",
      reason: "ordinary_unclaim",
      awards: [{ awardId: "award-hh", reversedAt: NOW_ISO }],
    });
    expect(fake.mutationEvents.map((e) => e.eventType)).toEqual([
      "claim_removed",
      "score_modifier_applied",
      "score_awarded",
    ]);
    expect(drawCalls).toHaveLength(0);
  });

  it("rejects unclaiming another team's claim and writes nothing", async () => {
    const fake = setup({
      claims: [{ id: "claim-b1", teamId: TEAM_B, barId: BARS.a.id }],
    });
    const response = await unclaim(BARS.a.id);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "claim_not_active",
    });
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bonus_Claim (19.6, 19.10).
// ---------------------------------------------------------------------------

describe("POST /claims — Happy Hour Bonus_Claim", () => {
  it("appends exactly one mutation event after the due transition events; no claim, no draw", async () => {
    const fake = setup({
      dueTransitions: 2,
      claims: [teamAClaimOnA],
      effects: [happyHourOnA],
    });

    const response = await bonus(BARS.a.id);
    expect(response.status).toBe(200);
    const body = await response.json();

    // Transition events precede the single mutation event; the response seq
    // names the mutation event, never a transition event.
    expect(fake.transitionEvents).toHaveLength(2);
    expect(fake.mutationEvents).toHaveLength(1);
    const [mutation] = fake.mutationEvents;
    expect(mutation.eventType).toBe("happy_hour_bonus_claimed");
    expect(fake.transitionEvents.every((t) => t.seq < mutation.seq)).toBe(true);
    expect(body.seq).toBe(mutation.seq);

    // +5 ledger entry with no source claim, and an award with claim_id null.
    const ledger = fake.writesTo("score_ledger_entries").map((w) => w.detail);
    expect(ledger).toEqual([
      expect.objectContaining({
        teamId: TEAM_A,
        category: "happy_hour_bonus",
        points: 5,
        sourceClaimId: null,
        sourceEffectId: "eff-hh",
      }),
    ]);
    expect(fake.writesTo("card_effect_awards")).toEqual([
      expect.objectContaining({
        op: "insert",
        detail: expect.objectContaining({ effectId: "eff-hh", claimId: null }),
      }),
    ]);
    expect(mutation.payload).toMatchObject({
      barKey: BARS.a.id,
      teamId: TEAM_A,
      effectId: "eff-hh",
      awards: [{ claimId: null, kind: "happy_hour_bonus" }],
      scoreEntries: [{ points: 5, category: "happy_hour_bonus" }],
    });

    expect(fake.writesTo("claims")).toEqual([]);
    expect(fake.writesTo("card_effects")).toEqual([]);
    expect(drawCalls).toHaveLength(0);
  });

  const rejections: Array<{
    name: string;
    error: string;
    status: number;
    options: FakeClaimsDbOptions;
  }> = [
    {
      name: "the team has no active claim on the bar",
      error: "conflict",
      status: 409,
      options: { effects: [happyHourOnA] },
    },
    {
      name: "no Happy Hour window targets the bar",
      error: "not_found",
      status: 404,
      options: { claims: [teamAClaimOnA] },
    },
    {
      name: "the window ended at server time (no expiry event yet)",
      error: "expired",
      status: 409,
      options: {
        claims: [teamAClaimOnA],
        effects: [{ ...happyHourOnA, startsAt: at(-90), endsAt: at(-30) }],
      },
    },
    {
      name: "the team already holds this window's bonus",
      error: "already_resolved",
      status: 409,
      options: {
        claims: [teamAClaimOnA],
        effects: [happyHourOnA],
        awards: [
          {
            id: "award-hh",
            effectId: "eff-hh",
            teamId: TEAM_A,
            kind: "happy_hour_bonus",
            claimId: "claim-a1",
            ledgerEntryId: "led-hh",
          },
        ],
      },
    },
    {
      name: "a claim block applies (open challenge)",
      error: "blocked",
      status: 409,
      options: {
        claims: [teamAClaimOnA],
        effects: [happyHourOnA],
        challenges: [
          {
            id: "ch-1",
            slug: "wired",
            casterTeamId: TEAM_B,
            targetTeamId: TEAM_A,
            status: "open",
          },
        ],
      },
    },
  ];

  for (const { name, error, status, options } of rejections) {
    it(`rejects with ${error} when ${name}, committing only transition events`, async () => {
      const fake = setup({ ...options, dueTransitions: 1 });
      const response = await bonus(BARS.a.id);

      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ applied: false, error });
      if (error === "blocked") {
        expect(body.details.blocks).toEqual([
          { kind: "challenge", slug: "wired", challengeId: "ch-1" },
        ]);
      }
      // 19.10: no domain rows or mutation events; the settle's transition
      // event still commits.
      expect(domainWrites(fake)).toEqual([]);
      expect(fake.mutationEvents).toEqual([]);
      expect(fake.transitionEvents).toHaveLength(1);
    });
  }

  it("does not apply next-claim restrictions to a Bonus_Claim (10.7)", async () => {
    const fake = setup({
      claims: [teamAClaimOnA],
      effects: [
        happyHourOnA,
        {
          id: "eff-pioneer",
          slug: "pioneer",
          kind: "next_claim_restriction",
          targetTeamId: TEAM_A,
          params: { rule: "pioneer" },
        },
      ],
    });
    const response = await bonus(BARS.a.id);
    expect(response.status).toBe(200);
    // The restriction is not consumed by a Bonus_Claim.
    expect(fake.writesTo("card_effects")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rejections write nothing; transition events excluded (19.10).
// ---------------------------------------------------------------------------

describe("POST /claims — rejections commit no domain rows or mutation events (19.10)", () => {
  it("a blocked claim commits only the settle's transition events", async () => {
    const fake = setup({
      dueTransitions: 2,
      challenges: [
        {
          id: "ch-1",
          slug: "wired",
          casterTeamId: TEAM_B,
          targetTeamId: TEAM_A,
          status: "open",
        },
      ],
    });
    const response = await claim(BARS.a.id);
    expect(response.status).toBe(409);
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
    expect(fake.transitionEvents).toHaveLength(2);
  });

  it("a claim on an ended game is rejected not_live with no writes", async () => {
    const fake = setup({ lifecycle: "ended" });
    const response = await claim(BARS.a.id);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "not_live" });
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
  });

  it("a non-member is rejected before settle or load", async () => {
    const fake = setup({ member: false });
    const response = await claim(BARS.a.id);
    expect(response.status).toBe(403);
    expect(fake.indexOfSql("bbb_settle_card_effects")).toBe(-1);
    expect(fake.committedEvents).toEqual([]);
    expect(domainWrites(fake)).toEqual([]);
  });

  it("an unknown bar key is rejected not_found with no writes", async () => {
    const fake = setup();
    const response = await claim("no-such-bar");
    expect(response.status).toBe(404);
    expect(domainWrites(fake)).toEqual([]);
    expect(fake.mutationEvents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline ordering (19.9).
// ---------------------------------------------------------------------------

describe("POST /claims — settle precedes loadBehaviorState (19.9)", () => {
  for (const action of ["claim", "unclaim", "bonus"] as const) {
    it(`${action}: lock → clock → settle(now) → load`, async () => {
      const fake = setup({
        claims: action === "claim" ? [] : [teamAClaimOnA],
        effects: action === "bonus" ? [happyHourOnA] : [],
      });
      const response =
        action === "claim"
          ? await claim(BARS.a.id)
          : action === "unclaim"
            ? await unclaim(BARS.a.id)
            : await bonus(BARS.a.id);
      expect(response.status).toBe(200);

      const lock = fake.indexOfSql("from locked g");
      const clock = fake.indexOfSql("clock_timestamp()");
      const settle = fake.indexOfSql("bbb_settle_card_effects");
      const load = fake.indexOfSql("admin_session_id, start_bar_id");
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(clock);
      expect(clock).toBeLessThan(settle);
      expect(settle).toBeLessThan(load);
      // Settled at the same server instant the plan is evaluated at.
      expect(fake.sqlCalls[settle].params).toEqual(["game-1", NOW_ISO]);
    });
  }
});

// ---------------------------------------------------------------------------
// Append failure rollback (19.5).
// ---------------------------------------------------------------------------

describe("POST /claims — append failure rolls back everything (19.5)", () => {
  const cases: Array<{
    name: string;
    failType: string;
    run: () => Promise<Response>;
    options: FakeClaimsDbOptions;
  }> = [
    {
      name: "claim (claim_recorded append fails)",
      failType: "claim_recorded",
      run: () => claim(BARS.a.id),
      options: { effects: [happyHourOnA] },
    },
    {
      name: "claim (draw append fails after claim + scores)",
      failType: "cards_drawn",
      run: () => claim(BARS.a.id),
      options: { effects: [happyHourOnA] },
    },
    {
      name: "unclaim (claim_removed append fails)",
      failType: "claim_removed",
      run: () => unclaim(BARS.a.id),
      options: {
        claims: [teamAClaimOnA],
        ledger: [
          {
            id: "led-share",
            teamId: TEAM_A,
            barId: BARS.a.id,
            category: "bar_share",
            points: 12,
          },
        ],
      },
    },
    {
      name: "bonus (happy_hour_bonus_claimed append fails)",
      failType: "happy_hour_bonus_claimed",
      run: () => bonus(BARS.a.id),
      options: { claims: [teamAClaimOnA], effects: [happyHourOnA] },
    },
  ];

  for (const { name, failType, run, options } of cases) {
    it(`${name}: responds unavailable and commits nothing, transition events included`, async () => {
      const fake = setup({
        ...options,
        dueTransitions: 1,
        failAppendOfType: failType,
      });
      const response = await run();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        applied: false,
        error: "unavailable",
      });
      expect(fake.rolledBack).toBe(true);
      expect(fake.committed).toBe(false);
      expect(fake.committedWrites).toEqual([]);
      expect(fake.committedEvents).toEqual([]);
    });
  }
});
