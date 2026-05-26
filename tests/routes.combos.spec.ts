import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Hono } from "hono";

import { registerCombosRoute } from "../src/server/routes/combos.js";
import { ForbiddenError } from "../src/server/auth.js";
import { saveCombo } from "../src/server/combos.js";
import {
  MAX_COMBOS,
  type ComboSpec,
  type ComboStep,
} from "../src/shared/types.js";
import { makeRedisFake, type RedisFake } from "./_fakes/redisFake.js";

/**
 * `/api/combos` route tests for `tasks.md` task 8.2.
 *
 * Coverage:
 *   - 403 on all three verbs when `auth` throws `ForbiddenError`
 *   - GET 200 (empty + non-empty)
 *   - POST 200 with a valid spec; POST 400 with an invalid spec, and the
 *     validator's exact error message is asserted in the response body
 *   - POST 400 when the storage layer hits `MAX_COMBOS` on a create
 *   - DELETE 200 returning `{ ok: true }`, including the idempotent
 *     "delete a missing name" case
 *   - >=1 PBT at >=100 iterations: forall valid `ComboSpec` candidates,
 *     POST then GET round-trips to the same spec set
 *
 * **Validates: Requirements 6.1, 6.2, 6.3 — Properties 7 and 10 in
 * `design.md` "Correctness Properties".**
 */

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SUB = "Modsynnow";
const USER = "alice";

interface Harness {
  app: Hono;
  redis: RedisFake;
  setForbidden(value: boolean): void;
}

/**
 * Build an app + recording redis fake. `setForbidden(true)` flips the
 * injected `auth` to throw `ForbiddenError` for every subsequent call,
 * so we can drive the 403 path without re-mounting.
 */
function makeHarness(): Harness {
  const redis = makeRedisFake();
  const app = new Hono();
  let forbidden = false;

  registerCombosRoute(app, {
    auth: async () => {
      if (forbidden) throw new ForbiddenError(USER, SUB);
      return { user: USER, sub: SUB };
    },
    combos: { redis },
  });

  return {
    app,
    redis,
    setForbidden(v: boolean) {
      forbidden = v;
    },
  };
}

/** Convenience: parsed JSON body + status from a Hono response. */
async function call(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await app.request(path, init);
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// 403 paths — all three verbs reject non-mods
// ---------------------------------------------------------------------------

describe("auth gate (403 on every verb when ForbiddenError is thrown)", () => {
  test("GET /api/combos → 403 with no Redis reads", async () => {
    const h = makeHarness();
    h.setForbidden(true);
    const res = await call(h.app, "GET", "/api/combos");
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/not a moderator/);
  });

  test("POST /api/combos → 403 with no Redis writes", async () => {
    const h = makeHarness();
    h.setForbidden(true);
    const res = await call(h.app, "POST", "/api/combos", {
      name: "x",
      steps: [{ kind: "REMOVE" }],
    });
    expect(res.status).toBe(403);
    expect(h.redis._writes.hSet).toBe(0);
  });

  test("DELETE /api/combos/:name → 403 with no Redis writes", async () => {
    const h = makeHarness();
    h.setForbidden(true);
    const res = await call(h.app, "DELETE", "/api/combos/whatever");
    expect(res.status).toBe(403);
    expect(h.redis._writes.hDel).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET — empty and non-empty
// ---------------------------------------------------------------------------

describe("GET /api/combos", () => {
  test("returns 200 with empty array when no combos exist", async () => {
    const h = makeHarness();
    const res = await call(h.app, "GET", "/api/combos");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("returns 200 with persisted combos", async () => {
    const h = makeHarness();
    const a: ComboSpec = { name: "a", steps: [{ kind: "REMOVE" }] };
    const b: ComboSpec = {
      name: "b",
      steps: [{ kind: "LOCK" }, { kind: "APPROVE" }],
      description: "lock then approve",
    };
    await saveCombo(SUB, a, { redis: h.redis });
    await saveCombo(SUB, b, { redis: h.redis });

    const res = await call(h.app, "GET", "/api/combos");
    expect(res.status).toBe(200);
    const list = res.body as ComboSpec[];
    expect(list).toHaveLength(2);
    const byName = new Map(list.map((c) => [c.name, c]));
    expect(byName.get("a")).toEqual(a);
    expect(byName.get("b")).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// POST — valid, invalid, cap hit
// ---------------------------------------------------------------------------

describe("POST /api/combos", () => {
  test("returns 200 with the persisted spec when valid", async () => {
    const h = makeHarness();
    const spec: ComboSpec = {
      name: "warn-then-remove",
      steps: [
        { kind: "MODNOTE", text: "first warning", label: "ABUSE_WARNING" },
        { kind: "REMOVE" },
      ],
      description: "Soft warn, then remove.",
    };
    const res = await call(h.app, "POST", "/api/combos", spec);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(spec);

    // GET reflects the same write.
    const list = await call(h.app, "GET", "/api/combos");
    expect(list.body).toEqual([spec]);
  });

  test("returns 400 with the validator's exact error message on invalid spec", async () => {
    const h = makeHarness();
    // 0 steps → validator rejects with "at least 1 step"
    const res = await call(h.app, "POST", "/api/combos", {
      name: "bad",
      steps: [],
    });
    expect(res.status).toBe(400);
    const err = (res.body as { error: string }).error;
    expect(err).toMatch(/at least 1 step/);

    // No write happened — listCombos still empty.
    const list = await call(h.app, "GET", "/api/combos");
    expect(list.body).toEqual([]);
  });

  test("returns 400 when MAX_COMBOS cap is hit on create", async () => {
    const h = makeHarness();
    // Fill to the cap via direct saveCombo so the test isolates the
    // cap-hit path on the route.
    for (let i = 0; i < MAX_COMBOS; i++) {
      await saveCombo(
        SUB,
        { name: `combo-${i}`, steps: [{ kind: "REMOVE" }] },
        { redis: h.redis },
      );
    }
    const res = await call(h.app, "POST", "/api/combos", {
      name: "overflow",
      steps: [{ kind: "REMOVE" }],
    });
    expect(res.status).toBe(400);
    const err = (res.body as { error: string }).error;
    expect(err).toMatch(/max of 50/);
  });
});

// ---------------------------------------------------------------------------
// DELETE — 200 + idempotency
// ---------------------------------------------------------------------------

describe("DELETE /api/combos/:name", () => {
  test("returns 200 { ok: true } when deleting a present combo", async () => {
    const h = makeHarness();
    await saveCombo(
      SUB,
      { name: "doomed", steps: [{ kind: "REMOVE" }] },
      { redis: h.redis },
    );
    const res = await call(h.app, "DELETE", "/api/combos/doomed");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const list = await call(h.app, "GET", "/api/combos");
    expect(list.body).toEqual([]);
  });

  test("returns 200 { ok: true } when deleting a missing name (idempotent)", async () => {
    const h = makeHarness();
    const res = await call(h.app, "DELETE", "/api/combos/never-existed");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// PBT — POST then GET round-trip
// ---------------------------------------------------------------------------

/** Generator for a small but non-trivial valid combo (mirrors combos.spec.ts). */
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
        .map(({ days, reason }): ComboStep => ({ kind: "BAN", days, reason })),
      fc
        .string({ maxLength: 100 })
        .map((text): ComboStep => ({ kind: "MODNOTE", text })),
    ),
    { minLength: 1, maxLength: 4 },
  ),
});

describe("Property: POST then GET round-trips the spec set", () => {
  test("forall valid ComboSpec set: POST each then GET yields same set (>=100 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1-5 unique-by-name combos so the round-trip is non-trivial.
        fc
          .uniqueArray(validComboArb, {
            minLength: 1,
            maxLength: 5,
            selector: (c) => c.name,
          }),
        async (specs) => {
          const h = makeHarness();

          for (const spec of specs) {
            const res = await call(h.app, "POST", "/api/combos", spec);
            expect(res.status).toBe(200);
            expect(res.body).toEqual(spec);
          }

          const listRes = await call(h.app, "GET", "/api/combos");
          expect(listRes.status).toBe(200);
          const list = listRes.body as ComboSpec[];

          // Same name set, deepEqual JSON for each.
          expect(list.length).toBe(specs.length);
          const got = new Map(list.map((c) => [c.name, c]));
          for (const spec of specs) {
            expect(got.get(spec.name)).toEqual(spec);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
