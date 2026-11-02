/**
 * Cron_Route tests (card-behavior Task 12.4; design.md "Settlement").
 *
 *   - missing `CRON_SECRET` config fails closed with 500 and never settles
 *     (Req 20.5a);
 *   - a wrong or missing bearer is refused 401 and never settles (Req 20.5a);
 *   - a valid bearer calls `bbb_settle_card_effects(null, false)` and returns
 *     200 `{ ok: true, appended }`;
 *   - a thrown failure returns 503 `{ ok: false, error: "unavailable" }`
 *     (Req 20.9).
 *
 * Hermetic: a fake {@link QueryRunner} answers the settle SQL and
 * `@/lib/db/server`'s `withTransaction` is mocked to hand it over (Req 24.2).
 *
 * Requirements: 20.5a, 20.9, 24.2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";

const SECRET = "test-cron-secret";

let sqlCalls: { sql: string; params: readonly unknown[] }[] = [];
let transactionCalls = 0;
let appendedResult: unknown = 0;
let fail = false;

const runner: QueryRunner = {
  query: async (sql, params = []) => {
    sqlCalls.push({ sql, params });
    if (fail) throw new Error("db down");
    if (sql.includes("bbb_settle_card_effects")) {
      return { rows: [{ appended: appendedResult }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
};

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(
    fn: (tx: QueryRunner) => Promise<T>,
  ): Promise<T> => {
    transactionCalls += 1;
    return fn(runner);
  },
}));

import { GET, POST } from "./route";

function request(
  method: "GET" | "POST",
  authorization: string | null,
): Request {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request("http://test/api/cron/card-effects", { method, headers });
}

const handlers = { GET, POST } as const;

beforeEach(() => {
  sqlCalls = [];
  transactionCalls = 0;
  appendedResult = 0;
  fail = false;
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["GET", "POST"] as const)(
  "%s /api/cron/card-effects",
  (method) => {
    const handler = handlers[method];

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["whitespace", "   "],
    ])(
      "fails closed with 500 when CRON_SECRET is %s, without settling",
      async (_label, value) => {
        vi.stubEnv("CRON_SECRET", value);
        const response = await handler(request(method, `Bearer ${SECRET}`));
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: "CRON_SECRET is not configured",
        });
        expect(transactionCalls).toBe(0);
        expect(sqlCalls).toHaveLength(0);
      },
    );

    it.each([
      ["missing", null],
      ["wrong", "Bearer not-the-secret"],
      ["non-bearer", SECRET],
      ["empty bearer", "Bearer "],
    ])(
      "refuses a %s authorization with 401, without settling",
      async (_label, authorization) => {
        const response = await handler(request(method, authorization));
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: "unauthorized",
        });
        expect(transactionCalls).toBe(0);
        expect(sqlCalls).toHaveLength(0);
      },
    );

    it("settles all games with bbb_settle_card_effects(null, false) on a valid bearer", async () => {
      appendedResult = "3";
      const response = await handler(request(method, `Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, appended: 3 });
      expect(transactionCalls).toBe(1);
      expect(sqlCalls).toHaveLength(1);
      expect(sqlCalls[0].sql).toContain("bbb_settle_card_effects(null, false)");
      expect(sqlCalls[0].params).toEqual([]);
    });

    it("returns 503 unavailable when the settle throws", async () => {
      fail = true;
      const response = await handler(request(method, `Bearer ${SECRET}`));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "unavailable",
      });
    });
  },
);
