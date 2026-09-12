/**
 * Pure lobby-entry render selection for the Lobby_Client.
 *
 * While a Game is in the Lobby, the Lobby_Client must render exactly one
 * lobby-entry surface, chosen from the two durable per-game local facts
 * `(isAdmin, hasJoined)`:
 *
 * - `hasJoined`  → `'team'`          (the Team_Pipeline / TeamSelection)
 * - else `isAdmin` → `'host-complete'` (the not-yet-joined Admin completion surface)
 * - else           → `'join'`          (the code-entry Join_Game_Form)
 *
 * This mapping is exhaustive and mutually exclusive over the four `(isAdmin,
 * hasJoined)` combinations, satisfying the requirement that a visitor sees
 * exactly one of the Join_Game_Form or the Team_Pipeline (and the host sees the
 * completion surface only in the created-but-not-joined recovery case).
 *
 * The function is framework-free and side-effect-free so it can be
 * property-tested in isolation.
 *
 * Requirements: 3.2, 4.1, 4.2, 4.3, 4.4
 */

/** The lobby-entry surface the Lobby_Client should render. */
export type LobbyEntry = "team" | "host-complete" | "join";

/**
 * Select the lobby-entry surface for a Game in the Lobby from the durable local
 * facts `(isAdmin, hasJoined)`.
 *
 * @param isAdmin   whether the requesting Session created this Game.
 * @param hasJoined whether the requesting Session has a Player_Fact for this Game.
 * @returns the single lobby-entry surface to render.
 */
export function selectLobbyEntry(
  isAdmin: boolean,
  hasJoined: boolean,
): LobbyEntry {
  if (hasJoined) return "team";
  if (isAdmin) return "host-complete";
  return "join";
}
