/**
 * Account-deletion scrub-on-read for ModSync (`tasks.md` task 9.2,
 * `design.md` "Account-deletion scrub-on-read").
 *
 * Devvit does not expose an `onAccountDelete` trigger and Devvit Redis
 * is per-install-namespaced, so cross-install deletion fan-out is
 * impossible. The compliant pattern is therefore lazy: every read of
 * the activity feed (`readFeed` in `src/server/feed.ts`) pipes each
 * parsed `ActionEntry` through `scrubEntry`, which checks the per-sub
 * cache `deleted-mods:{sub}` and, on cache miss, asks the Reddit API
 * whether the user still exists. Once a user is observed as deleted
 * we cache the result so future reads avoid the Reddit round-trip.
 *
 * Storage shape:
 *   - `deleted-mods:{sub}` — HASH, field = username, value = `"1"`.
 *     Append-only. Keys are scoped per install so a delete recorded
 *     in one subreddit's install does not leak to another.
 *
 * Critical invariant: the SORTED SET member in `actions:{sub}` is
 * NEVER rewritten. Only the value returned to the API consumer is
 * mutated. The audit trail is preserved verbatim.
 *
 * Dependency injection:
 *   - `reddit: { getUserByUsername(name): Promise<{...} | null> }`
 *     A `null` return is treated the same as an explicitly deleted /
 *     suspended user. The Devvit `reddit` client throws on missing
 *     users; we catch errors whose message mentions
 *     `"user not found"`, `"suspended"`, or `"deleted"` and treat
 *     them as positive deletion signals (so e.g. a transient network
 *     error is propagated, not silently swallowed).
 *   - `redis: { hGet, hSet }` — the narrow surface of the Redis
 *     client this module needs. Tests inject the in-memory fake from
 *     `tests/_fakes/redisFake.ts`.
 */

import type { ActionEntry } from "../shared/types";
import { deletedModsKey } from "./redisKeys";

/**
 * Shape of a Reddit user record relevant to deletion detection. The
 * Devvit `reddit.getUserByUsername` returns a richer object; we only
 * care about the two boolean flags. Both are optional since the SDK
 * does not always populate them (e.g. for healthy accounts).
 */
export interface RedditUserLike {
  readonly isSuspended?: boolean;
  readonly isDeleted?: boolean;
}

/**
 * Reddit client surface this module uses. `getUserByUsername` MAY:
 *   - return a `RedditUserLike` for a healthy account
 *   - return `null` if the account does not exist (some SDK shims)
 *   - throw an error whose message contains a deletion / suspension
 *     hint (`"user not found"`, `"suspended"`, `"deleted"`)
 *
 * Any other thrown error is propagated to the caller — we do NOT
 * silently scrub on transient failures, because that would corrupt
 * the audit trail.
 */
export interface RedditClient {
  getUserByUsername(username: string): Promise<RedditUserLike | null>;
}

/** Narrow Redis surface — only the two ops `scrub` needs. */
export interface RedisLike {
  hGet(key: string, field: string): Promise<string | undefined>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
}

/** Injected dependencies. */
export interface ScrubDeps {
  redis: RedisLike;
  reddit: RedditClient;
}

/**
 * Lower-cased substrings in a thrown error's message that we
 * interpret as "user is gone". Anything else is re-thrown so callers
 * can react to genuine outages instead of silently scrubbing the
 * audit log.
 */
const DELETION_ERROR_HINTS = ["not found", "suspended", "deleted"] as const;

function looksLikeDeletionError(err: unknown): boolean {
  const msg = String(
    (err as { message?: unknown } | null)?.message ?? err ?? "",
  ).toLowerCase();
  return DELETION_ERROR_HINTS.some((h) => msg.includes(h));
}

/**
 * Returns `true` iff `username` is known (or now observed) to be a
 * deleted / suspended account in the context of `sub`.
 *
 * Algorithm:
 *   1. Read `hGet(deletedModsKey(sub), username)`. If defined, the
 *      account was already cached as deleted. Return `true` with no
 *      further side effects (no Reddit API call, no Redis writes).
 *   2. On cache miss, call `reddit.getUserByUsername(username)`.
 *   3. If the call throws an error whose message mentions a deletion
 *      hint, mark the user as deleted (`hSet`) and return `true`.
 *   4. If the call throws any OTHER error, propagate it — we do not
 *      pollute the cache from transient failures.
 *   5. If the result is `null` or has `isSuspended === true` or
 *      `isDeleted === true`, mark the user as deleted (`hSet`) and
 *      return `true`.
 *   6. Otherwise return `false` with no Redis writes.
 */
export async function isModeratorDeleted(
  sub: string,
  username: string,
  deps: ScrubDeps,
): Promise<boolean> {
  const key = deletedModsKey(sub);
  const cached = await deps.redis.hGet(key, username);
  if (cached !== undefined) return true;

  let user: RedditUserLike | null;
  try {
    user = await deps.reddit.getUserByUsername(username);
  } catch (err) {
    if (looksLikeDeletionError(err)) {
      await deps.redis.hSet(key, { [username]: "1" });
      return true;
    }
    throw err;
  }

  if (user === null || user.isSuspended === true || user.isDeleted === true) {
    await deps.redis.hSet(key, { [username]: "1" });
    return true;
  }

  return false;
}

/**
 * If `entry.moderator` is a deleted account, return a clone with the
 * moderator field replaced by `"[deleted]"`; otherwise return the
 * entry unchanged. The object is only cloned on the deletion path so
 * the live-mod path returns referentially-identical entries.
 *
 * The underlying `actions:{sub}` SORTED SET member is NEVER rewritten
 * by this function — the caller (`readFeed`) is responsible for
 * passing already-parsed entries; the canonical audit row in Redis is
 * untouched.
 */
export async function scrubEntry(
  sub: string,
  entry: ActionEntry,
  deps: ScrubDeps,
): Promise<ActionEntry> {
  const deleted = await isModeratorDeleted(sub, entry.moderator, deps);
  if (!deleted) return entry;
  return { ...entry, moderator: "[deleted]" };
}
