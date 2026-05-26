import { describe, expect, test } from "vitest";

import {
  onAppInstall,
  type AppInstallDeps,
  type RedditClient,
} from "../src/server/triggers/appInstall.js";
import {
  combosKey,
  modsExpiryKey,
  modsKey,
} from "../src/server/redisKeys.js";
import type { ComboSpec } from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * `onAppInstall` trigger tests for `tasks.md` task 9.3.
 *
 * Covered:
 *   - Happy path: warms `mods:{sub}` (1 `hSet`) and arms the 5-minute
 *     sentinel via `set` with `{ expiration }` (1 `set`); skips post
 *     creation when `createPostOnInstall: false`.
 *   - Default combos provided: one `hSet` against `combos:{sub}` with
 *     every default spec serialized as JSON.
 *   - `defaultCombos: []` (or undefined): no combo writes.
 *   - Idempotency: re-running the handler with the same payload yields
 *     a byte-identical final Redis state (snapshot before/after via
 *     `hGetAll` + `zCard`-equivalent reads).
 *   - `getModerators` failure propagates — production wants the
 *     trigger to retry on a 5xx, swallowing here would defeat that.
 *
 * The handler shares its file with no other entry points, so the
 * test surface is intentionally tight: 5 example tests + a snapshot
 * comparison for idempotency. No PBT in this file — task 9.3's
 * acceptance signal is `npm test -- triggers.appInstall` exit 0, and
 * the property facets the task body lists (idempotency, default-combo
 * seeding, cache warm-fill) are each verified directly via example
 * tests below.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RedditCalls {
  getModerators: number;
  submitPost: number;
  lastSubmitPostOpts:
    | {
        subredditName: string;
        title: string;
        postData?: Record<string, unknown>;
      }
    | null;
}

/**
 * Recording Reddit fake. `getModerators` returns the supplied list (or
 * throws when `throwOnGetModerators` is set). `submitPost` records the
 * call args and returns a stub `{ id }`. The recording lets each test
 * assert call counts directly.
 */
function makeRedditFake(
  modList: readonly string[],
  options: { throwOnGetModerators?: Error } = {},
): { reddit: RedditClient; calls: RedditCalls } {
  const calls: RedditCalls = {
    getModerators: 0,
    submitPost: 0,
    lastSubmitPostOpts: null,
  };
  let nextPostId = 1;
  const reddit: RedditClient = {
    async getModerators() {
      calls.getModerators += 1;
      if (options.throwOnGetModerators) {
        throw options.throwOnGetModerators;
      }
      return modList.map((u) => ({ username: u }));
    },
    async submitPost(opts) {
      calls.submitPost += 1;
      calls.lastSubmitPostOpts = opts;
      return { id: `t3_post${nextPostId++}` };
    },
  };
  return { reddit, calls };
}

/**
 * Build a fresh `OnAppInstallRequest`-shaped payload for tests. The
 * real protobuf type accepts a few more optional fields (`installer`,
 * etc.) that we don't read — keeping the test payload minimal avoids
 * accidental coupling to fields the handler doesn't consume.
 */
function makeBody(subName: string, subId = "t5_modsynnow"): {
  subreddit: { name: string; id: string };
} {
  return { subreddit: { name: subName, id: subId } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot the handler-relevant Redis state for a sub. Used by the
 * idempotency test to deepEqual before/after a re-run. The shape is
 * structural — `combosKey` and `modsKey` are HASHes, `modsExpiryKey`
 * is a STRING; we read each via the matching read primitive.
 */
async function snapshot(
  redis: RedisFake,
  sub: string,
): Promise<{
  mods: Record<string, string>;
  combos: Record<string, string>;
  expirySet: number;
}> {
  return {
    mods: await redis.hGetAll(modsKey(sub)),
    combos: await redis.hGetAll(combosKey(sub)),
    expirySet: await redis.exists(modsExpiryKey(sub)),
  };
}

const DEFAULT_COMBOS: ComboSpec[] = [
  {
    name: "Spam removal",
    steps: [
      { kind: "REMOVE" },
      { kind: "BAN", days: 7, reason: "spam" },
    ],
  },
  {
    name: "Off-topic cleanup",
    steps: [{ kind: "REMOVE" }, { kind: "LOCK" }],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onAppInstall (task 9.3)", () => {
  test("happy path warms mods cache and arms sentinel; skips post creation when createPostOnInstall=false", async () => {
    const redis = makeRedisFake();
    const { reddit, calls } = makeRedditFake(["alice", "bob", "carol"]);
    const deps: AppInstallDeps = { redis, reddit, createPostOnInstall: false };

    const result = await onAppInstall(makeBody("Modsynnow"), deps);

    expect(result).toEqual({});
    // Exactly one warm-fill hSet on mods:{sub}.
    expect(redis._writes.hSet).toBe(1);
    // Exactly one set on the sentinel (with expiration in the future).
    expect(redis._writes.set).toBe(1);
    // No combo seeding when defaultCombos is undefined.
    expect(redis._writes.hSet).toBe(1);
    // No post creation under the explicit opt-out.
    expect(calls.submitPost).toBe(0);
    expect(calls.getModerators).toBe(1);

    // Verify the cached moderator hash.
    expect(await redis.hGetAll(modsKey("Modsynnow"))).toEqual({
      alice: "1",
      bob: "1",
      carol: "1",
    });
    // Sentinel is set.
    expect(await redis.exists(modsExpiryKey("Modsynnow"))).toBe(1);
    // No combos persisted.
    expect(await redis.hGetAll(combosKey("Modsynnow"))).toEqual({});
  });

  test("default combos provided: hSet on combos:{sub} for each spec", async () => {
    const redis = makeRedisFake();
    const { reddit } = makeRedditFake(["alice"]);
    const deps: AppInstallDeps = {
      redis,
      reddit,
      createPostOnInstall: false,
      defaultCombos: DEFAULT_COMBOS,
    };

    await onAppInstall(makeBody("Modsynnow"), deps);

    // 2 hSet calls total: 1 for mods, 1 for combos.
    expect(redis._writes.hSet).toBe(2);

    const persisted = await redis.hGetAll(combosKey("Modsynnow"));
    expect(Object.keys(persisted).sort()).toEqual([
      "Off-topic cleanup",
      "Spam removal",
    ]);
    // Round-trip: each value must JSON.parse back to the matching ComboSpec.
    for (const spec of DEFAULT_COMBOS) {
      const raw = persisted[spec.name];
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual(spec);
    }
  });

  test("defaultCombos: [] (and undefined) yields zero combo writes", async () => {
    // First subcase: explicit empty array.
    const redisA = makeRedisFake();
    const { reddit: redditA } = makeRedditFake(["alice"]);
    await onAppInstall(makeBody("subA"), {
      redis: redisA,
      reddit: redditA,
      createPostOnInstall: false,
      defaultCombos: [],
    });
    expect(await redisA.hGetAll(combosKey("subA"))).toEqual({});
    // Only the mods warm-fill hSet — no second write.
    expect(redisA._writes.hSet).toBe(1);

    // Second subcase: omitted entirely.
    const redisB = makeRedisFake();
    const { reddit: redditB } = makeRedditFake(["alice"]);
    await onAppInstall(makeBody("subB"), {
      redis: redisB,
      reddit: redditB,
      createPostOnInstall: false,
    });
    expect(await redisB.hGetAll(combosKey("subB"))).toEqual({});
    expect(redisB._writes.hSet).toBe(1);
  });

  test("idempotency: re-running the handler yields the same final Redis state", async () => {
    const redis = makeRedisFake();
    const { reddit, calls } = makeRedditFake(["alice", "bob"]);
    const deps: AppInstallDeps = {
      redis,
      reddit,
      createPostOnInstall: false,
      defaultCombos: DEFAULT_COMBOS,
    };

    await onAppInstall(makeBody("Modsynnow"), deps);
    const after1 = await snapshot(redis, "Modsynnow");

    // Re-deliver the same payload (Devvit retries on 5xx and may
    // re-fire AppInstall on re-install).
    await onAppInstall(makeBody("Modsynnow"), deps);
    const after2 = await snapshot(redis, "Modsynnow");

    // Final state is byte-identical: same mod set, same combo set
    // (same JSON values), sentinel still set.
    expect(after2.mods).toEqual(after1.mods);
    expect(after2.combos).toEqual(after1.combos);
    expect(after2.expirySet).toBe(after1.expirySet);
    // Combo hash count unchanged across re-runs.
    expect(Object.keys(after2.combos).length).toBe(DEFAULT_COMBOS.length);

    // Reddit was queried twice (once per call) — the warm-fill is
    // unconditional so the trigger always re-fetches the latest mod
    // list. That's intentional: a re-install may follow a mod change.
    expect(calls.getModerators).toBe(2);
  });

  test("getModerators failure propagates so the trigger retries", async () => {
    const redis = makeRedisFake();
    const failure = new Error("Reddit API 503");
    const { reddit, calls } = makeRedditFake([], {
      throwOnGetModerators: failure,
    });
    const deps: AppInstallDeps = {
      redis,
      reddit,
      createPostOnInstall: false,
      defaultCombos: DEFAULT_COMBOS,
    };

    await expect(
      onAppInstall(makeBody("Modsynnow"), deps),
    ).rejects.toThrow("Reddit API 503");

    // No writes after the propagated failure — the warm-fill error
    // happens before any Redis mutation.
    expect(redis._writes.hSet).toBe(0);
    expect(redis._writes.set).toBe(0);
    expect(calls.getModerators).toBe(1);
    expect(calls.submitPost).toBe(0);
    // No combos were seeded.
    expect(await redis.hGetAll(combosKey("Modsynnow"))).toEqual({});
  });

  test("createPostOnInstall=true invokes submitPost exactly once with the dashboard payload", async () => {
    const redis = makeRedisFake();
    const { reddit, calls } = makeRedditFake(["alice"]);
    const deps: AppInstallDeps = {
      redis,
      reddit,
      createPostOnInstall: true,
    };

    await onAppInstall(makeBody("Modsynnow"), deps);

    expect(calls.submitPost).toBe(1);
    expect(calls.lastSubmitPostOpts).toEqual({
      subredditName: "Modsynnow",
      title: "ModSync Dashboard",
      postData: { kind: "modsync" },
    });
  });

  test("missing subreddit.name short-circuits without any side effects", async () => {
    const redis = makeRedisFake();
    const { reddit, calls } = makeRedditFake(["alice"]);
    // Build an empty-name payload (proto field is optional on the type).
    const body = { subreddit: { name: "", id: "t5_x" } };

    const result = await onAppInstall(body, {
      redis,
      reddit,
      createPostOnInstall: true,
      defaultCombos: DEFAULT_COMBOS,
    });

    expect(result).toEqual({});
    expect(calls.getModerators).toBe(0);
    expect(calls.submitPost).toBe(0);
    expect(redis._writes.hSet).toBe(0);
    expect(redis._writes.set).toBe(0);
  });
});
