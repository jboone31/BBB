/**
 * Settle_Nudge route tests (card-behavior Task 12.4; design.md "Timer
 * settlement" and the `POST /effects/settle` row).
 *
 *   - `missing_session` / `not_member` write nothing and never call
 *     `bbb_settle_card_effects` (Req 20.8 via 20.5c contract);
 *   - a member call returns `appended`, `seq`, and `serverNow` (Req 20.5b,
 *     20.5c);
 *   - any thrown failure maps to `unavailable` (Req 20.9).
 *
 * Hermetic: a small fake {@link QueryRunner} answers the route's SQL and
 * `@/lib/db/server`'s `withTransaction` is mocked to hand it over (Req 24.2).
 *
 * Requirements: 20.5b, 20.5c, 20.9, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

const GAME_ID = "11111111-1111-4111-8111-111111111111";

interface FakeOptions {
  member?: boolean;
  appended?: number;
  serverNow?: Date | string;
  maxSeq?: number | string | null;
  failOn?: "settle" | "now" | "seq";
}

class FakeSettleDb {
  readonly sqlCalls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(private readonly options: FakeOptions = {}) {}

  get settleCalls(): { sql: string; params: readonly unknown[] }[] {
    return this.sqlCalls.filter((c) =>
      c.sql.includes("bbb_settle_card_effects"),
    );
  }

  readonly runner: QueryRunner = {
    query: async (sql, params = []) => {
      this.sqlCalls.push({ sql, params });
      const o = this.options;
      if (sql.includes("bbb_settle_card_effects")) {
        if (o.failOn === "settle") throw new Error("settle failed");
        return { rows: [{ appended: o.appended ?? 0 }] };
      }
      if (sql.includes("clock_timestamp()")) {
        if (o.failOn === "now") throw new Error("clock failed");
        return {
          rows: [
            { server_now: o.serverNow ?? new Date("2025-01-01T00:00:00Z") },
          ],
        };
      }
      if (sql.includes("max(seq)")) {
        if (o.failOn === "seq") throw new Error("seq failed");
        return { rows: [{ seq: o.maxSeq === undefined ? 0 : o.maxSeq }] };
      }
      if (sql.includes("for update")) {
        // assertMember's membership query.
        return { rows: o.member === false ? [] : [{ id: GAME_ID }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

let db: FakeSettleDb;
let transactionCalls = 0;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(
    fn: (tx: QueryRunner) => Promise<T>,
  ): Promise<T> => {
    transactionCalls += 1;
    return fn(db.runner);
  },
}));

import { POST } from "./route";

function request(sessionId: string | null = "session-a"): Request {
  const headers: Record<string, string> = {};
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request(`http://test/api/games/${GAME_ID}/effects/settle`, {
    method: "POST",
    headers,
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: GAME_ID }) };
}

beforeEach(() => {
  db = new FakeSettleDb();
  transactionCalls = 0;
});

describe("POST /effects/settle — write-free rejections", () => {
  it("rejects a missing session (401) without opening a transaction or settling", async () => {
    const response = await POST(request(null), params());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "missing_session",
    });
    expect(transactionCalls).toBe(0);
    expect(db.sqlCalls).toHaveLength(0);
  });

  it("rejects a blank session header the same way", async () => {
    const response = await POST(request("   "), params());
    expect(response.status).toBe(401);
    expect(db.settleCalls).toHaveLength(0);
  });

  it("rejects a non-member (403) after the membership check and never settles", async () => {
    db = new FakeSettleDb({ member: false });
    const response = await POST(request(), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "not_member",
    });
    expect(db.sqlCalls).toHaveLength(1);
    expect(db.settleCalls).toHaveLength(0);
  });
});

describe("POST /effects/settle — member call", () => {
  it("settles this game and returns appended, seq, and serverNow", async () => {
    db = new FakeSettleDb({
      appended: 2,
      serverNow: new Date("2025-06-01T12:34:56.789Z"),
      maxSeq: "42",
    });
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 42,
      result: { appended: 2, serverNow: "2025-06-01T12:34:56.789Z" },
    });

    // Membership checked before the settle; settle scoped to this game, p_now null.
    expect(db.settleCalls).toHaveLength(1);
    expect(db.settleCalls[0].sql).toContain(
      "bbb_settle_card_effects($1, true)",
    );
    expect(db.settleCalls[0].params).toEqual([GAME_ID]);
    const settleIdx = db.sqlCalls.indexOf(db.settleCalls[0]);
    expect(settleIdx).toBe(1);
    expect(transactionCalls).toBe(1);
  });

  it("returns appended 0 and the current high-water seq when nothing was due", async () => {
    db = new FakeSettleDb({
      appended: 0,
      serverNow: "2025-06-01T00:00:00Z",
      maxSeq: 7,
    });
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: true,
      seq: 7,
      result: { appended: 0, serverNow: "2025-06-01T00:00:00.000Z" },
    });
  });

  it("reports seq 0 when the game has no events", async () => {
    db = new FakeSettleDb({ maxSeq: null });
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seq: number };
    expect(body.seq).toBe(0);
  });
});

describe("POST /effects/settle — failures", () => {
  it.each(["settle", "now", "seq"] as const)(
    "maps a thrown %s query to unavailable (503)",
    async (failOn) => {
      db = new FakeSettleDb({ failOn });
      const response = await POST(request(), params());
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        applied: false,
        error: "unavailable",
      });
    },
  );
});
