# Tech

_The stack is **locked** for the web-app foundation. This file records the decided
technical direction. The AWS hosting alternative remains a documented fallback._

## Locked Stack

- **Runtime & framework:** Node.js with **Next.js (App Router)** in **TypeScript**.
- **Hosting:** **Vercel** (app + serverless routes + cron).
- **Backend:** **Supabase** — managed **Postgres**, **Realtime**, **Auth**, and
  **Storage** (temporary photo/file handling for card validation).
- **Testing:** **Vitest** as the runner, **fast-check** for property-based tests.
  Live Supabase integration tests are configured and available with
  `npm run test:integration`; the default `npm test` run remains hermetic and
  offline.
- **Data access:**
  - **postgres.js** for transaction-capable server writes (a domain write and its
    `game_events` append committed atomically in one transaction from server routes).
  - **@supabase/supabase-js** for the browser client (RLS-scoped reads and Realtime
    subscriptions).
- **Mapping:** **Leaflet** via **react-leaflet** (with
  `leaflet-defaulticon-compatibility`) renders the live bar map and team claim markers
  client-side. No paid map API; chosen for the claim-visualization work.

## Real-Time Propagation (decided)

The core v0 problem was latency — card plays reached opposing teams up to 15 minutes late.
The v1 approach: an **append-only `game_events` log** in Postgres. Clients subscribe via
**Supabase Realtime Postgres-changes** on that table, so every state change (membership joins,
team assignments, departures, game start/end, card plays, bar claims,
targeting/notifications, and score updates) propagates to all clients in near real time.
Server routes write the domain change and append the corresponding event in a single
transaction, keeping state and the event log consistent.

The active board folds the event stream into one authoritative client projection. This keeps
initial snapshots, reconnects, and live events consistent for rosters, join-code identity,
lifecycle/read-only state, scores, claims, and notifications. Participant departure uses an
authorized transactional removal plus `player_left`; host departure reuses the atomic
live-to-ended transition.

## Fallback / Deferred

- **AWS hosting alternative:** a plan for hosting on AWS instead of Vercel + Supabase,
  with a rough cost estimate, remains a documented fallback. Deferred; not needed while
  Vercel + Supabase is the active choice.

## Decided (previously open)

- **Map / claim visualization:** resolved — a client-side **Leaflet** map plots candidate
  bars and renders which teams have claimed which bars (`lib/map/`,
  `components/board/BarLeafletMap.tsx`). Claiming writes through a score ledger
  (`lib/claims/`, `lib/scoring/`, migration `0010_claims_and_score_ledger.sql`).

## Still To Be Designed

- **Bar selection mechanism:** candidate bars now feed the map, but the sourcing model
  (curated list vs. map/geocoding API) and the admin approval flow for player-proposed
  bars are still open.
- **Photo handling:** storage lifecycle and privacy for temporary card-validation uploads
  shown in a public feed (Supabase Storage is the target).

---

_Update as remaining integrations (bar selection, map, photo lifecycle) are designed._
