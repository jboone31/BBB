import { describe, expect, it } from "vitest";

import {
  MAX_TEAM_NAME,
  TEAM_COLORS,
  decideCreateTeam,
  validateTeamName,
} from "./team";

/**
 * Unit tests for team validation and creation decision (Task 4.5).
 *
 * These cover the concrete color-assignment ordering (first free palette color)
 * and the exact result shapes returned by `validateTeamName` and
 * `decideCreateTeam`, complementing the property tests in
 * `team.property.test.ts`.
 *
 * Requirements: 4.4
 */

describe("validateTeamName — result shapes and boundaries", () => {
  it("accepts a simple name and returns the trimmed value", () => {
    expect(validateTeamName("Red Team")).toEqual({
      ok: true,
      value: "Red Team",
    });
  });

  it("trims surrounding whitespace from an accepted name", () => {
    expect(validateTeamName("  Blue  ")).toEqual({ ok: true, value: "Blue" });
  });

  it("rejects the empty string", () => {
    expect(validateTeamName("")).toEqual({
      ok: false,
      reason: "invalid_team_name",
    });
  });

  it("rejects an all-whitespace name", () => {
    expect(validateTeamName("   \t\n ")).toEqual({
      ok: false,
      reason: "invalid_team_name",
    });
  });

  it("accepts a name whose trimmed length is exactly MAX_TEAM_NAME", () => {
    const name = "a".repeat(MAX_TEAM_NAME);
    expect(validateTeamName(name)).toEqual({ ok: true, value: name });
  });

  it("rejects a name whose trimmed length exceeds MAX_TEAM_NAME by one", () => {
    const name = "a".repeat(MAX_TEAM_NAME + 1);
    expect(validateTeamName(name)).toEqual({
      ok: false,
      reason: "invalid_team_name",
    });
  });
});

describe("decideCreateTeam — color-assignment ordering (first free palette color)", () => {
  it("assigns the first palette color when no teams exist yet", () => {
    const result = decideCreateTeam([], "First");
    expect(result).toEqual({ ok: true, color: TEAM_COLORS[0] });
  });

  it("skips the first color when it is taken and assigns the next free entry", () => {
    const result = decideCreateTeam([TEAM_COLORS[0]], "Second");
    expect(result).toEqual({ ok: true, color: TEAM_COLORS[1] });
  });

  it("assigns the first free color even when a later palette color is already used", () => {
    // TEAM_COLORS[1] is in use but [0] is free — the first free entry is [0].
    const result = decideCreateTeam([TEAM_COLORS[1]], "Third");
    expect(result).toEqual({ ok: true, color: TEAM_COLORS[0] });
  });

  it("assigns the last remaining palette color when three are taken", () => {
    const result = decideCreateTeam(
      [TEAM_COLORS[0], TEAM_COLORS[1], TEAM_COLORS[2]],
      "Fourth",
    );
    expect(result).toEqual({ ok: true, color: TEAM_COLORS[3] });
  });
});

describe("decideCreateTeam — rejection result shapes", () => {
  it("returns team_limit_reached when the palette-sized limit is met", () => {
    const result = decideCreateTeam([...TEAM_COLORS], "Fifth");
    expect(result).toEqual({ ok: false, reason: "team_limit_reached" });
  });

  it("returns invalid_team_name for an all-whitespace name under the count limit", () => {
    const result = decideCreateTeam([], "   ");
    expect(result).toEqual({ ok: false, reason: "invalid_team_name" });
  });

  it("checks name validity before the count gate", () => {
    // Even at the team limit, an invalid name reports invalid_team_name.
    const result = decideCreateTeam([...TEAM_COLORS], "");
    expect(result).toEqual({ ok: false, reason: "invalid_team_name" });
  });
});
