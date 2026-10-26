/**
 * Boundary_Toasts for timed Effects (`lib/cards/boundaryToasts.ts`).
 *
 * Pure and framework-free (design.md section 13). The board renders start and
 * end Boundary_Toasts locally from an Effect's `startsAt` / `endsAt` plus the
 * measured Server_Clock_Offset, rather than routing them from the
 * `effect_activated` / `effect_expired` transition events. This module turns the
 * folded Effect set into that list of {@link Toast}s.
 *
 * The boundaries themselves come from {@link toastBoundaries} (section 6): the
 * Cancel Culture radius-lock start, and the Crop Dusting, Cancel Culture, Happy
 * Hour, and Power Hour ends. `toastBoundaries` already excludes an end whose
 * Effect was cancelled or consumed at or before its end time, so host- and
 * game-end-cancelled Effects produce no end toast (Requirement 20.6).
 *
 * A boundary is shown when either the corrected device clock has reached it
 * (`b.atMs <= serverNowMs`, the local timer) or its id has already arrived via a
 * transition event (`announced`, the fallback when the device clock is off).
 * Both sources yield the same `boundary:${effectId}:${start|end}` id, so the
 * board — which keys the result in a `Map` by id — shows each boundary at most
 * once (Requirement 20.12). Dismissed ids and late-join replays (source play seq
 * at or below the dismissal floor) are filtered out, and once the game has ended
 * only ids already shown this session survive, so boundaries that passed while a
 * board was away from an ended game stay suppressed (Requirements 20.10, 20.11).
 */

import type { CardSlug } from "./catalog";
import { getCardMetadata, getCardText } from "./catalog";
import type { Boundary, BoundaryKind, EffectRecord } from "./effects";
import { toastBoundaries } from "./effects";
import type { Toast } from "./toasts";
import type { TemplateValues } from "./templates";
import { renderTemplate, formatClockTime } from "./templates";
import { CANDIDATE_BARS } from "@/lib/map/bars";

/**
 * The inputs {@link deriveBoundaryToasts} needs, assembled by the board from the
 * folded card-behavior slice plus the device's local timing and dismissal state
 * (design.md section 13).
 */
export interface BoundaryToastInput {
  /** The folded timed Effects (from `view.cardBehavior.effects`). */
  readonly effects: readonly EffectRecord[];
  /** The `seq` of the `card_played` event that created each Effect. */
  readonly playSeqByEffect: ReadonlyMap<string, number>;
  readonly lifecycle: "lobby" | "live" | "ended";
  /** `Date.now()` corrected by the Server_Clock_Offset. */
  readonly serverNowMs: number;
  /** Boundary ids seen via `effect_activated` / `effect_expired` events. */
  readonly announced: ReadonlySet<string>;
  /** Boundary ids already shown by this board session. */
  readonly sessionShown: ReadonlySet<string>;
  /** The per-game localStorage dismissal record shared with `deriveToasts`. */
  readonly dismissal: {
    readonly floorSeq: number;
    readonly dismissed: readonly string[];
  };
  /** Optional IANA time zone for the rendered Clock_Times. */
  readonly timeZone?: string;
}

/**
 * The stable id of a Boundary_Toast: `boundary:${effectId}:${start|end}`. The
 * local timer and the transition-event fallback both derive this same id for a
 * given boundary, which is what lets the board dedupe (20.12).
 */
export function boundaryToastId(effectId: string, kind: BoundaryKind): string {
  return `boundary:${effectId}:${kind}`;
}

/**
 * The Boundary_Toasts the board should currently show, one per boundary from
 * {@link toastBoundaries} that satisfies all of:
 *
 * - It is due: `b.atMs <= serverNowMs` (local timer) **or** its id is in
 *   `announced` (transition-event fallback).
 * - Its id is not in `dismissal.dismissed`, and the source play's seq is strictly
 *   greater than `dismissal.floorSeq` (no late-join replay).
 * - If `lifecycle === "ended"`, its id is already in `sessionShown`, so a
 *   boundary that passed while away from an ended game stays suppressed.
 *
 * The result is ordered by `atMs`, then boundary id.
 */
export function deriveBoundaryToasts(input: BoundaryToastInput): Toast[] {
  const effectsById = new Map<string, EffectRecord>();
  for (const effect of input.effects) {
    effectsById.set(effect.effectId, effect);
  }

  const dismissed = new Set(input.dismissal.dismissed);
  const results: { readonly atMs: number; readonly toast: Toast }[] = [];

  for (const boundary of toastBoundaries(input.effects)) {
    const id = boundaryToastId(boundary.effectId, boundary.kind);

    // Due via the local timer or the transition-event fallback; both yield this
    // same id, so the board's keyed Map shows the boundary at most once (20.12).
    const due = boundary.atMs <= input.serverNowMs || input.announced.has(id);
    if (!due) {
      continue;
    }

    // Locally dismissed, or historical relative to this device's first load
    // (no late-join replay).
    if (dismissed.has(id)) {
      continue;
    }
    const playSeq = input.playSeqByEffect.get(boundary.effectId);
    if (playSeq !== undefined && playSeq <= input.dismissal.floorSeq) {
      continue;
    }

    // After game end, only boundaries this session already showed survive; ones
    // that passed while the board was away from an ended game are suppressed.
    if (input.lifecycle === "ended" && !input.sessionShown.has(id)) {
      continue;
    }

    const effect = effectsById.get(boundary.effectId);
    if (effect === undefined) {
      continue;
    }

    const toast = renderBoundaryToast(id, boundary, effect, input.timeZone);
    if (toast === null) {
      continue;
    }
    results.push({ atMs: boundary.atMs, toast });
  }

  // Order by boundary time, then id (toastBoundaries already orders this way,
  // but make the contract explicit at this layer too).
  results.sort((a, b) => {
    if (a.atMs !== b.atMs) {
      return a.atMs - b.atMs;
    }
    return a.toast.id < b.toast.id ? -1 : a.toast.id > b.toast.id ? 1 : 0;
  });

  return results.map((r) => r.toast);
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * Render one boundary into its finished {@link Toast}, using the card's catalog
 * `start` / `end` copy filled with the Effect's bar name and Clock_Times.
 * Returns `null` when the card has no override copy for that boundary kind (the
 * boundary set only contains kinds that do, so this is a defensive guard).
 */
function renderBoundaryToast(
  id: string,
  boundary: Boundary,
  effect: EffectRecord,
  timeZone: string | undefined,
): Toast | null {
  const template = boundaryTemplate(effect.slug, boundary.kind);
  if (template === null) {
    return null;
  }
  const values = boundaryTemplateValues(effect, timeZone);
  return {
    id,
    kind: boundary.kind,
    // Boundary_Toasts are driven by local timers, not by a sequenced event, so
    // they carry no meaningful event seq.
    seq: 0,
    headline: renderTemplate(template, values),
    body: null,
    dropdown: null,
    actions: [],
    dismissable: true,
  };
}

/**
 * The catalog `start` / `end` override copy for a card and boundary kind, or
 * `null` when that card defines none.
 */
function boundaryTemplate(slug: CardSlug, kind: BoundaryKind): string | null {
  const overrides = getCardText(slug).toasts;
  if (overrides === undefined) {
    return null;
  }
  const template = kind === "start" ? overrides.start : overrides.end;
  return template ?? null;
}

/**
 * Fill `{CARD}`, `{Bar}`, `{startTime}`, and `{endTime}` from the Effect itself.
 * The bar name resolves from the candidate-bar catalog, falling back to the key;
 * the clock times come straight off the Effect's `startsAt` / `endsAt`.
 */
function boundaryTemplateValues(
  effect: EffectRecord,
  timeZone: string | undefined,
): TemplateValues {
  const values: TemplateValues = {
    CARD: getCardMetadata(effect.slug).name.toUpperCase(),
    startTime: formatClockTime(effect.startsAt, timeZone),
  };
  if (effect.targetBarKey !== null) {
    values.Bar = barName(effect.targetBarKey);
  }
  if (effect.endsAt !== null) {
    values.endTime = formatClockTime(effect.endsAt, timeZone);
  }
  return values;
}

const BAR_NAME_BY_KEY: ReadonlyMap<string, string> = new Map(
  CANDIDATE_BARS.map((bar) => [bar.id, bar.name] as const),
);

/** The human-readable bar name for a bar key, falling back to the key itself. */
function barName(barKey: string): string {
  return BAR_NAME_BY_KEY.get(barKey) ?? barKey;
}
