# Structure

_No application code exists yet. This file describes the current layout and sketches an
intended structure. The future structure is tentative and will be replaced with the real
layout once the app is scaffolded._

## Current Layout

```
BBB/
  .kiro/
    steering/            # project steering files (this directory)
      product.md
      tech.md
      structure.md
      game-rules.md
      cards.md
  v0/                    # original game design + assets
    Beltline Bar Brawl.txt   # readable full v0 ruleset (source of truth for history)
    Beltline Bar Brawl.docx
    Beltline Bar Brawl.pdf
    BBB_Curses.docx
    BBB_Curse_Deck.pdf
    BBB_logo.PNG
  README.md
  .gitignore
```

## Intended Structure (tentative)

To be defined when the web app is scaffolded. A likely high-level shape given the
intended stack (Node.js, Vercel, Supabase candidate):

```
BBB/
  app/ (or src/)         # application code (framework TBD)
  components/            # UI components
  lib/                   # shared logic (game rules, scoring, card engine)
  supabase/ (or db/)     # schema, migrations, backend config
  public/                # static assets (logo, etc.)
  v0/                    # preserved historical design docs
  .kiro/                 # steering, specs, hooks
```

---

_Barebones by design. Update this file as real directories and conventions are
established during the web-app phase._
