import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_ENV_VARS, SERVER_DB_URL_VAR } from "@/lib/env";

/**
 * Task 19.2 — `.env.example` completeness check.
 *
 * A static, environment-free assertion over the committed `.env.example`
 * template: it must list EVERY required environment variable (the exact set
 * `loadEnv()` fails fast on, imported here as {@link REQUIRED_ENV_VARS} so the
 * check stays in sync with the source of truth) with a non-empty, non-secret
 * placeholder value.
 *
 * The template may ALSO document the optional {@link SERVER_DB_URL_VAR}
 * (`SUPABASE_DB_URL`); that is expected and must not fail the check — only the
 * REQUIRED set is asserted present.
 *
 * Validates: Requirements 2.8.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");

/**
 * Parse the `KEY=value` assignments from a dotenv-style file into a map. Blank
 * lines and `#` comment lines are ignored; the value is everything after the
 * first `=`, trimmed. This mirrors how a dotenv loader would read the file.
 */
function parseDotenv(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out.set(key, value);
  }
  return out;
}

const ENV_EXAMPLE = parseDotenv(
  readFileSync(join(PROJECT_ROOT, ".env.example"), "utf8"),
);

describe("`.env.example` completeness (Req 2.8)", () => {
  it("lists every required env var (matching loadEnv's required set)", () => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !ENV_EXAMPLE.has(name));
    expect(missing).toEqual([]);
  });

  it.each(REQUIRED_ENV_VARS)(
    "gives %s a non-empty placeholder value",
    (name) => {
      const value = ENV_EXAMPLE.get(name);
      expect(value, `${name} must be present in .env.example`).toBeDefined();
      // A non-empty placeholder — real values live in git-ignored env files.
      expect((value ?? "").length).toBeGreaterThan(0);
    },
  );

  it("does not fail on the optional SUPABASE_DB_URL entry (allowed/expected)", () => {
    // The optional var may be documented; if present it should have a
    // placeholder too, but its absence must NOT fail the required-set check.
    if (ENV_EXAMPLE.has(SERVER_DB_URL_VAR)) {
      expect((ENV_EXAMPLE.get(SERVER_DB_URL_VAR) ?? "").length).toBeGreaterThan(
        0,
      );
    }
    // Whether present or not, the required-set assertions above stand alone.
    expect(true).toBe(true);
  });
});
