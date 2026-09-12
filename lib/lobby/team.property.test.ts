import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { MAX_TEAMS } from "@/lib/gameend";
import {
  MAX_TEAM_NAME,
  TEAM_COLORS,
  decideCreateTeam,
  validateTeamName,
} from "./team";

/**
 * Feature: game-setup-lobby, Property 5: Team-name validation and trimming
 *
 * For any raw string, `validateTeamName` accepts it if and only if the trimmed
 * string has length between 1 and `MAX_TEAM_NAME` (100) inclusive. Empty,
 * all-whitespace, and over-100 inputs are rejected with an `invalid_team_name`
 * result; accepted inputs carry the trimmed value verbatim.
 *
 * Validates: Requirements 4.4, 4.7
 */
describe("validateTeamName — Team-name validation and trimming (Property 5)", () => {
  it("accepts iff the trimmed length is 1..100, returning the trimmed value", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const trimmed = raw.trim();
        const shouldAccept =
          trimmed.length >= 1 && trimmed.length <= MAX_TEAM_NAME;

        const result = validateTeamName(raw);

        expect(result.ok).toBe(shouldAccept);
        if (result.ok) {
          expect(result.value).toBe(trimmed);
        } else {
          expect(result.reason).toBe("invalid_team_name");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("rejects empty and all-whitespace inputs", () => {
    fc.assert(
      fc.property(
        // Strings composed solely of whitespace characters (possibly empty).
        fc.string({
          unit: fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"),
          minLength: 0,
          maxLength: 20,
        }),
        (blank) => {
          const result = validateTeamName(blank);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("invalid_team_name");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts a padded name whose trimmed core is 1..100 chars, and rejects when the core exceeds 100", () => {
    fc.assert(
      fc.property(
        // A non-whitespace core of a bounded length, padded with surrounding
        // whitespace. The core length decides acceptance regardless of padding.
        fc.integer({ min: 1, max: 130 }).chain((coreLen) =>
          fc.record({
            core: fc.constant("x".repeat(coreLen)),
            pad: fc.string({
              unit: fc.constantFrom(" ", "\t", "\n"),
              minLength: 0,
              maxLength: 5,
            }),
          }),
        ),
        ({ core, pad }) => {
          const raw = `${pad}${core}${pad}`;
          const result = validateTeamName(raw);
          const shouldAccept = core.length <= MAX_TEAM_NAME;

          expect(result.ok).toBe(shouldAccept);
          if (result.ok) {
            expect(result.value).toBe(core);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: game-setup-lobby, Property 6: Create-team count gate
 *
 * For any current team count, `decideCreateTeam` (given a valid name) permits
 * creating a new Team if and only if the count is fewer than `MAX_TEAMS` (4);
 * at 4 or more it returns `team_limit_reached`.
 *
 * Validates: Requirements 4.2, 4.3
 */
describe("decideCreateTeam — Create-team count gate (Property 6)", () => {
  it("permits iff existing team count < MAX_TEAMS", () => {
    fc.assert(
      fc.property(
        // A count of existing teams, spanning below, at, and above the bound.
        fc.integer({ min: 0, max: MAX_TEAMS + 3 }),
        (count) => {
          // Distinct colors so the count is the only variable under test. When
          // count exceeds the palette, pad with synthetic distinct colors — the
          // gate is on length, not palette membership.
          const existingColors = Array.from({ length: count }, (_, i) =>
            i < TEAM_COLORS.length ? TEAM_COLORS[i] : `#custom${i}`,
          );

          const result = decideCreateTeam(existingColors, "Valid Name");
          const shouldPermit = count < MAX_TEAMS;

          expect(result.ok).toBe(shouldPermit);
          if (!result.ok) {
            expect(result.reason).toBe("team_limit_reached");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects an invalid name before consulting the count gate", () => {
    // An invalid name is rejected as invalid_team_name regardless of count,
    // including when the count is under the limit.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_TEAMS - 1 }), (count) => {
        const existingColors = TEAM_COLORS.slice(0, count);
        const result = decideCreateTeam(existingColors, "   ");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("invalid_team_name");
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: game-setup-lobby, Property 7: Assigned team color is distinct from
 * existing teams
 *
 * For any set of existing Team colors drawn from `TEAM_COLORS` whose size is
 * fewer than `MAX_TEAMS`, `decideCreateTeam` (given a valid name) assigns a
 * color that is present in `TEAM_COLORS` but not present in the existing-color
 * set.
 *
 * Validates: Requirements 4.4
 */
describe("decideCreateTeam — Assigned color distinct from existing (Property 7)", () => {
  it("assigns a palette color not already in use", () => {
    fc.assert(
      fc.property(
        // A subset of the palette with size strictly fewer than MAX_TEAMS, so a
        // free palette color is guaranteed to exist.
        fc
          .subarray([...TEAM_COLORS], {
            minLength: 0,
            maxLength: TEAM_COLORS.length,
          })
          .filter((sub) => sub.length < MAX_TEAMS),
        (existingColors) => {
          const result = decideCreateTeam(existingColors, "Valid Name");

          // Creation must be permitted: the subset size is below the limit.
          expect(result.ok).toBe(true);
          if (result.ok) {
            // Assigned color is a real palette entry and is distinct from every
            // existing color.
            expect(TEAM_COLORS).toContain(result.color);
            expect(existingColors).not.toContain(result.color);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
