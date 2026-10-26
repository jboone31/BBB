"use client";

/**
 * Toast_Stack for the Game_Board (card-behavior design.md §UI Changes, Task 10.3).
 *
 * Renders the per-viewer {@link Toast}s produced by `deriveToasts`
 * (`lib/cards/toasts.ts`) — merged by the parent board with the Boundary_Toasts
 * from `deriveBoundaryToasts` — as an INLINE, NON-MODAL stack. It replaces
 * `TargetedNotification` for real card-behavior events (that component stays for
 * the historical `wireframe_card_played` notices).
 *
 * What it owns:
 *
 *   - **Rendering.** Each toast is a `section` with `role="status"`. A toast
 *     that carries a pending action (Mark complete / We failed / Fairest Play /
 *     Decline) is an `role="alert"` and focuses its first action button on
 *     appearance (3.8, 6.1-6.3, and the design's accessibility note). Others'
 *     informational toasts (`kind: "others"` / `"mirror_others"` / `"payout"`)
 *     collapse into a single native `<details>/<summary>` dropdown so they do
 *     not crowd the actionable toasts.
 *   - **Posting.** Action buttons POST to the real routes
 *     (`/api/games/{gameId}/fairest-offers/{offerId}` for a Fairest decision,
 *     `/api/games/{gameId}/challenges/{challengeId}/resolve` for Mark complete /
 *     We failed). A button disables while its post is in flight and surfaces the
 *     server's `{ applied: false, error }` body inline beneath the toast.
 *   - **Fairest mirror legality (Pioneer / Scenic Route).** The Fairest prompt
 *     re-evaluates {@link ToastStackProps.isMirrorLegal} from the CURRENT view on
 *     every render (the parent recomputes it against the freshly folded
 *     `BehaviorState`). While it returns `false`, Play is disabled, Decline stays
 *     enabled, and the toast shows the exact notice
 *     "Mirroring is no longer legal: {Caster} would have no legal next bar."
 *     (9.18). A server `invalid_input` on Play is shown inline and the prompt
 *     stays open (the offer is still `pending`, so Decline remains available).
 *
 * What it does NOT own: it enforces no card effect and derives no state. The
 * toasts, the dismissal bookkeeping, the Boundary_Toast merge, and the
 * mirror-legality predicate are all computed by the board page and passed in, so
 * this is a pure projection plus transient per-action posting state. It is not
 * wired into the board tree here (that is the board-integration task).
 *
 * Mobile-first (cross-cutting): single column, `box-sizing: border-box`, every
 * interactive control is at least 44×44 CSS pixels, and the action row wraps at a
 * 320px viewport.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { FairestOfferRecord } from "@/lib/cards/behaviorState";
import type { BoardTeamView } from "@/lib/gameboard/events";
import type { Toast, ToastAction } from "@/lib/cards/toasts";

/** Minimum touch-target size for interactive controls (cross-cutting). */
const TOUCH_TARGET = "44px";

/**
 * The exact notice shown on a Pioneer / Scenic Route Fairest prompt once
 * mirroring the restriction back onto the original caster is no longer legal
 * (9.18). `{Caster}` is filled with the original caster team's name.
 */
export const MIRROR_NO_LONGER_LEGAL = (caster: string): string =>
  `Mirroring is no longer legal: ${caster} would have no legal next bar.`;

/**
 * The success envelope every Card_Behavior_Mutation route returns, and the
 * `not-applied` rejection body (`app/api/games/_shared.ts`). The stack only
 * needs to know whether the post applied and, if not, the stable error and its
 * reason, so it narrows to those fields.
 */
interface PostResult {
  readonly applied: boolean;
  readonly error?: string;
  readonly details?: { readonly reason?: string } | null;
}

/**
 * Post an action to its route and return the parsed `applied` / `error` body. A
 * non-JSON or transport failure is reported as a generic `unavailable` so the
 * caller always has something to show. Injected in tests via
 * {@link ToastStackProps.postAction}.
 */
export type PostAction = (
  action: ToastAction,
  gameId: string,
) => Promise<PostResult>;

const defaultPostAction: PostAction = async (action, gameId) => {
  const base = `/api/games/${encodeURIComponent(gameId)}`;
  let url: string;
  let body: unknown;
  switch (action.kind) {
    case "fairest_play":
      url = `${base}/fairest-offers/${encodeURIComponent(action.offerId)}`;
      body = { decision: "play" };
      break;
    case "fairest_decline":
      url = `${base}/fairest-offers/${encodeURIComponent(action.offerId)}`;
      body = { decision: "decline" };
      break;
    case "mark_complete":
      url = `${base}/challenges/${encodeURIComponent(action.challengeId)}/resolve`;
      body = { outcome: "completed" };
      break;
    case "we_failed":
      url = `${base}/challenges/${encodeURIComponent(action.challengeId)}/resolve`;
      body = { outcome: "failed" };
      break;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as PostResult;
    return json;
  } catch {
    return { applied: false, error: "unavailable" };
  }
};

export interface ToastStackProps {
  /** The game these toasts belong to (used to build the action routes). */
  readonly gameId: string;
  /**
   * The seq-ordered toasts for the viewing team: `deriveToasts` output merged
   * with `deriveBoundaryToasts`, deduped by id by the parent board.
   */
  readonly toasts: readonly Toast[];
  /** Every team in the game, for resolving the caster name in the mirror notice. */
  readonly teams: readonly BoardTeamView[];
  /**
   * The folded Fairest offers (`view.cardBehavior.offers`), so a Fairest prompt
   * can recover its offer (slug + original caster) when deciding whether the
   * mirror-legality notice applies.
   */
  readonly offers: Readonly<Record<string, FairestOfferRecord>>;
  /**
   * Whether mirroring the given Fairest offer back onto its original caster is
   * still legal, recomputed by the parent from the CURRENT view on every render
   * (`mirrorIsLegal(state, offer, serverNow)`). Returns `true` for non-restriction
   * offers; the stack only gates Play when it returns `false` (9.18).
   */
  readonly isMirrorLegal: (offer: FairestOfferRecord) => boolean;
  /** Dismiss a dismissable toast by id (the parent persists the dismissal). */
  readonly onDismiss?: (toastId: string) => void;
  /** Injectable poster (defaults to a real `fetch`); used by tests. */
  readonly postAction?: PostAction;
}

/** True for the informational toasts that collapse into the others' dropdown. */
function isOthersToast(toast: Toast): boolean {
  return (
    toast.actions.length === 0 &&
    (toast.kind === "others" ||
      toast.kind === "mirror_others" ||
      toast.kind === "payout" ||
      toast.kind === "announcement" ||
      toast.kind === "host_override")
  );
}

export default function ToastStack({
  gameId,
  toasts,
  teams,
  offers,
  isMirrorLegal,
  onDismiss,
  postAction = defaultPostAction,
}: ToastStackProps): React.JSX.Element | null {
  // Per-action transient posting state: the action id currently in flight, and
  // the last server error keyed by action id. Rebuilt from props otherwise, so a
  // realtime fold that resolves the toast simply drops it from the stack.
  const [postingId, setPostingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const teamName = useCallback(
    (teamId: string): string =>
      teams.find((team) => team.id === teamId)?.name ?? teamId,
    [teams],
  );

  const runAction = useCallback(
    async (actionId: string, action: ToastAction): Promise<void> => {
      setPostingId(actionId);
      setErrors((prev) => {
        if (prev[actionId] === undefined) {
          return prev;
        }
        const next = { ...prev };
        delete next[actionId];
        return next;
      });
      const result = await postAction(action, gameId);
      setPostingId((current) => (current === actionId ? null : current));
      if (!result.applied) {
        const message = result.error ?? "unavailable";
        setErrors((prev) => ({ ...prev, [actionId]: message }));
      }
      // On success nothing else is done here: the mutation appends an event, the
      // board folds it, and the resolved toast drops out of `toasts` on the next
      // render. The Fairest prompt stays open on a rejection because the offer
      // remains `pending` in the fold.
    },
    [gameId, postAction],
  );

  const actionable = toasts.filter((toast) => !isOthersToast(toast));
  const others = toasts.filter((toast) => isOthersToast(toast));

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Card notifications"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      {actionable.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          gameId={gameId}
          offers={offers}
          teamName={teamName}
          isMirrorLegal={isMirrorLegal}
          postingId={postingId}
          errors={errors}
          onRun={runAction}
          onDismiss={onDismiss}
        />
      ))}

      {others.length > 0 ? (
        <details
          style={{
            width: "100%",
            maxWidth: "100%",
            boxSizing: "border-box",
            border: "1px solid #ccc",
            borderRadius: "0.5rem",
            background: "#fafafa",
          }}
        >
          <summary
            style={{
              minHeight: TOUCH_TARGET,
              display: "flex",
              alignItems: "center",
              padding: "0.6rem 0.75rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              color: "#444",
              cursor: "pointer",
            }}
          >
            Other updates ({others.length})
          </summary>
          <ul
            aria-label="Other updates"
            style={{
              listStyle: "none",
              margin: 0,
              padding: "0 0.75rem 0.6rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            {others.map((toast) => (
              <li key={toast.id}>
                <section
                  role="status"
                  aria-label={toast.headline}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.2rem",
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.9rem",
                      fontWeight: 500,
                      color: "#1a1a1a",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {toast.headline}
                  </p>
                  {toast.body !== null ? (
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.85rem",
                        color: "#555",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {toast.body}
                    </p>
                  ) : null}
                  {toast.dropdown !== null ? (
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.8rem",
                        color: "#777",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {toast.dropdown}
                    </p>
                  ) : null}
                </section>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

interface ToastCardProps {
  readonly toast: Toast;
  readonly gameId: string;
  readonly offers: Readonly<Record<string, FairestOfferRecord>>;
  readonly teamName: (teamId: string) => string;
  readonly isMirrorLegal: (offer: FairestOfferRecord) => boolean;
  readonly postingId: string | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly onRun: (actionId: string, action: ToastAction) => void;
  readonly onDismiss?: (toastId: string) => void;
}

/**
 * One actionable or status toast. A toast with actions is an `role="alert"` and
 * focuses its first (enabled) action button on appearance; a plain status toast
 * is `role="status"`.
 */
function ToastCard({
  toast,
  offers,
  teamName,
  isMirrorLegal,
  postingId,
  errors,
  onRun,
  onDismiss,
}: ToastCardProps): React.JSX.Element {
  const hasActions = toast.actions.length > 0;
  const firstActionRef = useRef<HTMLButtonElement | null>(null);

  // A Pioneer / Scenic Route Fairest prompt gates Play while mirroring is no
  // longer legal, recomputed from the CURRENT view every render (9.18).
  const playAction = toast.actions.find(
    (action) => action.kind === "fairest_play",
  );
  const offer =
    playAction !== undefined ? offers[playAction.offerId] : undefined;
  const mirrorIllegal = offer !== undefined && !isMirrorLegal(offer);

  // Focus the first action on appearance so a keyboard / screen-reader user
  // lands on the thing they owe. When Play is disabled by the mirror check, the
  // focus falls to the first still-enabled action (Decline).
  useEffect(() => {
    if (hasActions) {
      firstActionRef.current?.focus();
    }
    // Focus once per toast identity; a re-render from posting state must not
    // steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  // The first still-enabled action receives the focus ref on appearance. Play
  // is disabled while mirroring is illegal, so the ref then falls to Decline.
  const firstEnabledIndex = toast.actions.findIndex(
    (action) => !(action.kind === "fairest_play" && mirrorIllegal),
  );

  return (
    <section
      role={hasActions ? "alert" : "status"}
      aria-label={toast.headline}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: "0.75rem",
        border: hasActions ? "1px solid #1a1a1a" : "1px solid #ccc",
        borderRadius: "0.5rem",
        background: hasActions ? "#fffbea" : "#ffffff",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "0.95rem",
          fontWeight: 600,
          color: "#1a1a1a",
          overflowWrap: "anywhere",
        }}
      >
        {toast.headline}
      </p>

      {toast.body !== null ? (
        <p
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: "#555",
            overflowWrap: "anywhere",
          }}
        >
          {toast.body}
        </p>
      ) : null}

      {/* The others' Effect text, when this status toast carries one. */}
      {toast.dropdown !== null ? (
        <details>
          <summary
            style={{
              minHeight: TOUCH_TARGET,
              display: "flex",
              alignItems: "center",
              fontSize: "0.8rem",
              color: "#555",
              cursor: "pointer",
            }}
          >
            Details
          </summary>
          <p
            style={{
              margin: "0.3rem 0 0",
              fontSize: "0.8rem",
              color: "#777",
              overflowWrap: "anywhere",
            }}
          >
            {toast.dropdown}
          </p>
        </details>
      ) : null}

      {/* Mirror-no-longer-legal notice for a Pioneer / Scenic Fairest prompt. */}
      {mirrorIllegal && offer !== undefined ? (
        <p
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: "#7a1a1a",
            overflowWrap: "anywhere",
          }}
        >
          {MIRROR_NO_LONGER_LEGAL(teamName(offer.originalCasterTeamId))}
        </p>
      ) : null}

      {hasActions ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            width: "100%",
          }}
        >
          {toast.actions.map((action, index) => {
            const actionId = actionKey(toast.id, action);
            const posting = postingId === actionId;
            // Play is disabled while mirroring is illegal; everything else is
            // disabled only while its own post is in flight.
            const disabled =
              posting || (action.kind === "fairest_play" && mirrorIllegal);
            const assignRef = index === firstEnabledIndex;
            return (
              <button
                key={actionId}
                ref={assignRef ? firstActionRef : undefined}
                type="button"
                aria-label={actionLabel(action)}
                disabled={disabled}
                onClick={() => onRun(actionId, action)}
                style={actionButtonStyle(action.kind, disabled)}
              >
                {posting ? "Working…" : actionLabel(action)}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Inline server errors, one per action that failed. */}
      {toast.actions.map((action) => {
        const actionId = actionKey(toast.id, action);
        const message = errors[actionId];
        if (message === undefined) {
          return null;
        }
        return (
          <p
            key={`err-${actionId}`}
            role="alert"
            style={{
              margin: 0,
              padding: "0.4rem 0.5rem",
              fontSize: "0.8rem",
              color: "#7a1a1a",
              border: "1px solid #7a1a1a",
              borderRadius: "0.4rem",
              background: "#fff0f0",
              overflowWrap: "anywhere",
            }}
          >
            {errorLabel(message)}
          </p>
        );
      })}

      {/* Dismiss control for a dismissable status toast. */}
      {toast.dismissable && onDismiss !== undefined ? (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          style={{
            alignSelf: "flex-end",
            minWidth: TOUCH_TARGET,
            minHeight: TOUCH_TARGET,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.4rem 0.75rem",
            fontSize: "0.85rem",
            borderRadius: "0.5rem",
            border: "1px solid #888",
            background: "#ffffff",
            color: "#1a1a1a",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      ) : null}
    </section>
  );
}

/** The stable per-action key: the toast id plus the action's target id. */
function actionKey(toastId: string, action: ToastAction): string {
  switch (action.kind) {
    case "fairest_play":
    case "fairest_decline":
      return `${toastId}:${action.kind}:${action.offerId}`;
    case "mark_complete":
    case "we_failed":
      return `${toastId}:${action.kind}:${action.challengeId}`;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** The button copy for an action. */
function actionLabel(action: ToastAction): string {
  switch (action.kind) {
    case "fairest_play":
      return "Play";
    case "fairest_decline":
      return "Decline";
    case "mark_complete":
      return "Mark complete";
    case "we_failed":
      return "We failed";
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** A human-readable message for a stable error reason returned by a route. */
function errorLabel(error: string): string {
  switch (error) {
    case "invalid_input":
      return "That action is no longer valid. Please review and try again.";
    case "conflict":
      return "This no longer applies — it may have already been resolved.";
    case "already_resolved":
      return "This has already been resolved.";
    case "not_authorized":
      return "Your team can't take this action.";
    case "unavailable":
      return "Something went wrong. Please try again.";
    default:
      return `Couldn't complete that action (${error}).`;
  }
}

function actionButtonStyle(
  kind: ToastAction["kind"],
  disabled: boolean,
): React.CSSProperties {
  // Play and Mark complete are the primary (filled) affordances; Decline and We
  // failed are secondary (outlined).
  const primary = kind === "fairest_play" || kind === "mark_complete";
  return {
    flex: "1 1 auto",
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "1rem",
    fontWeight: primary ? 600 : 500,
    borderRadius: "0.5rem",
    border: primary ? "2px solid #1a1a1a" : "1px solid #888",
    background: disabled ? "#e0e0e0" : primary ? "#1a1a1a" : "#ffffff",
    color: disabled ? "#777" : primary ? "#ffffff" : "#1a1a1a",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
