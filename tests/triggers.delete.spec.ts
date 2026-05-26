import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  onPostDelete,
  type TriggerDeps,
} from "../src/server/triggers/postDelete.js";
import { onCommentDelete } from "../src/server/triggers/commentDelete.js";
import { appendAction, type FeedDeps } from "../src/server/feed.js";
import {
  actionsKey,
  claimKey,
  claimsIndexKey,
} from "../src/server/redisKeys.js";
import {
  CLAIM_TTL_SEC,
  type ActionEntry,
  type ThingId,
} from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";
import type {
  OnCommentDeleteRequest,
  OnPostDeleteRequest,
} from "@devvit/web/shared";

/**
 * Trigger-handler tests for `tasks.md` task 9.1.
 *
 *   - **Property 11 (deletion-trigger half)**: forall pre-existing
 *     `actions:{sub}` and any `thingId t`. After the trigger handler
 *     returns, `actions:{sub}` contains zero entries with
 *     `entry.thingId === t` AND the order of remaining entries is
 *     preserved AND `claims:{sub}:{t}` does not exist AND
 *     `claims-index:{sub}` does not contain `t`.
 *   - **Idempotency (Property 11)**: forall sequence of mixed
 *     post-delete / comment-delete trigger calls (with arbitrary
 *     duplicates). Replaying the same sequence twice produces a
 *     byte-identical Redis snapshot — the second pass cannot mutate
 *     state because every operation in the handler is idempotent.
 *
 * **Validates: Requirements 9.1, 9.2 (Reddit-Rules deletion compliance)
 * — Property 11 in `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(): {
  deps: TriggerDeps;
  feedDeps: FeedDeps;
  redis: RedisFake;
} {
  const redis = makeRedisFake();
  return {
    deps: { redis },
    feedDeps: { redis },
    redis,
  };
}

function makeEntry(opts: {
  id: string;
  ts: number;
  moderator: string;
  thingId: ThingId;
}): ActionEntry {
  return {
    id: opts.id,
    ts: opts.ts,
    moderator: opts.moderator,
    thingId: opts.thingId,
    comboName: "Claim",
    ranSteps: [],
  };
}

/**
 * Build a minimal `OnPostDeleteRequest` payload. The `subreddit` and
 * `postId` fields are the only ones the handler reads; the protobuf
 * carries plenty of other fields but they are irrelevant here. We
 * cast so we don't have to fill the entire `SubredditV2` shape.
 */
function postDeleteBody(sub: string, postId: string): OnPostDeleteRequest {
  return {
    type: "PostDelete",
    postId,
    source: 0,
    reason: 0,
    subreddit: { name: sub } as OnPostDeleteRequest["subreddit"],
  } as OnPostDeleteRequest;
}

function commentDeleteBody(
  sub: string,
  commentId: string,
): OnCommentDeleteRequest {
  return {
    type: "CommentDelete",
    commentId,
    postId: "t3_dummy",
    parentId: "t3_dummy",
    source: 0,
    reason: 0,
    subreddit: { name: sub } as OnCommentDeleteRequest["subreddit"],
  } as OnCommentDeleteRequest;
}

/**
 * Snapshot every Redis key relevant to deletion-trigger compliance so
 * we can byte-compare across redeliveries. We capture the entire
 * `actions:{sub}` sorted set (member + score), every relevant claim
 * STRING key, and the entire `claims-index:{sub}` sorted set.
 */
async function snapshot(
  redis: RedisFake,
  sub: string,
  thingIds: readonly ThingId[],
): Promise<{
  actions: { member: string; score: number }[];
  claims: Record<string, string | undefined>;
  index: { member: string; score: number }[];
}> {
  const actions = await redis.zRange(actionsKey(sub), 0, -1, { by: "rank" });
  const claims: Record<string, string | undefined> = {};
  for (const t of thingIds) {
    claims[t] = await redis.get(claimKey(sub, t));
  }
  const index = await redis.zRange(claimsIndexKey(sub), 0, -1, {
    by: "rank",
  });
  return { actions, claims, index };
}

// ---------------------------------------------------------------------------
// Example tests — basic semantics
// ---------------------------------------------------------------------------

describe("onPostDelete (example tests)", () => {
  test("no matching entries: purgeByThingId returns 0; del + zRem are no-ops", async () => {
    const { deps, feedDeps, redis } = makeDeps();
    const sub = "Modsynnow";

    // Seed a handful of entries on a DIFFERENT thingId that must NOT
    // be touched.
    for (let i = 0; i < 3; i++) {
      await appendAction(
        sub,
        makeEntry({
          id: `keep-${i}`,
          ts: 1_700_000_000_000 + i,
          moderator: "alice",
          thingId: "t3_keep",
        }),
        feedDeps,
      );
    }
    const before = await snapshot(redis, sub, ["t3_keep", "t3_missing"]);

    const result = await onPostDelete(
      postDeleteBody(sub, "t3_missing"),
      deps,
    );
    expect(result).toEqual({});

    // Feed unchanged.
    const after = await snapshot(redis, sub, ["t3_keep", "t3_missing"]);
    expect(after).toEqual(before);

    // The handler still issued the (no-op) del and zRem — those are
    // safe on missing keys.
    expect(redis._writes.del).toBe(1);
    expect(redis._writes.zRem).toBe(1);
  });

  test("3 matching entries on t3_abc + 2 on t3_other: only t3_abc purged", async () => {
    const { deps, feedDeps, redis } = makeDeps();
    const sub = "Modsynnow";

    // Interleave so order-preservation can be checked on the survivors.
    let ts = 1_700_000_000_000;
    await appendAction(
      sub,
      makeEntry({ id: "abc-0", ts: ts++, moderator: "a", thingId: "t3_abc" }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({
        id: "other-0",
        ts: ts++,
        moderator: "a",
        thingId: "t3_other",
      }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({ id: "abc-1", ts: ts++, moderator: "a", thingId: "t3_abc" }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({
        id: "other-1",
        ts: ts++,
        moderator: "a",
        thingId: "t3_other",
      }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({ id: "abc-2", ts: ts++, moderator: "a", thingId: "t3_abc" }),
      feedDeps,
    );

    // Plant a live claim + index entry on t3_abc that also must go.
    await redis.set(
      claimKey(sub, "t3_abc"),
      JSON.stringify({ moderator: "a", claimedAt: 1 }),
      { expiration: new Date(Date.now() + CLAIM_TTL_SEC * 1000) },
    );
    await redis.zAdd(claimsIndexKey(sub), {
      member: "t3_abc",
      score: Date.now() + CLAIM_TTL_SEC * 1000,
    });
    // And a claim on t3_other that must SURVIVE.
    await redis.set(
      claimKey(sub, "t3_other"),
      JSON.stringify({ moderator: "a", claimedAt: 2 }),
      { expiration: new Date(Date.now() + CLAIM_TTL_SEC * 1000) },
    );
    await redis.zAdd(claimsIndexKey(sub), {
      member: "t3_other",
      score: Date.now() + CLAIM_TTL_SEC * 1000,
    });

    const result = await onPostDelete(postDeleteBody(sub, "t3_abc"), deps);
    expect(result).toEqual({});

    // Feed survivors are exactly the t3_other entries, in their
    // original chronological order (newest-first when read).
    const survivors = await redis.zRange(actionsKey(sub), 0, -1, {
      by: "rank",
    });
    const ids = survivors.map((m) => JSON.parse(m.member).id);
    expect(ids).toEqual(["other-0", "other-1"]);
    // None of the survivors carries thingId === t3_abc.
    expect(
      survivors.every((m) => JSON.parse(m.member).thingId === "t3_other"),
    ).toBe(true);

    // Claim STRING for t3_abc is gone.
    expect(await redis.get(claimKey(sub, "t3_abc"))).toBeUndefined();
    // Claim STRING for t3_other is intact.
    expect(await redis.get(claimKey(sub, "t3_other"))).toBeDefined();

    // Index: t3_abc gone, t3_other present.
    const indexMembers = (
      await redis.zRange(claimsIndexKey(sub), 0, -1)
    ).map((m) => m.member);
    expect(indexMembers).not.toContain("t3_abc");
    expect(indexMembers).toContain("t3_other");
  });
});

describe("onCommentDelete (example tests)", () => {
  test("3 matching entries on t1_xyz: purged + claim + index dropped", async () => {
    const { deps, feedDeps, redis } = makeDeps();
    const sub = "Modsynnow";

    let ts = 1_700_000_000_000;
    await appendAction(
      sub,
      makeEntry({
        id: "xyz-0",
        ts: ts++,
        moderator: "a",
        thingId: "t1_xyz",
      }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({
        id: "keep-0",
        ts: ts++,
        moderator: "a",
        thingId: "t1_keep",
      }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({
        id: "xyz-1",
        ts: ts++,
        moderator: "a",
        thingId: "t1_xyz",
      }),
      feedDeps,
    );
    await appendAction(
      sub,
      makeEntry({
        id: "xyz-2",
        ts: ts++,
        moderator: "a",
        thingId: "t1_xyz",
      }),
      feedDeps,
    );

    await redis.set(
      claimKey(sub, "t1_xyz"),
      JSON.stringify({ moderator: "a", claimedAt: 1 }),
    );
    await redis.zAdd(claimsIndexKey(sub), {
      member: "t1_xyz",
      score: Date.now() + 90_000,
    });

    const result = await onCommentDelete(
      commentDeleteBody(sub, "t1_xyz"),
      deps,
    );
    expect(result).toEqual({});

    // Only the keep entry remains.
    const survivors = await redis.zRange(actionsKey(sub), 0, -1);
    expect(survivors.length).toBe(1);
    expect(JSON.parse(survivors[0]!.member).thingId).toBe("t1_keep");

    expect(await redis.get(claimKey(sub, "t1_xyz"))).toBeUndefined();
    const indexMembers = (
      await redis.zRange(claimsIndexKey(sub), 0, -1)
    ).map((m) => m.member);
    expect(indexMembers).not.toContain("t1_xyz");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — example test
// ---------------------------------------------------------------------------

describe("idempotency (example test)", () => {
  test("second call with same payload yields byte-identical Redis state", async () => {
    const { deps, feedDeps, redis } = makeDeps();
    const sub = "Modsynnow";

    // Plant some feed entries on multiple things, plus claims.
    let ts = 1_700_000_000_000;
    const seedThings: ThingId[] = ["t3_abc", "t3_other", "t1_keep"];
    for (let i = 0; i < 8; i++) {
      const tid = seedThings[i % seedThings.length]!;
      await appendAction(
        sub,
        makeEntry({
          id: `e-${i}`,
          ts: ts++,
          moderator: "a",
          thingId: tid,
        }),
        feedDeps,
      );
    }
    for (const t of seedThings) {
      await redis.set(
        claimKey(sub, t),
        JSON.stringify({ moderator: "a", claimedAt: 1 }),
      );
      await redis.zAdd(claimsIndexKey(sub), {
        member: t,
        score: Date.now() + 90_000,
      });
    }

    const body = postDeleteBody(sub, "t3_abc");

    await onPostDelete(body, deps);
    const afterFirst = await snapshot(redis, sub, [
      "t3_abc",
      "t3_other",
      "t1_keep",
    ]);

    // Second call with the SAME payload — must not mutate state.
    await onPostDelete(body, deps);
    const afterSecond = await snapshot(redis, sub, [
      "t3_abc",
      "t3_other",
      "t1_keep",
    ]);

    expect(afterSecond).toEqual(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Property 11 (deletion-trigger half + idempotency) — PBT
// ---------------------------------------------------------------------------

describe("Property 11: deletion triggers + idempotency (PBT)", () => {
  // Small thingId pool with a fixed prefix split so generated trigger
  // calls hit a realistic mix of "matches an entry" and "no match".
  const POOL: ThingId[] = [
    "t3_aaa",
    "t3_bbb",
    "t3_ccc",
    "t1_xxx",
    "t1_yyy",
  ];

  type Op =
    | { kind: "post"; thingId: ThingId }
    | { kind: "comment"; thingId: ThingId };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constantFrom(...POOL).map(
      (thingId): Op =>
        thingId.startsWith("t3_")
          ? { kind: "post", thingId }
          : { kind: "comment", thingId },
    ),
    // Also allow operations targeting things that aren't in the seed
    // (no-match path) — uses the typed prefixes.
    fc.constantFrom<ThingId>(
      "t3_zzz" as ThingId,
      "t1_qqq" as ThingId,
    ).map(
      (thingId): Op =>
        thingId.startsWith("t3_")
          ? { kind: "post", thingId }
          : { kind: "comment", thingId },
    ),
  );

  async function applyOp(
    op: Op,
    sub: string,
    deps: TriggerDeps,
  ): Promise<void> {
    if (op.kind === "post") {
      await onPostDelete(postDeleteBody(sub, op.thingId), deps);
    } else {
      await onCommentDelete(commentDeleteBody(sub, op.thingId), deps);
    }
  }

  test("forall sequence of trigger ops: replaying yields byte-identical final state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/),
        // Seed 0..30 feed entries, each targeting a thingId from the
        // pool (so matches AND no-matches are exercised).
        fc.array(
          fc.record({
            tid: fc.constantFrom(...POOL),
            mod: fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        // Optional pre-claims — a subset of the pool gets claim
        // STRING + index entries planted before the triggers run.
        fc.subarray(POOL),
        // Sequence of 1..15 trigger calls including duplicates.
        fc.array(opArb, { minLength: 1, maxLength: 15 }),
        // Plus a redundant duplicate count to force re-delivery: each
        // op in the sequence is replayed `dupes` extra times.
        fc.integer({ min: 0, max: 3 }),
        async (sub, seedEntries, preClaims, ops, dupes) => {
          const { deps, feedDeps, redis } = makeDeps();

          // Seed feed.
          let ts = 1_000_000;
          for (let i = 0; i < seedEntries.length; i++) {
            const e = seedEntries[i]!;
            await appendAction(
              sub,
              makeEntry({
                id: `seed-${i}`,
                ts: ts++,
                moderator: e.mod,
                thingId: e.tid,
              }),
              feedDeps,
            );
          }
          // Seed claims + index.
          for (const t of preClaims) {
            await redis.set(
              claimKey(sub, t),
              JSON.stringify({ moderator: "a", claimedAt: 1 }),
            );
            await redis.zAdd(claimsIndexKey(sub), {
              member: t,
              score: 9_000_000,
            });
          }

          // First pass — apply each op (op + dupes extra deliveries).
          for (const op of ops) {
            for (let k = 0; k < 1 + dupes; k++) {
              await applyOp(op, sub, deps);
            }
          }
          const allThings: readonly ThingId[] = [
            ...POOL,
            "t3_zzz" as ThingId,
            "t1_qqq" as ThingId,
          ];
          const afterFirst = await snapshot(redis, sub, allThings);

          // Replay the FULL sequence again — should be a complete no-op
          // because each handler op is idempotent.
          for (const op of ops) {
            for (let k = 0; k < 1 + dupes; k++) {
              await applyOp(op, sub, deps);
            }
          }
          const afterSecond = await snapshot(redis, sub, allThings);
          expect(afterSecond).toEqual(afterFirst);

          // Compliance invariant: every thingId that appeared in the op
          // sequence must NOT survive in any of the three storage
          // surfaces.
          const targeted = new Set(ops.map((o) => o.thingId));
          for (const t of targeted) {
            // No feed entry references the targeted thingId.
            const survivors = afterFirst.actions
              .map((m) => JSON.parse(m.member) as ActionEntry)
              .filter((e) => e.thingId === t);
            expect(survivors).toEqual([]);
            // Claim STRING gone.
            expect(afterFirst.claims[t]).toBeUndefined();
            // Index entry gone.
            expect(afterFirst.index.find((m) => m.member === t)).toBeUndefined();
          }

          // Order-preservation: the surviving entries' scores are the
          // same set, in the same order, as the seed entries with
          // un-targeted thingIds (no rewrites).
          const expectedSurvivorScores = seedEntries
            .map((_, i) => 1_000_000 + i)
            .filter((_, i) => !targeted.has(seedEntries[i]!.tid));
          const actualScores = afterFirst.actions.map((m) => m.score);
          expect(actualScores).toEqual(expectedSurvivorScores);
        },
      ),
      { numRuns: 100 },
    );
  });
});
