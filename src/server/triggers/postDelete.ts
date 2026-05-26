/**
 * `onPostDelete` trigger handler — Reddit Rules / Devpost compliance.
 *
 * Devvit fires this trigger when a post is deleted on the host
 * subreddit. Per `.kiro/specs/modsync/design.md` "Deletion Compliance"
 * and `tasks.md` task 9.1, the handler must remove every audit-trail
 * entry that referenced the deleted Thing AND any live claim against
 * it, so that the moderator UI never re-surfaces a deleted post.
 *
 * Side-effects (in order):
 *   1. `purgeByThingId(sub, thingId, deps)` from `src/server/feed.ts`
 *      removes every matching member from `actions:{sub}` (the SORTED
 *      SET that backs the activity feed). Survivor scores are NOT
 *      rewritten, so the chronological order of unaffected entries is
 *      preserved exactly.
 *   2. `redis.del(claimKey(sub, thingId))` drops the live claim STRING
 *      (90-second JSON record) if any. `del` is harmless on a missing
 *      key.
 *   3. `redis.zRem(claimsIndexKey(sub), [thingId])` drops the index
 *      entry. `zRem` of a non-member is a no-op.
 *
 * Idempotency:
 *   - All three operations are idempotent. Re-delivery of the same
 *     trigger payload (Devvit retries on 5xx) leaves Redis in a
 *     byte-identical state — `purgeByThingId` returns 0 the second
 *     time, `del` is harmless on missing keys, `zRem` returns 0 on
 *     non-members. Property 11 (idempotency facet) verifies this.
 *
 * Auth:
 *   - No `requireMod` gate. Devvit invokes triggers internally; there
 *     is no end-user identity to authenticate. `deps` accepts only
 *     `redis` — no `reddit`, no `realtime` (canonical state lives in
 *     Redis; UI clients reconcile via the regular `/api/feed` poll +
 *     realtime stream).
 *
 * Dependency injection:
 *   - The module never imports `@devvit/web/server`. The route
 *     wrapper that mounts this handler at `/internal/trigger/post-delete`
 *     (a future task) will close over the per-request `redis` from
 *     `@devvit/web/server` and pass it through. Tests inject the
 *     in-memory fake from `tests/_fakes/redisFake.ts`.
 */

import type { OnPostDeleteRequest, TriggerResponse } from "@devvit/web/shared";
import type { ThingId } from "../../shared/types";
import { purgeByThingId, type FeedDeps } from "../feed";
import { claimKey, claimsIndexKey } from "../redisKeys";

/**
 * Minimal Redis surface used by the deletion-trigger handlers.
 *
 * Combines the surface that `purgeByThingId` needs (sorted-set ops on
 * `actions:{sub}`) with the two extra ops the handler itself uses on
 * the claim layer (`del` for the STRING, `zRem` for the SORTED SET
 * index). Tracks Devvit-Web 0.12.24 per `.kiro/steering/01-build-truth.md`.
 */
export interface RedisLike {
  // Used by purgeByThingId on `actions:{sub}` (FeedDeps.redis).
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
  // Used directly by the handler on `claims:{sub}:{thingId}`.
  del(...keys: string[]): Promise<void>;
}

/**
 * Injected dependencies for the deletion-trigger handlers. Only Redis;
 * no `reddit` or `realtime` — both are read-only-by-clients in the
 * deletion flow.
 */
export interface TriggerDeps {
  redis: RedisLike;
}

/**
 * Handle an `onPostDelete` trigger event.
 *
 * Reads `subreddit.name` and `postId` from the protobuf-shaped trigger
 * body. Per Reddit's convention `postId` is already prefixed `t3_…`,
 * so it can be used directly as a `ThingId` in our key paths.
 *
 * Returns the empty `TriggerResponse` (`{}`) — Devvit only checks for
 * a 200 status with a JSON-shaped body. The response shape is locked
 * by `@devvit/web/shared`'s `TriggerResponse = {}`.
 */
export async function onPostDelete(
  body: OnPostDeleteRequest,
  deps: TriggerDeps,
): Promise<TriggerResponse> {
  const sub = body.subreddit?.name ?? "";
  // PostDelete payloads carry `postId` already prefixed with `t3_`
  // (Reddit's Thing convention). Cast to `ThingId` for type safety
  // inside our key builders.
  const thingId = body.postId as ThingId;

  // 1. Drop every matching audit-feed entry. `purgeByThingId` returns
  // 0 when nothing matches and short-circuits before any `zRem` call.
  const feedDeps: FeedDeps = { redis: deps.redis };
  await purgeByThingId(sub, thingId, feedDeps);

  // 2. Drop the live claim STRING if any. `del` is harmless on a
  // missing key — the operation is unconditionally safe.
  await deps.redis.del(claimKey(sub, thingId));

  // 3. Drop the claims-index entry. `zRem` of a non-member is a no-op
  // (returns 0).
  await deps.redis.zRem(claimsIndexKey(sub), [thingId]);

  return {};
}
