/**
 * Fairest-of-Them-All decision route tests (card-behavior Task 7.11), on the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the
 * "Fairest decision route" row).
 *
 * The route runs the real pipeline (`resolveCardActor`: authorize + lock, server
 * `now`, lazy settle, `loadBehaviorState`; then the pure `decideFairest`, the
 * Fairest hand→played deck move, `writeOffers`, `writeChallenges` /
 * `writeEffects`, and one `fairest_decided` mutation event). These tests drive
 * that whole pipeline against the shared in-memory {@link FakeMutationDb} harness
 * so the pipeline's observable contract is asserted directly rather than mocked:
 *
 *   - Play: the Fairest card moves hand→played, the decided offer plus any voided
 *     offers are written, the mirrored challenge OR mirrored next-claim-restriction
 *     effect is written, and exactly one `fairest_decided` event embeds the moved
 *     card / offers / challenge / effect; response is applied(seq) (R9.5, R9.8,
 *     R9.9, R9.13);
 *   - Decline: only the declined offer is written, no mirrored subject, one
 *     `fairest_decided` event, applied(seq) (R9.4);
 *   - `not_authorized` when the requester is not the offer holder, write-free
 *     (R9.3);
 *   - `already_resolved` for an already-decided offer, write-free;
 *   - `conflict` when the Fairest card is no longer in hand, write-free (R9.5);
 *   - a Scenic Route Play whose mirror became illegal at decision-time `now`
 *     rejects with `invalid_input`, `details.reason = "no_legal_next_bar"` and the
 *     rules; nothing written, offer stays pending (R9.16, R9.17);
 *   - with a due-transition fixture the lazy-settle transition events precede the
 *     single mutation event (R19.9, R19.10);
 *   - an injected append failure rolls back: no mutation event, `unavailable`
 *     (R19.5).
 *
 * Hermetic: the fake {@link QueryRunner} needs no live Postgres (R24.2).
 *
 * Requirements: 9.4, 9.5, 9.8, 9.9, 9.13, 9.16, 9.17, 19.5, 19.9, 19.10, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

import {
  FakeMutationDb,
  IDS,
  type FakeDbOptions,
  type InstanceSeed,
  type OfferSeed,
} from "../../cards/_mutationTestDb";

let db: FakeMutationDb;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(db.runner),
}));

import { POST } from "./route";

const OFFER_ID = "offer-decide-1";

function freshDb(options: FakeDbOptions = {}): FakeMutationDb {
  db = new FakeMutationDb(options);
  return db;
}

/** A Fairest card held in hand by the acting team (team A), so a Play can move it. */
const FAIREST_IN_HAND: InstanceSeed = {
  slug: "fairest-of-them-all",
  deckState: "hand",
  drawPosition: 0,
};

/**
 * A pending offer held by team A (the acting team by default), mirrored back onto
 * team B as the original caster. `slug` drives the mirrored subject: a gated team
 * card ("go-piss-girl") mirrors a challenge; "pioneer" / "scenic-route" mirror a
 * next-claim-restriction effect.
 */
function pendingOffer(overrides: Partial<OfferSeed> = {}): OfferSeed {
  return {
    id: OFFER_ID,
    slug: "go-piss-girl",
    sourcePlayId: "play-1",
    holderTeamId: IDS.teamA,
    originalCasterTeamId: IDS.teamB,
    challengeId: "chal-1",
    status: "pending",
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
    `http://test/api/games/${IDS.gameId}/fairest-offers/${OFFER_ID}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function params(): {
  params: Promise<{ gameId: string; offerId: string }>;
} {
  return {
    params: Promise.resolve({ gameId: IDS.gameId, offerId: OFFER_ID }),
  };
}

beforeEach(() => {
  freshDb();
});

// ---------------------------------------------------------------------------
// Play — mirror a gated challenge.
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — play (mirror a challenge)", () => {
  it("moves Fairest hand→played, writes the decided offer and mirrored challenge, appends one fairest_decided", async () => {
    freshDb({ instances: [FAIREST_IN_HAND], offers: [pendingOffer()] });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ applied: true });

    // The Fairest card was moved to `played` as a row-only deck diff.
    const fairestMove = db.instanceUpserts.find(
      (u) => u.slug === "fairest-of-them-all",
    );
    expect(fairestMove?.deckState).toBe("played");

    // The decided offer was written as played, naming its mirrored challenge.
    expect(db.offerUpserts).toHaveLength(1);
    expect(db.offerUpserts[0].id).toBe(OFFER_ID);
    expect(db.offerUpserts[0].status).toBe("played");
    expect(db.offerUpserts[0].mirroredChallengeId).not.toBeNull();
    expect(db.offerUpserts[0].mirroredEffectId).toBeNull();

    // Exactly one mirrored challenge row was written on the original caster; no
    // restriction effect for a gated card.
    expect(db.challengeUpserts).toHaveLength(1);
    expect(db.effectUpserts).toHaveLength(0);

    // Exactly one mutation event embedding the moved card, offers, and challenge.
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.eventType).toBe("fairest_decided");
    expect(event.actorTeamId).toBe(IDS.teamA);
    expect(event.payload.offerId).toBe(OFFER_ID);
    expect(event.payload.decision).toBe("play");
    expect(
      (event.payload.cards as { slug: string; state: string }[]).some(
        (c) => c.slug === "fairest-of-them-all" && c.state === "played",
      ),
    ).toBe(true);
    expect((event.payload.offers as unknown[]).length).toBeGreaterThanOrEqual(
      1,
    );
    expect((event.payload.challenges as unknown[]).length).toBe(1);
    expect(event.payload.effects).toEqual([]);
  });

  it("voids the holder's other pending offers alongside the decided one", async () => {
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [
        pendingOffer(),
        pendingOffer({
          id: "offer-other",
          slug: "wired",
          sourcePlayId: "play-2",
          challengeId: "chal-2",
        }),
      ],
    });

    const response = await POST(request({ decision: "play" }), params());
    expect(response.status).toBe(200);

    // Both the decided offer and the other pending offer were written; the other
    // one as `void`.
    expect(db.offerUpserts).toHaveLength(2);
    const decided = db.offerUpserts.find((o) => o.id === OFFER_ID);
    const voided = db.offerUpserts.find((o) => o.id === "offer-other");
    expect(decided?.status).toBe("played");
    expect(voided?.status).toBe("void");

    // Still exactly one mutation event.
    expect(db.mutationEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Play — mirror a next-claim-restriction effect (Pioneer).
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — play (mirror a restriction)", () => {
  it("writes a mirrored next_claim_restriction effect and no challenge for a Pioneer offer", async () => {
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer({ slug: "pioneer", challengeId: null })],
    });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ applied: true });

    // The decided offer names a mirrored effect, not a challenge.
    expect(db.offerUpserts).toHaveLength(1);
    expect(db.offerUpserts[0].status).toBe("played");
    expect(db.offerUpserts[0].mirroredEffectId).not.toBeNull();
    expect(db.offerUpserts[0].mirroredChallengeId).toBeNull();

    // Exactly one mirrored restriction effect on the original caster; no challenge.
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.effectUpserts).toHaveLength(1);
    expect(db.effectUpserts[0].kind).toBe("next_claim_restriction");
    expect(db.effectUpserts[0].targetTeamId).toBe(IDS.teamB);

    // Exactly one mutation event embedding the effect.
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.payload.challenges).toEqual([]);
    expect((event.payload.effects as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decline.
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — decline", () => {
  it("writes only the declined offer, no mirrored subject, one fairest_decided", async () => {
    freshDb({ instances: [FAIREST_IN_HAND], offers: [pendingOffer()] });

    const response = await POST(request({ decision: "decline" }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ applied: true });

    // The Fairest card stays in hand — no deck move on a decline.
    expect(
      db.instanceUpserts.some((u) => u.slug === "fairest-of-them-all"),
    ).toBe(false);

    // Only the declined offer written; no mirrored challenge or effect.
    expect(db.offerUpserts).toHaveLength(1);
    expect(db.offerUpserts[0].status).toBe("declined");
    expect(db.offerUpserts[0].mirroredChallengeId).toBeNull();
    expect(db.offerUpserts[0].mirroredEffectId).toBeNull();
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.effectUpserts).toHaveLength(0);

    // Exactly one mutation event.
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.eventType).toBe("fairest_decided");
    expect(event.payload.decision).toBe("decline");
    expect(event.payload.cards).toEqual([]);
    expect(event.payload.challenges).toEqual([]);
    expect(event.payload.effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Write-free rejections.
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — write-free rejections", () => {
  it("rejects not_authorized when the requester is not the offer holder", async () => {
    // The offer is held by team B, but the acting session resolves to team A.
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer({ holderTeamId: IDS.teamB })],
    });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_authorized",
    });
    expect(db.offerUpserts).toHaveLength(0);
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.effectUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects already_resolved when the offer is already decided", async () => {
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer({ status: "played" })],
    });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "already_resolved",
    });
    expect(db.offerUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects conflict when the Fairest card is no longer in hand", async () => {
    // No Fairest instance seeded, so the holder no longer holds it in hand.
    freshDb({ instances: [], offers: [pendingOffer()] });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    expect(db.offerUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request({ decision: "play" }, null), params());
    expect(response.status).toBe(401);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a bad decision body with 400 invalid_input", async () => {
    freshDb({ instances: [FAIREST_IN_HAND], offers: [pendingOffer()] });
    const response = await POST(request({ decision: "nope" }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_input",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a non-member write-free (the ACTUAL actor-reason mapping is 403 not_member)", async () => {
    // KNOWN INCONSISTENCY: resolveCardActor rejects a non-member with
    // `not_member` and this route returns that reason *directly* (actor.reason),
    // so ERROR_STATUS maps it to 403. The play/resolve routes instead funnel the
    // actor reason through their local `reasonFor`, where `not_member`/`no_team`
    // collapse to `invalid_input` (400). This route was NOT given that funnel, so
    // its actor-rejection statuses differ (403 here vs 400 there). We assert the
    // ACTUAL behavior (403) so the divergence is visible, not silently masked.
    freshDb({ member: false, offers: [pendingOffer()] });
    const response = await POST(request({ decision: "play" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
    expect(db.mutationEvents).toHaveLength(0);
    expect(db.offerUpserts).toHaveLength(0);
  });

  it("rejects a teamless requester write-free (the ACTUAL actor-reason mapping is 403 no_team)", async () => {
    // Same known inconsistency as above: a teamless member yields `no_team`,
    // returned directly → 403 here (vs 400 via `reasonFor` on the play route).
    freshDb({ teamId: null, offers: [pendingOffer()] });
    const response = await POST(request({ decision: "play" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_team",
    });
    expect(db.mutationEvents).toHaveLength(0);
    expect(db.offerUpserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Illegal mirror at decision time (Scenic Route).
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — illegal mirror", () => {
  it("rejects a Scenic Route play whose mirror has no legal next bar with no_legal_next_bar, leaving the offer pending", async () => {
    // A Scenic Route mirror needs the original caster to still have a bar farther
    // from the finish than its previous bar. The harness bars carry no
    // coordinates, so Scenic Route is never satisfiable → mirrorIsLegal is false.
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer({ slug: "scenic-route", challengeId: null })],
    });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      applied: boolean;
      error: string;
      details: { reason: string; rules: string[] };
    };
    expect(body.applied).toBe(false);
    expect(body.error).toBe("invalid_input");
    expect(body.details.reason).toBe("no_legal_next_bar");
    expect(body.details.rules).toContain("scenic");

    // Nothing written; the offer stays pending so Decline remains available.
    expect(db.offerUpserts).toHaveLength(0);
    expect(db.challengeUpserts).toHaveLength(0);
    expect(db.effectUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lazy-settle ordering + append-failure rollback.
// ---------------------------------------------------------------------------

describe("POST /fairest-offers/[offerId] — settle ordering + rollback", () => {
  it("orders the lazy-settle transition events before the single mutation event", async () => {
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer()],
      dueTransitions: 1,
    });

    const response = await POST(request({ decision: "play" }), params());
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
    freshDb({
      instances: [FAIREST_IN_HAND],
      offers: [pendingOffer()],
      failMutationAppend: true,
    });

    const response = await POST(request({ decision: "play" }), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    // The mutation event never committed.
    expect(db.mutationEvents).toHaveLength(0);
  });
});
