# Implementation Plan: App Shell, Navigation & Entry Points

## Overview

This plan implements **App shell, navigation & entry points** (ROADMAP U0.1) as an additive
layer on top of the existing lobby feature. It builds five cohesive slices in dependency
order: the served logo asset, a persistent branded `Header_Nav` mounted by the root
`App_Shell`, a branded `Landing_Page` with `Host_Entry` and `Join_Entry`, a new read-only
`Resolution_Service` route that maps a submitted Join_Code to a non-`ended` game id, and the
lobby `?code=` prefill wiring that carries the typed code into the existing lobby.

The approach reuses the locked stack (Next.js App Router + TypeScript, Vercel + Supabase,
Vitest + fast-check) and existing building blocks verbatim: `lib/lobby/joinCode`
(`isValidSubmittedCode`, `normalizeSubmittedCode`) on both client and server, the
`postgres.js` helper in `lib/db/server.ts`, and `components/lobby/JoinGame.tsx`'s existing
`initialJoinCode` support. No new tables, columns, or migrations are required.

Tasks are ordered so each builds on the previous: the asset and shell first (every route
depends on them), then the resolution route (the join path's authority), then the landing
entry points that call it, then the lobby prefill that consumes a successful resolution, and
finally the cross-cutting mobile-first viewport coverage that wires the whole shell together.
The resolution route's pure decision logic is the high-value property-test target; its four
correctness properties each map to a co-located `*.property.test.ts` task.

## Tasks

- [ ] 1. Add the served logo asset
  - Copy `v0/BBB_logo.PNG` to `public/BBB_logo.png` so the logo is reachable at the site-root
    URL `/BBB_logo.png` (only `public/` is served verbatim by Next.js); leave the `v0/`
    original untouched as the canonical source asset
  - _Requirements: 1.2_

- [ ] 2. Implement the persistent branded header (`components/shell/HeaderNav.tsx`)
  - [ ] 2.1 Implement `HeaderNav` server component
    - Brand row: `<img src="/BBB_logo.png" alt="Beltline Bar Brawl" width height />` (explicit
      dimensions to avoid layout shift), tagline text, all wrapped in `<Link href="/"
      aria-label="Beltline Bar Brawl home">`; apply BBB brand colors to background and text
    - _Requirements: 1.2, 1.3, 1.4, 1.6_
  - [ ]* 2.2 Write component render test `components/shell/HeaderNav.test.tsx`
    - Assert logo `alt`, tagline text present, and the brand link resolves to `/`
    - _Requirements: 1.2, 1.3, 1.4_

- [ ] 3. Extend the root layout into the App_Shell (`app/layout.tsx`)
  - Render `<HeaderNav />` inside `<body>` above `{children}`; preserve the existing
    `metadata`/`viewport` exports (device-width, initial-scale 1) so the mobile-first viewport
    lock is retained
  - _Requirements: 1.1, 1.5_

- [ ] 4. Checkpoint - shell renders on every route
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement the code → gameId resolution route (`app/api/games/resolve/route.ts`, NEW)
  - [ ] 5.1 Implement `POST` handler (`runtime = "nodejs"`)
    - Parse JSON body (malformed body → uniform not-found); read `joinCode` string; reject via
      `isValidSubmittedCode` → uniform not-found; `normalizeSubmittedCode` (trim + uppercase),
      then `select id from games where join_code = $1 and lifecycle <> 'ended' limit 1` via
      `getSql()` from `lib/db/server.ts`; no row → uniform not-found; on match return
      `200 { resolved: true, gameId }`; every not-found returns the identical
      `404 { resolved: false }`; select and return **only** `id`; no session, no transaction,
      no event append, no rate limiting
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - [ ]* 5.2 Write property test `app/api/games/resolve/route.property.test.ts` for uniform not-found
    - **Feature: app-shell-navigation, Property 1: Not-found is uniform and indistinguishable**
    - Mock the DB (in-memory `games` map keyed by `join_code` + lifecycle); assert malformed,
      unmatched, and ended-only misses all return the identical body and status
    - **Validates: Requirements 6.2, 6.3, 6.4**
  - [ ]* 5.3 Write property test in `app/api/games/resolve/route.property.test.ts` for only-id-in-response
    - **Feature: app-shell-navigation, Property 2: Successful resolution exposes only the game id**
    - For any code matching exactly one non-`ended` game, assert the response contains the id
      and no other game field (no Join_Code, no lifecycle, no further attributes)
    - **Validates: Requirements 6.1, 6.5**
  - [ ]* 5.4 Write property test in `app/api/games/resolve/route.property.test.ts` for normalization invariance
    - **Feature: app-shell-navigation, Property 3: Resolution is invariant under code normalization**
    - For any code and any whitespace/casing variation, assert both forms produce the same
      outcome (same id on match, or the same uniform not-found)
    - **Validates: Requirements 6.6**
  - [ ]* 5.5 Write unit tests for resolution edge cases
    - Malformed JSON body → 404; a `live`-game code resolves (only `ended` excluded); boundary
      code lengths 5 (reject), 6 (accept-shape), 12 (accept-shape), 13 (reject)
    - _Requirements: 6.1, 6.2, 6.3_

- [ ] 6. Implement the Host entry control (`components/shell/HostEntry.tsx`)
  - Styled `<Link href="/games/new/lobby" role="button">` labeled to indicate hosting, with a
    ≥ 44×44 CSS px touch target and brand styling (no client JS needed)
  - _Requirements: 3.1, 3.2, 7.3_

- [ ] 7. Implement the Join-by-code entry control (`components/shell/JoinEntry.tsx`, client component)
  - [ ] 7.1 Implement `JoinEntry` client component
    - `"use client"`; hold `{ code, submitting, error }` state; render a code text input and a
      submit control (≥ 44×44 CSS px); on submit: `isValidSubmittedCode(raw)` false → show
      invalid-code message and issue **no** request; else `normalizeSubmittedCode`, set
      `submitting` (disable submit), `POST /api/games/resolve` with the normalized code; on
      `res.ok` `router.push('/games/{gameId}/lobby?code={normalized}')` via `next/navigation`;
      on 404 (or fetch throw) show a uniform code-not-recognized message; re-enable submit in
      `finally`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.3_
  - [ ]* 7.2 Write property test `components/shell/JoinEntry.property.test.tsx` for malformed-code short-circuit
    - **Feature: app-shell-navigation, Property 4: Malformed codes never trigger a resolution request**
    - For any raw input whose normalized value is not 6–12 alphanumeric, assert an invalid-code
      message shows and the mocked `fetch` is never called
    - **Validates: Requirements 4.2**
  - [ ]* 7.3 Write interaction tests for JoinEntry (mocked router + fetch)
    - Valid code triggers a fetch and, on success, `router.push` to
      `/games/{gameId}/lobby?code=...`; a 404 shows the not-recognized message; submit is
      disabled while a request is in flight
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [ ] 8. Implement the branded Landing_Page (`app/page.tsx`)
  - Replace the foundation "baseline is running" splash with a mobile-first single-column
    server component rendering landing branding (logo/tagline/brand colors) plus `<HostEntry />`
    and `<JoinEntry />`; static, no data dependency (returns HTTP 200)
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ]* 8.1 Write landing render test (`app/page.smoke.test.tsx` or a new render test)
    - Assert Host_Entry links to `/games/new/lobby`, the Join_Entry input + submit render, and
      the "baseline is running" text is gone
    - _Requirements: 2.1, 2.4, 3.2, 4.1_

- [ ] 9. Wire the lobby `?code=` prefill (`app/games/[gameId]/lobby/page.tsx`)
  - Read `useSearchParams().get("code")` and pass it as `JoinGame`'s `initialJoinCode` when
    `view.joinCode` is not yet known; prefer the authoritative `view.joinCode` once the
    snapshot loads; a Share_Link with no `?code=` falls back to the existing `view.joinCode`
    prefill (already implemented)
  - _Requirements: 4.4, 5.1, 5.2_
  - [ ]* 9.1 Write interaction test for lobby prefill precedence
    - Opening `/games/{gameId}/lobby?code=ABC123` seeds `initialJoinCode` before the snapshot;
      once `view.joinCode` loads it takes precedence; no `?code=` still prefills from
      `view.joinCode`
    - _Requirements: 5.1, 5.2_

- [ ] 10. Add mobile-first shell + landing CSS (`app/globals.css`)
  - Shell/header and landing styles: single-column, `box-sizing: border-box`, `max-width: 100%`,
    no fixed widths, tagline `flex-wrap`/ellipsis so the header and landing fit 320–430px with
    no horizontal scroll; Host_Entry and Join_Entry submit expose ≥ 44×44 CSS px targets
  - _Requirements: 7.1, 7.2, 7.3_
  - [ ]* 10.1 Write viewport tests (`app/page.viewport.test.tsx` + `components/shell/HeaderNav.viewport.test.tsx`)
    - Landing page and header fit 320–430px with no horizontal overflow; Host_Entry and
      Join_Entry submit each expose ≥ 44×44 CSS px targets
    - _Requirements: 7.1, 7.2, 7.3_

- [ ] 11. Final checkpoint - shell, entry points, and resolution wired end to end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core
  implementation tasks are never optional.
- Each task references specific requirements clauses for traceability.
- All four design correctness properties are covered by co-located property tests: Property 1
  (5.2), Property 2 (5.3), Property 3 (5.4) on the Resolution_Service, and Property 4 (7.2) on
  Join_Entry.
- Property tests use fast-check with a minimum of 100 iterations (`{ numRuns: 100 }`) and are
  each tagged `Feature: app-shell-navigation, Property {n}: {text}`, matching the repo's
  existing `*.property.test.ts` suites.
- The Resolution_Service DB is mocked in property tests (an in-memory `games` map) so the
  properties exercise our decision logic, not Supabase; edge-case, interaction, and viewport
  tests cover the remaining behaviors per the design's Testing Strategy.
- No new tables, columns, or migrations: the route reads the existing `games` table
  (`join_code` unique index, `lifecycle` filter) and returns only `id`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "5.1", "6"] },
    { "id": 1, "tasks": ["2.1", "5.2", "5.3", "5.4", "5.5", "7.1"] },
    { "id": 2, "tasks": ["2.2", "3", "7.2", "7.3", "9"] },
    { "id": 3, "tasks": ["8", "9.1", "10"] },
    { "id": 4, "tasks": ["8.1", "10.1"] }
  ]
}
```
