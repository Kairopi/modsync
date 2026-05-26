import { describe, expect, test } from "vitest";

import { DEFAULT_COMBOS } from "../src/server/defaultCombos.js";
import { validateCombo } from "../src/server/combos.js";
import { COMBO_NAME_REGEX } from "../src/shared/types.js";

/**
 * Static-shape tests for `tasks.md` task 8.6. The default combo list
 * is canned data, so a property test would be tautological — but each
 * spec must round-trip through `validateCombo` cleanly so the seeder
 * in task 9.3's `onAppInstall` cannot silently drop them.
 *
 * **Validates: Requirement 6.x — supports Property 7 (validator
 * round-trip on canned specs) per `tasks.md` task 8.6.**
 */

describe("DEFAULT_COMBOS — shape and validation contract", () => {
  test("ships at least 2 specs (spec floor)", () => {
    expect(DEFAULT_COMBOS.length).toBeGreaterThanOrEqual(2);
  });

  test("every default combo passes validateCombo against empty existingNames", () => {
    for (const spec of DEFAULT_COMBOS) {
      const result = validateCombo(spec, []);
      // Surface the validator's own message if this fails so the test
      // log points at the offending spec without a separate inspection
      // step.
      if (!result.ok) {
        throw new Error(
          `Default combo "${spec.name}" failed validation: ${result.message}`,
        );
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The validator coerces the spec — the name + step count must
        // round-trip byte-identical.
        expect(result.value.name).toBe(spec.name);
        expect(result.value.steps.length).toBe(spec.steps.length);
      }
    }
  });

  test("default combo names are unique within DEFAULT_COMBOS", () => {
    const names = DEFAULT_COMBOS.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("every default combo name matches COMBO_NAME_REGEX", () => {
    for (const spec of DEFAULT_COMBOS) {
      expect(
        COMBO_NAME_REGEX.test(spec.name),
        `name "${spec.name}" must match COMBO_NAME_REGEX`,
      ).toBe(true);
    }
  });

  test("every default combo has between 1 and 10 steps", () => {
    for (const spec of DEFAULT_COMBOS) {
      expect(spec.steps.length).toBeGreaterThanOrEqual(1);
      expect(spec.steps.length).toBeLessThanOrEqual(10);
    }
  });

  test("every MODNOTE.text length is within [0, 1000]", () => {
    for (const spec of DEFAULT_COMBOS) {
      for (const step of spec.steps) {
        if (step.kind === "MODNOTE") {
          expect(step.text.length).toBeGreaterThanOrEqual(0);
          expect(step.text.length).toBeLessThanOrEqual(1000);
        }
      }
    }
  });

  test("every BAN.days value is within [0, 999]", () => {
    for (const spec of DEFAULT_COMBOS) {
      for (const step of spec.steps) {
        if (step.kind === "BAN") {
          expect(step.days).toBeGreaterThanOrEqual(0);
          expect(step.days).toBeLessThanOrEqual(999);
        }
      }
    }
  });
});
