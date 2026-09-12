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
  scripts/          # one-off ops/dev scripts (apply migrations, enable realtime, probes)
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

### `scripts/` — ops / dev scripts

Node scripts run manually (via `node scripts/<name>.mjs`) against a live Supabase
project — e.g. applying migrations, enabling Realtime on `game_events`, and
connectivity/RLS probes. They load `.env.local` via `dotenv` and use the
`postgres`/`@supabase/supabase-js` clients the app already depends on.

Current scripts and how to run them:

```
scripts/
  apply-migrations.mjs      # apply all supabase/migrations/*.sql in order (run once, fresh DB)
  check-db.mjs              # connectivity check: connect + `select 1`, prints host only
  enable-realtime.mjs       # enable Supabase Realtime on game_events
  probe-member-session.mjs  # RLS / member-session probe
  verify-schema.mjs         # verify the applied schema matches expectations
  db-size-report.mjs        # storage breakdown by schema/table + dead-tuple bloat (read-only)
  vacuum-now.mjs            # VACUUM (ANALYZE) to reclaim bloat + refresh stats; prints size before/after
  purge-ended-games.mjs     # delete ended games older than a retention window (cascades to all rows)
```

Storage maintenance (free-tier hygiene):

- `node scripts/db-size-report.mjs` — see where storage is going before deciding to
  clean up. Read-only; changes nothing.
- `node scripts/vacuum-now.mjs` — reclaim dead-tuple bloat and refresh planner stats.
  Safe/routine (not `VACUUM FULL`); superuser-only shared catalogs are skipped with
  harmless warnings.
- `node scripts/purge-ended-games.mjs` — purge aged **ended** games. Because everything
  cascades from `games`, deleting a game removes all its bars/teams/players/claims/cards/
  events; the static `card_definitions` catalog is never touched. **Defaults to a DRY RUN**
  (reports what it would delete + table sizes, changes nothing). Flags: `--apply` to
  actually delete and VACUUM, `--days=N` to set the retention window (default 7).

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
