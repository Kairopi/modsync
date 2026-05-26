import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  actionsKey,
  claimKey,
  claimsIndexKey,
  combosKey,
  deletedModsKey,
  isoWeekKey,
  metricsKey,
  modsExpiryKey,
  modsKey,
} from "../src/server/redisKeys";

/**
 * Tests for `src/server/redisKeys.ts`.
 *
 * Source: `.kiro/specs/modsync/tasks.md` task 2.2.
 *
 * **Validates: Property 9 (week-key correctness)**
 *
 * Two layers of coverage:
 *   1. The 5 ISO 8601 boundary examples named in tasks.md task 2.2.
 *   2. A ≥200-iteration fast-check property that asserts `isoWeekKey`
 *      output always matches the ISO week regex for any UTC date in the
 *      year range 2000-01-01..2100-12-31.
 *
 * Plus a narrow round-trip example for the key builders to lock in the
 * exact `{...}` substitution shape; we don't need property tests for
 * the key builders themselves — they're pure string templates and the
 * only failure mode is a typo in a separator, which an example test
 * catches just as well.
 */

describe("isoWeekKey — ISO 8601 boundary cases (tasks.md task 2.2)", () => {
  // Each tuple is [UTC date string, expected key]. The 5 cases are the
  // exact set listed in tasks.md task 2.2; do not add or remove without
  // updating the spec.
  const boundaryCases: ReadonlyArray<readonly [string, string]> = [
    ["2004-01-01T00:00:00Z", "2004-W01"],
    ["2005-01-01T00:00:00Z", "2004-W53"],
    ["2007-12-31T00:00:00Z", "2008-W01"],
    ["2020-01-01T00:00:00Z", "2020-W01"],
    ["2021-01-01T00:00:00Z", "2020-W53"],
  ];

  for (const [iso, expected] of boundaryCases) {
    test(`${iso} -> ${expected}`, () => {
      expect(isoWeekKey(new Date(iso))).toBe(expected);
    });
  }
});

describe("isoWeekKey — fast-check property over 2000..2100", () => {
  // 2000-01-01..2100-12-31 inclusive in UTC ms.
  const MIN_MS = Date.UTC(2000, 0, 1);
  const MAX_MS = Date.UTC(2100, 11, 31);
  // ISO 8601: a year has either 52 or 53 weeks. The regex accepts any
  // two-digit week number from 01..53.
  const isoWeekRegex = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

  test("forall date in 2000..2100. isoWeekKey(date) matches /^\\d{4}-W(0[1-9]|[1-4]\\d|5[0-3])$/", () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_MS, max: MAX_MS }), (ms) => {
        const key = isoWeekKey(new Date(ms));
        return isoWeekRegex.test(key);
      }),
      { numRuns: 200 },
    );
  });
});

describe("redis key builders — representative inputs", () => {
  test("produce the spec-locked key strings", () => {
    expect(claimKey("Modsynnow", "t3_abc123")).toBe(
      "claims:Modsynnow:t3_abc123",
    );
    expect(claimKey("Modsynnow", "t1_xyz789")).toBe(
      "claims:Modsynnow:t1_xyz789",
    );
    expect(claimsIndexKey("Modsynnow")).toBe("claims-index:Modsynnow");
    expect(actionsKey("Modsynnow")).toBe("actions:Modsynnow");
    expect(combosKey("Modsynnow")).toBe("combos:Modsynnow");
    expect(metricsKey("Modsynnow", "2025-W42")).toBe(
      "metrics:Modsynnow:2025-W42",
    );
    expect(modsKey("Modsynnow")).toBe("mods:Modsynnow");
    expect(modsExpiryKey("Modsynnow")).toBe("mods-expiry:Modsynnow");
    expect(deletedModsKey("Modsynnow")).toBe("deleted-mods:Modsynnow");
  });

  test("metricsKey embeds the output of isoWeekKey verbatim", () => {
    // Cross-module consistency check: if isoWeekKey ever changes its
    // separator from `-W` to anything else, this catches it without
    // relying on the format string in metricsKey alone.
    const isoWeek = isoWeekKey(new Date("2020-01-01T00:00:00Z"));
    expect(metricsKey("test-sub", isoWeek)).toBe("metrics:test-sub:2020-W01");
  });
});
