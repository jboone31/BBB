import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 7.5 — Schema shape and card-catalog seed tests.
 *
 * No live Postgres is available in this environment, so these tests parse the
 * committed SQL migration files as text and assert on their content:
 *
 *   * 0005_seed_card_catalog.sql — the seeded `card_definitions` INSERT must
 *     equal the finalized v1 card set from `.kiro/steering/cards.md`, every row
 *     must carry a valid `card_type`, `requires_target` must be a boolean, and
 *     the no-target / self / reactive cards must have `requires_target = false`.
 *   * 0001_core_game_schema.sql — the `game_lifecycle` and `game_end_reason`
 *     enums must have exactly the expected members.
 *   * 0004_cards.sql — the `card_type` and `card_instance_state` enums must have
 *     exactly the expected members.
 *
 * Validates: Requirements 3.2, 3.4, 3.10, 3.11.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");

const MIGRATIONS = join(PROJECT_ROOT, "supabase", "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/**
 * Extract the members of a `create type <name> as enum (...)` declaration.
 * Returns the string literals in declaration order.
 */
function parseEnumMembers(sql: string, enumName: string): string[] {
  const re = new RegExp(
    `create\\s+type\\s+${enumName}\\s+as\\s+enum\\s*\\(([^)]*)\\)`,
    "i",
  );
  const match = sql.match(re);
  if (!match) {
    throw new Error(`enum "${enumName}" not found`);
  }
  const body = match[1];
  const members = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return members;
}

// ---------------------------------------------------------------------------
// Expected v1 card catalog (source of truth: .kiro/steering/cards.md)
// ---------------------------------------------------------------------------

const VALID_CARD_TYPES = [
  "opponent_slowing",
  "economy_boost",
  "reactive",
] as const;
type CardType = (typeof VALID_CARD_TYPES)[number];

interface ExpectedCard {
  name: string;
  cardType: CardType;
  requiresTarget: boolean;
}

/**
 * The finalized v1 card set. 24 cards total:
 *   * 16 opponent_slowing (14 targeting + 2 no-target: Crop Dusting, Cancel Culture)
 *   *  7 economy_boost (all self/economy -> requires_target = false)
 *   *  1 reactive (Fairest of Them All -> requires_target = false)
 */
const EXPECTED_CARDS: ExpectedCard[] = [
  // opponent_slowing — targeting (requires_target = true)
  { name: "Go Piss Girl", cardType: "opponent_slowing", requiresTarget: true },
  { name: "Moneybags", cardType: "opponent_slowing", requiresTarget: true },
  {
    name: "Use It or Lose It",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  { name: "Wired", cardType: "opponent_slowing", requiresTarget: true },
  {
    name: "Art School Dropout",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  {
    name: "Broad Shoulders",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  { name: "Bird Guide", cardType: "opponent_slowing", requiresTarget: true },
  {
    name: "Interested Buyer",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  {
    name: "Different Tastes",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  {
    name: "Everyone's a Critic",
    cardType: "opponent_slowing",
    requiresTarget: true,
  },
  { name: "Quit Nursing", cardType: "opponent_slowing", requiresTarget: true },
  { name: "Spin Cycle", cardType: "opponent_slowing", requiresTarget: true },
  { name: "Dirty Bird", cardType: "opponent_slowing", requiresTarget: true },
  { name: "Scenic Route", cardType: "opponent_slowing", requiresTarget: true },
  // opponent_slowing — no target (requires_target = false)
  { name: "Crop Dusting", cardType: "opponent_slowing", requiresTarget: false },
  {
    name: "Cancel Culture",
    cardType: "opponent_slowing",
    requiresTarget: false,
  },
  // economy_boost — self/economy (requires_target = false)
  { name: "Heavyweight", cardType: "economy_boost", requiresTarget: false },
  { name: "Insured", cardType: "economy_boost", requiresTarget: false },
  { name: "Happy Hour", cardType: "economy_boost", requiresTarget: false },
  { name: "Power Hour", cardType: "economy_boost", requiresTarget: false },
  { name: "Party Crasher", cardType: "economy_boost", requiresTarget: false },
  {
    name: "Patient Investor",
    cardType: "economy_boost",
    requiresTarget: false,
  },
  { name: "Window Shopping", cardType: "economy_boost", requiresTarget: false },
  // reactive (requires_target = false)
  { name: "Fairest of Them All", cardType: "reactive", requiresTarget: false },
];

// ---------------------------------------------------------------------------
// Seed-row parsing (0005_seed_card_catalog.sql)
// ---------------------------------------------------------------------------

interface SeededRow {
  slug: string;
  name: string;
  cardType: string;
  requiresTarget: string; // raw token as written in SQL, e.g. "true" | "false"
}

/**
 * Parse the seeded card_definitions rows. Each row begins
 *   ('slug', 'Name', 'card_type', <bool>, ...
 * We only need the first four column values, so we anchor on the row prefix and
 * capture the leading slug, name, card_type, and requires_target token. SQL
 * escapes a single quote by doubling it ('') — we join those back together.
 */
function parseSeededRows(sql: string): SeededRow[] {
  // Isolate the VALUES block up to the ON CONFLICT clause so comments and the
  // INSERT column list are not mistaken for rows. Both "values" and
  // "on conflict" appear in the header comment, so anchor on the LAST match of
  // each (the real clause) rather than the first.
  const valuesStart = lastIndexOfRegex(sql, /\bvalues\b/gi);
  const conflictStart = lastIndexOfRegex(sql, /on\s+conflict/gi);
  const block = sql.slice(
    valuesStart,
    conflictStart === -1 ? undefined : conflictStart,
  );

  const rows: SeededRow[] = [];
  // Match: ( <str>, <str>, <str>, <bool token>,
  // A SQL string is a run of non-quote chars and doubled-quote escapes.
  const rowRe =
    /\(\s*((?:'(?:[^']|'')*'))\s*,\s*((?:'(?:[^']|'')*'))\s*,\s*((?:'(?:[^']|'')*'))\s*,\s*(true|false)\b/gi;

  for (const m of block.matchAll(rowRe)) {
    rows.push({
      slug: unquote(m[1]),
      name: unquote(m[2]),
      cardType: unquote(m[3]),
      requiresTarget: m[4].toLowerCase(),
    });
  }
  return rows;
}

/** Index of the last match of a global regex, or -1 if none. */
function lastIndexOfRegex(text: string, re: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(re)) {
    last = m.index ?? last;
  }
  return last;
}

function unquote(sqlString: string): string {
  // Strip surrounding quotes and unescape doubled single quotes.
  return sqlString.slice(1, -1).replace(/''/g, "'");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("card catalog seed — 0005_seed_card_catalog.sql (Req 3.10)", () => {
  const seedSql = readMigration("0005_seed_card_catalog.sql");
  const rows = parseSeededRows(seedSql);

  it("seeds exactly the 24 finalized v1 cards with no duplicates", () => {
    expect(rows).toHaveLength(EXPECTED_CARDS.length);
    expect(rows.length).toBe(24);

    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const names = rows.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("seeds a card set whose names equal the finalized v1 set from cards.md", () => {
    const seededNames = new Set(rows.map((r) => r.name));
    const expectedNames = new Set(EXPECTED_CARDS.map((c) => c.name));
    expect(seededNames).toEqual(expectedNames);
  });

  it("has the expected type distribution (16 opponent_slowing, 7 economy_boost, 1 reactive)", () => {
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.cardType] = (acc[r.cardType] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      opponent_slowing: 16,
      economy_boost: 7,
      reactive: 1,
    });
  });

  it("gives every row a valid card_type", () => {
    for (const row of rows) {
      expect(VALID_CARD_TYPES).toContain(row.cardType as CardType);
    }
  });

  it("writes requires_target as a boolean token for every row", () => {
    for (const row of rows) {
      expect(["true", "false"]).toContain(row.requiresTarget);
    }
  });

  it("matches the expected card_type and requires_target for every card", () => {
    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const expected of EXPECTED_CARDS) {
      const row = byName.get(expected.name);
      expect(row, `missing seeded card "${expected.name}"`).toBeDefined();
      if (!row) continue;
      expect(row.cardType, `card_type for "${expected.name}"`).toBe(
        expected.cardType,
      );
      expect(
        row.requiresTarget === "true",
        `requires_target for "${expected.name}"`,
      ).toBe(expected.requiresTarget);
    }
  });

  it("sets requires_target = false for the no-target opponent cards, all economy_boost, and reactive", () => {
    const byName = new Map(rows.map((r) => [r.name, r]));

    const noTargetOrSelf = [
      "Crop Dusting",
      "Cancel Culture",
      // all economy_boost
      "Heavyweight",
      "Insured",
      "Happy Hour",
      "Power Hour",
      "Party Crasher",
      "Patient Investor",
      "Window Shopping",
      // reactive
      "Fairest of Them All",
    ];

    for (const name of noTargetOrSelf) {
      const row = byName.get(name);
      expect(row, `missing seeded card "${name}"`).toBeDefined();
      expect(row?.requiresTarget, `${name} should not require a target`).toBe(
        "false",
      );
    }

    // And every economy_boost / reactive row is false, whatever its name.
    for (const row of rows) {
      if (row.cardType === "economy_boost" || row.cardType === "reactive") {
        expect(row.requiresTarget, `${row.name} (${row.cardType})`).toBe(
          "false",
        );
      }
    }
  });
});

describe("game enums — 0001_core_game_schema.sql (Req 3.2, 3.4)", () => {
  const coreSql = readMigration("0001_core_game_schema.sql");

  it("game_lifecycle has exactly {lobby, live, ended}", () => {
    const members = parseEnumMembers(coreSql, "game_lifecycle");
    expect(new Set(members)).toEqual(new Set(["lobby", "live", "ended"]));
    expect(members).toHaveLength(3);
  });

  it("game_end_reason has exactly {finish_bar_claimed, admin_ended, auto_timeout}", () => {
    const members = parseEnumMembers(coreSql, "game_end_reason");
    expect(new Set(members)).toEqual(
      new Set(["finish_bar_claimed", "admin_ended", "auto_timeout"]),
    );
    expect(members).toHaveLength(3);
  });
});

describe("card enums — 0004_cards.sql (Req 3.10, 3.11)", () => {
  const cardsSql = readMigration("0004_cards.sql");

  it("card_type has exactly {opponent_slowing, economy_boost, reactive}", () => {
    const members = parseEnumMembers(cardsSql, "card_type");
    expect(new Set(members)).toEqual(
      new Set(["opponent_slowing", "economy_boost", "reactive"]),
    );
    expect(members).toHaveLength(3);
  });

  it("card_instance_state has exactly {in_hand, played, discarded}", () => {
    const members = parseEnumMembers(cardsSql, "card_instance_state");
    expect(new Set(members)).toEqual(
      new Set(["in_hand", "played", "discarded"]),
    );
    expect(members).toHaveLength(3);
  });
});
