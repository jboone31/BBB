---
inclusion: auto
name: BBB Card Catalog
description: The Beltline Bar Brawl card catalog and proposed card reworks. Activate this when discussing, designing, balancing, or implementing card functionality (the deck, individual cards, card effects, targeting, validation, or card-related game logic).
---

# Cards

_Lean card reference. In v0 these were called "curses." In v1 they are renamed to
"cards" and expanded to include effects that benefit the playing team. For the full,
authoritative v0 card text (casting costs, special interactions, resolution rules), see
`v0/Beltline Bar Brawl.txt`. The v1 card set below is finalized; per-card casting costs,
timers, and app-validation details will be detailed during the web-app phase._

## Terminology

- "Curse" (v0) -> "Card" (v1). The v1 deck includes team-beneficial cards (economy/boosts)
  alongside the opponent-slowing ones.

## v0 Cards (summary — one line each)

Full text lives in `v0/Beltline Bar Brawl.txt`.

- **Stop and Smell the Roses** — take 3 photos by 3 distinct plant beds, each 50+ ft apart. _(removed in v1)_
- **Quit Nursing** — next bar must be an unvisited bonus bar; bonus if it's farther from finish. _(reworked in v1 — see below)_
- **Go Piss Girl** — a member must use a public restroom not inside any bar.
- **Crop Dusting** — (no target) played inside a non-finish bar; blocks others from entering for 15 min.
- **Moneybags** — photograph a retail price tag over $150.
- **Use It or Lose It** — cursed team must immediately play every card in hand.
- **Wired** — order an espresso shot from a non-bar location.
- **Heavyweight** — (self-target) permanently increase hand size by one and draw two; has claim-count cost. _(reworked in v1 — see below)_
- **Blue Shell** — always targets the team closest to the finish; cursed team must physically tag the caster. _(removed in v1 — replaced by Spin Cycle)_
- **Art School Dropout** — cursed team photographs a mural/graffiti/art with 3 distinct ROYGBIV colors.
- **Broad Shoulders** — photo next to an official ATL Tiny Door installation.
- **Uno Reverse** — reaction card; redirects a curse back onto the casting team.
- **Bird Guide** — film a continuous video keeping a single bird in frame (matched duration).
- **Cancel Culture** — (no target) picks a bar; teams within 0.25 mi in 15 min are frozen 15 min. _(reworked in v1 — see below)_
- **Papparazzi, Please** — three consensual selfies with three different non-team people. _(removed in v1)_
- **Interested Buyer** — obtain a souvenir/brochure from an apartment leasing office.
- **Different Tastes** — photograph a restaurant with cuisine from the same continent as the caster's.
- **Everyone's a Critic** — photo at a 4.5+ star Google location, else frozen 10 min; no research first.

## Locked v1 Card Changes

These changes are locked for v1.

### Reworks

- **Uno Reverse -> "Fairest of Them All"** — reworked from discard-and-reflect into a
  reactive card: when a team plays a card against your team, you may immediately use this
  to also make the *playing* team complete the card's requirements (both teams complete it).
- **Quit Nursing** — the next bar visited must be an **unclaimed bar** (previously an
  unvisited *bonus* bar; "bonus bars" no longer exist in v1).
- **Heavyweight** — casting cost is now: the team must have **claimed 5 bars AND have the
  most bars claimed** of any team. (Self-target; permanently increases hand size by one and
  draws two.)
- **Cancel Culture** — publicly pick a bar. Starting **15 minutes after casting**, no bar
  within **0.25 miles** of the chosen bar can be claimed for the **next 15 minutes**.

### Removals

- **Remove "Stop and Smell the Roses"** — too easy.
- **Remove "Papparazzi, Please"** — too easy.
- **Remove "Blue Shell"** — replaced by **Spin Cycle** (see additions).

### Additions — Opponent-slowing

- **Spin Cycle** — the cursed team must immediately return to the **most recently claimed
  bar** (the bar it claimed most recently) before it can claim another bar.
- **Dirty Bird** — the cursed team must take a photo with a **non-team member wearing an
  Atlanta sports team logo** before claiming another bar.
- **Scenic Route** — the cursed team's next claim must be a bar **farther from the finish**
  than their current position.

### Additions — Economy / boosts

Boosts are rare and forward-looking: they affect *future* bars, never retroactively change
bars already scored. Several are public (any team can benefit) but timed so the casting
team holds the positional advantage.

- **Insured** — (self) the points you receive from the **next bar you claim cannot be
  reduced** by later claimers. Other teams still gain and lose points normally based on how
  many teams claim that bar, so the total awarded on that bar **can exceed 12**.
- **Happy Hour** — pick a bar. **Any team** that claims it in the **next hour** gets **+2
  points**.
- **Power Hour** — for the **next 20 minutes**, whenever **any team** claims a bar, that
  team **draws two cards and keeps both**.
- **Party Crasher** — pick a non-finish bar that **fewer than four teams** have claimed.
  Teams that claim this bar score **as if sharing with one extra (phantom) team** — i.e.,
  the split is computed on (actual claiming teams + 1): 1 claimer scores 6, 2 claimers
  score 4 each, 3 claimers score 3 each. If **all four teams** claim it, the phantom share
  disappears and they score the normal 3 each.
- **Patient Investor** — (self) after your team claims **five more bars**, gain **+5
  points**.
- **Window Shopping** — you must have **another card in hand**; **trade your hand** for
  another team's hand.

## Design Notes

- v1 favors cards the app can **validate** (photo uploads, location checks, timers) to fix
  v0's enforceability problems.
- Cards requiring a target let the playing team choose which team to target; the target is
  notified immediately and blocked from claiming a bar until conditions are met.

### Card interactions

- **Insured + Party Crasher** — self-contained. Insured locks whatever share you *receive*
  at claim time; Party Crasher only changes what that share is. If a team is insured, Party
  Crasher cannot later reduce them. If Party Crasher is already in effect on a bar and an
  insured team is the first to claim it, they are insured at 6 (the phantom-team share).

---

_The v1 card set is finalized. Casting costs, exact timers, and app-validation logic for
each card will be specified during the web-app phase._
