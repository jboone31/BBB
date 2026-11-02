"use client";

/**
 * Host_Card_Panel (card-behavior Task 11.4; Requirements 21.8, 21.10, 21.11).
 *
 * A host-only list, shown while the game is live, of every challenge (card,
 * target, status) with its valid Clear / Reset action and every pending or
 * active effect with an "End early" action. Each unconsumed Pioneer or Scenic
 * Route restriction is labeled with the team it holds up so the host can unstick
 * a team left with no legal next bar (21.11).
 *
 * The rows come straight from `selectHostItems` (lib/gameboard/cardBehavior.ts),
 * so the panel never decides which actions are valid on its own. Every action
 * opens a confirmation dialog first; only Confirm posts to the host override
 * routes with the `x-bbb-session-id` header:
 *
 *   - `POST /api/games/{gameId}/host/challenges/{challengeId}` `{ action }`
 *     with `action` = `"clear"` | `"reset"`;
 *   - `POST /api/games/{gameId}/host/effects/{effectId}` `{ action: "end" }`.
 *
 * On success nothing else happens here: the route appends one
 * `host_override_applied` event, the board folds it, and the row updates (or
 * drops out) on the next render. Every team sees the override toast via the
 * ToastStack (21.8). A rejection is shown inline in the dialog.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getCardMetadata } from "@/lib/cards/catalog";
import type { HostItem } from "@/lib/gameboard/cardBehavior";
import type { BoardTeamView } from "@/lib/gameboard/events";

/** Header carrying the per-game session id (session-based Identity_Model). */
const SESSION_HEADER = "x-bbb-session-id";

/** Minimum touch-target size (WCAG 2.5.5). */
const TOUCH_TARGET = "44px";

/** One host override the panel can post. */
export type HostOverride =
  | {
      readonly kind: "challenge";
      readonly challengeId: string;
      readonly action: "clear" | "reset";
    }
  | {
      readonly kind: "effect";
      readonly effectId: string;
      readonly action: "end";
    };

/** The parsed `applied` / `error` body every host route returns. */
export interface HostOverrideResult {
  readonly applied: boolean;
  readonly error?: string;
}

/** Posts one override; injectable for tests. */
export type PostHostOverride = (
  override: HostOverride,
  gameId: string,
  sessionId: string,
) => Promise<HostOverrideResult>;

/** The real poster: the host override routes with the session header. */
export const defaultPostHostOverride: PostHostOverride = async (
  override,
  gameId,
  sessionId,
) => {
  const base = `/api/games/${encodeURIComponent(gameId)}/host`;
  const url =
    override.kind === "challenge"
      ? `${base}/challenges/${encodeURIComponent(override.challengeId)}`
      : `${base}/effects/${encodeURIComponent(override.effectId)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_HEADER]: sessionId,
      },
      body: JSON.stringify({ action: override.action }),
    });
    return (await res.json()) as HostOverrideResult;
  } catch {
    return { applied: false, error: "unavailable" };
  }
};

export interface HostCardPanelProps {
  /** The game the overrides apply to. */
  readonly gameId: string;
  /** The host's session id, sent as `x-bbb-session-id`; null until resolved. */
  readonly sessionId: string | null;
  /** `selectHostItems(view.cardBehavior, serverNowMs)`. */
  readonly items: readonly HostItem[];
  /** Every team in the game, to show team names instead of ids. */
  readonly teams: readonly BoardTeamView[];
  /** Injectable poster (defaults to a real `fetch`); used by tests. */
  readonly postOverride?: PostHostOverride;
}

/** A pending confirmation: the override plus the text describing it. */
interface PendingConfirm {
  readonly override: HostOverride;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

const CHALLENGE_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  completed: "Completed",
  failed: "Failed",
  cleared_by_host: "Cleared by host",
};

/** Human card name for a slug, falling back to the slug itself. */
function cardName(slug: HostItem["slug"]): string {
  try {
    return getCardMetadata(slug).name;
  } catch {
    return slug;
  }
}

/** A human-readable message for a stable error reason returned by a host route. */
export function hostErrorLabel(error: string): string {
  switch (error) {
    case "conflict":
      return "This override no longer applies. The item may have changed.";
    case "already_resolved":
      return "This effect has already ended.";
    case "not_authorized":
      return "Only the host can apply overrides.";
    case "not_found":
      return "This item could not be found.";
    case "missing_session":
      return "Your session is not ready yet. Please try again.";
    case "unavailable":
      return "Something went wrong. Please try again.";
    default:
      return `The override could not be applied (${error}).`;
  }
}

/** The row heading for an effect: restriction rules name their team (21.11). */
function effectHeading(
  item: Extract<HostItem, { kind: "effect" }>,
  teamName: (id: string) => string,
): string {
  if (item.rule !== null) {
    const ruleName = item.rule === "pioneer" ? "Pioneer" : "Scenic Route";
    const team =
      item.targetTeamId === null ? "unknown team" : teamName(item.targetTeamId);
    return `${ruleName} restriction on ${team}`;
  }
  return cardName(item.slug);
}

export default function HostCardPanel({
  gameId,
  sessionId,
  items,
  teams,
  postOverride = defaultPostHostOverride,
}: HostCardPanelProps): React.JSX.Element {
  const headingId = useId();
  const dialogTitleId = useId();
  const dialogDescId = useId();

  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // The action button that opened the dialog, so focus returns to it on close.
  const openerRef = useRef<HTMLElement | null>(null);

  const teamName = useCallback(
    (teamId: string): string =>
      teams.find((team) => team.id === teamId)?.name ?? teamId,
    [teams],
  );

  // Move focus into the dialog when it opens (Cancel is the safe default).
  useEffect(() => {
    if (confirm !== null) {
      cancelRef.current?.focus();
    }
  }, [confirm]);

  const openConfirm = (
    event: React.MouseEvent<HTMLButtonElement>,
    next: PendingConfirm,
  ): void => {
    openerRef.current = event.currentTarget;
    setError(null);
    setConfirm(next);
  };

  const closeConfirm = useCallback((): void => {
    if (posting) {
      return;
    }
    setConfirm(null);
    setError(null);
    const opener = openerRef.current;
    openerRef.current = null;
    // Return focus to the opener when it is still in the document.
    if (opener !== null && opener.isConnected) {
      opener.focus();
    }
  }, [posting]);

  const handleConfirm = async (): Promise<void> => {
    if (confirm === null || posting) {
      return;
    }
    if (sessionId === null) {
      setError(hostErrorLabel("missing_session"));
      return;
    }
    setPosting(true);
    setError(null);
    const result = await postOverride(confirm.override, gameId, sessionId);
    setPosting(false);
    if (!result.applied) {
      setError(hostErrorLabel(result.error ?? "unavailable"));
      return;
    }
    // Applied: the folded host_override_applied event updates the rows.
    setConfirm(null);
    openerRef.current = null;
  };

  const challenges = items.filter(
    (item): item is Extract<HostItem, { kind: "challenge" }> =>
      item.kind === "challenge",
  );
  const effects = items.filter(
    (item): item is Extract<HostItem, { kind: "effect" }> =>
      item.kind === "effect",
  );

  const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.75rem",
    border: "1px solid #1a1a1a",
    borderRadius: "0.5rem",
    background: "#ffffff",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
  };
  const listStyle: React.CSSProperties = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem",
    border: "1px solid #ccc",
    borderRadius: "0.4rem",
    minWidth: 0,
  };
  const rowTextStyle: React.CSSProperties = {
    flex: "1 1 10rem",
    minWidth: 0,
    overflowWrap: "anywhere",
    fontSize: "0.9rem",
  };
  const buttonStyle = (danger: boolean): React.CSSProperties => ({
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    padding: "0.5rem 0.9rem",
    fontSize: "0.95rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: danger ? "1px solid #b00020" : "1px solid #1a1a1a",
    background: danger ? "#b00020" : "#ffffff",
    color: danger ? "#ffffff" : "#1a1a1a",
    cursor: "pointer",
  });

  return (
    <section aria-labelledby={headingId} style={sectionStyle}>
      <h2 id={headingId} style={{ margin: 0, fontSize: "1.05rem" }}>
        Host card controls
      </h2>

      <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Challenges</h3>
      {challenges.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
          No challenges yet.
        </p>
      ) : (
        <ul aria-label="Challenges" style={listStyle}>
          {challenges.map((item) => {
            const name = cardName(item.slug);
            const target = teamName(item.targetTeamId);
            const status = CHALLENGE_STATUS_LABEL[item.status] ?? item.status;
            return (
              <li key={item.challengeId} style={rowStyle}>
                <div style={rowTextStyle}>
                  <strong>{name}</strong>
                  <div>
                    Target: {target} · Caster: {teamName(item.casterTeamId)}
                  </div>
                  <div>Status: {status}</div>
                </div>
                {item.actions.map((action) => {
                  const verb = action === "clear" ? "Clear" : "Reset";
                  return (
                    <button
                      key={action}
                      type="button"
                      aria-label={`${verb} ${name} on ${target}`}
                      onClick={(event) =>
                        openConfirm(event, {
                          override: {
                            kind: "challenge",
                            challengeId: item.challengeId,
                            action,
                          },
                          title: `${verb} challenge?`,
                          description:
                            action === "clear"
                              ? `Clear ${name} on ${target}. The challenge is closed and no longer blocks ${target}'s claims.`
                              : `Reset ${name} on ${target} to open. ${target} must resolve it again before claiming another bar.`,
                          confirmLabel: verb,
                        })
                      }
                      style={buttonStyle(action === "clear")}
                    >
                      {verb}
                    </button>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}

      <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Effects</h3>
      {effects.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
          No pending or active effects.
        </p>
      ) : (
        <ul aria-label="Effects" style={listStyle}>
          {effects.map((item) => {
            const heading = effectHeading(item, teamName);
            return (
              <li key={item.effectId} style={rowStyle}>
                <div style={rowTextStyle}>
                  <strong>{heading}</strong>
                  <div>
                    {item.rule !== null ? `${cardName(item.slug)} · ` : ""}
                    {item.phase === "pending" ? "Pending" : "Active"}
                  </div>
                </div>
                {item.actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    aria-label={`End ${heading} early`}
                    onClick={(event) =>
                      openConfirm(event, {
                        override: {
                          kind: "effect",
                          effectId: item.effectId,
                          action,
                        },
                        title: "End effect early?",
                        description: `End ${heading} now. Points already awarded stay in place.`,
                        confirmLabel: "End early",
                      })
                    }
                    style={buttonStyle(true)}
                  >
                    End early
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {confirm !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeConfirm();
              return;
            }
            // aria-modal: keep Tab / Shift+Tab cycling inside the dialog.
            if (event.key === "Tab") {
              const focusable = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not([disabled])",
                ),
              );
              if (focusable.length === 0) {
                event.preventDefault();
                return;
              }
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              const active = document.activeElement;
              if (
                event.shiftKey &&
                (active === first || !focusable.includes(active as HTMLElement))
              ) {
                event.preventDefault();
                last.focus();
              } else if (
                !event.shiftKey &&
                (active === last || !focusable.includes(active as HTMLElement))
              ) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            padding: "1rem",
            background: "rgba(0, 0, 0, 0.45)",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "24rem",
              padding: "1rem",
              borderRadius: "0.75rem",
              background: "#ffffff",
              boxSizing: "border-box",
              overflowWrap: "anywhere",
            }}
          >
            <h2 id={dialogTitleId} style={{ marginTop: 0 }}>
              {confirm.title}
            </h2>
            <p id={dialogDescId}>{confirm.description}</p>
            {error !== null ? (
              <p role="alert" style={{ color: "#b00020" }}>
                {error}
              </p>
            ) : null}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: "0.5rem",
              }}
            >
              <button
                ref={cancelRef}
                type="button"
                onClick={closeConfirm}
                disabled={posting}
                style={buttonStyle(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={posting}
                style={buttonStyle(true)}
              >
                {posting ? "Applying…" : confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
