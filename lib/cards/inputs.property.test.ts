import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { ROYGBIV, validateCastingInput, type Color } from "./inputs";

/**
 * Feature: card-behavior, Property 10: Casting input validation
 *
 * `validateCastingInput(input, raw)` turns an untrusted raw body into a
 * validated `CastingParams`, or an `invalid_input` rejection, so the card-play
 * planner and route share one definition of "well-formed input":
 *
 *   - colors ("colors"): accepts exactly three *distinct* ROYGBIV colors,
 *     matched case-insensitively, normalized to lowercase, with the caster's
 *     order preserved. Rejects wrong counts, duplicates, and non-ROYGBIV words.
 *   - duration_seconds ("duration_seconds"): accepts integers in [0, 300] and
 *     rejects anything out of range or non-integer.
 *   - cuisine ("cuisine"): accepts a 1-60 character string after trimming and
 *     rejects empty, whitespace-only, and over-60-character values.
 *   - no-input kinds ("none", "bar", "public_bar"): always succeed with
 *     `{ kind: "none" }` regardless of the raw body.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

/** A single ROYGBIV color in its canonical lowercase spelling. */
const colorArb: fc.Arbitrary<Color> = fc.constantFrom(...ROYGBIV);

/** Re-case a string so matching must be case-insensitive to succeed. */
function randomCase(word: string, bits: boolean[]): string {
  return word
    .split("")
    .map((ch, i) => (bits[i % bits.length] ? ch.toUpperCase() : ch))
    .join("");
}

/** Whitespace padding that must be tolerated around a single color token. */
const padding = fc.constantFrom("", " ", "  ", "\t", "\n ");

describe("validateCastingInput — Casting input validation (Property 10)", () => {
  describe("colors (Art School Dropout)", () => {
    it("accepts exactly three distinct ROYGBIV colors, normalized and order-preserved", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(colorArb, { minLength: 3, maxLength: 3 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
          padding,
          padding,
          (colors, caseBits, left, right) => {
            // Present each color in mixed case with surrounding whitespace; a
            // correct validator lowercases and trims without reordering.
            const raw = {
              colors: colors.map(
                (c) => `${left}${randomCase(c, caseBits)}${right}`,
              ),
            };
            const result = validateCastingInput("colors", raw);
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.params.kind).toBe("colors");
              if (result.params.kind === "colors") {
                // Order preserved and each entry is the canonical lowercase form.
                expect(result.params.colors).toEqual(colors);
              }
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    it("rejects the wrong number of colors", () => {
      fc.assert(
        fc.property(
          fc
            .uniqueArray(colorArb, { minLength: 0, maxLength: 7 })
            .filter((xs) => xs.length !== 3),
          (colors) => {
            expect(validateCastingInput("colors", { colors }).ok).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("rejects three colors when any two are duplicates", () => {
      fc.assert(
        fc.property(
          colorArb,
          colorArb,
          // Position of the duplicated color among the three slots.
          fc.integer({ min: 0, max: 2 }),
          (dup, other, slot) => {
            // Build a 3-element array that contains `dup` at least twice.
            const colors: Color[] = [dup, dup, other];
            // Rotate so the duplicate pair sits in different positions.
            const rotated = colors
              .slice(slot)
              .concat(colors.slice(0, slot)) as Color[];
            // Guard: ensure it truly has a duplicate (always true here).
            expect(new Set(rotated).size).toBeLessThan(3);
            expect(validateCastingInput("colors", { colors: rotated }).ok).toBe(
              false,
            );
          },
        ),
        { numRuns: 200 },
      );
    });

    it("rejects any word that is not a ROYGBIV color", () => {
      const nonRoygbiv = fc
        .string({ minLength: 1, maxLength: 12 })
        .filter(
          (s) =>
            !(ROYGBIV as readonly string[]).includes(s.trim().toLowerCase()),
        );
      fc.assert(
        fc.property(
          fc.uniqueArray(colorArb, { minLength: 2, maxLength: 2 }),
          nonRoygbiv,
          (twoColors, bad) => {
            const raw = { colors: [twoColors[0], twoColors[1], bad] };
            expect(validateCastingInput("colors", raw).ok).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("rejects non-string color entries and non-array color bodies", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant({ colors: [1, 2, 3] }),
            fc.constant({ colors: "red,green,blue" }),
            fc.constant({ colors: null }),
            fc.constant({}),
            fc.constant(null),
            fc.constant([]),
            fc.constant("red"),
          ),
          (raw) => {
            expect(validateCastingInput("colors", raw).ok).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("duration_seconds (Bird Guide)", () => {
    it("accepts every integer in [0, 300]", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 300 }), (seconds) => {
          const result = validateCastingInput("duration_seconds", { seconds });
          expect(result.ok).toBe(true);
          if (result.ok && result.params.kind === "duration_seconds") {
            expect(result.params.seconds).toBe(seconds);
          }
        }),
        { numRuns: 301 },
      );
    });

    it("rejects integers outside [0, 300]", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer({ min: -1_000_000, max: -1 }),
            fc.integer({ min: 301, max: 1_000_000 }),
          ),
          (seconds) => {
            expect(
              validateCastingInput("duration_seconds", { seconds }).ok,
            ).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("rejects non-integer and non-number durations", () => {
      const nonInteger = fc
        .float({ noNaN: true })
        .filter((n) => !Number.isInteger(n));
      fc.assert(
        fc.property(
          fc.oneof(
            nonInteger,
            fc.constant(Number.NaN),
            fc.constant(Number.POSITIVE_INFINITY),
            fc.constant(150.5),
          ),
          (seconds) => {
            expect(
              validateCastingInput("duration_seconds", { seconds }).ok,
            ).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("rejects durations of the wrong shape or type", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant({ seconds: "60" }),
            fc.constant({ seconds: null }),
            fc.constant({}),
            fc.constant(null),
            fc.constant(60),
          ),
          (raw) => {
            expect(validateCastingInput("duration_seconds", raw).ok).toBe(
              false,
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("cuisine (Different Tastes)", () => {
    it("accepts 1-60 characters after trimming and stores the trimmed form", () => {
      fc.assert(
        fc.property(
          // A core of 1-60 non-whitespace-bounded chars, then pad both sides.
          fc
            .string({ minLength: 1, maxLength: 60 })
            .map((s) => s.trim())
            .filter((s) => s.length >= 1 && s.length <= 60),
          padding,
          padding,
          (core, left, right) => {
            const raw = { cuisine: `${left}${core}${right}` };
            const result = validateCastingInput("cuisine", raw);
            expect(result.ok).toBe(true);
            if (result.ok && result.params.kind === "cuisine") {
              expect(result.params.cuisine).toBe(core);
              expect(result.params.cuisine.length).toBeGreaterThanOrEqual(1);
              expect(result.params.cuisine.length).toBeLessThanOrEqual(60);
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    it("rejects empty and whitespace-only cuisines", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(""),
            fc.stringMatching(/^[ \t\n\r]+$/),
            fc.constant("   "),
            fc.constant("\t\n"),
          ),
          (cuisine) => {
            expect(validateCastingInput("cuisine", { cuisine }).ok).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("rejects cuisines longer than 60 characters after trimming", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 61, max: 400 }),
          padding,
          padding,
          (length, left, right) => {
            const core = "x".repeat(length);
            const raw = { cuisine: `${left}${core}${right}` };
            expect(validateCastingInput("cuisine", raw).ok).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("rejects cuisines of the wrong type or shape", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant({ cuisine: 123 }),
            fc.constant({ cuisine: null }),
            fc.constant({ cuisine: ["italian"] }),
            fc.constant({}),
            fc.constant(null),
            fc.constant("italian"),
          ),
          (raw) => {
            expect(validateCastingInput("cuisine", raw).ok).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("no-input kinds (none / bar / public_bar)", () => {
    it('always succeeds with { kind: "none" } regardless of the raw body', () => {
      fc.assert(
        fc.property(
          fc.constantFrom("none", "bar", "public_bar"),
          fc.anything(),
          (input, raw) => {
            const result = validateCastingInput(
              input as "none" | "bar" | "public_bar",
              raw,
            );
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.params.kind).toBe("none");
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
