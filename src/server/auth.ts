/**
 * Auth gate for ModSync. Every menu, form-submit, and mutating `/api/*`
 * endpoint must call `requireMod` first (see design.md "Server modules"
 * and `02-modsync-architecture.md` "Critical gotchas").
 *
 * The function resolves the current Reddit user, verifies they are a
 * moderator of the current subreddit (consulting a 5-minute Redis cache
 * to avoid hammering the Reddit API), and returns the resolved
 * `{ user, sub }` pair. On a non-mod, it throws `ForbiddenError` with
 * NO Redis writes and NO realtime publishes — that no-side-effect
 * guarantee is Property 10 in the spec.
 *
 * SDK signatures used here are the verified Devvit-Web 0.12.24 surface
 * documented in `01-build-truth.md` ("Installed SDK API surface"):
 *   - `redis.hGet(key, field)` returns `string | undefined`. There is no
 *     `hExists` on this client; use `hGet(...) !== undefined`.
 *   - `redis.exists(...keys)` returns `Promise<number>` (count). Treat
 *     `> 0` as "the key is set".
 *   - `redis.set(key, value, opts)` takes `{ expiration?: Date, nx?, xx? }`
 *     for TTL — NOT `{ ex: seconds }`. The 5-minute sentinel is therefore
 *     `set(modsExpiryKey(sub), '1', { expiration: new Date(now + 300_000) })`.
 *
 * Lookup flow (matches tasks.md 3.1, with one ordering refinement so the
 * throw path stays write-free per Property 10's acceptance signal):
 *
 *   1. Read the current user via `deps.reddit.getCurrentUser()`. If that
 *      throws or yields an empty username, propagate — there's nothing
 *      to authorize.
 *
 *   2. Cache hit fast-path: if `mods:{sub}` already lists this user AND
 *      `mods-expiry:{sub}` is still set, return immediately. Zero writes,
 *      zero Reddit API call. This is the steady-state path inside the
 *      5-minute window.
 *
 *   3. Cache miss / stale: call `deps.reddit.getModerators(sub)` ONCE,
 *      check membership against the freshly-fetched list. If the user
 *      is NOT a moderator, throw `ForbiddenError` *before* writing
 *      anything to Redis. This keeps Property 10's "zero writes on
 *      throw" invariant intact.
 *
 *   4. If the user IS a moderator, warm the cache: a single `hSet` with
 *      every moderator name as a field, then `set` the 5-minute sentinel
 *      with `{ expiration }`. Subsequent calls within 5 minutes hit the
 *      fast-path in step 2.
 *
 * The original task body lists the warm-fill in step 3 and the
 * membership re-check in step 4. That literal ordering would force the
 * throw path to write `mods:{sub}` even for non-moderators, contradicting
 * the property's "zero writes on throw" assertion. The reordering here
 * is observationally identical for any moderator (cache ends up
 * populated, sentinel ends up set) and strictly stricter for non-mods
 * (no cache pollution from rejected callers). See design.md
 * "Concurrency and Collision Counting" — `requireMod` is described as a
 * "5-min sentinel expiry" pattern that incurs "exactly one
 * `reddit.getModerators(sub)` call which warms the hash for all
 * subsequent invocations within the window", which this implementation
 * preserves.
 */

// TODO(task 2.2): switch these literals to `modsKey(sub)` / `modsExpiryKey(sub)`
// imports from `./redisKeys` once 2.2 lands. The literals below are the exact
// strings 2.2 will return (`mods:{sub}` and `mods-expiry:{sub}`); see
// `02-modsync-architecture.md` Redis schema table. Keeping them inline avoids
// creating a duplicate key-builder module.
const modsKey = (sub: string): string => `mods:${sub}`;
const modsExpiryKey = (sub: string): string => `mods-expiry:${sub}`;

/** TTL on the `mods-expiry:{sub}` sentinel. 5 minutes per design.md. */
const MODS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Minimal Reddit client surface `requireMod` actually uses. Real callers
 * inject the Devvit `reddit` client from `@devvit/web/server`; tests
 * inject a recording fake.
 */
export interface RedditClient {
  /** Returns the calling moderator's identity. Throws on missing identity. */
  getCurrentUser(): Promise<{ username: string }>;
  /**
   * Returns the full moderator list for `sub`. Called at most once per
   * `requireMod` invocation, only on cache miss.
   */
  getModerators(sub: string): Promise<{ username: string }[]>;
}

/**
 * Minimal Redis client surface `requireMod` actually uses. Tracks the
 * Devvit-Web 0.12.24 signatures verified in `01-build-truth.md`. Tests
 * inject a recording fake that records every write call.
 */
export interface RedisLike {
  hGet(key: string, field: string): Promise<string | undefined>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  set(
    key: string,
    value: string,
    options?: { expiration?: Date; nx?: boolean; xx?: boolean },
  ): Promise<string>;
}

/** Injected dependencies for `requireMod`. Real call site is a request handler. */
export interface RequireModDeps {
  redis: RedisLike;
  reddit: RedditClient;
}

/**
 * Thrown when the current user is not a moderator of the requested
 * subreddit. Carries `user` and `sub` so the route layer can log and
 * map to a 403 without re-deriving them.
 */
export class ForbiddenError extends Error {
  constructor(
    public readonly user: string,
    public readonly sub: string,
  ) {
    super(`User ${user} is not a moderator of ${sub}`);
    this.name = "ForbiddenError";
  }
}

/**
 * Resolve and authorize the current moderator for `ctx.sub`.
 *
 * Pass the per-request subreddit name via `ctx.sub`. In production this
 * is `context.subredditName` from `@devvit/web/server`; in tests, any
 * non-empty string.
 *
 * Returns `{ user, sub }` on success. Throws `ForbiddenError` if the
 * caller is not a moderator. Other errors (Reddit API failure, missing
 * identity) propagate unchanged.
 */
export async function requireMod(
  ctx: { sub: string },
  deps: RequireModDeps,
): Promise<{ user: string; sub: string }> {
  const { sub } = ctx;
  const { redis, reddit } = deps;

  const user = (await reddit.getCurrentUser()).username;

  // Step 2 — cache hit fast-path. Both lookups must succeed: the hash
  // must list the user AND the 5-minute sentinel must still exist. If
  // the sentinel is missing the cache is stale (even if the user happens
  // to still be in the hash from a prior fill), so we fall through to a
  // fresh `getModerators` call.
  const cachedField = await redis.hGet(modsKey(sub), user);
  if (cachedField !== undefined) {
    const sentinelCount = await redis.exists(modsExpiryKey(sub));
    if (sentinelCount > 0) {
      return { user, sub };
    }
  }

  // Step 3 — cache miss or stale. One Reddit API call, then membership
  // check against the in-memory list. Throw BEFORE any Redis write so
  // the throw path stays side-effect-free (Property 10).
  const mods = await reddit.getModerators(sub);
  const isMod = mods.some((m) => m.username === user);
  if (!isMod) {
    throw new ForbiddenError(user, sub);
  }

  // Step 4 — warm the cache. One `hSet` with every moderator as a
  // field, then the 5-minute sentinel via `{ expiration }`. Devvit-Web
  // 0.12.24 does NOT accept `{ ex: seconds }`; see `01-build-truth.md`.
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

  return { user, sub };
}
