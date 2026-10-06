"use client";

/**
 * Leaflet + OpenStreetMap map for the Map_Region (client-only).
 *
 * Renders every candidate bar (see {@link CANDIDATE_BARS}) as a marker on a
 * pannable, zoomable Leaflet map backed by free OpenStreetMap raster tiles (no
 * API key required). Each marker's color reflects the bar's current claimers —
 * one team paints it solid, multiple teams split it into equal vertical bands
 * (2/3/4 ways) — using the same {@link colorSegments}/{@link segmentsToGradient}
 * helpers as the pure claim logic. Clicking a marker opens a popup with the bar
 * name and a single claim/unclaim control for the current player's own Team.
 *
 * This component touches the DOM/`window` directly through Leaflet, so it must
 * only ever render in the browser. It is loaded via a `dynamic(..., { ssr:
 * false })` boundary in {@link MapRegion}; it is never imported into a server
 * component or rendered during SSR.
 *
 * It is a wireframe: claims are local state owned by {@link MapRegion} and
 * passed in; nothing here persists, POSTs, or affects scoring.
 */

import { useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type {
  ClaimAction,
  ClaimAttestation,
} from "@/components/board/MapRegion";
import {
  CANDIDATE_BARS,
  computeBounds,
  type CandidateBar,
} from "@/lib/map/bars";
import {
  claimersOf,
  colorSegments,
  isClaimedBy,
  segmentsToGradient,
  type ClaimState,
} from "@/lib/map/claims";

export interface BarLeafletMapProps {
  /** Reducer-derived claim state: bar id → claiming team ids. */
  readonly claims: ClaimState;
  /** Teams whose colors may appear on markers (all teams in the game). */
  readonly teams: readonly BoardTeamView[];
  /** The one Team this client may claim/unclaim for (the player's own Team). */
  readonly ownTeamId: string;
  /** Submit a server-backed claim transition for the current player's team. */
  readonly onMutate: (
    barId: string,
    action: ClaimAction,
    attestation: ClaimAttestation,
  ) => void | Promise<void>;
  readonly pendingBarId?: string | null;
  readonly mutationError?: {
    readonly barId: string;
    readonly message: string;
  } | null;
  readonly readOnly?: boolean;
}

/** Build a Leaflet div-icon whose teardrop fill is the bar's color split. */
function makePinIcon(fill: string | null): L.DivIcon {
  const background = fill ?? "#ffffff";
  // A round pin with a pointer tail; the fill is either a solid color, a
  // multi-team linear-gradient, or white when unclaimed.
  const html = `
    <span style="
      display:block;
      width:22px;height:22px;
      border:2px solid #1a1a1a;
      border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:${background};
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    "></span>`;
  return L.divIcon({
    html,
    className: "bbb-bar-pin",
    iconSize: [22, 22],
    iconAnchor: [11, 22],
    popupAnchor: [0, -22],
  });
}

export default function BarLeafletMap({
  claims,
  teams,
  ownTeamId,
  onMutate,
  pendingBarId = null,
  mutationError = null,
  readOnly = false,
}: BarLeafletMapProps): React.JSX.Element {
  const [attestations, setAttestations] = useState<
    Record<string, ClaimAttestation>
  >({});
  // Center + a fitting zoom derived from the bars' bounding box. Computed once;
  // the bar set is static.
  const { center, bounds } = useMemo(() => {
    const b = computeBounds(CANDIDATE_BARS);
    const centerLatLng: [number, number] = [
      (b.minLat + b.maxLat) / 2,
      (b.minLng + b.maxLng) / 2,
    ];
    const latLngBounds = L.latLngBounds(
      [b.minLat, b.minLng],
      [b.maxLat, b.maxLng],
    );
    return { center: centerLatLng, bounds: latLngBounds };
  }, []);

  const ownTeamName =
    teams.find((t) => t.id === ownTeamId)?.name ?? "your team";

  return (
    <MapContainer
      center={center}
      bounds={bounds}
      boundsOptions={{ padding: [24, 24] }}
      scrollWheelZoom
      style={{
        width: "100%",
        height: "100%",
        borderRadius: "0.5rem",
      }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {CANDIDATE_BARS.map((bar: CandidateBar) => {
        const segments = colorSegments(claims, bar.id, teams);
        const fill = segmentsToGradient(segments);
        const claimedByOwn = isClaimedBy(claims, bar.id, ownTeamId);
        const claimerCount = claimersOf(claims, bar.id).length;
        const attestation = attestations[bar.id] ?? {
          allMembersPresent: true,
          finishedDrinkCount: 1,
        };
        const pending = pendingBarId === bar.id;
        const error =
          mutationError?.barId === bar.id ? mutationError.message : null;
        return (
          <Marker
            key={bar.id}
            position={[bar.lat, bar.lng]}
            icon={makePinIcon(fill)}
          >
            <Popup>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  minWidth: "10rem",
                }}
              >
                <strong style={{ fontSize: "0.95rem" }}>{bar.name}</strong>
                <span style={{ fontSize: "0.8rem", color: "#555" }}>
                  {claimerCount === 0
                    ? "Unclaimed"
                    : `Claimed by ${claimerCount} team${claimerCount === 1 ? "" : "s"}`}
                </span>
                <label style={{ fontSize: "0.8rem" }}>
                  <input
                    type="checkbox"
                    checked={attestation.allMembersPresent}
                    onChange={(event) =>
                      setAttestations((current) => ({
                        ...current,
                        [bar.id]: {
                          ...attestation,
                          allMembersPresent: event.target.checked,
                        },
                      }))
                    }
                  />{" "}
                  Everyone is present
                </label>
                <label style={{ fontSize: "0.8rem" }}>
                  Finished drinks{" "}
                  <input
                    aria-label={`${bar.name} finished drinks`}
                    type="number"
                    min={0}
                    step={1}
                    value={attestation.finishedDrinkCount}
                    onChange={(event) =>
                      setAttestations((current) => ({
                        ...current,
                        [bar.id]: {
                          ...attestation,
                          finishedDrinkCount: Math.max(
                            0,
                            Number.parseInt(event.target.value, 10) || 0,
                          ),
                        },
                      }))
                    }
                    style={{ width: "3.5rem" }}
                  />
                </label>
                {error !== null ? (
                  <span
                    role="alert"
                    style={{ fontSize: "0.8rem", color: "#b00020" }}
                  >
                    {error}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={
                    readOnly ||
                    pending ||
                    ownTeamId === "" ||
                    !attestation.allMembersPresent
                  }
                  onClick={() =>
                    void onMutate(
                      bar.id,
                      claimedByOwn ? "unclaim" : "claim",
                      attestation,
                    )
                  }
                  style={{
                    minHeight: "44px",
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.95rem",
                    fontWeight: 600,
                    borderRadius: "0.5rem",
                    border: "1px solid #1a1a1a",
                    background: claimedByOwn ? "#ffffff" : "#1a1a1a",
                    color: claimedByOwn ? "#1a1a1a" : "#ffffff",
                    cursor: pending ? "wait" : "pointer",
                  }}
                >
                  {pending
                    ? "Saving…"
                    : claimedByOwn
                      ? `Unclaim for ${ownTeamName}`
                      : `Claim for ${ownTeamName}`}
                </button>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
