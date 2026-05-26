/**
 * Claims module for ModSync. The "claim" subsystem owns the
 * collision-avoidance primitives that every menu / form / executor flow
 * relies on. See `.kiro/specs/modsync/design.md` "Claim handler
 * algorithm" and "Concurrency and Collision Counting".
 *
 * Storage shape (per-install, per `.kiro/steering/02-modsync-architecture.md`):
 *   - `claims:{sub}:{thingId}` — STRING(JSON) `{ moderator, claimedAt }`,
 *     90s TTL via `redis.set(..., { expiration: Date })`. There is one
 *     key per Thing.
 *   - `claims-index:{sub}` — SORTED SET, member = `thingId`,
 *     score = absolute expiry-ms (`now + CLAIM_TTL_SEC * 1000`). Devvit
 *     Redis has no `SCAN`; the index is the only way to enumerate active
 *     claims, and the score is also the "is this still alive?" filter
 *     (entries whose score is below `now` have already expired).
 *
 * Realtime shape:
 *   - Channel name: `claims-{sub}` (hyphens, never colons — Devvit
 *     Realtime forbids `:` in channel names; see 01-build-truth.md).
 *   - Every successful `claim` and `release` publishes exactly one
 *     `RealtimeEvent` whose payload mirrors the resulting Redis state
 *     (Property 2). Refresh publishes a `claim` event (the new
 *     `claimedAt` and `ttlSec` are the up-to-date facts).
 *
 * Dependency injection:
 *   - The module never imports `@devvit/web/server` directly. Callers
 *     (route handlers in `src/server/routes/**`) inject a `RedisLike`
 *     and a `RealtimeLike`. Tests inject the in-memory fake from
 *     `tests/_fakes/redisFake.ts` plus a recording realtime fake.
 *   - A `now()` clock is also injectable so tests can pin time.
 *     Defaults to `Date.now`.
 *
 * Failure semantics:
 *   - `claim` / `refresh` / `release` first do the Redis writes that
 *     mutate state, then publish. If the publish fails, the Redis state
 *     is already consistent — clients will reconcile via the next
 *     `/api/claims` refetch (see design.md "Failure Modes"). We
 *     deliberately do NOT wrap the publish in a try/catch here; the
 *     `realtime.send` wrapper in 4.3 handles that swallow+log.
 */

import {
  CLAIM_TTL_SEC,
  type ClaimRecord,
  type RealtimeEvent,
  type ThingId,
} from "../shared/types";
import { claimKey, claimsIndexKey } from "./redisKeys";

/** Cap on entries returned by `listActiveClaims`. */
const ACTIVE_CLAIMS_MAX = 200;

/** Reason recorded on a `release` realtime event. */
export type ReleaseReason = "completed" | "expired" | "manual";

/**
 * Minimal Redis surface this module uses. Tracks Devvit-Web 0.12.24 per
 * `01-build-truth.md` ("Installed SDK API surface"). The in-memory fake
 * structurally satisfies this interface.
 */
export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: { expiration?: Date; nx?: boolean; xx?: boolean },
  ): Promise<string>;
  del(...keys: string[]): Promise<void>;
  zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number>;
  zRem(key: string, members: string[]): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    opts?: {
      by?: "score" | "rank" | "lex";
      reverse?: boolean;
      limit?: { offset: number; count: number };
    },
  ): Promise<{ member: string; score: number }[]>;
  zScore(key: string, member: string): Promise<number | undefined>;
}

/**
 * Minimal Realtime surface. The wrapper in `src/server/realtime.ts`
 * (task 4.3) calls `realtime.send` from `@devvit/web/server`; here we
 * accept any object with that method so tests can record publishes.
 */
export interface RealtimeLike {
  send(channel: string, msg: RealtimeEvent): Promise<void>;
}

/** Injected dependencies. `now` defaults to `Date.now`. */
export interface ClaimsDeps {
  redis: RedisLike;
  realtime: RealtimeLike;
  now?: () => number;
}

/** Channel name for claim/release broadcasts. Hyphens are mandatory. */
function claimsChannel(sub: string): string {
  return `claims-${sub}`;
}

/**
 * Compute remaining TTL in seconds from an absolute expiry-ms. Floors at
 * 0 (callers never see a negative TTL; an entry that has expired is
 * filtered out at the index-read level instead).
 *
 * This is also the value reported in `RealtimeEvent.ttlSec` and in the
 * `getClaim` / `listActiveClaims` return shape. It is recomputed on
 * every read — the stored record itself only carries `claimedAt`.
 */
function ttlSecFromExpiry(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/**
 * Acquire (or overwrite) the claim on `thingId` for `mod`. Always wins —
 * collision detection is the *caller's* responsibility (see the menu
 * handler in 4.2, which checks `getClaim()` first and routes to a soft
 * warning instead of overwriting). This module's job is just to write
 * the claim, update the active-claims index, and publish.
 */
export async function claim(
  sub: string,
  thingId: ThingId,
  mod: string,
  deps: ClaimsDeps,
): Promise<ClaimRecord> {
  const now = deps.now ?? Date.now;
  const claimedAt = now();
  const expiresAtMs = claimedAt + CLAIM_TTL_SEC * 1000;
  const record: ClaimRecord = { moderator: mod, claimedAt };

  await deps.redis.set(claimKey(sub, thingId), JSON.stringify(record), {
    expiration: new Date(expiresAtMs),
  });
  await deps.redis.zAdd(claimsIndexKey(sub), {
    member: thingId,
    score: expiresAtMs,
  });

  await deps.realtime.send(claimsChannel(sub), {
    type: "claim",
    thingId,
    moderator: mod,
    claimedAt,
    ttlSec: CLAIM_TTL_SEC,
  });

  return record;
}

/**
 * Manually release a claim. Used by:
 *   - the executor on combo completion (`reason: "completed"`)
 *   - explicit user actions (`reason: "manual"`)
 *   - lazy expiry sweeps (`reason: "expired"`)
 *
 * Idempotent: releasing a key that's already gone still publishes a
 * `release` event so any client that missed the original release event
 * still converges. The realtime payload carries the moderator that the
 * caller asserts owned the claim — `release` is fire-and-forget; it
 * does NOT validate ownership against Redis (the caller is expected to
 * have done that already, e.g. inside the executor).
 *
 * Property 2: exactly one realtime event per call, regardless of
 * whether the key existed. Property 4: after this returns the key is
 * gone AND the index does not contain `thingId`.
 */
export async function release(
  sub: string,
  thingId: ThingId,
  reason: ReleaseReason,
  mod: string,
  deps: ClaimsDeps,
): Promise<void> {
  await deps.redis.del(claimKey(sub, thingId));
  await deps.redis.zRem(claimsIndexKey(sub), [thingId]);

  await deps.realtime.send(claimsChannel(sub), {
    type: "release",
    thingId,
    moderator: mod,
    reason,
  });
}

/**
 * Refresh an existing claim — extend its TTL by another full
 * `CLAIM_TTL_SEC`. Used by the executor between steps so a long combo
 * does not let the claim expire under the moderator's feet.
 *
 * Implementation is `claim()` with a fresh `claimedAt`. The realtime
 * event is a `claim` event (the type is what the client uses to update
 * its in-memory map; "refresh" is not a distinct event type per the
 * `RealtimeEvent` union in `src/shared/types.ts`).
 *
 * Property 4 (refresh half): `claimedAt2 > claimedAt1` whenever the
 * caller's `now()` strictly advances between calls; the index score
 * for `thingId` becomes `now() + 90000ms`.
 */
export async function refresh(
  sub: string,
  thingId: ThingId,
  mod: string,
  deps: ClaimsDeps,
): Promise<ClaimRecord> {
  return claim(sub, thingId, mod, deps);
}

/**
 * Read a single claim. Returns `null` if the key is absent (which, due
 * to Devvit-Redis lazy expiry, includes the post-90s case).
 *
 * The returned `ttlSec` is recomputed at read time from the index score
 * (which is the absolute expiry-ms) when the key is present in the
 * index, OR conservatively from `claimedAt + 90000` when the index is
 * missing — the latter case shouldn't happen in production but keeps
 * `getClaim` resilient if the index gets out of sync.
 */
export async function getClaim(
  sub: string,
  thingId: ThingId,
  deps: ClaimsDeps,
): Promise<(ClaimRecord & { ttlSec: number }) | null> {
  const now = deps.now ?? Date.now;
  const raw = await deps.redis.get(claimKey(sub, thingId));
  if (raw === undefined) return null;

  const record = JSON.parse(raw) as ClaimRecord;
  const expiry = await deps.redis.zScore(claimsIndexKey(sub), thingId);
  const expiresAtMs =
    expiry !== undefined ? expiry : record.claimedAt + CLAIM_TTL_SEC * 1000;
  const ttlSec = ttlSecFromExpiry(expiresAtMs, now());

  // If the key is somehow alive but the index says it's already past
  // expiry, treat it as gone. (Devvit Redis would normally evict the
  // key for us, but the index is the canonical "live" oracle here.)
  if (ttlSec === 0) return null;

  return { ...record, ttlSec };
}

/**
 * Enumerate every live claim for `sub`. Capped at
 * `ACTIVE_CLAIMS_MAX` (200) per the spec — this is the bound applied at
 * the API boundary in `/api/claims`.
 *
 * Implementation: `zRange claims-index:{sub}` filtered by score >= now
 * (so expired entries fall off without needing physical eviction),
 * then a single `get` per surviving member to fetch the JSON record.
 *
 * Returns a map keyed by `ThingId` so callers don't have to re-key the
 * array client-side. Members whose underlying STRING key has already
 * been TTL-evicted (race window) are silently skipped — the index will
 * be zRem'd next time `release` runs against them, or pruned by a
 * future periodic sweep (not in scope for 4.1).
 */
export async function listActiveClaims(
  sub: string,
  deps: ClaimsDeps,
): Promise<Record<ThingId, ClaimRecord & { ttlSec: number }>> {
  const now = deps.now ?? Date.now;
  const cutoff = now();

  // `by: "score"` with a lower bound of `cutoff` filters expired entries
  // out at the source. `+inf` is the conventional unbounded upper edge.
  // `limit` enforces the 200 cap at the index level so we don't even
  // round-trip extra `get`s.
  const members = await deps.redis.zRange(
    claimsIndexKey(sub),
    cutoff,
    "+inf",
    {
      by: "score",
      limit: { offset: 0, count: ACTIVE_CLAIMS_MAX },
    },
  );

  const out: Record<string, ClaimRecord & { ttlSec: number }> = {};
  for (const { member, score } of members) {
    const raw = await deps.redis.get(claimKey(sub, member));
    if (raw === undefined) continue;
    let record: ClaimRecord;
    try {
      record = JSON.parse(raw) as ClaimRecord;
    } catch {
      // Corrupt JSON — skip rather than throwing (defensive; would
      // never happen against our own writers).
      continue;
    }
    const ttlSec = ttlSecFromExpiry(score, cutoff);
    if (ttlSec === 0) continue;
    out[member] = { ...record, ttlSec };
  }

  return out as Record<ThingId, ClaimRecord & { ttlSec: number }>;
}
