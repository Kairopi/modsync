import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  ForbiddenError,
  requireMod,
  type RedditClient,
  type RedisLike,
} from "../src/server/auth.js";

/**
 * Auth-gate tests for `requireMod` — `tasks.md` task 3.1.
 *
 * Two properties, each at >=100 fast-check iterations:
 *
 *   - **Property 10 (basic gate)**: `requireMod` returns iff the current
 *     user is in the moderator list for `sub`; otherwise it throws
 *     `ForbiddenError`. The throw path performs ZERO Redis writes
 *     (no `hSet`, no `set`).
 *
 *   - **Cache-hit path**: when `mods:{sub}` already lists the user AND
 *     `mods-expiry:{sub}` is still set, `requireMod` returns without
 *     calling `reddit.getModerators` even once.
 *
 * The fakes here are recording fakes — every `hSet` / `set` /
 * `getModerators` call is logged so the assertions can verify
 * call-count invariants directly.
 *
 * **Validates: Requirements 10.x (auth gate) — see Property 10 in
 * `design.md` "Correctness Properties".**
 */

/** Builds a fresh in-memory Redis fake plus the recording call log. */
function makeRedisFake(seed?: {
  hashes?: Record<string, Record<string, string>>;
  strings?: Record<string, string>;
}): {
  redis: RedisLike;
  writes: { hSet: number; set: number };
} {
  const hashes: Record<string, Record<string, string>> = JSON.parse(
    JSON.stringify(seed?.hashes ?? {}),
  );
  const strings: Record<string, string> = { ...(seed?.strings ?? {}) };
  const writes = { hSet: 0, set: 0 };

  const redis: RedisLike = {
    async hGet(key, field) {
      return hashes[key]?.[field];
    },
    async hSet(key, fieldValues) {
      writes.hSet += 1;
      const bucket = hashes[key] ?? (hashes[key] = {});
      let added = 0;
      for (const [f, v] of Object.entries(fieldValues)) {
        if (!(f in bucket)) added += 1;
        bucket[f] = v;
      }
      return added;
    },
    async exists(...keys) {
      let n = 0;
      for (const k of keys) {
        if (k in strings || k in hashes) n += 1;
      }
      return n;
    },
    async set(key, value) {
      writes.set += 1;
      strings[key] = value;
      return "OK";
    },
  };

  return { redis, writes };
}

/** Builds a recording Reddit fake driven by a fixed user + moderator list. */
function makeRedditFake(
  username: string,
  modList: readonly string[],
): { reddit: RedditClient; calls: { getCurrentUser: number; getModerators: number } } {
  const calls = { getCurrentUser: 0, getModerators: 0 };
  const reddit: RedditClient = {
    async getCurrentUser() {
      calls.getCurrentUser += 1;
      return { username };
    },
    async getModerators() {
      calls.getModerators += 1;
      return modList.map((u) => ({ username: u }));
    },
  };
  return { reddit, calls };
}

/** Reddit usernames are 3-20 chars, [A-Za-z0-9_-]. We use a relaxed regex. */
const usernameArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);

describe("requireMod (Property 10: basic gate, no side effects on throw)", () => {
  test("forall (user, modList): returns iff user in modList; otherwise throws ForbiddenError with zero Redis writes", async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        subArb,
        // Distinct moderator usernames so set semantics are clean. Allow empty.
        fc.uniqueArray(usernameArb, { minLength: 0, maxLength: 12 }),
        async (user, sub, modList) => {
          const { redis, writes } = makeRedisFake();
          const { reddit, calls } = makeRedditFake(user, modList);

          const userIsMod = modList.includes(user);

          if (userIsMod) {
            const result = await requireMod({ sub }, { redis, reddit });
            expect(result).toEqual({ user, sub });
            // Cache miss path: exactly one getModerators call, then warm-fill.
            expect(calls.getCurrentUser).toBe(1);
            expect(calls.getModerators).toBe(1);
            // hSet is skipped when modList is empty (defensive — non-mods can
            // never reach this branch anyway, but documenting it here).
            expect(writes.hSet).toBe(modList.length > 0 ? 1 : 0);
            // Sentinel is always written on the success path.
            expect(writes.set).toBe(1);
          } else {
            await expect(requireMod({ sub }, { redis, reddit })).rejects.toBeInstanceOf(
              ForbiddenError,
            );
            // The critical Property 10 assertion: zero writes on the throw path.
            expect(writes.hSet).toBe(0);
            expect(writes.set).toBe(0);
            expect(calls.getCurrentUser).toBe(1);
            expect(calls.getModerators).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("ForbiddenError carries the user and sub it was thrown for", async () => {
    const { redis } = makeRedisFake();
    const { reddit } = makeRedditFake("alice", ["bob", "carol"]);

    try {
      await requireMod({ sub: "Modsynnow" }, { redis, reddit });
      throw new Error("expected ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      const fe = err as ForbiddenError;
      expect(fe.user).toBe("alice");
      expect(fe.sub).toBe("Modsynnow");
      expect(fe.name).toBe("ForbiddenError");
    }
  });
});

describe("requireMod (cache-hit path: warm cache avoids Reddit API)", () => {
  test("forall (user, mods) where user in mods AND cache is warm: returns and getModerators is called 0 times", async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        subArb,
        fc.uniqueArray(usernameArb, { minLength: 1, maxLength: 12 }),
        async (user, sub, otherMods) => {
          // Construct a moderator list that always contains `user`.
          const modList = otherMods.includes(user) ? otherMods : [user, ...otherMods];

          // Pre-populate the Redis fake to simulate a recent warm-fill:
          // both `mods:{sub}` lists `user` AND `mods-expiry:{sub}` is set.
          const hashes: Record<string, Record<string, string>> = {};
          const modsKey = `mods:${sub}`;
          hashes[modsKey] = Object.fromEntries(modList.map((m) => [m, "1"]));
          const strings: Record<string, string> = {
            [`mods-expiry:${sub}`]: "1",
          };

          const { redis, writes } = makeRedisFake({ hashes, strings });
          const { reddit, calls } = makeRedditFake(user, modList);

          const result = await requireMod({ sub }, { redis, reddit });

          expect(result).toEqual({ user, sub });
          // Cache-hit path must not call the Reddit moderator API at all.
          expect(calls.getModerators).toBe(0);
          expect(calls.getCurrentUser).toBe(1);
          // No writes either — the cache is already warm.
          expect(writes.hSet).toBe(0);
          expect(writes.set).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("stale sentinel falls through to fresh getModerators call", async () => {
    // Hash has the user, but the sentinel is missing -> cache stale.
    const sub = "Modsynnow";
    const user = "alice";
    const { redis, writes } = makeRedisFake({
      hashes: { [`mods:${sub}`]: { alice: "1", bob: "1" } },
      // no `mods-expiry:{sub}` here -> stale
    });
    const { reddit, calls } = makeRedditFake(user, ["alice", "bob"]);

    const result = await requireMod({ sub }, { redis, reddit });

    expect(result).toEqual({ user, sub });
    // Stale-sentinel path must re-fetch moderators and re-arm the sentinel.
    expect(calls.getModerators).toBe(1);
    expect(writes.hSet).toBe(1);
    expect(writes.set).toBe(1);
  });
});
