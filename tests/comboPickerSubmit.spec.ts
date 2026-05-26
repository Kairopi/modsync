import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";

import {
  onComboPickerSubmit,
  type AuthFn,
  type ClaimsService,
  type CombosService,
  type ComboPickerSubmitBody,
  type ComboPickerSubmitDeps,
  type ExecutorService,
  type MetricsService,
} from "../src/server/forms/comboPickerSubmit.js";
import {
  claim as realClaim,
  getClaim as realGetClaim,
  type ClaimsDeps,
  type RealtimeLike,
} from "../src/server/claims.js";
import {
  listCombos as realListCombos,
  saveCombo as realSaveCombo,
  type CombosDeps,
} from "../src/server/combos.js";
import { runCombo as realRunCombo } from "../src/server/executor.js";
import { bumpMetric, type MetricsDeps } from "../src/server/metrics.js";
import { ForbiddenError } from "../src/server/auth.js";
import type {
  ActionEntry,
  ComboSpec,
  RealtimeEvent,
  ThingId,
} from "../src/shared/types.js";
import { actionsKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";
import type { UiResponse } from "@devvit/web/shared";

/**
 * Tests for `tasks.md` task 8.3b — `/internal/form/combo-picker-submit`
 * handler.
 *
 * Coverage (matches the user's prompt):
 *   - 403 path → 'Forbidden' toast, zero side effects (Property 10).
 *   - Combo not found → 'Combo not found' toast, zero side effects.
 *   - Invalid thingId shape → 'Invalid target' toast, zero side effects.
 *   - Foreign claim → softWarningForm with data.kind === 'combo' and
 *     data.comboName, exactly 1 hIncrBy on softWarningsShown, no claim
 *     write, no executor call (Property 9 form-shown counter routing).
 *   - No foreign claim → executor invoked exactly once, response is
 *     'Combo complete' toast, claim was written, action appended to
 *     feed (Property 3 combo branch claim invariant).
 *   - Own-claim re-run → still proceeds (the foreign-claim warning
 *     fires only when the claim belongs to a DIFFERENT moderator).
 *   - PBT (≥100 iter) **Property 9 (form-shown increment for combo
 *     flow)** — forall foreign claim. exactly one HINCRBY against
 *     softWarningsShown, response is showForm with data.kind === 'combo'.
 *
 * **Validates: Property 3 (combo branch), Property 9 (counter routing),
 * Property 10 (auth gate has no side effects on throw).**
 */

// ---------------------------------------------------------------------------
// Realtime recording fake — mirrors the pattern in tests/claimHandler.spec.ts
// and tests/claims.spec.ts. Tracks both channel and msg so the property
// tests can distinguish `claims-{sub}` from `actions-{sub}` traffic.
// ---------------------------------------------------------------------------

interface RealtimeFake {
  send(channel: string, msg: unknown): Promise<void>;
  events: { channel: string; msg: unknown }[];
}

function makeRealtimeFake(): RealtimeFake {
  const events: { channel: string; msg: unknown }[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg });
    },
  };
}

// ---------------------------------------------------------------------------
// Reddit recording fake — mirrors tests/executor.spec.ts. We only care
// about call counts here; the executor's exact dispatch shape is
// already locked by tests/executor.spec.ts.
// ---------------------------------------------------------------------------

interface RecordedRedditCall {
  method: string;
  args: unknown[];
}

function makeRedditFake(): {
  calls: RecordedRedditCall[];
  remove(thingId: ThingId): Promise<void>;
  approve(thingId: ThingId): Promise<void>;
  lock(thingId: ThingId): Promise<void>;
  banUser(opts: {
    thingId: ThingId;
    days: number;
    reason: string;
    by: string;
  }): Promise<void>;
  addModNote(opts: {
    thingId: ThingId;
    text: string;
    label?: string;
    by: string;
  }): Promise<void>;
} {
  const calls: RecordedRedditCall[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    async remove(thingId) {
      record("remove", [thingId]);
    },
    async approve(thingId) {
      record("approve", [thingId]);
    },
    async lock(thingId) {
      record("lock", [thingId]);
    },
    async banUser(banOpts) {
      record("banUser", [banOpts]);
    },
    async addModNote(noteOpts) {
      record("addModNote", [noteOpts]);
    },
  };
}

// ---------------------------------------------------------------------------
// Recording executor fake — wraps the real `runCombo` so we can count
// invocations AND assert the args without mocking the executor module.
// Property 3's "executor invoked exactly once with the matching combo"
// invariant uses this counter.
// ---------------------------------------------------------------------------

interface RecordedRunCombo {
  thingId: ThingId;
  combo: ComboSpec;
  mod: string;
  sub: string;
}

// ---------------------------------------------------------------------------
// Harness: build a full handler with REAL claims/combos/executor/metrics
// modules running against an in-memory Redis fake + recording realtime
// + recording reddit fake. Tests drive the handler and assert against
// the fake state directly.
// ---------------------------------------------------------------------------

interface Harness {
  deps: ComboPickerSubmitDeps;
  redis: RedisFake;
  realtime: RealtimeFake;
  reddit: ReturnType<typeof makeRedditFake>;
  authFn: ReturnType<typeof vi.fn<AuthFn>>;
  executorCalls: RecordedRunCombo[];
  // Helpers
  seedCombo(spec: ComboSpec): Promise<void>;
  seedClaim(thingId: ThingId, mod: string): Promise<void>;
}

function makeHarness(opts: {
  authImpl: AuthFn;
  sub: string;
  initialNow?: number;
}): Harness {
  const nowMs = opts.initialNow ?? Date.UTC(2025, 9, 15);
  const redis = makeRedisFake({ now: () => nowMs });
  const realtime = makeRealtimeFake();
  const reddit = makeRedditFake();

  const claimsDeps: ClaimsDeps = {
    redis,
    realtime: realtime as unknown as RealtimeLike,
    now: () => nowMs,
  };
  const combosDeps: CombosDeps = { redis };
  const metricsDeps: MetricsDeps = { redis, now: () => nowMs };

  const claimsService: ClaimsService = {
    getClaim: (sub, thingId) => realGetClaim(sub, thingId, claimsDeps),
    claim: (sub, thingId, mod) => realClaim(sub, thingId, mod, claimsDeps),
  };
  const combosService: CombosService = {
    listCombos: (sub) => realListCombos(sub, combosDeps),
  };
  const metricsService: MetricsService = {
    bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
  };

  // Wrap the real executor so we can count invocations and capture
  // args. The real executor uses the same redis + realtime + reddit
  // fakes so its side effects (refresh per step, action append,
  // release publish) are observable on the same fakes.
  const executorCalls: RecordedRunCombo[] = [];
  const executorService: ExecutorService = {
    runCombo: async (thingId, combo, mod, sub): Promise<ActionEntry> => {
      executorCalls.push({ thingId, combo, mod, sub });
      return realRunCombo(thingId, combo, mod, sub, {
        redis,
        realtime: realtime as unknown as RealtimeLike,
        reddit,
        now: () => nowMs,
      });
    },
  };

  const authFn = vi.fn<AuthFn>(opts.authImpl);

  const deps: ComboPickerSubmitDeps = {
    auth: authFn,
    getSub: () => opts.sub,
    claims: claimsService,
    combos: combosService,
    executor: executorService,
    metrics: metricsService,
  };

  return {
    deps,
    redis,
    realtime,
    reddit,
    authFn,
    executorCalls,
    async seedCombo(spec) {
      await realSaveCombo(opts.sub, spec, combosDeps);
    },
    async seedClaim(thingId, mod) {
      await realClaim(opts.sub, thingId, mod, claimsDeps);
    },
  };
}

const SUB = "Modsynnow";
const NOW = Date.UTC(2025, 9, 15);

const SAMPLE_COMBO: ComboSpec = {
  name: "spam-cleanup",
  steps: [
    { kind: "REMOVE" },
    { kind: "MODNOTE", text: "removed: brigading" },
  ],
};

function makeBody(comboName: string, thingId: string): ComboPickerSubmitBody {
  return {
    values: { comboName },
    data: { thingId },
  };
}

// ---------------------------------------------------------------------------
// 403 path — auth throws → Forbidden toast, zero side effects.
// ---------------------------------------------------------------------------

describe("403: auth throws ForbiddenError → Forbidden toast with zero side effects", () => {
  test("returns Forbidden toast and never invokes combos/claims/executor/metrics", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => {
        throw new ForbiddenError("intruder", sub);
      },
      sub: SUB,
      initialNow: NOW,
    });
    // Pre-seed a combo so a "combo not found" path is NOT what we'd
    // hit anyway — this isolates the auth-gate guarantee.
    await h.seedCombo(SAMPLE_COMBO);

    // After seeding, snapshot baseline write counters so post-auth
    // assertions measure ONLY what the handler did.
    const seedHSet = h.redis._writes.hSet;

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Forbidden" });
    expect(h.authFn).toHaveBeenCalledTimes(1);

    // Critical: auth-throw path does not write OR publish anything
    // beyond what the seed already did.
    expect(h.redis._writes.set).toBe(0);
    expect(h.redis._writes.zAdd).toBe(0);
    expect(h.redis._writes.del).toBe(0);
    expect(h.redis._writes.zRem).toBe(0);
    expect(h.redis._writes.hIncrBy).toBe(0);
    expect(h.redis._writes.hSet).toBe(seedHSet); // seed hSet preserved, no new writes
    expect(h.realtime.events).toHaveLength(0);
    expect(h.reddit.calls).toHaveLength(0);
    expect(h.executorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combo not found → 'Combo not found' toast, zero side effects.
// ---------------------------------------------------------------------------

describe("Combo not found", () => {
  test("returns 'Combo not found' toast with zero side effects", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    // No combos seeded — listCombos returns [].

    const res = (await onComboPickerSubmit(
      makeBody("missing-combo", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Combo not found" });

    expect(h.redis._writes.set).toBe(0);
    expect(h.redis._writes.zAdd).toBe(0);
    expect(h.redis._writes.hIncrBy).toBe(0);
    expect(h.redis._writes.hSet).toBe(0);
    expect(h.realtime.events).toHaveLength(0);
    expect(h.reddit.calls).toHaveLength(0);
    expect(h.executorCalls).toHaveLength(0);
  });

  test("returns 'Combo not found' toast even when other combos exist", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);
    const seedHSet = h.redis._writes.hSet;

    const res = (await onComboPickerSubmit(
      makeBody("not-this-one", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Combo not found" });
    expect(h.redis._writes.set).toBe(0); // no claim write
    expect(h.redis._writes.hIncrBy).toBe(0); // no metric bump
    expect(h.redis._writes.hSet).toBe(seedHSet);
    expect(h.executorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invalid thingId shape → 'Invalid target' toast, zero side effects.
// ---------------------------------------------------------------------------

describe("Invalid thingId shape", () => {
  test("returns 'Invalid target' toast for arbitrary string targetId", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);
    const seedHSet = h.redis._writes.hSet;

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "garbage-id"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });

    // No claim write, no metric bump, no realtime publish, no executor.
    expect(h.redis._writes.set).toBe(0);
    expect(h.redis._writes.zAdd).toBe(0);
    expect(h.redis._writes.hIncrBy).toBe(0);
    expect(h.redis._writes.hSet).toBe(seedHSet);
    expect(h.realtime.events).toHaveLength(0);
    expect(h.executorCalls).toHaveLength(0);
  });

  test("returns 'Invalid target' for t5_ subreddit prefix", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "t5_modsynnow"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });
    expect(h.executorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Foreign claim → softWarningForm + exactly one softWarningsShown
// HINCRBY + no claim write + no executor call.
// ---------------------------------------------------------------------------

describe("Foreign claim → softWarningForm with combo data envelope", () => {
  test("returns showForm with data.kind === 'combo' and data.comboName, exactly 1 softWarning bump, no executor call", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);
    // Foreign moderator owns the claim.
    await h.seedClaim("t3_abc123" as ThingId, "bob");

    // Snapshot post-seed counters so we measure ONLY the handler's deltas.
    const seedSet = h.redis._writes.set;
    const seedZAdd = h.redis._writes.zAdd;
    const seedRealtimeCount = h.realtime.events.length;

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    // Response shape: showForm, NOT showToast.
    expect(res.showToast).toBeUndefined();
    expect(res.showForm).toBeDefined();
    expect(res.showForm!.name).toBe("softWarningForm");
    expect(res.showForm!.data).toMatchObject({
      kind: "combo",
      thingId: "t3_abc123",
      comboName: "spam-cleanup",
    });

    // Form has at least the warningText and proceed fields.
    const fieldNames = res.showForm!.form.fields.map((f) =>
      "name" in f ? f.name : undefined,
    );
    expect(fieldNames).toContain("warningText");
    expect(fieldNames).toContain("proceed");

    // Exactly one HINCRBY (the softWarning bump).
    expect(h.redis._writes.hIncrBy).toBe(1);

    // NO claim write delta vs. the seed snapshot, NO new realtime
    // publish, NO executor call, NO Reddit-side effect.
    expect(h.redis._writes.set).toBe(seedSet);
    expect(h.redis._writes.zAdd).toBe(seedZAdd);
    expect(h.realtime.events.length).toBe(seedRealtimeCount);
    expect(h.executorCalls).toHaveLength(0);
    expect(h.reddit.calls).toHaveLength(0);

    // The claim record still belongs to the foreign mod — handler
    // must not have overwritten it.
    const stored = await realGetClaim("Modsynnow", "t3_abc123" as ThingId, {
      redis: h.redis,
      realtime: h.realtime as unknown as RealtimeLike,
      now: () => NOW,
    });
    expect(stored).not.toBeNull();
    expect(stored!.moderator).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// No foreign claim → executor runs end-to-end + 'Combo complete' toast.
// ---------------------------------------------------------------------------

describe("No foreign claim → executor runs combo end-to-end", () => {
  test("returns 'Combo complete' toast, executor invoked exactly once, claim + feed reflect the run", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Combo complete" });

    // Executor invoked exactly once with the right args.
    expect(h.executorCalls).toHaveLength(1);
    expect(h.executorCalls[0]).toEqual({
      thingId: "t3_abc123",
      combo: SAMPLE_COMBO,
      mod: "alice",
      sub: SUB,
    });

    // Reddit calls match combo steps (REMOVE + MODNOTE = 2).
    expect(h.reddit.calls.map((c) => c.method)).toEqual([
      "remove",
      "addModNote",
    ]);

    // Feed got exactly one append.
    const feedMembers = await h.redis.zRange(actionsKey(SUB), 0, -1);
    expect(feedMembers).toHaveLength(1);
    const persisted = JSON.parse(feedMembers[0]!.member) as ActionEntry;
    expect(persisted.moderator).toBe("alice");
    expect(persisted.thingId).toBe("t3_abc123");
    expect(persisted.comboName).toBe("spam-cleanup");
    expect(persisted.ranSteps).toEqual(SAMPLE_COMBO.steps);

    // No softWarning bump on this branch.
    expect(h.redis._writes.hIncrBy).toBe(0);

    // At least one realtime event on each channel (claim + action +
    // release).
    const claimEvents = h.realtime.events.filter(
      (e) => e.channel === `claims-${SUB}`,
    );
    const actionEvents = h.realtime.events.filter(
      (e) => e.channel === `actions-${SUB}`,
    );
    expect(claimEvents.length).toBeGreaterThan(0);
    expect(actionEvents.length).toBe(1);
    // Last claims-channel event is the release.
    const lastClaimEv = claimEvents[claimEvents.length - 1]!;
    expect((lastClaimEv.msg as { type: string }).type).toBe("release");
  });
});

// ---------------------------------------------------------------------------
// Own-claim re-run → still proceeds. Re-running a combo on a Thing
// you already claimed is a normal refresh-and-go path; the foreign-
// claim warning only fires when a DIFFERENT moderator owns the claim.
// ---------------------------------------------------------------------------

describe("Own-claim re-run", () => {
  test("re-running a combo on a Thing I already own succeeds without bumping softWarningsShown", async () => {
    const h = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
      initialNow: NOW,
    });
    await h.seedCombo(SAMPLE_COMBO);
    await h.seedClaim("t3_abc123" as ThingId, "alice");

    const res = (await onComboPickerSubmit(
      makeBody("spam-cleanup", "t3_abc123"),
      h.deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Combo complete" });
    expect(h.executorCalls).toHaveLength(1);
    // No softWarning bump on this branch.
    expect(h.redis._writes.hIncrBy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PBT — Property 9 (form-shown increment for combo flow).
//
// forall (sub, currentMod, foreignMod !== currentMod, thingId, comboName):
//   - exactly one HINCRBY against softWarningsShown
//   - response is showForm with data.kind === 'combo' and data.comboName
//   - NO claim write delta, NO new realtime publish, NO executor call
// ---------------------------------------------------------------------------

describe("Property 9: foreign claim → exactly one softWarningsShown HINCRBY + showForm{ kind: 'combo' }", () => {
  // Username regex matches Reddit's actual constraint and avoids the
  // `__proto__` collision class that bit `tests/scrub.spec.ts`.
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const thingPrefix = fc.constantFrom("t1_", "t3_");
  const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);
  // Combo name regex matches COMBO_NAME_REGEX from shared/types but
  // without the /i flag (fast-check 4 rejects /i in stringMatching).
  const comboNameArb = fc.stringMatching(/^[A-Za-z0-9\-_ ]{1,40}$/);

  test("forall foreign claim. exactly one softWarning bump, response is showForm with combo data envelope, no claim/executor side effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // Two distinct moderators (foreign vs current).
        fc.tuple(modArb, modArb).filter(([a, b]) => a !== b),
        thingPrefix,
        thingSuffixArb,
        comboNameArb,
        async (sub, [foreignMod, currentMod], prefix, suffix, comboName) => {
          const targetId = `${prefix}${suffix}`;

          const h = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: currentMod, sub: s }),
            sub,
            initialNow: NOW,
          });

          // Seed a combo under the picked name + a foreign claim.
          await h.seedCombo({
            name: comboName,
            steps: [{ kind: "REMOVE" }],
          });
          await h.seedClaim(targetId as ThingId, foreignMod);

          // Snapshot post-seed counters so we measure ONLY the handler.
          const seedSet = h.redis._writes.set;
          const seedZAdd = h.redis._writes.zAdd;
          const seedHSet = h.redis._writes.hSet;
          const seedRealtimeCount = h.realtime.events.length;
          const seedHIncrBy = h.redis._writes.hIncrBy;

          const res = (await onComboPickerSubmit(
            makeBody(comboName, targetId),
            h.deps,
          )) as UiResponse;

          // Response: showForm, NOT showToast.
          expect(res.showToast).toBeUndefined();
          expect(res.showForm).toBeDefined();
          expect(res.showForm!.name).toBe("softWarningForm");
          expect(res.showForm!.data).toMatchObject({
            kind: "combo",
            thingId: targetId,
            comboName,
          });

          // Exactly one new HINCRBY (the softWarning bump) on top of
          // the seed (which never bumps softWarningsShown).
          expect(h.redis._writes.hIncrBy - seedHIncrBy).toBe(1);

          // NO claim write delta, NO new realtime publish, NO executor call.
          expect(h.redis._writes.set).toBe(seedSet);
          expect(h.redis._writes.zAdd).toBe(seedZAdd);
          expect(h.redis._writes.hSet).toBe(seedHSet);
          expect(h.realtime.events.length).toBe(seedRealtimeCount);
          expect(h.executorCalls).toHaveLength(0);
          expect(h.reddit.calls).toHaveLength(0);

          // The foreign claim is intact — handler didn't overwrite.
          const stored = await realGetClaim(sub, targetId as ThingId, {
            redis: h.redis,
            realtime: h.realtime as unknown as RealtimeLike,
            now: () => NOW,
          });
          expect(stored).not.toBeNull();
          expect(stored!.moderator).toBe(foreignMod);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Recording-fake confirmation: combo branch invariant from Property 3.
//
// Asserts that `runCombo` is invoked iff the branch is "no foreign
// claim" and gets the matching ComboSpec. Locks task 8.3b's
// acceptance signal: "recording dispatch fake confirms `runCombo` is
// invoked iff branch ∈ {none}".
// ---------------------------------------------------------------------------

describe("Property 3 (combo branch): runCombo invoked iff branch ∈ {none}", () => {
  test("forall (combo, currentMod) with no foreign claim. runCombo invoked exactly once with matching ComboSpec", async () => {
    const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
    const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
    const thingPrefix = fc.constantFrom("t1_", "t3_");
    const thingSuffixArb = fc.stringMatching(/^[a-z0-9]{4,10}$/);
    const comboNameArb = fc.stringMatching(/^[A-Za-z0-9\-_ ]{1,40}$/);

    await fc.assert(
      fc.asyncProperty(
        subArb,
        modArb,
        thingPrefix,
        thingSuffixArb,
        comboNameArb,
        async (sub, currentMod, prefix, suffix, comboName) => {
          const targetId = `${prefix}${suffix}`;
          const combo: ComboSpec = {
            name: comboName,
            steps: [{ kind: "APPROVE" }],
          };

          const h = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: currentMod, sub: s }),
            sub,
            initialNow: NOW,
          });
          await h.seedCombo(combo);
          // No claim seeded — branch is "no foreign claim".

          const res = (await onComboPickerSubmit(
            makeBody(comboName, targetId),
            h.deps,
          )) as UiResponse;

          expect(res).toEqual({ showToast: "Combo complete" });
          expect(h.executorCalls).toHaveLength(1);
          expect(h.executorCalls[0]).toEqual({
            thingId: targetId,
            combo,
            mod: currentMod,
            sub,
          });
          // No softWarning bump on the no-foreign-claim branch.
          expect(h.redis._writes.hIncrBy).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
