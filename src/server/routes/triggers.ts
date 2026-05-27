/**
 * Production wiring for Devvit `/internal/trigger/*` endpoints.
 *
 * Three triggers, all dispatched to spec-module handlers in
 * `src/server/triggers/`:
 *   - onAppInstall    -> warm-fill mods cache + seed default combos +
 *                        create the dashboard custom post
 *   - onPostDelete    -> compliance: purge audit feed + drop claim
 *   - onCommentDelete -> same for comments
 *
 * No `requireMod` gate — Devvit invokes triggers internally; there is
 * no end-user identity to authenticate.
 */

import { Hono } from "hono";
import type {
  OnAppInstallRequest,
  OnCommentDeleteRequest,
  OnPostDeleteRequest,
} from "@devvit/web/shared";
import { reddit as devvitReddit, redis as devvitRedis } from "@devvit/web/server";

import { DEFAULT_COMBOS } from "../defaultCombos.js";
import { onAppInstall } from "../triggers/appInstall.js";
import { onCommentDelete } from "../triggers/commentDelete.js";
import { onPostDelete } from "../triggers/postDelete.js";
import type { TriggerDeps } from "../triggers/postDelete.js";
import type { RedisLike as AppInstallRedis, RedditClient as AppInstallReddit } from "../triggers/appInstall.js";

export const triggers = new Hono();

function buildTriggerDeps(): TriggerDeps {
  return { redis: devvitRedis as unknown as TriggerDeps["redis"] };
}

function buildAppInstallReddit(): AppInstallReddit {
  return {
    async getModerators(sub: string) {
      const listing = devvitReddit.getModerators({ subredditName: sub });
      const all = await listing.all();
      return all.map((u) => ({ username: u.username }));
    },
    async submitPost(opts) {
      const post = await devvitReddit.submitPost({
        subredditName: opts.subredditName,
        title: opts.title,
        // The post block is registered in devvit.json; passing
        // `postData` keys it to the custom-post entrypoint. Use a
        // text fallback so non-Devvit Reddit clients render
        // something sane.
        text: "ModSync — open in the Reddit app to view the dashboard.",
      } as never);
      return { id: post.id };
    },
  };
}

triggers.post("/app-install", async (c) => {
  const body = await c.req.json<OnAppInstallRequest>();
  const deps = {
    redis: devvitRedis as unknown as AppInstallRedis,
    reddit: buildAppInstallReddit(),
    createPostOnInstall: true,
    defaultCombos: DEFAULT_COMBOS,
  };
  const res = await onAppInstall(body, deps);
  return c.json(res);
});

triggers.post("/post-delete", async (c) => {
  const body = await c.req.json<OnPostDeleteRequest>();
  const res = await onPostDelete(body, buildTriggerDeps());
  return c.json(res);
});

triggers.post("/comment-delete", async (c) => {
  const body = await c.req.json<OnCommentDeleteRequest>();
  const res = await onCommentDelete(body, buildTriggerDeps());
  return c.json(res);
});
