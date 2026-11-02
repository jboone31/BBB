/**
 * Lazy settle helper (`settleDueTransitions` in `lib/cards/behaviorStore.ts`) —
 * hermetic unit tests (task 6.8).
 *
 * These tests exercise the lazy Timer_Sweep step of the mutation pipeline
 * (design.md "Mutation pipeline" step 3; Requirements 19.9, 19.10) against an
 * in-memory fake {@link QueryRunner} that records every statement it is asked to
 * run, in the same fake-runner style as `behaviorStore.test.ts` /
 * `persistence.test.ts`. No live Postgres is required, so this runs in the
 * default hermetic suite; the live settle function (`bbb_settle_card_effects`)
 * is covered by the integration suite under `supabase/__tests__/integration`.
 *
 * Coverage:
 *   - settleDueTransitions issues `select bbb_settle_card_effects($1, true, $2)`
 *     with the passed gameId and the mutation's own nowIso (p_wait = true), and
 *     does so before it reads the last transition seq.
 *   - it returns the appended count from the settle function and the last
 *     transition seq from the max(seq) query (null when the game has none).
 *   - a thrown error from the query propagates to the caller (so the caller's
 *     transaction rolls back), rather than being swallowed (19.10).
 *
 * Requirements: 19.9, 19.10.
 */

import { describe, expect, it } from "vitest";

import type { QueryRunner, SqlRow } from "@/lib/events";

import { settleDueTransitions } from "./behaviorStore";

// ---------------------------------------------------------------------------
// Fake QueryRunner
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A fake {@link QueryRunner} that records every statement and returns a canned
 * result based on which of the two statements `settleDueTransitions` issues it
 * recognizes (matched by a stable SQL substring). It does not interpret SQL; it
 * just maps the settle call to an `appended` count and the max(seq) read to a
 * `last_seq` value, mirroring the fake-runner pattern in the sibling tests.
 */
class FakeRunner implements QueryRunner {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly appended: number,
    private readonly lastSeq: number | null,
  ) {}

  query(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: SqlRow[] }> {
    this.calls.push({ sql, params });
    if (sql.includes("bbb_settle_card_effects")) {
      return Promise.resolve({ rows: [{ appended: this.appended }] });
    }
    if (sql.includes("max(seq)")) {
      return Promise.resolve({ rows: [{ last_seq: this.lastSeq }] });
    }
    return Promise.resolve({ rows: [] });
  }
}

/** A fake runner whose first `query` throws, modelling a failed settle. */
class ThrowingRunner implements QueryRunner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly error: Error) {}

  query(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: SqlRow[] }> {
    this.calls.push({ sql, params });
    return Promise.reject(this.error);
  }
}

const GAME_ID = "11111111-1111-1111-1111-111111111111";
const NOW_ISO = "2024-05-01T12:30:00.000Z";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settleDueTransitions", () => {
  it("calls bbb_settle_card_effects with the gameId and the mutation's now, p_wait = true, before reading the last seq", async () => {
    const runner = new FakeRunner(0, null);

    await settleDueTransitions(runner, GAME_ID, NOW_ISO);

    // Exactly two statements, in order: settle first, then the max(seq) read.
    expect(runner.calls).toHaveLength(2);

    const [settle, seqRead] = runner.calls;
    expect(settle.sql).toContain("bbb_settle_card_effects");
    // $1 = gameId, $2 = p_wait (true), $3 = nowIso (the mutation's own now).
    expect(settle.params).toEqual([GAME_ID, NOW_ISO]);
    // p_wait is baked into the SQL as the literal `true`, not a parameter.
    expect(settle.sql).toContain("true");

    // The seq read happens after the settle so it observes any appended rows.
    expect(seqRead.sql).toContain("max(seq)");
    expect(seqRead.params).toEqual([GAME_ID]);
  });

  it("returns the appended count from the function and the last transition seq from the max(seq) query", async () => {
    const runner = new FakeRunner(3, 42);

    const outcome = await settleDueTransitions(runner, GAME_ID, NOW_ISO);

    expect(outcome).toEqual({ appended: 3, lastTransitionSeq: 42 });
  });

  it("reports lastTransitionSeq = null when the game has no transition events", async () => {
    const runner = new FakeRunner(0, null);

    const outcome = await settleDueTransitions(runner, GAME_ID, NOW_ISO);

    expect(outcome).toEqual({ appended: 0, lastTransitionSeq: null });
  });

  it("propagates a thrown query error so the caller's transaction rolls back", async () => {
    const boom = new Error("settle failed");
    const runner = new ThrowingRunner(boom);

    await expect(settleDueTransitions(runner, GAME_ID, NOW_ISO)).rejects.toBe(
      boom,
    );

    // The settle was attempted; the error was not swallowed.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].sql).toContain("bbb_settle_card_effects");
  });
});
