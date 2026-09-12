"use client";

/**
 * Region navigation for the Game_Board (design §Components 4; Task 8.1;
 * Requirements 2.1, 2.4, 2.5, 9.2).
 *
 * This presentational component renders the three primary navigation controls
 * of the Game_Board — one each for the Bars_Region, the Scoreboard_Region, and
 * the Cards_Region ({@link Region}, R2.1). It is intentionally *presentational*:
 * it owns no active-Region state and performs no navigation itself. The active
 * {@link Region} is passed in, and every activation is delegated to the
 * `onSelect` callback the page (Task 11) wires to its pure `selectRegion`
 * transition. Re-selecting the already-active Region is a page-level no-op
 * (R2.7); this component simply reports every activation.
 *
 * Behavior it guarantees:
 *  - All three controls are always rendered and operable so the Player can
 *    switch Regions without leaving the active one (R2.5). None is ever
 *    disabled — activating the active control is a harmless no-op upstream.
 *  - The control for the active Region is visually distinguished from the two
 *    non-active controls and marks itself with `aria-current="page"` so the
 *    distinction is exposed to assistive technology (R2.4).
 *
 * Mobile-first constraints (R9.2): a single-row flex layout that fits a
 * 320–430px viewport with no horizontal overflow (the controls share the width
 * equally with inherited `box-sizing: border-box`), and every control is at
 * least 44×44 CSS pixels (`--touch-target`).
 */

import type { Region } from "@/lib/gameboard/region";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

/** The three Regions in display order, each with its human-readable label (R2.1). */
const REGIONS: readonly { readonly region: Region; readonly label: string }[] =
  [
    { region: "bars", label: "Bars" },
    { region: "scoreboard", label: "Scoreboard" },
    { region: "cards", label: "Cards" },
  ];

export interface RegionNavProps {
  /** The currently active Region — its control is visually distinguished (R2.4). */
  readonly active: Region;
  /**
   * Called when the Player activates a Region's control. The page wires this to
   * its `selectRegion` transition; re-selecting the active Region is a no-op
   * upstream (R2.7), so this component reports the activation unconditionally.
   */
  readonly onSelect: (region: Region) => void;
}

export default function RegionNav({
  active,
  onSelect,
}: RegionNavProps): React.JSX.Element {
  return (
    <nav
      aria-label="Game board regions"
      style={{
        display: "flex",
        flexDirection: "row",
        gap: "0.5rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      {REGIONS.map(({ region, label }) => {
        const isActive = region === active;
        return (
          <button
            key={region}
            type="button"
            // Expose the active control to assistive technology (R2.4). Only the
            // active control carries aria-current; the others omit it.
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(region)}
            style={{
              // Share the row width equally so all three fit a narrow viewport
              // without horizontal overflow (R9.1/R9.2).
              flex: "1 1 0",
              minWidth: TOUCH_TARGET,
              minHeight: TOUCH_TARGET,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.6rem 0.5rem",
              fontSize: "1rem",
              fontWeight: isActive ? 700 : 500,
              textAlign: "center",
              borderRadius: "0.5rem",
              // Visually distinguish the active control from the two non-active
              // ones (R2.4): a heavier border, filled background, and inverted
              // text, mirroring the "current" affordance used elsewhere.
              border: isActive ? "2px solid #1a1a1a" : "1px solid #888",
              background: isActive ? "#1a1a1a" : "#ffffff",
              color: isActive ? "#ffffff" : "#1a1a1a",
              // All three controls stay operable at all times (R2.5).
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
