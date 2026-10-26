/**
 * Keep-card route tests, reworked onto the Card_Behavior_Mutation pipeline
 * (card-behavior Task 7.4).
 *
 * The route runs the real pipeline (`loadCardMutationContext`: authorize +
 * lock, server `now`, lazy settle, `loadBehaviorState`; then the pure `keepCard`
 * transition, `settleInventoryChange`, and `persistDeckTransition` with the
 * embedded inventory follow-up). These tests drive that pipeline against the
 * shared {@link FakeMutationDb} harness and assert:
 *
 *   - a keep resolves the pending draw and appends exactly one mutation event;
 *     with a due-transition fixture the lazy settle appends its transition event
 *     first, ahead of the mutation (R19.9, R19.10);
 *   - Power Hour's `keep_all` mode moves only the chosen card into the hand and
 *     leaves the rest pending (R17.2);
 *   - engine rejections (no pending draw, card not pending, hand full) map to
 *     the right structured 4xx and write no mutation event;
 *   - an injected append failure rolls back: no mutation event, `unavailable`.
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
  return new Request(`http://test/api/games/${IDS.gameId}/cards/keep`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: IDS.gameId }) };
}

/** Two pending cards drawn against a bar, the normal `choose_one` draw shape. */
function pendingPair() {
  return [
    {
      slug: "moneybags",
      deckState: "pending" as const,
      drawPosition: 0,
      pendingBarId: IDS.startBar,
    },
    {
      slug: "wired",
      deckState: "pending" as const,
      drawPosition: 1,
      pendingBarId: IDS.startBar,
    },
  ];
}

beforeEach(() => {
  freshDb();
});

describe("POST /api/games/[gameId]/cards/keep — pipeline", () => {
  it("keeps one of a pending pair and appends exactly one mutation event", async () => {
    freshDb({ instances: pendingPair() });

    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(true);

    expect(db.mutationEvents).toHaveLength(1);
    expect(db.mutationEvents[0].eventType).toBe("card_kept");
    // The chosen card moves to hand, the other is discarded — two row diffs.
    const byState = new Map(
      db.instanceUpserts.map((u) => [u.slug, u.deckState]),
    );
    expect(byState.get("moneybags")).toBe("hand");
    expect(byState.get("wired")).toBe("discarded");
  });

  it("appends the lazy-settle transition events before the mutation event", async () => {
    freshDb({ instances: pendingPair(), dueTransitions: 2 });

    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );
    expect(response.status).toBe(200);

    expect(db.transitionEvents).toHaveLength(2);
    expect(db.mutationEvents).toHaveLength(1);
    const maxTransitionSeq = Math.max(...db.transitionEvents.map((e) => e.seq));
    expect(maxTransitionSeq).toBeLessThan(db.mutationEvents[0].seq);
    // The settle ran before loadBehaviorState.
    const settleIdx = db.sqlCalls.findIndex((s) =>
      s.includes("bbb_settle_card_effects"),
    );
    const loadIdx = db.sqlCalls.findIndex((s) => s.includes("from teams t"));
    expect(settleIdx).toBeLessThan(loadIdx);
  });

  it("keeps only the chosen card under Power Hour keep_all, leaving the rest pending", async () => {
    // Three pending cards in keep_all mode: keeping one moves only it to hand,
    // discards nothing, and leaves the other two pending (R17.2).
    freshDb({
      instances: [
        {
          slug: "moneybags",
          deckState: "pending",
          drawPosition: 0,
          pendingBarId: IDS.startBar,
        },
        {
          slug: "wired",
          deckState: "pending",
          drawPosition: 1,
          pendingBarId: IDS.startBar,
        },
        {
          slug: "dirty-bird",
          deckState: "pending",
          drawPosition: 2,
          pendingBarId: IDS.startBar,
        },
      ],
      pendingMode: "keep_all",
    });

    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );

    expect(response.status).toBe(200);
    // Only moneybags changed (to hand); nothing was discarded.
    expect(db.instanceUpserts).toEqual([
      { slug: "moneybags", deckState: "hand" },
    ]);
    // The draw stays open: the persisted pending mode is still keep_all.
    expect(db.teamDeckUpserts.at(-1)?.pendingMode).toBe("keep_all");
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    freshDb({ instances: pendingPair(), failMutationAppend: true });

    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  // --- Authorization + rejection mapping ----------------------------------

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request({ cardId: "x" }, null), params());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "missing_session",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a non-member with 403 and applies nothing", async () => {
    freshDb({ member: false });
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
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

  it("rejects a teamless requester with 403", async () => {
    freshDb({ teamId: null });
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_team",
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

  it("maps the engine's no-pending-draw rejection to 409 no_pending_draw", async () => {
    // A card in hand, no pending draw -> keepCard rejects with `pending_draw`.
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
    });
    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_pending_draw",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("maps the engine's card_not_pending rejection to 409", async () => {
    // Name a card that is not the pending one.
    freshDb({ instances: pendingPair() });
    const response = await POST(
      request({ cardId: `${IDS.teamA}:go-piss-girl` }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "card_not_pending",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("maps the engine's hand_full rejection to 409", async () => {
    // Hand already holds two cards, plus a pending draw: keeping overflows.
    freshDb({
      instances: [
        { slug: "insurance", deckState: "hand", drawPosition: 0 },
        { slug: "power-hour", deckState: "hand", drawPosition: 1 },
        {
          slug: "moneybags",
          deckState: "pending",
          drawPosition: 2,
          pendingBarId: IDS.startBar,
        },
      ],
    });
    const response = await POST(
      request({ cardId: `${IDS.teamA}:moneybags` }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "hand_full",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });
});
