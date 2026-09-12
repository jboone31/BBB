// @vitest-environment jsdom
//
// Property test for the Card_Play_Wireframe target list (Task 9.2).
//
// Feature: in-game-landing-wireframe, Property 8: Target list excludes own Team
// and includes every other Team.
//
// Requirements 6.2 — WHERE a placeholder card targets another Team, THE
// Card_Play_Wireframe SHALL present a target-selection control listing every
// other Team in the Game and excluding the current Player's own Team.
//
// APPROACH — component + oracle, exercising the real render path:
//   `CardPlayWireframe` is a purely presentational client component. For a
//   targeting card ({@link PlaceholderCard.targetsTeam} `true`) it renders a
//   target group `role="group" aria-label="Choose a target team"` whose child
//   `<button>`s each carry a Team's name as their accessible name; the caller's
//   own Team is never rendered. So we render it with a targeting placeholder
//   card, a generated set of 2–4 distinct Teams, and an `ownTeamId` chosen from
//   within that set, then enumerate the buttons inside the target group and
//   compare their accessible names against the pure oracle `teams minus own
//   team` — asserting set equality and the absence of the own Team.
//
//   The generator produces 2–4 Teams with distinct ids and distinct, non-empty
//   names (so a button's accessible name maps unambiguously back to one Team),
//   then picks `ownTeamId` from within the set — matching the real invariant
//   that the current Player belongs to one of the Game's Teams.
//
//   The tree is unmounted between iterations so each run starts clean.
//   `@vitest-environment jsdom` opts THIS FILE into a DOM (the project default
//   is `node`, see vitest.config.mts), matching the other component tests.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type { PlaceholderCard } from "@/lib/gameboard/placeholderCards";

import CardPlayWireframe from "./CardPlayWireframe";

afterEach(() => {
  cleanup();
});

/** A targeting placeholder card — drives the target-selection flow (R6.2). */
const TARGETING_CARD: PlaceholderCard = {
  id: "placeholder-card",
  label: "Detour",
  targetsTeam: true,
};

/** The colors a placeholder Team row can carry (cosmetic here). */
const COLOR_ARB = fc.constantFrom("#e11", "#1a1", "#11e", "#ee1");

/**
 * An arbitrary set of 2–4 Teams with distinct ids and distinct, non-empty names,
 * paired with an `ownTeamId` chosen from within the set.
 *
 * Uniqueness of both id and name is guaranteed *by construction*: each Team gets
 * a per-index prefix (`t0-`, `t1-`, …) on both its id and name, so an arbitrary
 * generated suffix can never collide across Teams. This keeps a rendered
 * button's text a unique key back to one Team without paying for generator
 * retries. Choosing `ownTeamId` from within the set mirrors the real invariant
 * that the current Player is on one of the Game's Teams. A live Game has 2–4
 * Teams (Glossary), so the set size is bounded to [2, 4].
 */
const gameArb: fc.Arbitrary<{
  teams: BoardTeamView[];
  ownTeamId: string;
}> = fc
  .integer({ min: 2, max: 4 })
  .chain((teamCount) =>
    fc
      .tuple(
        // A distinguishing suffix + color per Team; the index prefix guarantees
        // distinct ids and names regardless of the generated suffixes.
        fc.array(
          fc.record({
            suffix: fc.string({ maxLength: 20 }),
            color: COLOR_ARB,
          }),
          { minLength: teamCount, maxLength: teamCount },
        ),
        fc.integer({ min: 0, max: teamCount - 1 }),
      )
      .map(([parts, ownIndex]) => {
        const teams: BoardTeamView[] = parts.map((part, index) => ({
          id: `t${index}-${part.suffix}`,
          name: `Team ${index} ${part.suffix}`,
          color: part.color,
        }));
        return { teams, ownTeamId: teams[ownIndex].id };
      }),
  );

describe("Feature: in-game-landing-wireframe, Property 8: Target list excludes own Team and includes every other Team", () => {
  it("renders exactly every other Team as a target option and never the own Team", () => {
    fc.assert(
      fc.property(gameArb, ({ teams, ownTeamId }) => {
        const { container, unmount } = render(
          <CardPlayWireframe
            card={TARGETING_CARD}
            teams={teams}
            ownTeamId={ownTeamId}
            onConfirm={() => {}}
            onCancel={() => {}}
          />,
        );

        try {
          // The target-selection control is the labeled group
          // (`role="group" aria-label="Choose a target team"`); the options are
          // the <button>s within it, each whose text is a Team name. Query the
          // rendered container directly (fast, no whole-document a11y scan).
          const group = container.querySelector<HTMLElement>(
            '[role="group"][aria-label="Choose a target team"]',
          );
          expect(group).not.toBeNull();

          // The decorative swatch <span> is empty, so a button's textContent is
          // exactly its Team name — compare raw (no trimming) so a name with
          // surrounding whitespace still maps back to its Team unchanged.
          const renderedNames = Array.from(
            group!.querySelectorAll("button"),
          ).map((button) => button.textContent ?? "");

          const ownTeam = teams.find((team) => team.id === ownTeamId)!;
          const expectedNames = teams
            .filter((team) => team.id !== ownTeamId)
            .map((team) => team.name);

          // Set equality: the rendered target options are exactly the other
          // Teams' names — every other Team is present, nothing extra (R6.2).
          expect([...renderedNames].sort()).toEqual([...expectedNames].sort());

          // The own Team is never rendered as a target option (R6.2).
          expect(renderedNames).not.toContain(ownTeam.name);
        } finally {
          unmount();
        }
      }),
      { numRuns: 100 },
    );
  });
});
