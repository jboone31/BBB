/**
 * Real card-play route tests (brawl-deck-architecture Task 8; R3.1, R3.2, R3.3).
 *
 * The deck transition is delegated to the persistence helper (mocked here); the
 * eligibility fold runs for real against the events the fake tx returns. These
 * tests assert the route's responsibilities: auth, team-target validation
 * (in-game, not self, not already same-card-targeted on the server — R3.3), and
 * that a valid play delegates one `play` transition carrying the targets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

let mockMember = true;
let mockLifecycle: "lobby" | "live" | "ended" = "live";
let mockTeamId: string | null = "team-a";
let mockTargetTeamInGame = true;
// Prior committed events the eligibility fold reads (as raw game_events rows).
let mockEventRows: Record<string, unknown>[] = [];

const fakeTx: QueryRunner = {
  async query(sql: string, params: readonly unknown[] = []) {
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
    if (text.includes("from teams")) {
      return { rows: mockTargetTeamInGame ? [{ ok: 1 }] : [] };
    }
    if (text.includes("from game_events")) {
      return { rows: mockEventRows };
    }
    void params;
    return { rows: [] };
  },
};

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(fakeTx),
}));

let mockPlayResult: { ok: boolean; seq?: number; reason?: string } = {
  ok: true,
  seq: 9,
};
const mockPlayCalls: Array<{
  teamId: string;
  eventExtra: Record<string, unknown>;
}> = [];

vi.mock("@/lib/cards/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cards/persistence")
  >("@/lib/cards/persistence");
  return {
    ...actual,
    applyDeckTransition: vi.fn(
      async (
        _tx: QueryRunner,
        args: {
          ctx: { gameId: string; teamId: string };
          eventExtra?: Record<string, unknown>;
        },
      ) => {
        mockPlayCalls.push({
          teamId: args.ctx.teamId,
          eventExtra: args.eventExtra ?? {},
        });
        return mockPlayResult.ok
          ? { ok: true, seq: mockPlayResult.seq ?? 0, state: {} }
          : {
              ok: false,
              reason: mockPlayResult.reason ?? "rejected",
              state: {},
            };
      },
    ),
  };
});

import { POST } from "./route";

function cardPlayedRow(
  seq: number,
  slug: string,
  castingTeamId: string,
  targetTeamId: string,
): Record<string, unknown> {
  return {
    id: `e-${seq}`,
    game_id: "game-1",
    seq,
    event_type: "card_played",
    actor_kind: "team",
    actor_team_id: castingTeamId,
    payload: { castingTeamId, slug, targetTeamId, teamId: castingTeamId },
    created_at: new Date(seq).toISOString(),
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
  return new Request("http://test/api/games/game-1/cards/play", {
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
  mockTeamId = "team-a";
  mockTargetTeamInGame = true;
  mockEventRows = [];
  mockPlayResult = { ok: true, seq: 9 };
  mockPlayCalls.length = 0;
});

// go-piss-girl is a team-targeting card; power-hour targets no one;
// happy-hour targets a bar; voted-off-the-island targets a team AND a bar.
const TEAM_CARD = "team-a:go-piss-girl";
const NONE_CARD = "team-a:power-hour";
const BAR_CARD = "team-a:happy-hour";
const TEAM_AND_BAR_CARD = "team-a:voted-off-the-island";

function cardPlayedBarRow(
  seq: number,
  slug: string,
  castingTeamId: string,
  targetBarId: string,
): Record<string, unknown> {
  return {
    id: `e-${seq}`,
    game_id: "game-1",
    seq,
    event_type: "card_played",
    actor_kind: "team",
    actor_team_id: castingTeamId,
    payload: { castingTeamId, slug, targetBarId, teamId: castingTeamId },
    created_at: new Date(seq).toISOString(),
  };
}

describe("POST /api/games/[gameId]/cards/play (R3.1, R3.2, R3.3)", () => {
  it("plays a team-targeting card and records the target in the event extra", async () => {
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 9 });
    expect(mockPlayCalls).toHaveLength(1);
    expect(mockPlayCalls[0].teamId).toBe("team-a");
    expect(mockPlayCalls[0].eventExtra).toMatchObject({
      castingTeamId: "team-a",
      slug: "go-piss-girl",
      targetTeamId: "team-b",
    });
  });

  it("plays a no-target card without requiring a target team", async () => {
    const response = await POST(request({ cardId: NONE_CARD }), params());
    expect(response.status).toBe(200);
    expect(mockPlayCalls[0].eventExtra).toMatchObject({ slug: "power-hour" });
  });

  it("rejects a missing session (401), applying nothing", async () => {
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }, null),
      params(),
    );
    expect(response.status).toBe(401);
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects a non-member (403)", async () => {
    mockMember = false;
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(403);
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects a team-targeting card with no target (400 invalid_card)", async () => {
    const response = await POST(request({ cardId: TEAM_CARD }), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_card",
    });
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects targeting the caster's own team (400)", async () => {
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-a" }),
      params(),
    );
    expect(response.status).toBe(400);
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects a target team not in the game (404)", async () => {
    mockTargetTeamInGame = false;
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "ghost" }),
      params(),
    );
    expect(response.status).toBe(404);
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects a team already targeted by the same card (409 target_ineligible) — R3.3", async () => {
    // team-a already played go-piss-girl on team-b.
    mockEventRows = [cardPlayedRow(1, "go-piss-girl", "team-a", "team-b")];
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "target_ineligible",
    });
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("allows a DIFFERENT card to target a team already hit by another card", async () => {
    mockEventRows = [cardPlayedRow(1, "wired", "team-a", "team-b")];
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(mockPlayCalls).toHaveLength(1);
  });

  it("maps the engine's card_not_in_hand rejection to 409", async () => {
    mockPlayResult = { ok: false, reason: "card_not_in_hand" };
    const response = await POST(
      request({ cardId: TEAM_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "card_not_in_hand",
    });
  });

  // --- Bar targeting (Task 9; R3.4, R3.5) ---------------------------------

  it("plays a bar-targeting card and records the target bar", async () => {
    const response = await POST(
      request({ cardId: BAR_CARD, targetBarId: "bar-1" }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(mockPlayCalls[0].eventExtra).toMatchObject({
      slug: "happy-hour",
      targetBarId: "bar-1",
    });
  });

  it("rejects a bar-targeting card with no bar (400)", async () => {
    const response = await POST(request({ cardId: BAR_CARD }), params());
    expect(response.status).toBe(400);
    expect(mockPlayCalls).toHaveLength(0);
  });

  it("rejects a bar already targeted by the same card (409) — R3.5", async () => {
    mockEventRows = [cardPlayedBarRow(1, "happy-hour", "team-a", "bar-1")];
    const response = await POST(
      request({ cardId: BAR_CARD, targetBarId: "bar-1" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "target_ineligible",
    });
    expect(mockPlayCalls).toHaveLength(0);
  });

  // --- Team-and-bar (Task 9; R3.6) ----------------------------------------

  it("plays a team_and_bar card carrying both targets", async () => {
    const response = await POST(
      request({
        cardId: TEAM_AND_BAR_CARD,
        targetTeamId: "team-b",
        targetBarId: "bar-1",
      }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(mockPlayCalls[0].eventExtra).toMatchObject({
      slug: "voted-off-the-island",
      targetTeamId: "team-b",
      targetBarId: "bar-1",
    });
  });

  it("rejects a team_and_bar card missing the bar (400)", async () => {
    const response = await POST(
      request({ cardId: TEAM_AND_BAR_CARD, targetTeamId: "team-b" }),
      params(),
    );
    expect(response.status).toBe(400);
    expect(mockPlayCalls).toHaveLength(0);
  });
});
