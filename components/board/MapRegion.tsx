"use client";

/**
 * Map_Region for the Game_Board (replaces the former Bars_Region).
 *
 * Owns the local, wireframe claim state (bar id → claiming team ids) and renders
 * the candidate bars on a real, pannable/zoomable map. The map itself
 * ({@link BarLeafletMap}) is a Leaflet + OpenStreetMap surface that touches the
 * DOM directly, so it is loaded through a `dynamic(..., { ssr: false })`
 * boundary and only ever mounts in the browser; during SSR (and before the
 * chunk loads) a neutral placeholder renders in its place.
 *
 * Claiming rule: a client may only claim or unclaim a bar for the Team it is on
 * ({@link MapRegionProps.ownTeamId}). Every marker still shows *all* teams'
 * claims (its color splits 2/3/4 ways when multiple teams claim it), but the
 * claim/unclaim control in a marker's popup only ever toggles the current
 * player's own Team.
 *
 * This is a wireframe: nothing here persists, POSTs, appends a Game_Event, or
 * affects scoring. It is local UI state only.
 */

import dynamic from "next/dynamic";
import { useState } from "react";

import type { BoardTeamView } from "@/lib/gameboard/events";
import { EMPTY_CLAIMS, toggleClaim, type ClaimState } from "@/lib/map/claims";

/**
 * The Leaflet map, loaded client-side only. Leaflet needs `window`, so it must
 * not render during SSR; the placeholder fills the map area until the chunk
 * loads in the browser.
 */
const BarLeafletMap = dynamic(() => import("./BarLeafletMap"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        color: "#555",
        border: "1px solid #888",
        borderRadius: "0.5rem",
        background: "#f5f5f5",
      }}
    >
      Loading map…
    </div>
  ),
});

export interface MapRegionProps {
  /**
   * All Teams in the game, each with its assigned color. Used to color every
   * marker's claim split (not just the current player's Team).
   */
  readonly teams: readonly BoardTeamView[];
  /**
   * The one Team this client may claim/unclaim bars for — the Team the current
   * player is on. Only this Team's claim is toggled by the map controls.
   */
  readonly ownTeamId: string;
}

export default function MapRegion({
  teams,
  ownTeamId,
}: MapRegionProps): React.JSX.Element {
  // Local-only claim state (wireframe): bar id → claiming team ids. Nothing here
  // persists or writes an event.
  const [claims, setClaims] = useState<ClaimState>(EMPTY_CLAIMS);

  // A pin tap toggles ONLY the current player's own Team's claim (R: you can
  // only claim for the team you are on).
  const handleToggle = (barId: string): void => {
    if (ownTeamId === "") {
      return;
    }
    setClaims((prev) => toggleClaim(prev, barId, ownTeamId));
  };

  const ownTeam = teams.find((t) => t.id === ownTeamId);

  return (
    <section
      aria-label="Map"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
        Pan and zoom the map, then tap a bar to claim or unclaim it for{" "}
        {ownTeam !== undefined ? (
          <span style={{ fontWeight: 600, color: "#1a1a1a" }}>
            {ownTeam.name}
          </span>
        ) : (
          "your team"
        )}
        . You can only claim for your own team. (Wireframe — claims are not
        saved and do not affect scoring.)
      </p>

      {/* The map surface. A tall, full-width area that fits a narrow viewport
          without horizontal overflow; Leaflet owns pan/zoom within it. */}
      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          height: "min(70vh, 30rem)",
          boxSizing: "border-box",
        }}
      >
        <BarLeafletMap
          claims={claims}
          teams={teams}
          ownTeamId={ownTeamId}
          onToggle={handleToggle}
        />
      </div>
    </section>
  );
}
