import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  isModeratorDeleted,
  scrubEntry,
  type RedditClient,
  type RedditUserLike,
  type ScrubDeps,
} from "../src/server/scrub.js";
import { appendAction, readFeed, type FeedDeps } from "../src/server/feed.js";
import { actionsKey, deletedModsKey } from "../src/server/redisKeys.js";
import type { ActionEntry, ThingId } from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Scrub-on-read tests for `tasks.md` task 9.2.
 *
 * Properties covered:
 *
 *   - **Property 11 (scrub semantics)** at >=100 fast-check
 *     iterations: forall sequence of feed entries with mixed
 *     deleted/live moderators, the scrubbed feed has every deleted
 *     entry's moderator replaced with `"[deleted]"` and every
 *     live-moderator entry returned byte-identical (deepEqual).
 *
 *   - **Cache hit avoids API calls**: when `deleted-mods:{sub}`
 *     already lists the user, `isModeratorDeleted` returns `true`
 *     without invoking `reddit.getUserByUsername` and without any
 *     additional Redis writes.
 *
 *   - **Audit preservation**: the `actions:{sub}` SORTED SET member
 *     is never rewritten — verified by reading the underlying
 *     redis-fake state directly.
 *
 * **Validates: Requirements 9.3, 9.4 — Property 11 in `design.md`
 * "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

/**
 * Builds a recording Reddit fake with three behaviors keyed by
 * username:
 *   - `live` — returns a healthy `RedditUserLike` object
 *   - `deleted` — throws an error whose message contains `"user not
 *     found"` (the most realistic Devvit error shape)
 *   - `suspendedFlag` — returns a non-null user with
 *     `isSuspended: true`
 *   - `deletedFlag` — returns a non-null user with
 *     `isDeleted: true`
 *   - `nullReturn` — resolves to `null`
 *
 * The `calls` log captures every invocation so tests can assert call
 * counts directly.
 */
function makeRedditFake(
  rules: Record<
    string,
    "live" | "deleted" | "suspendedFlag" | "deletedFlag" | "nullReturn"
  >,
): {
  reddit: RedditClient;
  calls: { getUserByUsername: number; lastUsername: string | null };
} {
  const calls = { getUserByUsername: 0, lastUsername: null as string | null };
  const reddit: RedditClient = {
    async getUserByUsername(username) {
      calls.getUserByUsername += 1;
      calls.lastUsername = username;
      const rule = rules[username] ?? "live";
      switch (rule) {
        case "live":
          return { isSuspended: false, isDeleted: false } satisfies RedditUserLike;
        case "deleted":
          throw new Error(`user not found: ${username}`);
        case "suspendedFlag":
          return { isSuspended: true } satisfies RedditUserLike;
        case "deletedFlag":
          return { isDeleted: true } satisfies RedditUserLike;
        case "nullReturn":
          return null;
      }
    },
  };
  return { reddit, calls };
}

function makeDeps(rules: Record<string, "live" | "deleted" | "suspendedFlag" | "deletedFlag" | "nullReturn"> = {}): {
  deps: ScrubDeps;
  redis: RedisFake;
  reddit: RedditClient;
  calls: { getUserByUsername: number; lastUsername: string | null };
} {
  const redis = makeRedisFake();
  const { reddit, calls } = makeRedditFake(rules);
  return { deps: { redis, reddit }, redis, reddit, calls };
}

function makeEntry(opts: {
  id: string;
  ts: number;
  moderator: string;
  thingId?: ThingId;
}): ActionEntry {
  return {
    id: opts.id,
    ts: opts.ts,
    moderator: opts.moderator,
    thingId: opts.thingId ?? "t3_aaaaa",
    comboName: "Claim",
    ranSteps: [],
  };
}

// ---------------------------------------------------------------------------
// scrubEntry — example tests
// ---------------------------------------------------------------------------

describe("scrubEntry", () => {
  test("cached deleted user → returns scrubbed entry with moderator '[deleted]'", async () => {
    const { deps, redis, calls } = makeDeps();
    const sub = "Modsynnow";
    // Pre-seed the deleted-mods cache so no Reddit API call is needed.
    await redis.hSet(deletedModsKey(sub), { ghostmod: "1" });
    const writesBefore = redis._writes.hSet;

    const entry = makeEntry({ id: "x", ts: 1, moderator: "ghostmod" });
    const out = await scrubEntry(sub, entry, deps);

    expect(out.moderator).toBe("[deleted]");
    // All other fields preserved.
    expect(out.id).toBe(entry.id);
    expect(out.ts).toBe(entry.ts);
    expect(out.thingId).toBe(entry.thingId);
    expect(out.comboName).toBe(entry.comboName);
    // Cache hit: no Reddit API call, no extra Redis writes.
    expect(calls.getUserByUsername).toBe(0);
    expect(redis._writes.hSet).toBe(writesBefore);
    // Original entry object is not mutated.
    expect(entry.moderator).toBe("ghostmod");
  });

  test("non-deleted user → returns entry unchanged (deepEqual)", async () => {
    const { deps, redis } = makeDeps({ alice: "live" });
    const sub = "Modsynnow";
    const entry = makeEntry({ id: "x", ts: 1, moderator: "alice" });

    const out = await scrubEntry(sub, entry, deps);

    expect(out).toEqual(entry);
    // No write to deleted-mods cache for live users.
    expect(redis._writes.hSet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isModeratorDeleted — example tests
// ---------------------------------------------------------------------------

describe("isModeratorDeleted", () => {
  test("cache miss with reddit returning live user → returns false, no Redis writes", async () => {
    const { deps, redis, calls } = makeDeps({ alice: "live" });

    const result = await isModeratorDeleted("Modsynnow", "alice", deps);

    expect(result).toBe(false);
    expect(calls.getUserByUsername).toBe(1);
    expect(calls.lastUsername).toBe("alice");
    // No write to deleted-mods cache.
    expect(redis._writes.hSet).toBe(0);
  });

  test("cache miss with reddit throwing 'user not found' → returns true, exactly one hSet", async () => {
    const { deps, redis, calls } = makeDeps({ ghostmod: "deleted" });

    const result = await isModeratorDeleted("Modsynnow", "ghostmod", deps);

    expect(result).toBe(true);
    expect(calls.getUserByUsername).toBe(1);
    expect(redis._writes.hSet).toBe(1);
    // Cached for next time.
    expect(await redis.hGet(deletedModsKey("Modsynnow"), "ghostmod")).toBe("1");
  });

  test("cache hit → returns true, no Reddit API call, no Redis writes", async () => {
    const { deps, redis, calls } = makeDeps({ ghostmod: "live" });
    const sub = "Modsynnow";
    // Pre-seed cache via a direct hSet (counts as a write); reset
    // counter before the assertion.
    await redis.hSet(deletedModsKey(sub), { ghostmod: "1" });
    const hSetBefore = redis._writes.hSet;

    const result = await isModeratorDeleted(sub, "ghostmod", deps);

    expect(result).toBe(true);
    expect(calls.getUserByUsername).toBe(0);
    expect(redis._writes.hSet).toBe(hSetBefore);
  });

  test("cache miss with reddit returning user with isSuspended=true → returns true, caches", async () => {
    const { deps, redis } = makeDeps({ banned: "suspendedFlag" });

    const result = await isModeratorDeleted("Modsynnow", "banned", deps);

    expect(result).toBe(true);
    expect(redis._writes.hSet).toBe(1);
  });

  test("cache miss with reddit returning user with isDeleted=true → returns true, caches", async () => {
    const { deps, redis } = makeDeps({ removed: "deletedFlag" });

    const result = await isModeratorDeleted("Modsynnow", "removed", deps);

    expect(result).toBe(true);
    expect(redis._writes.hSet).toBe(1);
  });

  test("cache miss with reddit returning null → returns true, caches", async () => {
    const { deps, redis } = makeDeps({ ghost: "nullReturn" });

    const result = await isModeratorDeleted("Modsynnow", "ghost", deps);

    expect(result).toBe(true);
    expect(redis._writes.hSet).toBe(1);
  });

  test("cache miss with reddit throwing a non-deletion error → propagates, no cache write", async () => {
    const redis = makeRedisFake();
    const reddit: RedditClient = {
      async getUserByUsername() {
        throw new Error("network timeout");
      },
    };
    const deps: ScrubDeps = { redis, reddit };

    await expect(
      isModeratorDeleted("Modsynnow", "alice", deps),
    ).rejects.toThrow("network timeout");
    // Transient error must NOT pollute the cache.
    expect(redis._writes.hSet).toBe(0);
  });

  test("per-install isolation: writes to subA do not affect subB", async () => {
    const { deps, redis } = makeDeps({ ghost: "deleted" });

    expect(await isModeratorDeleted("subA", "ghost", deps)).toBe(true);

    // subB has its own deleted-mods key — the cache write to subA
    // does not bleed across.
    expect(await redis.hGet(deletedModsKey("subA"), "ghost")).toBe("1");
    expect(await redis.hGet(deletedModsKey("subB"), "ghost")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readFeed integration with scrub layer
// ---------------------------------------------------------------------------

describe("readFeed with injected scrub layer", () => {
  test("deleted moderator entry comes back with moderator='[deleted]'; underlying sorted-set member is unchanged", async () => {
    const sub = "Modsynnow";
    const { deps: scrubDeps, redis } = makeDeps({
      ghostmod: "deleted",
      alice: "live",
    });
    const feedDeps: FeedDeps = {
      redis,
      scrub: { scrubEntry, deps: scrubDeps },
    };

    const ghostEntry = makeEntry({ id: "g-1", ts: 100, moderator: "ghostmod" });
    const aliveEntry = makeEntry({ id: "a-1", ts: 200, moderator: "alice" });

    await appendAction(sub, ghostEntry, { redis });
    await appendAction(sub, aliveEntry, { redis });

    const out = await readFeed(sub, 500, feedDeps);

    // Newest first: alice (ts 200) then ghostmod (ts 100).
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("a-1");
    expect(out[0]!.moderator).toBe("alice");
    expect(out[1]!.id).toBe("g-1");
    expect(out[1]!.moderator).toBe("[deleted]");

    // CRITICAL: the underlying sorted-set member is NOT rewritten.
    // The original `ghostmod` is still there byte-for-byte.
    const raw = await redis.zRange(actionsKey(sub), 0, -1);
    const ghostMember = raw.find((m) => m.score === 100);
    expect(ghostMember).toBeDefined();
    const parsed = JSON.parse(ghostMember!.member) as ActionEntry;
    expect(parsed.moderator).toBe("ghostmod");
    expect(parsed.id).toBe("g-1");
  });

  test("readFeed without scrub injected → entries returned verbatim (backward compatibility with task 7.1)", async () => {
    const sub = "Modsynnow";
    const redis = makeRedisFake();
    const feedDeps: FeedDeps = { redis };

    await appendAction(
      sub,
      makeEntry({ id: "x", ts: 1, moderator: "ghostmod" }),
      feedDeps,
    );

    const out = await readFeed(sub, 500, feedDeps);
    expect(out).toHaveLength(1);
    // No scrub injected → moderator is returned verbatim, even if the
    // user has been deleted.
    expect(out[0]!.moderator).toBe("ghostmod");
  });
});

// ---------------------------------------------------------------------------
// Property 11 (scrub semantics) — fast-check
// ---------------------------------------------------------------------------

const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t1_${s}` as const),
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t3_${s}` as const),
);

describe("Property 11 (scrub semantics)", () => {
  test("forall mixed feed: scrubbed feed replaces deleted moderators with '[deleted]'; live entries byte-identical", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // 1..15 entries; up to ~5 distinct moderator names so the
        // mixed deleted/live distribution is dense.
        fc
          .uniqueArray(modArb, { minLength: 1, maxLength: 6 })
          .chain((modPool) =>
            fc.tuple(
              fc.constant(modPool),
              // For each mod in the pool, decide deleted (true) or
              // live (false).
              fc.array(fc.boolean(), {
                minLength: modPool.length,
                maxLength: modPool.length,
              }),
              // The actual entry stream — picks a mod from the pool
              // by index.
              fc.array(
                fc.record({
                  modIndex: fc.nat({ max: modPool.length - 1 }),
                  ts: fc.integer({ min: 1, max: 10_000_000 }),
                  thingId: thingIdArb,
                }),
                { minLength: 1, maxLength: 15 },
              ),
            ),
          ),
        async (sub, [modPool, deletedFlags, stream]) => {
          // Build the rules map that the reddit fake consults.
          const rules: Record<
            string,
            "live" | "deleted"
          > = {};
          for (let i = 0; i < modPool.length; i++) {
            rules[modPool[i]!] = deletedFlags[i] ? "deleted" : "live";
          }
          const deletedSet = new Set(
            modPool.filter((_, i) => deletedFlags[i]),
          );

          const { deps: scrubDeps, redis } = makeDeps(rules);
          const feedDeps: FeedDeps = {
            redis,
            scrub: { scrubEntry, deps: scrubDeps },
          };

          // Append entries with strictly-increasing ts so we have
          // unambiguous ordering.
          const baseTs = 1_700_000_000_000;
          const expected: ActionEntry[] = [];
          for (let i = 0; i < stream.length; i++) {
            const s = stream[i]!;
            const mod = modPool[s.modIndex]!;
            const entry = makeEntry({
              id: `e-${i}`,
              ts: baseTs + i,
              moderator: mod,
              thingId: s.thingId,
            });
            expected.push(entry);
            await appendAction(sub, entry, { redis });
          }

          const out = await readFeed(sub, 500, feedDeps);

          // Newest-first: reverse of insertion order.
          expect(out).toHaveLength(expected.length);
          for (let i = 0; i < out.length; i++) {
            const expectedEntry = expected[expected.length - 1 - i]!;
            const got = out[i]!;
            if (deletedSet.has(expectedEntry.moderator)) {
              expect(got.moderator).toBe("[deleted]");
              // Every other field byte-identical.
              expect(got.id).toBe(expectedEntry.id);
              expect(got.ts).toBe(expectedEntry.ts);
              expect(got.thingId).toBe(expectedEntry.thingId);
              expect(got.comboName).toBe(expectedEntry.comboName);
              expect(got.ranSteps).toEqual(expectedEntry.ranSteps);
            } else {
              // Live moderator: entry returned byte-identical.
              expect(got).toEqual(expectedEntry);
            }
          }

          // Audit preservation: every original sorted-set member is
          // still byte-identical to what we wrote (no rewrite).
          const raw = await redis.zRange(actionsKey(sub), 0, -1);
          const rawByTs = new Map(
            raw.map((m) => [m.score, m.member] as const),
          );
          for (const e of expected) {
            const member = rawByTs.get(e.ts);
            expect(member).toBeDefined();
            const parsed = JSON.parse(member!) as ActionEntry;
            expect(parsed.moderator).toBe(e.moderator);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
