import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { runCombo, type ExecutorDeps, type RedditClient } from "../src/server/executor.js";
import type { ComboSpec, ComboStep, ThingId } from "../src/shared/types.js";
import { actionsKey, claimKey, claimsIndexKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Combo executor tests for `tasks.md` task 8.4. One PBT at >=100
 * iterations covering the all-success path, plus example tests for the
 * happy 3-step run, the partial-failure mid-step, and dispatch shape
 * for BAN / MODNOTE. The recording fakes assert exact-once semantics
 * for refresh / append / publish / release.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3 — combo execution semantics
 * from `design.md` "Combo Execution Engine".**
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PublishedEvent {
  channel: string;
  msg: unknown;
}

/**
 * Recording realtime fake. Captures every (channel, msg) the executor
 * publishes (claim refresh events on `claims-{sub}`, the final
 * `action` event on `actions-{sub}`, and the final release event on
 * `claims-{sub}`).
 */
function makeRealtimeFake(): {
  send: (channel: string, msg: unknown) => Promise<void>;
  events: PublishedEvent[];
} {
  const events: PublishedEvent[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg });
    },
  };
}

interface RecordedRedditCall {
  method: keyof RedditClient;
  args: unknown[];
}

/**
 * Recording reddit fake. Each method records its name + args; an
 * optional per-method failure injection lets tests force a step to
 * throw at a specific index. Default is success across the board.
 */
function makeRedditFake(opts: {
  failOn?: { method: keyof RedditClient; message: string };
} = {}): RedditClient & { calls: RecordedRedditCall[] } {
  const calls: RecordedRedditCall[] = [];
  const recordOrThrow = async (
    method: keyof RedditClient,
    args: unknown[],
  ): Promise<void> => {
    calls.push({ method, args });
    if (opts.failOn && opts.failOn.method === method) {
      throw new Error(opts.failOn.message);
    }
  };
  return {
    calls,
    async remove(thingId) {
      await recordOrThrow("remove", [thingId]);
    },
    async approve(thingId) {
      await recordOrThrow("approve", [thingId]);
    },
    async lock(thingId) {
      await recordOrThrow("lock", [thingId]);
    },
    async banUser(banOpts) {
      await recordOrThrow("banUser", [banOpts]);
    },
    async addModNote(noteOpts) {
      await recordOrThrow("addModNote", [noteOpts]);
    },
  };
}

function makeDeps(opts: {
  initialNow?: number;
  reddit?: RedditClient & { calls: RecordedRedditCall[] };
  idGen?: () => string;
} = {}): {
  deps: ExecutorDeps;
  redis: RedisFake;
  realtime: ReturnType<typeof makeRealtimeFake>;
  reddit: RedditClient & { calls: RecordedRedditCall[] };
  setNow: (t: number) => void;
} {
  let nowMs = opts.initialNow ?? 1_700_000_000_000;
  const redis = makeRedisFake({ now: () => nowMs });
  const realtime = makeRealtimeFake();
  const reddit = opts.reddit ?? makeRedditFake();
  const deps: ExecutorDeps = {
    redis,
    realtime,
    reddit,
    now: () => nowMs,
    ...(opts.idGen !== undefined ? { idGen: opts.idGen } : {}),
  };
  return {
    deps,
    redis,
    realtime,
    reddit,
    setNow(t) {
      nowMs = t;
    },
  };
}

// ---------------------------------------------------------------------------
// Example: happy path — 3 successful steps
// ---------------------------------------------------------------------------

describe("runCombo — happy path", () => {
  test("3-step combo (REMOVE, LOCK, MODNOTE) completes cleanly", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t3_abc123";
    const mod = "alice";
    const combo: ComboSpec = {
      name: "spam-cleanup",
      steps: [
        { kind: "REMOVE" },
        { kind: "LOCK" },
        { kind: "MODNOTE", text: "Removed: brigading", label: "ABUSE_WARNING" },
      ],
    };

    const { deps, redis, realtime, reddit } = makeDeps({
      idGen: () => "01HXZ0000000000000000001",
    });

    const entry = await runCombo(thingId, combo, mod, sub, deps);

    // Returned ActionEntry shape.
    expect(entry.id).toBe("01HXZ0000000000000000001");
    expect(entry.moderator).toBe(mod);
    expect(entry.thingId).toBe(thingId);
    expect(entry.comboName).toBe("spam-cleanup");
    expect(entry.ranSteps).toEqual(combo.steps);
    expect(entry.failedStepIndex).toBeUndefined();
    expect(entry.failureMessage).toBeUndefined();

    // Reddit calls in order.
    expect(reddit.calls.map((c) => c.method)).toEqual([
      "remove",
      "lock",
      "addModNote",
    ]);

    // Feed: exactly one append matching the entry.
    expect(redis._writes.zAdd).toBeGreaterThanOrEqual(1);
    const feedMembers = await redis.zRange(actionsKey(sub), 0, -1);
    expect(feedMembers).toHaveLength(1);
    expect(JSON.parse(feedMembers[0]!.member)).toEqual(entry);

    // Realtime: one `claim` per step (refresh) + 1 `action` + 1 `release`.
    const channels = realtime.events.map((e) => e.channel);
    const claimEvents = realtime.events.filter(
      (e) => e.channel === `claims-${sub}`,
    );
    const actionEvents = realtime.events.filter(
      (e) => e.channel === `actions-${sub}`,
    );

    // 3 refresh `claim` events + 1 final `release` event = 4 on claims channel.
    expect(claimEvents).toHaveLength(4);
    expect(actionEvents).toHaveLength(1);
    expect(channels).toContain(`actions-${sub}`);

    // The 4 claims-channel events: first 3 are `claim` (refresh), last is `release`.
    const claimTypes = claimEvents.map(
      (e) => (e.msg as { type: string }).type,
    );
    expect(claimTypes).toEqual(["claim", "claim", "claim", "release"]);
    expect(
      (claimEvents[3]!.msg as { reason: string }).reason,
    ).toBe("completed");

    // The action event mirrors the appended entry.
    expect(actionEvents[0]!.msg).toEqual({ type: "action", entry });

    // Claim is gone after release.
    expect(await redis.get(claimKey(sub, thingId))).toBeUndefined();
    expect(await redis.zScore(claimsIndexKey(sub), thingId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Example: partial failure — step 1 (LOCK) throws
// ---------------------------------------------------------------------------

describe("runCombo — partial failure", () => {
  test("step 1 (LOCK) throws, ranSteps holds only [REMOVE], release reason is manual", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t3_def456";
    const mod = "bob";
    const combo: ComboSpec = {
      name: "spam-cleanup",
      steps: [
        { kind: "REMOVE" },
        { kind: "LOCK" },
        { kind: "MODNOTE", text: "after lock" },
      ],
    };

    const reddit = makeRedditFake({
      failOn: { method: "lock", message: "API error" },
    });
    const { deps, redis, realtime } = makeDeps({
      reddit,
      idGen: () => "01HXZ0000000000000000002",
    });

    const entry = await runCombo(thingId, combo, mod, sub, deps);

    // Failure recorded.
    expect(entry.ranSteps).toEqual([{ kind: "REMOVE" }]);
    expect(entry.failedStepIndex).toBe(1);
    expect(entry.failureMessage).toBe("API error");

    // Reddit: remove succeeded, lock threw, addModNote never called.
    expect(reddit.calls.map((c) => c.method)).toEqual(["remove", "lock"]);

    // Feed appended exactly once.
    const feedMembers = await redis.zRange(actionsKey(sub), 0, -1);
    expect(feedMembers).toHaveLength(1);
    expect(JSON.parse(feedMembers[0]!.member)).toEqual(entry);

    // Realtime: 2 refresh `claim` events (one before REMOVE, one before
    // LOCK; LOCK threw AFTER refresh) + 1 final `release` (manual).
    const claimEvents = realtime.events.filter(
      (e) => e.channel === `claims-${sub}`,
    );
    expect(claimEvents).toHaveLength(3);
    expect(
      claimEvents.map((e) => (e.msg as { type: string }).type),
    ).toEqual(["claim", "claim", "release"]);
    expect(
      (claimEvents[2]!.msg as { reason: string }).reason,
    ).toBe("manual");

    const actionEvents = realtime.events.filter(
      (e) => e.channel === `actions-${sub}`,
    );
    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]!.msg).toEqual({ type: "action", entry });

    // Claim released even though combo failed.
    expect(await redis.get(claimKey(sub, thingId))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Example: dispatch shape for BAN and MODNOTE
// ---------------------------------------------------------------------------

describe("runCombo — dispatch shape", () => {
  test("BAN step is dispatched with { thingId, days, reason, by: mod }", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t3_ban789";
    const mod = "carol";
    const combo: ComboSpec = {
      name: "ban-spammer",
      steps: [{ kind: "BAN", days: 7, reason: "spam" }],
    };
    const { deps, reddit } = makeDeps();

    await runCombo(thingId, combo, mod, sub, deps);

    expect(reddit.calls).toHaveLength(1);
    expect(reddit.calls[0]!.method).toBe("banUser");
    expect(reddit.calls[0]!.args[0]).toEqual({
      thingId,
      days: 7,
      reason: "spam",
      by: mod,
    });
  });

  test("MODNOTE step (with label) is dispatched with { thingId, text, label, by: mod }", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t1_note111";
    const mod = "dave";
    const combo: ComboSpec = {
      name: "note-helpful",
      steps: [
        {
          kind: "MODNOTE",
          text: "great answer",
          label: "HELPFUL_USER",
        },
      ],
    };
    const { deps, reddit } = makeDeps();

    await runCombo(thingId, combo, mod, sub, deps);

    expect(reddit.calls).toHaveLength(1);
    expect(reddit.calls[0]!.method).toBe("addModNote");
    expect(reddit.calls[0]!.args[0]).toEqual({
      thingId,
      text: "great answer",
      label: "HELPFUL_USER",
      by: mod,
    });
  });

  test("MODNOTE step (no label) is dispatched without a label key", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t1_note222";
    const mod = "erin";
    const combo: ComboSpec = {
      name: "note-bare",
      steps: [{ kind: "MODNOTE", text: "see rules" }],
    };
    const { deps, reddit } = makeDeps();

    await runCombo(thingId, combo, mod, sub, deps);

    expect(reddit.calls).toHaveLength(1);
    expect(reddit.calls[0]!.method).toBe("addModNote");
    const arg = reddit.calls[0]!.args[0] as Record<string, unknown>;
    expect(arg).toEqual({ thingId, text: "see rules", by: mod });
    expect("label" in arg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Example: refresh-per-step — recording fake confirms 3 refresh calls
//                            for a 3-step combo
// ---------------------------------------------------------------------------

describe("runCombo — refresh per step", () => {
  test("refresh runs exactly once per step (3 steps -> 3 refresh writes)", async () => {
    const sub = "Modsynnow";
    const thingId: ThingId = "t3_refr01";
    const mod = "frank";
    const combo: ComboSpec = {
      name: "trio",
      steps: [{ kind: "REMOVE" }, { kind: "LOCK" }, { kind: "APPROVE" }],
    };
    const { deps, redis, realtime } = makeDeps();

    await runCombo(thingId, combo, mod, sub, deps);

    // Refresh writes the STRING claim key + zAdds the index, once per
    // step. The claim STRING set count is at LEAST 3 (refresh × 3); the
    // zAdd count includes the 3 refresh-index updates plus the 1 feed
    // append, so totals are 3 and 4 respectively in this clean run.
    //
    // The cleanest invariant is the realtime record: every refresh
    // publishes one `claim` event on `claims-{sub}`. Three refreshes
    // produce three `claim` events; the trailing `release` makes 4
    // total events on the claims channel.
    const claimChannelEvents = realtime.events.filter(
      (e) => e.channel === `claims-${sub}`,
    );
    expect(claimChannelEvents).toHaveLength(4);
    expect(
      claimChannelEvents
        .slice(0, 3)
        .every((e) => (e.msg as { type: string }).type === "claim"),
    ).toBe(true);

    // Per-step refresh side-effects: exactly 3 STRING `set` calls + 3
    // `zAdd` to the claims index + 1 `del` (final release). The feed's
    // `zAdd` accounts for the +1 difference.
    expect(redis._writes.set).toBe(3);
    // 3 refresh zAdd + 1 feed zAdd = 4
    expect(redis._writes.zAdd).toBe(4);
    expect(redis._writes.del).toBe(1);
    expect(redis._writes.zRem).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PBT — forall valid combo (1..5 steps, all succeed): result has all
// steps in ranSteps, exactly 1 feed append, 1 action publish, 1 release
// ---------------------------------------------------------------------------

const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t1_${s}` as const),
  fc.stringMatching(/^[a-z0-9]{4,10}$/).map((s): ThingId => `t3_${s}` as const),
);
const stepArb: fc.Arbitrary<ComboStep> = fc.oneof(
  fc.constant({ kind: "REMOVE" } as const),
  fc.constant({ kind: "LOCK" } as const),
  fc.constant({ kind: "APPROVE" } as const),
  fc
    .record({
      days: fc.integer({ min: 0, max: 999 }),
      reason: fc.string({ minLength: 0, maxLength: 50 }),
    })
    .map(
      (r): ComboStep => ({ kind: "BAN", days: r.days, reason: r.reason }),
    ),
  fc
    .record({
      text: fc.string({ minLength: 0, maxLength: 100 }),
    })
    .map((r): ComboStep => ({ kind: "MODNOTE", text: r.text })),
);
const comboArb: fc.Arbitrary<ComboSpec> = fc
  .record({
    name: fc.stringMatching(/^[A-Za-z0-9_\- ]{1,40}$/),
    steps: fc.array(stepArb, { minLength: 1, maxLength: 5 }),
  })
  .map((c): ComboSpec => ({ name: c.name, steps: c.steps }));

describe("Property: all-success combo runs append+publish+release exactly once", () => {
  test("forall (sub, thingId, mod, valid combo): clean run produces correct artifacts", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        thingIdArb,
        modArb,
        comboArb,
        async (sub, thingId, mod, combo) => {
          const { deps, redis, realtime, reddit } = makeDeps({
            idGen: () => "01HXZ0000000000000000099",
          });

          const entry = await runCombo(thingId, combo, mod, sub, deps);

          // ranSteps holds every step in order.
          expect(entry.ranSteps).toEqual(combo.steps);
          expect(entry.failedStepIndex).toBeUndefined();
          expect(entry.failureMessage).toBeUndefined();
          expect(entry.moderator).toBe(mod);
          expect(entry.thingId).toBe(thingId);
          expect(entry.comboName).toBe(combo.name);

          // Reddit: exactly combo.steps.length calls.
          expect(reddit.calls).toHaveLength(combo.steps.length);

          // Feed: exactly 1 append.
          const feedMembers = await redis.zRange(actionsKey(sub), 0, -1);
          expect(feedMembers).toHaveLength(1);
          expect(JSON.parse(feedMembers[0]!.member)).toEqual(entry);

          // Realtime: exactly 1 `action` event on actions-{sub}.
          const actionEvents = realtime.events.filter(
            (e) => e.channel === `actions-${sub}`,
          );
          expect(actionEvents).toHaveLength(1);
          expect(actionEvents[0]!.msg).toEqual({ type: "action", entry });

          // Realtime: exactly N `claim` (refresh) + 1 `release` on claims-{sub}.
          const claimEvents = realtime.events.filter(
            (e) => e.channel === `claims-${sub}`,
          );
          expect(claimEvents).toHaveLength(combo.steps.length + 1);
          const last = claimEvents[claimEvents.length - 1]!;
          expect((last.msg as { type: string }).type).toBe("release");
          expect((last.msg as { reason: string }).reason).toBe("completed");

          // Exactly one release-side `del` + `zRem`.
          expect(redis._writes.del).toBe(1);
          expect(redis._writes.zRem).toBe(1);

          // Claim is gone.
          expect(await redis.get(claimKey(sub, thingId))).toBeUndefined();
          expect(
            await redis.zScore(claimsIndexKey(sub), thingId),
          ).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
