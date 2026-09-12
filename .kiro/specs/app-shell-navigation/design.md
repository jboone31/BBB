# Design Document

## Overview

This feature builds the **app shell, navigation, and entry points** (ROADMAP U0.1) —
the UI skeleton every later screen plugs into. It does four things, all mobile-first:

1. Replaces the bare `app/layout.tsx` body wrapper with an **App_Shell** that renders a
   persistent branded **Header_Nav** above every page's content.
2. Replaces the foundation "baseline is running" splash in `app/page.tsx` with a branded
   **Landing_Page** offering exactly two entry points: **Host_Entry** and **Join_Entry**.
3. Wires **Host_Entry** to navigate to the existing create surface at `/games/new/lobby`,
   and wires the **Share_Link** join path (`/games/{gameId}/lobby`) to prefill the lobby's
   join code (which the existing `LobbyPage` already supports via `JoinGame`'s
   `initialJoinCode`).
4. Adds a new **code → gameId resolution** server route so a player who only has a
   Join_Code can be routed to the correct game's lobby.

The design is deliberately additive. It reuses the locked stack (Next.js App Router +
TypeScript, Vercel + Supabase, Vitest + fast-check) and existing building blocks:

- `lib/lobby/joinCode.ts` validators (`isValidSubmittedCode`, `normalizeSubmittedCode`) —
  reused verbatim on both the client (advisory feedback) and the server (authoritative).
- The session-based Identity_Model (`x-bbb-session-id`) and structured-response
  conventions from `app/api/games/_shared.ts`.
- `components/lobby/JoinGame.tsx`, which already accepts `initialJoinCode`.
- `app/games/[gameId]/lobby/page.tsx`, which already renders the lobby (create surface at
  `/games/new/lobby`, a specific game at `/games/{gameId}/lobby`) and already seeds
  `JoinGame`'s `initialJoinCode` from the folded `view.joinCode`.

**Explicitly out of scope** (per requirements): changing the six lobby routes or the join
flow itself, rate limiting or heavier enumeration hardening on the resolution route, and
full per-screen branding polish (owned by F4.3/U4.1).

## Architecture

```
                          ┌──────────────────────────────────────────┐
                          │  App_Shell  (app/layout.tsx — root layout)│
                          │  ┌────────────────────────────────────┐  │
   every route  ────────► │  │  Header_Nav  (brand link → "/")     │  │
                          │  └────────────────────────────────────┘  │
                          │  { children }  ← current page content     │
                          └──────────────────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                            ▼                           ▼
   Landing_Page ("/")          Lobby_Page (existing)         other routes
   app/page.tsx                /games/new/lobby              (demo, etc.)
   ┌──────────────────┐        /games/{gameId}/lobby
   │  Host_Entry ─────┼─► router.push("/games/new/lobby")
   │  Join_Entry      │        ▲
   │   code input ────┼────┐   │ router.push("/games/{id}/lobby")
   └──────────────────┘    │   │            (with code prefilled)
                           ▼   │
              POST /api/games/resolve  (Resolution_Service — NEW)
                           │
                           ▼
                   Supabase Postgres (games.join_code → games.id)
```

**Layer boundaries.**

- **App_Shell / Header_Nav** are server components (no client JS needed); the brand link is
  a plain Next.js `<Link>`.
- **Landing_Page** is a server component for its static branding; **Join_Entry** is a small
  client component (it holds input state, calls the resolution route, and navigates), and
  **Host_Entry** can be a client component or a `<Link>` — a `<Link href="/games/new/lobby">`
  styled as a button is the simplest and needs no JS.
- **Resolution_Service** is a Node.js runtime route handler (`runtime = "nodejs"`) that uses
  the same `postgres.js` connection helper (`lib/db/server.ts`) the lobby routes use. It is
  a read-only lookup — no transaction or event append is required.

**Navigation model.** All navigation is client-side via `next/navigation`'s `useRouter().push`
(Join_Entry) or `<Link>` (Host_Entry, Header_Nav brand). The share-link path needs no new
code beyond confirming the existing lobby prefill works: opening `/games/{gameId}/lobby`
already folds the game's events and seeds `JoinGame` with `view.joinCode`.

## Components and Interfaces

### 1. Logo asset (`public/BBB_logo.png`)

The logo currently lives at `v0/BBB_logo.PNG`, which is **not** served by Next.js — only
files under `public/` are served verbatim at the site root. The `v0/` directory is preserved
original design/assets and is not a static-serving location.

**Decision:** copy the logo into `public/` (e.g. `public/BBB_logo.png`) so it is reachable
at the URL path `/BBB_logo.png`. The `v0/BBB_logo.PNG` original stays as-is (it is the
canonical source asset per the structure steering). The Header_Nav references the copy via
`next/image` (`<Image src="/BBB_logo.png" .../>`) or a plain `<img>` with explicit
dimensions to avoid layout shift.

> This satisfies R1.2 ("logo sourced from the project logo asset"): the served copy is the
> project logo asset relocated to a Next.js-servable path.

### 2. `App_Shell` — root layout (`app/layout.tsx`)

Extends the existing root layout. Today it renders `<html><body>{children}</body></html>`
with metadata + viewport. The change: render `Header_Nav` inside `<body>` above `{children}`.

```tsx
// app/layout.tsx (server component)
import Header_Nav from "@/components/shell/HeaderNav";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HeaderNav />
        {children}
      </body>
    </html>
  );
}
```

- **R1.1 / R1.5:** rendering `HeaderNav` in the root layout puts it on every route, above the
  page content.
- Existing `metadata`/`viewport` exports (device-width, initial-scale 1) are preserved, so the
  mobile-first viewport lock still applies (R7).

### 3. `Header_Nav` (`components/shell/HeaderNav.tsx`)

A small server component: brand row with the logo, tagline text, and a link home.

```tsx
export default function HeaderNav(): React.JSX.Element {
  return (
    <header /* brand background/text colors; flex row; no horizontal overflow */>
      <Link href="/" aria-label="Beltline Bar Brawl home">
        <img src="/BBB_logo.png" alt="Beltline Bar Brawl" width={/*…*/} height={/*…*/} />
        <span>Race the Beltline. Claim the bars.</span> {/* tagline */}
      </Link>
    </header>
  );
}
```

Responsibilities & requirement mapping:

- **R1.2:** renders the logo from the served asset path (`/BBB_logo.png`).
- **R1.3:** renders the BBB tagline text.
- **R1.4:** the brand is wrapped in `<Link href="/">`, so activating it navigates to the
  Landing_Page.
- **R1.6:** applies BBB brand colors to background and text via inline styles or a shell class
  in `globals.css`.
- **R7.2:** flex layout with `max-width: 100%`, `flex-wrap`/ellipsis on the tagline, and no
  fixed widths, so it fits 320–430px with no horizontal scroll.

### 4. `Landing_Page` (`app/page.tsx`)

Replaces the foundation splash (R2.4). A server component that renders branding plus the two
entry points.

```tsx
export default function HomePage() {
  return (
    <main /* mobile-first single column, brand colors */>
      {/* R2.2: logo + tagline + brand colors (shell already shows logo; page reinforces
          brand identity for the landing hero) */}
      <HostEntry />   {/* R3 */}
      <JoinEntry />   {/* R4 */}
    </main>
  );
}
```

- **R2.1 / R2.3:** requesting `/` renders both `HostEntry` and `JoinEntry`; the route is a
  static server component with no data dependency, so it responds HTTP 200.
- **R2.4:** the "baseline is running" copy is removed entirely.
- **R7.1 / R7.3:** single-column layout, `box-sizing: border-box`, `max-width: 100%`, controls
  ≥ 44×44 CSS px.

### 5. `Host_Entry` (`components/shell/HostEntry.tsx` or inline)

The simplest correct implementation is a styled `<Link>` — no client JS:

```tsx
<Link
  href="/games/new/lobby"
  role="button"
  style={{ minHeight: "44px", minWidth: "44px" /* + brand styling */ }}
>
  Host a game
</Link>
```

- **R3.1:** labeled to indicate hosting.
- **R3.2:** navigates to `/games/new/lobby` (the existing create surface).
- **R7.3:** ≥ 44×44 CSS px touch target.

### 6. `Join_Entry` (`components/shell/JoinEntry.tsx`, client component)

Owns a Join_Code input, client-side shape validation (reusing `lib/lobby/joinCode`), the call
to the Resolution_Service, and navigation on success.

```tsx
"use client";
import { useRouter } from "next/navigation";
import { isValidSubmittedCode, normalizeSubmittedCode } from "@/lib/lobby/joinCode";

// state: code, submitting, error
async function onSubmit() {
  const raw = code;
  if (!isValidSubmittedCode(raw)) {          // R4.2: no request issued
    setError("That code doesn't look right — enter a 6–12 character code.");
    return;
  }
  const normalized = normalizeSubmittedCode(raw);   // R4.3
  setSubmitting(true);                              // R4.6: disable submit
  try {
    const res = await fetch("/api/games/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: normalized }),
    });
    if (res.ok) {
      const { gameId } = (await res.json()) as { gameId: string };
      // R4.4: route to the lobby; carry the code so the lobby can prefill it.
      router.push(`/games/${gameId}/lobby?code=${encodeURIComponent(normalized)}`);
    } else {
      setError("We couldn't find a game for that code."); // R4.5 (uniform not-found)
    }
  } finally {
    setSubmitting(false);
  }
}
```

- **R4.1:** renders a text input for the code and a submit control.
- **R4.2:** when the normalized value is not 6–12 alphanumeric, shows an invalid-code message
  and issues **no** resolution request.
- **R4.3:** sends the normalized code to the Resolution_Service.
- **R4.4:** on a matching id, navigates to `/games/{gameId}/lobby` with the code prefilled
  (see the prefill note below).
- **R4.5:** on a not-found result, shows a code-not-recognized message.
- **R4.6:** the submit control is disabled while a request is in flight.
- **R7.3:** the submit control is ≥ 44×44 CSS px.

**Prefill mechanism (R4.4 / R5.2).** The lobby page already seeds `JoinGame`'s
`initialJoinCode` from the folded `view.joinCode` once the snapshot loads. To also prefill
immediately from the submitted code (before the snapshot resolves) and to support share links
that don't yet know the code, Join_Entry passes the normalized code as a `?code=` query param.
A small addition in `LobbyPage` reads `useSearchParams().get("code")` and passes it as
`initialJoinCode` when `view.joinCode` is not yet known, preferring the authoritative
`view.joinCode` once it arrives. For a Share_Link that carries no `?code=`, the existing
`view.joinCode` prefill (R5.2) already covers it.

### 7. `Resolution_Service` — `POST /api/games/resolve` (`app/api/games/resolve/route.ts`, NEW)

A Node.js runtime route that maps a submitted Join_Code to the id of the single non-`ended`
game that owns it. Read-only — no transaction, no event append.

```ts
export const runtime = "nodejs";

interface ResolveBody { readonly joinCode?: unknown; }

// Uniform not-found: identical body + status for every miss (R6.4).
const NOT_FOUND = { status: 404 as const, body: { resolved: false } };

const RESOLVE_SQL = `
  select id
  from games
  where join_code = $1 and lifecycle <> 'ended'
  limit 1
`;

export async function POST(request: Request): Promise<NextResponse> {
  let body: ResolveBody;
  try { body = (await request.json()) as ResolveBody; }
  catch { return notFound(); }                       // malformed body → uniform miss (R6.4)

  const raw = typeof body.joinCode === "string" ? body.joinCode : "";
  if (!isValidSubmittedCode(raw)) return notFound();  // R6.2 (shape) → uniform miss

  const normalized = normalizeSubmittedCode(raw);     // R6.6 (trim + uppercase)
  const { rows } = await getSql().unsafe(RESOLVE_SQL, [normalized]);
  const row = rows[0];
  if (!row) return notFound();                        // R6.3 (no non-ended match) → uniform miss

  // R6.1 + R6.5: return ONLY the resolved id, nothing else.
  return NextResponse.json({ resolved: true, gameId: String(row.id) }, { status: 200 });
}

function notFound(): NextResponse {
  return NextResponse.json({ resolved: false }, { status: 404 });
}
```

Interface contract:

| Case | Condition | Response |
| --- | --- | --- |
| Match | normalized code is 6–12 alnum AND matches exactly one non-`ended` game | `200 { resolved: true, gameId }` (R6.1) |
| Malformed | normalized code is not 6–12 alnum | `404 { resolved: false }` (R6.2) |
| No match | well-formed but no non-`ended` game | `404 { resolved: false }` (R6.3) |
| Ended-only match | code belongs only to an `ended` game | `404 { resolved: false }` (R6.4) |

- **R6.4 (uniform not-found):** malformed, unmatched, and ended-only cases all return the exact
  same body (`{ resolved: false }`) and status (`404`). A caller cannot distinguish them; the
  only observably different outcome is a successful resolution.
- **R6.5 (minimal leak):** the SQL selects only `id`; the response includes only `gameId` on
  success. The Join_Code, lifecycle, and every other game field are excluded.
- **R6.6 (normalize):** the code is trimmed + uppercased via `normalizeSubmittedCode` before
  matching, matching how codes are stored (`normalizeSubmittedCode` is applied on the join
  path too), so casing/whitespace never cause a valid code to miss.
- **No session required:** unlike the mutation routes, resolution is a pre-join lookup a
  visitor performs before they have joined; requiring `x-bbb-session-id` would add no security
  value (there is nothing session-scoped to authorize) and would break the entry flow.
- **Minimal hardening, deferred items:** no rate limiting and no additional enumeration
  hardening in this pass (explicitly deferred). The uniform not-found is the enumeration
  mitigation that *is* in scope.

## Data Models

No new tables, columns, or migrations. The Resolution_Service reads the existing `games`
table:

```
games
  id           uuid / text   (returned on a successful resolve — the ONLY field exposed)
  join_code    text          (matched against; unique index already exists; never returned)
  lifecycle    'lobby' | 'live' | 'ended'   (filtered: only non-'ended' matches; never returned)
```

The query `select id from games where join_code = $1 and lifecycle <> 'ended' limit 1` relies
on the existing unique index on `join_code`. Because codes are globally unique (including
retained by `ended` games), at most one non-`ended` game can match a given code.

Client-side, `Join_Entry` holds transient view state only:

```ts
interface JoinEntryState {
  code: string;           // raw user input
  submitting: boolean;    // in-flight guard (R4.6)
  error: string | null;   // invalid-code (R4.2) or not-recognized (R4.5) message
}
```

## Error Handling

| Surface | Condition | Handling |
| --- | --- | --- |
| Join_Entry | code not 6–12 alnum after normalize | inline invalid-code message; **no** request (R4.2) |
| Join_Entry | resolution returns 404 | inline "code not recognized" message (R4.5) |
| Join_Entry | network/fetch throws | treated as a not-recognized/try-again message; submit re-enabled via `finally` (R4.6) |
| Resolution_Service | malformed JSON body | uniform `404 { resolved: false }` (R6.2/R6.4) |
| Resolution_Service | bad code shape | uniform `404 { resolved: false }` (R6.2/R6.4) |
| Resolution_Service | no non-`ended` match / ended-only | uniform `404 { resolved: false }` (R6.3/R6.4) |
| Resolution_Service | DB/connection error | `500` (a genuine server fault, distinct from a not-found miss; does not leak game existence) |
| App_Shell / Landing | logo asset missing | `<img alt>` / `next/image` fallback text renders; page still returns 200 |

The critical error-handling invariant is **not-found uniformity**: the route must never let the
distinction between malformed, unmatched, and ended-only leak through status, body, headers, or
timing-visible branching in the response shape.

## Testing Strategy

Stack: **Vitest** runner + **fast-check** for property tests, consistent with the repo's
existing `*.property.test.ts` suites. Run single-shot with `vitest --run`.

**Property tests (Resolution_Service).** The resolution route's pure decision logic is the
high-value target: behavior varies meaningfully across a large input space (arbitrary strings,
codes of every length, matched/unmatched/ended states), and the security-relevant uniformity
guarantee is exactly a universal property. The DB is mocked (an in-memory `games` map keyed by
`join_code` with a lifecycle) so 100+ iterations stay cheap and test *our* decision logic, not
Supabase.

- Uniform not-found across malformed / unmatched / ended cases (Property 1).
- Success returns only the id, no other game field (Property 2).
- Normalization: codes differing only in case/surrounding whitespace resolve identically
  (Property 3).

**Example / edge-case unit tests.**

- Malformed JSON body → 404 not-found.
- A code matching a `live` game resolves (only `ended` is excluded).
- Boundary code lengths: 5 (reject), 6 (accept-shape), 12 (accept-shape), 13 (reject).

**Component / integration tests.**

- `HeaderNav` renders on a page (smoke render) with logo `alt`, tagline text, and a home link
  → `/` (R1.2/R1.3/R1.4).
- Landing page renders Host_Entry (links `/games/new/lobby`) and Join_Entry input + submit
  (R2.1/R3.2/R4.1); asserts the "baseline is running" text is gone (R2.4).
- Join_Entry: invalid code shows a message and issues no fetch (R4.2); valid code triggers a
  fetch and, on success, a `router.push` to the lobby with the code (R4.4); on 404 shows the
  not-recognized message (R4.5); submit is disabled while in flight (R4.6). These are
  interaction assertions with a mocked router and fetch, not properties.
- Mobile-first viewport checks (mirroring existing `*.viewport.test.tsx`): landing page and
  header fit 320–430px with no horizontal overflow (R7.1/R7.2), and Host_Entry / Join_Entry
  submit expose ≥ 44×44 CSS px targets (R7.3).

**Property test configuration.** Minimum 100 iterations per property. Each property test is
tagged `Feature: app-shell-navigation, Property {n}: {text}` and references its design
property.

**Rationale for what is NOT property-tested.** The App_Shell/Header_Nav/landing rendering,
mobile-first layout, and Host_Entry/Share_Link navigation are UI/config behaviors whose output
does not vary meaningfully with generated input — they are covered by smoke, interaction, and
viewport tests, not properties. The share-link prefill reuses already-tested lobby wiring.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions
of a system — essentially, a formal statement about what the system should do. Properties serve
as the bridge between human-readable specifications and machine-verifiable correctness
guarantees.*

### Property 1: Not-found is uniform and indistinguishable

*For any* submitted code and any backing set of games, if the resolution does not succeed —
whether because the normalized code is not 6–12 alphanumeric, because no non-`ended` game
matches it, or because it matches only an `ended` game — the Resolution_Service returns the
identical response shape and HTTP status, so a caller cannot distinguish these cases from one
another.

**Validates: Requirements 6.2, 6.3, 6.4**

### Property 2: Successful resolution exposes only the game id

*For any* submitted code that matches exactly one non-`ended` game, the Resolution_Service
response contains that game's id and no other game field (no Join_Code, no lifecycle, no
further attributes).

**Validates: Requirements 6.1, 6.5**

### Property 3: Resolution is invariant under code normalization

*For any* Join_Code and any surrounding whitespace or letter-casing variation of it, submitting
either form to the Resolution_Service produces the same resolution outcome (the same game id on
a match, or the same uniform not-found), because the code is trimmed and uppercased before
matching.

**Validates: Requirements 6.6**

### Property 4: Malformed codes never trigger a resolution request

*For any* raw input whose normalized value is not 6–12 alphanumeric characters, Join_Entry
reports an invalid-code message and issues no request to the Resolution_Service.

**Validates: Requirements 4.2**
