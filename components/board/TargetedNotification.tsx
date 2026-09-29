"use client";

/**
 * Targeted-notification banner for the Game_Board (design §Components 4; Task 9.3;
 * Requirements 7.3, 7.4, 7.5, 7.6, 9.3, 9.5).
 *
 * When a Player on the target Team receives a `wireframe_card_played` event, the
 * reducer folds it into a {@link TargetedNotice} (see `lib/gameboard/events.ts`)
 * and the page presents it through this presentational component. It:
 *
 *   - Identifies the casting Team by name (falling back to its id if the Team is
 *     not yet in the folded roster), colored with the casting Team's color (R7.3).
 *   - Shows a placeholder label stating the card's effect and any claiming
 *     restriction are provided by a later feature (R7.4).
 *   - Offers a dismiss control that reports the notice's producing-event `seq` to
 *     the `onDismiss` callback the page wires to its pure `dismissTargetedNotice`
 *     transition (R7.5). The control is at least 44×44 CSS pixels (R9.3).
 *
 * It is deliberately rendered *inline and non-modal* — a banner that participates
 * in the normal document flow rather than a full-screen overlay. Because it never
 * covers the page, it cannot obscure the Region navigation controls and cannot
 * prevent their activation (R9.5), and it blocks the target Team from no Region or
 * control (R7.6): the notification's only effect is to inform.
 *
 * Mobile-first constraint (R9.3/R9.1): a full-width single-column banner with
 * inherited `box-sizing: border-box`, so it fits a 320–430px viewport with no
 * horizontal overflow, and the dismiss control meets the 44×44px touch target.
 */

import type { BoardTeamView, TargetedNotice } from "@/lib/gameboard/events";

/** Minimum touch-target size for interactive controls (R9.3). */
const TOUCH_TARGET = "44px";

export interface TargetedNotificationProps {
  /**
   * The folded notice to present — carries the casting Team id and the producing
   * event `seq` used as its stable identity for dismissal (R7.5).
   */
  readonly notice: TargetedNotice;
  /**
   * The Team roster from the folded view, used to resolve the casting Team's
   * display name and color for presentation (R7.3). If the casting Team is not
   * present, the notice falls back to naming the casting Team id.
   */
  readonly teams: readonly BoardTeamView[];
  /**
   * Called with the notice's producing-event `seq` when the Player dismisses the
   * notification. The page wires this to `dismissTargetedNotice` (R7.5).
   */
  readonly onDismiss: (seq: number) => void;
}

export default function TargetedNotification({
  notice,
  teams,
  onDismiss,
}: TargetedNotificationProps): React.JSX.Element {
  const castingTeam = teams.find((team) => team.id === notice.castingTeamId);
  // Prefer the resolved display name; fall back to the id so the notice always
  // identifies its caster even before the roster is fully folded (R7.3).
  const castingLabel = castingTeam?.name ?? notice.castingTeamId;
  const castingColor = castingTeam?.color ?? "#1a1a1a";

  return (
    <section
      // role=alert so assistive technology announces the notice when it appears
      // (R7.3). It stays inline in the document flow — never a modal overlay —
      // so it cannot obscure the Region nav (R9.5) or block any control (R7.6).
      role="alert"
      aria-label="Targeted card notification"
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "flex-start",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
        padding: "0.75rem",
        borderRadius: "0.5rem",
        // A tinted banner with a left accent in the casting Team's color, so the
        // caster is identifiable at a glance (R7.3).
        border: "1px solid #b8860b",
        borderLeft: `6px solid ${castingColor}`,
        background: "#fffbea",
        color: "#1a1a1a",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
          flex: "1 1 auto",
          minWidth: 0,
        }}
      >
        {/* Identify the casting Team (R7.3). */}
        <p style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>
          {castingLabel} played a card on your team.
        </p>

        {/* Placeholder label: effect + claiming restriction are a later feature
            (R7.4). */}
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
          The card&apos;s effect and any claiming restriction are provided by a
          later feature.
        </p>
      </div>

      {/* Dismiss control (R7.5), at least 44×44px (R9.3). */}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(notice.seq)}
        style={{
          flex: "0 0 auto",
          minWidth: TOUCH_TARGET,
          minHeight: TOUCH_TARGET,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0.4rem 0.6rem",
          fontSize: "1rem",
          fontWeight: 600,
          borderRadius: "0.5rem",
          border: "1px solid #1a1a1a",
          background: "#ffffff",
          color: "#1a1a1a",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
