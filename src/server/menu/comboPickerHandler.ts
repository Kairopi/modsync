/**
 * Combo-picker menu handler for ModSync (task 8.3a).
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/design.md` "Combo Picker Flow" — drives the
 *     branch shape (auth gate → location gate → empty-combos toast →
 *     showForm) and the form payload.
 *   - `.kiro/specs/modsync/tasks.md` task 8.3a — pins the export
 *     contract, the dep injection shape, and the property test for
 *     option-list freshness.
 *   - `.kiro/steering/02-modsync-architecture.md` "Critical gotchas":
 *     **the picker is purely informational** — no claim writes, no
 *     metric bumps, no realtime publishes. The submit handler
 *     (task 8.3b) is where the foreign-claim soft warning + executor
 *     dispatch happen.
 *
 * Algorithm:
 *
 *   1. Resolve the current subreddit name via `deps.getSub()`. The
 *      handler never imports `@devvit/web/server` so the unit harness
 *      stays pure.
 *
 *   2. Run the auth gate via `deps.auth({ sub })`. On `ForbiddenError`
 *      we short-circuit with `{ showToast: 'Forbidden' }`. Devvit menu
 *      handlers cannot return HTTP statuses — a neutral toast is the
 *      canonical "you can't do this" surface. Other errors bubble to
 *      Hono's default 500 path. Property 10 (auth gate has no side
 *      effects on throw) is preserved because we never read combos
 *      after a failed auth.
 *
 *   3. Branch on `body.location`:
 *        - 'subreddit' → claim/combo subsystem doesn't model subreddit
 *          targets; return `{ showToast: "Combos don't apply to
 *          subreddits" }` and stop.
 *        - 'post' → expect `body.targetId` to start with `t3_`.
 *        - 'comment' → expect `body.targetId` to start with `t1_`.
 *      A mismatched prefix returns `{ showToast: 'Invalid target' }`.
 *
 *   4. Read the current combo list via `deps.combos.listCombos(sub)`.
 *      The picker re-fetches on every invocation per
 *      `02-modsync-architecture.md` "5-second freshness": HKEYS
 *      (well, `listCombos` does a HGETALL but the freshness story is
 *      identical) is cheap and avoids any cache-invalidation
 *      coordination with the editor (task 8.5).
 *      If the list is empty, return `{ showToast: 'No combos defined
 *      yet' }` instead of an empty-options form (Devvit's renderer
 *      doesn't gracefully handle an empty `options` array).
 *
 *   5. Build the select-field options from `combos.map(c => c.name)`
 *      and return the `comboPickerForm`. `data: { thingId }` carries
 *      the action context into the submit handler (task 8.3b), which
 *      reads `body.values.comboName` + `body.data.thingId`.
 *
 * Form shape (matches design.md "Combo Picker Flow" verbatim):
 *
 *     {
 *       title: 'Run combo',
 *       fields: [{
 *         name: 'comboName',
 *         type: 'select',
 *         label: 'Combo',
 *         options: [{ value: name, label: name }, ...],
 *       }],
 *       acceptLabel: 'Run',
 *     }
 *
 * Dep injection shape (`ComboPickerDeps`):
 *   - `auth`, `getSub` — same `AuthFn` / `getSub` seam used by the
 *     claim handler (4.2) and the metrics route (5.2). Tests inject a
 *     `vi.fn()`.
 *   - `combos` — pre-bound to `CombosDeps` at register time so the
 *     handler doesn't have to thread `redis` through. Mirrors the
 *     `ClaimsService` / `MetricsService` shape.
 *
 * The submit handler (8.3b) is in a sibling file and owns the
 * foreign-claim soft warning, the claim write, the realtime publish,
 * and the `runCombo` invocation — none of those are dependencies of
 * this handler.
 */

import type { MenuItemRequest, UiResponse, Form } from "@devvit/web/shared";
import { ForbiddenError } from "../auth.js";
import type { ComboSpec, ThingId } from "../../shared/types.js";

/**
 * Auth callable shape — mimics `requireMod` from `../auth.ts`.
 * Production wiring uses `(ctx) => requireMod(ctx, { redis, reddit })`.
 * Tests inject a `vi.fn()`.
 */
export type AuthFn = (ctx: {
  sub: string;
}) => Promise<{ user: string; sub: string }>;

/**
 * Pre-bound combos surface. Production wiring closes over a
 * `CombosDeps` (redis) at register time. Tests inject the real
 * `listCombos` curried over an in-memory fake.
 */
export interface CombosService {
  listCombos(sub: string): Promise<ComboSpec[]>;
}

/** Injected dependencies. */
export interface ComboPickerDeps {
  auth: AuthFn;
  getSub: () => string;
  combos: CombosService;
}

/**
 * Build the combo-picker form returned when at least one combo exists.
 * Single `select` field whose options mirror the combo names verbatim
 * (`value === label === combo.name`).
 *
 * `acceptLabel: 'Run'` per design.md "Combo Picker Flow". No
 * `cancelLabel` override — Devvit renders the default Cancel button
 * which dismisses the form without invoking the submit endpoint.
 */
function buildComboPickerForm(comboNames: string[]): Form {
  return {
    title: "Run combo",
    fields: [
      {
        type: "select",
        name: "comboName",
        label: "Combo",
        options: comboNames.map((n) => ({ value: n, label: n })),
      },
    ],
    acceptLabel: "Run",
  };
}

/**
 * Handle `POST /internal/menu/combo-picker`. See file-level docstring
 * for the full algorithm. Pure function — no Devvit globals consulted.
 *
 * Returns a `UiResponse` for Reddit to render. Either:
 *   - `{ showToast: 'Forbidden' }` (auth failed)
 *   - `{ showToast: "Combos don't apply to subreddits" }`
 *   - `{ showToast: 'Invalid target' }` (location/prefix mismatch)
 *   - `{ showToast: 'No combos defined yet' }` (empty hash)
 *   - `{ showForm: { name: 'comboPickerForm', ... } }` (≥1 combo)
 */
export async function onComboPickerMenu(
  body: MenuItemRequest,
  deps: ComboPickerDeps,
): Promise<UiResponse> {
  const sub = deps.getSub();

  // Step 2 — auth gate. ForbiddenError → toast; other throws bubble.
  try {
    await deps.auth({ sub });
  } catch (err) {
    if (
      err instanceof ForbiddenError ||
      (err instanceof Error && err.name === "ForbiddenError")
    ) {
      return { showToast: "Forbidden" };
    }
    throw err;
  }

  // Step 3 — validate target by location. Combos only model post /
  // comment targets; subreddit-level invocations are out of contract.
  if (body.location === "subreddit") {
    return { showToast: "Combos don't apply to subreddits" };
  }
  const expectedPrefix = body.location === "post" ? "t3_" : "t1_";
  if (!body.targetId.startsWith(expectedPrefix)) {
    return { showToast: "Invalid target" };
  }
  // Cast is safe: we just verified the prefix matches one of the two
  // shapes that make up `ThingId` (`t1_${string}` | `t3_${string}`).
  const thingId: ThingId = body.targetId as ThingId;

  // Step 4 — read combo list. No cache; the picker re-fetches every
  // invocation so the moderator always sees the freshest set.
  const combos = await deps.combos.listCombos(sub);
  if (combos.length === 0) {
    return { showToast: "No combos defined yet" };
  }

  // Step 5 — build the picker form. `data.thingId` carries the
  // action context into the submit handler (8.3b).
  return {
    showForm: {
      name: "comboPickerForm",
      form: buildComboPickerForm(combos.map((c) => c.name)),
      data: { thingId },
    },
  };
}
