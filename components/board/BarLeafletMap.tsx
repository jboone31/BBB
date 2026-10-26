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
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Tooltip,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type { MapOverlay } from "@/lib/gameboard/cardBehavior";
import type {
  ClaimAction,
  ClaimAttestation,
} from "@/components/board/MapRegion";
import type { ClaimBlock } from "@/lib/claims/blocks";
import { CLAIM_BLOCKED_HEADLINE } from "@/lib/cards/toasts";
import { getCardMetadata } from "@/lib/cards/catalog";
import { formatClockTime } from "@/lib/cards/templates";
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
  /**
   * Card-behavior map overlays to draw additively on top of the bar markers
   * (`selectMapOverlays`, `lib/gameboard/cardBehavior.ts`; Requirements 10.9,
   * 11.6, 12.8). The board page computes these for the viewing team and passes
   * the resulting list in (task 10.6); this component never folds events.
   *
   * Overlay kinds and how each renders:
   * - `restriction`: a dashed outline ({@link CircleMarker}) on the restricted
   *   bar, shown only to the viewing team.
   * - `bar_lock`: a Crop Dusting lock badge (🔒) on a locked bar, for
   *   non-casters.
   * - `radius_lock`: a Cancel Culture {@link Circle} of
   *   `radiusMiles * METERS_PER_MILE` meters centered on `center`;
   *   dashed/translucent while `phase === "pending"`, solid while `"active"`.
   * - `bonus_window`: a Happy Hour "+5" badge on a bar.
   *
   * Every overlay carries a text `label` that is rendered (tooltip / aria /
   * badge text) so color is never the only signal. Bar-anchored overlays are
   * positioned by matching `overlay.barKey` to {@link CandidateBar.id} — the
   * same bar id the markers and the {@link claims} prop use; `radius_lock` uses
   * its own `center` coordinates directly. An overlay whose `barKey` has no
   * matching candidate bar is skipped.
   */
  readonly overlays?: readonly MapOverlay[];
  /**
   * Card-behavior claim blocks keyed by bar id (`barKey` === `CandidateBar.id`).
   * A non-empty entry makes the bar's popup show {@link CLAIM_BLOCKED_HEADLINE}
   * plus the blocking cards and each timed block's end Clock_Time
   * (Requirements 3.10, 4.5). Owned/computed by {@link MapRegion} (task 10.6).
   */
  readonly claimBlocksByBar?: Readonly<Record<string, readonly ClaimBlock[]>>;
  /** Bar ids where the own team may take a Happy Hour bonus claim (13.4). */
  readonly bonusClaimableBarIds?: readonly string[];
  /** Post a bonus claim (`action: "bonus"`) for the given bar. */
  readonly onBonusClaim?: (barId: string) => void | Promise<void>;
}

/**
 * The human-readable label for one claim block, with a timed block's end
 * Clock_Time appended when it carries an `endsAt` (Requirement 3.10).
 */
function describeClaimBlock(block: ClaimBlock): string {
  const card = getCardMetadata(block.slug).name;
  if ("endsAt" in block) {
    return `${card} — until ${formatClockTime(block.endsAt)}`;
  }
  if (block.kind === "challenge") {
    return `${card} — resolve the challenge first`;
  }
  if (block.kind === "pioneer") {
    return block.reason === "finish_bar"
      ? `${card} — can't claim the finish bar next`
      : `${card} — claim an unclaimed bar next`;
  }
  // scenic
  return `${card} — claim farther from the finish next`;
}

/**
 * Meters per statute mile. Leaflet's {@link Circle} takes a radius in meters, so
 * a Cancel Culture `radius_lock` (given in miles) is converted with
 * `radiusMiles * METERS_PER_MILE`. 0.25 mi (`CANCEL_CULTURE_RADIUS_MILES`) →
 * 402.336 m.
 */
const METERS_PER_MILE = 1609.344;

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

/**
 * Build a small text badge icon for a bar-anchored overlay (Crop Dusting lock,
 * Happy Hour "+5"). The glyph is a perceivable symbol and the full `label` is
 * carried as the element's `title`/`aria-label` so the meaning never depends on
 * color alone. The badge sits above-right of the bar pin.
 */
function makeBadgeIcon(glyph: string, label: string): L.DivIcon {
  const safeLabel = label.replace(/"/g, "&quot;");
  const html = `
    <span
      role="img"
      aria-label="${safeLabel}"
      title="${safeLabel}"
      style="
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:20px;height:20px;
        padding:0 4px;
        font-size:12px;font-weight:700;line-height:1;
        color:#1a1a1a;
        background:#ffffff;
        border:2px solid #1a1a1a;
        border-radius:10px;
        box-shadow:0 1px 3px rgba(0,0,0,0.4);
      ">${glyph}</span>`;
  return L.divIcon({
    html,
    className: "bbb-overlay-badge",
    iconSize: [24, 20],
    // Offset up-and-right of the bar pin so it does not sit on top of it.
    iconAnchor: [-6, 30],
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
  overlays = [],
  claimBlocksByBar,
  bonusClaimableBarIds,
  onBonusClaim,
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

  // Position lookup for bar-anchored overlays: candidate-bar id → [lat, lng].
  // Overlays carry a `barKey` equal to CandidateBar.id (the same id the markers
  // and the `claims` prop use); radius_lock overlays carry their own center.
  const barPositionById = useMemo(() => {
    const byId = new Map<string, [number, number]>();
    for (const bar of CANDIDATE_BARS) {
      byId.set(bar.id, [bar.lat, bar.lng]);
    }
    return byId;
  }, []);

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
        // Card-behavior claim blocks: either the pre-check surfaced blocks for
        // this bar, or the server rejected the claim with a `blocked` error.
        const barBlocks = claimBlocksByBar?.[bar.id] ?? [];
        const serverBlocked =
          mutationError?.barId === bar.id &&
          /blocked/i.test(mutationError.message);
        const showBlocked = barBlocks.length > 0 || serverBlocked;
        const bonusClaimable = bonusClaimableBarIds?.includes(bar.id) ?? false;
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
                {showBlocked ? (
                  <div
                    role="alert"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.25rem",
                      fontSize: "0.8rem",
                      color: "#b00020",
                    }}
                  >
                    <strong>{CLAIM_BLOCKED_HEADLINE}</strong>
                    {barBlocks.length > 0 ? (
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: "1.1rem",
                          listStyle: "disc",
                        }}
                      >
                        {barBlocks.map((block, index) => (
                          <li key={`${block.slug}:${index}`}>
                            {describeClaimBlock(block)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
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
                {bonusClaimable && onBonusClaim !== undefined ? (
                  <button
                    type="button"
                    aria-label={`Claim Happy Hour bonus at ${bar.name} for ${ownTeamName}`}
                    disabled={readOnly || pending || ownTeamId === ""}
                    onClick={() => void onBonusClaim(bar.id)}
                    style={{
                      minHeight: "44px",
                      padding: "0.5rem 0.75rem",
                      fontSize: "0.95rem",
                      fontWeight: 600,
                      borderRadius: "0.5rem",
                      border: "1px solid #1a7a1a",
                      background: "#eafbea",
                      color: "#1a7a1a",
                      cursor: pending ? "wait" : "pointer",
                    }}
                  >
                    Claim bonus (+5)
                  </button>
                ) : null}
              </div>
            </Popup>
          </Marker>
        );
      })}
      {overlays.map((overlay) => {
        const key = `${overlay.effectId}:${overlay.barKey}`;
        switch (overlay.kind) {
          case "radius_lock": {
            // Cancel Culture zone: a circle of radiusMiles converted to meters,
            // dashed/translucent while pending and solid once active (12.8).
            const pending = overlay.phase === "pending";
            return (
              <Circle
                key={key}
                center={[overlay.center.lat, overlay.center.lng]}
                radius={overlay.radiusMiles * METERS_PER_MILE}
                pathOptions={{
                  color: "#b00020",
                  weight: 2,
                  dashArray: pending ? "6" : undefined,
                  fillColor: "#b00020",
                  fillOpacity: pending ? 0.1 : 0.2,
                }}
              >
                <Tooltip direction="top" sticky>
                  {overlay.label}
                </Tooltip>
              </Circle>
            );
          }

          case "restriction": {
            // Dashed outline on a bar the viewing team cannot claim next (10.9).
            const pos = barPositionById.get(overlay.barKey);
            if (pos === undefined) {
              return null;
            }
            return (
              <CircleMarker
                key={key}
                center={pos}
                radius={16}
                pathOptions={{
                  color: "#b00020",
                  weight: 2,
                  dashArray: "4",
                  fill: false,
                }}
              >
                <Tooltip direction="top">{overlay.label}</Tooltip>
              </CircleMarker>
            );
          }

          case "bar_lock": {
            // Crop Dusting lock badge on a bar, shown to non-casters (11.6).
            const pos = barPositionById.get(overlay.barKey);
            if (pos === undefined) {
              return null;
            }
            return (
              <Marker
                key={key}
                position={pos}
                icon={makeBadgeIcon("🔒", overlay.label)}
                interactive={false}
                keyboard={false}
              >
                <Tooltip direction="right">{overlay.label}</Tooltip>
              </Marker>
            );
          }

          case "bonus_window": {
            // Happy Hour "+5" badge on a bar.
            const pos = barPositionById.get(overlay.barKey);
            if (pos === undefined) {
              return null;
            }
            return (
              <Marker
                key={key}
                position={pos}
                icon={makeBadgeIcon("+5", overlay.label)}
                interactive={false}
                keyboard={false}
              >
                <Tooltip direction="right">{overlay.label}</Tooltip>
              </Marker>
            );
          }

          default:
            return null;
        }
      })}
    </MapContainer>
  );
}
