import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";
import { Hono } from "hono";

import {
  registerMetricsRoute,
  type AuthFn,
  type MetricsResponse,
  type MetricsRouteDeps,
} from "../src/server/routes/metrics.js";
import {
  bumpMetric,
  getMetrics,
  type MetricKind,
  type MetricsDeps,
} from "../src/server/metrics.js";
import { ForbiddenError } from "../src/server/auth.js";
import { isoWeekKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Tests for `tasks.md` task 5.2 — `/api/metrics` endpoint.
 *
 * Coverage:
 *   - 403 path: `auth` throws ForbiddenError → handler returns 403,
 *     ZERO Redis reads (assert via `vi.spyOn` on the redis fake).
 *   - 200 with empty bucket: `getMetrics` returns all-zero, handler
 *     returns 200 with the zero bucket and the right periodKey.
 *   - 200 with seeded data: `bumpMetric` against the real metrics
 *     module → endpoint output matches.
 *   - Query param parsing: `?period=month` → calls getMetrics with
 *     'month'; default → 'week'; invalid → 'week' (documented
 *     graceful fallback in `routes/metrics.ts`).
 *   - PBT (≥100 iter): forall (period, sub, sequence of bumps).
 *     endpoint output deepEquals `getMetrics(sub, period)` direct
 *     call.
 *
 * **Validates: Properties 9 (route-level read consistency) and 10
 * (auth gate has no side effects on throw).**
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build an app + deps wired against a real `getMetrics` closure over
 * the injected redis fake and clock. The route deps' `metrics` field
 * is the production-shape pre-bound service; the redis fake is the
 * one returned to the caller for assertions.
 */
function makeApp(opts: {
  authImpl: AuthFn;
  sub: string;
  initialNow: number;
}): {
  app: Hono;
  redis: RedisFake;
  setNow: (t: number) => void;
  metricsDeps: MetricsDeps;
  authFn: AuthFn;
} {
  let nowMs = opts.initialNow;
  const redis = makeRedisFake({ now: () => nowMs });
  const metricsDeps: MetricsDeps = { redis, now: () => nowMs };
  const authFn = vi.fn(opts.authImpl);

  const deps: MetricsRouteDeps = {
    auth: authFn,
    metrics: {
      getMetrics: (sub, period) => getMetrics(sub, period, metricsDeps),
    },
    getSub: () => opts.sub,
  };

  const app = new Hono();
  registerMetricsRoute(app, deps);

  return {
    app,
    redis,
    setNow(t) {
      nowMs = t;
    },
    metricsDeps,
    authFn,
  };
}

const SUB = "Modsynnow";

async function call(
  app: Hono,
  query?: string,
): Promise<{ status: number; body: unknown }> {
  const url = `http://x/api/metrics${query ? `?${query}` : ""}`;
  const res = await app.fetch(new Request(url));
  // 403 path returns a JSON error envelope; 200 returns MetricsResponse.
  // Both have JSON content; parse uniformly.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 403 path — auth throws → no Redis reads
// ---------------------------------------------------------------------------

describe("403: auth throws ForbiddenError → handler returns 403 with zero Redis reads", () => {
  test("returns 403 and never invokes redis on the throw path", async () => {
    const { app, redis, authFn } = makeApp({
      authImpl: async ({ sub }) => {
        throw new ForbiddenError("intruder", sub);
      },
      sub: SUB,
      initialNow: Date.UTC(2025, 9, 15),
    });

    // Wrap every read method on the fake to assert zero invocations.
    const hGetAllSpy = vi.spyOn(redis, "hGetAll");
    const hGetSpy = vi.spyOn(redis, "hGet");
    const getSpy = vi.spyOn(redis, "get");
    const existsSpy = vi.spyOn(redis, "exists");
    const zRangeSpy = vi.spyOn(redis, "zRange");
    const zScoreSpy = vi.spyOn(redis, "zScore");
    const hKeysSpy = vi.spyOn(redis, "hKeys");

    const { status, body } = await call(app);
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });

    expect(authFn).toHaveBeenCalledTimes(1);
    // Critical: not a single redis read on the throw path.
    expect(hGetAllSpy).not.toHaveBeenCalled();
    expect(hGetSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
    expect(zRangeSpy).not.toHaveBeenCalled();
    expect(zScoreSpy).not.toHaveBeenCalled();
    expect(hKeysSpy).not.toHaveBeenCalled();
    // And no writes either (nothing in this handler writes anyway,
    // but lock the invariant in case the route ever gains telemetry).
    expect(redis._writes.hSet).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.set).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 200 path — empty bucket
// ---------------------------------------------------------------------------

describe("200 (empty install): handler returns the all-zero bucket", () => {
  test("week: returns zeros + isoWeekKey(now)", async () => {
    const now = Date.UTC(2025, 9, 15);
    const { app } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: now,
    });

    const { status, body } = await call(app, "period=week");
    expect(status).toBe(200);
    expect(body).toEqual({
      softWarningsShown: 0,
      collisionsDetected: 0,
      redundantActionsAvoided: 0,
      period: "week",
      periodKey: isoWeekKey(new Date(now)),
    });
  });

  test("month: returns zeros + YYYY-MM", async () => {
    const now = Date.UTC(2025, 9, 15);
    const { app } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: now,
    });

    const { status, body } = await call(app, "period=month");
    expect(status).toBe(200);
    expect(body).toEqual({
      softWarningsShown: 0,
      collisionsDetected: 0,
      redundantActionsAvoided: 0,
      period: "month",
      periodKey: "2025-10",
    });
  });
});

// ---------------------------------------------------------------------------
// 200 path — seeded data
// ---------------------------------------------------------------------------

describe("200 (seeded data): handler returns aggregated counters", () => {
  test("returns counts matching the bumped events for week scope", async () => {
    const midOct = Date.UTC(2025, 9, 15); // 2025-W42
    const { app, metricsDeps, setNow } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: midOct,
    });

    // Seed three bumps inside the same ISO week as `midOct`.
    setNow(Date.UTC(2025, 9, 14));
    await bumpMetric(SUB, "softWarning", metricsDeps);
    await bumpMetric(SUB, "softWarning", metricsDeps);
    await bumpMetric(SUB, "collision", metricsDeps);

    setNow(midOct);
    const { status, body } = await call(app, "period=week");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      softWarningsShown: 2,
      collisionsDetected: 1,
      redundantActionsAvoided: 0,
      period: "week",
      periodKey: isoWeekKey(new Date(midOct)),
    });
  });

  test("returns aggregated counts across multiple weeks for month scope", async () => {
    const midOct = Date.UTC(2025, 9, 15);
    const { app, metricsDeps, setNow } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: midOct,
    });

    // Seed in three different ISO weeks, all in October 2025.
    setNow(Date.UTC(2025, 9, 1));
    await bumpMetric(SUB, "softWarning", metricsDeps);
    setNow(Date.UTC(2025, 9, 8));
    await bumpMetric(SUB, "collision", metricsDeps);
    setNow(Date.UTC(2025, 9, 22));
    await bumpMetric(SUB, "redundantAvoided", metricsDeps);
    await bumpMetric(SUB, "redundantAvoided", metricsDeps);

    setNow(midOct);
    const { status, body } = await call(app, "period=month");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      softWarningsShown: 1,
      collisionsDetected: 1,
      redundantActionsAvoided: 2,
      period: "month",
      periodKey: "2025-10",
    });
  });
});

// ---------------------------------------------------------------------------
// Query param parsing
// ---------------------------------------------------------------------------

describe("query param parsing", () => {
  test("?period=month → calls getMetrics with 'month'", async () => {
    const now = Date.UTC(2025, 9, 15);
    const { app } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: now,
    });

    const { status, body } = await call(app, "period=month");
    expect(status).toBe(200);
    expect((body as MetricsResponse).period).toBe("month");
  });

  test("missing period → defaults to 'week'", async () => {
    const now = Date.UTC(2025, 9, 15);
    const { app } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: now,
    });

    const { status, body } = await call(app);
    expect(status).toBe(200);
    expect((body as MetricsResponse).period).toBe("week");
  });

  test("invalid period (e.g. ?period=year) → graceful fallback to 'week'", async () => {
    // Documented in `src/server/routes/metrics.ts` step 3 of the
    // file-level docstring: invalid values fall back to 'week' rather
    // than 400, so the dashboard always renders.
    const now = Date.UTC(2025, 9, 15);
    const { app } = makeApp({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: now,
    });

    const { status, body } = await call(app, "period=year");
    expect(status).toBe(200);
    expect((body as MetricsResponse).period).toBe("week");
    expect((body as MetricsResponse).periodKey).toBe(
      isoWeekKey(new Date(now)),
    );
  });
});

// ---------------------------------------------------------------------------
// Property test (≥100 iter): endpoint output deepEquals direct getMetrics
// ---------------------------------------------------------------------------

describe("Property: endpoint output deepEquals getMetrics direct call", () => {
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const periodArb: fc.Arbitrary<"week" | "month"> = fc.constantFrom(
    "week",
    "month",
  );
  const kindArb: fc.Arbitrary<MetricKind> = fc.constantFrom(
    "softWarning",
    "collision",
    "redundantAvoided",
  );
  // Tighten ts range to a single calendar month so month-scope and
  // week-scope assertions don't drift across bucket boundaries while
  // shrinking. October 2025 (UTC).
  const tsArb = fc.integer({
    min: Date.UTC(2025, 9, 1),
    max: Date.UTC(2025, 9, 31, 23, 59, 59),
  });
  const eventArb = fc.record({ kind: kindArb, ts: tsArb });

  test("forall (sub, period, events): endpoint deepEquals direct getMetrics", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        periodArb,
        fc.array(eventArb, { minLength: 0, maxLength: 12 }),
        tsArb,
        async (sub, period, events, readTs) => {
          const { app, metricsDeps, setNow, authFn } = makeApp({
            authImpl: async ({ sub: s }) => ({ user: "alice", sub: s }),
            sub,
            initialNow: readTs,
          });

          // Seed bumps at their declared timestamps.
          for (const ev of events) {
            setNow(ev.ts);
            await bumpMetric(sub, ev.kind, metricsDeps);
          }

          // Pin both the route handler clock and the direct-call
          // clock to the same readTs.
          setNow(readTs);
          const direct = await getMetrics(sub, period, metricsDeps);

          const { status, body } = await call(
            app,
            `period=${period}`,
          );
          expect(status).toBe(200);
          expect(body).toEqual(direct);
          expect(authFn).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
