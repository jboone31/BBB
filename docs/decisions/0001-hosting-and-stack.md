# ADR 0001 — Hosting and Stack Decision (Hosting_Decision_Record)

- **Status:** Accepted (locked)
- **Date:** 2024
- **Spec:** `.kiro/specs/web-app-foundation` (feature F0.1)
- **Requirements:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
- **Source of truth:** `.kiro/specs/web-app-foundation/design.md` — "F0.1 — Hosting Decision Record" (embedded in the Architecture section). This ADR mirrors that content.

## Context

The BBB web app must replace the v0 physical-card + group-chat game. The make-or-break
capability is **real-time propagation**: a persisted game-state change must reach every
subscribed client within a 3-second `Latency_Budget` (the v0 pain point was card plays
arriving up to 15 minutes late over text).

This record compares the **Vercel + Supabase** option against an **AWS alternative**
(Req 1.1), records a per-capability pass/fail verdict (Req 1.2), calls out the real-time
verdict specifically (Req 1.3), gives a rough monthly cost per option (Req 1.4), and records
the locked choice (Req 1.5), the deviation note (Req 1.6), the folded-in Identity_Model
(Req 1.7) and Photo_Lifecycle_Policy (Req 1.8) decisions, and the deferred items
(Req 1.9, 1.10).

## Per-capability verdict (Req 1.1, 1.2)

Verdicts are sized for **one concurrent game: up to 4 teams × 4 players + 1 admin = 17
clients**.

| Capability                      | Vercel + Supabase | AWS alternative | Notes                                                                                                                                                                                                         |
| ------------------------------- | ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-time propagation within 3s | **PASS**          | **PASS**        | Supabase Realtime pushes Postgres changes in well under 3s at this scale. AWS can match it with AppSync subscriptions or API Gateway WebSockets + DynamoDB Streams, but requires assembling several services. |
| Managed Postgres                | **PASS**          | **PASS**        | Supabase = managed Postgres directly. AWS = RDS/Aurora Postgres.                                                                                                                                              |
| Authentication                  | **PASS**          | **PASS**        | Supabase Auth built in. AWS = Cognito.                                                                                                                                                                        |
| File / photo storage            | **PASS**          | **PASS**        | Supabase Storage with lifecycle. AWS = S3 with lifecycle rules.                                                                                                                                               |
| Mobile-first web delivery       | **PASS**          | **PASS**        | Vercel edge CDN serves the Next.js app globally. AWS = CloudFront + Amplify/Lambda.                                                                                                                           |

Both options **pass** every capability. The decision therefore turns on integration effort,
operational surface, and cost at our small scale — not raw capability.

## Real-time capability detail (Req 1.3)

The deciding capability is real-time delivery of a persisted `Game_State_Change` within the
3-second `Latency_Budget`.

- **Vercel + Supabase:** the path is `Postgres commit → WAL → Realtime → client`, a single
  managed pipeline with sub-second push at 17 clients — comfortably inside the 3s budget.
- **AWS alternative:** the equivalent path (`DynamoDB Streams → Lambda → AppSync/API Gateway
WS → client`, or Aurora + a change pipeline) is also inside budget but is several services
  the team must wire and operate.

**Verdict:** both PASS; Supabase reaches PASS with far less assembly.

## Rough monthly cost estimate (Req 1.4)

USD, sized for a single concurrent game (17 clients).

| Option                | Monthly estimate (USD) | Basis                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel + Supabase** | **~$0–25/mo**          | Both have free tiers that cover one small intermittent game (17 clients, low storage, short-lived photos). Realistic paid floor if upgrading past free limits: Supabase Pro ~$25/mo; Vercel Hobby $0 for non-commercial. Estimate: **$0 on free tiers, ~$25/mo if Supabase Pro is needed.**                                                                         |
| **AWS alternative**   | **~$30–70/mo**         | RDS/Aurora Postgres (smallest instance ~$15–30/mo even mostly idle), AppSync or API Gateway WebSockets (usage-based, low at this scale), S3 + CloudFront (a few dollars), Cognito (free at this volume). Dominated by the always-on database instance. Estimate: **~$30–70/mo**, higher floor because managed Postgres is not free-tier-friendly for sustained use. |

These are rough figures for planning, not quotes. Both scale cheaply at single-game volume;
the gap is driven mainly by AWS's always-on database floor versus Supabase's free tier.

## Decision — locked choice and rationale (Req 1.5)

**Locked choice: Vercel (hosting) + Supabase (Backend_Platform), with Next.js (App Router)
on Node.js as the framework.**

Rationale: at single-game scale both options are capable, so we optimize for **least
integration effort and lowest operational surface**. Supabase bundles the four backend
capabilities (Postgres, auth, realtime, storage) behind one service and one client library,
and its realtime feature directly solves the primary v0 problem with no assembly. Vercel is
the native host for Next.js with zero-config preview deployments that make the
`Deployable_Baseline` and mobile testing trivial. The AWS path delivers the same
capabilities but multiplies the number of services to wire, secure, and pay for, with a
higher fixed monthly floor and no offsetting benefit at this scale.

## Deviation from technical direction (Req 1.6)

**None.** `tech.md` named Supabase as the leading candidate; this decision confirms it. No
deviation reason is required. If future scale (many concurrent games, heavier media) changes
the tradeoff, the AWS plan is the fallback (see Deferred decisions).

## Identity_Model decision (Req 1.7)

**Decision: lightweight per-game session identity.**

- A game is created by an **admin** who receives a host credential (a session bound to that
  game). Players **join via a code/link** and pick a display name and team; each player gets
  a per-game session token, not a global account.
- **Rationale:** BBB is a one-evening, in-person bar crawl. Requiring signup/email
  verification adds friction at the exact moment a group is trying to start playing on the
  sidewalk. Per-game sessions are enough to attribute claims, card plays, and events to the
  right team, which is all the game logic needs.
- **Consequence for the schema (Req 3.15):** because identity is **not** account-based,
  players and admin are modeled as per-game rows (`players`, and an admin identity on
  `games`), **not** as persistent cross-game identity records. Supabase Auth is still used to
  issue and validate the per-game session tokens that RLS keys off of.

## Photo_Lifecycle_Policy decision (Req 1.8)

**Decision:**

- **Storage location:** Supabase Storage, in a dedicated bucket per environment
  (`photo-feed`), objects namespaced by `game_id`.
- **Retention duration:** **24 hours** from upload, after which objects are deleted by a
  scheduled lifecycle job. Photos are validation/feed artifacts, not durable content, so
  short retention minimizes privacy exposure.
- **Takedown:** a photo can be removed before expiry by the uploading team (self) or the
  admin (moderation). Deletion removes the storage object and marks the referencing feed
  event as redacted (the `game_event` itself stays, but its photo reference is nulled).

Photo _handling logic_ (upload, feed, challenge) is deferred to F3.3; this decision only
fixes the policy and ensures the schema/storage can hold it.

## Deferred decisions (Req 1.9, 1.10)

| Deferred item                                                            | Resolved by                          | Reason for deferral                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Full AWS-alternative build plan / detailed cost model                    | **(fallback only)**                  | AWS is the alternative, not the chosen path; a detailed build plan is only produced if we migrate. The rough comparison above satisfies F0.1. |
| Bar selection mechanism (map API vs. predetermined list + propose-a-bar) | **F2.1 — Bar selection & discovery** | Depends on how heavy map API integration proves to be; not needed to lock the foundation.                                                     |
| Map / claim visualization (map API vs. in-house coordinates vs. list)    | **F2.3 — Claim visualization**       | UI-layer decision that builds on claiming; out of scope for the foundation.                                                                   |

## Consequences

- The foundation targets **Next.js (App Router) / Node.js on Vercel** with **Supabase**
  (Postgres + Realtime + Auth + Storage) as the single backend platform.
- Real-time propagation rides **Supabase Postgres Changes on `game_events`** (the append-only
  ordered event log), which is the single ordered source for per-game delivery.
- Identity is session-based per game, so no persistent cross-game identity records are
  created (Req 3.15 is vacuously satisfied).
- The AWS alternative remains a documented fallback if scale changes the tradeoff.
