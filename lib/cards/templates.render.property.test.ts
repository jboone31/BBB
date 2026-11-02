import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  renderTemplate,
  templatePlaceholders,
  type TemplateValues,
} from "./templates";
import type { TemplatePlaceholder } from "./cardText";

/**
 * Feature: card-behavior, Property 2: Template rendering fills every value
 * exactly once.
 *
 * For any template built from literal text and `{Placeholder}` tokens and any
 * partial map of values:
 *
 *   - every placeholder for which a value is provided is substituted exactly
 *     once in a single left-to-right pass;
 *   - a provided value that itself contains a brace token (e.g. a bar literally
 *     named `{Bar}`) is NOT re-expanded;
 *   - unknown or unprovided placeholders are left in place verbatim, braces and
 *     all;
 *   - the set of placeholders actually substituted equals
 *     `templatePlaceholders(template) ∩ keys(values)`.
 *
 * Validates: Requirements 1.3, 3.5, 9.6
 */

// ---------------------------------------------------------------------------
// The allowed placeholder set, kept independent of the module under test so the
// assertions are real checks, not tautologies.
// ---------------------------------------------------------------------------

const ALL_PLACEHOLDERS: readonly TemplatePlaceholder[] = [
  "Caster",
  "Target",
  "CARD",
  "Bar",
  "color1",
  "color2",
  "color3",
  "duration",
  "cuisine",
  "startTime",
  "endTime",
];

// A "{token}" that is NOT one of the allowed placeholders, so it exercises the
// unknown-placeholder branch (left in place verbatim).
const unknownTokenArb: fc.Arbitrary<string> = fc
  .constantFrom("Nope", "unknown", "x", "Caster ", " Target", "BAR")
  .map((name) => `{${name}}`);

// ---------------------------------------------------------------------------
// Generators.
//
// A template is a sequence of segments. Each segment is one of:
//   - literal text with no braces,
//   - a known `{Placeholder}` token,
//   - an unknown `{token}` (left verbatim).
// Joining the segments yields a template with no accidental brace collisions,
// because literal text is brace-free.
// ---------------------------------------------------------------------------

/** Literal text containing no brace characters. */
const literalArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 8 })
  .map((s) => s.replace(/[{}]/g, ""));

/** A single `{Placeholder}` token for an allowed placeholder. */
const knownTokenArb: fc.Arbitrary<string> = fc
  .constantFrom(...ALL_PLACEHOLDERS)
  .map((name) => `{${name}}`);

const segmentArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: literalArb },
  { weight: 3, arbitrary: knownTokenArb },
  { weight: 1, arbitrary: unknownTokenArb },
);

const templateArb: fc.Arbitrary<string> = fc
  .array(segmentArb, { minLength: 0, maxLength: 12 })
  .map((segments) => segments.join(""));

/**
 * A value string. Deliberately biased to include brace tokens (including ones
 * that look exactly like real placeholders such as `{Bar}`) so we exercise the
 * "no re-expansion" guarantee.
 */
const valueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.string({ minLength: 0, maxLength: 10 }) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.string({ maxLength: 4 }),
        fc.constantFrom(...ALL_PLACEHOLDERS, "Nope", "x"),
        fc.string({ maxLength: 4 }),
      )
      .map(([pre, token, post]) => `${pre}{${token}}${post}`),
  },
);

/** A partial values map: each allowed placeholder is present with some prob. */
const valuesArb: fc.Arbitrary<TemplateValues> = fc
  .tuple(...ALL_PLACEHOLDERS.map(() => fc.option(valueArb, { nil: undefined })))
  .map((chosen) => {
    const values: TemplateValues = {};
    ALL_PLACEHOLDERS.forEach((name, i) => {
      const v = chosen[i];
      if (v !== undefined) values[name] = v;
    });
    return values;
  });

// ---------------------------------------------------------------------------
// An independent oracle: a single left-to-right pass over the template,
// splicing in provided values and copying everything else (including unknown
// and unprovided tokens) verbatim. Crucially it never looks inside a
// substituted value, so it models the "no re-expansion" guarantee.
// ---------------------------------------------------------------------------

interface OracleResult {
  readonly output: string;
  /** Placeholder names substituted, in order, with duplicates kept. */
  readonly substituted: string[];
}

function renderOracle(template: string, values: TemplateValues): OracleResult {
  const pattern = /\{([^{}]+)\}/g;
  let output = "";
  let lastIndex = 0;
  const substituted: string[] = [];
  for (const match of template.matchAll(pattern)) {
    const whole = match[0];
    const name = match[1] as string;
    const start = match.index ?? 0;
    output += template.slice(lastIndex, start);
    const replacement = values[name as TemplatePlaceholder];
    if (replacement === undefined) {
      output += whole; // unknown or unprovided: verbatim
    } else {
      output += replacement; // spliced in as-is, never re-scanned
      substituted.push(name);
    }
    lastIndex = start + whole.length;
  }
  output += template.slice(lastIndex);
  return { output, substituted };
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("Template rendering (Property 2)", () => {
  it("matches a single left-to-right pass that never re-expands substituted values (1.3, 3.5, 9.6)", () => {
    fc.assert(
      fc.property(templateArb, valuesArb, (template, values) => {
        const oracle = renderOracle(template, values);
        expect(renderTemplate(template, values)).toBe(oracle.output);
      }),
      { numRuns: 500 },
    );
  });

  it("substitutes exactly templatePlaceholders(template) ∩ keys(values), once each (1.3, 9.6)", () => {
    fc.assert(
      fc.property(templateArb, valuesArb, (template, values) => {
        const present = templatePlaceholders(template).filter(
          (name) => values[name] !== undefined,
        );
        const substituted = renderOracle(template, values).substituted;

        // Each such placeholder is filled exactly once per occurrence; the set
        // of distinct substituted names equals the intersection.
        const distinctSubstituted = new Set(substituted);
        expect(distinctSubstituted).toEqual(new Set(present));

        // And the rendered output no longer contains those tokens unless a
        // substituted value re-introduced them (handled by the next property).
        for (const name of present) {
          // Count occurrences of this token in the template.
          const occurrences = (
            template.match(new RegExp(`\\{${name}\\}`, "g")) ?? []
          ).length;
          const timesSubstituted = substituted.filter((n) => n === name).length;
          expect(timesSubstituted).toBe(occurrences);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("does not re-expand a value that itself contains a brace token like {Bar} (3.5, 9.6)", () => {
    // Pick two DISTINCT placeholders so the outer value's own key and the inner
    // token's key don't collide in the values map.
    const distinctPairArb = fc
      .tuple(
        fc.constantFrom(...ALL_PLACEHOLDERS),
        fc.constantFrom(...ALL_PLACEHOLDERS),
      )
      .filter(([a, b]) => a !== b);

    fc.assert(
      fc.property(
        distinctPairArb,
        fc.string({ maxLength: 6 }).map((s) => s.replace(/[{}]/g, "")),
        ([outer, inner], pad) => {
          // The outer placeholder's value literally contains {inner}. If
          // rendering re-expanded, the {inner} token inside the value would be
          // replaced by innerValue; the single-pass guarantee forbids that.
          const innerToken = `{${inner}}`;
          const outerValue = `${pad}${innerToken}${pad}`;
          const values: TemplateValues = {
            [outer]: outerValue,
            [inner]: "SHOULD_NOT_APPEAR",
          };
          const rendered = renderTemplate(`{${outer}}`, values);
          expect(rendered).toBe(outerValue);
          expect(rendered).toContain(innerToken);
          expect(rendered).not.toContain("SHOULD_NOT_APPEAR");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("leaves unknown and unprovided placeholders in place verbatim (1.3)", () => {
    fc.assert(
      fc.property(templateArb, valuesArb, (template, values) => {
        const rendered = renderTemplate(template, values);
        // Any known placeholder with no provided value must survive verbatim.
        for (const name of templatePlaceholders(template)) {
          if (values[name] === undefined) {
            expect(rendered).toContain(`{${name}}`);
          }
        }
        // An unknown token the oracle preserved must also survive in the output
        // (unless a substituted value coincidentally introduced/removed it — the
        // oracle equality in the first property already covers exact output, so
        // here we just assert the oracle and impl agree on unknown handling).
        expect(rendered).toBe(renderOracle(template, values).output);
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent on its own output only when no substituted value reintroduces a provided token", () => {
    // A direct example-style guard reinforcing the single-pass semantics: with
    // no values whose substitution reintroduces a provided token, rendering
    // twice equals rendering once.
    fc.assert(
      fc.property(templateArb, valuesArb, (template, values) => {
        const once = renderTemplate(template, values);
        // Re-render with the SAME values. Tokens left verbatim were unprovided,
        // so a second pass changes nothing.
        const twice = renderTemplate(once, values);
        const reintroduces = Object.values(values).some((v) =>
          templatePlaceholders(v ?? "").some((n) => values[n] !== undefined),
        );
        if (!reintroduces) {
          expect(twice).toBe(once);
        }
      }),
      { numRuns: 500 },
    );
  });
});
