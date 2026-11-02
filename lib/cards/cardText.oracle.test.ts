import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CARD_TEXT_MAP,
  type CardText,
  type TemplatePlaceholder,
} from "./cardText";
import { CARD_CATALOG_MAP, CARD_SLUGS, type CardSlug } from "./catalog";

/**
 * Feature: card-behavior, Task 1.4: oracle parity test.
 *
 * `docs/card-text-oracle.md` is the wording source of truth; `cardText.ts`
 * (Task 1.1) is the agreed copy of it into code, with line wraps joined by
 * single spaces. This test re-parses the oracle markdown independently and
 * asserts that every field of every card in `CARD_TEXT_MAP` matches the oracle
 * character for character, apart from `{placeholder}` tokens (which are legal in
 * the copy and whose membership in the allowed set is also checked here).
 *
 * The code is the agreed copy: when the oracle and the code disagree, this test
 * is corrected to parse what the code copied — it never edits the oracle doc
 * (that relabel work is Task 13.1). Field labels are matched by prefix so the
 * 13.1 relabel of the Fairest "Prompt" line still parses.
 *
 * Validates: Requirements 1.2, 24.3
 */

// ---------------------------------------------------------------------------
// Allowed placeholder set (independent of the module under test) + a scanner.
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

// ---------------------------------------------------------------------------
// Oracle markdown parsing.
//
// The doc is a flat list of `## <Card Name>` sections (between the intro and the
// trailing `## Decisions` section). Each section is a bullet list of
// `- **Label:** value` entries; a value may wrap across indented continuation
// lines, which Task 1.1 joined with single spaces. We reproduce that join so the
// comparison is against the same text the code copied.
// ---------------------------------------------------------------------------

const ORACLE_PATH = fileURLToPath(
  new URL("../../docs/card-text-oracle.md", import.meta.url),
);

type OracleFields = ReadonlyMap<string, string>;

/**
 * Parse the oracle into `cardName -> (label -> joined value)`. Labels keep their
 * original text (e.g. `"Target toast"`, `"Others' toast body"`); callers match
 * them by prefix.
 *
 * The card list is the run of `## <Card Name>` sections between the first
 * standalone `---` rule (which closes the intro: Scope, Text surfaces, Standard
 * toast templates) and the trailing `---` before `## Decisions`. Parsing only
 * collects headers while inside that fenced region, so intro `##` headings and
 * the closing notes are never mistaken for cards.
 */
function parseOracle(markdown: string): ReadonlyMap<string, OracleFields> {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map<string, Map<string, string>>();

  let inCardRegion = false;
  let currentCard: string | null = null;
  let currentFields: Map<string, string> | null = null;
  let currentLabel: string | null = null;

  const bulletRe = /^- \*\*(.+?):\*\*\s?(.*)$/;
  const headerRe = /^## (.+?)\s*$/;

  for (const raw of lines) {
    // A standalone `---` rule toggles region boundaries. The first one opens the
    // card region (after the intro); the next closes it (before `## Decisions`).
    if (/^---\s*$/.test(raw)) {
      if (!inCardRegion) {
        inCardRegion = true;
      } else {
        inCardRegion = false;
        currentCard = null;
        currentFields = null;
        currentLabel = null;
      }
      continue;
    }

    const headerMatch = raw.match(headerRe);
    if (headerMatch) {
      const name = headerMatch[1].trim();
      currentLabel = null;
      if (!inCardRegion) {
        currentCard = null;
        currentFields = null;
        continue;
      }
      currentCard = name;
      currentFields = new Map<string, string>();
      sections.set(name, currentFields);
      continue;
    }

    // Only collect inside a card section.
    if (currentCard === null || currentFields === null) continue;

    const bulletMatch = raw.match(bulletRe);
    if (bulletMatch) {
      currentLabel = bulletMatch[1].trim();
      currentFields.set(currentLabel, bulletMatch[2].trim());
      continue;
    }

    // Continuation line: an indented, non-empty line following a bullet joins
    // onto the current field with a single space (how Task 1.1 unwrapped text).
    if (currentLabel !== null && /^\s+\S/.test(raw)) {
      const prev = currentFields.get(currentLabel) ?? "";
      const joined = prev.length > 0 ? `${prev} ${raw.trim()}` : raw.trim();
      currentFields.set(currentLabel, joined);
      continue;
    }

    // A blank line (or an un-indented, non-bullet line) ends the current field.
    if (raw.trim().length === 0) currentLabel = null;
  }

  return sections;
}

/** Find a field value by label prefix (case-sensitive), or undefined. */
function fieldByPrefix(
  fields: OracleFields,
  prefix: string,
): string | undefined {
  for (const [label, value] of fields) {
    if (label.startsWith(prefix)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Field-specific extraction for the two oracle lines Task 1.1 copied as a
// prefix rather than verbatim. The code is the agreed copy, so the test derives
// the expected code string from the oracle line here instead of changing either.
// ---------------------------------------------------------------------------

/**
 * Fairest's "Mirrored toast" oracle line appends trailing prose after the
 * headline ("... complete {CARD}. Body: the original card's target toast ...").
 * Task 1.1 copied only the headline (through the first sentence ending in
 * "{CARD}."). Derive that prefix for comparison.
 */
function mirrorHeadlineFromOracle(value: string): string {
  const marker = " Body:";
  const idx = value.indexOf(marker);
  return idx === -1 ? value : value.slice(0, idx);
}

/**
 * Everyone's a Critic "Target toast actions" oracle line is
 * "Mark complete / We failed (starts the 15-minute block).": two slash-separated
 * actions with a trailing period. Task 1.1 copied the two action labels without
 * the trailing period. Split them back out.
 */
function criticActionsFromOracle(value: string): {
  complete: string;
  failed: string;
} {
  const trimmed = value.replace(/\.\s*$/, "");
  const [complete, failed] = trimmed.split(" / ").map((s) => s.trim());
  return { complete, failed };
}

// ---------------------------------------------------------------------------
// The full set of oracle-field comparisons for one card. Each entry names the
// label prefix to look up and how to pull the expected code string out of the
// `CardText`. A comparison is skipped only when the oracle has no such field
// (e.g. a card with no Requires line); every field the code carries that the
// oracle also states must match.
// ---------------------------------------------------------------------------

interface FieldCheck {
  /** Label prefix matched against the oracle bullet labels. */
  readonly prefix: string;
  /** Human-readable name for assertion messages. */
  readonly name: string;
  /** The in-code string for this field, or null/undefined when absent. */
  readonly code: string | null | undefined;
  /** Transform the oracle value before comparison (default: identity). */
  readonly fromOracle?: (oracle: string) => string;
}

function fieldChecksFor(text: CardText): FieldCheck[] {
  const t = text.toasts;
  return [
    { prefix: "Requires", name: "requires", code: text.requires },
    { prefix: "Effect", name: "effect", code: text.effect },
    {
      prefix: "Target toast body",
      name: "targetToastBody",
      code: text.targetToastBody,
    },
    // "Target toast" (not "...body"/"...actions"/"...headline") is the body too.
    {
      prefix: "Target toast:",
      name: "targetToastBody",
      code: text.targetToastBody,
    },
    // "Target:" is the target note. Checked below with an exact-label match so
    // it does not shadow the "Target toast*" labels via prefix.
    {
      prefix: "Others' toast body",
      name: "toasts.othersBody",
      code: t?.othersBody,
    },
    { prefix: "Start toast", name: "toasts.start", code: t?.start },
    { prefix: "End toast", name: "toasts.end", code: t?.end },
    {
      prefix: "Announcement toast",
      name: "toasts.announcement",
      code: t?.announcement,
    },
    {
      prefix: "Toast (all teams)",
      name: "toasts.announcement",
      code: t?.announcement,
    },
    { prefix: "Payout toast", name: "toasts.payout", code: t?.payout },
    {
      prefix: "Prompt",
      name: "toasts.fairestPrompt",
      code: t?.fairestPrompt,
    },
    {
      prefix: "Mirrored toast",
      name: "toasts.mirrorHeadline",
      code: t?.mirrorHeadline,
      fromOracle: mirrorHeadlineFromOracle,
    },
    // "Others' toast headline" names the non-casters' headline. For Fairest that
    // is the mirror headline (`mirrorOthersHeadline`); for Voted Off the Island
    // (a notice) it is the all-teams announcement headline (`announcement`).
    // Task 1.1 copied it into whichever field the card uses, so compare against
    // whichever the code carries.
    {
      prefix: "Others' toast headline",
      name: "toasts.mirrorOthersHeadline/announcement",
      code: t?.mirrorOthersHeadline ?? t?.announcement,
    },
  ];
}

// ---------------------------------------------------------------------------
// Build the card name -> slug index from the catalog (the independent oracle for
// which heading maps to which code entry).
// ---------------------------------------------------------------------------

const NAME_TO_SLUG = new Map<string, CardSlug>(
  CARD_SLUGS.map((slug) => [CARD_CATALOG_MAP.get(slug)!.name, slug] as const),
);

describe("Card text oracle parity (Task 1.4)", () => {
  const markdown = readFileSync(ORACLE_PATH, "utf8");
  const oracle = parseOracle(markdown);

  it("every card in the oracle maps to a catalog slug, and every slug appears in the oracle", () => {
    const oracleNames = new Set(oracle.keys());
    for (const name of oracleNames) {
      expect(NAME_TO_SLUG.has(name), `oracle card "${name}" has no slug`).toBe(
        true,
      );
    }
    for (const slug of CARD_SLUGS) {
      const name = CARD_CATALOG_MAP.get(slug)!.name;
      expect(oracleNames.has(name), `slug ${slug} missing from oracle`).toBe(
        true,
      );
    }
    expect(oracleNames.size).toBe(CARD_SLUGS.length);
  });

  it("every oracle field matches the in-code CardText character for character (1.2)", () => {
    for (const [name, fields] of oracle) {
      const slug = NAME_TO_SLUG.get(name);
      expect(slug, `oracle card "${name}" has no slug`).toBeDefined();
      const text = CARD_TEXT_MAP.get(slug as CardSlug);
      expect(text, `missing CardText for ${slug}`).toBeDefined();
      const cardText = text as CardText;

      // Target note: exact-label "Target" (the bottom "who/what it hits" note).
      const targetNoteOracle = fields.get("Target");
      if (targetNoteOracle !== undefined) {
        expect(cardText.targetNote, `${name}: targetNote mismatch`).toBe(
          targetNoteOracle,
        );
      }

      // Everyone's a Critic actions: slash-separated in the oracle.
      const actionsOracle = fieldByPrefix(fields, "Target toast actions");
      if (actionsOracle !== undefined) {
        const expectedActions = criticActionsFromOracle(actionsOracle);
        expect(
          cardText.toasts?.actions?.complete,
          `${name}: actions.complete mismatch`,
        ).toBe(expectedActions.complete);
        expect(
          cardText.toasts?.actions?.failed,
          `${name}: actions.failed mismatch`,
        ).toBe(expectedActions.failed);
      }

      for (const check of fieldChecksFor(cardText)) {
        const oracleValue = fieldByPrefix(fields, check.prefix);
        if (oracleValue === undefined) continue;
        const expected = check.fromOracle
          ? check.fromOracle(oracleValue)
          : oracleValue;
        expect(
          check.code,
          `${name}: ${check.name} present in oracle but not in code`,
        ).toBeTruthy();
        expect(check.code, `${name}: ${check.name} mismatch`).toBe(expected);
      }
    }
  });

  it("every placeholder in every oracle field belongs to the allowed set (24.3)", () => {
    for (const [name, fields] of oracle) {
      for (const [label, value] of fields) {
        for (const token of placeholdersIn(value)) {
          expect(
            ALLOWED_PLACEHOLDERS.has(token),
            `${name}: oracle field "${label}" uses unknown placeholder {${token}}`,
          ).toBe(true);
        }
      }
    }
  });

  it("every placeholder in every in-code card string belongs to the allowed set (24.3)", () => {
    for (const slug of CARD_SLUGS) {
      const text = CARD_TEXT_MAP.get(slug);
      expect(text, `missing text for ${slug}`).toBeDefined();
      const cardText = text as CardText;
      const strings: (string | null | undefined)[] = [
        cardText.requires,
        cardText.effect,
        cardText.targetNote,
        cardText.targetToastBody,
        cardText.toasts?.announcement,
        cardText.toasts?.othersBody,
        cardText.toasts?.start,
        cardText.toasts?.end,
        cardText.toasts?.payout,
        cardText.toasts?.mirrorHeadline,
        cardText.toasts?.mirrorOthersHeadline,
        cardText.toasts?.fairestPrompt,
        cardText.toasts?.actions?.complete,
        cardText.toasts?.actions?.failed,
      ];
      for (const str of strings) {
        if (typeof str !== "string") continue;
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
