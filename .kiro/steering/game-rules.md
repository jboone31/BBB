# Game Rules

_Lean rules reference. The v0 section summarizes the original game; the v1 section is the
**finalized** ruleset that the web app implements. For the full historical ruleset, see
`v0/Beltline Bar Brawl.txt`. Card definitions live in `cards.md`, not here._

## v0 Baseline (summary)

- 2-4 teams race along the Beltline from a **start bar** to a **finish bar**, on foot.
- **Claiming a bar:** the team is present and at least one member orders and finishes a
  drink. In v0 there were also intermediate **checkpoint bars** and optional **bonus bars**.
- **Drawing cards:** each time a team claims a new (unvisited) bar, it draws the top two
  cards, keeps one, and removes the other from play.
- **Curses:** cards used to impose obstacles/detours on opposing teams (slow them down).
  A cursed team must complete the curse before claiming another bar.
- **Winning:** the first team to claim the finish bar wins.

See `v0/Beltline Bar Brawl.txt` for full detail (claiming, dispatching, curse resolution,
special interactions, etc.).

## v1 Rules (finalized)

The v1 ruleset the web app implements.

- **"Curses" become "cards."** Terminology changes to reflect that some cards benefit the
  playing team, not just penalize opponents.
- **Claiming a bar** now requires **at least half of the team** to order and finish a drink
  (v0 required only one member).
- **No checkpoint bars.** Only a **start bar** and a **finish bar** are designated. Every
  other bar is a claimable scoring bar.
- **Scoring:**
  - The **start bar** is worth **0 points** (but still triggers a card draw).
  - Every **other non-finish bar** is worth **12 points total**, split **equally among all
    teams currently claiming it**. As more teams claim the same bar, each claimer's share
    drops so the total across claimers stays 12:
    - 1 claiming team: 12 each
    - 2 claiming teams: 6 each
    - 3 claiming teams: 4 each
    - 4 claiming teams: 3 each
  - The **finish bar** awards the **full 12 to the claiming team alone** (not split) and
    **immediately ends the game**. No other team can then claim it.
- **Winning:** claiming the finish bar ends the game but does not guarantee a win. The team
  with the **most points** when the game ends wins.
- **Card draw on claim:** unchanged in spirit — claiming a bar (including the start bar)
  lets a team draw two cards and add one to its hand, discarding the other.

## Resolved v1 Edge Cases

- **Claiming is binary and explicit.** A team becomes eligible to claim a bar once **at
  least half** its members have finished a drink there, but the bar is not claimed until the
  team taps **"claim"** in the app. If a bar has not been claimed at the moment a team
  claims the finish bar (ending the game), it counts as unclaimed for that team.
- **No re-claiming.** A team cannot claim the same bar twice.
- **Claim order does not matter.** Order of claiming affects nothing except the transient
  point split while the game is live (each bar's 12 points are always split equally among
  its current claimers).
- **"At least half" rounds up in the team's favor.** A team may claim once *at least half*
  its members have finished a drink: 2 of 3 qualifies, 1 of 3 does not.

---

_v1 rules are finalized. The web-app phase will translate these into implementation detail
(state model, timers, validation)._
