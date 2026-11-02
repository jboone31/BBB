/**
 * Casting-input validation for cards that require a caster-entered value
 * (framework-free, pure).
 *
 * Three v1 cards ask the casting team for a value when they play the card:
 * Art School Dropout (three ROYGBIV colors), Bird Guide (a duration in seconds),
 * and Different Tastes (a cuisine string). Every other card takes no caster input.
 * This module turns the untrusted raw body of a play request into a validated
 * {@link CastingParams} value, or an `invalid_input` rejection, so the card-play
 * planner and route share one definition of "well-formed input".
 *
 * Validation rules (card-behavior Requirements 6.1-6.4):
 * - colors: exactly three *distinct* ROYGBIV colors, matched case-insensitively,
 *   normalized to lowercase, with the caster's order preserved.
 * - duration_seconds: an integer from 0 to 300 inclusive.
 * - cuisine: a string of 1 to 60 characters after trimming surrounding whitespace.
 *
 * Anything that fails a card's rule, or that is malformed JSON shape, yields
 * `{ ok: false, error: "invalid_input" }`.
 */

import type { CardInput } from "./catalog";

/**
 * The seven ROYGBIV colors Art School Dropout draws from, in spectral order. This
 * tuple is the single source of truth for the color set and for the {@link Color}
 * type.
 */
export const ROYGBIV = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "indigo",
  "violet",
] as const;

/** A single ROYGBIV color, normalized to its lowercase spelling. */
export type Color = (typeof ROYGBIV)[number];

/**
 * A validated casting input, tagged by the kind of value the card needs. Cards
 * with no caster input resolve to `{ kind: "none" }`.
 */
export type CastingParams =
  | { readonly kind: "none" }
  | { readonly kind: "colors"; readonly colors: readonly [Color, Color, Color] }
  | { readonly kind: "duration_seconds"; readonly seconds: number }
  | { readonly kind: "cuisine"; readonly cuisine: string };

/** The result of validating a raw casting input against a card's input kind. */
export type CastingValidation =
  | { readonly ok: true; readonly params: CastingParams }
  | { readonly ok: false; readonly error: "invalid_input" };

const INVALID: CastingValidation = { ok: false, error: "invalid_input" };

const COLOR_LOOKUP: ReadonlyMap<string, Color> = new Map(
  ROYGBIV.map((color) => [color, color] as const),
);

/** Lowest valid Bird Guide duration, in seconds. */
const MIN_DURATION_SECONDS = 0;
/** Highest valid Bird Guide duration, in seconds. */
const MAX_DURATION_SECONDS = 300;
/** Longest valid Different Tastes cuisine, in characters after trimming. */
const MAX_CUISINE_LENGTH = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the three ROYGBIV colors for Art School Dropout.
 *
 * Accepts an array of exactly three strings that each name a ROYGBIV color
 * (case-insensitively) and are pairwise distinct. The returned colors are
 * lowercased but keep the caster's order.
 */
function validateColors(raw: unknown): CastingValidation {
  if (!isRecord(raw)) {
    return INVALID;
  }
  const { colors } = raw;
  if (!Array.isArray(colors) || colors.length !== 3) {
    return INVALID;
  }

  const normalized: Color[] = [];
  const seen = new Set<Color>();
  for (const entry of colors) {
    if (typeof entry !== "string") {
      return INVALID;
    }
    const color = COLOR_LOOKUP.get(entry.trim().toLowerCase());
    if (color === undefined || seen.has(color)) {
      return INVALID;
    }
    seen.add(color);
    normalized.push(color);
  }

  return {
    ok: true,
    params: {
      kind: "colors",
      colors: [normalized[0], normalized[1], normalized[2]],
    },
  };
}

/**
 * Validate the Bird Guide duration: an integer from 0 to 300 seconds inclusive.
 */
function validateDuration(raw: unknown): CastingValidation {
  if (!isRecord(raw)) {
    return INVALID;
  }
  const { seconds } = raw;
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < MIN_DURATION_SECONDS ||
    seconds > MAX_DURATION_SECONDS
  ) {
    return INVALID;
  }
  return { ok: true, params: { kind: "duration_seconds", seconds } };
}

/**
 * Validate the Different Tastes cuisine: a 1-60 character string after trimming.
 * The stored value is the trimmed form.
 */
function validateCuisine(raw: unknown): CastingValidation {
  if (!isRecord(raw)) {
    return INVALID;
  }
  const { cuisine } = raw;
  if (typeof cuisine !== "string") {
    return INVALID;
  }
  const trimmed = cuisine.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_CUISINE_LENGTH) {
    return INVALID;
  }
  return { ok: true, params: { kind: "cuisine", cuisine: trimmed } };
}

/**
 * Validate the raw casting input for a card against its declared input kind.
 *
 * Cards whose {@link CardInput} needs no caster value (`none`, `bar`,
 * `public_bar`) always succeed with `{ kind: "none" }`; the bar target itself is
 * validated elsewhere. Cards that need a value are checked against the rules in
 * this module's doc comment and reject with `invalid_input` on any violation.
 */
export function validateCastingInput(
  input: CardInput,
  raw: unknown,
): CastingValidation {
  switch (input) {
    case "colors":
      return validateColors(raw);
    case "duration_seconds":
      return validateDuration(raw);
    case "cuisine":
      return validateCuisine(raw);
    case "none":
    case "bar":
    case "public_bar":
      return { ok: true, params: { kind: "none" } };
    default: {
      // Exhaustiveness guard: a new CardInput kind must be handled explicitly.
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}
