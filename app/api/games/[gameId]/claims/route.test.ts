import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

let mockMember = true;
let mockGame = {
  lifecycle: "live",
  start_bar_id: "start-bar",
  finish_bar_id: "finish-bar",
};
let mockBarExists = true;
let mockPlayer: { team_id: string | null } | null = { team_id: "team-a" };
let mockMemberCount = 2;
let mockActiveClaims: Array<{ id: string; team_id: string }> = [];
let mockAppendError: Error | null = null;
let mockCommitted = false;
let mockSeq = 0;
const mockAppendCalls: Array<{
  type: string;
  actor: unknown;
  payload: unknown;
}> = [];

const fakeTx: QueryRunner = {
  async query(sql: string, params: readonly unknown[] = []) {
    const text = sql.toLowerCase().trim();
    if (text.includes("from locked")) {
      return { rows: mockMember ? [{ member: 1 }] : [] };
    }
    if (text.includes("select lifecycle") && text.includes("start_bar_id")) {
      return { rows: [mockGame] };
    }
    if (text.includes("from bars")) {
      return { rows: mockBarExists ? [{ exists: 1 }] : [] };
    }
    if (text.startsWith("insert into bars")) {
      return { rows: [{ id: "catalog-bar-new" }] };
    }
    if (text.includes("from players") && text.includes("session_id")) {
      return { rows: mockPlayer ? [{ ...mockPlayer }] : [] };
    }
    if (text.includes("count(*)") && text.includes("from players")) {
      return { rows: [{ member_count: mockMemberCount }] };
    }
    if (text.includes("from claims") && text.includes("revoked_at")) {
      return { rows: mockActiveClaims.map((claim) => ({ ...claim })) };
    }
    if (text.startsWith("insert into claims")) {
      return { rows: [{ id: "claim-new" }] };
    }
    if (text.startsWith("update claims")) {
      return { rows: [{ id: String(params[0]) }] };
    }
    if (text.startsWith("insert into score_ledger_entries")) {
      return { rows: [{ id: "ledger-1" }] };
    }
    if (text.startsWith("update games")) {
      return { rows: [{ id: "game-1" }] };
    }
    return { rows: [] };
  },
};

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(
    fn: (tx: QueryRunner) => Promise<T>,
  ): Promise<T> => {
    mockCommitted = false;
    const result = await fn(fakeTx);
    mockCommitted = true;
    return result;
  },
}));

// Draw-on-claim: the route delegates to the deck persistence helper, which has
// its own exhaustive hermetic + live coverage (lib/cards/persistence*.test.ts).
// Here we mock it so the route tests assert ONLY the route's responsibility —
// that a non-finish claim triggers exactly one draw and the finish bar does not
// — without re-exercising the deck engine or needing card_* rows in fakeTx.
let mockDrawResult: {
  ok: boolean;
  seq?: number;
  reason?: string;
} = { ok: true, seq: 0 };
const mockDrawCalls: Array<{ gameId: string; teamId: string; barId?: string }> =
  [];

vi.mock("@/lib/cards/persistence", () => ({
  applyDeckTransition: vi.fn(
    async (
      _tx: QueryRunner,
      args: {
        ctx: { gameId: string; teamId: string };
        barId?: string;
      },
    ) => {
      mockDrawCalls.push({
        gameId: args.ctx.gameId,
        teamId: args.ctx.teamId,
        barId: args.barId,
      });
      if (mockDrawResult.ok && mockDrawResult.seq) {
        mockSeq = mockDrawResult.seq;
      }
      return mockDrawResult.ok
        ? { ok: true, seq: mockDrawResult.seq ?? 0, state: {} }
        : { ok: false, reason: mockDrawResult.reason ?? "rejected", state: {} };
    },
  ),
}));

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    appendEvent: vi.fn(
      async (
        _tx: QueryRunner,
        args: {
          type: string;
          actor: unknown;
          payload: unknown;
        },
      ) => {
        if (mockAppendError) throw mockAppendError;
        mockSeq += 1;
        mockAppendCalls.push(args);
        return {
          id: `event-${mockSeq}`,
          gameId: "game-1",
          seq: mockSeq,
          eventType: args.type,
          actorKind: "team" as const,
          actorTeamId: "team-a",
          payload: args.payload,
          createdAt: new Date(0).toISOString(),
        };
      },
    ),
  };
});

import { POST } from "./route";

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

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: "game-1" }) };
}

beforeEach(() => {
  mockMember = true;
  mockGame = {
    lifecycle: "live",
    start_bar_id: "start-bar",
    finish_bar_id: "finish-bar",
  };
  mockBarExists = true;
  mockPlayer = { team_id: "team-a" };
  mockMemberCount = 2;
  mockActiveClaims = [];
  mockAppendError = null;
  mockCommitted = false;
  mockSeq = 0;
  mockAppendCalls.length = 0;
  mockDrawResult = { ok: true, seq: 0 };
  mockDrawCalls.length = 0;
});

describe("POST /api/games/[gameId]/claims", () => {
  it("accepts an eligible claim and writes claim plus score events", async () => {
    const response = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 2,
      result: { claimId: "claim-new" },
    });
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
    ]);
    expect(mockCommitted).toBe(true);
  });

  it("rejects a team below the half-team threshold", async () => {
    mockMemberCount = 3;

    const response = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "claim_ineligible",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("records a start-bar claim without awarding score points", async () => {
    const response = await POST(
      request({
        action: "claim",
        barId: "start-bar",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
    ]);
  });

  it("materializes a missing candidate bar before claiming it", async () => {
    mockBarExists = false;

    const response = await POST(
      request({
        action: "claim",
        barId: "apres-diem",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
    ]);
  });

  it("rejects duplicate claims and only allows the owning team to unclaim", async () => {
    mockActiveClaims = [{ id: "claim-a", team_id: "team-b" }];

    const duplicate = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );
    expect(duplicate.status).toBe(200);

    mockActiveClaims = [{ id: "claim-a", team_id: "team-b" }];
    mockAppendCalls.length = 0;
    const unauthorizedUndo = await POST(
      request({ action: "unclaim", barId: "bar-a" }),
      params(),
    );
    expect(unauthorizedUndo.status).toBe(409);
    await expect(unauthorizedUndo.json()).resolves.toEqual({
      applied: false,
      error: "claim_not_active",
    });
    expect(mockAppendCalls).toHaveLength(0);
  });

  it("revokes the owning team's claim and appends correction events", async () => {
    mockActiveClaims = [{ id: "claim-a", team_id: "team-a" }];

    const response = await POST(
      request({ action: "unclaim", barId: "bar-a" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_removed",
      "score_modifier_applied",
    ]);
  });

  it("awards the finish bar and ends the game in the same transaction", async () => {
    const response = await POST(
      request({
        action: "claim",
        barId: "finish-bar",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 3,
      result: { claimId: "claim-new" },
    });
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
      "game_ended",
    ]);
  });

  it("rolls back all work when event append fails", async () => {
    mockAppendError = new Error("append failed");

    const response = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(500);
    expect(mockCommitted).toBe(false);
    expect(mockAppendCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Draw on claim (Task 4; R1.1, R1.3, R1.4, R1.6)
  // -------------------------------------------------------------------------

  it("triggers a draw for the claimed scoring bar in the same transaction (R1.1, R1.6)", async () => {
    mockDrawResult = { ok: true, seq: 3 };

    const response = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    // Exactly one draw, for the team + bar that was claimed.
    expect(mockDrawCalls).toHaveLength(1);
    expect(mockDrawCalls[0]).toEqual({
      gameId: "game-1",
      teamId: "team-a",
      barId: "bar-a",
    });
    // The draw committed alongside the claim and its score (same transaction).
    expect(mockCommitted).toBe(true);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
    ]);
    // The response surfaces the draw's seq as the latest committed event.
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 3,
      result: { claimId: "claim-new" },
    });
  });

  it("also draws on the start bar (0 points but still a draw)", async () => {
    const response = await POST(
      request({
        action: "claim",
        barId: "start-bar",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockDrawCalls).toHaveLength(1);
    expect(mockDrawCalls[0].barId).toBe("start-bar");
  });

  it("does NOT draw when claiming the finish bar (R1.3)", async () => {
    const response = await POST(
      request({
        action: "claim",
        barId: "finish-bar",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockDrawCalls).toHaveLength(0);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
      "game_ended",
    ]);
  });

  it("does NOT draw when unclaiming", async () => {
    mockActiveClaims = [{ id: "claim-a", team_id: "team-a" }];

    const response = await POST(
      request({ action: "unclaim", barId: "bar-a" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockDrawCalls).toHaveLength(0);
  });

  it("still commits the claim when the draw is rejected (already-drawn bar, exhausted deck) (R1.4, R1.5)", async () => {
    // A repeat encounter of an already-drawn bar: the engine rejects the draw.
    mockDrawResult = { ok: false, reason: "duplicate_bar_draw" };

    const response = await POST(
      request({
        action: "claim",
        barId: "bar-a",
        allMembersPresent: true,
        finishedDrinkCount: 1,
      }),
      params(),
    );

    // The claim and its score still commit; the rejected draw is benign.
    expect(response.status).toBe(200);
    expect(mockCommitted).toBe(true);
    expect(mockDrawCalls).toHaveLength(1);
    expect(mockAppendCalls.map((call) => call.type)).toEqual([
      "claim_recorded",
      "score_awarded",
    ]);
    // With no draw seq, the response falls back to the score event's seq.
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 2,
      result: { claimId: "claim-new" },
    });
  });
});
