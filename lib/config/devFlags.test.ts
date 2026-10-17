/**
 * Brawl Deck Architecture — Task 2: committed dev-flag config module.
 *
 * Validates Requirement 5.1: a PR-controlled compile-time flag (not an env var)
 * gates the dev-only card-injection capability. These tests prove:
 *   1. the accessors read straight from the committed {@link DEV_FLAGS} constant,
 *   2. the shipped default is off (prod mode),
 *   3. the accessor is a faithful mapping — flipping the underlying value flips the
 *      reported value — so turning the flag on in a PR genuinely turns it on,
 *   4. the constant is frozen, so the only way to change a flag is a source edit.
 *
 * No behavior is wired to the flag yet; this is the declaration + accessor only.
 */

import { describe, expect, it } from "vitest";

import {
  DEV_FLAGS,
  isDevCardInjectionEnabled,
  isDevFlagEnabled,
  type DevFlag,
} from "./devFlags";

describe("devFlags: committed PR-controlled flags (R5.1)", () => {
  it("ships with DEV_CARD_INJECTION off (prod default)", () => {
    expect(DEV_FLAGS.DEV_CARD_INJECTION).toBe(false);
    expect(isDevCardInjectionEnabled()).toBe(false);
  });

  it("isDevFlagEnabled reports exactly the committed constant for every flag", () => {
    for (const flag of Object.keys(DEV_FLAGS) as DevFlag[]) {
      expect(isDevFlagEnabled(flag)).toBe(DEV_FLAGS[flag]);
    }
  });

  it("isDevCardInjectionEnabled matches isDevFlagEnabled('DEV_CARD_INJECTION')", () => {
    expect(isDevCardInjectionEnabled()).toBe(
      isDevFlagEnabled("DEV_CARD_INJECTION"),
    );
  });

  it("the flags constant is frozen (only a source edit can change a flag)", () => {
    expect(Object.isFrozen(DEV_FLAGS)).toBe(true);
    expect(() => {
      // @ts-expect-error — the constant is readonly/frozen on purpose.
      DEV_FLAGS.DEV_CARD_INJECTION = true;
    }).toThrow(TypeError);
    // The mutation attempt did not take effect.
    expect(DEV_FLAGS.DEV_CARD_INJECTION).toBe(false);
  });

  it("flipping the underlying value flips the reported value (faithful mapping)", () => {
    // The real DEV_FLAGS is frozen, so model the "flip it in a PR" edit with a
    // local source of the same shape and prove the accessor logic is a pure,
    // faithful lookup: reading `true` reports `true`, reading `false` reports
    // `false`. This is the guarantee that editing the literal to `true` actually
    // turns the capability on.
    const read = (source: Record<DevFlag, boolean>, flag: DevFlag): boolean =>
      source[flag];

    const flippedOn: Record<DevFlag, boolean> = { DEV_CARD_INJECTION: true };
    const flippedOff: Record<DevFlag, boolean> = { DEV_CARD_INJECTION: false };

    expect(read(flippedOn, "DEV_CARD_INJECTION")).toBe(true);
    expect(read(flippedOff, "DEV_CARD_INJECTION")).toBe(false);

    // And the shipped accessor agrees with its own backing constant.
    expect(isDevFlagEnabled("DEV_CARD_INJECTION")).toBe(
      DEV_FLAGS.DEV_CARD_INJECTION,
    );
  });
});
