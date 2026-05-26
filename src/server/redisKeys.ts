/**
 * Redis key builders + ISO 8601 week derivation for ModSync.
 *
 * Sources of truth:
 *   - `.kiro/specs/modsync/design.md` "Data Models" / "Concurrency and
 *     Collision Counting" (the `isoWeekKey` algorithm is copied verbatim
 *     from that section).
 *   - `.kiro/steering/02-modsync-architecture.md` "Redis schema".
 *
 * Devvit Redis is per-install namespaced, so every key still embeds the
 * subreddit name (`{sub}`) so that downstream tests can exercise multiple
 * subs against a single in-memory fake without cross-contamination.
 *
 * Key paths use `:` as a separator. Realtime channel names (a different
 * concern, see `src/server/realtime.ts`) use `-` because Devvit Realtime
 * forbids `:` in channel names — that constraint does NOT apply here.
 */

import type { ThingId } from "../shared/types";

/** `claims:{sub}:{thingId}` — STRING (JSON), TTL 90s, one per item. */
export function claimKey(sub: string, thingId: ThingId | string): string {
  return `claims:${sub}:${thingId}`;
}

/**
 * `claims-index:{sub}` — SORTED SET, member = thingId, score = expiry-ms.
 *
 * Used by `listActiveClaims` (task 4.1) to enumerate active claims via
 * `zRangeByScore (now, +inf)` since Devvit Redis has no SCAN.
 */
export function claimsIndexKey(sub: string): string {
  return `claims-index:${sub}`;
}

/** `actions:{sub}` — SORTED SET capped at 500 (newest by score). */
export function actionsKey(sub: string): string {
  return `actions:${sub}`;
}

/** `combos:{sub}` — HASH, field = combo name, value = JSON `ComboSpec`. */
export function combosKey(sub: string): string {
  return `combos:${sub}`;
}

/**
 * `metrics:{sub}:{isoWeek}` — HASH with `softWarningsShown` /
 * `collisionsDetected` / `redundantActionsAvoided` counters. The `isoWeek`
 * portion is produced by `isoWeekKey` and is therefore safe to embed
 * directly (`YYYY-Www`, no separators that collide with the key format).
 */
export function metricsKey(sub: string, isoWeek: string): string {
  return `metrics:${sub}:${isoWeek}`;
}

/**
 * `mods:{sub}` — HASH, field = moderator username, value = `"1"`.
 * Populated by `requireMod` (task 3.1) on cache miss.
 */
export function modsKey(sub: string): string {
  return `mods:${sub}`;
}

/**
 * `mods-expiry:{sub}` — STRING sentinel, TTL 300s. Existence gates
 * `mods:{sub}` freshness in `requireMod`.
 */
export function modsExpiryKey(sub: string): string {
  return `mods-expiry:${sub}`;
}

/**
 * `deleted-mods:{sub}` — HASH, field = username, value = `"1"`.
 * Populated lazily by the read-time scrub in `src/server/scrub.ts`
 * (task 9.2).
 */
export function deletedModsKey(sub: string): string {
  return `deleted-mods:${sub}`;
}

/**
 * Convert a `Date` to an ISO 8601 week key (`YYYY-Www`) in UTC.
 *
 * Algorithm copied verbatim from design.md "Concurrency and Collision
 * Counting". The trick: shift to the Thursday of the same ISO week
 * (Mon-Sun, where Sunday = 7), then count whole weeks since Jan 1 of the
 * resulting year. The Thursday-shift is what lets a date like 2005-01-01
 * (a Saturday) correctly land in 2004-W53 — the Thursday of that week
 * is 2004-12-30, so `date.getUTCFullYear()` becomes 2004.
 *
 * Cross-checked against the ISO 8601 boundary cases listed in
 * `tests/redisKeys.spec.ts`.
 */
export function isoWeekKey(d: Date): string {
  // Normalize to UTC midnight so the week number doesn't drift across
  // local TZ boundaries.
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  // ISO weekday: Monday=1..Sunday=7 (JS `getUTCDay()` is Sun=0..Sat=6).
  const day = date.getUTCDay() || 7;
  // Shift to the Thursday of the current ISO week.
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
