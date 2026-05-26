/**
 * Activity feed module for ModSync. Owns the `actions:{sub}` SORTED SET
 * — the audit trail of every executed combo / claim. See
 * `.kiro/specs/modsync/design.md` "Activity Feed" and "Property 8".
 *
 * Devvit Redis exposes no LIST primitives, so the feed lives in a sorted
 * set keyed by `entry.ts`. Newest-first reads are served by reading the
 * top of a rank-descending range; trimming to the newest-500 happens via
 * `zRemRangeByRank` after every append.
 *
 * Storage shape (per-install):
 *   - `actions:{sub}` — SORTED SET, member = JSON-encoded `ActionEntry`,
 *     score = `entry.ts`. Capped at `MAX_FEED_ENTRIES` (500). The cap is
 *     enforced by trimming the lowest-ranked (oldest by score) entries
 *     after every `zAdd`.
 *
 * Read-time scrubbing:
 *   - `scrubEntry` / `isModeratorDeleted` from `src/server/scrub.ts` will
 *     be wired in by task 9.2. This module is read-only with respect to
 *     deleted-mod compliance: the original JSON in the sorted set is
 *     never mutated. Per task 7.1 the feed module no longer exports a
 *     `scrubModerator` helper.
 *
 * Dependency injection:
 *   - The module never imports `@devvit/web/server`. Callers (the
 *     `/api/feed` route in 7.2, the executor in 4.x, the deletion
 *     triggers in 9.1) inject a `RedisLike`. Tests inject the in-memory
 *     fake from `tests/_fakes/redisFake.ts`.
 */

import { MAX_FEED_ENTRIES, type ActionEntry, type ThingId } from "../shared/types";
import { actionsKey } from "./redisKeys";
import type { ScrubDeps } from "./scrub";

/**
 * Optional read-time scrub hook. Task 9.2 supplies a `scrubEntry`
 * implementation that consults `deleted-mods:{sub}` and rewrites
 * `entry.moderator` to `"[deleted]"` when the original moderator's
 * Reddit account is gone. The SORTED SET member in `actions:{sub}`
 * is NEVER rewritten — only the value returned to the API consumer.
 *
 * `scrub` is optional so existing 7.1 tests (which were written
 * before 9.2) keep working without supplying a scrub layer.
 */
export interface FeedScrubLike {
  scrubEntry(
    sub: string,
    entry: ActionEntry,
    deps: ScrubDeps,
  ): Promise<ActionEntry>;
}

/**
 * Minimal Redis surface this module uses. Tracks Devvit-Web 0.12.24 per
 * `01-build-truth.md`. The in-memory fake structurally satisfies it.
 */
export interface RedisLike {
  zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    opts?: {
      by?: "score" | "rank" | "lex";
      reverse?: boolean;
      limit?: { offset: number; count: number };
    },
  ): Promise<{ member: string; score: number }[]>;
  zRem(key: string, members: string[]): Promise<number>;
  zRemRangeByRank(key: string, start: number, stop: number): Promise<number>;
}

/** Injected dependencies. */
export interface FeedDeps {
  redis: RedisLike;
  /**
   * Optional read-time scrub layer (task 9.2). When supplied, every
   * parsed entry returned by `readFeed` is piped through
   * `scrub.scrubEntry(sub, entry, scrub.deps)`. When absent, behavior
   * matches the pre-9.2 contract — entries are returned verbatim.
   */
  scrub?: {
    scrubEntry: FeedScrubLike["scrubEntry"];
    deps: ScrubDeps;
  };
}

/**
 * Append an `ActionEntry` to the per-sub activity feed and trim the set
 * back down to the newest `MAX_FEED_ENTRIES` (500). Per Property 8:
 *
 *   - `zAdd` writes the entry with `score = entry.ts` so sorted-set
 *     order is identical to chronological order.
 *   - `zRemRangeByRank(0, -(MAX_FEED_ENTRIES + 1))` removes ranks
 *     `[0, len - MAX_FEED_ENTRIES - 1]` — i.e. the oldest entries that
 *     overflow the 500 cap. When `len <= 500` the negative stop index
 *     normalizes to `< 0`, the `start > stop` short-circuit kicks in,
 *     and nothing is removed (verified in the redisFake's
 *     `zRemRangeByRank` implementation).
 *
 * The realtime `action` publish happens at the call site (executor /
 * trigger handler) — `appendAction` is purely a Redis-write primitive.
 */
export async function appendAction(
  sub: string,
  entry: ActionEntry,
  deps: FeedDeps,
): Promise<void> {
  const key = actionsKey(sub);
  await deps.redis.zAdd(key, {
    member: JSON.stringify(entry),
    score: entry.ts,
  });
  // Trim everything except the newest MAX_FEED_ENTRIES (by score). The
  // negative stop index `-(MAX_FEED_ENTRIES + 1)` selects the oldest
  // overflow tail when `len > MAX_FEED_ENTRIES`, and is a no-op when
  // `len <= MAX_FEED_ENTRIES`.
  await deps.redis.zRemRangeByRank(key, 0, -(MAX_FEED_ENTRIES + 1));
}

/**
 * Read the newest `limit` entries from the feed in score-descending
 * order (newest first). JSON-parses each member back into an
 * `ActionEntry`.
 *
 * Implementation: `zRange(key, 0, limit - 1, { by: "rank", reverse: true })`.
 * Per `01-build-truth.md` the verified Devvit-Web SDK accepts this
 * shape. Since `appendAction` keeps the set capped at 500 and callers
 * never request more than 500, `len <= limit` holds in practice and the
 * result is the entire set in descending-score order.
 *
 * Members that fail to parse (defensive — would never happen against
 * our own writers) are silently skipped rather than throwing the whole
 * read.
 */
export async function readFeed(
  sub: string,
  limit: number,
  deps: FeedDeps,
): Promise<ActionEntry[]> {
  if (limit <= 0) return [];
  const members = await deps.redis.zRange(actionsKey(sub), 0, limit - 1, {
    by: "rank",
    reverse: true,
  });
  const out: ActionEntry[] = [];
  for (const { member } of members) {
    try {
      out.push(JSON.parse(member) as ActionEntry);
    } catch {
      // Corrupt member — skip.
    }
  }
  if (deps.scrub) {
    const scrubFn = deps.scrub.scrubEntry;
    const scrubDeps = deps.scrub.deps;
    const scrubbed: ActionEntry[] = [];
    for (const entry of out) {
      scrubbed.push(await scrubFn(sub, entry, scrubDeps));
    }
    return scrubbed;
  }
  return out;
}

/**
 * Remove every entry whose `thingId` matches the argument and return the
 * count of removed entries. Used by the post-delete / comment-delete
 * trigger handlers (task 9.1) to comply with Reddit Rules: when a Thing
 * is deleted, its action history must disappear.
 *
 * Important — kept entries are not rewritten. We `zRem` only the
 * matching JSON-string members; surviving entries keep their original
 * scores (and therefore their original chronological order) untouched.
 *
 * Devvit Redis has no `SCAN`. We enumerate the entire set via `zRange
 * (0, -1)` (capped at 500 entries, so this is a single round-trip), JSON
 * parse each member, filter by `thingId`, and `zRem` the matching
 * member-strings. Member-string equality is exact JSON equality, which
 * works because every writer goes through `JSON.stringify(entry)` once
 * with the same property ordering.
 */
export async function purgeByThingId(
  sub: string,
  thingId: ThingId,
  deps: FeedDeps,
): Promise<number> {
  const key = actionsKey(sub);
  const all = await deps.redis.zRange(key, 0, -1);
  const toRemove: string[] = [];
  for (const { member } of all) {
    let entry: ActionEntry;
    try {
      entry = JSON.parse(member) as ActionEntry;
    } catch {
      continue;
    }
    if (entry.thingId === thingId) {
      toRemove.push(member);
    }
  }
  if (toRemove.length === 0) return 0;
  return deps.redis.zRem(key, toRemove);
}
