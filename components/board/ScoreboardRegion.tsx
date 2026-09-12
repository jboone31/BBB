"use client";

/**
 * Scoreboard_Region wireframe for the Game_Board (design §Components 4; Task 8.3;
 * Requirements 4.1, 4.2, 4.3, 4.4, 4.5).
 *
 * This presentational component renders the placeholder scoreboard surface: one
 * row per Team in the Game (the Game has between 2 and 4 Teams, R4.1). Each row
 * surfaces the four things the scoreboard wireframe promises:
 *
 *   - the Team's assigned color (R4.2) — a color swatch plus the Team name;
 *   - a placeholder score value (R4.3) — a fixed "—" stand-in, not a real score;
 *   - a placeholder claimed-bars area (R4.4) — an empty stand-in region;
 *
 * and the Region as a whole carries a "later feature" label explaining that live
 * scores and claimed bars are provided by a later feature (R4.5).
 *
 * It is intentionally *presentational*: it owns no state, performs no I/O, and
 * derives everything it renders from the {@link BoardTeamView}[] the page (Task
 * 11) folds out of the event log. It renders whatever Teams it is given; the
 * 2–4-Team invariant (R4.1) is a property of the Game data, and the co-located
 * property test (Task 8.4) exercises it across the 2–4 range.
 *
 * Test-friendly markers (so Task 8.4's property test can assert one-row-per-team
 * with color / score / claimed-bars without depending on styling):
 *   - the row container is a `role="table"` region labelled "Scoreboard";
 *   - each Team row is a `role="row"` with `data-testid="scoreboard-row"` and a
 *     `data-team-id={team.id}` attribute;
 *   - within a row, the color swatch carries `data-testid="team-color"` and a
 *     `data-color={team.color}` attribute (its style also uses the color);
 *   - the placeholder score carries `data-testid="team-score"`;
 *   - the placeholder claimed-bars area carries `data-testid="claimed-bars"`;
 *   - the later-feature label carries `data-testid="scoreboard-later-feature"`.
 *
 * Mobile-first constraints (R9.1): a single-column flex layout that fits a
 * 320–430px viewport with no horizontal overflow (inherited `box-sizing:
 * border-box`, `width: 100%`, `maxWidth: 100%`).
 */

import type { BoardTeamView } from "@/lib/gameboard/events";

export interface ScoreboardRegionProps {
  /**
   * The Teams to render, one placeholder row each (R4.1). Supplied by the page
   * from the folded {@link import("@/lib/gameboard/events").GameBoardView}.
   */
  readonly teams: readonly BoardTeamView[];
}

/** The placeholder score stand-in shown on every row (R4.3 — not a real score). */
const PLACEHOLDER_SCORE = "—";

export default function ScoreboardRegion({
  teams,
}: ScoreboardRegionProps): React.JSX.Element {
  return (
    <section
      aria-label="Scoreboard"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      {/* The rows container. role="table" + labelled rows give the property test
          (Task 8.4) a stable structure to count one row per Team. */}
      <div
        role="table"
        aria-label="Team scores and claimed bars"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          width: "100%",
          maxWidth: "100%",
        }}
      >
        {teams.map((team) => (
          <div
            key={team.id}
            role="row"
            data-testid="scoreboard-row"
            data-team-id={team.id}
            aria-label={`Team ${team.name}`}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "0.75rem",
              width: "100%",
              maxWidth: "100%",
              padding: "0.6rem",
              border: "1px solid #888",
              borderRadius: "0.5rem",
              boxSizing: "border-box",
            }}
          >
            {/* Team color (R4.2): a swatch tinted with the Team's color, plus the
                name. The data-color marker exposes the raw color to the test. */}
            <span
              data-testid="team-color"
              data-color={team.color}
              aria-label={`${team.name} color`}
              style={{
                flex: "0 0 auto",
                width: "1.25rem",
                height: "1.25rem",
                borderRadius: "0.25rem",
                border: "1px solid #1a1a1a",
                background: team.color,
              }}
            />
            <span
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {team.name}
            </span>

            {/* Placeholder score (R4.3): a fixed stand-in, never a real score. */}
            <span
              data-testid="team-score"
              aria-label={`${team.name} score (placeholder)`}
              style={{
                flex: "0 0 auto",
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
              }}
            >
              {PLACEHOLDER_SCORE}
            </span>

            {/* Placeholder claimed-bars area (R4.4): an empty stand-in region. */}
            <span
              data-testid="claimed-bars"
              aria-label={`${team.name} claimed bars (placeholder)`}
              style={{
                flex: "0 0 auto",
                minWidth: "3rem",
                fontSize: "0.85rem",
                color: "#666",
              }}
            >
              claimed bars
            </span>
          </div>
        ))}
      </div>

      {/* Later-feature label (R4.5). */}
      <p
        data-testid="scoreboard-later-feature"
        style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}
      >
        Live scores and claimed bars are provided by a later feature.
      </p>
    </section>
  );
}
