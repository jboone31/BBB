// @vitest-environment jsdom
//
// Property test for the Scoreboard_Region one-row-per-Team rendering (Task 8.4).
//
// Feature: in-game-landing-wireframe, Property 6: Scoreboard renders one row per
// Team with color, score, and claimed-bars.
//
// Requirements 4.1, 4.2, 4.3, 4.4 — for any GameBoardView with between 2 and 4
// Teams, the Scoreboard_Region renders exactly one placeholder row per Team, and
// each row surfaces that Team's color (R4.2), a placeholder score value (R4.3),
// and a placeholder claimed-bars area (R4.4).
//
// APPROACH — component + structural oracle:
//   `ScoreboardRegion` is a purely presentational client component: it owns no
//   state and renders one row per `BoardTeamView` it is handed, tagging each with
//   stable, style-independent markers. So we generate a Teams array of size 2–4
//   with distinct ids and arbitrary names/colors, render the component, and
//   assert against those markers:
//     - exactly one `data-testid="scoreboard-row"` per Team (R4.1),
//     - each row carries the Team's `data-team-id` and, within it, a
//       `data-testid="team-color"` swatch whose `data-color` equals that Team's
//       color (R4.2),
//     - each row contains a `data-testid="team-score"` element (R4.3),
//     - each row contains a `data-testid="claimed-bars"` element (R4.4).
//
//   The generator biases toward the 2/3/4-Team boundary (R4.1's whole range) and
//   toward tricky color/name values (empty, whitespace, duplicate colors, unicode)
//   so runs land on the edges rather than deep in the interior. Team ids are made
//   distinct via an index suffix so each row maps to exactly one Team.
//
//   The tree is unmounted between iterations so each run starts from a clean DOM.
//   `@vitest-environment jsdom` opts THIS FILE into a DOM (the project default is
//   `node`, see vitest.config.mts), matching the other component tests.

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import type { BoardTeamView } from "@/lib/gameboard/events";

import ScoreboardRegion from "./ScoreboardRegion";

afterEach(() => {
  cleanup();
});

/**
 * A Team-field arbitrary biased toward the tricky values a color or name can
 * take: empty, whitespace, common CSS color forms, and arbitrary unicode text.
 */
const teamFieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("  "),
  fc.constant("#ff0000"),
  fc.constant("rebeccapurple"),
  fc.constant("rgb(0, 128, 255)"),
  fc.string({ maxLength: 24 }),
  fc.string({ unit: "grapheme", maxLength: 24 }),
);

/**
 * A Teams arbitrary of size 2–4 (R4.1's whole range) with distinct ids. Names
 * and colors are arbitrary (including duplicates across Teams); only the id is
 * forced distinct — via an index suffix — so each generated row maps to exactly
 * one Team.
 */
const teamsArb: fc.Arbitrary<readonly BoardTeamView[]> = fc
  .array(
    fc.record({
      name: teamFieldArb,
      color: teamFieldArb,
    }),
    { minLength: 2, maxLength: 4 },
  )
  .map((partials) =>
    partials.map((p, index) => ({
      id: `team-${index}-${Math.random().toString(36).slice(2, 8)}`,
      name: p.name,
      color: p.color,
    })),
  );

describe("Feature: in-game-landing-wireframe, Property 6: Scoreboard renders one row per Team with color, score, and claimed-bars", () => {
  it("renders exactly one row per Team, each surfacing color, score, and claimed-bars", () => {
    fc.assert(
      fc.property(teamsArb, (teams) => {
        const { container, unmount } = render(
          <ScoreboardRegion teams={teams} />,
        );

        const rows = container.querySelectorAll<HTMLElement>(
          '[data-testid="scoreboard-row"]',
        );

        // R4.1: exactly one placeholder row per Team.
        expect(rows.length).toBe(teams.length);

        // Each row maps to exactly one Team by id, with no duplicates or extras.
        const renderedTeamIds = Array.from(rows).map((row) =>
          row.getAttribute("data-team-id"),
        );
        const expectedTeamIds = teams.map((t) => t.id);
        expect(new Set(renderedTeamIds).size).toBe(teams.length);
        expect([...renderedTeamIds].sort()).toEqual(
          [...expectedTeamIds].sort(),
        );

        // Per-row assertions: color (R4.2), score (R4.3), claimed-bars (R4.4).
        for (const team of teams) {
          const matchingRows = Array.from(rows).filter(
            (row) => row.getAttribute("data-team-id") === team.id,
          );
          expect(matchingRows.length).toBe(1);
          const row = matchingRows[0]!;
          const scoped = within(row);

          // R4.2: the row surfaces this Team's color via a swatch whose
          // data-color equals the Team's assigned color.
          const colorEls = scoped.getAllByTestId("team-color");
          expect(colorEls.length).toBe(1);
          expect(colorEls[0].getAttribute("data-color")).toBe(team.color);

          // R4.3: the row surfaces a placeholder score value.
          expect(scoped.getAllByTestId("team-score").length).toBe(1);

          // R4.4: the row surfaces a placeholder claimed-bars area.
          expect(scoped.getAllByTestId("claimed-bars").length).toBe(1);
        }

        unmount();
      }),
      { numRuns: 100 },
    );
  });
});
