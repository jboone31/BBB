import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 12.8 — Hermetic text check for migration 0014_card_effect_sweep.
 *
 * The live apply + behavioral agreement with planEffectTransitions lives in the
 * env-gated integration suite (Task 12.7). These focused static checks read the
 * committed migration SQL as text and keep its key contract visible in the
 * default, database-free `npm test` run: it defines the settlement function,
 * stays wrapped in a single begin/commit, creates NO database scheduler, claims
 * transitions with the conditional `..._announced_at is null` updates, appends
 * the effect transition events, redefines the auto-timeout sweep to cancel
 * effects with `cancel_reason = 'game_ended'`, and keeps execute server-only.
 *
 * Validates: Requirements 20.3d, 20.5c.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");
const MIGRATIONS = join(PROJECT_ROOT, "supabase", "migrations");

// Strip line comments so prose in the header banner never satisfies (or breaks)
// a keyword scan — only executable SQL is asserted against.
const migration = readFileSync(
  join(MIGRATIONS, "0014_card_effect_sweep.sql"),
  "utf8",
).replace(/--[^\n]*/g, "");

describe("card-effect-sweep migration 0014", () => {
  it("defines the settlement function bbb_settle_card_effects", () => {
    expect(migration).toMatch(
      /create\s+or\s+replace\s+function\s+bbb_settle_card_effects\s*\(/i,
    );
  });

  it("wraps the migration in a single begin/commit transaction", () => {
    // Top-level transaction STATEMENTS (semicolon-terminated), ignoring the
    // PL/pgSQL `begin ... end;` block delimiters inside the function bodies,
    // which are not statement terminators.
    const begins = [...migration.matchAll(/\bbegin\s*;/gi)];
    const commits = [...migration.matchAll(/\bcommit\s*;/gi)];
    expect(begins.length).toBe(1);
    expect(commits.length).toBe(1);
    expect((begins[0].index ?? Infinity) < (commits[0].index ?? -1)).toBe(true);
  });

  it("creates no database scheduler (no cron schedule or cron schema reference)", () => {
    expect(migration).not.toMatch(/schedule\s*\(/i);
    expect(migration).not.toMatch(/\bcron\./i);
  });

  it("claims transitions with the conditional announced-at updates", () => {
    // Activation claim: stamp start_announced_at only while it is still null.
    expect(migration).toMatch(
      /update\s+card_effects\s+set\s+start_announced_at\s*=\s*clock_timestamp\(\)[\s\S]*?start_announced_at\s+is\s+null/i,
    );
    // Expiry claim: stamp end_announced_at only while it is still null.
    expect(migration).toMatch(
      /update\s+card_effects\s+set\s+end_announced_at\s*=\s*clock_timestamp\(\)[\s\S]*?end_announced_at\s+is\s+null/i,
    );
  });

  it("appends effect_activated / effect_expired transition events", () => {
    expect(migration).toMatch(/'effect_activated'/);
    expect(migration).toMatch(/'effect_expired'/);
    // Events go through the game_events append path.
    expect(migration).toMatch(/insert\s+into\s+game_events/i);
  });

  it("redefines the auto-timeout sweep to cancel effects as game_ended", () => {
    expect(migration).toMatch(
      /create\s+or\s+replace\s+function\s+bbb_run_auto_timeout_sweep\s*\(/i,
    );
    expect(migration).toMatch(
      /update\s+card_effects[\s\S]*?cancel_reason\s*=\s*'game_ended'/i,
    );
  });

  it("restricts execute on the settlement function to the server role", () => {
    // Server role keeps execute...
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+bbb_settle_card_effects\b[\s\S]*?to\s+service_role/i,
    );
    // ...and the browser roles are revoked.
    expect(migration).toMatch(
      /revoke\s+execute\s+on\s+function\s+bbb_settle_card_effects\b[\s\S]*?from\s+anon/i,
    );
    expect(migration).toMatch(
      /revoke\s+execute\s+on\s+function\s+bbb_settle_card_effects\b[\s\S]*?from\s+authenticated/i,
    );
  });
});
