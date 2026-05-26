import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  deleteCombo,
  listCombos,
  saveCombo,
  validateCombo,
  type CombosDeps,
} from "../src/server/combos.js";
import {
  COMBO_NAME_REGEX,
  MAX_COMBOS,
  type ComboSpec,
  type ComboStep,
} from "../src/shared/types.js";
import { combosKey } from "../src/server/redisKeys.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * Combos-module tests for `tasks.md` task 8.1. Two property tests at
 * >=200 fast-check iterations each, plus a handful of small example
 * tests to lock the validator's error-message routing.
 *
 *   - **Property 7 (validator)**: `forall arbitrary candidate.
 *     validator accepts iff (name unique within `existingNames` AND
 *     steps.length ∈ [1, 10] AND each step well-formed AND every
 *     MODNOTE.text.length ≤ 1000 AND every BAN.days ∈ [0, 999])`. Uses
 *     a generator that biases toward edge cases (empty steps, dup
 *     names, oversize names, 11-step combos, 1001-char MODNOTE.text,
 *     1000-day BAN — slightly above and below each boundary).
 *
 *   - **Property 7 (CRUD round-trip)**: a sequence of `save` / `delete`
 *     operations starting from empty, replayed against a sub via the
 *     real `saveCombo`/`deleteCombo`/`listCombos`, agrees set-wise with
 *     an in-memory model that applies the same operations under the
 *     same validation rules.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3 — see Property 7 in
 * `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDeps(): { deps: CombosDeps; redis: RedisFake } {
  const redis = makeRedisFake();
  return { deps: { redis }, redis };
}

const SUB = "Modsynnow";

/** Reddit subreddit name regex (3-21 [A-Za-z0-9_]); used in CRUD tests. */
const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);

// ---------------------------------------------------------------------------
// Generators biased toward validator edge cases
// ---------------------------------------------------------------------------

/**
 * `name` generator: mixes legal names with hostile ones (empty, 41-char,
 * illegal chars). Each branch is roughly equiprobable so ~25% of runs
 * hit each failure mode.
 */
const candidateNameArb = fc.oneof(
  // Legal names (well within bounds). The validator regex carries `i`,
  // so cover both A-Z and a-z explicitly here (fast-check's
  // `stringMatching` rejects the `/i` flag).
  fc.stringMatching(/^[A-Za-z0-9_\- ]{1,40}$/),
  // Empty string — fails regex.
  fc.constant(""),
  // 41 chars — fails regex (one over the cap).
  fc
    .stringMatching(/^[A-Za-z0-9]{41}$/)
    .filter((s) => s.length === 41),
  // Illegal char (`!` is outside the [a-z0-9-_ ] class).
  fc.stringMatching(/^[A-Za-z]{1,5}!$/),
);

/** `description` generator: half-the-time absent, otherwise legal string. */
const candidateDescriptionArb = fc.oneof(
  fc.constant(undefined),
  fc.string({ maxLength: 200 }),
  // ~10% non-string — exercises the type check.
  fc.constant(123 as unknown as string),
);

/**
 * `step` generator. ~10% of branches produce a malformed step (bad kind,
 * BAN.days out of range, MODNOTE.text too long, MODNOTE.label invalid,
 * missing required field).
 */
const candidateStepArb: fc.Arbitrary<unknown> = fc.oneof(
  // ---- Well-formed steps ----
  fc.constant({ kind: "REMOVE" }),
  fc.constant({ kind: "LOCK" }),
  fc.constant({ kind: "APPROVE" }),
  fc.record({
    kind: fc.constant("BAN"),
    days: fc.integer({ min: 0, max: 999 }),
    reason: fc.string({ maxLength: 100 }),
  }),
  fc.record({
    kind: fc.constant("MODNOTE"),
    text: fc.string({ maxLength: 1000 }),
  }),
  fc.record({
    kind: fc.constant("MODNOTE"),
    text: fc.string({ maxLength: 1000 }),
    label: fc.constantFrom(
      "ABUSE_WARNING",
      "SPAM_WARNING",
      "HELPFUL_USER",
      "OTHER",
    ),
  }),
  // ---- Edge / hostile cases ----
  // Boundary BAN: -1 day (invalid) and 1000 days (invalid).
  fc.record({
    kind: fc.constant("BAN"),
    days: fc.constantFrom(-1, 1000, 1500),
    reason: fc.string({ maxLength: 50 }),
  }),
  // BAN.days non-integer (e.g. 1.5)
  fc.record({
    kind: fc.constant("BAN"),
    days: fc.constant(1.5),
    reason: fc.string({ maxLength: 50 }),
  }),
  // MODNOTE.text 1001 chars (one over the cap) — invalid.
  fc.record({
    kind: fc.constant("MODNOTE"),
    text: fc
      .stringMatching(/^[a-z]{1001}$/)
      .filter((s) => s.length === 1001),
  }),
  // MODNOTE.label invalid string.
  fc.record({
    kind: fc.constant("MODNOTE"),
    text: fc.string({ maxLength: 50 }),
    label: fc.constantFrom("WAT", "abuse", ""),
  }),
  // Unknown kind.
  fc.record({
    kind: fc.constantFrom("YEET", "DELETE", ""),
  }),
  // Plain object missing kind.
  fc.constant({}),
  // Non-object.
  fc.constantFrom(null, 1, "step"),
);

/**
 * `steps` array generator. `minLength: 0` and `maxLength: 11` ensure we
 * routinely hit the [1, 10] cardinality boundaries on both sides.
 */
const candidateStepsArb = fc.oneof(
  fc.array(candidateStepArb, { minLength: 0, maxLength: 11 }),
  // Force the "11 steps" edge to actually appear regularly. fast-check
  // tends to shrink toward smaller arrays so an explicit boost helps.
  fc.array(candidateStepArb, { minLength: 11, maxLength: 11 }),
);

/** Whole candidate: object with `name`, `steps`, optional `description`. */
const candidateArb = fc.record(
  {
    name: candidateNameArb,
    steps: candidateStepsArb,
    description: candidateDescriptionArb,
  },
  { requiredKeys: ["name", "steps"] },
);

/** `existingNames`: 0-3 fresh legal names, occasionally including the candidate's. */
function existingNamesArb(): fc.Arbitrary<string[]> {
  return fc.array(fc.stringMatching(/^[A-Za-z0-9_\- ]{1,40}$/), {
    minLength: 0,
    maxLength: 3,
  });
}

// ---------------------------------------------------------------------------
// Reference predicate — what the validator should accept
// ---------------------------------------------------------------------------

/**
 * Pure spec-side predicate: returns true iff `validateCombo(spec,
 * existingNames)` should return `{ ok: true }`. Mirrors the validator
 * rules in task 8.1, written as a separate piece of code so the
 * property test is genuinely cross-checking two implementations.
 */
function shouldAccept(spec: unknown, existingNames: string[]): boolean {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return false;
  }
  const obj = spec as Record<string, unknown>;
  const name = obj["name"];
  if (typeof name !== "string") return false;
  if (!COMBO_NAME_REGEX.test(name)) return false;
  if (existingNames.includes(name)) return false;
  const steps = obj["steps"];
  if (!Array.isArray(steps)) return false;
  if (steps.length < 1 || steps.length > 10) return false;
  for (const step of steps) {
    if (!isStepValid(step)) return false;
  }
  const description = obj["description"];
  if (description !== undefined && typeof description !== "string") return false;
  return true;
}

function isStepValid(step: unknown): boolean {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    return false;
  }
  const obj = step as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string") return false;
  switch (kind) {
    case "REMOVE":
    case "LOCK":
    case "APPROVE":
      return true;
    case "BAN": {
      const days = obj["days"];
      if (typeof days !== "number" || !Number.isInteger(days)) return false;
      if (days < 0 || days > 999) return false;
      if (typeof obj["reason"] !== "string") return false;
      return true;
    }
    case "MODNOTE": {
      const text = obj["text"];
      if (typeof text !== "string") return false;
      if (text.length > 1000) return false;
      const label = obj["label"];
      if (label === undefined) return true;
      if (typeof label !== "string") return false;
      return ["ABUSE_WARNING", "SPAM_WARNING", "HELPFUL_USER", "OTHER"].includes(
        label,
      );
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Property 7 (validator)
// ---------------------------------------------------------------------------

describe("Property 7 (validator): accepts iff all rules pass", () => {
  test("forall candidate, existingNames: validator agrees with reference predicate (>=200 runs)", () => {
    fc.assert(
      fc.property(
        candidateArb,
        existingNamesArb(),
        fc.boolean(),
        (candidate, baseExistingNames, includeOwnName) => {
          // Sometimes inject the candidate's own name into existingNames
          // so the "name not unique" branch is exercised.
          const existingNames =
            includeOwnName && typeof candidate.name === "string"
              ? [...baseExistingNames, candidate.name]
              : baseExistingNames;

          const got = validateCombo(candidate, existingNames);
          const expected = shouldAccept(candidate, existingNames);

          expect(got.ok).toBe(expected);
          if (got.ok) {
            // Coerced value retains name + steps shape.
            expect(got.value.name).toBe(candidate.name);
            expect(got.value.steps.length).toBe(
              (candidate.steps as unknown[]).length,
            );
          } else {
            expect(typeof got.message).toBe("string");
            expect(got.message.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Validator example tests — locked rule boundaries
// ---------------------------------------------------------------------------

describe("validator boundary examples", () => {
  test("BAN with days = 0 is accepted; days = -1 and days = 1000 are rejected", () => {
    const base = (days: number): unknown => ({
      name: "ban-test",
      steps: [{ kind: "BAN", days, reason: "test" }],
    });
    expect(validateCombo(base(0), []).ok).toBe(true);
    expect(validateCombo(base(999), []).ok).toBe(true);
    expect(validateCombo(base(-1), []).ok).toBe(false);
    expect(validateCombo(base(1000), []).ok).toBe(false);
    expect(validateCombo(base(1.5), []).ok).toBe(false);
  });

  test("MODNOTE.text at exactly 1000 chars accepted; 1001 rejected", () => {
    const base = (len: number): unknown => ({
      name: "modnote-test",
      steps: [{ kind: "MODNOTE", text: "a".repeat(len) }],
    });
    expect(validateCombo(base(1000), []).ok).toBe(true);
    expect(validateCombo(base(1001), []).ok).toBe(false);
  });

  test("steps.length boundary: 0 rejected, 1 accepted, 10 accepted, 11 rejected", () => {
    const base = (n: number): unknown => ({
      name: "steps-test",
      steps: Array.from({ length: n }, () => ({ kind: "REMOVE" })),
    });
    expect(validateCombo(base(0), []).ok).toBe(false);
    expect(validateCombo(base(1), []).ok).toBe(true);
    expect(validateCombo(base(10), []).ok).toBe(true);
    expect(validateCombo(base(11), []).ok).toBe(false);
  });

  test("name uniqueness check uses existingNames (case-sensitive, exact)", () => {
    const spec: unknown = {
      name: "warn-and-remove",
      steps: [{ kind: "REMOVE" }],
    };
    expect(validateCombo(spec, ["other"]).ok).toBe(true);
    expect(validateCombo(spec, ["warn-and-remove"]).ok).toBe(false);
  });

  test("invalid name rejected: empty, illegal char, 41 chars", () => {
    const make = (name: string): unknown => ({
      name,
      steps: [{ kind: "REMOVE" }],
    });
    expect(validateCombo(make(""), []).ok).toBe(false);
    expect(validateCombo(make("!bad"), []).ok).toBe(false);
    expect(validateCombo(make("a".repeat(41)), []).ok).toBe(false);
    expect(validateCombo(make("a".repeat(40)), []).ok).toBe(true);
  });

  test("MODNOTE.label optional; valid values accepted; invalid rejected", () => {
    const make = (label?: string): unknown => ({
      name: "n",
      steps: [
        label === undefined
          ? { kind: "MODNOTE", text: "ok" }
          : { kind: "MODNOTE", text: "ok", label },
      ],
    });
    expect(validateCombo(make(), []).ok).toBe(true);
    expect(validateCombo(make("ABUSE_WARNING"), []).ok).toBe(true);
    expect(validateCombo(make("OTHER"), []).ok).toBe(true);
    expect(validateCombo(make("nope"), []).ok).toBe(false);
  });

  test("non-object spec rejected", () => {
    expect(validateCombo(null, []).ok).toBe(false);
    expect(validateCombo("string", []).ok).toBe(false);
    expect(validateCombo([], []).ok).toBe(false);
    expect(validateCombo(42, []).ok).toBe(false);
  });

  test("coerced output drops extra fields, retains optional description only when present", () => {
    const noDesc = validateCombo(
      { name: "x", steps: [{ kind: "REMOVE" }], extra: "ignored" },
      [],
    );
    expect(noDesc.ok).toBe(true);
    if (!noDesc.ok) throw new Error("type guard");
    expect("description" in noDesc.value).toBe(false);
    expect("extra" in noDesc.value).toBe(false);

    const withDesc = validateCombo(
      { name: "y", steps: [{ kind: "REMOVE" }], description: "hi" },
      [],
    );
    expect(withDesc.ok).toBe(true);
    if (!withDesc.ok) throw new Error("type guard");
    expect(withDesc.value.description).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// Property 7 (CRUD round-trip)
// ---------------------------------------------------------------------------

describe("Property 7 (CRUD round-trip): listCombos = model after replay", () => {
  /** Generator for a small but non-trivial valid combo. */
  const validComboArb: fc.Arbitrary<ComboSpec> = fc.record({
    name: fc.stringMatching(/^[a-z0-9-_]{1,15}$/),
    steps: fc.array(
      fc.oneof<fc.Arbitrary<ComboStep>>(
        fc.constant({ kind: "REMOVE" } as const),
        fc.constant({ kind: "LOCK" } as const),
        fc.constant({ kind: "APPROVE" } as const),
        fc
          .record({
            days: fc.integer({ min: 0, max: 999 }),
            reason: fc.string({ maxLength: 30 }),
          })
          .map(
            ({ days, reason }): ComboStep => ({ kind: "BAN", days, reason }),
          ),
        fc
          .string({ maxLength: 100 })
          .map((text): ComboStep => ({ kind: "MODNOTE", text })),
      ),
      { minLength: 1, maxLength: 4 },
    ),
  });

  /** Op = save | delete a name. */
  type Op =
    | { kind: "save"; spec: ComboSpec }
    | { kind: "delete"; name: string };

  // A small name pool concentrates ops on a handful of slots so we get
  // realistic create/update/delete mixes.
  const namePoolArb = fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9-_]{1,15}$/), {
      minLength: 1,
      maxLength: 5,
    })
    .filter((arr) => arr.length >= 1);

  const opsFromPoolArb = (pool: string[]): fc.Arbitrary<Op[]> =>
    fc.array(
      fc.oneof(
        validComboArb.chain((spec) =>
          fc
            .integer({ min: 0, max: pool.length - 1 })
            .map<Op>((idx) => ({
              kind: "save",
              spec: { ...spec, name: pool[idx]! },
            })),
        ),
        fc
          .integer({ min: 0, max: pool.length - 1 })
          .map<Op>((idx) => ({ kind: "delete", name: pool[idx]! })),
      ),
      { minLength: 1, maxLength: 15 },
    );

  test("forall sequence of save/delete: listCombos equals replayed model (>=200 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        namePoolArb.chain((pool) =>
          fc.tuple(fc.constant(pool), opsFromPoolArb(pool)),
        ),
        async (sub, [, ops]) => {
          const { deps, redis } = makeDeps();

          // In-memory model: name -> ComboSpec. Apply the same ops with
          // the same validation rules.
          const model = new Map<string, ComboSpec>();

          for (const op of ops) {
            if (op.kind === "save") {
              const existingNames = Array.from(model.keys()).filter(
                (n) => n !== op.spec.name,
              );
              const result = validateCombo(op.spec, existingNames);
              const isCreate = !model.has(op.spec.name);
              const wouldHitCap = isCreate && model.size >= MAX_COMBOS;

              if (!result.ok || wouldHitCap) {
                // Real saveCombo will throw; assert it does and that
                // state did not change.
                await expect(saveCombo(sub, op.spec, deps)).rejects.toThrow();
              } else {
                const saved = await saveCombo(sub, op.spec, deps);
                model.set(saved.name, saved);
              }
            } else {
              await deleteCombo(sub, op.name, deps);
              model.delete(op.name);
            }
          }

          // Compare set-wise: same names, same JSON for each.
          const listed = await listCombos(sub, deps);
          const listedByName = new Map(listed.map((c) => [c.name, c]));

          expect(listedByName.size).toBe(model.size);
          for (const [name, spec] of model.entries()) {
            const got = listedByName.get(name);
            expect(got).toBeDefined();
            expect(got).toEqual(spec);
          }

          // Sanity: combo HASH cardinality matches.
          const stored = await redis.hGetAll(combosKey(sub));
          expect(Object.keys(stored).length).toBe(model.size);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// CRUD smoke tests — locked semantics
// ---------------------------------------------------------------------------

describe("saveCombo / deleteCombo / listCombos behavior", () => {
  test("saveCombo persists JSON and listCombos round-trips", async () => {
    const { deps, redis } = makeDeps();
    const spec: ComboSpec = {
      name: "warn-then-remove",
      steps: [
        { kind: "MODNOTE", text: "first warning", label: "ABUSE_WARNING" },
        { kind: "REMOVE" },
      ],
      description: "Soft warn, then remove.",
    };

    const saved = await saveCombo(SUB, spec, deps);
    expect(saved).toEqual(spec);

    const listed = await listCombos(SUB, deps);
    expect(listed).toEqual([spec]);

    // Underlying storage is a HASH field with JSON value.
    const raw = await redis.hGetAll(combosKey(SUB));
    expect(JSON.parse(raw[spec.name]!)).toEqual(spec);
  });

  test("saveCombo rejects invalid spec via thrown error with validator's message", async () => {
    const { deps } = makeDeps();
    await expect(
      saveCombo(
        SUB,
        // Bad: 0 steps.
        { name: "bad", steps: [] } as unknown as ComboSpec,
        deps,
      ),
    ).rejects.toThrow(/at least 1 step/);
  });

  test("saveCombo update path (same name) is allowed and overwrites", async () => {
    const { deps } = makeDeps();
    const v1: ComboSpec = { name: "n", steps: [{ kind: "REMOVE" }] };
    const v2: ComboSpec = {
      name: "n",
      steps: [{ kind: "LOCK" }, { kind: "REMOVE" }],
    };
    await saveCombo(SUB, v1, deps);
    await saveCombo(SUB, v2, deps);
    const listed = await listCombos(SUB, deps);
    expect(listed).toEqual([v2]);
  });

  test("saveCombo enforces MAX_COMBOS cap on create but allows update at cap", async () => {
    const { deps } = makeDeps();
    // Fill to the cap.
    for (let i = 0; i < MAX_COMBOS; i++) {
      await saveCombo(
        SUB,
        { name: `combo-${i}`, steps: [{ kind: "REMOVE" }] },
        deps,
      );
    }
    // One more create: rejected.
    await expect(
      saveCombo(
        SUB,
        { name: "overflow", steps: [{ kind: "REMOVE" }] },
        deps,
      ),
    ).rejects.toThrow(/max of 50/);
    // Update at the cap: allowed.
    await expect(
      saveCombo(
        SUB,
        { name: "combo-0", steps: [{ kind: "LOCK" }] },
        deps,
      ),
    ).resolves.toEqual({ name: "combo-0", steps: [{ kind: "LOCK" }] });
  });

  test("deleteCombo is idempotent against missing name", async () => {
    const { deps } = makeDeps();
    await expect(deleteCombo(SUB, "never-existed", deps)).resolves.toBeUndefined();
    expect(await listCombos(SUB, deps)).toEqual([]);
  });

  test("listCombos skips corrupt JSON entries silently", async () => {
    const { deps, redis } = makeDeps();
    await saveCombo(
      SUB,
      { name: "ok", steps: [{ kind: "REMOVE" }] },
      deps,
    );
    // Inject a bad value directly.
    await redis.hSet(combosKey(SUB), { broken: "not-json{{{" });

    const listed = await listCombos(SUB, deps);
    expect(listed.length).toBe(1);
    expect(listed[0]!.name).toBe("ok");
  });
});
