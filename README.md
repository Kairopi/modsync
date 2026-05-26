# ModSync

> Real-time collision-free modqueue coordination for Reddit moderators.

ModSync is a Devvit Web app that prevents the most common pain point in shared moderation: two mods acting on the same queue item at the same time. It surfaces live presence, soft-warns on collisions, runs one-click action combos, and tracks a per-week metrics bucket — all without external services.

---

## Table of Contents

- [The Problem (cite the research)](#the-problem-cite-the-research)
- [What ModSync Does](#what-modsync-does)
- [How It's Different from MQCC / OmniMod](#how-its-different-from-mqcc--omnimod)
- [Architecture](#architecture)
- [Quick Stats](#quick-stats)
- [Installation](#installation)
- [Demo Flow (two-browser collision walkthrough)](#demo-flow-two-browser-collision-walkthrough)
- [Project Layout](#project-layout)
- [API Surface](#api-surface)
- [Settings](#settings)
- [Testing Strategy](#testing-strategy)
- [Compliance](#compliance)
- [Development Commands](#development-commands)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## The Problem (cite the research)

The Sept 2025 arXiv study **"In the Queue: Understanding How Reddit Moderators Use the Modqueue"** (n=110 moderators across 408 subreddits) reports that **74.5% of moderators have experienced collisions** — multiple mods acting on the same queue item simultaneously. The result is duplicate bans, conflicting decisions, contradictory mod notes, and wasted reviewer effort.

Existing mod tools focus on *what* to review (priority queues, signal aggregation). ModSync focuses on *who is reviewing what right now*, which is the gap the arXiv paper identifies as missing from the moderator workflow.

The paper also notes that moderators describe coordination as ad-hoc — usually a Discord channel, sometimes a pinned mod-only post, occasionally just hoping. None of those scale past ~5 active mods, and none provide programmatic guarantees that two reviewers won't act on the same item. ModSync fills that gap with a 90-second soft claim that's broadcast to every connected mod via Devvit's Realtime channels.

---

## What ModSync Does

Four P0 capabilities. Each is small enough to grasp in one read; together they replace the "shout in Discord" workflow with structured coordination.

### 1. Live presence + soft claims on modqueue items (90s TTL)

Click **"Claim for review"** on any post or comment from the moderator menu and a 90-second claim is broadcast to every connected mod through the `claims-{sub}` Realtime channel. The claim auto-expires so a forgotten claim never blocks the queue.

If another moderator already holds a claim on the item, you see a **soft-warning Devvit Form** showing who holds it, how long is left, and a `Proceed?` toggle. Override consciously, or cancel cleanly. Both outcomes feed the metrics dashboard.

### 2. One-click action combos (REMOVE / LOCK / BAN / MODNOTE / APPROVE)

Pre-build sequences and run them in one menu click. Two defaults ship out of the box:

| Combo | Steps |
| --- | --- |
| `spam-removal` | REMOVE → BAN 7d "Spam" → MODNOTE `SPAM_WARNING` |
| `rule-violation` | REMOVE → LOCK → MODNOTE `OTHER` |

Add up to 50 per sub via the **Combos** tab. Each combo step is one of: `REMOVE`, `LOCK`, `APPROVE`, `BAN { days, reason }`, `MODNOTE { text, label? }`. The validator enforces step count 1-10, BAN.days 0-999, and MODNOTE.text up to 1000 chars.

### 3. Real-time team activity feed

Every action a mod takes streams into a per-sub feed (last 500 entries) with moderator, target thing, combo name, and per-step success/failure detail. Failed combos show *which* step failed and the underlying error message, so reviewers can manually finish what auto-execution couldn't.

### 4. Collision metrics dashboard

Three counters tracked per ISO week, displayed in the **Metrics** tab with week and month rollups:

- `softWarningsShown` — how many times a moderator hit the soft-warning form
- `collisionsDetected` — how many times a moderator chose **Proceed** anyway
- `redundantActionsAvoided` — how many times a moderator chose **Cancel**

The third counter is the success metric. Every increment is a duplicate ban or contradictory mod note that didn't happen.

---

## How It's Different from MQCC / OmniMod

ModSync is **complementary, not competing.**

- **MQCC** focuses on *priority scoring* — what should be reviewed first. ModSync focuses on *collision avoidance* — making sure two mods don't process the same item twice. Run them side by side: MQCC tells you what to look at, ModSync tells you who's already looking.
- **OmniMod** and other multi-purpose mod toolkits cover bulk actions and rule automation. ModSync deliberately stays narrow: presence, claims, combos, activity, metrics. Less surface area, less to learn, faster review cycles.
- **AutoModerator and rule bots** act on rules, not on humans. ModSync coordinates the humans.

The narrow scope is intentional. The arXiv research identified collision avoidance as a specific, unsolved problem; ModSync solves it without trying to be everything else.

---

## Architecture

```
┌──────────────┐     ┌──────────────────────┐     ┌─────────────┐
│   Reddit     │     │  ModSync Server      │     │   Webview   │
│   Menu /     │ ──▶ │  (Hono on Devvit)    │ ──▶ │  (React)    │
│   Form /     │     │                      │     │             │
│   Trigger    │ ◀── │  ┌──────────────┐    │ ◀── │  Activity   │
└──────────────┘     │  │ Redis (per   │    │     │  Metrics    │
                     │  │ install,     │    │     │  Combos     │
                     │  │ namespaced)  │    │     │             │
                     │  └──────────────┘    │     └─────────────┘
                     │  ┌──────────────┐    │           ▲
                     │  │  Realtime    │ ───┼───────────┘
                     │  │  channels    │    │   claims-{sub}
                     │  │              │    │   actions-{sub}
                     │  └──────────────┘    │
                     └──────────────────────┘
```

Runs entirely on Devvit primitives: **Redis** for state, **Realtime** for fan-out, **Reddit API** for moderator actions, **Devvit Forms** for the soft-warning UX. No external services, no third-party APIs, no auth servers — full per-install isolation.

### Per-sub Redis schema (excerpt)

| Key | Type | Purpose | TTL |
| --- | --- | --- | --- |
| `claims:{sub}:{thingId}` | STRING (JSON) | Active claim record | 90s |
| `claims-index:{sub}` | SORTED SET | thingId → expiry-ms (for live-list reads) | manual |
| `actions:{sub}` | SORTED SET | Last 500 audit entries, score=ts | none, capped at 500 |
| `combos:{sub}` | HASH | name → JSON ComboSpec (cap 50) | none |
| `metrics:{sub}:{isoWeek}` | HASH | softWarningsShown / collisionsDetected / redundantActionsAvoided | 60d |
| `mods:{sub}` | HASH | username → "1" (auth allowlist) | refreshed |
| `mods-expiry:{sub}` | STRING | sentinel for 5-min mods cache | 300s |
| `deleted-mods:{sub}` | HASH | username → "1" (compliance scrub) | append-only |

Realtime channels use hyphens (`claims-Modsynnow`, `actions-Modsynnow`) per Devvit's channel-naming rules. Redis keys use colons. The two namespaces never overlap.

### Server modules (`src/server/`)

- **`auth.ts`** — `requireMod` runs on every menu, form, and mutating API endpoint. Caches the moderator list for 5 minutes via `mods:{sub}` + `mods-expiry:{sub}`.
- **`claims.ts`** — `claim` / `release` / `refresh` / `getClaim` / `listActiveClaims`. Each write also publishes a typed event on `claims-{sub}`.
- **`combos.ts`** — `validateCombo` (pure) + `saveCombo` / `deleteCombo` / `listCombos`. Validator enforces every constraint up front so the storage layer never sees malformed data.
- **`executor.ts`** — `runCombo` dispatches each step against the Reddit API, refreshes the claim per step (so long combos don't expire), appends one audit entry on completion, and releases the claim with `reason: 'completed' | 'manual'`.
- **`feed.ts`** — `appendAction` / `readFeed` / `purgeByThingId`. Sorted-set with newest-first reads and a hard cap at 500 entries via `zRemRangeByRank`.
- **`metrics.ts`** — `bumpMetric` / `getMetrics`. Week scope reads one HASH; month scope enumerates 4-6 ISO weeks overlapping the calendar month and sums them in parallel.
- **`realtime.ts`** — Thin swallow-and-log wrappers around `realtime.send` for the executor's release publish. Storage modules call `realtime.send` directly so they can assert exact-once semantics in tests.
- **`scrub.ts`** — `isModeratorDeleted` + `scrubEntry`. Read-time compliance scrub for moderators who deleted their accounts. Audit rows stay byte-identical on disk.

### Client modules (`src/client/`)

- **`App.tsx`** — tab router (Activity / Metrics / Combos), parallel initial fetch (`/api/feed`, `/api/metrics`, `/api/combos`, `/api/claims`), error surface.
- **`realtime.ts`** — `useRealtime` hook wraps Devvit's `connectRealtime` with a 250ms→4s exponential backoff and an `onResync` callback that fires after every successful reconnect (not the initial connect).
- **`api.ts`** — typed `fetch` wrappers for every endpoint, with status-code-aware error throwing.
- **`tabs/ActivityFeed.tsx`** — pure presentation. Exports `prependDedupe(feed, incoming, max)` for the parent's realtime fold.
- **`tabs/MetricsDashboard.tsx`** — week/month toggle, three counter cards.
- **`tabs/ComboConfig.tsx`** — CRUD UI with client-side regex preflight + inline server-error display.

---

## Quick Stats

- **180+ tests**, all passing (`npm test --run`)
- **11 correctness properties** validated by `fast-check` property-based tests (≥100 iterations each, 200+ for the combo validator and ISO-week derivation)
- **~2,500 lines of TypeScript** across server + client + shared types
- **Build time ~700ms** (`vite build` via `@devvit/start/vite`, single-pass CJS server bundle + ESM client bundle)
- **Zero runtime dependencies on third-party services** beyond Devvit
- **One devDependency-only test framework** (Vitest + fast-check + @testing-library/react)

---

## Installation

ModSync targets the Devvit Web platform.

```bash
# 1. Install dependencies
npm install

# 2. Authenticate the Devvit CLI with your Reddit account
npx devvit login

# 3. Run a live playtest against your test subreddit
npm run dev
```

`npm run dev` is an alias for `devvit playtest`, which uploads the bundle and pins it to the `dev.subreddit` declared in `devvit.json`. The first upload auto-creates an app account (e.g. `u/<app-slug>`) — invite that account as a moderator of your test sub with full permissions before exercising the menu items.

For production install:

```bash
npm run deploy   # type-check + lint + devvit upload
```

After upload, install on a target sub via `https://developers.reddit.com/apps/<your-app-slug>`.

---

## Demo Flow (two-browser collision walkthrough)

This is the hackathon demo path. It takes ~2 minutes and exercises every P0 capability.

### Prerequisites

- ModSync installed on a test sub (`npm run dev` against your `dev.subreddit`).
- Two moderator accounts on that sub. One is your primary, the other is an alt.
- Two browsers (or one browser + one private window) so each session is signed in independently.

### Steps

1. **Seed the queue.** From the **Combos** tab settings, flip `seedEnabled` on temporarily. POST `/api/dev/seed?count=12` to create 12 demo posts and report each into the modqueue. Flip `seedEnabled` off again.
2. **Open the queue in browser A** (your primary moderator). Click **"Claim for review"** on the first demo post.
3. **Open the same post in browser B** (your alt). Click **"Claim for review"**.
4. Browser B sees the **soft-warning Devvit Form**: *"u/primary is reviewing this — 87s left. Proceed?"*
5. **Cancel** the form in browser B. Watch the **Activity** tab in both browsers — no extra claim is recorded. The `redundantActionsAvoided` counter ticks up.
6. **In browser A**, run the `spam-removal` combo from the **"Run combo…"** menu. Three steps execute (REMOVE → BAN 7d → MODNOTE), the activity feed in both browsers receives the entry within ~1 second, and the claim releases automatically with `reason: 'completed'`.
7. **Switch to the Metrics tab in browser A.** This week's bucket shows `softWarningsShown: 1`, `redundantActionsAvoided: 1`, `collisionsDetected: 0`. That's the success metric — one duplicate action did not happen.
8. **Repeat step 3** but **Proceed** instead of cancel. The collision counter goes up; both moderators' actions appear in the feed; the audit trail captures both attempts.

### What the judges should see

- Sub-second realtime fan-out (claim event in browser A → soft warning in browser B).
- The Devvit Form (not a webview dialog) for the soft warning. This is intentional and matches Reddit's native UX.
- Per-step success/failure visible in the activity feed when a combo step throws (rare in test, but the UI handles it).
- Three counters update live as forms are submitted.

---

## Project Layout

```
src/
  server/          # Hono routes, claims, combos, executor, triggers
    claims.ts      # claim/release/refresh/getClaim/listActiveClaims
    combos.ts      # validate/save/delete/list combos
    executor.ts    # runCombo — sequential step dispatch w/ refresh per step
    feed.ts        # appendAction/readFeed/purgeByThingId
    metrics.ts     # bumpMetric/getMetrics (week + month rollup)
    realtime.ts    # publishClaim/publishAction wrappers
    auth.ts        # requireMod (cached 5-min mod-list)
    scrub.ts       # deleted-account compliance, lazy on read
    seed.ts        # demo seed
    redisKeys.ts   # all key builders + ISO week derivation
    defaultCombos.ts  # canned spam-removal + rule-violation
    routes/
      api.ts          # /api root router
      combos.ts       # /api/combos GET/POST/DELETE
      feed.ts         # /api/feed?limit=
      metrics.ts      # /api/metrics?period=week|month
      menu.ts         # /internal/menu/{claim,combo-picker}
      forms.ts        # /internal/form/{soft-warning,combo-picker,combo-editor}-submit
      triggers.ts     # /internal/trigger/{app-install,post-delete,comment-delete}
    menu/
      claimHandler.ts        # foreign-claim detection + soft warning
      comboPickerHandler.ts  # picker form rendering
    forms/
      softWarningSubmit.ts   # collision vs redundant routing
      comboPickerSubmit.ts   # combo dispatch w/ optional override
    triggers/
      appInstall.ts   # mod-cache warm + default-combo seed
      postDelete.ts   # purge audit + claim for deleted post
      commentDelete.ts

  client/          # React webview
    App.tsx        # Tab router + initial fetch + realtime wiring
    realtime.ts    # useRealtime hook with 250ms→4s backoff + resync
    api.ts         # Typed fetch wrappers
    types.ts       # Re-export barrel from shared/types
    tabs/
      ActivityFeed.tsx
      MetricsDashboard.tsx
      ComboConfig.tsx

  shared/
    types.ts       # ClaimRecord, ComboSpec, ActionEntry, RealtimeEvent, MetricsBucket

tests/             # 26+ spec files, 180+ tests
  _fakes/redisFake.ts   # In-memory Redis with TTL/HASH/sorted-set support

.kiro/
  specs/modsync/   # Locked requirements + design + tasks
  steering/        # Build truth, architecture, deployment state, implementation log
```

---

## API Surface

All `/api/*` endpoints require moderator auth via `requireMod`. Forbidden requests return `{ error: 'forbidden' }` with status 403.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/feed?limit=N` | Newest-first audit entries (default 50, cap 500) |
| GET | `/api/metrics?period=week\|month` | Counter bucket + `period` + `periodKey` |
| GET | `/api/combos` | List all saved combos |
| POST | `/api/combos` | Create/update a combo (validates first) |
| DELETE | `/api/combos/:name` | Idempotent delete |
| GET | `/api/claims` | Map of active claims (thingId → ClaimRecord & ttlSec) |
| POST | `/api/dev/seed?count=N` | Gated by `seedEnabled` setting |

Internal endpoints (Devvit invokes these; not for direct client calls):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/internal/menu/claim` | "Claim for review" menu item |
| POST | `/internal/menu/combo-picker` | "Run combo…" menu item |
| POST | `/internal/form/soft-warning-submit` | Collision form submit |
| POST | `/internal/form/combo-picker-submit` | Combo selection submit |
| POST | `/internal/form/combo-editor-submit` | Combo CRUD submit |
| POST | `/internal/trigger/app-install` | First install + re-install warm-up |
| POST | `/internal/trigger/post-delete` | Compliance scrub |
| POST | `/internal/trigger/comment-delete` | Compliance scrub |

---

## Settings

Declared in `devvit.json` (or via the App Directory settings UI per install):

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `seedEnabled` | boolean | `false` | Gates `/api/dev/seed`. Flip ON briefly during demo, OFF immediately after. |

The `seedEnabled` setting is read fresh on every `/api/dev/seed` request — no cached boolean, no server restart needed to flip.

---

## Testing Strategy

ModSync ships with property-based tests for every module that produces validated logic. The 11 properties from `design.md`:

| # | Property | Module |
| --- | --- | --- |
| 1 | Claim write produces correct record + index entry | `tests/claims.spec.ts` |
| 2 | Each claim/release publishes exactly one realtime event | `tests/claims.spec.ts` |
| 3 | No-foreign-claim and combo-override paths produce correct claim state | `tests/claimHandler.spec.ts` |
| 4 | Release deletes claim + index; refresh updates timestamp + score | `tests/claims.spec.ts` |
| 6 | Realtime payload integrity (publish-then-subscribe deepEqual) | `tests/realtime.spec.ts` |
| 7 | Combo validator + CRUD round-trip | `tests/combos.spec.ts` |
| 8 | Feed ordering, cap, and prepend-dedupe (server + client halves) | `tests/feed.spec.ts`, `tests/ActivityFeed.spec.tsx` |
| 9 | Metric counter routing + zero-state | `tests/metrics.spec.ts` |
| 10 | Auth gate (returns iff in mod list, no side-effects on throw) | `tests/auth.spec.ts` + every route test |
| 11 | ISO-week-key correctness; deleted-account scrub semantics | `tests/redisKeys.spec.ts`, `tests/scrub.spec.ts` |

Iteration counts: ≥100 for most properties, ≥200 for the combo validator (`tests/combos.spec.ts`) and the ISO-week boundary test (`tests/redisKeys.spec.ts`).

Auth tests use a recording fake that asserts **zero Redis writes on the throw path** — the structural invariant that makes Property 10 useful. Every route test repeats the same pattern at the API boundary.

Run targeted property suites with `npm test -- <file>`. Run the full suite with `npm test`.

---

## Compliance

ModSync follows the Devvit Rules and Reddit Developer Terms:

- Honors `onPostDelete` and `onCommentDelete` triggers — purges audit entries and active claims for any deleted Thing within the same Devvit invocation. Idempotent: re-delivering the same trigger leaves Redis byte-identical.
- Scrubs references to deleted moderator accounts on read, lazily, via a per-install `deleted-mods:{sub}` cache. Deleted moderator names render as `[deleted]` in the activity feed; the underlying audit log is preserved byte-identical so the audit trail stays intact even after a moderator deletes their account.
- Never makes outbound network requests outside Devvit primitives (no third-party APIs, no telemetry, no analytics).
- Per-install Redis namespaces — no cross-sub data leak, no shared state.
- Moderator-only menu items, gated by `requireMod` on every menu, form, and mutating API endpoint.
- All moderator actions go through Reddit's official API via the Devvit `reddit` client; ModSync never circumvents Reddit's rate limits or content policies.

---

## Development Commands

```bash
npm test                # Vitest, all property tests run with --run
npm run type-check      # tsc --build
npm run lint            # ESLint over src/**/*.{ts,tsx}
npm run build           # vite build (emits dist/server/index.cjs + dist/client/)
npm run dev             # devvit playtest against dev.subreddit
npm run deploy          # type-check + lint + devvit upload
npm run launch          # devvit publish (App Directory listing)
```

The `tests/` directory mirrors `src/server/` and `src/client/`. Property tests use `fast-check` and live next to the example tests they complement. The redis fake under `tests/_fakes/redisFake.ts` provides TTL-aware lazy expiry, all sorted-set ops with rank/score/lex `by` modes, and HASH ops — sufficient to exercise every production code path without touching the real Devvit Redis.

---

## License

[BSD-3-Clause](LICENSE).

---

## Acknowledgements

- The Cornell arXiv paper **"In the Queue: Understanding How Reddit Moderators Use the Modqueue"** (Sept 2025) for the research that motivated this project — particularly the 74.5% collision statistic that became the design's north star.
- The Reddit Developer Platform team for Devvit Web, the Realtime primitive, and the per-install Redis namespace that makes per-sub state isolation trivial.
- The Reddit moderator community at large for years of public discussion about queue-management pain points.
- Built for the **Reddit Mod Tools and Migrated Apps Hackathon** (April-May 2026).
