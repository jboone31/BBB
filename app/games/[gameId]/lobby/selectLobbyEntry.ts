/**
 * Pure lobby-entry render selection for the Lobby_Client.
 *
 * While a Game is in the Lobby, the Lobby_Client must render exactly one
 * lobby-entry surface, chosen from the durable per-game local facts plus whether
 * the visitor already arrived with a resolved Join_Code:
 *
 * - `hasJoined`        → `'team'`          (the Team_Pipeline / TeamSelection)
 * - else `isAdmin`     → `'host-complete'` (the not-yet-joined Admin completion surface)
 * - else `hasResolvedCode` → `'code-complete'` (name-only join for a visitor who
 *   reached the lobby via a resolved code / share link — they already have the
 *   code, so we only need a display name)
 * - else               → `'join'`          (the full code-entry Join_Game_Form,
 *   for a bare `/games/{id}/lobby` visit with no code in hand)
 *
 * The mapping is exhaustive and mutually exclusive: it returns exactly one
 * surface for every input combination. `hasJoined` dominates, then `isAdmin`,
 * then `hasResolvedCode`, then the plain join fallback — so a visitor sees
 * exactly one of the join surfaces or the Team_Pipeline (never two), and the
 * "you already resolved the code" fast path is preferred over asking for the
 * code again.
 *
 * Why `code-complete` is separate from `host-complete`: both are name-only, but
 * they source the Join_Code differently. `host-complete` uses the authoritative
 * `view.joinCode` (the admin can read it because they are a member).
 * `code-complete` uses the `?code=` the visitor arrived with, because a
 * not-yet-joined visitor is not a member and RLS prevents them from reading
 * `view.joinCode` until after they join.
 *
 * The function is framework-free and side-effect-free so it can be
 * property-tested in isolation.
 *
 * Requirements: 3.2, 4.1, 4.2, 4.3, 4.4
 */

/** The lobby-entry surface the Lobby_Client should render. */
export type LobbyEntry = "team" | "host-complete" | "code-complete" | "join";

/**
 * Select the lobby-entry surface for a Game in the Lobby from the durable local
 * facts `(isAdmin, hasJoined)` and whether the visitor arrived with a resolved
 * Join_Code (`hasResolvedCode`).
 *
 * @param isAdmin         whether the requesting Session created this Game.
 * @param hasJoined       whether the requesting Session has a Player_Fact for this Game.
 * @param hasResolvedCode whether the visitor arrived with a resolved Join_Code
 *   (e.g. via the landing page's Join_Entry or a share link `?code=`).
 * @returns the single lobby-entry surface to render.
 */
export function selectLobbyEntry(
  isAdmin: boolean,
  hasJoined: boolean,
  hasResolvedCode: boolean = false,
): LobbyEntry {
  if (hasJoined) return "team";
  if (isAdmin) return "host-complete";
  if (hasResolvedCode) return "code-complete";
  return "join";
}
