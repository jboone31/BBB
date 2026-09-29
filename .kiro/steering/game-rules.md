# Game Rules

_The **finalized** v1 ruleset the web app implements, taken from
`v1/Beltline Bar Brawl_redux.txt`. Card definitions live in `cards.md`, not here._

## Overview

- **2-4 teams** of any size race along the Beltline from a **start bar** to a **finish
  bar**, on foot. No cars, bikes, scooters, etc.
- Estimated duration: **2-4 hours**.
- Teams claim bars to earn points and draw cards. Claiming the finish bar ends the game
  immediately; the team with the **most points** when the game ends wins.

## Starting the Race

- All teams begin together at the **start bar**.
- The game officially begins once every team has their drinks. No one drinks until the
  game begins.

## Claiming Bars

- To claim a bar: **all team members must be present**, and **at least half of the team**
  must order and finish a drink.
- **"At least half" rounds up in the team's favor** — 2 of 3 qualifies, 1 of 3 does not.
- **Claiming is binary and explicit.** Meeting the half-drink threshold makes a team
  *eligible*; the bar is not claimed until the team taps **"claim"** in the app.
- **No re-claiming.** A team cannot claim the same bar twice.
- **Only two designated bars:** a **start bar** and a **finish bar**. There are no
  checkpoint or bonus bars — every other bar is a claimable scoring bar.

## Scoring

- The **start bar** is worth **0 points** (but still triggers a card draw).
- Every **other non-finish bar** is worth **12 points total**, split **equally among all
  teams currently claiming it**. As more teams claim the same bar, each claimer's share
  drops so the total across claimers stays 12:
  - 1 claiming team: 12 each
  - 2 claiming teams: 6 each
  - 3 claiming teams: 4 each
  - 4 claiming teams: 3 each
- Some cards may add or subtract points, or change how a bar's points are split (see
  `cards.md`). With card effects in play, the total awarded on a bar can differ from 12.
- **Claim order does not matter** except for the transient point split while the game is
  live — each bar's points are always split equally among its current claimers.
- The **finish bar** awards the **full 12 to the claiming team alone** (not split) and
  **immediately ends the game**. No other team can then claim it. A bar not yet claimed at
  the moment the finish bar is claimed counts as unclaimed for that team.

## Winning

Claiming the finish bar ends the game but does **not** guarantee a win. The team with the
**most points** when the game ends wins.

## The Brawl Deck

- Each time a team claims a bar **(excluding the finish bar)**, it draws the **top two
  cards**, keeps one, and removes the other from play.
- Cards are drawn **once per team, per unique bar** — a bar cannot be revisited for another
  draw.
- Once a card is played or discarded, it is removed from that team's deck for the rest of
  the game.
- If a team exhausts its deck it may still claim bars but draws no cards. If only **one
  card** remains when the team claims a bar, it may add that card to its hand.
- Some cards override these rules; when a card's text conflicts with this document, **the
  card wins**.

## Playing Cards

- Teams may hold **up to two** cards at a time. Before drawing a third, they must
  immediately play or discard one currently in hand.
- Cards may generally be played at any time, unless the card specifies playing conditions.
- A challenge card generally targets **one** other team, chosen by the casting team at play
  time, unless the card says otherwise.
- The casting team must **immediately inform the group** of the card played and the team
  targeted.
- With multiple teams in play, no team may be targeted by a challenge card of the **same
  name** more than once.

## Casting Requirements

- Some cards can only be played if certain conditions are met; otherwise they are discarded
  with no effect.
- All casting requirements must be completed **before announcing** the card.
- The casting team must **all be together** when playing a card.

## Resolving Cards

- An affected team must complete a challenge card's requirements **before claiming another
  bar**.
- If a challenge card is played on your team while you are **actively in line to order** a
  drink, you may finish claiming that bar before resolving the card. If you have **not** yet
  placed the order, you must resolve the card first.
- If multiple challenge cards are played on your team, you may resolve them in **any order**.
- You may **not** use something obtained **before being targeted** (e.g., a photo taken
  earlier) to satisfy a challenge requirement.

---

_v1 rules are finalized. The web-app phase translates these into implementation detail
(state model, timers, validation)._
