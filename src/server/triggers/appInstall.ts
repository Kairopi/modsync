/**
 * `onAppInstall` trigger handler — one-time setup the very first time
 * ModSync is installed onto a subreddit.
 *
 * Source of truth: `.kiro/specs/modsync/tasks.md` task 9.3 and
 * `.kiro/specs/modsync/design.md` "Onboarding" / "Demo Seed" sections.
 *
 * Devvit fires this trigger right after a successful `devvit install`
 * (and after `devvit upload` -> first install on the test sub). The
 * payload shape — `OnAppInstallRequest` from `@devvit/web/shared` —
 * carries `{ subreddit?: SubredditV2, installer?: UserV2, type:
 * "AppInstall" }`. We only need `subreddit.name`.
 *
 * Side-effects (in order):
 *   1. **Warm-fill `mods:{sub}`**. Call `reddit.getModerators(sub)`
 *      once, `hSet` every moderator name into `mods:{sub}`, and arm
 *      the 5-minute sentinel `mods-expiry:{sub}` via
 *      `set(..., { expiration: now + 300_000 })`. This means the very
 *      first menu-action invocation after install hits the warm cache
 *      in `requireMod` (`src/server/auth.ts`) and avoids a cold Reddit
 *      API round-trip.
 *
 *   2. **Seed default combos** when `combos:{sub}` is empty AND
 *      `deps.defaultCombos` was injected. Each `ComboSpec` is written
 *      via `hSet(combosKey(sub), { [name]: JSON.stringify(spec) })`.
 *      The "is empty" check uses `hGetAll` because `redis.hLen` is not
 *      part of the deps surface declared by task 9.3, and `hGetAll` on
 *      an unset HASH returns `{}` cheaply. Idempotent: re-installing
 *      the app will see an already-populated `combos:{sub}` and skip
 *      the seed write entirely. The actual default-combo values are
 *      task 8.6's responsibility — `appInstall.ts` is the wiring
 *      layer; if `defaultCombos` is `undefined` or empty, no combo
 *      writes are performed.
 *
 *   3. **Create the ModSync custom post**. Per design.md the
 *      `onAppInstall` flow lands a single Devvit custom post on the
 *      sub so the moderator can find the dashboard from the
 *      subreddit's pinned-post slot. Gated behind
 *      `deps.createPostOnInstall` (default `true` in production where
 *      the call site closes over the real `reddit` from
 *      `@devvit/web/server`; tests inject `false` to skip the side
 *      effect — the real `submitPost` would otherwise attempt a
 *      Reddit API round-trip and fail under the in-memory fake).
 *
 * Auth:
 *   - No `requireMod` gate. Devvit invokes triggers internally; there
 *     is no end-user identity to authenticate (the `installer` field
 *     on the payload is informational only and not authoritative).
 *
 * Failure semantics:
 *   - `getModerators` errors propagate. Devvit's trigger retry policy
 *     wants the trigger to retry on 5xx — swallowing the error here
 *     would prevent that retry and leave `mods:{sub}` cold. The route
 *     wrapper that mounts this handler at
 *     `/internal/trigger/app-install` returns a 500 on uncaught
 *     exceptions, which Devvit treats as a retry signal.
 *   - `submitPost` errors also propagate (same reasoning — a failed
 *     post creation should retry, not silently leave the sub without
 *     a dashboard post). If a future spec revision wants a softer
 *     posture (idempotent re-install must not double-post), wrap the
 *     `submitPost` call in a try/catch here and gate it on a
 *     `post-created:{sub}` sentinel key.
 *
 * Dependency injection:
 *   - The module never imports `@devvit/web/server`. The route
 *     wrapper that mounts this handler will close over the
 *     per-request `redis` and `reddit` clients from `@devvit/web/server`
 *     and pass them through. Tests inject the in-memory fakes from
 *     `tests/_fakes/redisFake.ts` and a recording reddit fake.
 */

import type { OnAppInstallRequest, TriggerResponse } from "@devvit/web/shared";
import type { ComboSpec } from "../../shared/types";
import { combosKey, modsExpiryKey, modsKey } from "../redisKeys";

/** TTL on the `mods-expiry:{sub}` sentinel (5 minutes), matches `auth.ts`. */
const MODS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Minimal Redis surface used by this handler. Tracks Devvit-Web 0.12.24
 * per `.kiro/steering/01-build-truth.md`.
 *
 * We only need three ops: `hSet` (warm-fill mods + seed combos), `set`
 * (arm the sentinel), `hGetAll` (check whether `combos:{sub}` is empty).
 * The recording fake from `tests/_fakes/redisFake.ts` structurally
 * satisfies this interface.
 */
export interface RedisLike {
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
  set(
    key: string,
    value: string,
    options?: { expiration?: Date; nx?: boolean; xx?: boolean },
  ): Promise<string>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

/**
 * Minimal Reddit client surface. Real callers inject the Devvit
 * `reddit` client from `@devvit/web/server`; tests inject a recording
 * fake.
 *
 * `submitPost` is only called when `createPostOnInstall === true`. The
 * shape of `opts` is loose-typed here to avoid coupling to the full
 * Devvit `reddit.submitPost` signature — the production wiring will
 * pass a typed opts bag through (`{ subredditName, title, postData }`).
 */
export interface RedditClient {
  getModerators(sub: string): Promise<{ username: string }[]>;
  submitPost(opts: {
    subredditName: string;
    title: string;
    postData?: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

/**
 * Injected dependencies for `onAppInstall`. `createPostOnInstall`
 * defaults to `true` in production; tests pass `false` so the
 * recording fake's `submitPost` is never called. `defaultCombos`
 * defaults to "no seed" — task 8.6 will wire the actual default
 * combo specs in via this same field at the route boundary.
 */
export interface AppInstallDeps {
  redis: RedisLike;
  reddit: RedditClient;
  /** Default `true` in production; tests pass `false`. */
  createPostOnInstall?: boolean;
  /**
   * Default combos to seed if `combos:{sub}` is empty. When omitted or
   * empty, no combo writes happen — the wiring is in place for 8.6 to
   * inject its canned specs without touching this handler.
   */
  defaultCombos?: ComboSpec[];
}

/**
 * Handle an `onAppInstall` trigger event.
 *
 * Reads `subreddit.name` from the protobuf-shaped trigger body. If the
 * field is absent (Devvit should always populate it for AppInstall, but
 * we guard against the optional field on the proto type) the handler
 * returns the empty `TriggerResponse` immediately — there's nothing to
 * scope the warm-fill / seed / post-creation against.
 */
export async function onAppInstall(
  body: OnAppInstallRequest,
  deps: AppInstallDeps,
): Promise<TriggerResponse> {
  const sub = body.subreddit?.name ?? "";
  if (sub === "") {
    return {};
  }

  const { redis, reddit } = deps;

  // 1. Warm-fill the moderator cache. One Reddit API call; on success,
  //    one `hSet` (only if the sub has at least one moderator — which it
  //    always will, but defend against an empty list anyway) and one
  //    `set` for the 5-minute sentinel. Errors propagate so Devvit
  //    retries the trigger.
  const mods = await reddit.getModerators(sub);
  if (mods.length > 0) {
    const fieldValues: Record<string, string> = {};
    for (const m of mods) {
      fieldValues[m.username] = "1";
    }
    await redis.hSet(modsKey(sub), fieldValues);
  }
  await redis.set(modsExpiryKey(sub), "1", {
    expiration: new Date(Date.now() + MODS_CACHE_TTL_MS),
  });

  // 2. Seed default combos when the hash is empty and an injection was
  //    provided. Idempotent across re-installs — a second invocation
  //    sees `combos:{sub}` already populated and skips the write.
  const defaults = deps.defaultCombos ?? [];
  if (defaults.length > 0) {
    const existing = await redis.hGetAll(combosKey(sub));
    if (Object.keys(existing).length === 0) {
      const fieldValues: Record<string, string> = {};
      for (const spec of defaults) {
        fieldValues[spec.name] = JSON.stringify(spec);
      }
      await redis.hSet(combosKey(sub), fieldValues);
    }
  }

  // 3. Create the ModSync custom post. Gated by `createPostOnInstall`
  //    so tests can opt out without touching the real Reddit API.
  //    Default `true` matches the production posture where the route
  //    wrapper closes over the real `reddit` client.
  const createPost = deps.createPostOnInstall ?? true;
  if (createPost) {
    await reddit.submitPost({
      subredditName: sub,
      title: "ModSync Dashboard",
      postData: { kind: "modsync" },
    });
  }

  return {};
}
