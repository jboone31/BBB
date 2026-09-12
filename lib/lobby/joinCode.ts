/**
 * Join_Code generation and validation for the Game Setup & Lobby feature
 * (design §Components 1a; Requirements 1.4, 3.1, 3.3).
 *
 * A Join_Code is the short, shareable code a Player uses to locate and join a
 * Game (`games.join_code`). The requirements mandate a deliberate asymmetry:
 *
 *  - the service **generates** codes of 6–8 alphanumeric characters (R1.4), but
 *  - it **accepts** submitted codes of 6–12 alphanumeric characters (R3.1/R3.3),
 *
 * so every generated code is always an acceptable submission, and out-of-range
 * submissions are rejected on shape before any database lookup.
 *
 * This module is framework-free and performs no I/O: it decides code *shape* and
 * produces candidates only. The uniqueness constraint (R1.4: unique across
 * non-`ended` games) and the 5-attempt retry (R1.5) live in the create route,
 * which retries generation against the DB unique index.
 *
 * NOTE: This is the Task 1 scaffold — constants and signatures per the design.
 * The function bodies are implemented in Task 2.
 */

/**
 * Alphabet for generated codes: unambiguous uppercase alphanumerics.
 *
 * Visually ambiguous characters are omitted so codes are easy to read aloud and
 * type on a phone: no `0`/`O`, no `1`/`I`. Submitted-code validation is looser
 * (any alphanumeric) so a manual entry is never rejected for using an excluded
 * character — the generator simply never produces one.
 */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of a generated Join_Code, within R1.4's 6–8 range. */
export const GENERATED_CODE_LENGTH = 8;

/** Maximum attempts to generate a unique Join_Code before giving up (R1.5). */
export const MAX_CODE_GEN_ATTEMPTS = 5;

/**
 * Generate one candidate Join_Code (R1.4).
 *
 * Produces a {@link GENERATED_CODE_LENGTH}-character string drawn from
 * {@link JOIN_CODE_ALPHABET}. `rand` is injectable so tests can drive
 * deterministic streams; it defaults to `Math.random`.
 *
 * @param rand a source of numbers in `[0, 1)`; defaults to `Math.random`.
 * @returns a candidate Join_Code.
 */
export function generateJoinCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) {
    const raw = Math.floor(rand() * JOIN_CODE_ALPHABET.length);
    // Clamp defensively in case an injected `rand` returns exactly 1.0 (or a
    // value ≥ 1), so we never index past the end of the alphabet.
    const index = Math.min(Math.max(raw, 0), JOIN_CODE_ALPHABET.length - 1);
    code += JOIN_CODE_ALPHABET[index];
  }
  return code;
}

/**
 * R1.4: a *generated* code is 6–8 alphanumeric characters.
 *
 * @param code the code to check.
 * @returns true iff `code` is 6–8 characters, all alphanumeric.
 */
export function isValidGeneratedCode(code: string): boolean {
  return /^[A-Za-z0-9]{6,8}$/.test(code);
}

/**
 * R3.1/R3.3: a *submitted* join code is 6–12 alphanumeric characters (looser
 * than generated), evaluated after {@link normalizeSubmittedCode}.
 *
 * @param code the submitted code to check.
 * @returns true iff, after normalization, `code` is 6–12 alphanumeric chars.
 */
export function isValidSubmittedCode(code: string): boolean {
  const normalized = normalizeSubmittedCode(code);
  return /^[A-Za-z0-9]{6,12}$/.test(normalized);
}

/**
 * Normalize a submitted Join_Code: trim leading/trailing whitespace and
 * uppercase it, so casing and stray spaces never cause a valid code to miss.
 *
 * @param code the raw submitted code.
 * @returns the trimmed, uppercased code.
 */
export function normalizeSubmittedCode(code: string): string {
  return code.trim().toUpperCase();
}
