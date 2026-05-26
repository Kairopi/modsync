/**
 * Demo seed endpoint for the ModSync hackathon submission video. Runs
 * inside `POST /api/dev/seed` (wired into the route tree by a future
 * integration task — `tasks.md` task 10.1's body lists
 * `src/server/routes/devSeed.ts`, but the user's prompt for this leaf
 * scoped the deliverable to ONLY `src/server/seed.ts` + the test file).
 *
 * Algorithm (per design.md "Demo Seed"):
 *   1. Read the `seedEnabled` app setting via the injected
 *      `getSeedEnabled()` callback. If false, return `{ created: 0 }`
 *      immediately — no Reddit calls, no side effects. This is the
 *      "off by default; flipped on in the test sub before judging"
 *      gate from the spec.
 *   2. For `i in [0, count)`:
 *      a. `reddit.submitPost({ title: '[ModSync demo {i}]', runAs: 'APP' })`
 *      b. `reddit.report(post.id, { reason: 'demo' })` — surfaces the
 *         post in the modqueue so the demo video has something to
 *         click through.
 *      c. Sleep `delayMs` (default 1500) BETWEEN submissions to stay
 *         under Reddit's per-account rate limiter. Tests pass
 *         `delayMs: 0` to skip the pause entirely.
 *   3. Return `{ created: number }` — count of posts whose `submitPost`
 *      succeeded. If anything throws mid-loop, the loop stops and the
 *      partial count is returned WITHOUT propagating the error.
 *
 * Dependency injection:
 *   - `reddit` carries the two SDK calls we need. Production wiring
 *     closes over the per-request `reddit` from `@devvit/web/server`
 *     (which already knows the subreddit context). Tests inject a
 *     recording fake that captures every call's args.
 *   - `getSeedEnabled` is a thunk over the app setting. Production
 *     reads `redis.get('settings:seedEnabled') === 'true'` (or wherever
 *     `01-modsync-architecture.md` ends up putting the setting). Tests
 *     toggle by returning a constant.
 *   - `now` is reserved for deterministic logging or future jitter;
 *     not currently used by the algorithm. Kept on the interface so
 *     future enhancements can pin time without changing call sites.
 *   - `delayMs` defaults to 1500ms in production. Tests pass 0.
 */

export interface SeedSubmitOpts {
  title: string;
  runAs: "APP";
}

export interface SeedReddit {
  submitPost(opts: SeedSubmitOpts): Promise<{ id: string }>;
  report(thingId: string, opts?: { reason?: string }): Promise<void>;
}

export interface SeedDeps {
  reddit: SeedReddit;
  getSeedEnabled: () => Promise<boolean>;
  now?: () => number;
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 1500;

/**
 * Run the demo seed. Returns `{ created }` even on partial failure —
 * never throws. Caller (the `/api/dev/seed` route handler) maps the
 * result into a JSON response.
 */
export async function seedDemo(
  count: number,
  deps: SeedDeps,
): Promise<{ created: number }> {
  const enabled = await deps.getSeedEnabled();
  if (!enabled) {
    return { created: 0 };
  }

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  let created = 0;

  for (let i = 0; i < count; i++) {
    let postId: string;
    try {
      const post = await deps.reddit.submitPost({
        title: `[ModSync demo ${i}]`,
        runAs: "APP",
      });
      postId = post.id;
      created++;
    } catch {
      // submitPost failure stops the loop; return the partial count
      // WITHOUT propagating the error (per the spec's "no exception
      // propagation" acceptance signal).
      return { created };
    }

    try {
      await deps.reddit.report(postId, { reason: "demo" });
    } catch {
      // Same swallow-and-stop posture for report failures. The submit
      // already succeeded, so `created` was incremented above.
      return { created };
    }

    // Wait BETWEEN submissions, not after the last one. Skipped when
    // `delayMs === 0` so tests run instantly.
    if (delayMs > 0 && i < count - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }

  return { created };
}
