# Cards

_Finalized v1 card catalog. This is the authoritative flat list of every card in the
Brawl Deck, taken from the finalized ruleset in `v1/Beltline Bar Brawl_redux.txt`. Each
team's deck contains one of each card below._
# Cards

_Authoritative finalized v1 card catalog. The source of truth for card text and intended
app behavior is `v1/Card List.md`; this steering file mirrors that list for implementation
planning. Each team's deck contains one of each card below (identical decks)._

## How cards work (quick reference)

- Teams hold **up to two** cards. Before drawing a third, they must play or discard one.
- A challenge normally targets one opposing team and must be resolved before that team can
  claim another bar. Some cards target a bar, some target the casting team, and some have
  no target.
- No team may be targeted by a challenge card of the same name more than once.
- In the MVP, most challenges are honor-system actions surfaced by near-real-time toast
  notifications. The backend still records plays, targets, deadlines, claim blocks, and
  confirmations so the UI can enforce the parts explicitly listed below.
- Every card's App Mechanics below is part of the intended behavior, not merely display
  copy. Backend work must preserve the distinction between team targets, bar targets,
  self-targeting effects, persistent effects, and informational audience messages.

## Cards

### Go Piss Girl

At least one member of the target team must enter a publicly accessible restroom that is
not located inside any bar.

**App Mechanics:** Targets a team; toast plus confirmation by the target team; informational
toast to non-target and casting teams.

### Crop Dusting

**Special Rule:** Does not target a team. Must be played physically inside a bar that is not
the finish bar. Once played in a bar, no other team may enter that bar for 15 minutes.

**App Mechanics:** Targets a bar; alerts all non-casting teams; prevents the target bar from
being claimed for 15 minutes.

### Moneybags

The target team must find a product with a visible price tag over $150 inside a retail store.
A photograph of the price tag is required.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Use It or Lose It

The target team must immediately play every card currently in its hand. Cards whose playing
requirements cannot be met immediately are discarded with no effect.

**App Mechanics:** Targets a team and prompts it to play all cards before claiming a bar;
informational toast to non-target and casting teams.

### Wired

The target team must order a shot of espresso from a location that is not a bar.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Art School Dropout

The casting team must take a photo of a mural, graffiti, or art installation containing
three distinct ROYGBIV colors. The target team must then photograph a different one containing
the same three colors.

**App Mechanics:** The caster inputs three colors, then targets a team; toast plus target-team
confirmation; informational toast to non-target and casting teams.

### Broad Shoulders

The target team must take a photo with at least one team member next to an official ATL Tiny
Door installation.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Bird Guide

The casting team must film a continuous video, up to five minutes, keeping one bird visible.
The target team must film another bird for at least as long.

**App Mechanics:** The caster inputs a duration of 0-300 seconds, then targets a team; toast
plus target-team confirmation; informational toast to non-target and casting teams.

### Interested Buyer

The target team must obtain a souvenir or brochure from an apartment leasing office. If most
leasing offices are closed, a photo in front of one is acceptable.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Different Tastes

The casting team must take a picture next to a restaurant. The target team must photograph a
restaurant whose cuisine is from the same continent.

**App Mechanics:** The caster inputs a cuisine type, then targets a team; toast plus target-
team confirmation; informational toast to non-target and casting teams.

### Everyone's a Critic

The target team must take a picture on the premises of a location with at least 4.5 Google
stars. If it fails, it may not claim a bar for 15 minutes and may not use the internet for
research until making an attempt.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Fairest of Them All

May only be played immediately after the team is targeted by a challenge card. It forces the
casting team to complete that challenge's requirements too.

**App Mechanics:** When targeted, a team with this card is prompted to play it in the same
toast. If played, the casting team is alerted that the challenge was mirrored and receives
the original challenge toast. Informational toast goes to other teams.

### Pioneer

The target team's next claimed bar must be unclaimed and not the finish bar.

**App Mechanics:** Targets a team; blocks that team's finish-bar claims and claims of bars
already claimed by another team for its next claim only; informational toast to non-target
and casting teams.

### Cancel Culture

**Special Rule:** Targets a bar that is not within 0.25 miles of the finish bar, and the bar
must be publicly announced on play. Beginning 15 minutes after announcement, no bar within
0.25 miles of the target bar may be claimed for the next 15 minutes.

**App Mechanics:** Targets a bar; announces the upcoming restriction to all teams, then
announces when it starts; uses bar coordinates to block affected bars during the window.

### Spin Cycle

The target team must immediately return to the entrance of the most recently claimed bar.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Dirty Bird

The target team must take a photo with a non-team member wearing Atlanta sports merchandise.

**App Mechanics:** Targets a team; toast plus target-team confirmation; informational toast
to non-target and casting teams.

### Scenic Route

The target team's next claimed bar must be farther from the finish bar than its previous bar.

**App Mechanics:** Targets a team; uses coordinates to block claims closer to the finish than
the team's previous bar for its next claim only; informational toast to non-target and
casting teams.

### Insurance

**Special Rule:** Targets the casting team only. The points that team receives from its next
claimed bar cannot be reduced by later claimants; other teams share normally.

**App Mechanics:** Protects the caster's next-bar points only; toast to all non-casting teams.

### Happy Hour

**Special Rule:** Targets a non-finish bar. Any team drinking there in the next hour gets +5
points for its first drink, even if it already claimed the bar.

**App Mechanics:** Targets a bar; adds five immutable points alongside normal sharing and
allows teams that already claimed the bar to claim it again for the bonus only.

### Party Crasher

**Special Rule:** Targets a non-finish bar with fewer than four claiming teams. Claimants
score as if one phantom team were sharing. Once four teams claim it, the phantom disappears
and all teams score the normal three points.

**App Mechanics:** Targets an eligible bar, reduces its shares persistently as if an extra
team were present, and sends a toast to all teams.

### Patient Investor

**Special Rule:** Targets the casting team only. After that team claims four more bars, it
gains +6 points.

**App Mechanics:** Toast to all non-casting teams; tracks four subsequent claims and adds six
immutable points when the threshold is reached.

### Power Hour

**Special Rule:** No target; persistent effect. For the next 20 minutes, every team claiming
a bar draws two cards and keeps both.

**App Mechanics:** Toast to all teams; modifies draw resolution for 20 minutes so neither
card is discarded.

### Voted Off the Island

The card requires all four teams to have claimed a non-starting bar. The target team
un-claims a bar all four teams have claimed and may later re-claim it.

**App Mechanics:** Targets both a team and a qualifying bar; removes that team's claim,
notifies the target, permits re-claiming, and sends informational toast to other teams.

## Backend implementation priorities

The cards divide into four infrastructure families:

1. **Notification and confirmation:** Go Piss Girl, Wired, Broad Shoulders, Interested Buyer,
   Spin Cycle, Dirty Bird, and the informational portions of most other challenges.
2. **Evidence and parameter capture:** Moneybags, Art School Dropout, Bird Guide, Different
   Tastes, Everyone's a Critic, and any future photo/video validation.
3. **Claim eligibility and timers:** Crop Dusting, Use It or Lose It, Pioneer, Cancel Culture,
   Scenic Route, Happy Hour, and Voted Off the Island.
4. **Scoring and deck mutations:** Insurance, Happy Hour, Party Crasher, Patient Investor,
   Power Hour, Use It or Lose It, Fairest of Them All, and Voted Off the Island.

_The card set and intended App Mechanics above are finalized. Validation strength may begin
with confirmation and honor-system workflows, but the event, timer, eligibility, scoring,
and card-inventory state must be modeled so stronger validation can be added without a schema
rewrite._
