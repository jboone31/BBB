"use client";

/**
 * Effects_Strip (card-behavior Task 12.5; Requirement 20.7).
 *
 * A compact, inline list of the pending and active timed Effects with live
 * countdowns. Every countdown is computed from the Effect's server timestamps
 * and the board's Server_Clock_Offset (`serverNow(Date.now(), offsetMs)`), never
 * from the raw device clock, so all boards count down together.
 *
 * - A pending Effect (Cancel Culture before its lock begins) shows "Starts in".
 * - An active Effect with an end time shows "Ends in".
 * - Effects with no end time (Insurance, Party Crasher, Patient Investor,
 *   Pioneer, Scenic Route) are not timed and are not listed; ended, cancelled,
 *   and consumed Effects drop out.
 *
 * The strip ticks once per second while it lists anything and renders nothing
 * when there is no timed Effect. The countdown text is not a live region, so
 * screen readers are not interrupted every second.
 */

import { useEffect, useState } from "react";

import { getCardMetadata } from "@/lib/cards/catalog";
import {
  countedFromParams,
  PATIENT_INVESTOR_THRESHOLD,
} from "@/lib/cards/claimEffects";
import { serverNow } from "@/lib/cards/clockOffset";
import { effectPhase, type EffectRecord } from "@/lib/cards/effects";
import type { BoardTeamView } from "@/lib/gameboard/events";
import { CANDIDATE_BARS } from "@/lib/map/bars";

/** How often the countdowns refresh. */
export const EFFECTS_STRIP_TICK_MS = 1_000;

export interface EffectsStripProps {
  /** The folded Effects (`Object.values(view.cardBehavior.effects)`). */
  readonly effects: readonly EffectRecord[];
  /** The Server_Clock_Offset in ms (`serverTime − deviceTime`). */
  readonly offsetMs: number;
  /** Every team in the game, to show team names instead of ids. */
  readonly teams: readonly BoardTeamView[];
  /** Device clock (defaults to `Date.now`); injectable for tests. */
  readonly now?: () => number;
}

/** One listed Effect with its countdown target. */
export interface EffectsStripItem {
  readonly effectId: string;
  readonly phase: "pending" | "active";
  /** Server time the countdown runs to (start when pending, end when active). */
  readonly targetMs: number;
  readonly effect: EffectRecord;
}

/**
 * The timed Effects to list at `serverNowMs`, ordered by countdown target then
 * id: pending Effects (counting to their start) and active Effects with an end
 * time (counting to their end).
 */
export function selectEffectsStripItems(
  effects: readonly EffectRecord[],
  serverNowMs: number,
): EffectsStripItem[] {
  const items: EffectsStripItem[] = [];
  for (const effect of effects) {
    const phase = effectPhase(effect, serverNowMs);
    if (phase === "pending") {
      const start = Date.parse(effect.startsAt);
      if (effect.cancelledAt !== null || Number.isNaN(start)) {
        continue;
      }
      items.push({ effectId: effect.effectId, phase, targetMs: start, effect });
    } else if (phase === "active" && effect.endsAt !== null) {
      const end = Date.parse(effect.endsAt);
      if (Number.isNaN(end)) {
        continue;
      }
      items.push({ effectId: effect.effectId, phase, targetMs: end, effect });
    }
  }
  items.sort((a, b) =>
    a.targetMs !== b.targetMs
      ? a.targetMs - b.targetMs
      : a.effectId < b.effectId
        ? -1
        : a.effectId > b.effectId
          ? 1
          : 0,
  );
  return items;
}

/** One Patient Investor progress marker: its counter effect and current count. */
export interface ClaimCounterItem {
  readonly effectId: string;
  readonly effect: EffectRecord;
  /** Distinct bars counted so far (0..threshold). */
  readonly counted: number;
  /** The payout threshold (4). */
  readonly threshold: number;
}

/**
 * The Patient Investor progress markers to show: every active (not consumed,
 * not cancelled) `claim_counter` effect, with its distinct-bar count toward the
 * payout threshold. These are untimed effects, so they are not in
 * {@link selectEffectsStripItems}; the strip lists them separately so every team
 * can watch each counter climb toward {@link PATIENT_INVESTOR_THRESHOLD} (16.2).
 * Ordered by effect id for a stable render.
 */
export function selectClaimCounterItems(
  effects: readonly EffectRecord[],
): ClaimCounterItem[] {
  const items: ClaimCounterItem[] = [];
  for (const effect of effects) {
    if (
      effect.kind !== "claim_counter" ||
      effect.consumedAt !== null ||
      effect.cancelledAt !== null
    ) {
      continue;
    }
    items.push({
      effectId: effect.effectId,
      effect,
      counted: countedFromParams(effect.params ?? {}).length,
      threshold: PATIENT_INVESTOR_THRESHOLD,
    });
  }
  items.sort((a, b) =>
    a.effectId < b.effectId ? -1 : a.effectId > b.effectId ? 1 : 0,
  );
  return items;
}

/** Format a remaining duration as `m:ss`, or `h:mm:ss` from one hour up. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

const BAR_NAME_BY_KEY: ReadonlyMap<string, string> = new Map(
  CANDIDATE_BARS.map((bar) => [bar.id, bar.name] as const),
);

/** Human card name for a slug, falling back to the slug itself. */
function cardName(slug: EffectRecord["slug"]): string {
  try {
    return getCardMetadata(slug).name;
  } catch {
    return slug;
  }
}

/** What the Effect applies to: its bar, else its target team, else nothing. */
function subjectLabel(
  effect: EffectRecord,
  teams: readonly BoardTeamView[],
): string | null {
  if (effect.targetBarKey !== null) {
    return `at ${BAR_NAME_BY_KEY.get(effect.targetBarKey) ?? effect.targetBarKey}`;
  }
  if (effect.targetTeamId !== null) {
    const team = teams.find((t) => t.id === effect.targetTeamId);
    return `on ${team?.name ?? effect.targetTeamId}`;
  }
  return null;
}

export default function EffectsStrip({
  effects,
  offsetMs,
  teams,
  now = Date.now,
}: EffectsStripProps): React.JSX.Element | null {
  const [deviceNowMs, setDeviceNowMs] = useState<number>(() => now());
  const items = selectEffectsStripItems(
    effects,
    serverNow(deviceNowMs, offsetMs),
  );
  // Patient Investor progress markers are untimed, so they live alongside the
  // timed items (shown to every team).
  const counterItems = selectClaimCounterItems(effects);
  const hasTimed = items.length > 0;
  const hasAnything = hasTimed || counterItems.length > 0;

  // Only the timed items tick every second; a counter marker is static between
  // claims, so the interval runs whenever there is a timed item.
  useEffect(() => {
    if (!hasTimed) {
      return;
    }
    const handle = setInterval(
      () => setDeviceNowMs(now()),
      EFFECTS_STRIP_TICK_MS,
    );
    return () => clearInterval(handle);
  }, [hasTimed, now]);

  if (!hasAnything) {
    return null;
  }

  const serverNowMs = serverNow(deviceNowMs, offsetMs);

  return (
    <section
      aria-labelledby="effects-strip-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.4rem",
        padding: "0.6rem 0.75rem",
        border: "1px solid #1a1a1a",
        borderRadius: "0.5rem",
        background: "#f4f7ff",
        color: "#1a1a1a",
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
      }}
    >
      <h2
        id="effects-strip-heading"
        style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700 }}
      >
        Effects
      </h2>
      {hasTimed ? (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "0.3rem",
          }}
        >
          {items.map((item) => {
            const subject = subjectLabel(item.effect, teams);
            const verb = item.phase === "pending" ? "Starts in" : "Ends in";
            return (
              <li
                key={item.effectId}
                data-effect-id={item.effectId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  gap: "0.25rem 0.75rem",
                  fontSize: "0.85rem",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong>{cardName(item.effect.slug)}</strong>
                  {subject !== null ? ` ${subject}` : null}
                </span>
                <span>
                  {`${verb} `}
                  <time
                    dateTime={new Date(item.targetMs).toISOString()}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatCountdown(item.targetMs - serverNowMs)}
                  </time>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {counterItems.length > 0 ? (
        <ul
          aria-label="Progress markers"
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "0.3rem",
          }}
        >
          {counterItems.map((item) => {
            const owner =
              item.effect.ownerTeamId === null
                ? null
                : (teams.find((t) => t.id === item.effect.ownerTeamId)?.name ??
                  item.effect.ownerTeamId);
            return (
              <li
                key={item.effectId}
                data-counter-id={item.effectId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  gap: "0.25rem 0.75rem",
                  fontSize: "0.85rem",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong>{cardName(item.effect.slug)}</strong>
                  {owner !== null ? ` (${owner})` : null}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {`${item.counted}/${item.threshold} bars`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
