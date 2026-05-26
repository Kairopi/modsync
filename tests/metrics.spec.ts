import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  bumpMetric,
  getMetrics,
  type MetricKind,
  type MetricsDeps,
} from "../src/server/metrics.js";
import { isoWeekKey, metricsKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Metrics-module tests for `tasks.md` task 5.1. Two property tests at
 * 100 fast-check iterations each (Property 9 from `design.md` —
 * "Metrics counter routing and zero-state aggregation"), plus a small
 * example test for the month-aggregation path.
 *
 *   - **Property 9 (full)**: `forall random sequence of (kind, ts)
 *     events. for each event exactly one HINCRBY occurs against
 *     metrics:{sub}:{isoWeekKey(ts)}.{counterFor(kind)}; final hash
 *     totals equal counts grouped by (week, kind). Then `getMetrics`
 *     for the week of the last event returns counts that match the
 *     events whose ISO week equals that week.
 *
 *   - **Property 9 (zero-state)**: `forall sub with no metric keys
 *     written. getMetrics(sub, 'week') and getMetrics(sub, 'month')
 *     both return all-zero counters with the matching periodKey,
 *     without throwing.
 *
 * **Validates: Requirements 3.4, 8.1, 8.2, 8.3, 8.4 — see Property 9
 * in `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Bundle redis + clock under test. */
function makeDeps(initial: number): {
  deps: MetricsDeps;
  redis: RedisFake;
  setNow: (t: number) => void;
} {
  let nowMs = initial;
  const redis = makeRedisFake({ now: () => nowMs });
  return {
    deps: { redis, now: () => nowMs },
    redis,
    setNow(t) {
      nowMs = t;
    },
  };
}

const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
const kindArb: fc.Arbitrary<MetricKind> = fc.constantFrom(
  "softWarning",
  "collision",
  "redundantAvoided",
);
// Field name corresponding to a kind.
const FIELD_FOR: Record<MetricKind, keyof Record<string, number>> = {
  softWarning: "softWarningsShown",
  collision: "collisionsDetected",
  redundantAvoided: "redundantActionsAvoided",
};

// Range: 2020-01-01 .. 2030-12-31 (UTC) in ms-epoch. Wide enough to
// span multiple ISO years; tight enough that fast-check shrinking
// stays interpretable.
const TS_MIN = Date.UTC(2020, 0, 1);
const TS_MAX = Date.UTC(2030, 11, 31);
const tsArb = fc.integer({ min: TS_MIN, max: TS_MAX });

// ---------------------------------------------------------------------------
// Property 9 (full) — exactly-once HINCRBY routing + read consistency
// ---------------------------------------------------------------------------

describe("Property 9 (full): bumpMetric routes exactly one HINCRBY to the right week+field", () => {
  test("forall sequence of (kind, ts) events: one hIncrBy per event, totals match grouped counts", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        fc.array(
          fc.record({ kind: kindArb, ts: tsArb }),
          { minLength: 1, maxLength: 30 },
        ),
        async (sub, events) => {
          const { deps, redis, setNow } = makeDeps(events[0]!.ts);

          // Run the full sequence, checking the recording counter
          // increments by exactly 1 per event.
          let expectedIncrCount = 0;
          for (const ev of events) {
            setNow(ev.ts);
            const before = redis._writes.hIncrBy;
            await bumpMetric(sub, ev.kind, deps);
            expectedIncrCount += 1;
            // Exactly one hIncrBy per bumpMetric call.
            expect(redis._writes.hIncrBy - before).toBe(1);
            expect(redis._writes.hIncrBy).toBe(expectedIncrCount);
          }

          // Build the expected (week, field) -> count map by replaying
          // the events directly.
          const expected = new Map<string, Map<string, number>>();
          for (const ev of events) {
            const week = isoWeekKey(new Date(ev.ts));
            const field = FIELD_FOR[ev.kind] as string;
            const bucket = expected.get(week) ?? new Map<string, number>();
            bucket.set(field, (bucket.get(field) ?? 0) + 1);
            expected.set(week, bucket);
          }

          // Read each week's hash from the fake and assert it matches
          // the replayed expectation exactly. Unbumped fields are
          // absent (we never write zeros).
          for (const [week, bucket] of expected.entries()) {
            const stored = await redis.hGetAll(metricsKey(sub, week));
            for (const [field, count] of bucket.entries()) {
              expect(Number(stored[field])).toBe(count);
            }
            // No extra fields beyond the ones we bumped.
            for (const f of Object.keys(stored)) {
              expect(bucket.has(f)).toBe(true);
            }
          }

          // getMetrics(sub, 'week') for the week of the last event
          // reflects the counts grouped by (that week, kind).
          const lastTs = events[events.length - 1]!.ts;
          setNow(lastTs);
          const lastWeek = isoWeekKey(new Date(lastTs));
          const result = await getMetrics(sub, "week", deps);
          expect(result.period).toBe("week");
          expect(result.periodKey).toBe(lastWeek);

          const lastWeekBucket = expected.get(lastWeek) ?? new Map();
          expect(result.softWarningsShown).toBe(
            lastWeekBucket.get("softWarningsShown") ?? 0,
          );
          expect(result.collisionsDetected).toBe(
            lastWeekBucket.get("collisionsDetected") ?? 0,
          );
          expect(result.redundantActionsAvoided).toBe(
            lastWeekBucket.get("redundantActionsAvoided") ?? 0,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9 (zero-state) — empty install never throws
// ---------------------------------------------------------------------------

describe("Property 9 (zero-state): getMetrics on empty install returns all-zero counters", () => {
  test("forall sub with no metric keys: week+month both return zeros without throwing", async () => {
    await fc.assert(
      fc.asyncProperty(subArb, tsArb, async (sub, ts) => {
        const { deps } = makeDeps(ts);

        const week = await getMetrics(sub, "week", deps);
        expect(week.softWarningsShown).toBe(0);
        expect(week.collisionsDetected).toBe(0);
        expect(week.redundantActionsAvoided).toBe(0);
        expect(week.period).toBe("week");
        // periodKey for week is the ISO week of `ts`.
        expect(week.periodKey).toBe(isoWeekKey(new Date(ts)));

        const month = await getMetrics(sub, "month", deps);
        expect(month.softWarningsShown).toBe(0);
        expect(month.collisionsDetected).toBe(0);
        expect(month.redundantActionsAvoided).toBe(0);
        expect(month.period).toBe("month");
        // periodKey for month is YYYY-MM (UTC).
        const d = new Date(ts);
        const expected = `${d.getUTCFullYear()}-${String(
          d.getUTCMonth() + 1,
        ).padStart(2, "0")}`;
        expect(month.periodKey).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke / example tests — month aggregation path
// ---------------------------------------------------------------------------

describe("getMetrics(sub, 'month') aggregates ISO weeks overlapping the calendar month", () => {
  test("sums counters across all weeks that overlap the month", async () => {
    // Pin to mid-October 2025 (UTC). October 2025 overlaps these ISO
    // weeks (each Monday is the start): 2025-W40 (Sep 29), 2025-W41
    // (Oct 6), 2025-W42 (Oct 13), 2025-W43 (Oct 20), 2025-W44 (Oct 27).
    const midOct = Date.UTC(2025, 9, 15); // 2025-10-15
    const { deps, setNow } = makeDeps(midOct);

    // Bump one event in each of three different weeks.
    setNow(Date.UTC(2025, 9, 1)); // in 2025-W40
    await bumpMetric("Modsynnow", "softWarning", deps);
    setNow(Date.UTC(2025, 9, 8)); // in 2025-W41
    await bumpMetric("Modsynnow", "softWarning", deps);
    setNow(Date.UTC(2025, 9, 8)); // in 2025-W41
    await bumpMetric("Modsynnow", "collision", deps);
    setNow(Date.UTC(2025, 9, 22)); // in 2025-W43
    await bumpMetric("Modsynnow", "redundantAvoided", deps);
    setNow(Date.UTC(2025, 9, 22)); // in 2025-W43
    await bumpMetric("Modsynnow", "redundantAvoided", deps);

    setNow(midOct);
    const month = await getMetrics("Modsynnow", "month", deps);
    expect(month.period).toBe("month");
    expect(month.periodKey).toBe("2025-10");
    expect(month.softWarningsShown).toBe(2);
    expect(month.collisionsDetected).toBe(1);
    expect(month.redundantActionsAvoided).toBe(2);
  });

  test("week scope only returns the current ISO week's counters", async () => {
    const midOct = Date.UTC(2025, 9, 15); // in 2025-W42
    const { deps, setNow } = makeDeps(midOct);

    // Bump in 2025-W42 (the current week relative to `midOct`).
    setNow(Date.UTC(2025, 9, 14));
    await bumpMetric("Modsynnow", "collision", deps);
    // Bump in a different week.
    setNow(Date.UTC(2025, 9, 1));
    await bumpMetric("Modsynnow", "collision", deps);

    setNow(midOct);
    const week = await getMetrics("Modsynnow", "week", deps);
    expect(week.period).toBe("week");
    expect(week.periodKey).toBe(isoWeekKey(new Date(midOct)));
    // Only the W42 bump shows up here.
    expect(week.collisionsDetected).toBe(1);
    expect(week.softWarningsShown).toBe(0);
    expect(week.redundantActionsAvoided).toBe(0);
  });
});
