import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";

import {
  onClaimMenu,
  type ClaimHandlerDeps,
  type ClaimsService,
  type MetricsService,
  type AuthFn,
} from "../src/server/menu/claimHandler.js";
import {
  claim as realClaim,
  getClaim as realGetClaim,
  type ClaimsDeps,
  type RealtimeLike,
} from "../src/server/claims.js";
import {
  bumpMetric,
  type MetricsDeps,
} from "../src/server/metrics.js";
import { ForbiddenError } from "../src/server/auth.js";
import { CLAIM_TTL_SEC, type RealtimeEvent, type ThingId } from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";
import type { MenuItemRequest, UiResponse } from "@devvit/web/shared";

/**
 * Tests for `tasks.md` task 4.2 — `/internal/menu/claim` handler.
 *
 * Coverage (matches the user's prompt):
 *   - **Property 3 (no-foreign-claim path)** at ≥100 iter — write +
 *     publish exactly once, response is the `Claimed` toast.
 *   - **Property 9 (form-shown increment)** at ≥100 iter — exactly
 *     one `hIncrBy` against `softWarningsShown` on a foreign-claim,
 *     no claim write, no realtime publish, response is the
 *     `softWarningForm`.
 *   - 403 path — auth throws → response `Forbidden` toast, no
 *     downstream side effects.
 *   - Invalid `targetId` (prefix mismatch) → toast, no side effects.
 *
 * **Validates: Properties 3 (no-foreign-claim), 9 (softWarningsShown
 * increment), 10 (auth gate has no side effects on throw).**
 */

// ---------------------------------------------------------------------------
// Realtime recording fake — mirrors the pattern in tests/claims.spec.ts.
// We need to track BOTH count and channel so the property tests can
// distinguish "exactly one publish on the claim channel" from "any
// random side-channel publish".
// ---------------------------------------------------------------------------

interface RealtimeFake extends RealtimeLike {
  events: { channel: string; msg: RealtimeEvent }[];
}

function makeRealtimeFake(): RealtimeFake {
  const events: { channel: string; msg: RealtimeEvent }[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: build a full handler harness with real claims/metrics modules
// running against an in-memory Redis fake. Tests then drive the handler
// and assert against the fake's state directly.
// ---------------------------------------------------------------------------

interface Harness {
  deps: ClaimHandlerDeps;
  redis: RedisFake;
  realtime: RealtimeFake;
  authFn: ReturnType<typeof vi.fn<AuthFn>>;
  setNow: (t: number) => void;
}

function makeHarness(opts: {
  authImpl: AuthFn;
  sub: string;
  initialNow?: number;
}): Harness {
  let nowMs = opts.initialNow ?? Date.UTC(2025, 9, 15);
  const redis = makeRedisFake({ now: () => nowMs });
  const realtime = makeRealtimeFake();

  const claimsDeps: ClaimsDeps = {
    redis,
    realtime,
    now: () => nowMs,
  };
  const metricsDeps: MetricsDeps = {
    redis,
    now: () => nowMs,
  };

  const claimsService: ClaimsService = {
    getClaim: (sub, thingId) => realGetClaim(sub, thingId, claimsDeps),
    claim: (sub, thingId, mod) => realClaim(sub, thingId, mod, claimsDeps),
  };
  const metricsService: MetricsService = {
    bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
  };

  const authFn = vi.fn<AuthFn>(opts.authImpl);

  const deps: ClaimHandlerDeps = {
    auth: authFn,
    getSub: () => opts.sub,
    claims: claimsService,
    metrics: metricsService,
  };

  return {
    deps,
    redis,
    realtime,
    authFn,
    setNow(t) {
      nowMs = t;
    },
  };
}

const SUB = "Modsynnow";
const NOW = Date.UTC(2025, 9, 15);

// ---------------------------------------------------------------------------
// 403 path — auth throws → Forbidden toast, no downstream effects.
// ---------------------------------------------------------------------------

describe("403: auth throws ForbiddenError → handler returns Forbidden toast with zero side effects", () => {
  test("returns Forbidden toast and never invokes claims/metrics on the throw path", async () => {
    const { deps, redis, realtime, authFn } = makeHarness({
      authImpl: async ({ sub }) => {
        throw new ForbiddenError("intruder", sub);
      },
      sub: SUB,
      initialNow: NOW,
    });

    const body: MenuItemRequest = {
      location: "post",
      targetId: "t3_abc123",
    };

    const res = (await onClaimMenu(body, deps)) as UiResponse;

    // Response: a neutral Forbidden toast.
    expect(res).toEqual({
      showToast: { text: "Forbidden", appearance: "neutral" },
    });

    // Auth was called once.
    expect(authFn).toHaveBeenCalledTimes(1);

    // Critical: the auth-throw path does not write OR publish anything.
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.hSet).toBe(0);
    expect(realtime.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invalid target / location handling — defensive returns with no side effects.
// ---------------------------------------------------------------------------

describe("Invalid target handling", () => {
  test("subreddit location → toast + zero side effects", async () => {
    const { deps, redis, realtime } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const res = (await onClaimMenu(
      { location: "subreddit", targetId: "t5_modsynnow" },
      deps,
    )) as UiResponse;

    expect(res.showToast).toBeDefined();
    expect(res.showForm).toBeUndefined();
    // No claim write, no metric bump, no publish.
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(realtime.events).toHaveLength(0);
  });

  test("post location with t1_ prefix → 'Invalid target' toast + zero side effects", async () => {
    const { deps, redis, realtime } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const res = (await onClaimMenu(
      { location: "post", targetId: "t1_oops" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(realtime.events).toHaveLength(0);
  });

  test("comment location with t3_ prefix → 'Invalid target' toast + zero side effects", async () => {
    const { deps, redis, realtime } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const res = (await onClaimMenu(
      { location: "comment", targetId: "t3_oops" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(realtime.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 3 (no-foreign-claim path).
//
// forall (currentMod, thingId) with NO existing claim:
//   - claim key holds { moderator: currentMod, ttlSec ≈ 90 }
//   - exactly one realtime event was published on `claims-{sub}`
//   - response is the `Claimed` toast
// ---------------------------------------------------------------------------

describe("Property 3 (no-foreign-claim path)", () => {
  // Username regex matches Reddit's actual constraint and avoids the
  // `__proto__` collision class that bit `tests/scrub.spec.ts`.
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const thingPrefix = fc.constantFrom("t1_", "t3_");
  const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);

  test("forall (currentMod, thingId): claim is written + published exactly once, response is the Claimed toast", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        modArb,
        thingPrefix,
        thingSuffixArb,
        async (sub, mod, prefix, suffix) => {
          const targetId = `${prefix}${suffix}`;
          const location = prefix === "t3_" ? "post" : "comment";

          const { deps, realtime, redis } = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: mod, sub: s }),
            sub,
            initialNow: NOW,
          });

          const res = (await onClaimMenu(
            { location, targetId },
            deps,
          )) as UiResponse;

          // Response shape: a `Claimed` toast (allowed to be a string
          // or an appearance-tagged object per the spec).
          expect(res.showForm).toBeUndefined();
          const toast = res.showToast;
          if (typeof toast === "string") {
            expect(toast).toBe("Claimed");
          } else {
            expect(toast).toBeDefined();
            expect(toast?.text).toBe("Claimed");
          }

          // Exactly one publish, on the right channel, with the right shape.
          expect(realtime.events).toHaveLength(1);
          const ev = realtime.events[0]!;
          expect(ev.channel).toBe(`claims-${sub}`);
          expect(ev.msg.type).toBe("claim");
          if (ev.msg.type === "claim") {
            expect(ev.msg.thingId).toBe(targetId);
            expect(ev.msg.moderator).toBe(mod);
            expect(ev.msg.ttlSec).toBe(CLAIM_TTL_SEC);
          }

          // Claim record is in Redis with the right moderator and a
          // ttlSec ≈ 90 (right after the write the entire window is
          // still ahead of us, so 90 is exact at our pinned clock).
          const stored = await realGetClaim(
            sub,
            targetId as ThingId,
            { redis, realtime, now: () => NOW },
          );
          expect(stored).not.toBeNull();
          expect(stored!.moderator).toBe(mod);
          expect(stored!.ttlSec).toBeGreaterThan(0);
          expect(stored!.ttlSec).toBeLessThanOrEqual(CLAIM_TTL_SEC);

          // No metric bump on this branch.
          expect(redis._writes.hIncrBy).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9 (form-shown increment).
//
// forall existing FOREIGN claim:
//   - exactly one hIncrBy against `softWarningsShown` occurs
//   - response is the softWarningForm with data.kind = 'claim' and
//     data.thingId echoing the targetId
//   - NO claim write, NO realtime publish on this branch
// ---------------------------------------------------------------------------

describe("Property 9 (form-shown increment, foreign-claim path)", () => {
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const thingPrefix = fc.constantFrom("t1_", "t3_");
  const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);

  test("forall (currentMod, foreignMod, thingId): exactly one softWarningsShown hIncrBy + showForm response + no claim write + no publish", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // Two distinct moderators (foreign vs current).
        fc
          .tuple(modArb, modArb)
          .filter(([a, b]) => a !== b),
        thingPrefix,
        thingSuffixArb,
        async (sub, [foreignMod, currentMod], prefix, suffix) => {
          const targetId = `${prefix}${suffix}`;
          const location = prefix === "t3_" ? "post" : "comment";

          const { deps, realtime, redis } = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: currentMod, sub: s }),
            sub,
            initialNow: NOW,
          });

          // Seed an existing claim by a DIFFERENT moderator. This
          // produces one realtime publish and one claim write — both
          // are part of the seeding setup, not the handler under test.
          await realClaim(sub, targetId as ThingId, foreignMod, {
            redis,
            realtime,
            now: () => NOW,
          });
          // Snapshot the counters AFTER seeding so subsequent
          // assertions measure ONLY what the handler does.
          const seedRealtimeCount = realtime.events.length;
          const seedSetCount = redis._writes.set;
          const seedZAddCount = redis._writes.zAdd;

          const res = (await onClaimMenu(
            { location, targetId },
            deps,
          )) as UiResponse;

          // Response shape: showForm, NOT showToast.
          expect(res.showToast).toBeUndefined();
          expect(res.showForm).toBeDefined();
          expect(res.showForm!.name).toBe("softWarningForm");
          // The data envelope carries the action context for the
          // submit handler in 4.2b.
          expect(res.showForm!.data).toMatchObject({
            kind: "claim",
            thingId: targetId,
          });
          // Form has at least the warningText and proceed fields.
          const fieldNames = res.showForm!.form.fields.map((f) =>
            "name" in f ? f.name : undefined,
          );
          expect(fieldNames).toContain("warningText");
          expect(fieldNames).toContain("proceed");

          // Exactly one HINCRBY (the softWarning bump).
          expect(redis._writes.hIncrBy).toBe(1);

          // NO claim write delta vs. the seed snapshot, NO new
          // realtime publish.
          expect(redis._writes.set).toBe(seedSetCount);
          expect(redis._writes.zAdd).toBe(seedZAddCount);
          expect(realtime.events.length).toBe(seedRealtimeCount);

          // The claim record is still owned by the foreign mod —
          // the handler must not have overwritten it.
          const stored = await realGetClaim(
            sub,
            targetId as ThingId,
            { redis, realtime, now: () => NOW },
          );
          expect(stored).not.toBeNull();
          expect(stored!.moderator).toBe(foreignMod);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Own-claim re-claim path: a moderator re-clicking 'Claim for review'
// on their OWN active claim should NOT trigger the soft-warning form
// (the warning is for FOREIGN claims). Re-claim by the same mod takes
// the no-foreign-claim branch, which refreshes the claim record.
// ---------------------------------------------------------------------------

describe("own-claim re-claim → no soft warning, refresh + Claimed toast", () => {
  test("re-claiming an item I already own succeeds without bumping softWarningsShown", async () => {
    const { deps, realtime, redis } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    // Seed an existing claim by Alice (same as the current user).
    await realClaim(SUB, "t3_abc123" as ThingId, "alice", {
      redis,
      realtime,
      now: () => NOW,
    });
    const seedRealtimeCount = realtime.events.length;

    const res = (await onClaimMenu(
      { location: "post", targetId: "t3_abc123" },
      deps,
    )) as UiResponse;

    expect(res.showForm).toBeUndefined();
    const toast = res.showToast;
    if (typeof toast === "string") {
      expect(toast).toBe("Claimed");
    } else {
      expect(toast?.text).toBe("Claimed");
    }
    // Refresh produces a new claim publish.
    expect(realtime.events.length).toBe(seedRealtimeCount + 1);
    // No softWarning bump on this branch.
    expect(redis._writes.hIncrBy).toBe(0);
  });
});
