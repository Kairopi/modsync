import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";

import {
  actionsChannel,
  claimsChannel,
  publishAction,
  publishClaim,
  type RealtimeLike,
} from "../src/server/realtime.js";
import type { ActionEntry, RealtimeEvent, ThingId } from "../src/shared/types.js";

/**
 * Realtime publish-layer tests for `tasks.md` task 4.3.
 *
 * Two property tests at >=100 fast-check iterations each (one per
 * publish wrapper) plus example tests that lock the channel-name
 * builders and the error-swallow semantics.
 *
 * **Validates: Requirements 2.4, 3.4, 8.1 — Properties 2 and 6 from
 * `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Recording realtime fake. Captures every `(channel, msg)` pair so the
 * property tests can assert exactly-once publish semantics + payload
 * deep-equality.
 */
interface RealtimeRecorder extends RealtimeLike {
  readonly events: { channel: string; msg: unknown }[];
}
function makeRealtimeFake(): RealtimeRecorder {
  const events: { channel: string; msg: unknown }[] = [];
  return {
    events,
    async send(channel, msg) {
      events.push({ channel, msg });
    },
  };
}

// Subreddit name regex (Reddit's actual rule: 3-21 alphanumerics + `_`).
const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);

// Reddit usernames: 3-20 chars from [A-Za-z0-9_-].
const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);

// ThingId base36-ish suffix.
const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
  fc
    .stringMatching(/^[a-z0-9]{4,10}$/)
    .map((s): ThingId => `t1_${s}` as const),
  fc
    .stringMatching(/^[a-z0-9]{4,10}$/)
    .map((s): ThingId => `t3_${s}` as const),
);

// Generators for each variant of the discriminated `RealtimeEvent`.
const claimEventArb: fc.Arbitrary<RealtimeEvent> = fc.record({
  type: fc.constant("claim" as const),
  thingId: thingIdArb,
  moderator: modArb,
  claimedAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  ttlSec: fc.integer({ min: 1, max: 90 }),
});

const releaseEventArb: fc.Arbitrary<RealtimeEvent> = fc.record({
  type: fc.constant("release" as const),
  thingId: thingIdArb,
  moderator: modArb,
  reason: fc.constantFrom(
    "completed" as const,
    "expired" as const,
    "manual" as const,
  ),
});

// Minimal but spec-correct ActionEntry generator (combo steps trimmed
// to a small set of well-formed shapes).
const stepArb = fc.oneof(
  fc.record({ kind: fc.constant("REMOVE" as const) }),
  fc.record({ kind: fc.constant("LOCK" as const) }),
  fc.record({ kind: fc.constant("APPROVE" as const) }),
  fc.record({
    kind: fc.constant("BAN" as const),
    days: fc.integer({ min: 0, max: 999 }),
    reason: fc.string({ minLength: 0, maxLength: 50 }),
  }),
  fc.record({
    kind: fc.constant("MODNOTE" as const),
    text: fc.string({ minLength: 0, maxLength: 100 }),
  }),
);

const actionEntryArb: fc.Arbitrary<ActionEntry> = fc.record({
  id: fc.uuid(),
  ts: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  moderator: modArb,
  thingId: thingIdArb,
  comboName: fc.oneof(
    fc.constant("Claim" as const),
    fc.string({ minLength: 1, maxLength: 40 }),
  ),
  ranSteps: fc.array(stepArb, { minLength: 0, maxLength: 5 }),
});

const actionEventArb: fc.Arbitrary<RealtimeEvent> = actionEntryArb.map(
  (entry): RealtimeEvent => ({ type: "action", entry }),
);

// All three variants for `publishClaim` / `publishAction` properties.
const realtimeEventArb: fc.Arbitrary<RealtimeEvent> = fc.oneof(
  claimEventArb,
  releaseEventArb,
  actionEventArb,
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("publishClaim (Property 2 / 6: exactly-once publish on claims-{sub})", () => {
  test("sends exactly one event to claims-{sub} with deep-equal payload", () => {
    fc.assert(
      fc.asyncProperty(subArb, realtimeEventArb, async (sub, event) => {
        const fake = makeRealtimeFake();

        await publishClaim(fake, sub, event);

        expect(fake.events).toHaveLength(1);
        expect(fake.events[0]?.channel).toBe(`claims-${sub}`);
        expect(fake.events[0]?.msg).toEqual(event);
      }),
      { numRuns: 100 },
    );
  });
});

describe("publishAction (Property 2 / 6: exactly-once publish on actions-{sub})", () => {
  test("sends exactly one event to actions-{sub} with deep-equal payload", () => {
    fc.assert(
      fc.asyncProperty(subArb, realtimeEventArb, async (sub, event) => {
        const fake = makeRealtimeFake();

        await publishAction(fake, sub, event);

        expect(fake.events).toHaveLength(1);
        expect(fake.events[0]?.channel).toBe(`actions-${sub}`);
        expect(fake.events[0]?.msg).toEqual(event);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example tests
// ---------------------------------------------------------------------------

describe("channel-name helpers", () => {
  test("claimsChannel(sub) and actionsChannel(sub) match the locked layout", () => {
    expect(claimsChannel("Modsynnow")).toBe("claims-Modsynnow");
    expect(actionsChannel("Modsynnow")).toBe("actions-Modsynnow");
  });
});

describe("error swallowing (best-effort publish)", () => {
  test("publishClaim does not propagate when realtime.send throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing: RealtimeLike = {
        async send() {
          throw new Error("realtime offline");
        },
      };

      // Must resolve, never reject.
      await expect(
        publishClaim(throwing, "Modsynnow", {
          type: "claim",
          thingId: "t3_abc123",
          moderator: "alice",
          claimedAt: 1_700_000_000_000,
          ttlSec: 90,
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("publishAction does not propagate when realtime.send throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing: RealtimeLike = {
        async send() {
          throw new Error("realtime offline");
        },
      };

      const event: RealtimeEvent = {
        type: "action",
        entry: {
          id: "01HXZ0000000000000000000",
          ts: 1_700_000_000_000,
          moderator: "alice",
          thingId: "t3_abc123",
          comboName: "Claim",
          ranSteps: [],
        },
      };

      await expect(
        publishAction(throwing, "Modsynnow", event),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
