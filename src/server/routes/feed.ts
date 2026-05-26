/**
 * `/api/feed` route module (task 7.2). Exports `registerFeedRoute`
 * which wires `GET /api/feed?limit=N` onto a caller-owned Hono app.
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/tasks.md` task 7.2.
 *   - `.kiro/specs/modsync/design.md` "Server endpoints" + "Activity
 *     Feed".
 *   - `.kiro/steering/02-modsync-architecture.md` "Critical gotchas":
 *     `requireMod` is on EVERY menu, form, and mutating /api endpoint.
 *     The feed is a read endpoint but still mod-only — non-moderators
 *     must not be able to enumerate moderator action history.
 *
 * Mirrors the structure of `routes/metrics.ts` (task 5.2) so the
 * production wiring story stays uniform across read endpoints.
 *
 * Handler flow (matches task 7.2):
 *
 *   1. Resolve the current subreddit name via `deps.getSub()`. In
 *      production this returns `context.subredditName` from
 *      `@devvit/web/server`; tests inject a fake. The route module
 *      MUST NOT import `@devvit/web/server` directly.
 *
 *   2. Run the auth gate via `deps.auth({ sub })`. Mimics
 *      `requireMod` from `../auth.ts`. `ForbiddenError` is mapped to
 *      403 with body `{ error: "forbidden" }` — and crucially with
 *      ZERO Redis reads (Property 10 — "no side effects on throw"
 *      carried forward to the route layer; this is what the
 *      403-path test asserts via `vi.spyOn` on the redis fake).
 *
 *   3. Parse the `limit` query param. Default 50, max 500. Any
 *      non-number / negative / zero value falls back to the default
 *      (50). Values above 500 are clamped to 500 (the
 *      `MAX_FEED_ENTRIES` cap on `actions:{sub}`). Locked behavior:
 *      a malformed `?limit=abc` does NOT 400 — the dashboard would
 *      rather render the default page than display an error toast,
 *      same UX posture as 5.2.
 *
 *   4. Call `deps.feed.readFeed(sub, limit)`. The injected `feed`
 *      service is pre-bound to its own redis (and optional
 *      read-time scrub layer from task 9.2) so this route module
 *      never sees those dependencies. Return as JSON 200.
 *
 * All other thrown errors (Reddit API failure, Redis transport
 * error, etc.) re-throw so Hono's default error handler maps them to
 * 500. Only `ForbiddenError` is mapped to 403 here.
 */

import type { Hono } from "hono";
import { ForbiddenError } from "../auth.js";
import type { ActionEntry } from "../../shared/types.js";

/** Default `?limit` when the param is absent or malformed. */
const DEFAULT_LIMIT = 50;

/**
 * Hard cap on `?limit`. Matches `MAX_FEED_ENTRIES` on the storage
 * layer — `actions:{sub}` is capped at 500, so requesting more than
 * 500 cannot return additional rows.
 */
const MAX_LIMIT = 500;

/**
 * Auth callable shape — mimics `requireMod` from `../auth.ts`.
 * Production wiring uses `(ctx) => requireMod(ctx, { redis, reddit })`.
 * Tests inject a `vi.fn()`.
 */
export type AuthFn = (ctx: {
  sub: string;
}) => Promise<{ user: string; sub: string }>;

/** Pre-bound feed surface — production wiring closes over `feedDeps`. */
export interface FeedService {
  readFeed(sub: string, limit: number): Promise<ActionEntry[]>;
}

/** Injected dependencies for `registerFeedRoute`. */
export interface FeedRouteDeps {
  auth: AuthFn;
  feed: FeedService;
  /**
   * Returns the current request's subreddit name. In production this
   * closes over `() => context.subredditName` from
   * `@devvit/web/server`; tests inject a fixed string getter.
   */
  getSub: () => string;
}

/**
 * Coerce the raw `?limit=` query string into a clamped integer.
 *
 * Rules (locked by tests in `tests/routes.feed.spec.ts`):
 *   - Absent / undefined → DEFAULT_LIMIT (50).
 *   - Non-numeric (e.g. `"abc"`) → DEFAULT_LIMIT.
 *   - Zero or negative → DEFAULT_LIMIT.
 *   - Above MAX_LIMIT → clamped to MAX_LIMIT.
 *   - Otherwise → floored to integer.
 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  if (n <= 0) return DEFAULT_LIMIT;
  const floored = Math.floor(n);
  return floored > MAX_LIMIT ? MAX_LIMIT : floored;
}

/**
 * Wire `GET /api/feed?limit=N` onto `app`. Idempotent only if called
 * once per app instance — Hono allows duplicate registrations but
 * they would all run, breaking the auth-once invariant.
 */
export function registerFeedRoute(app: Hono, deps: FeedRouteDeps): void {
  app.get("/api/feed", async (c) => {
    const sub = deps.getSub();

    // Step 2 — auth gate. ForbiddenError -> 403 with zero Redis reads
    // (Property 10). Other throws bubble to the default 500 path.
    try {
      await deps.auth({ sub });
    } catch (err) {
      if (
        err instanceof ForbiddenError ||
        (err instanceof Error && err.name === "ForbiddenError")
      ) {
        return c.json({ error: "forbidden" }, 403);
      }
      throw err;
    }

    // Step 3 — parse limit (default 50, max 500, malformed -> 50).
    const limit = parseLimit(c.req.query("limit"));

    // Step 4 — read feed (uses the injected pre-bound service).
    const entries = await deps.feed.readFeed(sub, limit);

    return c.json(entries, 200);
  });
}
