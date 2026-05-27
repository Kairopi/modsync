/**
 * Production wiring adapters for ModSync.
 *
 * Every spec module under `src/server/` is dependency-injected and
 * imports nothing from `@devvit/web/server`. This module is the single
 * place where the real Devvit `redis` / `realtime` / `reddit` /
 * `settings` / `context` clients are imported and adapted to the shapes
 * the spec modules expect.
 *
 * Adapter notes — these are the only places where the production
 * surface differs from the test fakes:
 *
 *   - `RedditClient.remove(id, isSpam)` — the real SDK's signature
 *     takes `(id, isSpam: boolean)`. The executor expects
 *     `remove(thingId)`. Adapter passes `isSpam: false`.
 *   - `RedditClient` has NO top-level `lock(id)` method. Lock is
 *     `Post.prototype.lock` / `Comment.prototype.lock`. Adapter
 *     fetches the thing by id then calls the instance method.
 *   - `RedditClient.banUser(opts)` takes `{ username, subredditName,
 *     duration, reason }` — NOT `{ thingId, days, by }`. Adapter
 *     looks up the post/comment author by `thingId`, then bans by
 *     username.
 *   - `RedditClient.addModNote(opts)` takes `{ subredditName, user,
 *     note, redditId, label }`. The executor calls with `{ thingId,
 *     text, label, by }`. Adapter resolves the author from thingId
 *     and re-shapes.
 *   - `RedditClient.getModerators({ subredditName })` returns a
 *     `Listing<User>`, not an array. Adapter calls `.all()` and
 *     maps to `{ username }[]`.
 *   - `RedditClient.getCurrentUser()` returns `User | undefined`.
 *     Adapter throws on undefined so `requireMod` sees a real error.
 *   - `RedditClient.getUserByUsername(name)` returns `User |
 *     undefined`. Adapter passes through; `scrub.ts` already treats
 *     undefined as "deleted".
 *   - `seed.ts` SeedReddit needs `report(thingId, { reason })`. Real
 *     SDK takes `report(post: Post, opts)`. Adapter fetches the
 *     post by id then reports.
 */

import {
  context,
  realtime as devvitRealtime,
  reddit as devvitReddit,
  redis as devvitRedis,
  settings as devvitSettings,
} from "@devvit/web/server";
import type { T1, T3 } from "@devvit/shared-types/tid.js";

import { requireMod, type RedditClient as AuthRedditClient } from "./auth.js";
import { type ClaimsDeps } from "./claims.js";
import { type CombosDeps } from "./combos.js";
import { type ExecutorDeps, type RedditClient as ExecutorRedditClient } from "./executor.js";
import { type FeedDeps } from "./feed.js";
import { type MetricsDeps } from "./metrics.js";
import { type ScrubDeps, type RedditClient as ScrubRedditClient } from "./scrub.js";
import { scrubEntry } from "./scrub.js";
import { type SeedReddit } from "./seed.js";
import type { ThingId } from "../shared/types.js";

/**
 * The real Devvit `redis` client structurally satisfies every
 * `RedisLike` interface the spec modules declare (because each one
 * picks a subset of the same SDK surface). Cast once here so the
 * assignment-site widening doesn't need `as` everywhere.
 */
/** Cast helper — Devvit's redis client has every method our modules need. */
function asRedis<T>(): T {
  return devvitRedis as unknown as T;
}

/** Resolve the per-request subreddit name from Devvit context. */
export function getSub(): string {
  return context.subredditName ?? "";
}

/** Adapter for `auth.RedditClient`. */
export function authRedditAdapter(): AuthRedditClient {
  return {
    async getCurrentUser() {
      const u = await devvitReddit.getCurrentUser();
      if (!u) throw new Error("No current user");
      return { username: u.username };
    },
    async getModerators(sub: string) {
      const listing = devvitReddit.getModerators({ subredditName: sub });
      const all = await listing.all();
      return all.map((u) => ({ username: u.username }));
    },
  };
}

/** Build the auth callback used by every gated route/handler. */
export function buildAuth(): () => Promise<{ user: string; sub: string }> {
  return async () => {
    const sub = getSub();
    return requireMod(
      { sub },
      {
        redis: asRedis<Parameters<typeof requireMod>[1]["redis"]>(),
        reddit: authRedditAdapter(),
      },
    );
  };
}

/** ClaimsDeps factory — closes over the real redis + realtime + Date.now. */
export function buildClaimsDeps(): ClaimsDeps {
  return {
    redis: asRedis<ClaimsDeps["redis"]>(),
    realtime: {
      send: (channel, msg) => devvitRealtime.send(channel, msg as never),
    },
    now: Date.now,
  };
}

/** MetricsDeps factory. */
export function buildMetricsDeps(): MetricsDeps {
  return {
    redis: asRedis<MetricsDeps["redis"]>(),
    now: Date.now,
  };
}

/** CombosDeps factory. */
export function buildCombosDeps(): CombosDeps {
  return { redis: asRedis<CombosDeps["redis"]>() };
}

/** FeedDeps factory — wires the optional scrub layer (task 9.2). */
export function buildFeedDeps(): FeedDeps {
  return {
    redis: asRedis<FeedDeps["redis"]>(),
    scrub: {
      scrubEntry,
      deps: buildScrubDeps(),
    },
  };
}

/** ScrubDeps factory. */
export function buildScrubDeps(): ScrubDeps {
  const reddit: ScrubRedditClient = {
    async getUserByUsername(username: string) {
      const u = await devvitReddit.getUserByUsername(username);
      // Devvit's User has no isSuspended/isDeleted booleans in this
      // SDK version; the scrub module treats `undefined` return as
      // a positive deletion signal, which covers the common case.
      if (!u) return null;
      return {};
    },
  };
  return {
    redis: asRedis<ScrubDeps["redis"]>(),
    reddit,
  };
}

/**
 * Resolve a `ThingId` to its author's username. Used by BAN and
 * MODNOTE adapters which need the author rather than the thing id.
 */
async function resolveAuthor(thingId: ThingId): Promise<string> {
  if (thingId.startsWith("t3_")) {
    const post = await devvitReddit.getPostById(thingId as unknown as T3);
    return post.authorName ?? "";
  }
  const comment = await devvitReddit.getCommentById(thingId as unknown as T1);
  return comment.authorName ?? "";
}

/** ExecutorDeps factory — translates `runCombo`'s reddit calls. */
export function buildExecutorDeps(): ExecutorDeps {
  const sub = getSub();
  const reddit: ExecutorRedditClient = {
    async remove(thingId) {
      // Real SDK signature is `remove(id: T1 | T3, isSpam: boolean)`.
      await devvitReddit.remove(thingId as unknown as T1 | T3, false);
    },
    async approve(thingId) {
      await devvitReddit.approve(thingId as unknown as T1 | T3);
    },
    async lock(thingId) {
      // Real SDK has no top-level lock; fetch the thing then call
      // the instance method.
      if (thingId.startsWith("t3_")) {
        const post = await devvitReddit.getPostById(thingId as unknown as T3);
        await post.lock();
      } else {
        const comment = await devvitReddit.getCommentById(
          thingId as unknown as T1,
        );
        await comment.lock();
      }
    },
    async banUser(opts) {
      const username = await resolveAuthor(opts.thingId);
      if (username === "") return;
      await devvitReddit.banUser({
        username,
        subredditName: sub,
        duration: opts.days,
        reason: opts.reason,
      });
    },
    async addModNote(opts) {
      const username = await resolveAuthor(opts.thingId);
      if (username === "") return;
      // Real SDK: addModNote({ subredditName, user, note, redditId, label }).
      const noteOpts: {
        subredditName: string;
        user: string;
        note: string;
        redditId: T1 | T3;
        label?: typeof opts.label;
      } = {
        subredditName: sub,
        user: username,
        note: opts.text,
        redditId: opts.thingId as unknown as T1 | T3,
      };
      if (opts.label !== undefined) {
        noteOpts.label = opts.label;
      }
      await devvitReddit.addModNote(noteOpts as never);
    },
  };

  return {
    redis: asRedis<ExecutorDeps["redis"]>(),
    realtime: {
      send: (channel, msg) => devvitRealtime.send(channel, msg as never),
    },
    reddit,
    now: Date.now,
  };
}

/** Build the SeedReddit adapter for `seedDemo`. */
export function buildSeedReddit(): SeedReddit {
  const sub = getSub();
  return {
    async submitPost(opts) {
      const post = await devvitReddit.submitPost({
        subredditName: sub,
        title: opts.title,
        runAs: opts.runAs,
        // Self-post text body (required for non-custom posts).
        text: "ModSync demo seed post.",
      } as never);
      return { id: post.id };
    },
    async report(thingId, opts) {
      // Real SDK: report(thing: Post | Comment, options).
      if (thingId.startsWith("t3_")) {
        const post = await devvitReddit.getPostById(thingId as unknown as T3);
        await devvitReddit.report(post, { reason: opts?.reason ?? "demo" });
      } else if (thingId.startsWith("t1_")) {
        const comment = await devvitReddit.getCommentById(
          thingId as unknown as T1,
        );
        await devvitReddit.report(comment, { reason: opts?.reason ?? "demo" });
      }
    },
  };
}

/** Read the `seedEnabled` setting (defaults to false). */
export async function getSeedEnabled(): Promise<boolean> {
  try {
    const v = await devvitSettings.get("seedEnabled");
    return v === true;
  } catch {
    return false;
  }
}
