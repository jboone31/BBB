/**
 * Share_Link construction for the Lobby Host, Player, and Sharing feature
 * (design §Share_Link construction; Requirements 5.2, 5.3, 5.4).
 *
 * A Share_Link is the id-carrying Lobby URL with the Join_Code embedded as the
 * `code` query parameter, so a recipient who opens it lands in the Game's Lobby
 * with the Join_Code prefilled (matching the app-shell-navigation model,
 * `/games/{gameId}/lobby?code={code}`).
 *
 * This module is framework-free and performs no I/O: it derives URL shape only.
 * The caller supplies the browser origin (`window.location.origin`) on the
 * client, or `null` under SSR where the origin is unavailable — in which case
 * only the relative `path` is produced and `absolute` is `null` (R5.4), letting
 * the roster still render the Join_Code text without failing to render.
 */

/**
 * The pieces of a Share_Link: an always-available relative `path` and an
 * `absolute` URL that is only present when an origin was supplied.
 */
export interface ShareLink {
  /** The relative Lobby URL with the code embedded, e.g. `/games/g1/lobby?code=ABC`. */
  readonly path: string;
  /** The absolute Share_Link, or `null` when no origin is available (SSR). */
  readonly absolute: string | null;
}

/**
 * Build a {@link ShareLink} from an origin, Game identifier, and Join_Code
 * (R5.2, R5.3, R5.4).
 *
 * The `path` is always the Lobby URL for `gameId` with `code` embedded as a
 * URL-encoded query parameter. The `absolute` link is produced only when
 * `origin` is a string (the client's `window.location.origin`); when `origin`
 * is `null` (SSR), `absolute` is `null` while `path` remains available.
 *
 * @param origin the browser origin (e.g. `https://example.com`), or `null` under SSR.
 * @param gameId the Game identifier segment of the Lobby URL.
 * @param code the Join_Code to embed as the `code` query parameter.
 * @returns the relative `path` and, when an origin is present, the `absolute` link.
 */
export function buildShareLink(
  origin: string | null,
  gameId: string,
  code: string,
): ShareLink {
  const path = `/games/${gameId}/lobby?code=${encodeURIComponent(code)}`;
  const absolute = origin === null ? null : `${origin}${path}`;
  return { path, absolute };
}
