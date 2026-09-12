import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MAX_DISPLAY_NAME,
  MIN_DISPLAY_NAME,
  validateDisplayName,
} from "./displayName";

/**
 * Feature: game-setup-lobby, Property 4: Display-name validation and trimming
 *
 * For any raw string, `validateDisplayName` accepts it if and only if the
 * trimmed string has length between `MIN_DISPLAY_NAME` (1) and
 * `MAX_DISPLAY_NAME` (40) inclusive. On acceptance it returns exactly the
 * trimmed value; empty, all-whitespace, and over-40 inputs are rejected with an
 * `invalid_display_name` result.
 *
 * Validates: Requirements 3.5, 3.6
 */
describe("validateDisplayName — Display-name validation and trimming (Property 4)", () => {
  it("accepts iff the trimmed length is 1..40, returning the trimmed value", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const trimmed = raw.trim();
        const shouldAccept =
          trimmed.length >= MIN_DISPLAY_NAME &&
          trimmed.length <= MAX_DISPLAY_NAME;

        const result = validateDisplayName(raw);

        expect(result.ok).toBe(shouldAccept);
        if (result.ok) {
          expect(result.value).toBe(trimmed);
        } else {
          expect(result.reason).toBe("invalid_display_name");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("rejects empty and all-whitespace inputs", () => {
    fc.assert(
      fc.property(
        // Strings composed solely of whitespace characters (possibly empty).
        fc.string({
          unit: fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"),
          minLength: 0,
          maxLength: 20,
        }),
        (blank) => {
          const result = validateDisplayName(blank);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("invalid_display_name");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts a padded name whose trimmed core is 1..40 chars, and rejects when the core exceeds 40", () => {
    fc.assert(
      fc.property(
        // A non-whitespace core of a bounded length, padded with surrounding
        // whitespace. The core length decides acceptance regardless of padding.
        fc.integer({ min: 1, max: 60 }).chain((coreLen) =>
          fc.record({
            core: fc.constant("x".repeat(coreLen)),
            pad: fc.string({
              unit: fc.constantFrom(" ", "\t", "\n"),
              minLength: 0,
              maxLength: 5,
            }),
          }),
        ),
        ({ core, pad }) => {
          const raw = `${pad}${core}${pad}`;
          const result = validateDisplayName(raw);
          const shouldAccept = core.length <= MAX_DISPLAY_NAME;

          expect(result.ok).toBe(shouldAccept);
          if (result.ok) {
            expect(result.value).toBe(core);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
