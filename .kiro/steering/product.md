# Product

## What is the Beltline Bar Brawl?

The Beltline Bar Brawl (BBB) is a competitive team bar-crawl game played along the
Atlanta Beltline. Teams race down the bar corridor claiming bars to earn points. Along
the way they draw and play cards that give their own team an edge or slow down opposing
teams. The game ends when a team claims the designated finish bar, but claiming the
finish bar does not guarantee victory: the team with the most points when the game ends
is the winner.

This project builds a web application to run the game, replacing the original physical
cards and group-chat coordination.

## Players

- 2 to 4 teams of roughly equal size (3-4 players per team recommended).
- One admin/host who sets up and runs a game.
- Designed for the Atlanta Beltline, but any walkable bar corridor works.

## Project Phases

1. **Steering** - establish project context (this set of steering files). *(complete)*
2. **Rules finalization** - refine and lock the v1 ruleset and card set. *(complete — see
   `game-rules.md` and `cards.md`)*
3. **Web application** - design and build the app (Node.js, hosted on Vercel, backend TBD).
   *(current phase — starting with a spec)*

## Problems v1 Must Solve

The original version (v0) was played with physical cards and a group chat. It was fun but
had three core issues the web app is meant to fix:

- **Latency** - cards played on opposing teams were relayed by text and often arrived up
  to 15 minutes late, creating unfair timing in a game where time is a primary resource.
- **Beeline strategy** - the original "race to the finish" scoring let one team rush the
  final bar and ignore everything else. v1 changes scoring so claiming more bars matters.
- **Enforceability** - some cards (curses) were hard to track or verify. v1 aims for
  cards the app can validate.

---

_This file is preliminary and intentionally barebones. It will be updated as the product
direction and requirements evolve through later phases._
