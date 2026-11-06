/**
 * Discard-card route tests, reworked onto the Card_Behavior_Mutation pipeline
 * (card-behavior Task 7.4).
 *
 * The route now runs the real pipeline (`loadCardMutationContext`: authorize +
 * lock, server `now`, lazy settle, `loadBehaviorState`; then the pure
 * `discardCard` transition, `settleInventoryChange`, and `persistDeckTransition`
 * with the embedded inventory follow-up). These tests drive that whole pipeline
 * against the shared in-memory {@link FakeMutationDb} harness so the pipeline's
 * observable contract is asserted directly rather than mocked:
 *
 *   - a hand discard completes an open Use It or Lose It in the SAME inventory
 *     event (the emptying transaction), and appends exactly one mutation event —
 *     with a due-transition fixture the lazy settle appends its transition event
 *     first, ahead of the mutation (R8.3, R8.5, R19.9, R19.10);
 *   - the `cannot_play` shortcut is rejected with `conflict` while a Fairest
 *     offer for the team's open UIOLI is pending, writing no domain rows and no
 *     mutation event (R5.5, R19.9);
 *   - discarding the last Fairest of Them All voids the holder's pending offers
 *     on the single inventory event (R9.12);
 *   - an injected append failure rolls back: no mutation event, `unavailable`
 *     (R19.9, R19.10).
 *
 * Hermetic: the fake {@link QueryRunner} needs no live Postgres (R24.2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

import { FakeMutationDb, IDS, type FakeDbOptions } from "../_mutationTestDb";

let db: FakeMutationDb;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(db.runner),
}));

import { POST } from "./route";

function freshDb(options: FakeDbOptions = {}): FakeMutationDb {
  db = new FakeMutationDb(options);
  return db;
}

function request(
  body: unknown,
  sessionId: string | null = "session-a",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(`http://test/api/games/${IDS.gameId}/cards/discard`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: IDS.gameId }) };
}

beforeEach(() => {
  freshDb();
});

const CARD = `${IDS.teamA}:moneybags`;

describe("POST /api/games/[gameId]/cards/discard — pipeline", () => {
  it("discards a held card, completing an open UIOLI in the same inventory event", async () => {
    // Team A holds only moneybags; discarding it empties the hand and pending,
    // completing the open Use It or Lose It targeting team A (R8.5).
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
      challenges: [
        {
          id: "chal-uioli",
          slug: "use-it-or-lose-it",
          sourcePlayId: "play-1",
          casterTeamId: IDS.teamB,
          targetTeamId: IDS.teamA,
          status: "open",
        },
      ],
    });

    const response = await POST(request({ cardId: CARD }), params());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(true);

    // Exactly one mutation event (the inventory `card_discarded`).
    expect(db.mutationEvents).toHaveLength(1);
    const event = db.mutationEvents[0];
    expect(event.eventType).toBe("card_discarded");
    // The UIOLI completion rides on that single event (R8.3, R8.5).
    expect(event.payload.completeChallenges).toEqual(["chal-uioli"]);
    // The challenge row is also durably flipped to `completed`, so the claim
    // gate (evaluateClaimBlocks) stops blocking the team on a later claim — not
    // just the event payload carries the id (the QA "still blocks claims" bug).
    expect(db.challengeUpserts).toContainEqual({
      id: "chal-uioli",
      status: "completed",
      failureEffectId: null,
    });
    // One instance row changed (moneybags -> discarded).
    expect(db.instanceUpserts).toEqual([
      { slug: "moneybags", deckState: "discarded" },
    ]);
  });

  it("appends exactly one mutation event, after the lazy-settle transition events", async () => {
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
      dueTransitions: 1,
    });

    const response = await POST(request({ cardId: CARD }), params());
    expect(response.status).toBe(200);

    // The lazy settle appended one transition event; the route appended exactly
    // one mutation event, and the transition precedes it in the log (R19.9).
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

  it("rejects an ordinary discard with conflict while a Fairest offer is pending, writing nothing", async () => {
    // Team A has an open UIOLI with a live Fairest offer it still holds, so the
    // Fairest decision must resolve first (R9.3 / R5.5). The freeze now applies
    // to any discard — the dedicated "cannot_play" shortcut was removed — so a
    // plain discard (no reason) is what triggers it.
    freshDb({
      instances: [
        { slug: "moneybags", deckState: "hand", drawPosition: 0 },
        { slug: "fairest-of-them-all", deckState: "hand", drawPosition: 1 },
      ],
      challenges: [
        {
          id: "chal-uioli",
          slug: "use-it-or-lose-it",
          sourcePlayId: "play-1",
          casterTeamId: IDS.teamB,
          targetTeamId: IDS.teamA,
          status: "open",
        },
      ],
      offers: [
        {
          id: "offer-1",
          sourcePlayId: "play-1",
          holderTeamId: IDS.teamA,
          originalCasterTeamId: IDS.teamB,
          challengeId: "chal-uioli",
          status: "pending",
        },
      ],
      dueTransitions: 1,
    });

    const response = await POST(request({ cardId: CARD }), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    // No domain rows and no mutation event were written (transition events from
    // the step-3 settle are allowed to have committed).
    expect(db.instanceUpserts).toHaveLength(0);
    expect(db.teamDeckUpserts).toHaveLength(0);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("allows an ordinary discard during an open UIOLI when no Fairest offer is pending", async () => {
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
      challenges: [
        {
          id: "chal-uioli",
          slug: "use-it-or-lose-it",
          sourcePlayId: "play-1",
          casterTeamId: IDS.teamB,
          targetTeamId: IDS.teamA,
          status: "open",
        },
      ],
    });

    const response = await POST(request({ cardId: CARD }), params());

    expect(response.status).toBe(200);
    expect(db.mutationEvents).toHaveLength(1);
  });

  it("voids the holder's pending Fairest offers when the last Fairest leaves the hand", async () => {
    // Team A holds Fairest; discarding it means the team no longer holds
    // Fairest, so its pending offer voids on the same inventory event (R9.12).
    freshDb({
      instances: [
        { slug: "fairest-of-them-all", deckState: "hand", drawPosition: 0 },
        { slug: "moneybags", deckState: "hand", drawPosition: 1 },
      ],
      offers: [
        {
          id: "offer-void",
          sourcePlayId: "play-9",
          holderTeamId: IDS.teamA,
          originalCasterTeamId: IDS.teamB,
          challengeId: "chal-x",
          status: "pending",
        },
      ],
    });

    const response = await POST(
      request({ cardId: `${IDS.teamA}:fairest-of-them-all` }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(db.mutationEvents).toHaveLength(1);
    expect(db.mutationEvents[0].payload.voidOffers).toEqual(["offer-void"]);
    // The offer row is also durably voided, not just named on the event.
    expect(db.offerUpserts).toContainEqual({
      id: "offer-void",
      slug: "fairest-of-them-all",
      holderTeamId: "",
      status: "void",
      mirroredChallengeId: null,
      mirroredEffectId: null,
    });
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
      failMutationAppend: true,
    });

    const response = await POST(request({ cardId: CARD }), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    // The mutation event never committed.
    expect(db.mutationEvents).toHaveLength(0);
  });

  // --- Authorization + rejection mapping ----------------------------------

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request({ cardId: "x" }, null), params());
    expect(response.status).toBe(401);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a non-member with 403 and applies nothing", async () => {
    freshDb({ member: false });
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects when the game is not live with 409", async () => {
    freshDb({ lifecycle: "lobby" });
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_live",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a blank card id with 400", async () => {
    const response = await POST(request({ cardId: "   " }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
  });

  it("maps the engine's unknown_card rejection to 400 invalid_card", async () => {
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
    });
    const response = await POST(request({ cardId: "nope" }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("maps the engine's card_not_in_hand rejection to 409", async () => {
    // The card exists but is already discarded, so it is neither pending nor
    // in hand.
    freshDb({
      instances: [
        { slug: "moneybags", deckState: "discarded", drawPosition: 0 },
      ],
    });
    const response = await POST(request({ cardId: CARD }), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "card_not_in_hand",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });
});
