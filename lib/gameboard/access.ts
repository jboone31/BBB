/**
 * Pure board-access decision for the Game_Board_Client (design.md §Board access
 * gate; R1).
 *
 * Before rendering any Region, the Game_Board page derives an access decision
 * from the folded view's `lifecycle` and the resolved Session (whether a valid
 * Session is present, and whether it is the Admin or a Player of the Game). This
 * mirrors `selectLobbyEntry` in the lobby feature: a pure, framework-free,
 * side-effect-free mapping that returns exactly one decision for every input
 * combination, so it can be property-tested in isolation (Property 1).
 *
 * Only the `board` decision renders the Bars/Scoreboard/Cards Regions; every
 * other decision renders its own indication and omits the Regions (R1.3–R1.6):
 *
 *   - `no-session`     → no valid Session: establish-session prompt (R1.6)
 *   - `not-authorized` → Session is neither Admin nor Player: not-authorized (R1.5)
 *   - `redirect-lobby` → `lifecycle === "lobby"`: redirect to the lobby (R1.3)
 *   - `ended`          → `lifecycle === "ended"`: ended-game indication (R1.4)
 *   - `board`          → `live` and Admin-or-Player: the Game_Board (R1.1)
 *
 * Requirements: 1.1, 1.3, 1.4, 1.5, 1.6.
 */

import type { GameBoardLifecycle } from "@/lib/gameboard/events";

/** The board-access decision the Game_Board_Client renders. */
export type BoardAccess =
  "no-session" | "not-authorized" | "redirect-lobby" | "ended" | "board";

/**
 * Select the board-access decision from the Game's `lifecycle` and the resolved
 * Session facts (design.md §Board access gate; R1).
 *
 * Returns `board` **if and only if** a valid Session is present, the Session is
 * the Admin or a Player of the Game, and `lifecycle === "live"`; every other
 * input yields a non-`board` decision that renders no Region.
 *
 * @param lifecycle  the folded Game lifecycle (`lobby` | `live` | `ended`).
 * @param hasSession whether a valid Session is present (async auth resolved).
 * @param isAdmin    whether the Session is the Admin of the Game.
 * @param isPlayer   whether the Session is a Player of the Game.
 * @returns the single board-access decision to render.
 */
export function selectBoardAccess(
  lifecycle: GameBoardLifecycle,
  hasSession: boolean,
  isAdmin: boolean,
  isPlayer: boolean,
): BoardAccess {
  // Order matters (design.md §Board access gate):
  // 1. no valid Session dominates everything — nothing else can be trusted (R1.6).
  if (!hasSession) return "no-session";
  // 2. a valid Session that is neither Admin nor Player is not authorized (R1.5).
  if (!isAdmin && !isPlayer) return "not-authorized";
  // 3. an authorized Session is then gated on lifecycle (R1.3, R1.4).
  if (lifecycle === "lobby") return "redirect-lobby";
  if (lifecycle === "ended") return "ended";
  // 4. valid Session, Admin-or-Player, and `lifecycle === "live"` renders the board (R1.1).
  return "board";
}
