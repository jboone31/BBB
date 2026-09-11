# Structure

_The web-app foundation is scaffolded. This file documents the **real** current layout.
Requirement 2.3 demands bidirectional consistency: every directory named here exists in
the repo, and every top-level source directory in the repo is listed here. An automated
check keeps this list honest, so keep the top-level entries below accurate._

## Top-Level Layout

```
BBB/
  app/              # Next.js App Router: pages, layout, API routes
  components/       # React UI components
  lib/              # framework-free shared logic (game rules, scoring, data access)
  supabase/         # database migrations + backend config
  public/           # static assets served as-is
  test/             # cross-cutting test suites not co-located with source
  docs/             # architecture decision records and design notes
  v0/               # preserved original game design + assets
  .kiro/            # steering, specs, hooks
```

Everything else at the root is committed configuration and tooling (not source
directories): `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`,
`eslint.config.mjs`, `vitest.config.mts`, `.prettierrc.json`, `.prettierignore`,
`.gitattributes`, `.gitignore`, `.nvmrc`, `.env.example`, `instrumentation.ts`,
`next-env.d.ts`, `README.md`, `ROADMAP.md`.

## Directory Details

### `app/` — Next.js App Router

```
app/
  api/              # server route handlers
    cron/           # scheduled/maintenance endpoints
    demo-mutation/  # demo transactional-write endpoint
    games/          # game resource routes
  demo/             # real-time propagation demo page
  layout.tsx        # root layout
  page.tsx          # landing page
  globals.css       # global styles
```

UI pages and server routes live together under the App Router. Tests are co-located
(e.g. `page.smoke.test.tsx`, `page.viewport.test.tsx`).

### `components/` — React components

Shared client components (e.g. `PropagationDemo.tsx`).

### `lib/` — framework-free shared logic

Pure/domain logic that does not depend on Next.js, so it can be unit- and
property-tested in isolation.

```
lib/
  env/        # startup env loading + validation (fail fast on missing config)
  scoring/    # bar point-split scoring
  gameend/    # game-end / winner determination
  events/     # append-only game_events log helpers
  realtime/   # Supabase Realtime subscription helpers
  db/         # transactional server writes (postgres.js) + client access
  games/      # game domain operations
  claims/     # bar-claim domain operations
```

### `supabase/` — database + backend config

```
supabase/
  migrations/   # SQL schema migrations
  __tests__/    # backend/schema tests
```

### `public/` — static assets

Files served verbatim (logo, icons, etc.).

### `test/` — cross-cutting tests

Suites that aren't tied to a single source file.

```
test/
  smoke/    # lint/format and other project-wide smoke checks
```

### `docs/` — decision records

```
docs/
  decisions/   # architecture decision records (e.g. hosting + stack)
```

---

_Keep the **Top-Level Layout** list above in sync with the repo: add a directory here
when you create a new top-level source directory, and remove one when it goes away._
