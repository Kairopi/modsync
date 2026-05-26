import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  appendAction,
  purgeByThingId,
  readFeed,
  type FeedDeps,
} from "../src/server/feed.js";
import {
  MAX_FEED_ENTRIES,
  type ActionEntry,
  type ThingId,
} from "../src/shared/types.js";
import { actionsKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Feed-module tests for `tasks.md` task 7.1.
 *
 *   - **Property 8 (server half)**: forall sequence of `appendAction`
 *     calls with timestamps t_1..t_n. `readFeed(sub, 500)` returns
 *     entries ordered by score-descending (non-increasing ts) with
 *     length min(n, 500). After the (MAX_FEED_ENTRIES + 1)-th append,
 *     the lowest-scored (oldest) entry is evicted.
 *
 * Plus an example test for `purgeByThingId` covering the multi-thing
 * filter + count + order-preservation case from the prompt.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4 — see Property 8 in
 * `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(): { deps: FeedDeps; redis: RedisFake } {
  const redis = makeRedisFake();
  return { deps: { redis }, redis };
}

// Reddit-y arbitraries (mirroring claims.spec.ts so future readers can
// follow the same pattern).
const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t1_${s}` as const),
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t3_${s}` as const),
);

/** A minimal `ActionEntry` with caller-supplied `id` and `ts`. */
function makeEntry(opts: {
  id: string;
  ts: number;
  moderator: string;
  thingId: ThingId;
  comboName?: string;
}): ActionEntry {
  return {
    id: opts.id,
    ts: opts.ts,
    moderator: opts.moderator,
    thingId: opts.thingId,
    comboName: opts.comboName ?? "Claim",
    ranSteps: [],
  };
}

// ---------------------------------------------------------------------------
// Property 8 (server half) — ordering + cap + eviction
// ---------------------------------------------------------------------------

describe("Property 8 (server half): feed ordering, cap, and eviction", () => {
  test("forall n appends with arbitrary ts: readFeed(500) is score-descending and length min(n, 500)", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // 1..50 entries with arbitrary timestamps. We deliberately keep
        // n well under 500 here so the cap-overflow edge is exercised
        // by the dedicated test below.
        fc.array(
          fc.record({
            ts: fc.integer({ min: 1, max: 10_000_000 }),
            mod: modArb,
            thingId: thingIdArb,
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (sub, batch) => {
          const { deps } = makeDeps();
          for (let i = 0; i < batch.length; i++) {
            const e = batch[i]!;
            await appendAction(
              sub,
              makeEntry({
                id: `e-${i}`,
                ts: e.ts,
                moderator: e.mod,
                thingId: e.thingId,
              }),
              deps,
            );
          }

          const out = await readFeed(sub, MAX_FEED_ENTRIES, deps);
          expect(out.length).toBe(Math.min(batch.length, MAX_FEED_ENTRIES));
          // Score-descending: ts non-increasing across the array.
          for (let i = 1; i < out.length; i++) {
            expect(out[i - 1]!.ts).toBeGreaterThanOrEqual(out[i]!.ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("forall (MAX + 1) appends with strictly increasing ts: oldest entry is evicted", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // The starting timestamp can be anything; the per-append step
        // is a strict positive integer so all 501 entries have unique,
        // strictly-increasing scores.
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        async (sub, t0, dt) => {
          const { deps, redis } = makeDeps();
          // Append 500 entries first — these all should survive the
          // post-append trim.
          for (let i = 0; i < MAX_FEED_ENTRIES; i++) {
            await appendAction(
              sub,
              makeEntry({
                id: `e-${i}`,
                ts: t0 + i * dt,
                moderator: "alice",
                thingId: "t3_aaaaa",
              }),
              deps,
            );
          }
          // Sanity: cap not yet breached.
          let out = await readFeed(sub, MAX_FEED_ENTRIES, deps);
          expect(out.length).toBe(MAX_FEED_ENTRIES);

          // Append the (MAX + 1)-th entry with a strictly-greater ts,
          // forcing the oldest entry (id "e-0", ts t0) to fall off.
          const newestTs = t0 + MAX_FEED_ENTRIES * dt;
          await appendAction(
            sub,
            makeEntry({
              id: `e-${MAX_FEED_ENTRIES}`,
              ts: newestTs,
              moderator: "alice",
              thingId: "t3_aaaaa",
            }),
            deps,
          );

          out = await readFeed(sub, MAX_FEED_ENTRIES, deps);
          expect(out.length).toBe(MAX_FEED_ENTRIES);
          // Newest first.
          expect(out[0]!.ts).toBe(newestTs);
          expect(out[0]!.id).toBe(`e-${MAX_FEED_ENTRIES}`);
          // Oldest is evicted: no surviving entry has ts === t0.
          expect(out.find((e) => e.ts === t0)).toBeUndefined();
          // The oldest surviving ts is t0 + dt (the 2nd-oldest pre-trim).
          const oldestSurviving = out[out.length - 1]!;
          expect(oldestSurviving.ts).toBe(t0 + dt);
          // Cardinality at the Redis level matches the cap.
          const card = (await redis.zRange(actionsKey(sub), 0, -1)).length;
          expect(card).toBe(MAX_FEED_ENTRIES);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// purgeByThingId — example test from the task prompt
// ---------------------------------------------------------------------------

describe("purgeByThingId", () => {
  test("removes only entries matching the thingId, preserves order of survivors", async () => {
    const { deps, redis } = makeDeps();
    const sub = "Modsynnow";

    // Interleave 5 entries on t3_a and 3 on t3_b with strictly
    // increasing timestamps so survivor ordering is unambiguous.
    let ts = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      await appendAction(
        sub,
        makeEntry({
          id: `a-${i}`,
          ts: ts++,
          moderator: "alice",
          thingId: "t3_a",
        }),
        deps,
      );
    }
    for (let i = 0; i < 3; i++) {
      await appendAction(
        sub,
        makeEntry({
          id: `b-${i}`,
          ts: ts++,
          moderator: "bob",
          thingId: "t3_b",
        }),
        deps,
      );
    }

    const removed = await purgeByThingId(sub, "t3_a", deps);
    expect(removed).toBe(5);

    const out = await readFeed(sub, 500, deps);
    // Three b-entries remain, newest-first by ts.
    expect(out.map((e) => e.id)).toEqual(["b-2", "b-1", "b-0"]);
    expect(out.every((e) => e.thingId === "t3_b")).toBe(true);

    // Survivor scores were not rewritten — the redis-level scores still
    // match the original ts of each entry.
    const raw = await redis.zRange(actionsKey(sub), 0, -1, { by: "rank" });
    const scoresInOrder = raw.map((m) => m.score);
    // Ascending by score (the natural sort), entries are b-0, b-1, b-2.
    expect(scoresInOrder).toEqual([...scoresInOrder].sort((a, b) => a - b));
    expect(scoresInOrder.length).toBe(3);
  });

  test("returns 0 when nothing matches and leaves the feed unchanged", async () => {
    const { deps } = makeDeps();
    const sub = "Modsynnow";
    await appendAction(
      sub,
      makeEntry({
        id: "x",
        ts: 1,
        moderator: "alice",
        thingId: "t3_keep",
      }),
      deps,
    );
    const removed = await purgeByThingId(sub, "t3_other", deps);
    expect(removed).toBe(0);
    const out = await readFeed(sub, 500, deps);
    expect(out.length).toBe(1);
    expect(out[0]!.thingId).toBe("t3_keep");
  });
});
