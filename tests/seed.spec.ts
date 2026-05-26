import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  seedDemo,
  type SeedDeps,
  type SeedReddit,
  type SeedSubmitOpts,
} from "../src/server/seed.js";

/**
 * Demo seed endpoint tests for `tasks.md` task 10.1. One PBT at >=100
 * iterations covers the "submitPost calls <= count AND never crashes"
 * acceptance signal. Five example tests lock the gate, ordering, title
 * format, runAs, and partial-failure semantics.
 *
 * **Validates: Requirements 10.x — Property 10 (auth-style gate on
 * `seedEnabled`) per `.kiro/specs/modsync/design.md`.**
 */

interface RecordedCall {
  method: "submitPost" | "report";
  args: unknown;
}

interface RedditFakeOptions {
  failSubmitAt?: number;
  failReportAt?: number;
}

function makeRedditFake(
  opts: RedditFakeOptions = {},
): SeedReddit & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let submitCount = 0;
  let reportCount = 0;
  return {
    calls,
    async submitPost(args: SeedSubmitOpts) {
      const idx = submitCount++;
      calls.push({ method: "submitPost", args });
      if (opts.failSubmitAt !== undefined && idx === opts.failSubmitAt) {
        throw new Error("rate limited");
      }
      return { id: `t3_demo${idx}` };
    },
    async report(thingId, options) {
      const idx = reportCount++;
      calls.push({ method: "report", args: { thingId, options } });
      if (opts.failReportAt !== undefined && idx === opts.failReportAt) {
        throw new Error("report failed");
      }
    },
  };
}

function makeDeps(
  reddit: SeedReddit,
  enabled: boolean,
  delayMs = 0,
): SeedDeps {
  return {
    reddit,
    getSeedEnabled: async () => enabled,
    delayMs,
  };
}

describe("seedDemo", () => {
  test("returns { created: 0 } when getSeedEnabled is false", async () => {
    const reddit = makeRedditFake();
    const result = await seedDemo(12, makeDeps(reddit, false));
    expect(result).toEqual({ created: 0 });
    expect(reddit.calls).toHaveLength(0);
    const submits = reddit.calls.filter((c) => c.method === "submitPost");
    const reports = reddit.calls.filter((c) => c.method === "report");
    expect(submits).toHaveLength(0);
    expect(reports).toHaveLength(0);
  });

  test("count=12 produces 12 submitPost + 12 report calls in order", async () => {
    const reddit = makeRedditFake();
    const result = await seedDemo(12, makeDeps(reddit, true));
    expect(result).toEqual({ created: 12 });
    expect(reddit.calls).toHaveLength(24);
    // Order: submitPost, report, submitPost, report, ...
    for (let i = 0; i < 12; i++) {
      expect(reddit.calls[2 * i]?.method).toBe("submitPost");
      expect(reddit.calls[2 * i + 1]?.method).toBe("report");
    }
    const submits = reddit.calls.filter((c) => c.method === "submitPost");
    const reports = reddit.calls.filter((c) => c.method === "report");
    expect(submits).toHaveLength(12);
    expect(reports).toHaveLength(12);
  });

  test("every post title is [ModSync demo {i}] for i in [0, count)", async () => {
    const reddit = makeRedditFake();
    await seedDemo(5, makeDeps(reddit, true));
    const titles = reddit.calls
      .filter((c) => c.method === "submitPost")
      .map((c) => (c.args as SeedSubmitOpts).title);
    expect(titles).toEqual([
      "[ModSync demo 0]",
      "[ModSync demo 1]",
      "[ModSync demo 2]",
      "[ModSync demo 3]",
      "[ModSync demo 4]",
    ]);
  });

  test("runAs: 'APP' is set on every submitPost call", async () => {
    const reddit = makeRedditFake();
    await seedDemo(7, makeDeps(reddit, true));
    const submits = reddit.calls.filter((c) => c.method === "submitPost");
    expect(submits).toHaveLength(7);
    for (const call of submits) {
      expect((call.args as SeedSubmitOpts).runAs).toBe("APP");
    }
  });

  test("submitPost failure mid-way stops loop and returns partial { created }", async () => {
    // Fail at index 3 (the 4th submit). 3 successful submits before that.
    const reddit = makeRedditFake({ failSubmitAt: 3 });
    const result = await seedDemo(10, makeDeps(reddit, true));
    expect(result).toEqual({ created: 3 });
    // submitPost called 4 times total (indices 0..3, last threw)
    const submits = reddit.calls.filter((c) => c.method === "submitPost");
    expect(submits).toHaveLength(4);
    // report called only after each successful submit (3 times)
    const reports = reddit.calls.filter((c) => c.method === "report");
    expect(reports).toHaveLength(3);
  });

  test("PBT (>=100 iter): submitPost calls <= count AND seedDemo never crashes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        async (count, enabled) => {
          const reddit = makeRedditFake();
          const result = await seedDemo(count, makeDeps(reddit, enabled));
          const submits = reddit.calls.filter((c) => c.method === "submitPost");
          // submitPost calls bounded by count
          expect(submits.length).toBeLessThanOrEqual(count);
          // result is well-formed
          expect(typeof result.created).toBe("number");
          expect(result.created).toBeGreaterThanOrEqual(0);
          expect(result.created).toBeLessThanOrEqual(count);
          // when disabled, zero work
          if (!enabled) {
            expect(submits).toHaveLength(0);
            expect(result.created).toBe(0);
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
