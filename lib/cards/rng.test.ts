import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CARD_SLUGS } from "./catalog";
import { hashStringToSeed, mulberry32, seededShuffle } from "./rng";

describe("seeded RNG", () => {
  it("hashStringToSeed is deterministic and order-sensitive", () => {
    expect(hashStringToSeed("a:b")).toBe(hashStringToSeed("a:b"));
    expect(hashStringToSeed("a:b")).not.toBe(hashStringToSeed("b:a"));
  });

  it("mulberry32 yields a reproducible sequence in [0, 1)", () => {
    const first = mulberry32(12345);
    const second = mulberry32(12345);
    for (let i = 0; i < 100; i += 1) {
      const value = first();
      expect(value).toBe(second());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("seededShuffle is a pure permutation (same length, same multiset)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (seed) => {
        const input = [...CARD_SLUGS];
        const shuffled = seededShuffle(input, seed);
        // Non-mutating: the input is untouched.
        expect(input).toEqual([...CARD_SLUGS]);
        // A permutation: same length and same multiset of slugs.
        expect(shuffled).toHaveLength(input.length);
        expect([...shuffled].sort()).toEqual([...input].sort());
      }),
    );
  });

  it("the same seed reproduces the same order; different seeds usually differ", () => {
    const a = seededShuffle(CARD_SLUGS, "game-1:team-a");
    const aAgain = seededShuffle(CARD_SLUGS, "game-1:team-a");
    const b = seededShuffle(CARD_SLUGS, "game-1:team-b");
    expect(a).toEqual(aAgain);
    // Two different teams in the same game get different orders (the 23-card
    // space makes an accidental identical permutation astronomically unlikely).
    expect(a).not.toEqual(b);
  });
});
