/**
 * Keep-card route tests (brawl-deck-architecture Task 5; R1.2, R2.4).
 *
 * The route delegates the deck transition to the persistence helper (which has
 * its own hermetic + live coverage), so these tests mock that helper and assert
 * the route's own responsibilities: session + membership + live + team
 * authorization, that exactly one `keep` transition is applied for the
 * requester's team and card, and that engine rejections map to the right
 * structured 4xx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

let mockMember = true;
let mockLifecycle: "lobby" | "live" | "ended" = "live";
let mockGameExists = true;
let mockTeamId: string | null = "team-a";

const fakeTx: QueryRunner = {
  async query(sql: string) {
    const text = sql.toLowerCase();
    if (text.includes("from locked") || text.includes("from games g")) {
      return { rows: mockMember ? [{ ok: 1 }] : [] };
    }
    if (text.includes("select lifecycle")) {
      return { rows: mockGameExists ? [{ lifecycle: mockLifecycle }] : [] };
    }
    if (text.includes("from players")) {
      return { rows: [{ team_id: mockTeamId }] };
    }
    return { rows: [] };
  },
};

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(fakeTx),
}));

let mockResult: { ok: boolean; seq?: number; reason?: string } = {
  ok: true,
  seq: 5,
};
const mockCalls: Array<{
  kind: string;
  teamId: string;
  transitionReason?: string;
}> = [];

vi.mock("@/lib/cards/persistence", () => ({
  applyDeckTransition: vi.fn(
    async (
      _tx: QueryRunner,
      args: {
        ctx: { gameId: string; teamId: string };
        kind: string;
        transition: (s: unknown) => { ok: boolean; reason?: string };
      },
    ) => {
      mockCalls.push({ kind: args.kind, teamId: args.ctx.teamId });
      return mockResult.ok
        ? { ok: true, seq: mockResult.seq ?? 0, state: {} }
        : { ok: false, reason: mockResult.reason ?? "rejected", state: {} };
    },
  ),
}));

import { POST } from "./route";

function request(
  body: unknown,
  sessionId: string | null = "session-a",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request("http://test/api/games/game-1/cards/keep", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: "game-1" }) };
}

beforeEach(() => {
  mockMember = true;
  mockLifecycle = "live";
  mockGameExists = true;
  mockTeamId = "team-a";
  mockResult = { ok: true, seq: 5 };
  mockCalls.length = 0;
});

describe("POST /api/games/[gameId]/cards/keep", () => {
  it("applies one keep transition for the requester's team and returns the seq", async () => {
    const response = await POST(
      request({ cardId: "team-a:go-piss-girl" }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 5 });
    expect(mockCalls).toEqual([{ kind: "keep", teamId: "team-a" }]);
  });

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request({ cardId: "x" }, null), params());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "missing_session",
    });
    expect(mockCalls).toHaveLength(0);
  });

  it("rejects a non-member with 403 and applies nothing", async () => {
    mockMember = false;
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
    expect(mockCalls).toHaveLength(0);
  });

  it("rejects when the game is not live with 409", async () => {
    mockLifecycle = "lobby";
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_live",
    });
    expect(mockCalls).toHaveLength(0);
  });

  it("rejects a teamless requester with 403", async () => {
    mockTeamId = null;
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_team",
    });
    expect(mockCalls).toHaveLength(0);
  });

  it("rejects a blank card id with 400", async () => {
    const response = await POST(request({ cardId: "   " }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
    expect(mockCalls).toHaveLength(0);
  });

  it("maps the engine's no-pending-draw rejection to 409 no_pending_draw", async () => {
    mockResult = { ok: false, reason: "pending_draw" };
    const response = await POST(
      request({ cardId: "team-a:go-piss-girl" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "no_pending_draw",
    });
  });

  it("maps the engine's card_not_pending rejection to 409", async () => {
    mockResult = { ok: false, reason: "card_not_pending" };
    const response = await POST(
      request({ cardId: "team-a:go-piss-girl" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "card_not_pending",
    });
  });
});
