import { describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";

import {
  onComboPickerMenu,
  type ComboPickerDeps,
  type CombosService,
  type AuthFn,
} from "../src/server/menu/comboPickerHandler.js";
import {
  listCombos as realListCombos,
  saveCombo as realSaveCombo,
  type CombosDeps,
} from "../src/server/combos.js";
import { ForbiddenError } from "../src/server/auth.js";
import type { ComboSpec, ComboStep } from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";
import type { MenuItemRequest, UiResponse } from "@devvit/web/shared";

/**
 * Tests for `tasks.md` task 8.3a — `/internal/menu/combo-picker` handler.
 *
 * Coverage:
 *   - 403 path: ForbiddenError → 'Forbidden' toast, zero side effects.
 *   - Subreddit location: out-of-contract toast, zero side effects.
 *   - Empty combos: 'No combos defined yet' toast, no form shown.
 *   - Non-empty combos: showForm with one select field, options match
 *     combo names verbatim.
 *   - Invalid prefix: 'Invalid target' toast.
 *   - **Property 7 (combo list freshness)** at ≥100 iter — forall
 *     (sub, combos[1..50]). After handler:
 *     `response.showForm.form.fields[0].options.length === combos.length`
 *     AND every option.value matches a combo name in the input set.
 *
 * **Validates: Property 7 (freshness), Property 10 (mod gate has no
 * side effects on throw).**
 */

// ---------------------------------------------------------------------------
// Fixture: build a handler harness with the real combos module running
// against an in-memory Redis fake. Tests then drive the handler and
// assert against the fake's state directly.
// ---------------------------------------------------------------------------

interface Harness {
  deps: ComboPickerDeps;
  redis: RedisFake;
  authFn: ReturnType<typeof vi.fn<AuthFn>>;
  combosDeps: CombosDeps;
}

function makeHarness(opts: { authImpl: AuthFn; sub: string }): Harness {
  const redis = makeRedisFake();
  const combosDeps: CombosDeps = { redis };

  const combosService: CombosService = {
    listCombos: (sub) => realListCombos(sub, combosDeps),
  };

  const authFn = vi.fn<AuthFn>(opts.authImpl);

  const deps: ComboPickerDeps = {
    auth: authFn,
    getSub: () => opts.sub,
    combos: combosService,
  };

  return { deps, redis, authFn, combosDeps };
}

const SUB = "Modsynnow";

// ---------------------------------------------------------------------------
// 403 path — auth throws → 'Forbidden' toast, zero side effects.
// ---------------------------------------------------------------------------

describe("403 path: ForbiddenError → 'Forbidden' toast with zero side effects", () => {
  test("returns Forbidden toast and never reads or writes Redis on the throw path", async () => {
    const { deps, redis, authFn, combosDeps } = makeHarness({
      authImpl: async ({ sub }) => {
        throw new ForbiddenError("intruder", sub);
      },
      sub: SUB,
    });

    // Pre-seed a combo so we can verify the handler did not read it.
    await realSaveCombo(
      SUB,
      { name: "preseed", steps: [{ kind: "REMOVE" }] },
      combosDeps,
    );
    const seedHSetCount = redis._writes.hSet;

    // Spy on every read method to confirm zero reads on the auth-throw path.
    const hGetAllSpy = vi.spyOn(redis, "hGetAll");
    const hKeysSpy = vi.spyOn(redis, "hKeys");
    const hGetSpy = vi.spyOn(redis, "hGet");
    const getSpy = vi.spyOn(redis, "get");
    const existsSpy = vi.spyOn(redis, "exists");

    const body: MenuItemRequest = { location: "post", targetId: "t3_abc123" };
    const res = (await onComboPickerMenu(body, deps)) as UiResponse;

    expect(res).toEqual({ showToast: "Forbidden" });
    expect(authFn).toHaveBeenCalledTimes(1);

    // Zero reads after the auth throw.
    expect(hGetAllSpy).not.toHaveBeenCalled();
    expect(hKeysSpy).not.toHaveBeenCalled();
    expect(hGetSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();

    // No new writes (the seed setup wrote once; nothing more).
    expect(redis._writes.hSet).toBe(seedHSetCount);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subreddit location / invalid prefix — out-of-contract toasts.
// ---------------------------------------------------------------------------

describe("Out-of-contract target handling", () => {
  test("subreddit location → 'Combos don't apply to subreddits' toast + zero combo reads", async () => {
    const { deps, redis, combosDeps } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });

    // Pre-seed combos so we can verify the handler short-circuits
    // BEFORE reading them.
    await realSaveCombo(
      SUB,
      { name: "preseed", steps: [{ kind: "REMOVE" }] },
      combosDeps,
    );
    const seedHSetCount = redis._writes.hSet;
    const hGetAllSpy = vi.spyOn(redis, "hGetAll");

    const res = (await onComboPickerMenu(
      { location: "subreddit", targetId: "t5_modsynnow" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Combos don't apply to subreddits" });
    expect(res.showForm).toBeUndefined();
    // Handler returned before reading combos.
    expect(hGetAllSpy).not.toHaveBeenCalled();
    // No new writes either.
    expect(redis._writes.hSet).toBe(seedHSetCount);
    expect(redis._writes.hIncrBy).toBe(0);
  });

  test("post location with t1_ prefix → 'Invalid target' toast + zero combo reads", async () => {
    const { deps, redis } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });
    const hGetAllSpy = vi.spyOn(redis, "hGetAll");

    const res = (await onComboPickerMenu(
      { location: "post", targetId: "t1_oops" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });
    expect(res.showForm).toBeUndefined();
    expect(hGetAllSpy).not.toHaveBeenCalled();
  });

  test("comment location with t3_ prefix → 'Invalid target' toast + zero combo reads", async () => {
    const { deps, redis } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });
    const hGetAllSpy = vi.spyOn(redis, "hGetAll");

    const res = (await onComboPickerMenu(
      { location: "comment", targetId: "t3_oops" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "Invalid target" });
    expect(res.showForm).toBeUndefined();
    expect(hGetAllSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty combo list — informational toast, no form shown.
// ---------------------------------------------------------------------------

describe("Empty combos: 'No combos defined yet' toast", () => {
  test("post target with no combos seeded → toast, no form, zero writes", async () => {
    const { deps, redis } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });

    const res = (await onComboPickerMenu(
      { location: "post", targetId: "t3_abc123" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "No combos defined yet" });
    expect(res.showForm).toBeUndefined();
    // Picker is informational — never writes.
    expect(redis._writes.hSet).toBe(0);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
  });

  test("comment target with no combos seeded → same toast", async () => {
    const { deps } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });

    const res = (await onComboPickerMenu(
      { location: "comment", targetId: "t1_abc123" },
      deps,
    )) as UiResponse;

    expect(res).toEqual({ showToast: "No combos defined yet" });
  });
});

// ---------------------------------------------------------------------------
// Non-empty combos — showForm with select field, options match names.
// ---------------------------------------------------------------------------

describe("Non-empty combos: showForm with comboName select field", () => {
  test("two seeded combos → form with two options matching the combo names", async () => {
    const { deps, redis, combosDeps } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });

    await realSaveCombo(
      SUB,
      { name: "remove-and-lock", steps: [{ kind: "REMOVE" }, { kind: "LOCK" }] },
      combosDeps,
    );
    await realSaveCombo(
      SUB,
      {
        name: "ban-7-days",
        steps: [{ kind: "BAN", days: 7, reason: "spam" }],
      },
      combosDeps,
    );
    // Snapshot any side-channel writes from the seed so we can confirm
    // the handler does not add to them.
    const seedHSet = redis._writes.hSet;

    const res = (await onComboPickerMenu(
      { location: "post", targetId: "t3_abc123" },
      deps,
    )) as UiResponse;

    expect(res.showToast).toBeUndefined();
    expect(res.showForm).toBeDefined();
    expect(res.showForm!.name).toBe("comboPickerForm");
    expect(res.showForm!.form.title).toBe("Run combo");
    expect(res.showForm!.form.acceptLabel).toBe("Run");
    expect(res.showForm!.form.fields).toHaveLength(1);

    const field = res.showForm!.form.fields[0]!;
    expect(field.type).toBe("select");
    expect("name" in field ? field.name : undefined).toBe("comboName");
    expect("label" in field ? field.label : undefined).toBe("Combo");

    if (field.type !== "select") throw new Error("expected select field");
    const optionValues = field.options.map((o) => o.value).sort();
    const optionLabels = field.options.map((o) => o.label).sort();
    expect(optionValues).toEqual(["ban-7-days", "remove-and-lock"]);
    expect(optionLabels).toEqual(["ban-7-days", "remove-and-lock"]);

    // data.thingId carries the action context into 8.3b's submit handler.
    expect(res.showForm!.data).toEqual({ thingId: "t3_abc123" });

    // Picker is read-only: no new writes beyond seed setup.
    expect(redis._writes.hSet).toBe(seedHSet);
    expect(redis._writes.hIncrBy).toBe(0);
    expect(redis._writes.set).toBe(0);
    expect(redis._writes.zAdd).toBe(0);
  });

  test("comment target also returns the same form with the comment thingId in data", async () => {
    const { deps, combosDeps } = makeHarness({
      authImpl: async ({ sub }) => ({ user: "alice", sub }),
      sub: SUB,
    });

    await realSaveCombo(
      SUB,
      { name: "approve-only", steps: [{ kind: "APPROVE" }] },
      combosDeps,
    );

    const res = (await onComboPickerMenu(
      { location: "comment", targetId: "t1_xyz789" },
      deps,
    )) as UiResponse;

    expect(res.showForm).toBeDefined();
    expect(res.showForm!.data).toEqual({ thingId: "t1_xyz789" });
  });
});

// ---------------------------------------------------------------------------
// Property 7 (combo-list freshness).
//
// forall (sub, combos[1..50]):
//   - response.showForm.form.fields[0].options.length === combos.length
//   - every option.value matches a name in the seeded combos
//   - every option.label matches a name in the seeded combos
//   - the picker reads HKEYS-equivalent on every invocation, so a
//     freshly-saved combo will appear immediately.
// ---------------------------------------------------------------------------

describe("Property 7 (combo-list freshness)", () => {
  // Use the case-explicit form (no /i flag) per the note in
  // tests/combos.spec.ts — fast-check 4 rejects /i-flagged regexes.
  const subArb = fc.stringMatching(/^[A-Za-z0-9_]{3,21}$/);
  const nameArb = fc.stringMatching(/^[a-z0-9_\- ]{1,40}$/);

  // Build a small valid `ComboSpec` arbitrary. We stick to REMOVE /
  // LOCK / APPROVE steps because they have no kind-specific fields,
  // which keeps the property focused on the picker (not the validator).
  const stepArb = fc.constantFrom<ComboStep>(
    { kind: "REMOVE" },
    { kind: "LOCK" },
    { kind: "APPROVE" },
  );

  const comboArb: fc.Arbitrary<ComboSpec> = fc.record({
    name: nameArb,
    steps: fc.array(stepArb, { minLength: 1, maxLength: 5 }),
  });

  test("forall (sub, combos[1..50]): form options length equals combo count + every option value/label is in the input set", async () => {
    await fc.assert(
      fc.asyncProperty(
        subArb,
        // Cap at 50 (MAX_COMBOS) and force at least 1 so we hit the
        // showForm branch deterministically.
        fc.uniqueArray(comboArb, {
          minLength: 1,
          maxLength: 50,
          selector: (c) => c.name,
        }),
        async (sub, combos) => {
          const { deps, combosDeps } = makeHarness({
            authImpl: async ({ sub: s }) => ({ user: "alice", sub: s }),
            sub,
          });

          // Seed via the real saveCombo path so the storage layer's
          // contract is exercised end-to-end.
          for (const c of combos) {
            await realSaveCombo(sub, c, combosDeps);
          }

          const res = (await onComboPickerMenu(
            { location: "post", targetId: "t3_abc123" },
            deps,
          )) as UiResponse;

          expect(res.showForm).toBeDefined();
          expect(res.showForm!.name).toBe("comboPickerForm");
          expect(res.showForm!.form.fields).toHaveLength(1);

          const field = res.showForm!.form.fields[0]!;
          if (field.type !== "select") {
            throw new Error("expected select field");
          }

          // Length matches.
          expect(field.options).toHaveLength(combos.length);

          const inputNames = new Set(combos.map((c) => c.name));
          for (const opt of field.options) {
            // Every option's value AND label must be one of the
            // seeded combo names.
            expect(inputNames.has(opt.value)).toBe(true);
            expect(inputNames.has(opt.label)).toBe(true);
            // value === label is the locked invariant.
            expect(opt.value).toBe(opt.label);
          }

          // Set-equality: no missing names, no extras.
          const optionValues = new Set(field.options.map((o) => o.value));
          expect(optionValues.size).toBe(inputNames.size);
          for (const n of inputNames) {
            expect(optionValues.has(n)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
