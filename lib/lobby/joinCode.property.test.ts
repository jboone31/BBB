import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  generateJoinCode,
  isValidGeneratedCode,
  isValidSubmittedCode,
  normalizeSubmittedCode,
  JOIN_CODE_ALPHABET,
  GENERATED_CODE_LENGTH,
} from "./joinCode";

/**
 * Feature: game-setup-lobby, Property 2: Generated Join_Codes have valid,
 * acceptable shape.
 *
 * For any random-number stream, `generateJoinCode` produces a string of 6 to 8
 * characters all drawn from `JOIN_CODE_ALPHABET`, and that string is accepted
 * by both `isValidGeneratedCode` (6–8 alphanumeric) and `isValidSubmittedCode`
 * (6–12 alphanumeric). Every generated code is therefore always an acceptable
 * submission.
 *
 * Validates: Requirements 1.4
 */
describe("generateJoinCode — Generated Join_Codes have valid, acceptable shape (Property 2)", () => {
  const alphabet = new Set(JOIN_CODE_ALPHABET.split(""));

  it("produces a 6–8 char code from the alphabet accepted by both validators", () => {
    fc.assert(
      fc.property(
        // An arbitrary RNG stream: a non-empty list of numbers in [0, 1). The
        // generator draws GENERATED_CODE_LENGTH values; cycling the list keeps
        // the stream deterministic and long enough regardless of its length.
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: 1,
          maxLength: 32,
        }),
        (stream) => {
          let i = 0;
          const rand = () => stream[i++ % stream.length];

          const code = generateJoinCode(rand);

          // 6–8 characters (generated length sits within R1.4's range).
          expect(code.length).toBeGreaterThanOrEqual(6);
          expect(code.length).toBeLessThanOrEqual(8);
          expect(code.length).toBe(GENERATED_CODE_LENGTH);

          // Every character is drawn from the join-code alphabet.
          for (const ch of code) {
            expect(alphabet.has(ch)).toBe(true);
          }

          // Accepted by both the generated- and submitted-code validators, so a
          // generated code is always an acceptable submission.
          expect(isValidGeneratedCode(code)).toBe(true);
          expect(isValidSubmittedCode(code)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("stays in range even when the RNG returns out-of-bound values", () => {
    // Defensive: values >= 1 or < 0 must never index past the alphabet.
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 2, noNaN: true }), {
          minLength: 1,
          maxLength: 32,
        }),
        (stream) => {
          let i = 0;
          const rand = () => stream[i++ % stream.length];

          const code = generateJoinCode(rand);

          expect(isValidGeneratedCode(code)).toBe(true);
          for (const ch of code) {
            expect(alphabet.has(ch)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: game-setup-lobby, Property 3: Submitted Join_Code format acceptance.
 *
 * For any string, `isValidSubmittedCode` accepts it if and only if, after
 * normalization (trim + upcase), its length is between 6 and 12 inclusive and
 * every character is alphanumeric; any other string (empty, too short, too
 * long, containing non-alphanumerics) is rejected.
 *
 * Validates: Requirements 3.3
 */
describe("isValidSubmittedCode — Submitted Join_Code format acceptance (Property 3)", () => {
  // Independent oracle for the acceptance predicate: normalize, then check the
  // length window and alphanumeric-only shape without reusing the impl regex.
  const oracleAccepts = (raw: string): boolean => {
    const normalized = raw.trim().toUpperCase();
    const len = normalized.length;
    if (len < 6 || len > 12) return false;
    for (const ch of normalized) {
      const isAlnum =
        (ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        (ch >= "0" && ch <= "9");
      if (!isAlnum) return false;
    }
    return true;
  };

  it("accepts iff normalized length is 6–12 and all alphanumeric (arbitrary strings)", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(isValidSubmittedCode(raw)).toBe(oracleAccepts(raw));
      }),
      { numRuns: 100 },
    );
  });

  it("agrees with the oracle on strings biased toward alphanumerics and whitespace", () => {
    // A charset that stresses the boundaries: alphanumerics, whitespace, and a
    // few non-alphanumerics, so many samples land near the 6/12 length window.
    const biasedChar = fc.constantFrom(
      ..."ABCabc0129".split(""),
      " ",
      "\t",
      "\n",
      "-",
      "_",
      "!",
    );
    fc.assert(
      fc.property(
        fc
          .array(biasedChar, { minLength: 0, maxLength: 16 })
          .map((cs) => cs.join("")),
        (raw) => {
          const accepted = isValidSubmittedCode(raw);
          expect(accepted).toBe(oracleAccepts(raw));

          // When accepted, the normalized form is concretely in-window/alnum.
          if (accepted) {
            const normalized = normalizeSubmittedCode(raw);
            expect(normalized.length).toBeGreaterThanOrEqual(6);
            expect(normalized.length).toBeLessThanOrEqual(12);
            expect(/^[A-Z0-9]+$/.test(normalized)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
