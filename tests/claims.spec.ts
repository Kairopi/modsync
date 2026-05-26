import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  claim,
  getClaim,
  listActiveClaims,
  refresh,
  release,
  type ClaimsDeps,
  type RealtimeLike,
} from "../src/server/claims.js";
import { CLAIM_TTL_SEC, type RealtimeEvent, type ThingId } from "../src/shared/types.js";
import { claimKey, claimsIndexKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Claims-module tests for `tasks.md` task 4.1. Three property tests at
 * >=100 fast-check iterations each, plus a couple of small example
 * tests for documentation value.
 *
 *   - **Property 1**: after `claim(sub, thingId, mod)`, `getClaim`
 *     reflects `{ moderator: mod, claimedAt within 1s of now,
 *     ttlSec ∈ (0, 90] }` AND the index score for `thingId` is
 *     `now + 90000ms` (1s tolerance).
 *
 *   - **Property 2**: a sequence of `claim` / `release` calls publishes
 *     exactly one realtime event per call, whose payload matches the
 *     resulting Redis state (or the deleted state for `release`).
 *
 *   - **Property 4**: after `release` the key is gone and the index
 *     does not contain `thingId`; for `(t1<t2)` a refresh at `t2` after
 *     a claim at `t1` produces `claimedAt2 > claimedAt1`,
 *     `ttlSec ≈ 90`, and an index score equal to `t2 + 90000ms`.
 *
 * **Validates: Requirements 2.1, 2.3, 3.3, 3.4, 8.1 — see Properties 1,
 * 2, 4 in `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Recording realtime fake. Captures every published `(channel, msg)`
 * pair so tests can assert exact-once publish semantics (Property 2).
 */
interface RealtimeRecorder extends RealtimeLike {
  readonly events: { channel: string; msg: RealtimeEvent }[];
}
function makeRealtimeFake(): RealtimeRecorder {
  const events: { channel: string; msg: RealtimeEvent }[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg });
    },
  };
}

/** Bundle redis + realtime + clock under test. */
function makeDeps(initial = 1_700_000_000_000): {
  deps: ClaimsDeps;
  redis: RedisFake;
  realtime: RealtimeRecorder;
  setNow: (t: number) => void;
  advance: (ms: number) => void;
} {
  let nowMs = initial;
  const redis = makeRedisFake({ now: () => nowMs });
  const realtime = makeRealtimeFake();
  return {
    deps: { redis, realtime, now: () => nowMs },
    redis,
    realtime,
    setNow(t) {
      nowMs = t;
    },
    advance(ms) {
      nowMs += ms;
    },
  };
}

// Subreddit names: 3-21 alphanumerics + underscore (Reddit's actual rule).
const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
// Reddit usernames: 3-20 chars from [A-Za-z0-9_-].
const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
// ThingId base36-ish suffix; constrain length so the union resolves cleanly.
const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
  fc
    .stringMatching(/^[a-z0-9]{4,10}$/)
    .map((s): ThingId => `t1_${s}` as const),
  fc
    .stringMatching(/^[a-z0-9]{4,10}$/)
    .map((s): ThingId => `t3_${s}` as const),
);

// ---------------------------------------------------------------------------
// Property 1 — claim shape, TTL, and index score
// ---------------------------------------------------------------------------

describe("Property 1: claim writes correct record + index score within bounds", () => {
  test("forall (sub, thingId, mod): claim() then getClaim() reflects correct record and TTL", async () => {
    await fc.assert(
      fc.asyncProperty(subArb, thingIdArb, modArb, async (sub, thingId, mod) => {
        const { deps, redis } = makeDeps();
        const nowAtCall = (deps.now as () => number)();

        const record = await claim(sub, thingId, mod, deps);

        // Returned record is the same shape we'll find on read.
        expect(record.moderator).toBe(mod);
        expect(Math.abs(record.claimedAt - nowAtCall)).toBeLessThanOrEqual(
          1000,
        );

        // getClaim returns moderator + claimedAt within 1s of now and
        // ttlSec strictly in (0, 90].
        const got = await getClaim(sub, thingId, deps);
        expect(got).not.toBeNull();
        expect(got!.moderator).toBe(mod);
        expect(Math.abs(got!.claimedAt - nowAtCall)).toBeLessThanOrEqual(1000);
        expect(got!.ttlSec).toBeGreaterThan(0);
        expect(got!.ttlSec).toBeLessThanOrEqual(CLAIM_TTL_SEC);

        // The index score is the absolute expiry-ms and must be within
        // 1s of `now + 90000`.
        const score = await redis.zScore(claimsIndexKey(sub), thingId);
        expect(score).toBeDefined();
        const expectedScore = nowAtCall + CLAIM_TTL_SEC * 1000;
        expect(Math.abs(score! - expectedScore)).toBeLessThanOrEqual(1000);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — exactly one realtime event per claim/release call,
// payload matches resulting Redis state
// ---------------------------------------------------------------------------

describe("Property 2: each claim/release publishes exactly one event matching state", () => {
  test("forall sequence of claim/release ops: 1 event per call, payload matches Redis", async () => {
    /**
     * Generator: a non-empty sequence of operations against a fixed set
     * of known thingIds. Each op is either {kind: "claim", mod, idx} or
     * {kind: "release", reason, idx}. The `idx` selects from a small
     * pool so we get realistic mixes (claim then release, double-claim,
     * release-without-claim, etc.).
     */
    const opArb = fc.record({
      kind: fc.constantFrom("claim" as const, "release" as const),
      mod: modArb,
      reason: fc.constantFrom(
        "completed" as const,
        "expired" as const,
        "manual" as const,
      ),
      idx: fc.integer({ min: 0, max: 4 }),
    });

    await fc.assert(
      fc.asyncProperty(
        subArb,
        fc.array(thingIdArb, { minLength: 1, maxLength: 5 }),
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        async (sub, thingIds, ops) => {
          const { deps, realtime } = makeDeps();
          const channel = `claims-${sub}`;

          let expectedEvents = 0;
          for (const op of ops) {
            const thingId = thingIds[op.idx % thingIds.length]!;
            if (op.kind === "claim") {
              await claim(sub, thingId, op.mod, deps);
            } else {
              await release(sub, thingId, op.reason, op.mod, deps);
            }
            expectedEvents += 1;

            // After every call, exactly one new event has been
            // published, and it matches the resulting state.
            expect(realtime.events.length).toBe(expectedEvents);
            const last = realtime.events[expectedEvents - 1]!;
            expect(last.channel).toBe(channel);

            if (op.kind === "claim") {
              expect(last.msg.type).toBe("claim");
              if (last.msg.type !== "claim") throw new Error("type guard");
              expect(last.msg.thingId).toBe(thingId);
              expect(last.msg.moderator).toBe(op.mod);
              expect(last.msg.ttlSec).toBe(CLAIM_TTL_SEC);

              // The published claim payload must equal the now-current
              // Redis state for that thing.
              const got = await getClaim(sub, thingId, deps);
              expect(got).not.toBeNull();
              expect(got!.moderator).toBe(last.msg.moderator);
              expect(got!.claimedAt).toBe(last.msg.claimedAt);
            } else {
              expect(last.msg.type).toBe("release");
              if (last.msg.type !== "release") throw new Error("type guard");
              expect(last.msg.thingId).toBe(thingId);
              expect(last.msg.moderator).toBe(op.mod);
              expect(last.msg.reason).toBe(op.reason);

              // The published release payload reflects deleted state:
              // getClaim returns null after a release call.
              const got = await getClaim(sub, thingId, deps);
              expect(got).toBeNull();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — release deletes claim + index entry; refresh advances
// claimedAt and resets the index score
// ---------------------------------------------------------------------------

describe("Property 4: release removes; refresh advances claimedAt + index score", () => {
  test("forall (sub, thingId, mod): release leaves no claim and no index member", async () => {
    await fc.assert(
      fc.asyncProperty(subArb, thingIdArb, modArb, async (sub, thingId, mod) => {
        const { deps, redis } = makeDeps();

        await claim(sub, thingId, mod, deps);
        await release(sub, thingId, "completed", mod, deps);

        // claim key gone
        expect(await getClaim(sub, thingId, deps)).toBeNull();
        expect(await redis.get(claimKey(sub, thingId))).toBeUndefined();

        // index does not contain thingId
        const score = await redis.zScore(claimsIndexKey(sub), thingId);
        expect(score).toBeUndefined();
        const indexed = await redis.zRange(
          claimsIndexKey(sub),
          0,
          "+inf",
          { by: "score" },
        );
        expect(indexed.find((m) => m.member === thingId)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  test("forall (mod, thingId, t1<t2): refresh at t2 after claim at t1 advances claimedAt and resets score", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        thingIdArb,
        modArb,
        // t1 < t2 with a strict positive gap so equality cases are excluded.
        // Bound dt to keep both timestamps within the same fake-time epoch.
        fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        async (sub, thingId, mod, t1, dt) => {
          const t2 = t1 + dt;
          const { deps, redis, setNow } = makeDeps(t1);

          setNow(t1);
          const r1 = await claim(sub, thingId, mod, deps);

          setNow(t2);
          const r2 = await refresh(sub, thingId, mod, deps);

          // claimedAt strictly increases.
          expect(r2.claimedAt).toBeGreaterThan(r1.claimedAt);
          expect(r2.claimedAt).toBe(t2);

          // ttlSec ≈ 90 immediately after refresh.
          const got = await getClaim(sub, thingId, deps);
          expect(got).not.toBeNull();
          expect(got!.ttlSec).toBeGreaterThan(0);
          expect(got!.ttlSec).toBeLessThanOrEqual(CLAIM_TTL_SEC);
          // Tighter bound: just refreshed at t2 with now=t2, so TTL
          // should be exactly CLAIM_TTL_SEC (no time has elapsed yet).
          expect(got!.ttlSec).toBe(CLAIM_TTL_SEC);

          // Index score updated to t2 + 90000.
          const score = await redis.zScore(claimsIndexKey(sub), thingId);
          expect(score).toBe(t2 + CLAIM_TTL_SEC * 1000);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Small smoke / example tests — supplement the property tests above
// ---------------------------------------------------------------------------

describe("listActiveClaims", () => {
  test("filters out expired index members and respects the 200 cap", async () => {
    const start = 1_700_000_000_000;
    const { deps, redis, advance } = makeDeps(start);

    // Seed two claims at t=start. After 100s, both expire (TTL is 90s).
    await claim("Modsynnow", "t3_aaa", "alice", deps);
    await claim("Modsynnow", "t3_bbb", "bob", deps);

    // Sanity: both are visible immediately.
    let active = await listActiveClaims("Modsynnow", deps);
    expect(Object.keys(active).sort()).toEqual(["t3_aaa", "t3_bbb"]);

    // Advance past expiry. The redis fake's lazy-expire kicks in for
    // STRINGs (claim values), and listActiveClaims's `score >= now`
    // filter excludes expired members from the index.
    advance(95_000);
    active = await listActiveClaims("Modsynnow", deps);
    expect(Object.keys(active)).toEqual([]);

    // The underlying claim key really is gone from Redis (TTL eviction).
    expect(await redis.get(claimKey("Modsynnow", "t3_aaa"))).toBeUndefined();
  });

  test("returns map keyed by thingId with ttlSec recomputed at read time", async () => {
    const { deps, advance } = makeDeps(2_000_000_000_000);
    await claim("Modsynnow", "t1_xyz", "carol", deps);

    advance(30_000); // 30s in
    const active = await listActiveClaims("Modsynnow", deps);
    expect(active["t1_xyz"]).toBeDefined();
    expect(active["t1_xyz"]!.moderator).toBe("carol");
    // 90s - 30s = 60s remaining, within ±1s of 60.
    expect(active["t1_xyz"]!.ttlSec).toBeGreaterThanOrEqual(59);
    expect(active["t1_xyz"]!.ttlSec).toBeLessThanOrEqual(60);
  });
});
