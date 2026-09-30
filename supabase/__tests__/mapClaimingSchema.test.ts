import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static contract checks for map-and-claiming migration 0010.
 *
 * The live migration smoke covers application against Postgres. These focused
 * checks keep the reversible claim and server-only write contract visible in
 * the default test suite without requiring a database.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const MIGRATIONS = join(PROJECT_ROOT, "supabase", "migrations");

const migration = readFileSync(
  join(MIGRATIONS, "0010_claims_and_score_ledger.sql"),
  "utf8",
).replace(/--[^\n]*/g, "");

describe("map-and-claiming migration 0010", () => {
  it("adds reversible claim state and one-active-claim uniqueness", () => {
    expect(migration).toMatch(
      /alter\s+table\s+claims\s+add\s+column\s+revoked_at\s+timestamptz/i,
    );
    expect(migration).toMatch(/add\s+column\s+revoked_reason\s+text/i);
    expect(migration).toMatch(
      /create\s+unique\s+index\s+claims_active_game_team_bar_unique[\s\S]*?where\s+revoked_at\s+is\s+null/i,
    );
    expect(migration).toMatch(
      /drop\s+constraint\s+claims_game_team_bar_unique/i,
    );
  });

  it("creates a game-scoped append-only score ledger shape", () => {
    expect(migration).toMatch(/create\s+table\s+score_ledger_entries/i);
    expect(migration).toMatch(
      /source_claim_id\s+uuid[\s\S]*?category\s+text[\s\S]*?points\s+integer/i,
    );
    expect(migration).toMatch(
      /foreign\s+key\s*\(\s*source_claim_id\s*,\s*game_id\s*\)[\s\S]*?references\s+claims\s*\(\s*id\s*,\s*game_id\s*\)/i,
    );
  });

  it("keeps claim and ledger writes behind the server mutation path", () => {
    expect(migration).toMatch(
      /drop\s+policy\s+if\s+exists\s+claims_member_insert/i,
    );
    expect(migration).toMatch(
      /drop\s+policy\s+if\s+exists\s+claims_member_update/i,
    );
    expect(migration).toMatch(
      /drop\s+policy\s+if\s+exists\s+claims_member_delete/i,
    );
    expect(migration).toMatch(
      /create\s+policy\s+score_ledger_entries_member_select[\s\S]*?for\s+select/i,
    );
    expect(migration).toMatch(
      /revoke\s+insert\s*,\s*update\s*,\s*delete\s+on\s+table\s+score_ledger_entries\s+from\s+authenticated/i,
    );
  });
});
