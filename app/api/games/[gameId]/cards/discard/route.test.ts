/**
 * Discard-card route tests (brawl-deck-architecture Task 5; R1.2, R2.4).
 *
 * The route delegates the deck transition to the persistence helper; these tests
 * mock it and assert the route's authorization + delegation + rejection mapping.
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
  seq: 7,
};
const mockCalls: Array<{ kind: string; teamId: string }> = [];

vi.mock("@/lib/cards/persistence", () => ({
  applyDeckTransition: vi.fn(
    async (
      _tx: QueryRunner,
      args: { ctx: { gameId: string; teamId: string }; kind: string },
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
  return new Request("http://test/api/games/game-1/cards/discard", {
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
  mockResult = { ok: true, seq: 7 };
  mockCalls.length = 0;
});

describe("POST /api/games/[gameId]/cards/discard", () => {
  it("applies one discard transition for the requester's team and returns the seq", async () => {
    const response = await POST(
      request({ cardId: "team-a:moneybags" }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 7 });
    expect(mockCalls).toEqual([{ kind: "discard", teamId: "team-a" }]);
  });

  it("rejects a missing session with 401 and applies nothing", async () => {
    const response = await POST(request({ cardId: "x" }, null), params());
    expect(response.status).toBe(401);
    expect(mockCalls).toHaveLength(0);
  });

  it("rejects a non-member with 403 and applies nothing", async () => {
    mockMember = false;
    const response = await POST(request({ cardId: "x" }), params());
    expect(response.status).toBe(403);
    expect(mockCalls).toHaveLength(0);
  });

  it("maps the engine's unknown_card rejection to 400 invalid_card", async () => {
    mockResult = { ok: false, reason: "unknown_card" };
    const response = await POST(request({ cardId: "nope" }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
  });

  it("maps the engine's card_not_in_hand rejection to 409", async () => {
    mockResult = { ok: false, reason: "card_not_in_hand" };
    const response = await POST(
      request({ cardId: "team-a:moneybags" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "card_not_in_hand",
    });
  });
});
