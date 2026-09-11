# Tech

_The stack is **locked** for the web-app foundation. This file records the decided
technical direction. The AWS hosting alternative remains a documented fallback._

## Locked Stack

- **Runtime & framework:** Node.js with **Next.js (App Router)** in **TypeScript**.
- **Hosting:** **Vercel** (app + serverless routes + cron).
- **Backend:** **Supabase** — managed **Postgres**, **Realtime**, **Auth**, and
  **Storage** (temporary photo/file handling for card validation).
- **Testing:** **Vitest** as the runner, **fast-check** for property-based tests.
- **Data access:**
  - **postgres.js** for transaction-capable server writes (a domain write and its
    `game_events` append committed atomically in one transaction from server routes).
  - **@supabase/supabase-js** for the browser client (RLS-scoped reads and Realtime
    subscriptions).

## Real-Time Propagation (decided)

The core v0 problem was latency — card plays reached opposing teams up to 15 minutes late.
The v1 approach: an **append-only `game_events` log** in Postgres. Clients subscribe via
**Supabase Realtime Postgres-changes** on that table, so every state change (card plays,
bar claims, targeting/notifications, score updates) propagates to all clients in near real
time. Server routes write the domain change and append the corresponding event in a single
transaction, keeping state and the event log consistent.

## Fallback / Deferred

- **AWS hosting alternative:** a plan for hosting on AWS instead of Vercel + Supabase,
  with a rough cost estimate, remains a documented fallback. Deferred; not needed while
  Vercel + Supabase is the active choice.

## Still To Be Designed

- **Bar selection mechanism:** map API vs. a predetermined bar list (with an admin
  approval flow for player-proposed bars).
- **Map / claim visualization:** map API, in-house map with hard-coded coordinates, or a
  simple list view of which teams have claimed which bars.
- **Photo handling:** storage lifecycle and privacy for temporary card-validation uploads
  shown in a public feed (Supabase Storage is the target).

---

_Update as remaining integrations (bar selection, map, photo lifecycle) are designed._
