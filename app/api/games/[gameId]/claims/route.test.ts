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
});
