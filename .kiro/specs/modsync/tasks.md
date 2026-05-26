# Implementation Plan: ModSync

## Overview

Greenfield Devvit Web app, TypeScript only, ~24-30h to deadline. Tasks are designed for parallel execution by `spec-task-execution` sub-agents — every leaf task is self-contained with explicit file paths, function signatures or component contracts, the PBT properties it validates, an acceptance signal, a priority tag (P0 / P1), and an aggressive time estimate in minutes.

The 11 Correctness Properties from `design.md` are each validated by at least one leaf task via fast-check property tests with ≥100 iterations. Property tests are required (not optional) for every leaf that produces validated logic.

**Cut order** (apply in this order if time runs short):
- P0 floor (cannot be cut): claim subsystem (4.x), soft warnings (4.2 + 4.2b + 6.3), metrics (5.x + 6.4), webview shell (6.1 + 6.2), deletion triggers (9.x — required for Devvit Rules compliance and Devpost approval), demo + submission deliverables (10.x)
- P1 (cuttable in order): combos (8.x — fall back to ship 8.6 default combos only if 8.3a/b/8.5 run over), activity feed (7.x — trim to last-50 only)

`npm run build` (or `devvit build`) MUST exit 0 after each parent task completes.

## Tasks

- [x] 1. Project bootstrap
  - [x] 1.1 Initialize Devvit Web app with full wiring scaffold
    - **Files**: `package.json`, `tsconfig.json`, `devvit.json`, `src/server/index.ts`, `src/server/routes/menu.ts`, `src/server/routes/forms.ts`, `src/server/routes/triggers.ts`, `src/server/routes/api.ts`, `src/client/index.html`, `src/client/index.tsx`, `src/client/App.tsx`, `vite.config.ts`, `.gitignore`, `eslint.config.js`, `.prettierrc`
    - **CONTEXT**: The repo was already scaffolded from the official `reddit/devvit-template-mod-tool-devvit-web` template. Current state: `src/index.ts` (Hono entry) + `src/routes/{menu,forms,triggers,api}.ts` + `src/core/nuke.ts` (template nuke logic — to be removed). devvit.json has template defaults (mop menu items, mopComment/mopPost forms, single onAppInstall trigger, `permissions.reddit: true` bare). `npm run build` is GREEN (~770ms emitting `dist/server/index.cjs`). Build pipeline is `@devvit/start/vite` plugin which auto-builds BOTH client (`dist/client/`) and server (`dist/server/index.cjs` as CJS via rollup) in one `vite build` run — DO NOT add a separate esbuild step.
    - **Migration tasks for 1.1**:
      1. Move `src/index.ts` → `src/server/index.ts`; move `src/routes/*.ts` → `src/server/routes/*.ts`. Delete `src/core/nuke.ts`. Update import paths.
      2. Server entry resolution order in `@devvit/start/vite` (verified in `node_modules/@devvit/start/vite/utils.js:getServerEntry`): `src/api/index.ts` → `src/server/index.ts` → `src/index.ts`. We pick `src/server/index.ts` to match the spec layout and the plugin's automatic server-only-imports check (it scans `src/server` and `src/api` for accidental client imports).
      3. `src/server/index.ts` MUST: import `Hono` from `hono`, `serve` from `@hono/node-server`, `createServer` + `getServerPort` from `@devvit/web/server`. Register Hono routers for `/internal/menu`, `/internal/form`, `/internal/trigger` (singular — note this differs from the template's plural `/internal/triggers/`), and `/api`. Each child router imported from `src/server/routes/<name>.ts` exposes leaf POST routes for `/claim`, `/combo-picker`, `/soft-warning-submit`, `/combo-picker-submit`, `/combo-editor-submit`, `/app-install`, `/post-delete`, `/comment-delete`, plus `GET /feed`, `GET /metrics`, `GET /combos`, `POST /combos`, `DELETE /combos/:name`, `GET /claims`, `POST /dev/seed`. Each handler is a stub returning `c.json({ ok: true })` for now — full implementations come in later tasks. Scrub-on-read happens inside `readFeed` (task 9.2), not via a trigger endpoint.
      4. Create `src/client/index.html` (minimal `<div id="root"></div>` + `<script type="module" src="./index.tsx">`), `src/client/index.tsx` (mounts React via `createRoot(document.getElementById('root')!).render(<App />)`), `src/client/App.tsx` exporting a placeholder `<div>ModSync</div>` component. The `@devvit/start/vite` plugin auto-resolves `post.entrypoints.default.entry: "index.html"` against `src/client/` first.
      5. Add npm deps: `react`, `react-dom` (runtime). Add devDeps: `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `vitest`, `fast-check` (vitest+fast-check fully wired in task 1.3).
      6. Update `vite.config.ts` to compose `devvit()` plugin with `@vitejs/plugin-react` (the `devvit()` plugin's `opts.client` field merges into the client environment config).
      7. Single `tsconfig.json` works (template's existing one with `composite: true`). DO NOT split into `tsconfig.client.json` / `tsconfig.server.json` — the `@devvit/start` plugin uses Vite's environment API to keep client/server bundles separate without requiring separate tsconfigs.
    - **Acceptance signal**: `npm install` succeeds; `npm run type-check` (`tsc --build`) exits 0; `npm run build` (`vite build`) exits 0 producing `dist/server/index.cjs` AND `dist/client/index.html` + `dist/client/index.js`. `dist/server/index.cjs` is a CJS bundle (`node -e "require('./dist/server/index.cjs')"` either succeeds or fails with a runtime error referencing missing Devvit context, NOT with `SyntaxError: Cannot use import statement outside a module`).
    - **PBT validates**: none (scaffold)
    - **Priority**: P0
    - **Estimate**: 50 min

  - [x] 1.2 Configure Devvit permissions, menu, forms, triggers, and app settings
    - **Files**: `devvit.json`
    - Match the `devvit.json` schema (https://developers.reddit.com/schema/config-file.v1.json). Required fields and structure per design.md "Schema notes":
      - `$schema`: `"https://developers.reddit.com/schema/config-file.v1.json"`
      - `name`: `"modsync-set"` (the app slug locked in by the user via `developers.reddit.com/new`; cannot be renamed after first `devvit upload`. The brand name in copy/UI/docs remains "ModSync"; only this internal slug is `modsync-set`.)
      - `post.dir`: `"dist/client"`; `post.entrypoints.default`: `{ entry: "index.html", height: "tall" }` — there is NO `customPost` field in the schema
      - `server`: `{ "dir": "dist/server", "entry": "index.cjs" }` — split `dir`+`entry` form (the `@devvit/start/vite` plugin emits `dist/server/index.cjs` as **CommonJS** automatically; both forms are accepted by the schema, this matches what the template ships with)
      - `permissions.reddit`: `{ enable: true, scope: "moderator" }` (CHANGE from template's bare `true`)
      - `permissions.redis`: `true` (boolean, NOT object — ADD)
      - `permissions.realtime`: `true` (boolean, NOT object — ADD)
      - `menu.items`: 2 items — `Claim for review` and `Run combo…`, both `forUserType: "moderator"`, `location: ["post", "comment"]`, pointing at `/internal/menu/claim` and `/internal/menu/combo-picker` (REPLACE template's mop items)
      - `forms`: 3 named forms — `softWarningForm` → `/internal/form/soft-warning-submit`, `comboPickerForm` → `/internal/form/combo-picker-submit`, `comboEditorForm` → `/internal/form/combo-editor-submit` (REPLACE template's mopComment/mopPost)
      - `triggers`: 3 events — `onAppInstall` → `/internal/trigger/app-install`, `onPostDelete` → `/internal/trigger/post-delete`, `onCommentDelete` → `/internal/trigger/comment-delete` (note: `/internal/trigger/` SINGULAR; template ships `/internal/triggers/` plural — fix in 1.1). Devvit does not expose an `onAccountDelete` trigger; deleted-account scrubbing happens on read — see task 9.2.
      - `marketingAssets.icon`: `"assets/icon.png"` (1024x1024 PNG required for App Directory listing — actual asset added in 10.x)
      - `scripts.dev`: `"vite build --watch"` (template default — keep)
      - `scripts.build`: `"vite build"` (NO esbuild — the `@devvit/start/vite` plugin handles both client AND server builds in a single `vite build` invocation, emitting `dist/server/index.cjs` as CJS automatically)
      - `dev.subreddit`: `"Modsynnow"` (the user's actual public test subreddit at https://www.reddit.com/r/Modsynnow/, owned by their currently-logged-in Reddit account. Verified public via Reddit's about.json endpoint. Note: subreddit names use mixed case for display but Reddit's API normalizes them — the canonical display name is `Modsynnow`. Can be overridden by `DEVVIT_SUBREDDIT` env var.)
    - **Acceptance signal**: `npm run build` exits 0; loading `devvit.json` and running `JSON.parse` returns an object containing: `name === "modsync-set"`, `post.entrypoints.default.entry === "index.html"`, `server.entry === "index.cjs"`, `server.dir === "dist/server"`, `menu.items.length === 2`, `Object.keys(forms).length === 3`, `Object.keys(triggers).length === 3`, `permissions.redis === true`, `permissions.realtime === true`, `permissions.reddit.scope === "moderator"`. `tests/devvitJson.spec.ts` (added in 6.3) validates this assertion programmatically.
    - **PBT validates**: none (config)
    - **Priority**: P0
    - **Estimate**: 20 min

  - [x] 1.3 Wire vitest + fast-check
    - **Files**: `package.json` (add devDeps + scripts), `vitest.config.ts`, `tests/_setup.ts`, `tests/sanity.spec.ts`
    - Install `vitest`, `fast-check`, `@vitest/coverage-v8`, `ulid`, `@types/node`
    - `package.json` scripts: `"test": "vitest --run"`, `"test:watch": "vitest"`
    - `vitest.config.ts`: node environment for server, jsdom for `src/client/**`, alias `@shared` -> `src/shared`
    - `tests/sanity.spec.ts`: trivial fast-check property `forall n:int. n + 0 === n` (≥100 runs) to confirm wiring
    - **Acceptance signal**: `npm test` exits 0 and reports 1 passing test
    - **PBT validates**: none (test infra)
    - **Priority**: P0
    - **Estimate**: 15 min

  - [x] 1.4 Add CI-friendly build script
    - **Files**: `package.json`
    - Confirm/add three npm scripts in `package.json` (template already has `build` and `type-check` — confirm they match the spec; add `lint` if missing):
      - `"build": "vite build"` — single command. The `@devvit/start/vite` plugin builds BOTH the client (`dist/client/`) and server (`dist/server/index.cjs` as CJS via rollup with `inlineDynamicImports: true`, `target: 'node22'`, minified) in one invocation. NO esbuild step. Verified by reading `node_modules/@devvit/start/vite/index.js`.
      - `"type-check": "tsc --build"` (template default — keep)
      - `"lint": "eslint 'src/**/*.{ts,tsx}'"` (template default — keep)
    - **Acceptance signal**: `npm run build` exits 0 with no warnings; `dist/client/index.html` exists and references the bundled JS; `dist/server/index.cjs` exists and is a CommonJS module (verify with `node -e "require('./dist/server/index.cjs')"` — succeeds OR fails with a Devvit-runtime-context error, NOT with `SyntaxError: Cannot use import statement outside a module`). `npm run type-check` exits 0. `npm run lint` exits 0.
    - **PBT validates**: none
    - **Priority**: P0
    - **Estimate**: 10 min

- [x] 2. Core types and storage primitives
  - [x] 2.1 Implement shared TypeScript types
    - **Files**: `src/shared/types.ts`
    - Export exactly: `ThingId`, `ClaimRecord`, `StepKind`, `ComboStep`, `ComboSpec`, `ActionEntry`, `RealtimeEvent`, `MetricsBucket` per `design.md` "TypeScript types"
    - Export `MAX_FEED_ENTRIES = 500`, `CLAIM_TTL_SEC = 90`, `MAX_COMBOS = 50`, `COMBO_NAME_REGEX = /^[a-z0-9-_ ]{1,40}$/i`
    - **Acceptance signal**: `npx tsc --noEmit` exits 0; `import { ClaimRecord, ComboSpec, RealtimeEvent } from "@shared/types"` resolves from both server and client tsconfigs
    - **PBT validates**: none (type-only)
    - **Priority**: P0
    - **Estimate**: 20 min

  - [x] 2.2 Implement Redis key builders + ISO week derivation
    - **Files**: `src/server/redisKeys.ts`, `tests/redisKeys.spec.ts`
    - Export: `claimKey(sub, thingId): string`, `actionsKey(sub): string`, `combosKey(sub): string`, `metricsKey(sub, isoWeek): string`, `isoWeekKey(d: Date): string` (matches the formula in design.md)
    - **PBT** (fast-check, ≥200 runs): `forall date in 2000..2100. isoWeekKey(date)` returns `YYYY-Www` matching `/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/`; cross-check against a known table for the year-boundary cases listed in ISO 8601 (2004-01-01 → 2004-W01, 2005-01-01 → 2004-W53, 2007-12-31 → 2008-W01, 2020-01-01 → 2020-W01, 2021-01-01 → 2020-W53)
    - **Acceptance signal**: `npm test -- redisKeys` exits 0 with at least 6 passing cases including 5 ISO-boundary examples and 1 ≥200-iteration property
    - **PBT validates**: supports Property 9 (week-key correctness)
    - **Priority**: P0
    - **Estimate**: 30 min

- [x] 3. Auth gate
  - [x] 3.1 Implement `requireMod` and stub-driven test
    - **Files**: `src/server/auth.ts`, `tests/auth.spec.ts`
    - Export `requireMod(ctx, deps): Promise<{ user: string, sub: string }>`; throws `ForbiddenError` (export from same file) when the current user is not a moderator of the current subreddit. Lookup flow:
      1. `user = await deps.reddit.getCurrentUser()` (throws on missing identity)
      2. Read-through cache: `if await deps.redis.hExists(\`mods:${sub}\`, user) && await deps.redis.exists(\`mods-expiry:${sub}\`)` → return `{ user, sub }`
      3. On miss: `mods = await deps.reddit.getModerators(sub)`; for each moderator name `m` call `deps.redis.hSet(\`mods:${sub}\`, m, '1')`; then `deps.redis.set(\`mods-expiry:${sub}\`, '1', { ex: 300 })`
      4. Re-check membership against the freshly-populated hash; throw `ForbiddenError` if absent.
    - Test against an injectable `RedditClient` interface with stubs for `getCurrentUser` and `getModerators` (no real Reddit calls)
    - **PBT** (fast-check, ≥100 runs):
      - **Property 10 (basic gate)**: `forall (user, modList). requireMod returns iff user in modList; throws otherwise`; assert zero Redis writes and zero realtime publishes happen on the throw path (use a recording fake)
      - **Cache hit avoids Reddit API**: `forall (user, mods) where user ∈ mods AND mods:{sub} HAS user AND mods-expiry:{sub} EXISTS. requireMod returns and the redditClient is called 0 times`
    - **Acceptance signal**: `npm test -- auth` exits 0; throw path verified with a recording fake that asserts no side effects
    - **PBT validates**: Property 10
    - **Priority**: P0
    - **Estimate**: 35 min

- [ ] 4. Claim subsystem (P0 floor)
  - [x] 4.1 Implement claims module
    - **Files**: `src/server/claims.ts`, `tests/claims.spec.ts`, `tests/_fakes/redisFake.ts` (in-memory Redis with TTL + LIST + HASH + sorted-set support) (redisFake supports `hExists`, `hSet`, `set`/`exists` with TTL — required for `requireMod` cache lookups in 3.1 and warm-fill in 9.3)
    - Export: `claim(sub, thingId, mod): Promise<ClaimRecord>`, `release(sub, thingId, reason): Promise<void>`, `refresh(sub, thingId, mod): Promise<ClaimRecord>`, `getClaim(sub, thingId): Promise<(ClaimRecord & { ttlSec: number }) | null>`, `listActiveClaims(sub): Promise<Record<ThingId, ClaimRecord & { ttlSec: number }>>` (capped at 200)
    - All writes go through injected `redis` and `realtime` clients (no globals); each successful claim/release publishes exactly one event
    - **Active-claims index** (Devvit Redis does not support SCAN): `claim()` MUST also `zAdd claims-index:{sub} { score: now + 90000, member: thingId }` on every write (so re-claims/refreshes update the score). `release()` MUST also `zRem claims-index:{sub} thingId`. `listActiveClaims()` MUST use `zRangeByScore claims-index:{sub} now +inf` to enumerate active members, then `GET claims:{sub}:{thingId}` for each. (The sorted-set score is the absolute expiry instant, so expired entries are filtered out by the score lower-bound.)
    - **PBT** (fast-check, ≥100 runs each):
      - **Property 1**: `forall (sub, thing, mod). after claim(): getClaim() returns { moderator: mod, claimedAt within 1s of now, ttlSec in (0, 90] } AND claims-index:{sub} contains thingId with score ≈ now + 90000ms (within 1s tolerance)`
      - **Property 2**: `forall sequence of claim/release. for each call exactly one realtime event is published whose payload equals the resulting Redis state (or deleted state for release)`
      - **Property 4**: `forall thingId. after a successful release: getClaim() === null AND claims-index:{sub} does not contain thingId`; `forall (mod, thingId, t1<t2). claim at t1 then refresh at t2 yields claimedAt2 > claimedAt1 and ttlSec ≈ 90 and the index score for thingId is updated to t2 + 90000ms`
    - **Acceptance signal**: `npm test -- claims` exits 0 with all three properties passing ≥100 iterations
    - **PBT validates**: Properties 1, 2, 4
    - **Priority**: P0
    - **Estimate**: 70 min

  - [x] 4.2 Implement claim menu endpoint with foreign-claim detection
    - **Files**: `src/server/menu/claimHandler.ts`, `tests/claimHandler.spec.ts`
    - Export `onClaimMenu(ctx, body): Promise<UiResponse>` matching the algorithm in design.md "Claim handler algorithm"
    - Accepts injected `claims`, `metrics`, `auth` so the test can drive both branches without a real Devvit runtime
    - Branches:
      - no foreign claim → write claim + publish, no metric bumps, return `UiResponse { showToast: "Claimed" }`
      - foreign claim → bump `softWarningsShown`, do NOT write claim or publish, return `UiResponse { showForm: { name: "softWarningForm", form: { fields: [warningTextField], acceptLabel: "Claim anyway", cancelLabel: "Cancel" }, data: { kind: "claim", thingId } } }`
    - **PBT** (fast-check, ≥100 runs):
      - **Property 3 (no-foreign-claim path)**: `forall (currentMod, thingId) with no existing claim. after onClaimMenu returns: claim key holds { moderator: currentMod, ttlSec ≈ 90 } and exactly one claim event was published`
      - **Property 9 (form-shown increment)**: `forall existing foreign claim. exactly one HINCRBY against softWarningsShown occurs and the response is UiResponse { showForm: ... data: { kind: "claim", thingId } }; no claim write, no realtime publish`
    - **Acceptance signal**: `npm test -- claimHandler` exits 0; recording fake confirms no claim write and no publish on the foreign-claim branch
    - **PBT validates**: Properties 3 (no-foreign-claim path), 9 (softWarningsShown increment)
    - **Priority**: P0
    - **Estimate**: 50 min

  - [x] 4.2b Implement softWarningSubmit form endpoint
    - **Files**: `src/server/forms/softWarningSubmit.ts`, `tests/softWarningSubmit.spec.ts`
    - Export `onSoftWarningSubmit(ctx, body): Promise<UiResponse>`. Reads `{ kind, thingId, comboName? }` from `body.data` and `{ proceed }` from `body.values`; runs `requireMod`; then routes:
      - `proceed === true` AND `kind === "claim"` → `HINCRBY collisionsDetected 1`, write claim, publish claim event, return `UiResponse { showToast: "Claimed (override)" }`
      - `proceed === true` AND `kind === "combo"` → `HINCRBY collisionsDetected 1`, lookup combo via `HGET combos:{sub} comboName` (404 toast if missing), write claim, publish claim event, await `runCombo(thingId, combo, user, sub)`, return `UiResponse { showToast: "Combo complete" }`
      - `proceed === false` → `HINCRBY redundantActionsAvoided 1`, no Redis writes beyond the counter, no claim publish, return `UiResponse { showToast: "Cancelled" }`
    - Accepts injected `claims`, `combos`, `executor`, `metrics`, `auth` so the test can drive every branch without a real Devvit runtime
    - **PBT** (fast-check, ≥100 runs):
      - **Property 9 (counter routing)**: `forall (kind, proceed) ∈ {(claim,true),(claim,false),(combo,true),(combo,false)}. exactly the expected counter set is incremented exactly once each (collisionsDetected on proceed=true, redundantActionsAvoided on proceed=false); softWarningsShown is NEVER incremented here (it was already bumped by 4.2 / 8.3a)`
      - **Property 3 (combo branch)**: `forall (combo kind, proceed=true). after the handler returns the claim key holds { moderator: currentMod, ttlSec ≈ 90 } AND runCombo was invoked exactly once with the matching ComboSpec`
    - **Acceptance signal**: `npm test -- softWarningSubmit` exits 0; recording fake confirms counter routing for all four (kind, proceed) combinations
    - **PBT validates**: Property 9 (counter routing), Property 3 (combo branch on override)
    - **Priority**: P0
    - **Estimate**: 50 min

  - [x] 4.3 Wire realtime publish layer + sub-1s integration check
    - **Files**: `src/server/realtime.ts`, `tests/realtime.spec.ts`
    - Export `publishClaim(sub, event)`, `publishAction(sub, event)`, `subscribeClaims(sub, handler)`, `subscribeActions(sub, handler)`; thin wrapper around `Devvit.realtime` that JSON-encodes payloads
    - Channel name pattern: `claims-{sub}` / `actions-{sub}`. Devvit Realtime explicitly forbids `:` in channel names; Redis KEY paths keep `:`.
    - Integration test using a fake realtime broker: publish a `claim` event, assert subscribed handler receives an exactly-equal payload within ≤1000ms (use deterministic clock; this validates the contract, not Devvit network)
    - **PBT** (fast-check, ≥100 runs): `forall RealtimeEvent. publish(e) then subscribe handler receives e' with deepEqual(e, e')`
    - **Acceptance signal**: `npm test -- realtime` exits 0; latency assertion passes
    - **PBT validates**: supports Properties 2, 6
    - **Priority**: P0
    - **Estimate**: 40 min

- [x] 5. Metrics subsystem (P0 floor)
  - [x] 5.1 Implement metrics module
    - **Files**: `src/server/metrics.ts`, `tests/metrics.spec.ts`
    - Export: `bumpMetric(sub, kind: "softWarning" | "collision" | "redundantAvoided"): Promise<void>`, `getMetrics(sub, period: "week" | "month"): Promise<MetricsBucket & { period, periodKey }>`
    - `bumpMetric` MUST do exactly one `HINCRBY` against `metrics:{sub}:{isoWeekKey(now)}` on the field that maps to the kind (softWarning -> `softWarningsShown`, collision -> `collisionsDetected`, redundantAvoided -> `redundantActionsAvoided`)
    - `getMetrics` for `period: "month"` aggregates the (up to 5) ISO weeks overlapping the current calendar month
    - **PBT** (fast-check, ≥100 runs):
      - **Property 9 (full)**: `forall random sequence of kind events at instants t_i. for each event exactly one HINCRBY occurs against metrics:{sub}:{isoWeekKey(t_i)}.{counterFor(kind)}; final hash totals equal counts grouped by (week, kind)`
      - **Property 9 (zero-state)**: `forall sub with no metric keys. getMetrics returns { softWarningsShown: 0, collisionsDetected: 0, redundantActionsAvoided: 0 } without throwing`
    - **Acceptance signal**: `npm test -- metrics` exits 0 with both Property 9 facets passing ≥100 iterations
    - **PBT validates**: Property 9
    - **Priority**: P0
    - **Estimate**: 45 min

  - [x] 5.2 Implement `/api/metrics` endpoint
    - **Files**: `src/server/routes/metrics.ts`, `tests/routes.metrics.spec.ts`
    - Export `register(router)` which wires `GET /api/metrics?period=week|month`; runs `requireMod` first; returns `MetricsBucket & { period, periodKey }`
    - Test with the in-memory redis fake + auth fake; verify 403 when non-mod, 200 with empty bucket when no data, correct aggregation when data present
    - **PBT** (fast-check, ≥100 runs): `forall (mod, periodKey). endpoint output deepEquals getMetrics(sub, period)` (router is a thin wrapper)
    - **Acceptance signal**: `npm test -- routes.metrics` exits 0; 403 path verified with zero Redis reads
    - **PBT validates**: Properties 9, 10
    - **Priority**: P0
    - **Estimate**: 25 min

- [x] 6. Webview app shell + soft-warning form (P0 floor)
  - [x] 6.1 Implement App.tsx tab router and initial fetch
    - **Files**: `src/client/App.tsx`, `src/client/api.ts`, `src/client/types.ts` (re-export from `@shared/types`)
    - `App` MUST: render `<Tabs value={tab} onChange={setTab}>` with three children `<ActivityFeed>`, `<MetricsDashboard>`, `<ComboConfig>` (placeholders allowed for tabs implemented later); during initial render call `Promise.all([api.getFeed(), api.getMetrics(), api.getCombos(), api.getClaims()])` and store in state
    - `src/client/api.ts` MUST export typed `getFeed`, `getMetrics`, `getCombos`, `getClaims`, `saveCombo`, `deleteCombo`, `seed` thin fetch wrappers
    - The soft-warning prompt is rendered by Reddit as a Devvit Form (declared in `devvit.json`), not by the webview — no dialog component is mounted in `App.tsx`
    - **Acceptance signal**: `npm run build` exits 0; `npm test -- App` (renders without throwing under jsdom + mocked fetch returning empty arrays) passes; initial render fires exactly 4 parallel fetches
    - **PBT validates**: none (UI shell)
    - **Priority**: P0
    - **Estimate**: 50 min

  - [x] 6.2 Implement realtime hook with backoff + resync
    - **Files**: `src/client/realtime.ts`, `tests/client.realtime.spec.ts`
    - Export `useRealtime<T>(channel: string, onEvent: (e: T) => void): { connected: boolean }`; reconnection backoff `250ms -> 500 -> 1000 -> 2000 -> 4000` capped at 4s; on reconnect, call optional `onResync` (so consumer can refetch `/api/claims` + `/api/feed`)
    - **PBT** (fast-check, ≥100 runs): `forall sequence of disconnect/reconnect events. backoff schedule is monotonic non-decreasing and capped at 4000ms; onResync fires exactly once per successful reconnect`
    - **Acceptance signal**: `npm test -- client.realtime` exits 0
    - **PBT validates**: supports the resync side of Property 8
    - **Priority**: P0
    - **Estimate**: 45 min

  - [x] 6.3 Define soft-warning form in devvit.json and validate the form-rendering contract
    - **Files**: `devvit.json` (extend the `forms` block created in 1.2 — confirm `softWarningForm`, `comboPickerForm`, `comboEditorForm` are present and each maps to its endpoint), `tests/devvitJson.spec.ts`
    - The soft-warning prompt is a Devvit Form rendered by Reddit, not a React component. The form is declared once in `devvit.json` and its submit endpoint (4.2b) reads `{ proceed }` from values plus `{ kind, thingId, comboName? }` from data. No webview-side rendering is needed.
    - `tests/devvitJson.spec.ts`: load `devvit.json`, parse it, and assert as one example test:
      - `forms.softWarningForm === "/internal/form/soft-warning-submit"`
      - `forms.comboPickerForm === "/internal/form/combo-picker-submit"`
      - `forms.comboEditorForm === "/internal/form/combo-editor-submit"`
      - every form endpoint string is also present in the route list registered by `src/server/main.ts` (read main.ts via fs and grep for the path)
      - the four trigger endpoints in `triggers` likewise each appear in `main.ts`
      - the two menu endpoints in `menu.items` likewise each appear in `main.ts`
    - **Acceptance signal**: `npm test -- devvitJson` exits 0
    - **PBT validates**: none (config validation; supports Property 3 contract by ensuring the form-routing wiring is intact)
    - **Priority**: P0
    - **Estimate**: 25 min

  - [x] 6.4 Implement Metrics Dashboard tab with empty-state
    - **Files**: `src/client/tabs/MetricsDashboard.tsx`, `tests/MetricsDashboard.spec.tsx`
    - Props: `{ metrics: MetricsBucket & { period, periodKey } }`; renders three counters (Soft warnings shown / Collisions detected / Redundant actions avoided) for current week and current month; on a `metrics` object whose three counters are all 0 it renders an empty-state message "No collision events recorded yet for this period."
    - Refetch on tab focus via `useEffect`
    - **PBT** (fast-check, ≥100 runs): `forall MetricsBucket b. component renders three numeric values that exactly equal b.softWarningsShown, b.collisionsDetected, b.redundantActionsAvoided`; with an all-zero bucket the empty-state copy appears
    - **Acceptance signal**: `npm test -- MetricsDashboard` exits 0
    - **PBT validates**: supports Property 9 (zero-state UX)
    - **Priority**: P0
    - **Estimate**: 35 min

- [x] 7. Activity feed (P1)
  - [x] 7.1 Implement feed module
    - **Files**: `src/server/feed.ts`, `tests/feed.spec.ts`
    - Devvit Redis does NOT support LIST operations. Use sorted-set operations exclusively.
    - Export:
      - `appendAction(sub, entry: ActionEntry): Promise<void>` — `await redis.zAdd(\`actions:${sub}\`, { score: entry.ts, member: JSON.stringify(entry) }); await redis.zRemRangeByRank(\`actions:${sub}\`, 0, -501); // keep newest 500 by score`
      - `readFeed(sub, limit = 50): Promise<ActionEntry[]>` — `await redis.zRange(\`actions:${sub}\`, 0, limit - 1, { by: 'score', rev: true })` then JSON.parse each member; pipe each entry through `scrubEntry(sub, entry)` from `src/server/scrub.ts` (added in task 9.2) before returning
      - `purgeByThingId(sub, thingId): Promise<number>` — `zRange` to enumerate, JSON.parse, filter by thingId, `zRem` matching members. Returns count of removed entries. Preserves order of kept entries by NOT rewriting their scores.
    - `scrubModerator` is no longer exported — scrubbing happens on read via `src/server/scrub.ts` (task 9.2).
    - **PBT** (fast-check, ≥100 runs):
      - **Property 8 (server half)**: `forall sequence of appendAction calls with timestamps t_1..t_n. readFeed(500) returns entries ordered by score-descending (i.e. non-increasing ts) and length min(n, 500); the (n+1)-th append correctly evicts the lowest-scored entry`
    - **Acceptance signal**: `npm test -- feed` exits 0
    - **PBT validates**: Property 8 (server half)
    - **Priority**: P1
    - **Estimate**: 50 min

  - [x] 7.2 Implement `/api/feed` endpoint
    - **Files**: `src/server/routes/feed.ts`, `tests/routes.feed.spec.ts`
    - Export `register(router)`; wires `GET /api/feed?limit=50`; runs `requireMod`; default limit 50, max 500; returns `ActionEntry[]`
    - **PBT** (fast-check, ≥100 runs): `forall limit in [1, 500]. response.length === min(actualEntries, limit) and every element passes ActionEntry shape check`
    - **Acceptance signal**: `npm test -- routes.feed` exits 0; 403 path verified with zero Redis reads
    - **PBT validates**: Properties 8, 10
    - **Priority**: P1
    - **Estimate**: 20 min

  - [x] 7.3 Implement Activity Feed tab with prepend dedupe
    - **Files**: `src/client/tabs/ActivityFeed.tsx`, `tests/ActivityFeed.spec.tsx`
    - Props: `{ feed: ActionEntry[], claims: Record<ThingId, ClaimRecord & { ttlSec: number }> }`; renders entries in order; for each entry: moderator, comboName (or "Claim"), thingId link to `https://reddit.com/{thingId}`, relative timestamp, "(failed at step N)" badge when `failedStepIndex !== undefined`
    - On incoming realtime `action` event: prepend if `entry.id` not already in list, slice to 500
    - **PBT** (fast-check, ≥100 runs):
      - **Property 8 (client half)**: `forall existingFeed and incoming event e. resulting feed[0].id === e.entry.id (or unchanged if duplicate id) and length ≤ 500`
    - **Acceptance signal**: `npm test -- ActivityFeed` exits 0
    - **PBT validates**: Property 8 (client half)
    - **Priority**: P1
    - **Estimate**: 45 min

- [ ] 8. Combos (P1)
  - [x] 8.1 Implement combos module + validator
    - **Files**: `src/server/combos.ts`, `tests/combos.spec.ts`
    - Export: `validateCombo(spec: unknown, existingNames: string[]): { ok: true, value: ComboSpec } | { ok: false, message: string }`, `saveCombo(sub, spec): Promise<ComboSpec>`, `deleteCombo(sub, name): Promise<void>`, `listCombos(sub): Promise<ComboSpec[]>`
    - Validator rules:
      - `name` matches `COMBO_NAME_REGEX`
      - `name` not in `existingNames` for create (allowed for update)
      - `steps.length >= 1` AND `steps.length <= 10` (upper bound enforces design.md's combo-step cap so that a 4-step combo at 300ms/step ~= 1.2s fits well under the 30s Devvit Web request limit)
      - each step matches `ComboStep` discriminated union
      - For step kind `MODNOTE`: `text.length <= 1000` (design.md MODNOTE comment; keeps payloads under the 4MB Devvit Web request limit even with 50 combos)
      - For step kind `BAN`: `days >= 0` AND `days <= 999` (Reddit ban duration accepts 0 = permanent up to 999 days max)
      - For step kind `MODNOTE`: `label` is one of `"ABUSE_WARNING"`, `"SPAM_WARNING"`, `"HELPFUL_USER"`, `"OTHER"` if present
      - Total combos in sub ≤ 50 (`MAX_COMBOS` from `@shared/types`)
    - **PBT** (fast-check, ≥200 runs):
      - **Property 7 (validator)**: `forall arbitrary candidate. validator accepts iff (name unique AND steps.length ∈ [1, 10] AND each step well-formed AND every MODNOTE.text.length ≤ 1000 AND every BAN.days ∈ [0, 999])`; use a generator that biases toward edge cases (empty steps, dup names, oversize names, 11-step combos, 1001-char MODNOTE text, 1000-day BAN).
      - **Property 7 (CRUD round-trip)**: `forall random sequence of save/edit/delete operations. listCombos result equals the model state computed by replaying the operations in memory`
    - **Acceptance signal**: `npm test -- combos` exits 0 with both Property 7 facets passing ≥200 iterations
    - **PBT validates**: Property 7
    - **Priority**: P1
    - **Estimate**: 55 min

  - [x] 8.2 Implement `/api/combos` GET/POST/DELETE endpoints
    - **Files**: `src/server/routes/combos.ts`, `tests/routes.combos.spec.ts`
    - Export `register(router)`; wires `GET /api/combos`, `POST /api/combos` (body: `ComboSpec`), `DELETE /api/combos/:name`; all run `requireMod`. No menu-item re-registration is needed — the combo picker (8.3a) re-reads `HKEYS combos:{sub}` on every invocation, so a newly saved combo appears in the picker's select options on the next click without any cache or manifest update.
    - On validator failure return 400 with the validator's message; on success return 200 with the persisted spec or `{ ok: true }`
    - **PBT** (fast-check, ≥100 runs): `forall (validSpec | invalidSpec). status code matches validator outcome; on success listCombos contains the spec; on 4xx/403 listCombos is unchanged`
    - **Acceptance signal**: `npm test -- routes.combos` exits 0; 403 + 400 paths verified
    - **PBT validates**: Properties 7, 10
    - **Priority**: P1
    - **Estimate**: 30 min

  - [x] 8.3a Implement combo-picker menu endpoint
    - **Files**: `src/server/menu/comboPicker.ts`, `tests/comboPicker.spec.ts`
    - Export `onComboPickerMenu(ctx, body): Promise<UiResponse>` matching the algorithm in design.md "Combo Picker Flow": `requireMod`, `HKEYS combos:{sub}` to load current combo names, return:
      ```
      UiResponse {
        showForm: {
          name: "comboPickerForm",
          form: {
            title: "Run combo",
            fields: [{ name: "comboName", type: "select", label: "Combo",
                       options: comboNames.map(n => ({ value: n, label: n })) }],
            acceptLabel: "Run"
          },
          data: { thingId }
        }
      }
      ```
    - When `combos:{sub}` is empty, return `UiResponse { showToast: "No combos configured. Visit ModSync settings to add one." }` instead of an empty-options form
    - Accepts injected `combos`, `auth` so the test can drive every branch without a real Devvit runtime
    - **PBT** (fast-check, ≥100 runs):
      - **Property 7 (combo list freshness)**: `forall (existingCombos, newCombo). after saveCombo(newCombo), the next onComboPickerMenu call returns a form whose select options include newCombo.name (asserted via timeline; satisfies the 5-second freshness clause from Requirements 1.4 / 6.3 by construction since the picker re-reads HKEYS on every invocation)`
      - **Property 10 (mod gate)**: non-mod invocation throws `ForbiddenError` and performs zero Redis reads
    - **Acceptance signal**: `npm test -- comboPicker` exits 0; freshness timeline asserts the new combo appears within the next picker invocation
    - **PBT validates**: Property 7 (freshness), Property 10 (mod gate)
    - **Priority**: P1
    - **Estimate**: 35 min

  - [x] 8.3b Implement combo-picker-submit form endpoint
    - **Files**: `src/server/forms/comboPickerSubmit.ts`, `tests/comboPickerSubmit.spec.ts`
    - Export `onComboPickerSubmit(ctx, body): Promise<UiResponse>`. Reads `{ comboName }` from `body.values` and `{ thingId }` from `body.data`; runs `requireMod`; then:
      - lookup combo via `HGET combos:{sub} comboName` — if missing, return `UiResponse { showToast: "Combo not found" }` (404 toast)
      - check existing claim: if `existing.moderator !== currentMod`, `HINCRBY softWarningsShown 1` and return `UiResponse { showForm: { name: "softWarningForm", form: { fields: [warningTextField], acceptLabel: "Run anyway", cancelLabel: "Cancel" }, data: { kind: "combo", thingId, comboName } } }` — DO NOT write claim or run combo on this branch
      - otherwise write claim, publish claim event, await `runCombo(thingId, combo, currentMod, sub)`, return `UiResponse { showToast: "Combo complete" }`
    - Accepts injected `claims`, `combos`, `executor`, `metrics`, `auth`
    - **PBT** (fast-check, ≥100 runs):
      - **Property 3 (combo branch claim invariant)**: `forall (existing, currentMod, comboName) with no foreign claim. after onComboPickerSubmit returns, the claim key holds { moderator: currentMod, ttlSec ≈ 90 } AND runCombo was invoked exactly once with the matching ComboSpec`
      - **Property 9 (counter routing)**: three branches asserted via recording metrics fake — none (no foreign claim) → no counter changes; foreign claim form-shown → exactly one HINCRBY against softWarningsShown; missing combo → no counter changes
    - **Acceptance signal**: `npm test -- comboPickerSubmit` exits 0; recording dispatch fake confirms `runCombo` is invoked iff branch ∈ {none}
    - **PBT validates**: Properties 3 (combo branch), 9 (counter routing)
    - **Priority**: P1
    - **Estimate**: 50 min

  - [x] 8.4 Implement combo executor
    - **Files**: `src/server/executor.ts`, `tests/executor.spec.ts`, `tests/_fakes/redditFake.ts`
    - Export `runCombo(thingId, combo, mod, sub, deps): Promise<ActionEntry>` matching the algorithm in design.md "Combo Execution Engine"; before each step refresh the claim TTL; on step failure record `failedStepIndex` + `failureMessage`, stop; afterwards `zAdd actions:{sub}` with score `entry.ts` and JSON-encoded member, `zRemRangeByRank actions:{sub} 0 -501` to enforce the 500-entry cap, publish `action` event to channel `actions-{sub}`, `DEL` claim key, publish `release` event to channel `claims-{sub}`
    - Export `dispatch(step, thingId, mod, redditClient): Promise<void>` matching the switch in design.md
    - Use injectable `redis`, `realtime`, `redditClient` interfaces; `tests/_fakes/redditFake.ts` records every call with args
    - **PBT** (fast-check, ≥200 runs):
      - **Property 5**: `forall (combo, failureIndex i in [0, steps.length]). entry.ranSteps === combo.steps.slice(0, i); each ranStep[k] produced exactly the redditFake call matching its kind (REMOVE -> remove, BAN -> banUser with right args, etc.); on failure entry.failedStepIndex === i and entry.failureMessage is non-empty`
      - **Property 6**: `forall combo run. exactly one zAdd to actions:{sub} occurred AND exactly one zRemRangeByRank invocation kept the cap AND exactly one publish to actions-{sub} channel occurred AND publishedEvent.entry deepEquals the persisted entry`
    - **Acceptance signal**: `npm test -- executor` exits 0 with both Properties 5, 6 passing ≥200 iterations
    - **PBT validates**: Properties 5, 6
    - **Priority**: P1
    - **Estimate**: 70 min

  - [x] 8.5 Implement Combo Config tab CRUD UI
    - **Files**: `src/client/tabs/ComboConfig.tsx`, `tests/ComboConfig.spec.tsx`
    - Props: `{ combos: ComboSpec[], canEdit: boolean }`; lists combos, supports add/edit/delete forms (mod-only via `canEdit`), step builder for each `StepKind`
    - Validation: client-side `validateCombo` mirror produces inline error messages identical to the server's; submit goes through `api.saveCombo` / `api.deleteCombo`
    - **PBT** (fast-check, ≥100 runs): `forall ComboSpec candidate. UI submit button is disabled iff client-side validator rejects; on canEdit=false the form controls are not rendered`
    - **Acceptance signal**: `npm test -- ComboConfig` exits 0; component renders empty state, single-combo state, max-combo state without throwing
    - **PBT validates**: supports Property 7 (UI parity with validator), Property 10 (mod-only edit)
    - **Priority**: P1
    - **Estimate**: 55 min

  - [x] 8.6 Seed two default combos on first install
    - **Files**: `src/server/seed/defaults.ts`, `tests/seed.defaults.spec.ts`
    - Export `seedDefaultCombos(sub): Promise<void>` (idempotent; uses `SETNX`-style "combos:{sub}:_seeded" sentinel so second call is a no-op); seeds:
      - "Spam removal" → `[{ kind: "REMOVE" }, { kind: "BAN", days: 7, reason: "spam" }, { kind: "MODNOTE", text: "Spam — auto via ModSync", label: "SPAM_WARNING" }]`
      - "Off-topic cleanup" → `[{ kind: "REMOVE" }, { kind: "LOCK" }]`
    - Called from `Devvit.addTrigger({ event: "AppInstall" })` (or first-boot guard) registered in `src/server/main.ts` (the call site already exists from 1.1)
    - **PBT** (fast-check, ≥100 runs): `forall random call sequence with k ≥ 1 calls. listCombos(sub) contains both default combos; running seedDefaultCombos again is a no-op (combos hash byte-identical)`
    - **Acceptance signal**: `npm test -- seed.defaults` exits 0; idempotency assertion passes
    - **PBT validates**: supports Property 7 (validator round-trip on canned specs)
    - **Priority**: P1
    - **Estimate**: 25 min

- [x] 9. Deletion compliance triggers (P0 — required for Devvit Rules + Devpost approval)
  - [x] 9.1 Implement onPostDelete + onCommentDelete trigger handlers
    - **Files**: `src/server/triggers/postDelete.ts`, `src/server/triggers/commentDelete.ts`, `tests/triggers.delete.spec.ts`
    - The trigger event names in `devvit.json` are `onPostDelete` / `onCommentDelete` (camelCase), not `PostDelete` / `CommentDelete`.
    - Both endpoints share a single helper `purgeByThingId(sub, thingId)` from `src/server/feed.ts` (added in 7.1): `zRange actions:{sub}` to enumerate → JSON.parse each → filter out entries whose `thingId === t` → `zRem actions:{sub}` matching members. Preserves order of kept entries by NOT rewriting their scores. After the rewrite, `DEL claims:{sub}:{thingId}` AND `zRem claims-index:{sub} thingId` to keep the active-claims index consistent.
    - Both handlers extract `{ subreddit, thingId }` from the trigger body, run `purgeByThingId`, return `{ ok: true }`. No auth gate (Devvit invokes triggers internally).
    - Idempotency: re-running on an already-deleted thing is a no-op (filter removes 0 entries; `DEL` and `zRem` of a non-existent key/member are harmless).
    - **PBT** (fast-check, ≥100 runs):
      - **Property 11 (onPostDelete/onCommentDelete half)**: `forall pre-existing actions list and any thingId t. after the trigger handler returns: actions:{s} contains zero entries with entry.thingId === t AND the order of remaining entries is preserved AND claims:{s}:{t} does not exist AND claims-index:{s} does not contain t`
      - **Idempotency**: `forall (sub, thingId). running the handler twice yields the same final state as running it once (byte-identical actions list and claims keys)`
    - **Acceptance signal**: `npm test -- triggers.delete` exits 0; idempotency sub-test passes
    - **PBT validates**: Property 11 (onPostDelete/onCommentDelete half)
    - **Priority**: P0
    - **Estimate**: 50 min

  - [x] 9.2 Implement scrub-on-read for deleted accounts
    - **Files**: `src/server/scrub.ts`, `tests/scrub.spec.ts`
    - Devvit does not provide an `onAccountDelete` trigger and Redis is per-install-namespaced. The compliant pattern is to scrub deleted-account references on every read of the activity feed.
    - Export:
      - `isModeratorDeleted(sub, username, redditClient): Promise<boolean>` — first checks `HEXISTS deleted-mods:{sub} username`; if missing, calls `redditClient.getUserByUsername(username)` and treats `null` / `isSuspended === true` / `isDeleted === true` as deleted; on positive result, `HSET deleted-mods:{sub} username "1"` and returns `true`
      - `scrubEntry(sub, entry, redditClient): Promise<ActionEntry>` — if `await isModeratorDeleted(sub, entry.moderator, redditClient)` returns `true`, returns a clone with `entry.moderator = "[deleted]"`; otherwise returns the entry unchanged
    - Use injectable `redis` and `redditClient` so tests can drive both branches
    - **PBT** (fast-check, ≥100 runs):
      - **Property 11 (scrub semantics)**: `forall (sub, entries, deletedSet). readFeed(sub) -> entries.map(scrubEntry) replaces moderator with "[deleted]" iff entries[i].moderator ∈ deletedSet; otherwise the entry is byte-identical`
      - **Cache hit avoids API calls**: `forall (sub, username) where deleted-mods:{sub} HAS username. isModeratorDeleted returns true and the redditClient is called 0 times`
      - **Per-install isolation**: `forall (subA, subB). modifying deleted-mods:{subA} does NOT affect deleted-mods:{subB}` (sanity check given Devvit's per-install Redis namespacing)
    - **Acceptance signal**: `npm test -- scrub` exits 0 with all three Property 11 facets passing
    - **PBT validates**: Property 11
    - **Priority**: P0 (required for Devvit Rules compliance)
    - **Estimate**: 50 min

  - [x] 9.3 Implement onAppInstall trigger
    - **Files**: `src/server/triggers/appInstall.ts`, `tests/triggers.appInstall.spec.ts`
    - Handler extracts `{ subreddit }` from the trigger body (with `{ installer }` per Devvit docs), then in this order:
      1. Calls `seedDefaultCombos(subreddit)` from 8.6 (idempotent default-combo seed).
      2. Warm-fills the moderator cache: `mods = await reddit.getModerators(subreddit)`; for each `m` in mods, `await redis.hSet(\`mods:${subreddit}\`, m, '1')`; then `await redis.set(\`mods-expiry:${subreddit}\`, '1', { ex: 300 })`. This means the very first menu-action invocation after install hits the cache and avoids a cold Reddit API call.
      3. Creates the ModSync custom post for the subreddit (one per install, guarded by a sentinel key).
      Returns `{ status: 'ok' }`.
    - No `installs:set`. Devvit Redis is per-install-namespaced — there is no cross-install view to maintain.
    - Idempotent: re-running `onAppInstall` N times yields one set of default combos (`seedDefaultCombos` is already idempotent per 8.6) and one custom post (guarded by a sentinel key).
    - **PBT** (fast-check, ≥100 runs):
      - **Idempotency**: `forall sub and any N ≥ 1 calls. listCombos(sub) after N calls is byte-identical to listCombos(sub) after 1 call`
      - **Default-combo seeding**: `forall fresh sub. listCombos(sub) after the handler returns includes "Spam removal" and "Off-topic cleanup"`
      - **Cache warm-fill**: `forall fresh sub. mods:{sub} hash contains every moderator returned by reddit.getModerators(sub) AND mods-expiry:{sub} key exists with TTL ≈ 300s`
    - **Acceptance signal**: `npm test -- triggers.appInstall` exits 0
    - **PBT validates**: supports Property 7 (default combos round-trip)
    - **Priority**: P0
    - **Estimate**: 30 min

- [ ] 10. Demo + submission deliverables (must NOT be cut)
  - [x] 10.1 Implement demo seed endpoint
    - **Files**: `src/server/seed.ts`, `src/server/routes/devSeed.ts`, `tests/seed.spec.ts`
    - Export `runDemoSeed(sub, count = 12, deps): Promise<{ created: number, error?: string }>` matching design.md 'Demo Seed'. Gated on `seedEnabled` setting (returns `{ created: 0 }` when false). For each `i in 0..count`:
      1. `const post = await reddit.submitPost({ title: \`[ModSync demo \${i}]\`, text: 'Demo modqueue item.', sub, runAs: 'APP' })`
      2. `await reddit.report(post.id, { reason: 'demo-seed' })`
      3. `await new Promise(r => setTimeout(r, 1500))` — interleaved 1500ms delay to stay under Reddit's per-account rate limiter ('you're doing that too much' kicks in on sub-second post bursts)
    On any thrown error mid-loop, return `{ created: i, error: String(err.message ?? err) }` partially. Wrap the loop body in try/catch.
    - Wire `POST /api/dev/seed` in `src/server/routes/devSeed.ts`; runs `requireMod` AND checks `seedEnabled`
    - **PBT** (fast-check, ≥50 runs): `forall count in [1, 25]. exactly count submitPost calls AND count report calls occur on the redditFake (when no error injected); titles are unique. With one injected error at index k, the result is { created: k, error } and there are exactly k+1 submitPost calls and k report calls.`
    - **Acceptance signal**: `npm test -- seed` exits 0; gate path returns `{ created: 0 }` when `seedEnabled=false`
    - **PBT validates**: supports Property 10 (mod gate)
    - **Priority**: P0 (deliverable, never cut)
    - **Estimate**: 45 min

  - [x] 10.2 Write README.md
    - **Files**: `README.md`, `docs/screenshots/.gitkeep`
    - Sections: What ModSync does (1 paragraph + 1 line citing the arXiv stat), Install (`devvit upload` + `devvit install <sub>`), Alt-account mod setup (how to add a second mod for the collision demo), `/api/dev/seed` walkthrough (curl example with auth header), Two-browser collision demo path (step-by-step, claim from browser A, watch warning in browser B), Screenshots placeholder block, Tech stack list, License
    - **Acceptance signal**: `README.md` exists; `markdownlint` (run via `npx markdownlint README.md`) exits 0; every section listed above is present (grep for headers)
    - **PBT validates**: none (docs)
    - **Priority**: P0 (deliverable, never cut)
    - **Estimate**: 50 min

  - [ ] 10.3 Write 3-minute demo video script
    - **Files**: `DEMO.md`
    - Tight beat-by-beat script with timestamps (0:00-0:15 hook, 0:15-0:30 install confirmation visible to judges, 0:30-1:30 two-browser collision demo with on-screen captions, 1:30-2:15 combo execution + activity feed live update, 2:15-2:45 metrics dashboard, 2:45-3:00 close + call to install)
    - Include exact on-screen caption strings and the exact `/api/dev/seed` curl line to copy-paste during the recording
    - **Acceptance signal**: `DEMO.md` exists; contains 6+ timestamped beats covering all P0 features; total runtime annotation says ≤3:00
    - **PBT validates**: none (docs)
    - **Priority**: P0 (deliverable, never cut)
    - **Estimate**: 35 min

  - [ ] 10.4 Write Devpost submission checklist
    - **Files**: `SUBMISSION.md`
    - Sections: Title (≤70 chars), Tagline (≤200 chars), What it does, How we built it (Devvit Web + Redis + Realtime + Menu Actions stack), **How ModSync differs from existing mod tools** (one paragraph: 'queuezero/MQCC scores mod-queue items by priority and detects coordinated spam patterns; ModSync solves a different problem — preventing two moderators from unknowingly acting on the same item, the 74.5%-prevalence collision pain documented in the Sept 2025 arXiv paper *In the Queue: Understanding How Reddit Moderators Use the Modqueue*. The two tools are complementary, not competitive.'), Challenges, Accomplishments, **Project Impact** (3 named subreddits with reasoning: r/AskHistorians, r/AmItheAsshole, r/news), Video link placeholder `<INSERT YOUTUBE URL>`, 3+ screenshot link placeholders, Install link template `https://developers.reddit.com/apps/<APP_NAME>`
    - **Acceptance signal**: `SUBMISSION.md` exists; `grep -c "^## "` ≥ 10 (was 8); all placeholder tokens (`<INSERT...>`) present and uppercased so they fail any 'remember to fill in' lint; the section 'How ModSync differs from existing mod tools' is present and references queuezero/MQCC by name.
    - **PBT validates**: none (docs)
    - **Priority**: P0 (deliverable, never cut)
    - **Estimate**: 30 min

## Notes

- Property tests are required (not optional) for every leaf task that produces validated logic. They reference Properties 1–11 from `design.md` by number, with ≥100 fast-check iterations each (≥200 for the validator and executor properties).
- The 11 Correctness Properties from `design.md` are each validated by at least one task:
  - Property 1 → 4.1
  - Property 2 → 4.1, 4.3
  - Property 3 → 4.2 (no-foreign-claim path), 4.2b (combo branch on override), 8.3b (combo branch claim invariant)
  - Property 4 → 4.1
  - Property 5 → 8.4
  - Property 6 → 8.4
  - Property 7 → 8.1, 8.3a (combo list freshness), 8.5 (UI parity), 8.6 (round-trip on canned specs), 9.3 (default combos via AppInstall)
  - Property 8 → 7.1 (server), 7.3 (client), 6.2 (resync)
  - Property 9 → 2.2 (week key), 4.2 (softWarningsShown increment), 4.2b (counter routing), 5.1, 6.4 (zero-state UX), 8.3b (counter routing)
  - Property 10 → 3.1, 5.2, 7.2, 8.2, 8.3a (mod gate on picker), 10.1
  - Property 11 → 9.1 (onPostDelete + onCommentDelete handlers + claims-index cleanup), 9.2 (scrub-on-read)
- Tasks are designed for parallel execution by `spec-task-execution` sub-agents — each leaf is self-contained with file paths, signatures, PBT property numbers, and an acceptance signal. Task 1.1 pre-wires every planned route + menu + form + trigger endpoint so downstream tasks do not need to edit `src/server/main.ts`, removing the main.ts merge-conflict bottleneck.
- Build must run cleanly (`npm run build`) after each parent task completes.
- Cut order in priority: P1 trims (combo CRUD UI → ship 8.6 defaults only; activity feed → last 50 only); P0 floor (1, 2, 3, 4, 5, 6, 9, 10) is non-negotiable. Deletion compliance (9.1 onPostDelete + onCommentDelete handlers, 9.2 scrub-on-read for deleted accounts) is P0 because Devvit Rules require honoring deleted posts, deleted comments, and deleted-account references for App Directory approval.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["4.1", "4.3", "5.1", "7.1", "8.1"] },
    { "id": 4, "tasks": ["4.2", "4.2b", "5.2", "7.2", "8.2", "8.4", "9.1", "9.2", "9.3"] },
    { "id": 5, "tasks": ["6.1", "8.3a", "8.3b"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4", "7.3", "8.5", "8.6"] },
    { "id": 7, "tasks": ["10.1"] },
    { "id": 8, "tasks": ["10.2"] },
    { "id": 9, "tasks": ["10.3"] },
    { "id": 10, "tasks": ["10.4"] }
  ]
}
```
