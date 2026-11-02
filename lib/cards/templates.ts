/**
 * Template rendering and time/duration formatting for card toasts
 * (card-behavior spec, design section 2).
 *
 * These helpers turn the placeholder strings in {@link CardText} (`"{Caster}
 * played {CARD} on {Bar}."`) into finished toast copy, and format the durations
 * and clock times those toasts embed. Everything here is pure and
 * framework-free so it can be unit- and property-tested in isolation and reused
 * by both the board UI and any server-side preview.
 *
 * The one subtlety is {@link renderTemplate}: it substitutes every placeholder
 * in a SINGLE pass, so a value that itself contains a brace token (for example a
 * bar literally named "{Bar}") is never re-expanded.
 */

import type { TemplatePlaceholder } from "./cardText";

/** A partial mapping from placeholder name to the string to substitute. */
export type TemplateValues = Partial<Record<TemplatePlaceholder, string>>;

/**
 * Matches a `{Placeholder}` token: an opening brace, one or more characters that
 * are not braces, and a closing brace. The inner capture is the placeholder
 * name, which we look up in {@link TemplateValues}.
 */
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

/**
 * Render `template`, replacing every `{name}` token for which `values` has an
 * entry with that value. The substitution is a single left-to-right pass
 * (`String.prototype.replace` with a global regex), so a substituted value that
 * itself contains `{Bar}` or any other token is never re-expanded.
 *
 * A token whose name is not a key of `values` (an unknown placeholder, or one
 * the caller intentionally left unfilled) is left in place verbatim, braces and
 * all. A catalog test rejects card copy that uses placeholders outside the
 * allowed {@link TemplatePlaceholder} set.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const replacement = values[name as TemplatePlaceholder];
    return replacement === undefined ? match : replacement;
  });
}

/**
 * The placeholder names that appear in `template`, in first-occurrence order
 * with duplicates removed. Only names that are valid {@link TemplatePlaceholder}
 * tokens are returned; a brace token with an unrecognized name is ignored (the
 * catalog test is what flags unknown placeholders in card copy).
 */
export function templatePlaceholders(template: string): TemplatePlaceholder[] {
  const seen = new Set<TemplatePlaceholder>();
  const result: TemplatePlaceholder[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (isTemplatePlaceholder(name) && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

const TEMPLATE_PLACEHOLDERS: ReadonlySet<string> = new Set<TemplatePlaceholder>(
  [
    "Caster",
    "Target",
    "CARD",
    "Bar",
    "color1",
    "color2",
    "color3",
    "duration",
    "cuisine",
    "startTime",
    "endTime",
  ],
);

function isTemplatePlaceholder(name: string): name is TemplatePlaceholder {
  return TEMPLATE_PLACEHOLDERS.has(name);
}

/**
 * Format a whole number of seconds as `m:ss` — minutes with no leading zero and
 * seconds always two digits. For example 90 renders as `"1:30"` and 5 as
 * `"0:05"`. Negative or fractional inputs are clamped to a non-negative integer
 * so the output always matches `^\d+:\d{2}$`.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/**
 * Parse a `m:ss` string (as produced by {@link formatDuration}) back into a
 * whole number of seconds, so `parseDuration(formatDuration(s)) === s`. The
 * seconds component must be exactly two digits in [0, 59]; the minutes
 * component is one or more digits. Any other shape — extra whitespace, a sign,
 * three-digit seconds, or seconds past 59 — returns `null`.
 */
export function parseDuration(text: string): number | null {
  const match = /^(\d+):([0-5]\d)$/.exec(text);
  if (match === null) {
    return null;
  }
  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  return minutes * 60 + seconds;
}

/**
 * Render an ISO instant as a 12-hour clock time, `h:mm AM/PM`, in the viewer's
 * time zone (or `timeZone` when given). The hour has no leading zero and the
 * minutes are always two digits, matching `^\d{1,2}:\d{2} (AM|PM)$`.
 *
 * Implemented with `Intl.DateTimeFormat` so the conversion respects the
 * viewer's locale-independent 12-hour clock and the requested time zone.
 */
export function formatClockTime(iso: string, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  // en-US with these options yields "1:30 PM"; normalize any non-breaking space
  // some runtimes insert before the meridiem to a plain ASCII space.
  return formatter.format(new Date(iso)).replace(/\u202f/g, " ");
}

/**
 * Milliseconds remaining until `endsAtIso` from the server-corrected now
 * (`serverNowMs`), clamped so it never goes below zero. Used to drive countdown
 * labels on timed-effect toasts.
 */
export function remainingMs(endsAtIso: string, serverNowMs: number): number {
  return Math.max(0, Date.parse(endsAtIso) - serverNowMs);
}
