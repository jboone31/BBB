# Tech

_No application code exists yet. This file records the intended technical direction and
open decisions. Choices are provisional and will be finalized in the web-app phase._

## Intended Stack

- **Runtime:** Node.js.
- **Hosting target:** Vercel.
- **Backend candidate:** Supabase (managed Postgres, auth, real-time subscriptions,
  temporary file/photo storage). Chosen as the leading option, not yet locked.

## Key Technical Concern: Real-Time Propagation

The single biggest v0 problem was latency: cards played against a team took up to 15
minutes to reach them over text. The app must propagate game state changes (card plays,
bar claims, targeting/notifications, score updates) to all clients in near real time.
This requirement should drive backend and data-layer decisions. Supabase real-time
subscriptions are the leading approach; evaluate against alternatives.

## Open Decisions

- **Hosting alternative — AWS:** Produce a plan for hosting on AWS as an alternative to
  Vercel + Supabase, including a rough cost estimate. To be evaluated in the web-app phase.
- **Bar selection mechanism:** Map API vs. a predetermined bar list (with an admin
  approval flow for player-proposed bars). Decision depends on how heavy the map API
  integration is.
- **Map / claim visualization:** Map API, in-house map with hard-coded coordinates, or a
  simple list view for showing which teams have claimed which bars.
- **Photo handling:** Card validation may require temporary photo uploads shown in a
  public feed; storage lifecycle and privacy still to be designed.

---

_Barebones by design. Update as the stack, hosting choice, and integrations are decided._
