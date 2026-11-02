/**
 * Forfeit-draw route tests, on the Card_Behavior_Mutation pipeline
 * (card-behavior Task 7.4).
 *
 * `forfeitDraw` discards BOTH pending cards without keeping either (R2.4). The
 * route runs the full pipeline (`loadCardMutationContext`: authorize + lock,
 * server `now`, lazy settle, `loadBehaviorState`; then the pure `forfeitDraw`
 * transition, `settleInventoryChange`, and `persistDeckTransition` with the
 * embedded inventory follow-up). These tests drive that pipeline against the
 * shared {@link FakeMutationDb} harness and assert:
 *
 *   - forfeiting an only-pending draw empties the hand and pending, completing
 *     an open Use It or Lose It in the SAME inventory event (R8.5);
 *   - exactly one mutation event is appended, after the lazy-settle transition
 *     events (R19.9, R19.10);
 *   - no pending draw maps to 409 `no_pending_draw` and writes no mutation event;
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

function request(sessionId: string | null = "session-a"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(`http://test/api/games/${IDS.gameId}/cards/forfeit`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: IDS.gameId }) };
}

/** A pending pair against a bar, with an empty hand (so a forfeit empties all). */
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

describe("POST /api/games/[gameId]/cards/forfeit — pipeline", () => {
  it("forfeits the pending draw, completing an open UIOLI in the same inventory event", async () => {
    // Only pending cards and no hand cards, so forfeiting empties both and
    // completes the open UIOLI targeting team A (R8.5).
    freshDb({
      instances: pendingPair(),
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

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(true);

    // Exactly one mutation event (a `card_discarded` inventory event).
    expect(db.mutationEvents).toHaveLength(1);
    expect(db.mutationEvents[0].eventType).toBe("card_discarded");
    // The UIOLI completion rides on that single event (R8.3, R8.5).
    expect(db.mutationEvents[0].payload.completeChallenges).toEqual([
      "chal-uioli",
    ]);
    // Both pending cards were discarded — neither kept (R2.4).
    const byState = new Map(
      db.instanceUpserts.map((u) => [u.slug, u.deckState]),
    );
    expect(byState.get("moneybags")).toBe("discarded");
    expect(byState.get("wired")).toBe("discarded");
  });

  it("appends exactly one mutation event, after the lazy-settle transition events", async () => {
    freshDb({ instances: pendingPair(), dueTransitions: 1 });

    const response = await POST(request(), params());
    expect(response.status).toBe(200);

    expect(db.transitionEvents).toHaveLength(1);
    expect(db.mutationEvents).toHaveLength(1);
    expect(db.transitionEvents[0].seq).toBeLessThan(db.mutationEvents[0].seq);
    const settleIdx = db.sqlCalls.findIndex((s) =>
      s.includes("bbb_settle_card_effects"),
    );
    const loadIdx = db.sqlCalls.findIndex((s) => s.includes("from teams t"));
    expect(settleIdx).toBeLessThan(loadIdx);
  });

  it("rolls back and returns unavailable when the mutation append fails", async () => {
    freshDb({ instances: pendingPair(), failMutationAppend: true });

    const response = await POST(request(), params());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  // --- Authorization + rejection mapping ----------------------------------

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request(null), params());
    expect(response.status).toBe(401);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects a non-member with 403 and applies nothing", async () => {
    freshDb({ member: false });
    const response = await POST(request(), params());
    expect(response.status).toBe(403);
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("rejects when the game is not live with 409", async () => {
    freshDb({ lifecycle: "lobby" });
    const response = await POST(request(), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_live",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });

  it("maps the engine's no-pending-draw rejection to 409 no_pending_draw", async () => {
    // A card in hand with no pending draw -> forfeitDraw rejects.
    freshDb({
      instances: [{ slug: "moneybags", deckState: "hand", drawPosition: 0 }],
    });
    const response = await POST(request(), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_pending_draw",
    });
    expect(db.mutationEvents).toHaveLength(0);
  });
});
