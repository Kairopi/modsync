---
inclusion: always
---

# Build Toolchain Truth (verified against installed packages)

These facts were verified by reading `node_modules/@devvit/start/vite/index.js` and `utils.js` directly. **Trust this file over any conflicting instruction in older spec text or your prior knowledge.**

## Build pipeline

- `npm run build` runs `vite build`. The `devvit()` plugin from `@devvit/start/vite` (composed in `vite.config.ts`) auto-builds **both** the client and the server in one invocation using Vite's environment API.
- Client output: `dist/client/` (HTML + ESM JS, sourcemaps).
- Server output: `dist/server/index.cjs` — **CommonJS**, minified, `target: 'node22'`, `inlineDynamicImports: true`. Emitted by rollup with `format: 'cjs'`.
- **Do NOT add a separate `esbuild` step.** Older spec drafts mentioned esbuild; the @devvit/start plugin replaces it. Build script is just `vite build`.

## Server entry resolution

`getServerEntry()` in the devvit plugin checks these paths in order:

1. `src/api/index.ts`
2. `src/server/index.ts`
3. `src/index.ts`

ModSync uses **`src/server/index.ts`** so the plugin's accidental-server-import detector (which scans `src/server` and `src/api`) protects the client bundle.

## Client root resolution

If `src/client/` exists, the plugin treats it as the client root for HTML entrypoints. ModSync ships `src/client/index.html`, `src/client/index.tsx`, `src/client/App.tsx`. `devvit.json` declares `post.entrypoints.default.entry: "index.html"` and the plugin resolves it under `src/client/` automatically.

## devvit.json server field

Both forms are accepted by the schema:

```json
"server": { "dir": "dist/server", "entry": "index.cjs" }
```

or

```json
"server": { "entry": "dist/server/index.cjs" }
```

The template ships the split `dir`+`entry` form. Keep that form.

## Redis primitives that are NOT available

- **No `SCAN`.** Use sorted sets with absolute-expiry scores (see `claims-index:{sub}` in design.md).
- **No `LIST` operations.** `actions:{sub}` is a sorted set keyed by timestamp, not a LIST.
- **No `MULTI/EXEC` needed on the hot paths.** All menu/form handlers touch one key per call.

## Realtime channel naming

- Channels use `-` (hyphen): `claims-{sub}`, `actions-{sub}`.
- Devvit Realtime explicitly **forbids `:`** in channel names. Redis KEY paths keep `:`.

## Trigger endpoint convention

- Singular: `/internal/trigger/<name>` (e.g. `/internal/trigger/post-delete`). The original mod-tool template shipped `/internal/triggers/` (plural) — ModSync overrides this.

## Triggers Devvit does not expose

- **No `onAccountDelete`.** Account deletion compliance (Requirement 9.3 / 9.4) is handled lazily on read via `deleted-mods:{sub}` (see `src/server/scrub.ts`, task 9.2).

## TypeScript

- Single `tsconfig.json` with `composite: true` (template default). **Do not split into `tsconfig.client.json` + `tsconfig.server.json`** — Vite's environment API in the devvit plugin keeps client/server bundles separate without separate tsconfigs.
- `npm run type-check` runs `tsc --build`.

## Test runner

- `vitest` + `fast-check`. `npm test` is `vitest --run`. Required iteration counts per task: ≥100 (most properties), ≥200 (validator in 8.1, ISO week in 2.2).


## Test subreddit

- **Slug**: `Modsynnow` (the user's public test subreddit at https://www.reddit.com/r/Modsynnow/). Verified public via Reddit's about.json endpoint. Owned by the Reddit account currently authenticated to the Devvit CLI.
- This is the value of `dev.subreddit` in `devvit.json`. The user has already created the subreddit. Before flipping `seedEnabled` on, the user must invite the app account (`u/modsync-set` after first upload) as a moderator with full permissions.


## Installed SDK API surface (verified by reading node_modules .d.ts files)

**Trust these signatures over older spec wording or prior knowledge.** Verified against `@devvit/web@0.12.24` actually installed in this workspace.

### Server: `import { context, realtime, reddit, redis, createServer, getServerPort } from '@devvit/web/server'`

- `context` — request-scoped object with: `subredditId: T5`, `subredditName: string`, `userId: T2 | undefined`, `username: string | undefined`, `postId: T3 | undefined`, `commentId: T1 | undefined`, `appSlug: string`, `appVersion: string`. Per-request, no need to inject from request body.
- `realtime.send(channel, msg)` — the publish method. Returns `Promise<void>`. Channel string uses hyphens, no colons. Spec says `publishClaim` / `publishAction`; the underlying primitive is `realtime.send`.
- `redis.set(key, value, { expiration?: Date, nx?: boolean, xx?: boolean })` — **critical: TTL is via `{ expiration: new Date(Date.now() + 90_000) }`, NOT `{ ex: 90 }`**. Older Redis SDKs accept `{ ex }`; this one doesn't.
- `redis.get(key)` returns `Promise<string | undefined>` (NOT `null`).
- `redis.exists(...keys)` returns `Promise<number>` (count of existing keys).
- `redis.del(...keys)` returns `Promise<void>`.
- `redis.expire(key, seconds)` returns `Promise<void>`.
- `redis.zAdd(key, ...members)` where each member is `{ member: string, score: number }`. Returns `Promise<number>`.
- `redis.zRange(key, start, stop, { by: 'score' | 'lex' | 'rank', reverse?: boolean, limit?: { offset, count } })` returns `Promise<{ member: string, score: number }[]>`.
- `redis.zRem(key, members: string[])` returns `Promise<number>`.
- `redis.zRemRangeByRank(key, start, stop)` returns `Promise<number>`.
- `redis.zScore(key, member)` returns `Promise<number | undefined>`.
- `redis.hSet(key, fieldValues: Record<string, string>)` returns `Promise<number>`.
- `redis.hGet(key, field)` returns `Promise<string | undefined>` — **`hExists` does NOT exist; use `hGet(key, field) !== undefined`** instead.
- `redis.hGetAll(key)` returns `Promise<Record<string, string>>`.
- `redis.hKeys(key)` returns `Promise<string[]>`.
- `redis.hIncrBy(key, field, value)` returns `Promise<number>`.
- `redis.hDel(key, fields: string[])` returns `Promise<number>`.
- `redis.hMGet(key, fields: string[])` returns `Promise<(string | null)[]>`.
- `redis.zScan` and `redis.hScan` DO exist (earlier `01-build-truth.md` claim that "no SCAN" was overcautious). Spec still uses sorted-set indices for active claims because that's atomically correct without cursor management — keep that design.

### Server: trigger payload types — `import { OnPostDeleteRequest, OnCommentDeleteRequest, OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared'`

- `OnPostDeleteRequest` extends `PostDelete` from `@devvit/protos/json/devvit/events/v1alpha/events.js` and adds `type: 'PostDelete'`.
- `OnCommentDeleteRequest` similar.
- Each protobuf trigger event includes `subreddit: SubredditV2` and the relevant `postId` / `commentId` fields. Read trigger payloads via `await c.req.json<OnPostDeleteRequest>()`.
- `TriggerResponse = {}` — handlers return `c.json<TriggerResponse>({}, 200)`.

### Server: menu / form types — `import { MenuItemRequest, UiResponse } from '@devvit/web/shared'`

- `MenuItemRequest = { location: 'subreddit' | 'post' | 'comment', targetId: string }`. The `targetId` is the Thing ID with prefix (`t1_`, `t3_`, or `t5_`); branch on `location` to interpret it.
- `UiResponse = { navigateTo?, showToast?: string | { text, appearance? }, showForm?: { name: string, form: Form, data?: FormValues } }`. Toast `appearance` is `'neutral' | 'success'`.
- `showForm.name` MUST match a form declared in `devvit.json` (e.g. `softWarningForm`, `comboPickerForm`, `comboEditorForm`).
- `showForm.data` carries the original action's context (`{ kind, thingId, comboName? }`) into the form-submit endpoint.

### Client: `import { connectRealtime, disconnectRealtime, isRealtimeConnected } from '@devvit/web/client'`

```ts
connectRealtime<Msg>({
  channel: 'claims-Modsynnow',
  onConnect(channel) { /* refetch /api/claims for resync */ },
  onDisconnect(channel) { /* show offline indicator */ },
  onMessage(msg) { /* handle event */ }
});
```

The SDK already provides connect/disconnect callbacks. The spec's `useRealtime` hook (task 6.2) wraps `connectRealtime` and adds React lifecycle binding + the on-resync semantics.

### Client: `import { context } from '@devvit/web/client'`

Same `BaseContext` shape as server (without server-only metadata). Use `context.subredditName` to build channel names client-side.

## Hono integration pattern (from the template, verified)

The template's `src/index.ts` (which we'll move to `src/server/index.ts` in task 1.1) uses Hono + `@hono/node-server`'s `serve` with a Devvit-provided `createServer` factory:

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
// ...
serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
```

`createServer` is Devvit's drop-in for Node's `http.createServer` — it returns something API-compatible with `http.Server`. `getServerPort()` returns the port the Devvit runtime expects to bind. Do not hard-code a port.

## Spec adjustments these findings imply

These are LOCKED corrections. Subagents implementing the corresponding leaf tasks must use the verified signatures, not the older spec wording:

1. **Claim TTL writes** (task 4.1): `redis.set(claimKey, JSON.stringify(record), { expiration: new Date(Date.now() + CLAIM_TTL_SEC * 1000) })`. NOT `{ ex: 90 }`.
2. **Realtime publish** (task 4.3): wrap `realtime.send(channel, msg)`. Do not invent a `publish` method.
3. **`mods:{sub}` cache check** (task 3.1): use `redis.hGet(\`mods:${sub}\`, user)` and check for `!== undefined`. There is no `hExists` on this Redis client.
4. **Trigger handler bodies** (task 9.1): parse via `await c.req.json<OnPostDeleteRequest>()`; the payload contains `subreddit.name`, `postId`, etc. The shape is the protobuf event, not a hand-rolled `{ sub, thingId }`.
5. **MenuItemRequest reading** (task 4.2): `body.targetId` is always present; branch on `body.location` to decide if it's a post or comment.
6. **Client realtime hook** (task 6.2): build on top of `connectRealtime({ channel, onMessage, onConnect, onDisconnect })`. The 250ms→4s backoff lives in the hook, not in the SDK.
