/**
 * Metrics module for ModSync (task 5.1). Counts soft warnings, collision
 * detections, and redundant-action-avoided events per ISO week per
 * subreddit, and aggregates them up to a calendar month on read.
 *
 * Sources of truth:
 *   - `.kiro/specs/modsync/design.md` "Concurrency and Collision
 *     Counting" + "Property 9: Metrics counter routing and zero-state
 *     aggregation".
 *   - `.kiro/steering/02-modsync-architecture.md` "Redis schema":
 *     `metrics:{sub}:{isoWeek}` is a HASH with three fields:
 *     `softWarningsShown`, `collisionsDetected`, `redundantActionsAvoided`.
 *
 * Bump path:
 *   - Exactly one `hIncrBy` per event. The week is derived from the
 *     injected `now()` clock via `isoWeekKey`. No read-modify-write.
 *
 * Read path:
 *   - `period === "week"`: one `hGetAll` against the current ISO week,
 *     fields parsed to numbers (missing fields default to 0).
 *   - `period === "month"`: enumerate the (up to 5-6) ISO weeks
 *     overlapping the current calendar month (UTC) by stepping in
 *     7-day increments from the Monday of the ISO week containing the
 *     first day of the month, dedupe via `isoWeekKey`, then `hGetAll`
 *     each and sum the three counters across all weeks.
 *
 * Dependency injection:
 *   - The module never imports `@devvit/web/server` directly. Callers
 *     (route handler in `src/server/routes/api.ts`, task 5.2) inject
 *     a `RedisLike` exposing the two methods this module uses
 *     (`hIncrBy`, `hGetAll`). Tests inject the in-memory fake from
 *     `tests/_fakes/redisFake.ts`.
 *   - A `now()` clock is also injectable so tests can pin time.
 *     Defaults to `Date.now`.
 */

import type { MetricsBucket } from "../shared/types";
import { isoWeekKey, metricsKey } from "./redisKeys";

/** The three event kinds that drive the metrics counters. */
export type MetricKind = "softWarning" | "collision" | "redundantAvoided";

/**
 * Map from event kind to the `MetricsBucket` field it increments. Locked
 * by `design.md` "Concurrency and Collision Counting" — do not rename
 * fields without updating both ends.
 */
const FIELD_FOR: Record<MetricKind, keyof MetricsBucket> = {
  softWarning: "softWarningsShown",
  collision: "collisionsDetected",
  redundantAvoided: "redundantActionsAvoided",
};

/**
 * Minimal Redis surface this module uses. Tracks Devvit-Web 0.12.24 per
 * `01-build-truth.md` ("Installed SDK API surface"). The in-memory fake
 * structurally satisfies this interface.
 */
export interface RedisLike {
  hIncrBy(key: string, field: string, value: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

/** Bundle of injected dependencies + optional clock. */
export interface MetricsDeps {
  redis: RedisLike;
  now?: () => number;
}

/**
 * Increment exactly one counter on `metrics:{sub}:{isoWeekKey(now)}`.
 * Runs exactly one `hIncrBy` against the field that maps to `kind`.
 */
export async function bumpMetric(
  sub: string,
  kind: MetricKind,
  deps: MetricsDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const week = isoWeekKey(new Date(now()));
  const field = FIELD_FOR[kind];
  await deps.redis.hIncrBy(metricsKey(sub, week), field, 1);
}

/**
 * Parse a single counter field from an `hGetAll` result, defaulting to
 * 0 if missing or non-numeric. Field-by-field so a partial bucket
 * (only one counter ever bumped) doesn't reset the other two to NaN.
 */
function parseField(h: Record<string, string>, field: string): number {
  const raw = h[field];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Build a `MetricsBucket` from a raw HASH result. */
function parseBucket(h: Record<string, string>): MetricsBucket {
  return {
    softWarningsShown: parseField(h, "softWarningsShown"),
    collisionsDetected: parseField(h, "collisionsDetected"),
    redundantActionsAvoided: parseField(h, "redundantActionsAvoided"),
  };
}

/** `YYYY-MM` periodKey for the calendar month containing `d` (UTC). */
function monthPeriodKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

const MS_PER_DAY = 86_400_000;

/**
 * Enumerate ISO week keys overlapping the calendar month containing
 * `d` (UTC), deduped. Walks Mondays starting from the Monday of the
 * ISO week that contains the first day of the month, stepping by 7
 * days, until past the last day of the month.
 *
 * Most months overlap 4-5 ISO weeks; a 31-day month starting on
 * Sat/Sun can overlap 6. The dedupe + `<= lastDay` cutoff means we
 * never emit a key for a week that doesn't actually overlap the month.
 */
function weeksOverlappingMonth(d: Date): string[] {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1));
  // Day 0 of the next month resolves to the last day of `month`.
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  // ISO weekday: Mon=1..Sun=7 (JS `getUTCDay()` is Sun=0..Sat=6).
  const dayOfWeek = firstDay.getUTCDay() || 7;
  const mondayMs = firstDay.getTime() - (dayOfWeek - 1) * MS_PER_DAY;

  const seen = new Set<string>();
  const out: string[] = [];
  for (
    let cursor = mondayMs;
    cursor <= lastDay.getTime();
    cursor += 7 * MS_PER_DAY
  ) {
    const k = isoWeekKey(new Date(cursor));
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Read the metrics bucket for the current ISO week or calendar month.
 *
 * `period === "week"`: one `hGetAll` against the current ISO week.
 * `period === "month"`: aggregate up to 5-6 ISO weeks overlapping the
 * current calendar month, summing the three counters across them.
 *
 * Missing fields default to 0 so a brand-new install never throws.
 */
export async function getMetrics(
  sub: string,
  period: "week" | "month",
  deps: MetricsDeps,
): Promise<MetricsBucket & { period: "week" | "month"; periodKey: string }> {
  const now = deps.now ?? Date.now;
  const nowDate = new Date(now());

  if (period === "week") {
    const week = isoWeekKey(nowDate);
    const h = await deps.redis.hGetAll(metricsKey(sub, week));
    return { ...parseBucket(h), period, periodKey: week };
  }

  // period === "month"
  const periodKey = monthPeriodKey(nowDate);
  const weeks = weeksOverlappingMonth(nowDate);
  const buckets = await Promise.all(
    weeks.map((w) => deps.redis.hGetAll(metricsKey(sub, w))),
  );
  let soft = 0;
  let coll = 0;
  let red = 0;
  for (const h of buckets) {
    soft += parseField(h, "softWarningsShown");
    coll += parseField(h, "collisionsDetected");
    red += parseField(h, "redundantActionsAvoided");
  }
  return {
    softWarningsShown: soft,
    collisionsDetected: coll,
    redundantActionsAvoided: red,
    period,
    periodKey,
  };
}
