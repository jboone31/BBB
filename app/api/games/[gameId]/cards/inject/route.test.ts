/**
 * Dev-only inject route tests (brawl-deck-architecture Task 10; R5.2, R5.3).
 *
 * The decisive requirements:
 *   - when DEV_CARD_INJECTION is false the route REFUSES the operation (not just
 *     hidden in the UI) — no injection happens even when called directly (R5.3);
 *   - when true, it injects the chosen slug into the team's hand, bypassing the
 *     hand-size limit (R5.2).
 *
 * The committed flag is mocked here so both states can be exercised; the deck
 * persistence `injectCardToHand` is mocked so the test asserts the route's
 * responsibilities (flag gate, auth, delegation), not the row mapping (covered
 * by the persistence tests).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

let mockFlagOn = false;
vi.mock("@/lib/config/devFlags", () => ({
  isDevCardInjectionEnabled: () => mockFlagOn,
  isDevFlagEnabled: (flag: string) =>
    flag === "DEV_CARD_INJECTION" ? mockFlagOn : false,
  DEV_FLAGS: { DEV_CARD_INJECTION: false },
}));

let mockMember = true;
let mockLifecycle: "lobby" | "live" | "ended" = "live";
let mockTeamId: string | null = "team-a";

const fakeTx: QueryRunner = {
  async query(sql: string) {
    const text = sql.toLowerCase();
    if (text.includes("from locked") || text.includes("from games g")) {
      return { rows: mockMember ? [{ ok: 1 }] : [] };
    }
    if (text.includes("select lifecycle")) {
      return { rows: [{ lifecycle: mockLifecycle }] };
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

const mockInjectCalls: Array<{ teamId: string; slug: string }> = [];
let mockInjectResult: { ok: boolean; seq?: number; cardId?: string } = {
  ok: true,
  seq: 4,
  cardId: "team-a:go-piss-girl",
};

vi.mock("@/lib/cards/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cards/persistence")
  >("@/lib/cards/persistence");
  return {
    ...actual,
    injectCardToHand: vi.fn(
      async (
        _tx: QueryRunner,
        ctx: { gameId: string; teamId: string },
        slug: string,
      ) => {
        mockInjectCalls.push({ teamId: ctx.teamId, slug });
        return mockInjectResult.ok
          ? {
              ok: true,
              seq: mockInjectResult.seq ?? 0,
              cardId: mockInjectResult.cardId ?? `${ctx.teamId}:${slug}`,
            }
          : { ok: false, reason: "unknown_card" };
      },
    ),
  };
});

import { POST } from "./route";

function request(
  body: unknown,
  sessionId: string | null = "session-a",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request("http://test/api/games/game-1/cards/inject", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: "game-1" }) };
}

beforeEach(() => {
  mockFlagOn = false;
  mockMember = true;
  mockLifecycle = "live";
  mockTeamId = "team-a";
  mockInjectCalls.length = 0;
  mockInjectResult = { ok: true, seq: 4, cardId: "team-a:go-piss-girl" };
});

describe("POST /api/games/[gameId]/cards/inject", () => {
  it("REFUSES the operation when the flag is off, even when called directly (R5.3)", async () => {
    mockFlagOn = false;
    const response = await POST(request({ slug: "go-piss-girl" }), params());
    // Indistinguishable from an absent route; nothing injected.
    expect(response.status).toBe(404);
    expect(mockInjectCalls).toHaveLength(0);
  });

  it("does not even require a session when the flag is off (gate is first)", async () => {
    mockFlagOn = false;
    const response = await POST(
      request({ slug: "go-piss-girl" }, null),
      params(),
    );
    expect(response.status).toBe(404);
    expect(mockInjectCalls).toHaveLength(0);
  });

  it("injects the chosen slug into the team's hand when the flag is on (R5.2)", async () => {
    mockFlagOn = true;
    const response = await POST(request({ slug: "go-piss-girl" }), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 4 });
    expect(mockInjectCalls).toEqual([
      { teamId: "team-a", slug: "go-piss-girl" },
    ]);
  });

  it("rejects an unknown slug (400) when the flag is on", async () => {
    mockFlagOn = true;
    const response = await POST(request({ slug: "not-a-card" }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
    expect(mockInjectCalls).toHaveLength(0);
  });

  it("rejects a missing session (401) when the flag is on", async () => {
    mockFlagOn = true;
    const response = await POST(
      request({ slug: "go-piss-girl" }, null),
      params(),
    );
    expect(response.status).toBe(401);
    expect(mockInjectCalls).toHaveLength(0);
  });

  it("rejects a non-member (403) when the flag is on", async () => {
    mockFlagOn = true;
    mockMember = false;
    const response = await POST(request({ slug: "go-piss-girl" }), params());
    expect(response.status).toBe(403);
    expect(mockInjectCalls).toHaveLength(0);
  });
});
