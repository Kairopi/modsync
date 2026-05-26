/**
 * `onCommentDelete` trigger handler — Reddit Rules / Devpost compliance.
 *
 * Mirror of `postDelete.ts` for comment Things. See that file for the
 * full design discussion; this handler only differs in:
 *   - the body type (`OnCommentDeleteRequest` from `@devvit/web/shared`)
 *   - the field read from the body (`commentId`, prefixed `t1_…`)
 *
 * Same three idempotent side-effects: purge feed entries, drop the
 * live claim STRING, drop the claims-index entry. Same lack of auth
 * gate (Devvit invokes triggers internally). Same dep-injected
 * `redis` — no `reddit`, no `realtime`.
 */

import type {
  OnCommentDeleteRequest,
  TriggerResponse,
} from "@devvit/web/shared";
import type { ThingId } from "../../shared/types";
import { purgeByThingId, type FeedDeps } from "../feed";
import { claimKey, claimsIndexKey } from "../redisKeys";
import type { TriggerDeps } from "./postDelete";

/**
 * Handle an `onCommentDelete` trigger event.
 *
 * Reads `subreddit.name` and `commentId` from the protobuf-shaped
 * trigger body. Reddit's `commentId` is already prefixed `t1_…`, so
 * it's used directly as a `ThingId` in our key paths.
 *
 * Returns the empty `TriggerResponse` (`{}`).
 */
export async function onCommentDelete(
  body: OnCommentDeleteRequest,
  deps: TriggerDeps,
): Promise<TriggerResponse> {
  const sub = body.subreddit?.name ?? "";
  // CommentDelete payloads carry `commentId` already prefixed `t1_`.
  const thingId = body.commentId as ThingId;

  const feedDeps: FeedDeps = { redis: deps.redis };
  await purgeByThingId(sub, thingId, feedDeps);
  await deps.redis.del(claimKey(sub, thingId));
  await deps.redis.zRem(claimsIndexKey(sub), [thingId]);

  return {};
}
