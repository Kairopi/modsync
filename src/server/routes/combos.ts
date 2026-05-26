/**
 * `/api/combos` HTTP routes — `tasks.md` task 8.2.
 *
 * Three endpoints, all gated by `requireMod`:
 *
 *   - `GET    /api/combos`        → 200 with `ComboSpec[]`
 *   - `POST   /api/combos`        → 200 with the saved `ComboSpec`,
 *                                   400 with `{ error }` on validator
 *                                   failure or `MAX_COMBOS` cap hit
 *   - `DELETE /api/combos/:name`  → 200 with `{ ok: true }` (idempotent —
 *                                   deleting a missing name still 200s)
 *
 * Auth and persistence are injected via `registerCombosRoute(app, deps)`.
 * `deps.auth` is an async callable that returns `{ user, sub }` on a
 * mod call OR throws `ForbiddenError` (which the route maps to 403).
 * `deps.combos` is the storage-layer dep bag from `src/server/combos.ts`
 * (`{ redis }`).
 *
 * Production wiring (lives in `src/server/index.ts` / `routes/api.ts`,
 * which this task does NOT touch) constructs `deps.auth` by closing over
 * the per-request `@devvit/web/server` `context` + `redis` + `reddit`,
 * then calls `requireMod({ sub: context.subredditName }, { redis, reddit })`.
 *
 * The route layer purposely does NOT invent its own validator — every
 * shape check happens inside `saveCombo` (`src/server/combos.ts`) which
 * throws `Error(message)` on either a validator failure or a hit of the
 * `MAX_COMBOS = 50` cap. Both surfaces map to the same 400 response,
 * matching the task body's "POST hits MAX_COMBOS cap → 400" clause.
 *
 * No realtime publish or metric bump fires here. Combo edits are mod-only
 * and rare; the picker (8.3a) re-reads `HKEYS combos:{sub}` on every
 * invocation so newly saved combos appear immediately without a cache
 * invalidation.
 */

import { Hono } from "hono";

import { ForbiddenError } from "../auth.js";
import {
  deleteCombo,
  listCombos,
  saveCombo,
  type CombosDeps,
} from "../combos.js";
import type { ComboSpec } from "../../shared/types.js";

/**
 * Auth callback shape. Production wiring closes over the per-request
 * Devvit `context` + clients; tests inject a fake that either resolves
 * `{ user, sub }` or throws `ForbiddenError`.
 */
export type AuthCheck = () => Promise<{ user: string; sub: string }>;

/** Injected dependencies for `registerCombosRoute`. */
export interface CombosRouteDeps {
  auth: AuthCheck;
  combos: CombosDeps;
}

/**
 * Register the three `/api/combos` endpoints onto the supplied Hono app.
 * Mutates `app` in place; returns `void` so callers can chain registrations
 * if desired.
 */
export function registerCombosRoute(
  app: Hono,
  deps: CombosRouteDeps,
): void {
  app.get("/api/combos", async (c) => {
    let sub: string;
    try {
      ({ sub } = await deps.auth());
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
    const combos = await listCombos(sub, deps.combos);
    return c.json(combos);
  });

  app.post("/api/combos", async (c) => {
    let sub: string;
    try {
      ({ sub } = await deps.auth());
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const saved = await saveCombo(sub, body as ComboSpec, deps.combos);
      return c.json(saved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.delete("/api/combos/:name", async (c) => {
    let sub: string;
    try {
      ({ sub } = await deps.auth());
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
    const name = c.req.param("name");
    await deleteCombo(sub, name, deps.combos);
    return c.json({ ok: true });
  });
}
