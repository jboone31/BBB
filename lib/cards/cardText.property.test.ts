import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createCardText,
  CARD_TEXT_MAP,
  type CardText,
  type TemplatePlaceholder,
} from "./cardText";
import { CARD_CATALOG_MAP, CARD_SLUGS, type CardSlug } from "./catalog";

/**
 * Feature: card-behavior, Property 1: Card text validation.
 *
 * For any card-text entry map, `createCardText` succeeds if and only if every
 * slug has a non-blank `effect` and `targetNote`, and every team-target slug has
 * a non-blank `targetToastBody` (Requirement 1.4). Every placeholder token in
 * every accepted string belongs to the allowed `TemplatePlaceholder` set
 * (Requirement 1.3). (design.md §Property 1.)
 *
 * Validates: Requirements 1.3, 1.4
 */

// ---------------------------------------------------------------------------
// The allowed placeholder set (Requirement 1.3) and a scanner that pulls every
// `{token}` out of a string. The scanner is deliberately independent of the
// module under test so the assertion is a real check, not a tautology.
// ---------------------------------------------------------------------------

const ALLOWED_PLACEHOLDERS: ReadonlySet<string> = new Set<TemplatePlaceholder>([
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
]);

/** Every `{token}` appearing in a string, in order (duplicates kept). */
function placeholdersIn(value: string): string[] {
  return Array.from(value.matchAll(/\{([^}]*)\}/g), (m) => m[1] ?? "");
}

/** Every string a {@link CardText} entry carries (ignoring null fields). */
function allStrings(text: CardText): string[] {
  const strings: string[] = [text.effect, text.targetNote];
  if (text.requires !== null) strings.push(text.requires);
  if (text.targetToastBody !== null) strings.push(text.targetToastBody);
  const t = text.toasts;
  if (t) {
    for (const value of [
      t.announcement,
      t.othersBody,
      t.start,
      t.end,
      t.payout,
      t.mirrorHeadline,
      t.mirrorOthersHeadline,
      t.fairestPrompt,
    ]) {
      if (typeof value === "string") strings.push(value);
    }
    if (t.actions) {
      strings.push(t.actions.complete);
      if (typeof t.actions.failed === "string") strings.push(t.actions.failed);
    }
  }
  return strings;
}

// The slugs whose catalog `targetMode` is "team" — the set the 1.4 rule requires
// a non-blank `targetToastBody` for. Derived from the catalog metadata, not from
// cardText.ts's private copy, so the test is an independent oracle.
const TEAM_TARGET_SLUGS: ReadonlySet<CardSlug> = new Set(
  CARD_SLUGS.filter(
    (slug) => CARD_CATALOG_MAP.get(slug)?.targetMode === "team",
  ),
);

// ---------------------------------------------------------------------------
// Generators: build an entry map with per-field blank / non-blank choices so the
// property exercises both the throwing and the accepting branches of each rule.
// ---------------------------------------------------------------------------

// "Blank" per the module's `isNonBlank`: empty or whitespace-only. We bias the
// generator toward a handful of representative blanks plus arbitrary non-blanks.
const blankArb: fc.Arbitrary<string> = fc.constantFrom("", " ", "\t", "\n  \t");

const nonBlankArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 12 })
  .map((s) => `x${s}`);

/** A field value that is blank with the given probability, else non-blank. */
function fieldArb(): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 1, arbitrary: blankArb },
    { weight: 2, arbitrary: nonBlankArb },
  );
}

/** A nullable field: null, blank, or non-blank. */
function nullableFieldArb(): fc.Arbitrary<string | null> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: fieldArb() },
  );
}

const cardTextArb: fc.Arbitrary<CardText> = fc.record({
  requires: nullableFieldArb(),
  effect: fieldArb(),
  targetNote: fieldArb(),
  targetToastBody: nullableFieldArb(),
});

/** An entry map covering every catalog slug with independently chosen fields. */
const entriesArb: fc.Arbitrary<Record<CardSlug, CardText>> = fc
  .tuple(...CARD_SLUGS.map(() => cardTextArb))
  .map((texts) => {
    const entries = {} as Record<CardSlug, CardText>;
    CARD_SLUGS.forEach((slug, i) => {
      entries[slug] = texts[i] as CardText;
    });
    return entries;
  });

function isNonBlank(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The 1.4 rule, computed independently of the module under test. */
function shouldSucceed(entries: Record<CardSlug, CardText>): boolean {
  return CARD_SLUGS.every((slug) => {
    const text = entries[slug];
    if (!isNonBlank(text.effect)) return false;
    if (!isNonBlank(text.targetNote)) return false;
    if (TEAM_TARGET_SLUGS.has(slug) && !isNonBlank(text.targetToastBody)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Property 1a (Requirement 1.4): createCardText throws exactly when a rule fails.
// ---------------------------------------------------------------------------

describe("Card text validation (Property 1)", () => {
  it("createCardText succeeds iff every slug has non-blank effect/targetNote and every team-target slug a non-blank targetToastBody (1.4)", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const expected = shouldSucceed(entries);
        if (expected) {
          const map = createCardText(entries);
          // Accepted: every slug is present and preserved.
          expect(map.size).toBe(CARD_SLUGS.length);
          for (const slug of CARD_SLUGS) {
            expect(map.get(slug)).toBe(entries[slug]);
          }
        } else {
          expect(() => createCardText(entries)).toThrow();
        }
      }),
      { numRuns: 300 },
    );
  });

  it("throws on a blank effect for any single slug (1.4)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CARD_SLUGS), blankArb, (slug, blank) => {
        const entries = validBaseEntries();
        entries[slug] = { ...entries[slug], effect: blank };
        expect(() => createCardText(entries)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("throws on a blank targetNote for any single slug (1.4)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CARD_SLUGS), blankArb, (slug, blank) => {
        const entries = validBaseEntries();
        entries[slug] = { ...entries[slug], targetNote: blank };
        expect(() => createCardText(entries)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("throws on a blank/null targetToastBody for a team-target slug, but not for a non-team-target slug (1.4)", () => {
    const teamTargets = CARD_SLUGS.filter((s) => TEAM_TARGET_SLUGS.has(s));
    const nonTeamTargets = CARD_SLUGS.filter((s) => !TEAM_TARGET_SLUGS.has(s));

    fc.assert(
      fc.property(
        fc.constantFrom(...teamTargets),
        fc.oneof(blankArb, fc.constant(null)),
        (slug, blankOrNull) => {
          const entries = validBaseEntries();
          entries[slug] = { ...entries[slug], targetToastBody: blankOrNull };
          expect(() => createCardText(entries)).toThrow();
        },
      ),
      { numRuns: 100 },
    );

    // A non-team-target slug may carry a null/blank targetToastBody and still
    // pass, as long as its effect and targetNote are non-blank.
    fc.assert(
      fc.property(
        fc.constantFrom(...nonTeamTargets),
        fc.oneof(blankArb, fc.constant(null)),
        (slug, blankOrNull) => {
          const entries = validBaseEntries();
          entries[slug] = { ...entries[slug], targetToastBody: blankOrNull };
          expect(() => createCardText(entries)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 1b (Requirement 1.3): every placeholder in every shipped string
  // belongs to the allowed TemplatePlaceholder set.
  // -------------------------------------------------------------------------

  it("every placeholder in every shipped card string belongs to the allowed set (1.3)", () => {
    for (const slug of CARD_SLUGS) {
      const text = CARD_TEXT_MAP.get(slug);
      expect(text, `missing text for ${slug}`).toBeDefined();
      for (const str of allStrings(text as CardText)) {
        for (const token of placeholdersIn(str)) {
          expect(
            ALLOWED_PLACEHOLDERS.has(token),
            `card ${slug} uses an unknown placeholder {${token}} in: ${str}`,
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fully valid entry map (every field non-blank, team targets with a body) that
 * each single-field mutation test starts from, so the only reason a mutated map
 * throws is the injected blank/null.
 */
function validBaseEntries(): Record<CardSlug, CardText> {
  const entries = {} as Record<CardSlug, CardText>;
  for (const slug of CARD_SLUGS) {
    entries[slug] = {
      requires: null,
      effect: "effect",
      targetNote: "target note",
      targetToastBody: TEAM_TARGET_SLUGS.has(slug) ? "body" : null,
    };
  }
  return entries;
}
