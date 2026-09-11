import { describe, expect, it } from "vitest";

import {
  isValidBarDesignation,
  validateBarDesignation,
  type BarDesignation,
} from "./index";

/**
 * Unit / example tests for the start/finish bar designation rule (Req 3.7).
 *
 * These mirror the `games` table in
 * `supabase/migrations/0001_core_game_schema.sql`:
 *  - single-valued `start_bar_id` / `finish_bar_id` columns (exactly one slot
 *    each per game); and
 *  - the `games_start_finish_differ` CHECK: reject only when both are set and
 *    equal, allow NULLs (undesignated).
 *
 * Validates: Requirements 3.7
 */

const START = "bar-start";
const FINISH = "bar-finish";

describe("validateBarDesignation — start/finish designation (Req 3.7)", () => {
  it("rejects a finish bar equal to the start bar (both set and equal)", () => {
    const result = validateBarDesignation({
      startBarId: START,
      finishBarId: START,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("finish_equals_start");
    }
    expect(
      isValidBarDesignation({ startBarId: START, finishBarId: START }),
    ).toBe(false);
  });

  it("accepts distinct start and finish bars", () => {
    const result = validateBarDesignation({
      startBarId: START,
      finishBarId: FINISH,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.startBarId).toBe(START);
      expect(result.finishBarId).toBe(FINISH);
    }
    expect(
      isValidBarDesignation({ startBarId: START, finishBarId: FINISH }),
    ).toBe(true);
  });

  it("allows an undesignated game (both null/undefined)", () => {
    const bothNull = validateBarDesignation({
      startBarId: null,
      finishBarId: null,
    });
    expect(bothNull.ok).toBe(true);
    if (bothNull.ok) {
      expect(bothNull.startBarId).toBeNull();
      expect(bothNull.finishBarId).toBeNull();
    }

    // undefined is normalized to null (undesignated).
    const bothUndefined = validateBarDesignation({
      startBarId: undefined,
      finishBarId: undefined,
    });
    expect(bothUndefined.ok).toBe(true);
    if (bothUndefined.ok) {
      expect(bothUndefined.startBarId).toBeNull();
      expect(bothUndefined.finishBarId).toBeNull();
    }
  });

  it("allows a partial designation where only one role is set", () => {
    // Only start designated: finish is still undesignated, so it is allowed even
    // if start happens to equal the (absent) finish slot.
    const onlyStart = validateBarDesignation({
      startBarId: START,
      finishBarId: null,
    });
    expect(onlyStart.ok).toBe(true);
    if (onlyStart.ok) {
      expect(onlyStart.startBarId).toBe(START);
      expect(onlyStart.finishBarId).toBeNull();
    }

    // Only finish designated.
    const onlyFinish = validateBarDesignation({
      startBarId: undefined,
      finishBarId: FINISH,
    });
    expect(onlyFinish.ok).toBe(true);
    if (onlyFinish.ok) {
      expect(onlyFinish.startBarId).toBeNull();
      expect(onlyFinish.finishBarId).toBe(FINISH);
    }
  });

  it("models exactly one start and exactly one finish (single-valued fields)", () => {
    // The designation type has exactly one slot for the start bar and one for
    // the finish bar — there is no way to express two starts or two finishes,
    // which is how "exactly one start and exactly one finish per game" (Req 3.7)
    // is enforced structurally. A fully-designated, valid game therefore has
    // precisely one start id and one finish id.
    const designation: BarDesignation = {
      startBarId: START,
      finishBarId: FINISH,
    };
    const result = validateBarDesignation(designation);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Exactly one designated start and exactly one designated finish.
      const designatedStarts = [result.startBarId].filter((id) => id !== null);
      const designatedFinishes = [result.finishBarId].filter(
        (id) => id !== null,
      );
      expect(designatedStarts).toEqual([START]);
      expect(designatedFinishes).toEqual([FINISH]);
      expect(designatedStarts).toHaveLength(1);
      expect(designatedFinishes).toHaveLength(1);
    }
  });
});
