"use client";

/**
 * Card_Play_Panel for the Game_Board (brawl-deck-architecture Tasks 8, 9;
 * card-behavior Task 10.2), replacing the former Card_Play_Wireframe.
 *
 * Presented when a player plays a held card. It drives the real targeting flow
 * against committed state and reports the chosen target(s) + validated casting
 * `params` to `onConfirm`, which the page POSTs to the real `/cards/play` route
 * (R3.1).
 *
 * Flow (top to bottom):
 *   1. **Input step** (card-behavior R6.1/R6.2/R6.3) — shown BEFORE targeting
 *      when the card's {@link CardInput} needs a caster value:
 *        - `colors`: seven ROYGBIV `aria-pressed` toggles; exactly THREE must be
 *          selected to proceed (Art School Dropout).
 *        - `duration_seconds`: minutes/seconds number inputs for 0:00–5:00,
 *          shown as `m:ss` (Bird Guide); clamped to 0–300s.
 *        - `cuisine`: a text input, `maxLength=60` (Different Tastes).
 *        - `bar` / `public_bar` / `none`: no caster value input (the bar TARGET
 *          itself is the bar step).
 *   2. **Targeting step** — unchanged modes:
 *        - **team** (R3.2/R3.3): grays out + disables the caster's own team and
 *          any team already targeted by a card of the same name
 *          ({@link selectTeamTargetEligibility}). Pioneer/Scenic rows with
 *          reason `no_legal_next_bar` are NOT natively disabled — they stay
 *          keyboard-focusable with `aria-disabled` so a screen-reader user can
 *          reach them and hear why (R10.12, R22.5).
 *        - **bar** (R3.4/R3.5): shows each bar's claim state and grays out +
 *          disables ineligible bars via {@link selectBarTargetEligibility}.
 *        - **team_and_bar** (R3.6): prompts for the BAR first, then the TEAM
 *          (Voted Off the Island).
 *        - **none / self**: no target step; confirm directly.
 *   3. The card's **Requires** text above Confirm when present (R6.x).
 *
 * The same eligibility selectors drive the server's enforcement, so what the UI
 * grays out is exactly what the route rejects. This component owns only transient
 * selection + input state and enforces no card effect. Mobile-first: full-width
 * single column, 44px touch targets.
 *
 * Contract note (for card-behavior Task 10.6 wiring):
 *   - {@link PlayTargets} now carries an optional `params: CastingParams` — the
 *     validated casting input built by {@link validateCastingInput}. `onConfirm`
 *     is never called with malformed input; for a card with no caster value the
 *     field is `{ kind: "none" }`.
 *   - A new optional {@link CardPlayPanelProps.serverError} prop lets the caller
 *     surface a server `invalid_input` rejection inline near the picker — in
 *     particular `details.reason === "no_legal_next_bar"` from the play route.
 */

import { useMemo, useState } from "react";

import {
  getCardMetadata,
  getCardText,
  type CardInput,
  type CardSlug,
} from "@/lib/cards/catalog";
import {
  ROYGBIV,
  validateCastingInput,
  type CastingParams,
  type Color,
} from "@/lib/cards/inputs";
import { formatDuration } from "@/lib/cards/templates";
import type { NextClaimRule } from "@/lib/claims/legalNextBar";
import type {
  BoardCardView,
  BoardTeamView,
  GameBoardView,
} from "@/lib/gameboard/events";
import {
  selectBarTargetEligibility,
  selectTeamTargetEligibility,
  type BarTargetEligibility,
  type CardTargetContext,
  type TeamTargetEligibility,
} from "@/lib/gameboard/cardEligibility";
import type { ClaimState } from "@/lib/map/claims";

const TOUCH_TARGET = "44px";
const MAX_CUISINE_LENGTH = 60;
const MAX_DURATION_SECONDS = 300;

/** A selectable bar for the bar-targeting step (the map's candidate bars). */
export interface PlayTargetBar {
  readonly id: string;
  readonly name: string;
}

/**
 * The target(s) and validated casting input a confirmed play carries.
 *
 * Contract change (card-behavior Task 10.2, consumed by Task 10.6): `params` is
 * the {@link CastingParams} produced by {@link validateCastingInput} for the
 * card's {@link CardInput}. It is always present and is `{ kind: "none" }` for
 * cards that take no caster value. The page forwards it as the play POST body's
 * `params` field, which the route re-validates with the same function.
 */
export interface PlayTargets {
  readonly targetTeamId?: string;
  readonly targetBarId?: string;
  readonly params: CastingParams;
}

/**
 * A server-side rejection to surface inline near the picker (for Task 10.6).
 * `reason` is the route's structured `details.reason` (notably
 * `"no_legal_next_bar"`), and `rules` the restriction rules it reported.
 */
export interface CardPlayServerError {
  readonly reason?: string;
  readonly rules?: readonly NextClaimRule[];
  readonly message?: string;
}

export interface CardPlayPanelProps {
  /** The held card being played. */
  readonly card: BoardCardView;
  /** The folded board view (source for targeting eligibility). */
  readonly view: GameBoardView;
  /** All teams in the game (defaults to `view.teams`). */
  readonly teams: readonly BoardTeamView[];
  /** The caster's own team id (excluded from the team target list). */
  readonly castingTeamId: string;
  /** Candidate bars for bar-targeting cards (the map's bars). */
  readonly bars?: readonly PlayTargetBar[];
  /** Current claim state (bar id -> claiming team ids), to show map state. */
  readonly claims?: ClaimState;
  /** The finish bar id, excluded from bar targeting (R3.5), or null if unknown. */
  readonly finishBarId?: string | null;
  /**
   * Confirm the play with the chosen target(s) and validated casting `params`.
   * Never called while a required target is unselected or the casting input is
   * invalid.
   */
  readonly onConfirm: (targets: PlayTargets) => void;
  /** Cancel and dismiss, leaving the hand unchanged. */
  readonly onCancel: () => void;
  /** True while the confirm POST is in flight (disables controls). */
  readonly pending?: boolean;
  /**
   * A server rejection to show inline near the picker (Task 10.6). The common
   * case is a Pioneer/Scenic `no_legal_next_bar` the client could not predict.
   */
  readonly serverError?: CardPlayServerError | null;
  /**
   * The durable targeting facts (bar coordinates, claims, previous bars, active
   * Pioneer/Scenic rules) for the eligibility selectors. Without it the panel
   * falls back to the bare `finishBarId` context, which cannot evaluate the
   * Pioneer/Scenic Legal_Next_Bar rule (R10.12, R22.5).
   */
  readonly targetContext?: CardTargetContext;
}

function cardName(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).name;
  } catch {
    return slug;
  }
}

function targetModeOf(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).targetMode;
  } catch {
    return "none";
  }
}

function castingInputOf(slug: string): CardInput {
  try {
    return getCardMetadata(slug as CardSlug).castingInput;
  } catch {
    return "none";
  }
}

/** A readable label for a next-claim restriction rule in the gray-out reason. */
function ruleLabel(rule: NextClaimRule): string {
  switch (rule) {
    case "pioneer":
      return "under Pioneer";
    case "scenic":
      return "under Scenic Route";
    default:
      return rule;
  }
}

function teamReasonLabel(row: TeamTargetEligibility): string {
  switch (row.reason) {
    case "caster":
      return "your team";
    case "already_targeted_same_card":
      return "already targeted by this card";
    case "no_legal_next_bar": {
      const rules = row.rules ?? [];
      if (rules.length === 0) {
        return "No legal next bar for this team";
      }
      return `No legal next bar for this team (${rules
        .map(ruleLabel)
        .join(", ")})`;
    }
    default:
      return "";
  }
}

function barReasonLabel(reason: BarTargetEligibility["reason"]): string {
  switch (reason) {
    case "finish_bar":
      return "finish bar";
    case "start_bar":
      return "start bar";
    case "already_targeted_same_card":
      return "already targeted by this card";
    case "near_finish":
      return "too close to the finish";
    case "no_coordinates":
      return "no known location";
    case "four_claimants":
      return "already claimed by four teams";
    case "not_claimed_by_all":
      return "not claimed by every team";
    default:
      return "";
  }
}

export default function CardPlayPanel({
  card,
  view,
  teams,
  castingTeamId,
  bars = [],
  claims = {},
  finishBarId = null,
  onConfirm,
  onCancel,
  pending = false,
  serverError = null,
  targetContext,
}: CardPlayPanelProps): React.JSX.Element {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);
  const [showRequired, setShowRequired] = useState(false);

  // Casting-input state (card-behavior R6.1-R6.3). Only the field matching the
  // card's input kind is used; the others stay at their inert defaults.
  const [selectedColors, setSelectedColors] = useState<readonly Color[]>([]);
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [cuisine, setCuisine] = useState("");

  const name = cardName(card.slug);
  const mode = targetModeOf(card.slug);
  const castingInput = castingInputOf(card.slug);
  const targetsTeam = mode === "team" || mode === "team_and_bar";
  const targetsBar = mode === "bar" || mode === "team_and_bar";

  // The caster value cards (colors / duration / cuisine) need an input step
  // before targeting; bar/public_bar/none carry no caster value here.
  const needsInputValue =
    castingInput === "colors" ||
    castingInput === "duration_seconds" ||
    castingInput === "cuisine";

  // The raw input shape validateCastingInput expects for this card's kind.
  const rawInput = useMemo((): unknown => {
    switch (castingInput) {
      case "colors":
        return { colors: selectedColors };
      case "duration_seconds":
        return { seconds: durationMinutes * 60 + durationSeconds };
      case "cuisine":
        return { cuisine };
      default:
        return undefined;
    }
  }, [castingInput, selectedColors, durationMinutes, durationSeconds, cuisine]);

  const inputValidation = useMemo(
    () => validateCastingInput(castingInput, rawInput),
    [castingInput, rawInput],
  );
  const inputValid = inputValidation.ok;

  // team_and_bar is ordered: the BAR must be chosen before the TEAM step is
  // revealed (R3.6). For a bar-only or team-only card the single step shows.
  const barStepActive = targetsBar;
  const teamStepActive = targetsTeam && (!targetsBar || selectedBarId !== null);

  // A supplied context carries the durable facts; a known finishBarId still
  // wins for the finish-bar rule. Otherwise use the legacy bare finish key.
  const eligibilityCtx: CardTargetContext | string | null =
    targetContext !== undefined
      ? {
          ...targetContext,
          finishBarKey: finishBarId ?? targetContext.finishBarKey,
        }
      : finishBarId;

  const teamRows = selectTeamTargetEligibility(
    view,
    card.slug as CardSlug,
    castingTeamId,
    eligibilityCtx,
    teams,
  ).filter((row) => row.reason !== "caster");

  const barRows = selectBarTargetEligibility(
    view,
    card.slug as CardSlug,
    bars.map((bar) => bar.id),
    eligibilityCtx,
  );
  const barById = new Map(bars.map((bar) => [bar.id, bar]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  const requiresText = getCardText(card.slug as CardSlug).requires;

  function toggleColor(color: Color): void {
    setShowRequired(false);
    setSelectedColors((current) => {
      if (current.includes(color)) {
        return current.filter((c) => c !== color);
      }
      // Cap at three; ignore a fourth pick until one is removed.
      if (current.length >= 3) {
        return current;
      }
      return [...current, color];
    });
  }

  function handleConfirm(): void {
    if (needsInputValue && !inputValid) {
      setShowRequired(true);
      return;
    }
    if (targetsBar && selectedBarId === null) {
      setShowRequired(true);
      return;
    }
    if (targetsTeam && selectedTeamId === null) {
      setShowRequired(true);
      return;
    }
    // inputValid implies ok; narrow for TypeScript and default to kind "none".
    const params: CastingParams = inputValidation.ok
      ? inputValidation.params
      : { kind: "none" };
    onConfirm({
      targetBarId: targetsBar ? (selectedBarId ?? undefined) : undefined,
      targetTeamId: targetsTeam ? (selectedTeamId ?? undefined) : undefined,
      params,
    });
  }

  function claimSummary(barId: string): string {
    const claimers = claims[barId] ?? [];
    if (claimers.length === 0) {
      return "unclaimed";
    }
    const names = claimers.map((id) => teamById.get(id)?.name ?? id).join(", ");
    return `claimed by ${names}`;
  }

  function requiredMessage(): string {
    if (needsInputValue && !inputValid) {
      switch (castingInput) {
        case "colors":
          return "Select exactly three colors before playing this card.";
        case "duration_seconds":
          return "Enter a duration between 0:00 and 5:00 before playing this card.";
        case "cuisine":
          return "Enter a cuisine (up to 60 characters) before playing this card.";
        default:
          break;
      }
    }
    if (targetsBar && selectedBarId === null) {
      return "Choose an eligible target bar before playing this card.";
    }
    return "Choose an eligible target team before playing this card.";
  }

  return (
    <section
      role="dialog"
      aria-label="Play card"
      aria-modal="false"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
        padding: "0.75rem",
        border: "1px solid #1a1a1a",
        borderRadius: "0.5rem",
        background: "#ffffff",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Play “{name}”</h2>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
        {getCardText(card.slug as CardSlug).effect}
      </p>

      {/* Input step (shown before targeting, card-behavior R6.1-R6.3). */}
      {castingInput === "colors" ? (
        <div
          role="group"
          aria-label="Choose three colors"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
            Choose exactly three colors ({selectedColors.length}/3):
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.4rem",
              width: "100%",
            }}
          >
            {ROYGBIV.map((color) => {
              const pressed = selectedColors.includes(color);
              const atCap = !pressed && selectedColors.length >= 3;
              return (
                <button
                  key={color}
                  type="button"
                  aria-pressed={pressed}
                  aria-disabled={atCap}
                  disabled={pending}
                  onClick={() => {
                    if (atCap) {
                      return;
                    }
                    toggleColor(color);
                  }}
                  style={{
                    textTransform: "capitalize",
                    minHeight: TOUCH_TARGET,
                    minWidth: TOUCH_TARGET,
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.95rem",
                    borderRadius: "0.5rem",
                    border: pressed ? "2px solid #1a1a1a" : "1px solid #888",
                    background: pressed
                      ? "#eef"
                      : atCap
                        ? "#eeeeee"
                        : "#ffffff",
                    color: atCap && !pressed ? "#999" : "#1a1a1a",
                    cursor: atCap ? "not-allowed" : "pointer",
                  }}
                >
                  {color}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {castingInput === "duration_seconds" ? (
        <div
          role="group"
          aria-label="Enter a duration"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
            Enter the duration (0:00–5:00):
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <label style={{ fontSize: "0.85rem", color: "#555" }}>
              Minutes
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={5}
                value={durationMinutes}
                disabled={pending}
                onChange={(event) => {
                  setShowRequired(false);
                  const raw = Number.parseInt(event.target.value, 10);
                  const minutes = Number.isNaN(raw)
                    ? 0
                    : Math.min(5, Math.max(0, raw));
                  setDurationMinutes(minutes);
                }}
                style={{
                  display: "block",
                  width: "4rem",
                  minHeight: TOUCH_TARGET,
                  marginTop: "0.2rem",
                  padding: "0.4rem",
                  fontSize: "1rem",
                  borderRadius: "0.4rem",
                  border: "1px solid #888",
                }}
              />
            </label>
            <label style={{ fontSize: "0.85rem", color: "#555" }}>
              Seconds
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                value={durationSeconds}
                disabled={pending}
                onChange={(event) => {
                  setShowRequired(false);
                  const raw = Number.parseInt(event.target.value, 10);
                  const seconds = Number.isNaN(raw)
                    ? 0
                    : Math.min(59, Math.max(0, raw));
                  setDurationSeconds(seconds);
                }}
                style={{
                  display: "block",
                  width: "4rem",
                  minHeight: TOUCH_TARGET,
                  marginTop: "0.2rem",
                  padding: "0.4rem",
                  fontSize: "1rem",
                  borderRadius: "0.4rem",
                  border: "1px solid #888",
                }}
              />
            </label>
            <span
              aria-live="polite"
              style={{ fontSize: "1rem", fontWeight: 600, color: "#1a1a1a" }}
            >
              {formatDuration(
                Math.min(
                  MAX_DURATION_SECONDS,
                  durationMinutes * 60 + durationSeconds,
                ),
              )}
            </span>
          </div>
        </div>
      ) : null}

      {castingInput === "cuisine" ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            width: "100%",
          }}
        >
          <label
            htmlFor="card-cuisine-input"
            style={{ fontSize: "0.9rem", color: "#444" }}
          >
            Enter the cuisine:
          </label>
          <input
            id="card-cuisine-input"
            type="text"
            maxLength={MAX_CUISINE_LENGTH}
            value={cuisine}
            disabled={pending}
            onChange={(event) => {
              setShowRequired(false);
              setCuisine(event.target.value);
            }}
            style={{
              width: "100%",
              minHeight: TOUCH_TARGET,
              padding: "0.5rem 0.6rem",
              fontSize: "1rem",
              borderRadius: "0.4rem",
              border: "1px solid #888",
            }}
          />
        </div>
      ) : null}

      {/* Bar step (shown first for team_and_bar, R3.6). */}
      {barStepActive ? (
        <div
          role="group"
          aria-label="Choose a target bar"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
            Choose a target bar:
          </p>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              maxHeight: "14rem",
              overflowY: "auto",
            }}
          >
            {barRows.map((row) => {
              const bar = barById.get(row.barId);
              if (bar === undefined) {
                return null;
              }
              const isSelected = row.barId === selectedBarId;
              const disabled = !row.eligible || pending;
              return (
                <li key={row.barId}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-disabled={!row.eligible}
                    disabled={disabled}
                    title={
                      row.eligible ? undefined : barReasonLabel(row.reason)
                    }
                    onClick={() => {
                      if (!row.eligible) {
                        return;
                      }
                      setSelectedBarId(row.barId);
                      // Choosing a different bar re-opens the team step cleanly.
                      setShowRequired(false);
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "0.1rem",
                      width: "100%",
                      minHeight: TOUCH_TARGET,
                      padding: "0.5rem 0.6rem",
                      fontSize: "0.95rem",
                      textAlign: "left",
                      borderRadius: "0.5rem",
                      border: isSelected
                        ? "2px solid #1a1a1a"
                        : "1px solid #888",
                      background: !row.eligible
                        ? "#eeeeee"
                        : isSelected
                          ? "#eef"
                          : "#ffffff",
                      color: row.eligible ? "#1a1a1a" : "#999",
                      cursor: row.eligible ? "pointer" : "not-allowed",
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>
                      {bar.name}
                      {!row.eligible ? (
                        <span style={{ fontSize: "0.75rem", color: "#999" }}>
                          {" "}
                          ({barReasonLabel(row.reason)})
                        </span>
                      ) : null}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "#777" }}>
                      {claimSummary(row.barId)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Team step (revealed after the bar for team_and_bar, R3.6). */}
      {teamStepActive ? (
        <div
          role="group"
          aria-label="Choose a target team"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
            Choose a target team:
          </p>
          {teamRows.map((row) => {
            const team = teamById.get(row.teamId);
            if (team === undefined) {
              return null;
            }
            const isSelected = row.teamId === selectedTeamId;
            // Pioneer/Scenic no_legal_next_bar rows stay keyboard-focusable so a
            // screen-reader user can reach them and hear the reason (R10.12,
            // R22.5): do NOT set native `disabled`; use aria-disabled + a no-op
            // click. All other ineligible rows remain natively disabled.
            const keepFocusable = row.reason === "no_legal_next_bar";
            const nativeDisabled = row.eligible
              ? pending
              : keepFocusable
                ? pending
                : true;
            const reasonLabel = teamReasonLabel(row);
            return (
              <button
                key={row.teamId}
                type="button"
                aria-pressed={isSelected}
                aria-disabled={!row.eligible}
                disabled={nativeDisabled}
                title={row.eligible ? undefined : reasonLabel}
                onClick={() => {
                  if (!row.eligible) {
                    return;
                  }
                  setSelectedTeamId(row.teamId);
                  setShowRequired(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  width: "100%",
                  minHeight: TOUCH_TARGET,
                  padding: "0.6rem 0.75rem",
                  fontSize: "1rem",
                  textAlign: "left",
                  borderRadius: "0.5rem",
                  border: isSelected ? "2px solid #1a1a1a" : "1px solid #888",
                  background: !row.eligible
                    ? "#eeeeee"
                    : isSelected
                      ? "#eef"
                      : "#ffffff",
                  color: row.eligible ? "#1a1a1a" : "#999",
                  cursor: row.eligible ? "pointer" : "not-allowed",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "1rem",
                    height: "1rem",
                    borderRadius: "50%",
                    background: team.color,
                    border: "1px solid #0003",
                    flex: "0 0 auto",
                    opacity: row.eligible ? 1 : 0.4,
                  }}
                />
                <span style={{ flex: "1 1 auto" }}>{team.name}</span>
                {!row.eligible ? (
                  <span style={{ fontSize: "0.75rem", color: "#999" }}>
                    ({reasonLabel})
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Server rejection surfaced inline near the picker (Task 10.6). */}
      {serverError !== null ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            fontSize: "0.9rem",
            color: "#7a1a1a",
            border: "1px solid #7a1a1a",
            borderRadius: "0.5rem",
            background: "#fff0f0",
          }}
        >
          {serverError.reason === "no_legal_next_bar"
            ? `No legal next bar for this team${
                serverError.rules && serverError.rules.length > 0
                  ? ` (${serverError.rules.map(ruleLabel).join(", ")})`
                  : ""
              }.`
            : (serverError.message ??
              "That play was rejected. Try another target.")}
        </p>
      ) : null}

      {showRequired ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            fontSize: "0.9rem",
            color: "#7a1a1a",
            border: "1px solid #7a1a1a",
            borderRadius: "0.5rem",
            background: "#fff0f0",
          }}
        >
          {requiredMessage()}
        </p>
      ) : null}

      {/* Requires text, shown above Confirm when the card has a condition. */}
      {requiresText !== null ? (
        <p
          style={{
            margin: 0,
            fontSize: "0.85rem",
            fontWeight: 500,
            color: "#444",
          }}
        >
          Requires: {requiresText}
        </p>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: "0.5rem",
          width: "100%",
        }}
      >
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          style={{
            flex: "1 1 0",
            minWidth: TOUCH_TARGET,
            minHeight: TOUCH_TARGET,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.6rem 1rem",
            fontSize: "1rem",
            fontWeight: 600,
            borderRadius: "0.5rem",
            border: "1px solid #1a1a1a",
            background: pending ? "#9a9a9a" : "#1a1a1a",
            color: "#ffffff",
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          {pending ? "Playing…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          style={{
            flex: "1 1 0",
            minWidth: TOUCH_TARGET,
            minHeight: TOUCH_TARGET,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.6rem 1rem",
            fontSize: "1rem",
            fontWeight: 500,
            borderRadius: "0.5rem",
            border: "1px solid #888",
            background: "#ffffff",
            color: "#1a1a1a",
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
