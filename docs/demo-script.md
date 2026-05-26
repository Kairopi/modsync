# ModSync — 3-Minute Demo Video Script

> **Total runtime: 3:00.** Devpost rule (≤3:00). Read every voiceover line aloud against the timestamp range — if it doesn't fit, trim before recording. Conversational delivery, not robotic.

---

## Pre-recording setup

- **Browser A**: Chrome window, logged in as `u/Standard-Hotel6953` (subreddit owner), parked on `https://www.reddit.com/r/Modsynnow/about/modqueue`.
- **Browser B**: Chrome incognito or a separate profile, logged in as a second moderator account (the "alt" — referred to as `u/alt-mod` in voiceover; substitute the actual handle on screen). Parked on the same URL.
- **OBS scene**: 1920×1080 canvas, two browser sources side-by-side (each 960×1080), labels "Browser A — alice" and "Browser B — bob" rendered as a 1080×40 strip across the top. Mic input separate track for post-record VO sweetening.
- **Pre-seed**: Before recording, hit the `/api/dev/seed` endpoint via the **Combos** tab settings (or curl from the mod console) with `count=12`. This pre-fills the modqueue with `[ModSync demo 0]` … `[ModSync demo 11]` posts, all auto-reported so they appear in modqueue. **Flip `seedEnabled` back OFF immediately after seeding.**
- **Tabs open in each browser**: `Activity` tab visible by default. Combos and Metrics are one click away.
- **Cursor magnifier ON** (so click targets read at 1080p YouTube compression).

---

## Shot list

### 0:00 – 0:15 — Hook: the problem

| Field | Value |
| --- | --- |
| **On screen** | Full-frame still: the arXiv paper's title page. After 4s, smash-cut to a split-screen of two real-looking modqueue tabs (Browsers A and B) where both cursors hover the same post and click it within 200ms of each other. Red "X" overlays appear on both. |
| **Lower-third caption** | `"In the Queue" — Cui et al., arXiv 2509.xxxxx, Sept 2025 (n=110, 408 subs)` |
| **Voiceover (verbatim)** | "A 2025 study of 110 Reddit moderators reported **74.5 percent** had experienced collisions — two mods acting on the same item at the same time. Duplicate bans. Conflicting decisions. Today's tools don't fix it. ModSync does." |
| **Production notes** | Beat the 74.5% number into bold yellow text on the lower third for the second half of the segment. Voice tight; this 15s sets the entire pitch. |

---

### 0:15 – 0:45 — Live presence + soft claim

| Field | Value |
| --- | --- |
| **On screen** | Both browsers visible. Browser A clicks **More options → Claim for review** on `[ModSync demo 0]`. A green toast `Claimed` appears top-right of A. Within 1 second, Browser B's view of the same post shows a "🔒 alice — 89s left" pill rendered in the ModSync custom post embed at the top of the modqueue. Browser B then clicks the same post's **Claim for review**. A Devvit Form modal opens in B titled "Soft warning" showing the text `u/alice is reviewing this — 88s left.` and a `Proceed?` checkbox (unchecked). |
| **Lower-third caption** | `Soft claim → broadcast in <1s via Devvit Realtime` then switch to `Override or cancel — both outcomes are recorded` |
| **Voiceover (verbatim)** | "Alice clicks 'Claim for review' on a post. Ninety-second soft claim, broadcast on the realtime channel, visible to every mod within a second. Bob tries to claim the same post. ModSync surfaces a soft warning — who's holding it, how long is left, a 'Proceed' toggle. Bob can override consciously, or cancel cleanly. Either way, the metrics tab knows." |
| **Production notes** | Split-screen the whole 30s. Sync the cursor moves so the realtime fan-out is visibly fast. Use a freeze-frame on the warning modal at the 0:38 mark for ~1s. |

---

### 0:45 – 1:30 — Combo execution (the wow moment)

| Field | Value |
| --- | --- |
| **On screen** | Browser B clicks Cancel on the soft warning. Cut to Browser A only (full screen). A clicks **More options → Run combo…** on the claimed post. A picker form opens listing two options: `spam-removal` and `rule-violation`. A selects `spam-removal`, clicks **Run**. Toast: `Combo complete`. Fast cut back to split-screen — Browser B's Activity tab is already showing the new entry at the top: `alice • spam-removal • [ModSync demo 0] • just now • REMOVE → BAN 7d → MODNOTE`. The post in Browser B's modqueue list now has a strikethrough and the "[removed]" tag. |
| **Lower-third caption** | `Combo: REMOVE → BAN 7 days → MODNOTE — one click` then `Activity feed updates on every connected mod, sub-1s` |
| **Voiceover (verbatim)** | "Bob cancels. Now Alice runs a combo. One click, three Reddit API calls — remove, seven-day ban, mod note. The combo engine refreshes the claim before each step so a long-running combo never expires mid-flight. Bob sees the result in his activity feed before Alice's toast even fades. No external services. Just Devvit Web, Redis, and Realtime." |
| **Production notes** | This is the wow. Punch the cut from picker → toast → feed in tight rhythm; no dead air. The "REMOVE → BAN 7d → MODNOTE" chips in the activity feed should be on screen for at least 3 seconds. |

---

### 1:30 – 2:15 — Activity feed + metrics dashboard

| Field | Value |
| --- | --- |
| **On screen** | Browser A: switch to the **Metrics** tab. Show the dashboard with three cards: `Soft warnings shown: 1`, `Collisions detected: 0`, `Redundant actions avoided: 1`. Period selector reads `Week — 2026-W21`. Cut to Browser B running a second combo on `[ModSync demo 1]` — the activity feed prepends. Cut back to A's Metrics: counters update live without reload. Then click the period dropdown to switch to `Month — 2026-05` and the numbers fold up the four overlapping ISO weeks. |
| **Lower-third caption** | `Activity feed: 500-entry sliding window, prepend-deduped` then `Metrics: per-ISO-week HASH, week or month rollup` |
| **Voiceover (verbatim)** | "The activity feed is a 500-entry sliding window, deduplicated by ULID so re-deliveries on reconnect don't double-render. Metrics tracks three counters per ISO week — soft warnings shown, collisions overridden, redundant actions avoided. Switch to month and you get the rollup across overlapping weeks. Every mod in the sub sees the same numbers." |
| **Production notes** | The metrics card transition from Week → Month is the visual anchor. Hold the Month view for 2s. Both tabs stay always-mounted, so switching is instant — exploit that, no loading spinners on screen. |

---

### 2:15 – 2:45 — Compliance (deletion triggers + scrub-on-read)

| Field | Value |
| --- | --- |
| **On screen** | Cut to Browser A. Open one of the demo posts in a third tab. Click `...` → **Delete**. Confirm. Cut back to ModSync's Activity tab — the entry for that post is gone within 2 seconds (the `onPostDelete` trigger purged it from `actions:{sub}`). Then a quick visual: a small terminal overlay showing `tests/triggers.delete.spec.ts ✓ 5/5` and `tests/scrub.spec.ts ✓ 13/13`. |
| **Lower-third caption** | `onPostDelete + onCommentDelete → instant feed purge` then `Deleted accounts → 'u/[deleted]' on read, audit row preserved` |
| **Voiceover (verbatim)** | "Compliance is built in. When a post or comment is deleted, ModSync's trigger handlers purge it from the feed and release any active claim — same Redis state on every redelivery. When a moderator account disappears, their name is scrubbed to '[deleted]' on read, but the underlying audit row stays intact. Per-install Redis isolation, no outbound network, mod-gated on every endpoint." |
| **Production notes** | The terminal overlay is 30% opacity, bottom-right, ~6s. Don't let it cover Alice's cursor. The voiceover must land on "Per-install Redis isolation" right as the visual hits the test-pass overlay. |

---

### 2:45 – 3:00 — Call to action

| Field | Value |
| --- | --- |
| **On screen** | Black background. Centered ModSync logo (the icon from `assets/icon.png`). Below: install URL **`developers.reddit.com/apps/modsync-set`** in 80pt mono. Subtitle: `Open source · Devvit Web · BSD-3-Clause`. URL stays on screen for the full 15s. |
| **Lower-third caption** | (none — the URL is the entire frame) |
| **Voiceover (verbatim)** | "ModSync. Real-time collision-free modqueue coordination for Reddit moderators. Install at developers dot reddit dot com slash apps slash modsync-set. Built for the Reddit Mod Tools hackathon. Source on GitHub." |
| **Production notes** | Hard cut to black, no fade. URL pops in on the first syllable of "Install". Final 2 seconds: hold the URL silent so judges can read it before the video ends. End card freezes — no autoplay-next. |

---

## Beat budget audit

| Range | Duration | Words (target) | Words (actual) | Status |
| --- | --- | --- | --- | --- |
| 0:00–0:15 | 15s | ≤37 | 35 | ✓ |
| 0:15–0:45 | 30s | ≤75 | 58 | ✓ |
| 0:45–1:30 | 45s | ≤112 | 56 | ✓ tight |
| 1:30–2:15 | 45s | ≤112 | 52 | ✓ tight |
| 2:15–2:45 | 30s | ≤75 | 60 | ✓ |
| 2:45–3:00 | 15s | ≤37 | 29 | ✓ |
| **Total** | **3:00** | **≤448** | **290** | **✓ under budget** |

Word counts come in below the conversational ceiling on every beat. That leaves room for natural pauses between sentences and for the music bed to breathe. Do not pad — judges' attention drops at the 90-second mark; the second half (1:30–3:00) needs visual density, not extra narration.

---

## Capability coverage check (P0 floor)

The video must demonstrate all four P0 capabilities from `requirements.md`. Mapping:

| P0 capability | Demonstrated in beat |
| --- | --- |
| Live presence + soft claims (Req 2, 3) | 0:15–0:45 |
| One-click action combos (Req 4, 6) | 0:45–1:30 |
| Real-time team activity feed (Req 7) | 0:45–1:30 + 1:30–2:15 |
| Metrics dashboard (Req 8) | 1:30–2:15 |
| Compliance — deletion triggers + scrub (Req 9) | 2:15–2:45 |

Every P0 lands on screen with both UI evidence and a voiceover line that names it.

---

## Recording checklist (before you hit record)

- [ ] `npm run dev` is connected to `r/Modsynnow` and the custom post is visible in the subreddit.
- [ ] Browser A and Browser B are both logged in as moderators with full permissions.
- [ ] `/api/dev/seed` has been hit with `count=12`; modqueue shows 12 `[ModSync demo N]` posts; **`seedEnabled` flipped back to OFF**.
- [ ] The metrics counters are at zero (clear the `metrics:Modsynnow:{week}` HASH if needed via redis CLI before recording).
- [ ] Mic level peaks around -12 dB; no AC fan in background.
- [ ] OBS canvas is 1920×1080 at 60fps. YouTube compression on the call-to-action URL is the failure mode you want to avoid most.
- [ ] One full silent rehearsal pass to confirm cursor choreography lands on the right beats.

---

## On-screen caption strings (copy-paste, verbatim)

```
"In the Queue" — Cui et al., arXiv 2509.xxxxx, Sept 2025 (n=110, 408 subs)
74.5% of moderators have experienced collisions
Soft claim → broadcast in <1s via Devvit Realtime
Override or cancel — both outcomes are recorded
Combo: REMOVE → BAN 7 days → MODNOTE — one click
Activity feed updates on every connected mod, sub-1s
Activity feed: 500-entry sliding window, prepend-deduped
Metrics: per-ISO-week HASH, week or month rollup
onPostDelete + onCommentDelete → instant feed purge
Deleted accounts → "u/[deleted]" on read, audit row preserved
developers.reddit.com/apps/modsync-set
```

If you don't have the real arXiv ID at record time, replace `2509.xxxxx` with the verbatim paper title only and drop the `arXiv 2509.xxxxx` token.

---

## Demo-seed command (one-liner, for reference)

The `/api/dev/seed` endpoint runs from inside the Devvit app context, not via curl. To seed before recording:

1. Open the **Combos** tab in either browser.
2. Open the app's settings panel (gear icon, top right of the post embed).
3. Toggle `seedEnabled` to ON.
4. POST to `/api/dev/seed?count=12` from the in-app dev controls.
5. Toggle `seedEnabled` back to OFF immediately. Leaving it on in production is a compliance risk.

If the in-app control isn't wired yet, run the equivalent through the redis CLI manually — but never expose `seedEnabled` in a recorded demo.
