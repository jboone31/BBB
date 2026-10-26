# Brawl Deck: Card Text Oracle

_The source of truth for the **player-facing** text of every Brawl Deck card: what the card
says in a team's hand, and what each audience sees in toasts when it's played._

## Scope

- Mechanics are defined in `.kiro/steering/cards.md`, `.kiro/steering/game-rules.md`, and
  `v1/Card List.md`. This document decides **wording only**. If wording and mechanics ever
  disagree, the mechanics win and this copy gets corrected.
- Status: **first-pass proposition.** Nothing is locked until signed off card by card.

## Text surfaces

Every card has up to four pieces of copy.

1. **Card text** is what the holding team sees when inspecting the card in its hand. It's
   written from the caster's point of view ("the target team must...") and has three parts,
   read top to bottom:
   - **Requires** (only if the card has one): what your team must do, or what must be true,
     before you can play it. Shown first.
   - **Effect**: what the card does, stated plainly.
   - **Target**: a small note at the bottom saying who or what the card hits, including any
     targeting limits. The target picker enforces those limits, so they aren't listed as
     requirements.
2. **Target toast** is what the targeted team sees: a standard headline plus a body written
   in second person ("your team must...").
3. **Others' toast** is a dismissable popup for everyone else: a standard headline, with the
   card's Effect text in an expandable dropdown.
4. **Caster toast** is a brief confirmation for the casting team.

Standard rules are not repeated in card copy. In particular, the app blocks a challenged team
from claiming bars until it confirms completion, so no card says "you can't claim a bar until
you do."

### Standard toast templates

`{Caster}` and `{Target}` are team names, `{CARD}` is the card name in caps, `{Bar}` is a bar
name. Per-card entries below only list toasts that differ from these.

| Card targets | Target toast headline | Others' toast headline | Caster toast |
| --- | --- | --- | --- |
| A team | {Caster} has played {CARD} on you! | {Caster} played {CARD} on {Target}! | You played {CARD} on {Target}. |
| A bar | (no target team) | {Caster} played {CARD} on {Bar}! | You played {CARD} on {Bar}. |
| Your own team / no target | (no target team) | {Caster} played {CARD}! | You played {CARD}. |

- Team-challenge target toasts show a **Mark complete** action when the card needs
  confirmation. Claim restrictions (Pioneer, Scenic Route) are plain notices, since the app
  enforces them at claim time.
- Values the caster entered (colors, duration, cuisine) are filled into both the target toast
  and the others' dropdown. Durations render as `m:ss` (e.g. `1:30`).
- Timed effects (Crop Dusting, Cancel Culture, Happy Hour, Power Hour) and Patient Investor's
  payout send a dismissable **end toast** to all teams. Each is listed on its card below.

---

## Go Piss Girl

- **Effect:** A member of the target team must enter a publicly accessible restroom that is
  not inside a bar.
- **Target:** An opposing team.
- **Target toast:** At least one member of your team must enter a publicly accessible restroom
  that is not inside a bar.

## Moneybags

- **Effect:** The target team must find a product with a visible price tag over $150 inside a
  retail store and photograph the price tag.
- **Target:** An opposing team.
- **Target toast:** Your team must find a product with a visible price tag over $150 inside a
  retail store and photograph the price tag.

## Wired

- **Effect:** The target team must order a shot of espresso from a place that is not a bar.
- **Target:** An opposing team.
- **Target toast:** Your team must order a shot of espresso from a place that is not a bar.

## Broad Shoulders

- **Effect:** The target team must take a photo with at least one team member next to an
  official ATL Tiny Door.
- **Target:** An opposing team.
- **Target toast:** Your team must take a photo with at least one team member next to an
  official ATL Tiny Door.

## Interested Buyer

- **Effect:** The target team must get a souvenir or brochure from an apartment leasing office.
  If most leasing offices are closed today, a photo in front of one counts instead.
- **Target:** An opposing team.
- **Target toast:** Your team must get a souvenir or brochure from an apartment leasing office.
  If most leasing offices are closed today, a photo in front of one counts instead.

## Dirty Bird

- **Effect:** The target team must take a photo with someone outside their team who is wearing
  Atlanta sports merchandise.
- **Target:** An opposing team.
- **Target toast:** Your team must take a photo with someone outside your team who is wearing
  Atlanta sports merchandise.

## Spin Cycle

- **Effect:** The target team must immediately return to the entrance of the bar they most
  recently claimed.
- **Target:** An opposing team.
- **Target toast:** Your team must immediately return to the entrance of the bar you most
  recently claimed.

## Everyone's a Critic

- **Effect:** The target team must take a picture on the premises of a place with at least 4.5
  stars on Google. They can't use the internet for research until they make an attempt. If
  they fail, they can't claim a bar for 15 minutes.
- **Target:** An opposing team.
- **Target toast:** Your team must take a picture on the premises of a place with at least 4.5
  stars on Google. You can't use the internet for research until you make an attempt. If you
  fail, you can't claim a bar for 15 minutes.
- **Target toast actions:** Mark complete / We failed (starts the 15-minute block).

## Art School Dropout

- **Requires:** Take a photo of a mural, graffiti, or art installation containing three
  distinct ROYGBIV colors, then enter those three colors.
- **Effect:** The target team must photograph a different mural, graffiti, or art installation
  containing the same three colors.
- **Target:** An opposing team.
- **Target toast:** Your team must photograph a mural, graffiti, or art installation containing
  {color1}, {color2}, and {color3}. It must be a different piece than {Caster}'s.

## Bird Guide

- **Requires:** Film a continuous video of a single bird staying in frame (up to 5 minutes),
  then enter how long it lasted.
- **Effect:** The target team must film a continuous video of a different bird staying in frame
  for at least as long.
- **Target:** An opposing team.
- **Target toast:** Your team must film a continuous video of a bird staying in frame for at
  least {duration}. It must be a different bird than {Caster}'s.

## Different Tastes

- **Requires:** Take a picture next to a restaurant, then enter its cuisine.
- **Effect:** The target team must take a picture next to a restaurant whose cuisine is from the
  same continent.
- **Target:** An opposing team.
- **Target toast:** {Caster} found a {cuisine} restaurant. Your team must take a picture next to
  a restaurant whose cuisine is from the same continent.

## Use It or Lose It

- **Effect:** The target team must immediately play every card in their hand. Any card whose
  requirements they can't meet right now is discarded with no effect.
- **Target:** An opposing team.
- **Target toast:** Your team must immediately play every card in your hand. Any card whose
  requirements you can't meet right now is discarded with no effect.

## Pioneer

- **Effect:** The target team's next claimed bar must be one no other team has claimed, and it
  can't be the finish bar.
- **Target:** An opposing team.
- **Target toast:** Your next claimed bar must be one no other team has claimed, and it can't
  be the finish bar.

## Scenic Route

- **Effect:** The target team's next claimed bar must be farther from the finish bar than the
  last bar they claimed.
- **Target:** An opposing team.
- **Target toast:** Your next claimed bar must be farther from the finish bar than the last bar
  you claimed.

## Crop Dusting

- **Requires:** Your team must be inside the bar you target.
- **Effect:** No other team may enter or claim this bar for 15 minutes.
- **Target:** The bar you're in. Can't be the finish bar.
- **Others' toast body:** No team may enter or claim {Bar} until {endTime}.
- **End toast (all teams):** CROP DUSTING has ended. {Bar} can be claimed again.

## Cancel Culture

- **Effect:** Starting 15 minutes from now, no bar within 0.25 miles of the target bar can be
  claimed for 15 minutes.
- **Target:** A bar not within 0.25 miles of the finish bar. All teams are told which bar.
- **Announcement toast (all teams):** {Caster} played CANCEL CULTURE on {Bar}! Starting at
  {startTime}, no bar within 0.25 miles of {Bar} can be claimed for 15 minutes.
- **Start toast (all teams):** CANCEL CULTURE is now in effect. No bar within 0.25 miles of
  {Bar} can be claimed until {endTime}.
- **End toast (all teams):** CANCEL CULTURE has ended. Bars near {Bar} can be claimed again.

## Happy Hour

- **Effect:** For the next hour, each team's first drink at the target bar earns +5 points,
  even if that team already claimed it.
- **Target:** Any bar except the finish bar.
- **Toast (all teams):** {Caster} played HAPPY HOUR on {Bar}! Until {endTime}, your team's
  first drink there earns +5 points, even if you've already claimed it.
- **End toast (all teams):** HAPPY HOUR at {Bar} has ended.

## Party Crasher

- **Effect:** Teams claiming the target bar score as if one extra team were sharing it. Once
  four teams have claimed it, the extra share disappears and each team scores 3.
- **Target:** A bar other than the finish bar that fewer than four teams have claimed.
- **Toast (all teams):** {Caster} played PARTY CRASHER on {Bar}! Teams claiming it score as if
  one extra team were sharing it.

## Insurance

- **Effect:** The points your team earns from its next claimed bar can't be reduced by teams
  that claim it later. Other teams share normally.
- **Target:** Your own team.

## Patient Investor

- **Effect:** After your team claims four more bars, it gains 6 points.
- **Target:** Your own team.
- **Payout toast (all teams):** {Caster} cashed in PATIENT INVESTOR for +6 points!

## Power Hour

- **Effect:** For the next 20 minutes, every team that claims a bar draws two cards and keeps
  both.
- **Target:** All teams.
- **Toast (all teams):** {Caster} played POWER HOUR! Until {endTime}, every team that claims a
  bar draws two cards and keeps both.
- **End toast (all teams):** POWER HOUR has ended. Draws are back to normal.

## Fairest of Them All

- **Requires:** Play this immediately after your team is targeted by a challenge card.
- **Effect:** The team that challenged you must also complete that challenge.
- **Target:** The team that just challenged you.
- **Prompt (inside the holder's target toast):** Play FAIREST OF THEM ALL to make {Caster}
  complete this challenge too?
- **Mirrored toast (original caster):** {Target} played FAIREST OF THEM ALL! Your team must
  also complete {CARD}. Body: the original card's target toast, with the same entered values.
- **Others' toast headline:** {Target} turned {CARD} back on {Caster} with FAIREST OF THEM ALL!

## Voted Off the Island

- **Requires:** Every team has claimed at least one bar other than the start bar.
- **Effect:** The target team loses its claim on a bar that every team has claimed. They may
  re-claim it later.
- **Target:** An opposing team, plus a bar every team has claimed.
- **Target toast body:** Your team's claim on {Bar} has been removed. You may re-claim it later.
- **Others' toast headline:** {Caster} played VOTED OFF THE ISLAND on {Target} at {Bar}!

---

## Decisions

- **Voted Off the Island** is a notice, not a challenge. The target has nothing to complete and
  is not gated from claiming. `lib/cards/catalog.ts` now marks it `resolution: "none"`,
  `completionRequired: false`.
- **Caster toast** is kept for every card.
- **End toasts:** timed effects and Patient Investor's payout send an informational toast to
  all teams.
- **Durations** render as `m:ss`.

## Deferred to the spec

- `CardText` in `lib/cards/catalog.ts` currently has `description`, `castingRequirement`, and
  `targetRequirement`. To carry this copy it needs roughly `requires`, `effect`, `targetNote`,
  `targetToastBody`, and per-card toast overrides (announcement, end, payout, mirror). This
  reshape and moving the text into code happen as part of the Brawl Deck spec.
