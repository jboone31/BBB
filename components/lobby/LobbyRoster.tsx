"use client";

/**
 * Lobby roster view (design.md Component 5 `LobbyRoster.tsx`; Req 9.3, 9.4;
 * lobby-host-player-and-sharing design §Component 4, Requirements 5.1–5.7).
 *
 * A mobile-first React component that renders the current lobby state a player
 * or admin sees while a Game is in the Lobby:
 *
 *   1. The Game's **Join_Code** (R9.3 / R5.1), shown prominently so it can be
 *      read off a phone and shared with teammates. Rendered as monospace so
 *      ambiguous characters are easy to distinguish, and kept visible at all
 *      times (R5.1, R5.7).
 *   2. A small **ShareControls** region beneath the code: a **Copy code**
 *      button for the raw Join_Code, and — when a browser origin is available —
 *      the absolute **Share_Link** plus a **Copy link** button (R5.2–R5.6). The
 *      Share_Link is built from the browser origin at render time and degrades
 *      gracefully under SSR, where the absolute link is omitted (R5.3, R5.4).
 *   3. The current **Teams**, each with its assigned **color** swatch and the
 *      **Players** on it (R9.4), plus a **teamless** bucket for Players who have
 *      joined but not yet picked a side (valid lobby state per R3.9).
 *
 * The roster owns only transient copy-confirmation UI state and performs no
 * network I/O; the owning page (`app/games/[gameId]/lobby/page.tsx`) folds the
 * `game_events` log into a {@link LobbyView} and passes the relevant slices here
 * as props. It became a client component to support the clipboard copy handlers
 * and the browser-origin-derived Share_Link; the lobby page already renders it
 * inside a client page.
 *
 * Layout is single-column and fluid with no fixed pixel widths, so it fits a
 * 360–430px viewport without horizontal overflow (R9.1). Interactive copy
 * controls honor the ≥44×44px touch-target rule (R9.2).
 *
 * Requirements: 9.3, 9.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7.
 */

import { useCallback, useState } from "react";

import type { LobbyPlayerView, LobbyTeamView } from "@/lib/lobby/events";
import { buildShareLink } from "@/lib/lobby/shareLink";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

/** How long the transient "Copied" confirmation stays visible, in ms. */
const COPIED_CONFIRMATION_MS = 1500;

export interface LobbyRosterProps {
  /**
   * The Game identifier, used to build the shareable Lobby link (R5.2).
   */
  readonly gameId: string;
  /**
   * The Game's Join_Code to display (R9.3, R5.1). `null` before the
   * `game_created` event has been folded into the view, in which case a
   * placeholder is shown and no share controls render.
   */
  readonly joinCode: string | null;
  /** The current Teams, each with its color and player ids (R9.4). */
  readonly teams: readonly LobbyTeamView[];
  /** Every Player in the Game; teamless Players (`teamId === null`) are bucketed separately (R3.9). */
  readonly players: readonly LobbyPlayerView[];
}

/**
 * Copy `text` to the clipboard, client-only and best-effort (R5.5, R5.6).
 *
 * Uses the async Clipboard API when available and falls back to the legacy
 * `document.execCommand("copy")` path when it is not. Any failure (missing API,
 * rejected promise, denied permission) is swallowed and reported as `false`;
 * this never throws, so a failed copy simply skips the "Copied" confirmation
 * while the Join_Code text remains visible (R5.7).
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy fallback below
  }
  try {
    if (typeof document !== "undefined") {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    }
  } catch {
    // never throw; report failure below
  }
  return false;
}

/** Look up a player's display name by id, falling back to the id if unknown. */
function displayNameFor(
  players: readonly LobbyPlayerView[],
  playerId: string,
): string {
  return players.find((p) => p.id === playerId)?.displayName ?? playerId;
}

/** A single player's name as a list item. */
function PlayerItem({ name }: { readonly name: string }): React.JSX.Element {
  return (
    <li
      style={{
        fontSize: "0.9rem",
        lineHeight: 1.4,
        wordBreak: "break-word",
      }}
    >
      {name}
    </li>
  );
}

/** One team card: color swatch + name header, then its players. */
function TeamCard({
  team,
  players,
}: {
  readonly team: LobbyTeamView;
  readonly players: readonly LobbyPlayerView[];
}): React.JSX.Element {
  return (
    <li
      style={{
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.4rem",
        padding: "0.6rem 0.75rem",
        border: "1px solid #ddd",
        borderRadius: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            width: "1rem",
            height: "1rem",
            borderRadius: "50%",
            background: team.color,
            border: "1px solid rgba(0, 0, 0, 0.2)",
          }}
        />
        <h4
          style={{
            margin: 0,
            fontSize: "1rem",
            wordBreak: "break-word",
          }}
        >
          {team.name}
        </h4>
        <span
          style={{ marginLeft: "auto", fontSize: "0.75rem", color: "#666" }}
        >
          {team.playerIds.length}{" "}
          {team.playerIds.length === 1 ? "player" : "players"}
        </span>
      </div>
      {team.playerIds.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#666" }}>
          No players yet.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {team.playerIds.map((playerId) => (
            <PlayerItem
              key={playerId}
              name={displayNameFor(players, playerId)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Shared inline style for the small copy controls (≥44px touch target, R9.2). */
const copyButtonStyle: React.CSSProperties = {
  minHeight: TOUCH_TARGET,
  padding: "0.4rem 0.75rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  borderRadius: "0.5rem",
  border: "1px solid #444",
  background: "#1a1a1a",
  color: "#ffffff",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/**
 * A copy-to-clipboard button with a transient "Copied" confirmation (R5.5–R5.7).
 *
 * Owns only its own `copied` flag: on click it copies `value` and, when the copy
 * succeeds, flips to a short-lived confirmation label that reverts after
 * {@link COPIED_CONFIRMATION_MS}. The confirmation is purely additive UI on the
 * button itself and never removes the surrounding Join_Code text.
 */
function CopyButton({
  value,
  label,
  ariaLabel,
}: {
  readonly value: string;
  readonly label: string;
  readonly ariaLabel: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    void (async () => {
      const ok = await copyToClipboard(value);
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_CONFIRMATION_MS);
      }
    })();
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel}
      style={copyButtonStyle}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * Share affordances beneath the Join_Code text (R5.2–R5.6).
 *
 * Always offers a **Copy code** control for the raw Join_Code. When a browser
 * origin is available (client render), it also shows the absolute Share_Link and
 * a **Copy link** control; under SSR/null origin the absolute link and its
 * control are omitted (R5.4) while the code copy remains available.
 */
function ShareControls({
  gameId,
  joinCode,
}: {
  readonly gameId: string;
  readonly joinCode: string;
}): React.JSX.Element {
  const origin = typeof window !== "undefined" ? window.location.origin : null;
  const shareLink = buildShareLink(origin, gameId, joinCode);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <CopyButton
          value={joinCode}
          label="Copy code"
          ariaLabel="Copy join code"
        />
      </div>

      {shareLink.absolute !== null ? (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
        >
          <span style={{ fontSize: "0.8rem", color: "#666" }}>Share link</span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <a
              href={shareLink.absolute}
              style={{
                fontSize: "0.85rem",
                wordBreak: "break-all",
                flex: "1 1 12rem",
              }}
            >
              {shareLink.absolute}
            </a>
            <CopyButton
              value={shareLink.absolute}
              label="Copy link"
              ariaLabel="Copy share link"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function LobbyRoster({
  gameId,
  joinCode,
  teams,
  players,
}: LobbyRosterProps): React.JSX.Element {
  // Players not on any team form the teamless bucket (R3.9). Team membership is
  // authoritative on the player's `teamId`, matching the reducer's invariant
  // that each player appears on at most one team.
  const teamlessPlayers = players.filter((player) => player.teamId === null);

  return (
    <section
      aria-labelledby="lobby-roster-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        maxWidth: "100%",
      }}
    >
      <h2 id="lobby-roster-heading" style={{ margin: 0, fontSize: "1.1rem" }}>
        Lobby
      </h2>

      {/* Join_Code (R9.3, R5.1) + share affordances (R5.2–R5.6) */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
        >
          <span style={{ fontSize: "0.8rem", color: "#666" }}>Join code</span>
          <strong
            style={{
              fontSize: "1.5rem",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              letterSpacing: "0.1em",
              wordBreak: "break-all",
            }}
          >
            {joinCode ?? "—"}
          </strong>
        </div>
        {joinCode !== null ? (
          <ShareControls gameId={gameId} joinCode={joinCode} />
        ) : null}
      </div>

      {/* Teams with colors + players (R9.4) */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
          Teams ({teams.length})
        </h3>
        {teams.length === 0 ? (
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
            No teams yet.
          </p>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {teams.map((team) => (
              <TeamCard key={team.id} team={team} players={players} />
            ))}
          </ul>
        )}
      </div>

      {/* Teamless players (valid lobby state, R3.9) */}
      {teamlessPlayers.length > 0 ? (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}
        >
          <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
            Not on a team ({teamlessPlayers.length})
          </h3>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {teamlessPlayers.map((player) => (
              <PlayerItem key={player.id} name={player.displayName} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
