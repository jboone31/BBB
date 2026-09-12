/**
 * Lobby roster view (design.md Component 5 `LobbyRoster.tsx`; Req 9.3, 9.4).
 *
 * A purely presentational, mobile-first React component that renders the current
 * lobby state a player or admin sees while a Game is in the Lobby:
 *
 *   1. The Game's **Join_Code** (R9.3), shown prominently so it can be read off a
 *      phone and shared with teammates. Rendered as monospace so ambiguous
 *      characters are easy to distinguish.
 *   2. The current **Teams**, each with its assigned **color** swatch and the
 *      **Players** on it (R9.4), plus a **teamless** bucket for Players who have
 *      joined but not yet picked a side (valid lobby state per R3.9).
 *
 * It is deliberately *presentational*: it holds no state, performs no I/O, and
 * subscribes to nothing. The owning page (`app/games/[gameId]/lobby/page.tsx`,
 * Task 22) folds the `game_events` log into a {@link LobbyView} via
 * `applyLobbyEvent` and passes the relevant slices here as props; re-rendering
 * on an applied Team/Player event is what satisfies the "update within 5s"
 * behavior (R9.5) — this component just reflects whatever props it is given.
 *
 * Layout is single-column and fluid with no fixed pixel widths, so it fits a
 * 360–430px viewport without horizontal overflow (R9.1). There are no
 * interactive controls here (the roster is read-only), so the ≥44×44px
 * touch-target rule (R9.2) applies to the action components, not this one.
 *
 * Requirements: 9.3, 9.4.
 */

import type { LobbyPlayerView, LobbyTeamView } from "@/lib/lobby/events";

export interface LobbyRosterProps {
  /**
   * The Game's Join_Code to display (R9.3). `null` before the `game_created`
   * event has been folded into the view, in which case a placeholder is shown.
   */
  readonly joinCode: string | null;
  /** The current Teams, each with its color and player ids (R9.4). */
  readonly teams: readonly LobbyTeamView[];
  /** Every Player in the Game; teamless Players (`teamId === null`) are bucketed separately (R3.9). */
  readonly players: readonly LobbyPlayerView[];
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

export default function LobbyRoster({
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

      {/* Join_Code (R9.3) */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
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
