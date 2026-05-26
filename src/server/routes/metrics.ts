/**
 * `/api/metrics` route module (task 5.2). Exports `registerMetricsRoute`
 * which wires `GET /api/metrics?period=week|month` onto a caller-owned
 * Hono app.
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/tasks.md` task 5.2.
 *   - `.kiro/specs/modsync/design.md` "Server endpoints" + "Concurrency
 *     and Collision Counting".
 *   - `.kiro/steering/02-modsync-architecture.md` "Critical gotchas":
 *     `requireMod` is on EVERY menu, form, and mutating /api endpoint;
 *     this read-only metrics endpoint follows the same posture so a
 *     non-mod cannot scrape collision counts.
 *
 * Handler flow (matches task 5.2 step list):
 *
 *   1. Resolve the current subreddit name via `deps.getSub()`. In
 *      production this returns `context.subredditName` from
 *      `@devvit/web/server`; tests inject a fake. The route module
 *      MUST NOT import `@devvit/web/server` directly — that would
 *      pull a global into the test harness.
 *
 *   2. Run the auth gate via `deps.auth({ sub })`. Mimics
 *      `requireMod` from `../auth.ts`. Throws `ForbiddenError` if the
 *      caller is not a moderator. We catch and emit 403 with no
 *      Redis reads (Property 10 — "no side effects on throw" carried
 *      forward to the route layer).
 *
 *   3. Parse the `period` query param. `?period=month` -> 'month',
 *      `?period=week` or any other value (including absent / invalid)
 *      -> 'week'. **Documented choice**: an invalid value is
 *      *gracefully fallback*ed to 'week' rather than rejected with
 *      400. Rationale: the metrics dashboard (task 6.4) would prefer
 *      to render the week view than display an error toast, and the
 *      week period is the spec's primary view (collision counts are
 *      bucketed weekly per `metrics:{sub}:{isoWeek}`).
 *
 *   4. Call `deps.metrics.getMetrics(sub, period)`. The injected
 *      `metrics` is pre-bound to its own redis + clock so this route
 *      module never sees those dependencies. Production wiring will
 *      adapt the bare `getMetrics(sub, period, metricsDeps)` from
 *      `../metrics.ts` to this 2-arity shape at register-time.
 *
 *   5. Return the result as JSON with status 200.
 *
 * All other thrown errors (Reddit API failure, Redis transport error,
 * etc.) re-throw so Hono's default error handler maps them to 500.
 * Only `ForbiddenError` is mapped to 403 here.
 */

import type { Hono } from "hono";
import { ForbiddenError } from "../auth.js";
import type { MetricsBucket } from "../../shared/types.js";

/** The two period scopes the endpoint accepts. */
export type MetricsPeriod = "week" | "month";

/** Shape returned by `getMetrics` and serialized verbatim by this route. */
export type MetricsResponse = MetricsBucket & {
  period: MetricsPeriod;
  periodKey: string;
};

/**
 * Auth callable shape — mimics `requireMod` from `../auth.ts`.
 * Production wiring uses `(ctx) => requireMod(ctx, { redis, reddit })`.
 * Tests inject a `vi.fn()`.
 */
export type AuthFn = (ctx: {
  sub: string;
}) => Promise<{ user: string; sub: string }>;

/** Pre-bound metrics surface — production wiring closes over `metricsDeps`. */
export interface MetricsService {
  getMetrics(sub: string, period: MetricsPeriod): Promise<MetricsResponse>;
}

/** Injected dependencies for `registerMetricsRoute`. */
export interface MetricsRouteDeps {
  auth: AuthFn;
  metrics: MetricsService;
  /**
   * Returns the current request's subreddit name. In production this
   * closes over `() => context.subredditName` from
   * `@devvit/web/server`; tests inject a fixed string getter.
   */
  getSub: () => string;
}

/**
 * Wire `GET /api/metrics?period=week|month` onto `app`. Idempotent only
 * if called once per app instance — Hono allows duplicate registrations
 * but they would all run, breaking the auth-once invariant.
 */
export function registerMetricsRoute(
  app: Hono,
  deps: MetricsRouteDeps,
): void {
  app.get("/api/metrics", async (c) => {
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

    // Step 3 — parse period. Invalid -> 'week' (documented graceful
    // fallback; see file-level docstring step 3).
    const raw = c.req.query("period");
    const period: MetricsPeriod = raw === "month" ? "month" : "week";

    // Step 4 — read metrics (uses the injected pre-bound service).
    const result = await deps.metrics.getMetrics(sub, period);

    // Step 5 — JSON response.
    return c.json(result, 200);
  });
}
