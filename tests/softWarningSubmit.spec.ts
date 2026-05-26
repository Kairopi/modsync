import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";

import {
  onSoftWarningSubmit,
  type AuthFn,
  type ClaimsService,
  type CombosService,
  type ExecutorService,
  type MetricsService,
  type SoftWarningDeps,
  type SoftWarningSubmitBody,
} from "../src/server/forms/softWarningSubmit.js";
import {
  claim as realClaim,
  type ClaimsDeps,
  type RealtimeLike,
} from "../src/server/claims.js";
import { saveCombo, type CombosDeps } from "../src/server/combos.js";
import {
  bumpMetric,
  type MetricsDeps,
} from "../src/server/metrics.js";
import { ForbiddenError } from "../src/server/auth.js";
import {
  CLAIM_TTL_SEC,
  type ActionEntry,
  type ComboSpec,
  type ComboStep,
  type RealtimeEvent,
  type ThingId,
} from "../src/shared/types.js";
import { claimKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";
import type { UiResponse } from "@devvit/web/shared";

/**
 * Tests for `tasks.md` task 4.2b — `/internal/form/soft-warning-submit` handler.
 *
 * Coverage:
 *   - 403 path (auth throws → Forbidden toast, zero downstream side
 *     effects).
 *   - All 4 (kind, proceed) combinations:
 *       (claim, true)  → 1 hIncrBy on collisionsDetected, 1 claim
 *                        write, 1 publish, NO runCombo, "Claimed
 *                        (override)" toast.
 *       (claim, false) → 1 hIncrBy on redundantActionsAvoided, NO
 *                        claim write, NO publish, "Cancelled" toast.
 *       (combo, true)  → 1 hIncrBy on collisionsDetected, 1 claim
 *                        write, 1 publish, 1 runCombo call with the
 *                        right ComboSpec, "Combo complete" toast.
 *       (combo, false) → 1 hIncrBy on redundantActionsAvoided, NO
 *                        writes, "Cancelled" toast.
 *   - (combo, true) with `comboName` not in combos → "Combo not
 *     found" toast, NO runCombo, NO claim write.
 *   - **Property 9 (counter routing)** PBT at ≥100 iter — for every
 *     (kind, proceed) combination, the EXPECTED counter set is
 *     incremented exactly once each, and `softWarningsShown` is
 *     NEVER incremented.
 *   - **Property 3 (combo branch on override)** PBT at ≥100 iter —
 *     for (combo, true), claim key holds the right moderator with
 *     ttlSec ≈ 90 AND `runCombo` was invoked exactly once with the
 *     matching `ComboSpec`.
 *
 * **Validates: Property 9 (counter routing), Property 3 (combo
 * branch on override).**
 */

// ---------------------------------------------------------------------------
// Realtime recording fake — mirrors tests/claims.spec.ts /
// tests/claimHandler.spec.ts. We track channel + message so the
// counter-routing properties can distinguish "claim publish" vs any
// random side-channel publish.
// ---------------------------------------------------------------------------

interface RealtimeFake extends RealtimeLike {
  events: { channel: string; msg: RealtimeEvent }[];
}

function makeRealtimeFake(): RealtimeFake {
  const events: { channel: string; msg: RealtimeEvent }[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg: msg as RealtimeEvent });
    },
  };
}

// ---------------------------------------------------------------------------
// Executor recording fake. The combo branch invokes runCombo end-to-end;
// the soft-warning handler is not the system under test for executor
// semantics (that's tests/executor.spec.ts). Here we record the
// arguments for assertion + return a synthetic ActionEntry.
// ---------------------------------------------------------------------------

interface RecordingExecutor extends ExecutorService {
  calls: {
    thingId: ThingId;
    combo: ComboSpec;
    mod: string;
    sub: string;
  }[];
}

function makeRecordingExecutor(): RecordingExecutor {
  const calls: RecordingExecutor["calls"] = [];
  return {
    calls,
    async runCombo(thingId, combo, mod, sub) {
      calls.push({ thingId, combo, mod, sub });
      const entry: ActionEntry = {
        id: "fake-id",
        ts: 0,
        moderator: mod,
        thingId,
        comboName: combo.name,
        ranSteps: combo.steps,
      };
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness: full handler with REAL claims/combos/metrics modules running
// against an in-memory Redis fake plus a recording executor. Tests then
// drive the handler and assert against the fake's state directly.
// ---------------------------------------------------------------------------

interface Harness {
  deps: SoftWarningDeps;
  redis: RedisFake;
  realtime: RealtimeFake;
  executor: RecordingExecutor;
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
  const executor = makeRecordingExecutor();

  const claimsDeps: ClaimsDeps = {
    redis,
    realtime,
    now: () => nowMs,
  };
  const combosDeps: CombosDeps = { redis };
  const metricsDeps: MetricsDeps = {
    redis,
    now: () => nowMs,
  };

  const claimsService: ClaimsService = {
    claim: (sub, thingId, mod) => realClaim(sub, thingId, mod, claimsDeps),
  };
  const combosService: CombosService = {
    listCombos: async (sub) => {
      // Re-implement listCombos here over the redis fake so the test
      // exercises the SAME read path the route handler uses in 8.2.
      // (Going through the real combos module would require a circular
      // import; the fake-based round-trip is equivalent.)
      const all = await redis.hGetAll(`combos:${sub}`);
      const out: ComboSpec[] = [];
      for (const value of Object.values(all)) {
        try {
          out.push(JSON.parse(value) as ComboSpec);
        } catch {
          /* skip */
        }
      }
      return out;
    },
  };
  const metricsService: MetricsService = {
    bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
  };

  const authFn = vi.fn<AuthFn>(opts.authImpl);

  const deps: SoftWarningDeps = {
    auth: authFn,
    getSub: () => opts.sub,
    claims: claimsService,
    combos: combosService,
    executor,
    metrics: metricsService,
  };

  return {
    deps,
    redis,
    realtime,
    executor,
    authFn,
    setNow(t) {
      nowMs = t;
    },
    // Expose combosDeps for seeding combos via real saveCombo.
    ...({ combosDeps } as { combosDeps: CombosDeps }),
  } as Harness;
}

const SUB = "Modsynnow";
const NOW = Date.UTC(2025, 9, 15);

// ---------------------------------------------------------------------------
// 403 — auth throws → Forbidden toast, zero downstream side effects.
// ---------------------------------------------------------------------------

describe("403: auth throws ForbiddenError → Forbidden toast with zero side effects", () => {
  test("returns Forbidden toast and never invokes claims/combos/executor/metrics on the throw path", async () => {
    const { deps, redis, realtime, executor, authFn } = makeHarness({
      authImpl: async ({ sub }) => {
        throw new ForbiddenError("intruder", sub);
      },
      sub: SUB,
      initialNow: NOW,
    });

    const body: SoftWarningSubmitBody = {
      values: { proceed: true },
      data: { kind: "claim", thingId: "t3_abc123" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({
      showToast: { text: "Forbidden", appearance: "neutral" },
    });
    expect(authFn).toHaveBeenCalledTimes(1);

    // Critical: the auth-throw path does not write OR publish anything.
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.hSet).toBe(0);
    expect(redis._writes.del).toBe(0);
    expect(realtime.events).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// All 4 (kind, proceed) combinations as example tests.
// ---------------------------------------------------------------------------

describe("All 4 (kind, proceed) combinations route correctly", () => {
  test("(claim, true) → 1 hIncrBy on collisionsDetected, 1 claim write, 1 publish, no runCombo, 'Claimed (override)' toast", async () => {
    const { deps, redis, realtime, executor } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const body: SoftWarningSubmitBody = {
      values: { proceed: true },
      data: { kind: "claim", thingId: "t3_abc123" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Claimed (override)" });

    // Exactly one HINCRBY (the collision bump).
    expect(redis._writes.hIncrBy).toBe(1);
    // Verify the field was the collisions field — read back the metrics
    // hash and check exactly one field is set to "1".
    const week = await redis.hGetAll(
      // The week key embeds the ISO week of NOW; we don't need to know
      // it precisely, just enumerate hash keys to find the bucket.
      // hKeys on a missing prefix returns []; iterate redis maps via a
      // probe is heavy. Instead, assert from an indirect path: the
      // metrics write was on collisionsDetected by reading the value
      // after another bumpMetric call to the same field (covered in PBT).
      // Here, the simpler assertion is just hIncrBy === 1. The PBT
      // covers field-level routing.
      "noop",
    );
    void week; // eslint-no-unused-vars; quieten the unused destructure

    // Exactly one claim write: STRING set + index zAdd + 1 publish.
    expect(redis._writes.set).toBe(1);
    expect(redis._writes.zAdd).toBe(1);
    expect(realtime.events).toHaveLength(1);
    expect(realtime.events[0]!.channel).toBe(`claims-${SUB}`);
    expect(realtime.events[0]!.msg.type).toBe("claim");

    // Executor was NOT called on the claim branch.
    expect(executor.calls).toHaveLength(0);

    // Underlying claim record reflects the override.
    const raw = await redis.get(claimKey(SUB, "t3_abc123"));
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!);
    expect(record.moderator).toBe("alice");
  });

  test("(claim, false) → 1 hIncrBy on redundantActionsAvoided, no claim write, no publish, 'Cancelled' toast", async () => {
    const { deps, redis, realtime, executor } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const body: SoftWarningSubmitBody = {
      values: { proceed: false },
      data: { kind: "claim", thingId: "t3_abc123" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Cancelled" });
    expect(redis._writes.hIncrBy).toBe(1);
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(realtime.events).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });

  test("(combo, true) → 1 hIncrBy on collisionsDetected, 1 claim write, 1 publish, 1 runCombo with right ComboSpec, 'Combo complete' toast", async () => {
    const harness = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    const { deps, redis, realtime, executor } = harness;
    const combosDeps: CombosDeps = { redis };

    const spec: ComboSpec = {
      name: "warn-and-remove",
      steps: [
        { kind: "MODNOTE", text: "third strike" },
        { kind: "REMOVE" },
      ],
    };
    await saveCombo(SUB, spec, combosDeps);

    // Snapshot writes from the seeding phase so subsequent assertions
    // measure ONLY what the handler does.
    const seedHIncrBy = redis._writes.hIncrBy;
    const seedSet = redis._writes.set;
    const seedZAdd = redis._writes.zAdd;
    const seedRealtime = realtime.events.length;

    const body: SoftWarningSubmitBody = {
      values: { proceed: true },
      data: { kind: "combo", thingId: "t3_abc123", comboName: "warn-and-remove" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Combo complete" });

    // Counter routing.
    expect(redis._writes.hIncrBy - seedHIncrBy).toBe(1);
    // Claim write (STRING set + index zAdd) and one publish.
    expect(redis._writes.set - seedSet).toBe(1);
    expect(redis._writes.zAdd - seedZAdd).toBe(1);
    expect(realtime.events.length - seedRealtime).toBe(1);
    expect(realtime.events[realtime.events.length - 1]!.channel).toBe(
      `claims-${SUB}`,
    );

    // runCombo invoked exactly once with the matching ComboSpec.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]!.thingId).toBe("t3_abc123");
    expect(executor.calls[0]!.combo).toEqual(spec);
    expect(executor.calls[0]!.mod).toBe("alice");
    expect(executor.calls[0]!.sub).toBe(SUB);
  });

  test("(combo, false) → 1 hIncrBy on redundantActionsAvoided, no writes, 'Cancelled' toast", async () => {
    const { deps, redis, realtime, executor } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const body: SoftWarningSubmitBody = {
      values: { proceed: false },
      data: { kind: "combo", thingId: "t3_abc123", comboName: "warn-and-remove" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Cancelled" });
    expect(redis._writes.hIncrBy).toBe(1);
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(redis._writes.del).toBe(0);
    expect(realtime.events).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (combo, true) with comboName missing from the combos hash → 404 toast.
// ---------------------------------------------------------------------------

describe("(combo, true) with unknown comboName → 'Combo not found' toast, no runCombo, no claim write", () => {
  test("returns 'Combo not found' and skips claim/runCombo when the named combo is absent", async () => {
    const { deps, redis, realtime, executor } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });

    const body: SoftWarningSubmitBody = {
      values: { proceed: true },
      data: { kind: "combo", thingId: "t3_abc123", comboName: "ghost-combo" },
    };

    const res = (await onSoftWarningSubmit(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Combo not found" });

    // Collision bump still fires per design.md flow step 5 ("server
    // HINCRBY collisionsDetected, then writes the claim..." — the
    // collision is recorded the moment the moderator chose to override,
    // even if the combo name happens to be wrong).
    expect(redis._writes.hIncrBy).toBe(1);

    // No claim write, no publish, no runCombo.
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
    expect(realtime.events).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PBT — Property 9 (counter routing).
//
// forall (kind, proceed) ∈ {(claim,T), (claim,F), (combo,T), (combo,F)}.
//   - On proceed === true: collisionsDetected was incremented exactly
//     once on metrics:{sub}:{week}, redundantActionsAvoided was NOT
//     incremented, softWarningsShown was NEVER incremented.
//   - On proceed === false: redundantActionsAvoided was incremented
//     exactly once, collisionsDetected was NOT incremented,
//     softWarningsShown was NEVER incremented.
//   - In all 4 cases: total hIncrBy count is 1 (modulo seed writes
//     for the combo branch which seeds via saveCombo — saveCombo does
//     not bump metrics, so seed-deltas are still 0 on hIncrBy).
// ---------------------------------------------------------------------------

describe("Property 9 (counter routing for all 4 kind/proceed combinations)", () => {
  // Reuse the same arbitrary shapes as tests/claimHandler.spec.ts so
  // we cover the same realistic input space (Reddit's actual username
  // + subreddit constraints, the two thingId prefixes).
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const thingPrefix = fc.constantFrom<"t1_" | "t3_">("t1_", "t3_");
  const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);
  const kindArb = fc.constantFrom<"claim" | "combo">("claim", "combo");
  const proceedArb = fc.boolean();
  // Combo-name regex per validator (case-explicit form to avoid the
  // fast-check `i`-flag rejection documented in tests/combos.spec.ts).
  const comboNameArb = fc.stringMatching(/^[a-z0-9-_]{1,15}$/);

  // Track which fields were touched by inspecting the underlying
  // metrics hash in the redis fake, plus the per-method write counter
  // for total-call assertions.
  test("forall (kind, proceed): exactly the expected counter is incremented exactly once; softWarningsShown is never incremented", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        modArb,
        thingPrefix,
        thingSuffixArb,
        kindArb,
        proceedArb,
        comboNameArb,
        async (sub, mod, prefix, suffix, kind, proceed, comboName) => {
          const targetId = `${prefix}${suffix}`;
          const harness = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: mod, sub: s }),
            sub,
            initialNow: NOW,
          });
          const { deps, redis } = harness;
          const combosDeps: CombosDeps = { redis };

          // For the combo-true path we need the combo to exist, else the
          // routing is "combo not found" which still bumps collision
          // exactly once (also a valid case — but we want to also exercise
          // the success tail). Seed the named combo for the combo branch.
          if (kind === "combo") {
            const spec: ComboSpec = {
              name: comboName,
              steps: [{ kind: "REMOVE" }],
            };
            await saveCombo(sub, spec, combosDeps);
          }

          // Snapshot hIncrBy after seeding (saveCombo uses hSet not
          // hIncrBy, so seed-delta on hIncrBy is 0 — but track for
          // safety).
          const seedHIncrBy = redis._writes.hIncrBy;

          const body: SoftWarningSubmitBody = {
            values: { proceed },
            data:
              kind === "combo"
                ? { kind, thingId: targetId, comboName }
                : { kind, thingId: targetId },
          };

          await onSoftWarningSubmit(body, deps);

          // Total hIncrBy delta is exactly 1 in all four cases.
          expect(redis._writes.hIncrBy - seedHIncrBy).toBe(1);

          // Inspect every metrics:{sub}:{week} hash and verify field
          // routing. We don't know the exact week key, but we can
          // enumerate by reading any hash key in the fake whose keys
          // include "metrics:" — instead, do a targeted hGetAll for
          // the well-known week of NOW via redisKeys.metricsKey.
          // Importing isoWeekKey / metricsKey locally keeps the
          // assertion deterministic without depending on any fake
          // internals.
          const { metricsKey, isoWeekKey } = await import(
            "../src/server/redisKeys.js"
          );
          const week = isoWeekKey(new Date(NOW));
          const bucket = await redis.hGetAll(metricsKey(sub, week));

          // softWarningsShown is NEVER incremented by this handler.
          expect(bucket.softWarningsShown).toBeUndefined();

          if (proceed) {
            expect(bucket.collisionsDetected).toBe("1");
            expect(bucket.redundantActionsAvoided).toBeUndefined();
          } else {
            expect(bucket.collisionsDetected).toBeUndefined();
            expect(bucket.redundantActionsAvoided).toBe("1");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// PBT — Property 3 (combo branch on override).
//
// forall (combo kind, proceed=true) with the named combo present.
// After the handler returns:
//   - claim:{sub}:{thingId} holds { moderator: currentMod }
//   - the index has thingId with score ≈ now + 90000 (ttlSec ≈ 90)
//   - executor.runCombo was invoked exactly once with the matching
//     ComboSpec.
// ---------------------------------------------------------------------------

describe("Property 3 (combo branch on override): claim invariant + runCombo invocation", () => {
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const thingPrefix = fc.constantFrom<"t1_" | "t3_">("t1_", "t3_");
  const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);
  const comboNameArb = fc.stringMatching(/^[a-z0-9-_]{1,15}$/);

  // Small valid combo arbitrary covering the 5 step kinds. Mirrors
  // tests/combos.spec.ts validComboArb but uses the `name` from the
  // outer property's context (so we can reference it after seeding).
  const stepArb: fc.Arbitrary<ComboStep> = fc.oneof<fc.Arbitrary<ComboStep>>(
    fc.constant({ kind: "REMOVE" } as const),
    fc.constant({ kind: "LOCK" } as const),
    fc.constant({ kind: "APPROVE" } as const),
    fc
      .record({
        days: fc.integer({ min: 0, max: 999 }),
        reason: fc.string({ maxLength: 30 }),
      })
      .map(({ days, reason }): ComboStep => ({ kind: "BAN", days, reason })),
    fc
      .string({ maxLength: 100 })
      .map((text): ComboStep => ({ kind: "MODNOTE", text })),
  );

  test("forall (combo kind, proceed=true): claim invariant holds + runCombo invoked exactly once with matching ComboSpec", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        modArb,
        thingPrefix,
        thingSuffixArb,
        comboNameArb,
        fc.array(stepArb, { minLength: 1, maxLength: 4 }),
        async (sub, mod, prefix, suffix, comboName, steps) => {
          const targetId = `${prefix}${suffix}`;
          const harness = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: mod, sub: s }),
            sub,
            initialNow: NOW,
          });
          const { deps, redis, executor } = harness;
          const combosDeps: CombosDeps = { redis };

          const spec: ComboSpec = { name: comboName, steps };
          await saveCombo(sub, spec, combosDeps);

          const body: SoftWarningSubmitBody = {
            values: { proceed: true },
            data: { kind: "combo", thingId: targetId, comboName },
          };

          await onSoftWarningSubmit(body, deps);

          // Claim invariant: claim:{sub}:{thingId} holds the right
          // moderator with ttlSec ≈ 90.
          const raw = await redis.get(claimKey(sub, targetId));
          expect(raw).toBeDefined();
          const record = JSON.parse(raw!) as {
            moderator: string;
            claimedAt: number;
          };
          expect(record.moderator).toBe(mod);

          // Index score = NOW + CLAIM_TTL_SEC * 1000.
          const score = await redis.zScore(`claims-index:${sub}`, targetId);
          expect(score).toBeDefined();
          expect(score!).toBe(NOW + CLAIM_TTL_SEC * 1000);

          // runCombo invoked exactly once with the matching ComboSpec.
          expect(executor.calls).toHaveLength(1);
          expect(executor.calls[0]!.thingId).toBe(targetId);
          expect(executor.calls[0]!.combo).toEqual(spec);
          expect(executor.calls[0]!.mod).toBe(mod);
          expect(executor.calls[0]!.sub).toBe(sub);
        },
      ),
      { numRuns: 100 },
    );
  });
});
