/**
 * Feature: web-app-foundation, Property 15: Startup env validation reports exactly the missing variables
 *
 * Validates: Requirements 2.9
 *
 * The property: given a random subset `S` of the required environment variables to
 * omit or blank (all remaining required vars set to valid non-empty values), startup
 * validation halts pre-start and the reported names equal *exactly* `S`. When `S` is
 * empty, validation succeeds and returns a config.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  loadEnv,
  MissingEnvError,
  REQUIRED_ENV_VARS,
  type EnvSource,
} from "./index";

/** A valid, non-empty placeholder value for a required variable. */
function validValueFor(name: string): string {
  return `valid-value-for-${name}`;
}

/**
 * Build a synthetic environment source where the variables in `omitted` are absent
 * or blanked and every other required variable is set to a valid non-empty value.
 *
 * `mode` decides how an omitted variable is expressed: fully absent, empty string,
 * or whitespace-only (all three must count as "missing or empty").
 */
function buildSource(
  omitted: ReadonlySet<string>,
  blankMode: (name: string) => "absent" | "empty" | "whitespace",
): EnvSource {
  const source: Record<string, string | undefined> = {};
  for (const name of REQUIRED_ENV_VARS) {
    if (omitted.has(name)) {
      const mode = blankMode(name);
      if (mode === "empty") {
        source[name] = "";
      } else if (mode === "whitespace") {
        source[name] = "   ";
      }
      // "absent": leave the key unset entirely.
    } else {
      source[name] = validValueFor(name);
    }
  }
  return source;
}

describe("Property 15: Startup env validation reports exactly the missing variables", () => {
  it("reports exactly the omitted/blanked required variables (empty subset succeeds)", () => {
    // A generator over subsets of REQUIRED_ENV_VARS: one boolean per required var
    // decides whether it is omitted. This covers the empty subset, the full subset,
    // and everything in between.
    const subsetArb = fc
      .tuple(...REQUIRED_ENV_VARS.map(() => fc.boolean()))
      .map((flags) => {
        const omitted = new Set<string>();
        REQUIRED_ENV_VARS.forEach((name, i) => {
          if (flags[i]) omitted.add(name);
        });
        return omitted;
      });

    // How each omitted var is blanked: absent, empty, or whitespace-only.
    const blankModeArb = fc.constantFrom(
      "absent" as const,
      "empty" as const,
      "whitespace" as const,
    );

    fc.assert(
      fc.property(subsetArb, fc.func(blankModeArb), (omitted, blankMode) => {
        const source = buildSource(omitted, blankMode);

        if (omitted.size === 0) {
          // Empty subset: validation succeeds and returns a usable config.
          const config = loadEnv(source);
          expect(config).toBeDefined();
          expect(config.public.NEXT_PUBLIC_SUPABASE_URL).toBe(
            validValueFor("NEXT_PUBLIC_SUPABASE_URL"),
          );
          expect(config.public.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(
            validValueFor("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
          );
          expect(config.server.SUPABASE_SERVICE_ROLE_KEY).toBe(
            validValueFor("SUPABASE_SERVICE_ROLE_KEY"),
          );
          return;
        }

        // Non-empty subset: validation halts by throwing MissingEnvError, and the
        // reported names equal exactly the omitted subset S (order-independent).
        let thrown: unknown;
        try {
          loadEnv(source);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(MissingEnvError);
        const reported = new Set((thrown as MissingEnvError).missing);
        expect(reported).toEqual(omitted);
      }),
      { numRuns: 100 },
    );
  });
});
