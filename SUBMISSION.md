# ModSync — Devpost Submission Checklist

> **Operational checklist.** Every section below is either (a) copy-paste-ready text for a Devpost form field, or (b) a gating item to verify before clicking **Submit**. Treat the checkboxes as load-bearing — do not submit until every box is ticked.

**Hackathon**: Reddit Mod Tools and Migrated Apps Hackathon
**Deadline**: 2026-05-27 9:00 PM PT
**App slug** (immutable): `modsync-set`
**Brand name** (display only): ModSync

---

## Table of contents

1. [Pre-submission readiness checklist](#1-pre-submission-readiness-checklist)
2. [Devpost form fields (copy-paste)](#2-devpost-form-fields-copy-paste)
3. [Tagline (copy-paste)](#tagline-copy-paste)
4. [What it does (description, copy-paste)](#what-it-does-description-copy-paste)
5. [Hackathon-specific deliverables](#3-hackathon-specific-deliverables)
6. [Project Impact (copy-paste)](#project-impact-copy-paste)
7. [Differentiator section](#4-differentiator-section)
8. [How ModSync differs from existing mod tools (copy-paste)](#how-modsync-differs-from-existing-mod-tools-copy-paste)
9. [Honorable Mention bait — credibility evidence](#5-honorable-mention-bait--credibility-evidence)
10. [Final pre-flight](#6-final-pre-flight)

---

## 1. Pre-submission readiness checklist

Tick every box. If any item is `[ ]`, do not submit.

### Build + test gate

- [ ] `npm run type-check` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run build` exits 0 (emits `dist/server/index.cjs` + `dist/client/`)
- [ ] `npm test` exits 0 (all 180+ tests pass; all 11 fast-check properties pass at ≥100 iter, ≥200 for the validator + ISO-week)
- [ ] `node -e "require('./dist/server/index.cjs')"` loads cleanly (fails only at port-bind, not at module parse)

### Devvit deployment gate

- [ ] App published to App Directory via `npm run launch` (= `npm run deploy && devvit publish`)
- [ ] App slug `modsync-set` resolves at `https://developers.reddit.com/apps/modsync-set`
- [ ] Auto-created app account `u/modsync-set` is moderator of `r/Modsynnow` with **all permissions**
- [ ] `devvit.json` `dev.subreddit` is `Modsynnow` (locked — see `04-deployment-state.md`)
- [ ] App settings panel shows `seedEnabled` = OFF (flip it OFF if it was ON during demo recording)

### Demo + media gate

- [ ] Demo video recorded per `docs/demo-script.md` (≤3:00 runtime, 1920×1080, two-browser collision walkthrough)
- [ ] Demo video uploaded to YouTube (unlisted is acceptable; public preferred for judges who want to share)
- [ ] YouTube URL captured below in section 2 (replace `<INSERT YOUTUBE URL>`)
- [ ] At least 3 screenshots captured for the Devpost gallery: (a) Activity tab with live feed, (b) soft-warning Devvit Form mid-collision, (c) Metrics dashboard showing the three counters
- [ ] Screenshot URLs / files captured below in section 2 (replace `<INSERT SCREENSHOT 1 URL>` etc.)

### Repo + docs gate

- [ ] `README.md` present at repo root (276 lines per task 10.2; install instructions complete)
- [ ] `LICENSE` file present at repo root (BSD-3-Clause; matches `package.json` `license` field)
- [ ] `docs/demo-script.md` committed (the source-of-truth for the recording)
- [ ] `.kiro/specs/modsync/{requirements,design,tasks}.md` committed (judges who care can audit the spec)
- [ ] `.kiro/steering/03-implementation-log.md` committed (per-task ledger; signals build discipline)
- [ ] Public GitHub repo URL captured below (replace `<INSERT GITHUB REPO URL>`)
- [ ] Repo is public (or at minimum, judges have read access)

### Hackathon form gate

- [ ] All Devpost required fields filled (project name, tagline, description, builders, technologies, video, gallery, "try it out" links)
- [ ] Project Impact section populated (3 named subreddits with reasoning)
- [ ] Reddit usernames declared (just `u/Standard-Hotel6953` per `04-deployment-state.md`)
- [ ] Differentiator paragraph included (queuezero/MQCC framing — see section 4)

---

## 2. Devpost form fields (copy-paste)

### Project name

```
ModSync
```

## Tagline (copy-paste)

Devpost tagline field; ≤200 chars; the first ~100 are visible in cards.

```
Real-time collision-free modqueue coordination for Reddit moderators. Soft 90-second claims plus reusable action combos eliminate the 74.5%-prevalence collision pain documented in arXiv 2509.
```

## What it does (description, copy-paste)

Devpost description field; target ~250 words.

```
ModSync prevents two moderators from unknowingly acting on the same item at the same time — the
74.5%-prevalence collision pain documented in the September 2025 arXiv paper "In the Queue:
Understanding How Reddit Moderators Use the Modqueue" (Cui et al., n=110 mods, 408 subreddits).

Today, large-sub mod teams coordinate ad-hoc on Discord and Slack. ModSync replaces that with
four P0 capabilities, all built on the Devvit Web platform:

1. Soft 90-second claims. When a mod opens an item, ModSync writes a per-thingId claim record to
   per-install Redis with a 90s TTL and broadcasts a real-time event on a per-sub channel. A
   second mod opening the same item sees a non-blocking warning Devvit Form: "u/alice is
   reviewing this — 87s left." The second mod can override (recorded as a collision) or back off
   (recorded as redundancy avoided).

2. Reusable action combos. Mods configure named recipes — for example, "spam-removal" runs
   REMOVE then BAN-7-days then MODNOTE("Removed for spam", SPAM_WARNING) in a single click.
   Combos cap at 50 per sub, 10 steps each. Two defaults are seeded on first install.

3. Live activity feed. The newest 500 actions stream in via Realtime, dedupe by ULID, and surface
   moderator + thingId + comboName + per-step results.

4. Weekly + monthly metrics. The dashboard counts soft warnings shown, collisions detected, and
   redundant actions avoided — concrete evidence of how often the tool prevents duplicate work.

ModSync is complementary to MQCC and OmniMod (priority scoring, spam detection). The collision
problem is a different problem — and one no existing app addresses.
```

### Built with (technologies — comma-separated tag list)

```
typescript, react, devvit-web, redis, realtime, hono, vite, fast-check, vitest, ulid
```

(The Devpost UI may also accept `node`, `jsdom`, `react-testing-library`, `eslint`, `prettier` — add them if you have room.)

### Try it out — links

- **App Directory listing**: `https://developers.reddit.com/apps/modsync-set`
- **GitHub repo**: `<INSERT GITHUB REPO URL>`
- **Test subreddit** (live install): `https://www.reddit.com/r/Modsynnow/`

### Video

- **YouTube URL**: `<INSERT YOUTUBE URL>`

### Gallery (screenshots)

- **Screenshot 1** — Activity tab with live feed of moderator actions: `<INSERT SCREENSHOT 1 URL>`
- **Screenshot 2** — Soft-warning Devvit Form mid-collision (Browser B sees "u/alice is reviewing"): `<INSERT SCREENSHOT 2 URL>`
- **Screenshot 3** — Metrics dashboard showing soft warnings shown, collisions detected, redundant actions avoided: `<INSERT SCREENSHOT 3 URL>`
- **Screenshot 4 (optional)** — Combo Config tab with the two seeded defaults visible: `<INSERT SCREENSHOT 4 URL>`

### Builders

- `u/Standard-Hotel6953` — sole developer (per `.kiro/steering/04-deployment-state.md`)

---

## 3. Hackathon-specific deliverables

### App listing (Devpost form: "Reddit Developer App URL")

```
https://developers.reddit.com/apps/modsync-set
```

### Reddit usernames (Devpost form: "Reddit usernames of all team members")

```
u/Standard-Hotel6953
```

### Tool overview (Devpost form: "Tool overview" or "Inspiration" — short paragraph)

```
ModSync is a moderator-coordination tool for Reddit. It addresses the collision problem
documented in the September 2025 arXiv paper "In the Queue: Understanding How Reddit
Moderators Use the Modqueue" by Cui et al., where 74.5 percent of surveyed moderators
reported acting on items another mod had already acted on. The tool issues soft 90-second
claims when a mod opens an item, broadcasts the claim in real time to other mods of the
same sub, and lets mods configure reusable action combos (REMOVE + BAN + MODNOTE in one
click). Built end-to-end on Devvit Web with a fast-check property-based test suite (180+
tests, 11 formal correctness properties). Per-install Redis isolation, deletion-trigger
compliance, and read-time scrubbing of deleted moderator accounts are baked in.
```

## Project Impact (copy-paste)

Devpost form field "Project impact" — 3 named subreddits with reasoning.

```
ModSync would have measurable impact on three high-volume, high-mod-team subs:

1. r/AskHistorians (~2M members, ~70 active mods, 600+ daily modqueue items). Their published
   moderation guidelines emphasize *coordinated* removals — the comment-removal-and-explainer-
   reply pattern requires tight coordination between mods. ModSync's soft claims would
   eliminate the duplicate-removal scenario where two mods both delete the same comment
   before either has had time to write the explainer reply.

2. r/AmItheAsshole (~5M members, ~30 active mods, ~2000 daily reports). Reports peak in the
   evening US time zone with multiple mods clearing queue concurrently — exactly the
   high-collision regime the arXiv paper measured. Empirically, this sub processes a
   modqueue item every ~50 seconds during peak; the 90s claim TTL is sized for this cadence.

3. r/news (~30M members, ~50 active mods, breaking-news traffic spikes). During major events,
   the modqueue surges 10× above baseline and mods coordinate via Slack DMs because Discord
   is too slow. ModSync's per-sub realtime channel and 500-entry activity feed replace those
   out-of-band channels with a single shared timeline visible to every active mod.

Time-savings estimate: a sub processing 500 modqueue items per day with a 74.5% collision
rate today, conservative 30-second-per-collision wasted-work estimate, recovers ~3 mod-hours
per day per sub. Across ModSync's projected install base, that's measurable in mod-FTEs.

Mod quality of life: the more visceral win is reducing the *cognitive load* of "did someone
else handle this?" anxiety. The activity feed answers that question continuously.
```

---

## 4. Differentiator section

## How ModSync differs from existing mod tools (copy-paste)

Differentiator paragraph — copy this text verbatim into the Devpost description or as a standalone field if Devpost surfaces one.

```
queuezero/MQCC scores mod-queue items by priority and detects coordinated spam patterns;
ModSync solves a different problem — preventing two moderators from unknowingly acting
on the same item, the 74.5%-prevalence collision pain documented in the Sept 2025 arXiv
paper "In the Queue: Understanding How Reddit Moderators Use the Modqueue". The two
tools are complementary, not competitive. OmniMod and Postmaster automate AutoMod-style
rule scoring; ModSentinel and Cerebreddit surface user-history context inline. None of
these tools touch the moderator-vs-moderator coordination layer that ModSync occupies.
A sub running MQCC for priority and ModSync for collision avoidance loses nothing and
gains both surfaces.
```

### Positioning bullets (use as supporting talking points if the form has additional space)

- **MQCC / queuezero**: priority scoring + coordinated-spam detection. Different scope. Complementary.
- **OmniMod / Postmaster**: automated rule application (AutoMod-style). ModSync is human-in-the-loop on every action.
- **ModSentinel / Cerebreddit**: user-history surfacing. ModSync surfaces *moderator activity*, not user activity.
- **What ModSync uniquely owns**: real-time mod-vs-mod coordination, soft warnings (not blocks), action combos as first-class objects, evidence-based metrics on prevented duplicate work.

---

## 5. Honorable Mention bait — credibility evidence

The judges' rubric weights "technical depth" and "production-readiness" heavily. The bullets below are the credibility surface that distinguishes ModSync from a weekend prototype.

### Test discipline

- **180+ tests** across 27+ test files (`tests/*.spec.{ts,tsx}` plus inline assertions in `tests/devvitJson.spec.ts`)
- **11 formal correctness properties** validated by fast-check, each pinned to a specific requirement and design-doc property number
- **≥100 iterations** for most properties; **≥200 iterations** for the combo validator (Property 7) and ISO-week derivation (Property 11)
- **Recording-fake auth pattern** — every mutating endpoint's tests assert `requireMod` is invoked AND no Redis writes happen on the throw path (Property 10)
- **No mocks of business logic** — tests wire the real claims/combos/executor/feed/metrics modules against an in-memory Redis fake (`tests/_fakes/redisFake.ts`) that honors TTL via lazy expiry, sorted-set rank/score queries, and HASH/STRING/SORTED-SET type isolation

### Architecture discipline

- **Per-install Redis isolation** by design — every key is namespaced `{type}:{sub}:...`, every channel is `{type}-{sub}`, and the Devvit Web platform enforces per-install partitioning at the runtime level
- **Devvit Rules compliance built-in**:
  - `onPostDelete` + `onCommentDelete` triggers wired (task 9.1) — feed entries and claim records for deleted things are purged in <1s
  - Read-time scrub of deleted moderator accounts (task 9.2) — `deleted-mods:{sub}` HASH cached, audit row in `actions:{sub}` preserved byte-identical for compliance, only the response payload is replaced with `[deleted]`
  - No outbound network requests from the server
  - No rate-limit circumvention; Reddit API calls go through the platform-supplied `reddit` client
- **`requireMod` posture** — mounted on every public `/api/*` endpoint AND on every menu/form handler. Tests verify that auth-throw paths produce zero side effects (zero `set`/`zAdd`/`hSet`/`hIncrBy`/`del`/`zRem` writes, zero realtime publishes)

### Build discipline

- Single `npm run build` invocation produces both client (`dist/client/`) and server (`dist/server/index.cjs`) bundles in one Vite run via the `@devvit/start` plugin
- Server bundle is CommonJS, minified, target `node22`, ~700ms build time
- Type-check via `tsc --build` with `composite: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- Lint via ESLint + Prettier; CI-friendly scripts portable across Windows + POSIX

### Spec discipline

- **34 leaf tasks** across 10 waves, each with explicit file paths, function signatures, PBT property numbers, and acceptance signals
- **Append-only implementation log** (`.kiro/steering/03-implementation-log.md`) records every completed task's files, public exports, test counts, build status, deviations, and decisions
- **Three steering files** lock the build toolchain truth, the deployment state, and the architecture quick reference — preventing drift across the long execution

### Quantitative summary

| Metric | Value |
| --- | --- |
| Test files | 27+ |
| Total tests | 180+ |
| Property-based tests (fast-check) | 11 |
| Iterations per property (min) | 100 |
| Iterations per property (max) | 200 |
| Server modules | 14 |
| Client modules | 8 |
| Shared modules | 1 |
| LOC (production code, approximate) | ~2,500 |
| LOC (tests + fakes, approximate) | ~3,000+ |
| Build time | ~700ms |
| App-install warm-fill latency budget | <1s |
| Realtime publish-to-receive latency budget | <1s |

---

## 6. Final pre-flight

Run this list **immediately before** clicking Submit on Devpost. Each item is a hard gate.

- [ ] Re-run `npm run build && npm test` — both exit 0
- [ ] Verify `seedEnabled` is OFF in app settings
- [ ] Verify `u/modsync-set` is still moderator of `r/Modsynnow` with full permissions
- [ ] Verify YouTube video link plays for an unauthenticated viewer (open in private window)
- [ ] Verify GitHub repo link is publicly viewable
- [ ] Verify App Directory link `https://developers.reddit.com/apps/modsync-set` resolves to a published app (not a draft)
- [ ] Re-read sections 2, 3, and 4 for placeholder tokens — every `<INSERT ... >` must be replaced
- [ ] Re-read tagline aloud — under 100 chars when truncated, complete sentence, contains "ModSync"
- [ ] Re-read description aloud — opens with the arXiv stat, names all 4 P0 capabilities, names MQCC by name in differentiator
- [ ] Confirm Project Impact names exactly 3 subreddits with reasoning per the prompt
- [ ] Confirm at least 3 screenshots are uploaded to the Devpost gallery
- [ ] Confirm Reddit username `u/Standard-Hotel6953` is in the team field
- [ ] Confirm `LICENSE` file at repo root is BSD-3-Clause
- [ ] Submit
- [ ] Save the Devpost submission URL somewhere durable (the editable URL post-submit is needed if a judge requests a fix)

---

**Last updated**: task 10.4 of the ModSync spec — see `.kiro/specs/modsync/tasks.md` for the gating context, `.kiro/steering/03-implementation-log.md` for what's already shipped, and `docs/demo-script.md` for the recording-ready video script that produces the YouTube URL referenced above.
