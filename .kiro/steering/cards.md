# Cards

_Finalized v1 card catalog. This is the authoritative flat list of every card in the
Brawl Deck, taken from the finalized ruleset in `v1/Beltline Bar Brawl_redux.txt`. Each
team's deck contains one of each card below._

## How cards work (quick reference)

- Each team's deck contains **one of each** card listed here (identical decks).
- Teams hold **up to two** cards; before drawing a third they must play or discard one.
- Most cards **target one opposing team**, chosen by the casting team at play time. Some
  are **self** (benefit the casting team), some target a **bar**, and some have **no
  target**. Each card notes this inline below.
- A targeted challenge must be resolved by the affected team **before it claims another
  bar**. Casting and resolution rules live in `game-rules.md`.
- No team may be targeted by a challenge card of the **same name** more than once.

## MVP note

For the initial app, most cards are enforced by the **honor system** with a **toast
notification** to the targeted team (near-real-time, fixing v0's latency problem). Only
cards that **change point values** (Insurance, Happy Hour, Party Crasher, Patient
Investor, and the finish-bar award) need dedicated backend/scoring support in the MVP.
The rest are surfaced as notifications and tracked socially.

## The Cards

- **Go Piss Girl** — _(targets a team)_ At least one member of the target team must enter a
  publicly accessible restroom that is **not** located inside any bar.

- **Crop Dusting** — _(no target)_ Must be played physically inside any bar that is not the
  finish bar. Once played, **no other team may enter that bar for 15 minutes**.

- **Moneybags** — _(targets a team)_ The target team must find a product with a visible
  price tag of **more than $150** inside any retail store. A photo of the price tag is
  required for verification.

- **Use It or Lose It** — _(targets a team)_ The target team must **immediately play every
  card** currently in their hand. Any card whose playing requirement cannot be met at that
  moment is discarded with no effect.

- **Wired** — _(targets a team)_ The target team must order a **shot of espresso** from a
  location that is not a bar.

- **Art School Dropout** — _(targets a team; casting requirement)_ The casting team must
  first take a photo of a mural, graffiti, or art installation containing **three distinct
  colors** (ROYGBIV only). The target team must then photograph a **different** mural,
  graffiti, or art installation containing three such colors.

- **Broad Shoulders** — _(targets a team)_ The target team must take a photo with at least
  one member standing next to an **official ATL Tiny Door** installation.

- **Bird Guide** — _(targets a team; casting requirement)_ The casting team must first film
  a continuous video (up to 5 minutes) in which a **single bird** stays visible in frame.
  The target team must then film a continuous video of **another bird**, kept in frame for
  at least as long as the casting team's.

- **Interested Buyer** — _(targets a team)_ The target team must obtain a
  **souvenir/brochure** from any apartment leasing office. If most leasing offices are
  closed that day, they may take a picture in front of one instead.

- **Different Tastes** — _(targets a team; casting requirement)_ The casting team must first
  take a picture next to a restaurant. The target team must then photograph a restaurant
  whose cuisine is from the **same continent** as the casting team's restaurant.

- **Everyone's a Critic** — _(targets a team)_ The target team must take a picture on the
  premises of a location with **at least 4.5 stars on Google**. If they fail, they may not
  claim a bar for **15 minutes**. The targeted team may not use the internet for research
  until making an attempt.

- **Fairest of Them All** — _(reactive; targets the casting team)_ May only be played
  **immediately after your team is targeted** by a challenge card. Forces the casting team
  to **also complete** that challenge card's requirements (both teams complete it).

- **Pioneer** — _(targets a team)_ The **next bar claimed** by the target team must be an
  **unclaimed bar that is not the finish bar**.

- **Cancel Culture** — _(targets a bar; announced on play)_ Targets a bar that is **not
  within 0.25 miles of the finish bar**, announced publicly on play. Beginning **15 minutes
  after** the target bar is announced, no bar within **0.25 miles** of it may be claimed for
  the **next 15 minutes**.

- **Spin Cycle** — _(targets a team)_ The target team must immediately return to the
  entrance of the bar their team **most recently claimed**.

- **Dirty Bird** — _(targets a team)_ The target team must take a photo with a
  **non-team member wearing Atlanta sports team merchandise**.

- **Scenic Route** — _(targets a team)_ The target team's next claimed bar must be
  **farther from the finish bar** than the last bar their team claimed.

- **Insurance** — _(self)_ The points your team receives from the **next bar you claim
  cannot be reduced** by later-claiming teams. Other teams receive points for claiming that
  bar as if sharing normally (so the total awarded on the bar can exceed 12).

- **Happy Hour** — _(targets a bar)_ Targets any bar that is not the finish bar. Any team
  that drinks at the target bar in the **next hour** gets **+5 points for the first drink
  only**, even if they have already claimed it.

- **Party Crasher** — _(targets a bar)_ Targets any non-finish bar that **fewer than four
  teams** have claimed. Teams claiming this bar score **as if sharing with one extra
  (phantom) team**. If four teams claim it, the phantom share disappears and all teams score
  the normal 3 each.

- **Patient Investor** — _(self)_ After your team claims **four more bars**, gain **+6
  points**.

- **Power Hour** — _(no target; persistent)_ For the **next twenty minutes**, whenever any
  team claims a bar, that team **draws two cards and keeps both**.

- **Voted Off the Island** — _(targets a team; casting requirement)_ May only be played once
  **all four teams have claimed a non-starting bar**. The target team must **un-claim** a
  bar that all four teams have claimed. They may choose to re-claim that bar.

## Design notes

- v1 favors cards the app can **surface immediately** (fixing v0's 15-minute relay latency)
  and, where practical, **validate** (photo uploads, location checks, timers).
- Point-affecting cards (Insurance, Happy Hour, Party Crasher, Patient Investor) interact
  with scoring and are the priority for backend support; the rest are notification-driven.

---

_The v1 card set is finalized. Exact timers and app-validation logic for each card will be
specified during the web-app phase._
